/**
 * Write canonical activity-log row 1 headers to Google Sheets via Composio.
 *
 * Run:
 *   doppler run -- npx tsx scripts/push-activity-log-canonical-headers.mts
 *
 * Env:
 *   COMPOSIO_API_KEY (required)
 *   SPREADSHEET_ID (optional; defaults to AI CEO OF CATS LUV US mirror)
 *   COMPOSIO_SESSION_USER_ID (optional; default `seo-agent` — same id as the Worker
 *     so the Tool Router reuses your connected Google Sheets account)
 *   COMPOSIO_GOOGLESHEETS_CONNECTED_ACCOUNT_ID (optional; Composio connected-account
 *     id for toolkit `googlesheets` — set if you still get NoActiveConnection)
 */
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import {
  ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT,
  ACTIVITY_LOG_SHEET_TAB_NAME,
  buildActivityLogSheetCanonicalHeaderTitles,
  sheetColumnIndex1BasedToA1Letters
} from "../src/activityLogSheetColumns.ts";

const DEFAULT_SPREADSHEET_ID = "1kTh9-ppWnp-drjgdpA7sOO1qGNrSwL8KMMUTqMJHEjw";

const spreadsheetId = (
  process.env.SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID
).trim();

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey || !String(apiKey).trim()) {
  console.error(
    "Missing COMPOSIO_API_KEY (use: doppler run -- npx tsx scripts/push-activity-log-canonical-headers.mts)"
  );
  process.exit(1);
}

const tabQuoted = `'${ACTIVITY_LOG_SHEET_TAB_NAME.replace(/'/g, "''")}'`;
const lastA1 = sheetColumnIndex1BasedToA1Letters(
  ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
);
const range = `${tabQuoted}!A1:${lastA1}1`;

const physical = buildActivityLogSheetCanonicalHeaderTitles().map((c) =>
  String(c)
);
if (physical.length !== ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT) {
  throw new Error(
    `expected ${ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT} headers, got ${physical.length}`
  );
}

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

console.log(`Spreadsheet: ${spreadsheetId}`);
console.log(`Composio session user_id: ${sessionUserId}`);
if (googlesheetsConnectedAccountId) {
  console.log(
    "Using COMPOSIO_GOOGLESHEETS_CONNECTED_ACCOUNT_ID for googlesheets"
  );
}
console.log(`Range: ${range} (${physical.length} cells)`);

const updateRaw = await session.execute("GOOGLESHEETS_VALUES_UPDATE", {
  spreadsheet_id: spreadsheetId,
  range,
  values: [physical],
  value_input_option: "USER_ENTERED",
  major_dimension: "ROWS",
  auto_expand_sheet: true
});

const updatePreviewUnknown: unknown = updateRaw;
console.log(
  "VALUES_UPDATE:",
  typeof updatePreviewUnknown === "string"
    ? updatePreviewUnknown.slice(0, 500)
    : JSON.stringify(updatePreviewUnknown).slice(0, 1200)
);

const readRaw = await session.execute("GOOGLESHEETS_BATCH_GET", {
  spreadsheet_id: spreadsheetId,
  ranges: [range]
});

const vr = (readRaw as { data?: { valueRanges?: unknown[] } })?.data
  ?.valueRanges?.[0] as { values?: string[][] } | undefined;
const row = vr?.values?.[0] ?? [];
const pad = [...row];
while (pad.length < physical.length) pad.push("");

let mismatches = 0;
for (let i = 0; i < physical.length; i++) {
  const a = physical[i] ?? "";
  const b = pad[i] ?? "";
  if (a !== b) {
    if (mismatches < 8) {
      console.error(
        `mismatch index ${i}: canon=${JSON.stringify(a)} live=${JSON.stringify(b)}`
      );
    }
    mismatches++;
  }
}

console.log(
  `read-back: liveLen=${row.length} expected=${physical.length} mismatches=${mismatches}`
);
if (mismatches > 0) process.exit(3);
console.log("OK: row 1 matches buildActivityLogSheetCanonicalHeaderTitles()");
