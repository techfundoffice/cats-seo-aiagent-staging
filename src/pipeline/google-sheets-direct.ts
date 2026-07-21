/**
 * Direct Google Sheets API connector — a drop-in replacement for the
 * Composio `GOOGLESHEETS_*` tool calls the worker used for its "Sheet
 * mirror". Composio was an OAuth/auth abstraction in front of the Sheets
 * REST API; when its `COMPOSIO_API_KEY` died every sheet write started
 * returning `401 Invalid API key`. This connector talks to
 * `sheets.googleapis.com` directly using a Google **service account**
 * (the `GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON` secret), so the Composio key
 * is no longer in the runtime path for sheets.
 *
 * Auth flow (all in-Worker via WebCrypto — no Node APIs):
 *   1. RS256-sign a JWT asserting the service account + the spreadsheets
 *      scope.
 *   2. Exchange it at Google's OAuth token endpoint for a short-lived
 *      access token (cached until ~1 min before expiry).
 *   3. Call the Sheets v4 REST API with `Authorization: Bearer <token>`.
 *
 * `execute(slug, args)` mirrors the Composio session's signature and
 * argument names, and wraps the native Google response as
 * `{ data: <google response>, successful: true }` — the exact envelope
 * the existing `parseComposioSheetValuesGrid` / wrapper code already
 * understands, so no call-site parsing changes are required.
 *
 * IMPORTANT operational prerequisite: the target spreadsheet must be
 * shared (Editor) with the service account's `client_email`, or every
 * call returns 403. That sharing is a one-time Google Drive action.
 */

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Minimal shape of the fields we read from a service-account JSON key. */
export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** base64url (no padding) of bytes or a string. */
export function base64Url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode a PEM PKCS#8 private key (the `private_key` field of a Google
 * service-account JSON) into raw DER bytes for `crypto.subtle.importKey`.
 * Tolerates the literal `\n` escapes that survive JSON round-tripping.
 */
export function pemToPkcs8Der(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der.buffer;
}

/** Build the signed-JWT input (header.claims) for the token exchange. */
export function buildJwtAssertionInput(
  sa: GoogleServiceAccount,
  nowSeconds: number
): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SHEETS_SCOPE,
      aud: sa.token_uri ?? DEFAULT_TOKEN_URI,
      iat: nowSeconds,
      exp: nowSeconds + 3600
    })
  );
  return `${header}.${claims}`;
}

/**
 * Translate a Composio `GOOGLESHEETS_*` call into the Google Sheets REST
 * request (method/path/query/body). Pure + table-driven so it is unit
 * testable without touching the network. `resolveSheetId` is only invoked
 * for the row-insert path (which needs the numeric sheetId).
 */
export interface SheetsRestCall {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: string;
  body?: unknown;
}

export class GoogleSheetsDirectClient {
  private token: { value: string; expiresAt: number } | null = null;
  /** spreadsheetId -> (tab title -> numeric sheetId), cached per isolate. */
  private readonly sheetIdCache = new Map<string, Map<string, number>>();

  constructor(private readonly sa: GoogleServiceAccount) {}

  /**
   * Parse a service-account JSON string into a client. Throws when the
   * JSON is missing the two fields the JWT flow requires, so the caller
   * can fall back to Composio rather than emit cryptic crypto errors.
   */
  static fromServiceAccountJson(json: string): GoogleSheetsDirectClient {
    let parsed: GoogleServiceAccount;
    try {
      parsed = JSON.parse(json) as GoogleServiceAccount;
    } catch (err: unknown) {
      throw new Error(
        `GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (
      typeof parsed.client_email !== "string" ||
      parsed.client_email.trim() === "" ||
      typeof parsed.private_key !== "string" ||
      parsed.private_key.trim() === ""
    ) {
      throw new Error(
        "GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON missing client_email or private_key (non-empty strings required)"
      );
    }
    return new GoogleSheetsDirectClient(parsed);
  }

  /** The service-account identity — the email the sheet must be shared with. */
  get clientEmail(): string {
    return this.sa.client_email;
  }

  private async getAccessToken(): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - 60 > nowSeconds) {
      return this.token.value;
    }
    const signingInput = buildJwtAssertionInput(this.sa, nowSeconds);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8Der(this.sa.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput)
    );
    const assertion = `${signingInput}.${base64Url(signature)}`;

    const res = await fetch(this.sa.token_uri ?? DEFAULT_TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: JWT_BEARER_GRANT,
        assertion
      }).toString()
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Google token exchange failed: ${res.status} ${text.slice(0, 300)}`
      );
    }
    const json = JSON.parse(text) as {
      access_token: string;
      expires_in?: number;
    };
    this.token = {
      value: json.access_token,
      expiresAt: nowSeconds + (json.expires_in ?? 3600)
    };
    return this.token.value;
  }

  private async api(call: SheetsRestCall): Promise<unknown> {
    const token = await this.getAccessToken();
    const url = `${SHEETS_API_BASE}${call.path}${
      call.query ? `?${call.query}` : ""
    }`;
    const res = await fetch(url, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(call.body ? { "Content-Type": "application/json" } : {})
      },
      body: call.body ? JSON.stringify(call.body) : undefined
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Google Sheets ${call.method} ${call.path} -> ${res.status}: ${text.slice(
          0,
          300
        )}`
      );
    }
    return text ? JSON.parse(text) : {};
  }

  private async resolveSheetId(
    spreadsheetId: string,
    title: string
  ): Promise<number> {
    let byTitle = this.sheetIdCache.get(spreadsheetId);
    if (!byTitle || !byTitle.has(title)) {
      const info = (await this.api({
        method: "GET",
        path: `/${spreadsheetId}`,
        query: "fields=sheets.properties(sheetId,title)"
      })) as {
        sheets?: { properties?: { sheetId?: number; title?: string } }[];
      };
      byTitle = new Map<string, number>();
      for (const s of info.sheets ?? []) {
        const p = s.properties;
        if (p && typeof p.sheetId === "number" && typeof p.title === "string") {
          byTitle.set(p.title, p.sheetId);
        }
      }
      this.sheetIdCache.set(spreadsheetId, byTitle);
    }
    const sheetId = byTitle.get(title);
    if (sheetId == null) {
      throw new Error(`sheet tab "${title}" not found in ${spreadsheetId}`);
    }
    return sheetId;
  }

  /**
   * Composio-compatible executor. `slug` is a `GOOGLESHEETS_*` tool name;
   * `args` uses Composio's snake_case argument names. Returns the native
   * Google response wrapped as `{ data, successful: true }`.
   */
  async execute(slug: string, args: Record<string, unknown>): Promise<unknown> {
    const spreadsheetId = String(
      args.spreadsheet_id ?? args.spreadsheetId ?? ""
    );
    if (!spreadsheetId) {
      throw new Error(`${slug}: missing spreadsheet_id`);
    }
    const data = await this.api(
      await this.toRestCall(slug, spreadsheetId, args)
    );
    return { data, successful: true };
  }

  private async toRestCall(
    slug: string,
    id: string,
    args: Record<string, unknown>
  ): Promise<SheetsRestCall> {
    switch (slug) {
      case "GOOGLESHEETS_VALUES_GET":
        return {
          method: "GET",
          path: `/${id}/values/${encodeURIComponent(String(args.range))}`
        };
      case "GOOGLESHEETS_BATCH_GET": {
        // `ranges` may be a single string or an array (Composio accepted
        // both; the worker passes a bare string at the action-queue site).
        const raw = args.ranges;
        const ranges = Array.isArray(raw)
          ? (raw as string[])
          : raw != null
            ? [String(raw)]
            : [];
        return {
          method: "GET",
          path: `/${id}/values:batchGet`,
          query: ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&")
        };
      }
      case "GOOGLESHEETS_VALUES_UPDATE":
        return {
          method: "PUT",
          path: `/${id}/values/${encodeURIComponent(String(args.range))}`,
          query: `valueInputOption=${String(
            args.value_input_option ?? "USER_ENTERED"
          )}`,
          body: {
            values: args.values,
            majorDimension: args.major_dimension ?? "ROWS"
          }
        };
      case "GOOGLESHEETS_ADD_SHEET":
        return {
          method: "POST",
          path: `/${id}:batchUpdate`,
          body: {
            requests: [
              {
                addSheet: {
                  properties: { title: String(args.title ?? args.sheet_name) }
                }
              }
            ]
          }
        };
      case "GOOGLESHEETS_GET_SHEET_NAMES":
      case "GOOGLESHEETS_GET_SPREADSHEET_INFO":
        return {
          method: "GET",
          path: `/${id}`,
          query:
            "fields=spreadsheetId,properties.title,sheets.properties(sheetId,title,index)"
        };
      case "GOOGLESHEETS_CREATE_SPREADSHEET_ROW": {
        // Composio's CREATE_SPREADSHEET_ROW + insert_index inserts a blank
        // row. Map to insertDimension on the resolved numeric sheetId.
        // insert_index is 1-based ("insert below the header" passes 1); a
        // 0-based startIndex of insert_index therefore inserts the blank
        // row immediately under row 1.
        const sheetName = String(args.sheet_name ?? args.title ?? "");
        const insertIndex = Number(args.insert_index ?? 1);
        const sheetId = await this.resolveSheetId(id, sheetName);
        const startIndex = Math.max(0, insertIndex);
        return {
          method: "POST",
          path: `/${id}:batchUpdate`,
          body: {
            requests: [
              {
                insertDimension: {
                  range: {
                    sheetId,
                    dimension: "ROWS",
                    startIndex,
                    endIndex: startIndex + 1
                  },
                  inheritFromBefore: false
                }
              }
            ]
          }
        };
      }
      default:
        throw new Error(
          `GoogleSheetsDirectClient: unsupported tool slug "${slug}"`
        );
    }
  }
}
