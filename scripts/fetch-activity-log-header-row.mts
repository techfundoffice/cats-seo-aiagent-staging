/**
 * Read activity-log tab row 1 from Google Sheets via Composio and print JSON
 * (one string array) for `scripts/verify-activity-log-headers-vs-canonical.mts`.
 *
 * Run:
 *   doppler run -- npx tsx scripts/fetch-activity-log-header-row.mts
 *   doppler run -- npx tsx scripts/fetch-activity-log-header-row.mts path/to/out.json
 *
 * Env:
 *   COMPOSIO_API_KEY (required)
 *   SPREADSHEET_ID (optional; defaults to AI CEO mirror id in push script)
 *   COMPOSIO_SESSION_USER_ID / COMPOSIO_GOOGLESHEETS_CONNECTED_ACCOUNT_ID (optional)
 */
import { writeFileSync } from "node:fs";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import {
  ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT,
  ACTIVITY_LOG_SHEET_TAB_NAME,
  sheetColumnIndex1BasedToA1Letters
} from "../src/activityLogSheetColumns.ts";

const DEFAULT_SPREADSHEET_ID = "1kTh9-ppWnp-drjgdpA7sOO1qGNrSwL8KMMUTqMJHEjw";

const spreadsheetId = (
  process.env.SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID
).trim();

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey || !String(apiKey).trim()) {
  console.error(
    "Missing COMPOSIO_API_KEY (use: doppler run -- npx tsx scripts/fetch-activity-log-header-row.mts)"
  );
  process.exit(1);
}

const tabQuoted = `'${ACTIVITY_LOG_SHEET_TAB_NAME.replace(/'/g, "''")}'`;
const lastA1 = sheetColumnIndex1BasedToA1Letters(
  ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
);
const range = `${tabQuoted}!A1:${lastA1}1`;

const sessionUserId = (
  process.env.COMPOSIO_SESSION_USER_ID || "seo-agent"
).trim();
const googlesheetsConnectedAccountId = (
  process.env.COMPOSIO_GOOGLESHEETS_CONNECTED_ACCOUNT_ID || ""
).trim();

const composio = new Composio({ apiKey, provider: new VercelProvider() });
const session = await composio.create(
  sessionUserId,
  googlesheetsConnectedAccountId
    ? {
        toolkits: ["googlesheets"],
        connectedAccounts: {
          googlesheets: googlesheetsConnectedAccountId
        }
      }
    : { toolkits: ["googlesheets"] }
);
if (!session?.execute) {
  console.error("Composio session has no execute()");
  process.exit(2);
}

let raw: unknown;
try {
  raw = await session.execute("GOOGLESHEETS_VALUES_GET", {
    spreadsheet_id: spreadsheetId,
    range
  });
} catch {
  raw = await session.execute("GOOGLESHEETS_BATCH_GET", {
    spreadsheet_id: spreadsheetId,
    ranges: [range]
  });
}

function findValues2d(x: unknown, depth = 0): string[][] | null {
  if (depth > 12) return null;
  if (Array.isArray(x)) {
    if (x.length === 0) return [[]];
    const first = x[0];
    if (Array.isArray(first)) {
      return x.map((row) =>
        (row as unknown[]).map((c) => (c == null ? "" : String(c)))
      );
    }
    if (typeof first === "string" || typeof first === "number") {
      return [x.map((c) => (c == null ? "" : String(c)))];
    }
    for (const el of x) {
      const g = findValues2d(el, depth + 1);
      if (g) return g;
    }
    return null;
  }
  if (x && typeof x === "object") {
    for (const k of Object.keys(x as object)) {
      const g = findValues2d((x as Record<string, unknown>)[k], depth + 1);
      if (g) return g;
    }
  }
  return null;
}

function extractFirstRow(r: unknown): string[] {
  const grid = findValues2d(r);
  const row = grid?.[0] ?? [];
  return row.map((c) => String(c));
}

const row = extractFirstRow(raw);
const json = JSON.stringify(row);
const outPath = process.argv[2]?.trim();
if (outPath) {
  writeFileSync(outPath, `${json}\n`, "utf8");
  console.log(`Wrote ${row.length} cells to ${outPath}`);
} else {
  process.stdout.write(`${json}\n`);
}
