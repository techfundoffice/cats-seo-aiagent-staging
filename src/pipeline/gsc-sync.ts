import { errMsg, getEnvBinding } from "./http-utils";

/**
 * gsc-sync.ts — Google Search Console → article_ledger performance sync.
 *
 * Authenticates as the GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON service account
 * (RS256 JWT signed with WebCrypto, exchanged for an OAuth access token;
 * the account must be added as a user on the Search Console property).
 * Pulls the last-28-day Search Analytics report for the production
 * property, dimensioned by page, and writes impressions / clicks / CTR /
 * average position onto each article's ledger row — Google's actual
 * verdict on every published article, not a predicted score.
 *
 * Property forms differ by how the site was added to GSC:
 *   - Domain property:     "sc-domain:catsluvus.com"
 *   - URL-prefix property: "https://catsluvus.com/"
 * GSC_PROPERTY pins one; unset, both are tried in that order.
 */

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Mint a service-account access token for the Search Console API. */
export async function getGscAccessToken(env: unknown): Promise<string> {
  const raw = getEnvBinding(env, "GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON");
  if (!raw) {
    throw new Error("GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON not configured");
  }
  const sa = JSON.parse(raw) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const header = b64url(
    enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  );
  const claims = b64url(
    enc.encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: GSC_SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600
      })
    )
  );
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(signingInput)
  );
  const jwt = `${signingInput}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  if (!res.ok) {
    throw new Error(`GSC token exchange failed: HTTP ${res.status}`);
  }
  const tok = (await res.json()) as { access_token?: string };
  if (!tok.access_token) throw new Error("GSC token exchange: no access_token");
  return tok.access_token;
}

/** Map a GSC page URL to the article kv_key (`categorySlug:slug`). */
export function pageUrlToKvKey(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (!m) return null;
    return `${m[1]}:${m[2]}`;
  } catch {
    return null;
  }
}

export interface GscSyncResult {
  ok: boolean;
  property?: string;
  rows?: number;
  matched?: number;
  totals?: { impressions: number; clicks: number };
  error?: string;
}

interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Pull the last-28-day page report and update article_ledger rows.
 * Returns row/match counts so callers can log a meaningful summary.
 */
export async function runGscSync(
  env: unknown,
  keywordsDb: D1Database
): Promise<GscSyncResult> {
  let token: string;
  try {
    token = await getGscAccessToken(env);
  } catch (err: unknown) {
    return { ok: false, error: errMsg(err) };
  }

  const targetHost =
    getEnvBinding(env, "PROMOTION_TARGET_DOMAIN") ?? "catsluvus.com";
  const configured = getEnvBinding(env, "GSC_PROPERTY");
  const candidates = configured
    ? [configured]
    : [`sc-domain:${targetHost}`, `https://${targetHost}/`];

  const end = new Date();
  const start = new Date(end.getTime() - 28 * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  let rows: GscRow[] | null = null;
  let property = "";
  let lastErr = "";
  for (const candidate of candidates) {
    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(candidate)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          startDate: fmt(start),
          endDate: fmt(end),
          dimensions: ["page"],
          rowLimit: 5000
        })
      }
    );
    if (res.ok) {
      const data = (await res.json()) as { rows?: GscRow[] };
      rows = data.rows ?? [];
      property = candidate;
      break;
    }
    lastErr = `HTTP ${res.status} for ${candidate}`;
  }
  if (rows === null) {
    return { ok: false, error: `Search Analytics query failed: ${lastErr}` };
  }

  let matched = 0;
  let impressions = 0;
  let clicks = 0;
  const statements: D1PreparedStatement[] = [];
  const update = keywordsDb.prepare(
    `UPDATE article_ledger
        SET gsc_impressions = ?1, gsc_clicks = ?2, gsc_ctr = ?3,
            gsc_position = ?4, gsc_last_sync = datetime('now')
      WHERE kv_key = ?5`
  );
  // Sitewide mirror: persist EVERY page row (old production articles
  // included), not just pages present in article_ledger — this table
  // powers the dashboard panel plus CTR-triage and striking-distance
  // queries across the whole site.
  const upsertPage = keywordsDb.prepare(
    `INSERT OR REPLACE INTO gsc_pages
       (page_url, kv_key, impressions, clicks, ctr, position, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`
  );
  for (const row of rows) {
    const pageUrl = row.keys?.[0] ?? "";
    if (!pageUrl) continue;
    const kvKey = pageUrlToKvKey(pageUrl);
    statements.push(
      upsertPage.bind(
        pageUrl,
        kvKey,
        Math.round(row.impressions),
        Math.round(row.clicks),
        row.ctr,
        row.position
      )
    );
    if (kvKey) {
      statements.push(
        update.bind(
          Math.round(row.impressions),
          Math.round(row.clicks),
          row.ctr,
          row.position,
          kvKey
        )
      );
      matched++;
    }
    impressions += row.impressions;
    clicks += row.clicks;
  }
  if (statements.length > 0) {
    await keywordsDb.batch(statements);
  }

  return {
    ok: true,
    property,
    rows: rows.length,
    matched,
    totals: {
      impressions: Math.round(impressions),
      clicks: Math.round(clicks)
    }
  };
}
