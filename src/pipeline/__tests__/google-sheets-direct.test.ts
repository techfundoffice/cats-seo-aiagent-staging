import { describe, it, expect } from "vitest";
import {
  base64Url,
  pemToPkcs8Der,
  buildJwtAssertionInput,
  GoogleSheetsDirectClient
} from "../google-sheets-direct";
import { extractFirstRowFromComposioValuesResult } from "../../activityLogSheetLayout";

/** Decode a base64url string (test-side helper). */
function decodeBase64Url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

describe("google-sheets-direct: base64Url", () => {
  it("encodes strings url-safe with no padding", () => {
    // 'subjects?' -> standard base64 'c3ViamVjdHM/' uses '/', must become '_'
    const out = base64Url("subjects?");
    expect(out).not.toMatch(/[+/=]/);
    expect(decodeBase64Url(out)).toBe("subjects?");
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 255, 16, 128, 64]);
    const decoded = decodeBase64Url(base64Url(bytes));
    const back = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    expect(Array.from(back)).toEqual([0, 255, 16, 128, 64]);
  });
});

describe("google-sheets-direct: pemToPkcs8Der", () => {
  it("strips PEM armor and decodes the base64 body, tolerating \\n escapes", () => {
    const body = btoa("hello-der-bytes");
    const pem = `-----BEGIN PRIVATE KEY-----\\n${body}\\n-----END PRIVATE KEY-----\\n`;
    const der = pemToPkcs8Der(pem);
    const text = String.fromCharCode(...new Uint8Array(der));
    expect(text).toBe("hello-der-bytes");
  });
});

describe("google-sheets-direct: buildJwtAssertionInput", () => {
  it("produces header.claims with the spreadsheets scope and SA identity", () => {
    const input = buildJwtAssertionInput(
      {
        client_email: "svc@proj.iam.gserviceaccount.com",
        private_key: "unused-here"
      },
      1_700_000_000
    );
    const [headerB64, claimsB64, rest] = input.split(".");
    expect(rest).toBeUndefined(); // signing input is header.claims only
    expect(JSON.parse(decodeBase64Url(headerB64))).toEqual({
      alg: "RS256",
      typ: "JWT"
    });
    const claims = JSON.parse(decodeBase64Url(claimsB64));
    expect(claims.iss).toBe("svc@proj.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/spreadsheets");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_000_000 + 3600);
  });
});

describe("google-sheets-direct: fromServiceAccountJson validation", () => {
  it("throws on non-JSON", () => {
    expect(() =>
      GoogleSheetsDirectClient.fromServiceAccountJson("not json")
    ).toThrow(/not valid JSON/);
  });

  it("throws when client_email/private_key are missing", () => {
    expect(() =>
      GoogleSheetsDirectClient.fromServiceAccountJson('{"client_email":"a@b"}')
    ).toThrow(/missing client_email or private_key/);
  });

  it("throws when client_email/private_key are not non-empty strings", () => {
    expect(() =>
      GoogleSheetsDirectClient.fromServiceAccountJson(
        JSON.stringify({ client_email: { bad: true }, private_key: 42 })
      )
    ).toThrow(/non-empty strings required/);

    expect(() =>
      GoogleSheetsDirectClient.fromServiceAccountJson(
        JSON.stringify({ client_email: "   ", private_key: "\n" })
      )
    ).toThrow(/non-empty strings required/);
  });

  it("exposes clientEmail for sheet-sharing diagnostics", () => {
    const c = GoogleSheetsDirectClient.fromServiceAccountJson(
      JSON.stringify({ client_email: "svc@p.iam", private_key: "k" })
    );
    expect(c.clientEmail).toBe("svc@p.iam");
  });
});

describe("google-sheets-direct: response shape is Composio-compatible", () => {
  it("VALUES_GET-shaped { data: { values } } parses via the existing extractor", () => {
    // This is exactly what the client returns for GOOGLESHEETS_VALUES_GET.
    const clientReturn = {
      data: { range: "A1:B1", majorDimension: "ROWS", values: [["h1", "h2"]] },
      successful: true
    };
    expect(extractFirstRowFromComposioValuesResult(clientReturn)).toEqual([
      "h1",
      "h2"
    ]);
  });

  it("BATCH_GET-shaped { data: { valueRanges } } parses via the existing extractor", () => {
    const clientReturn = {
      data: { valueRanges: [{ values: [["c1", "c2", "c3"]] }] },
      successful: true
    };
    expect(extractFirstRowFromComposioValuesResult(clientReturn)).toEqual([
      "c1",
      "c2",
      "c3"
    ]);
  });
});
