/**
 * Compare live Google Sheet row 1 (JSON array) to
 * buildActivityLogSheetCanonicalHeaderTitles().
 *
 * Usage:
 *   npx tsx scripts/verify-activity-log-headers-vs-canonical.mts path/to/row.json
 *   LIVE_ROW_JSON='["A",...]' npx tsx scripts/verify-activity-log-headers-vs-canonical.mts
 */
import { readFileSync } from "node:fs";
import { buildActivityLogSheetCanonicalHeaderTitles } from "../src/activityLogSheetColumns.ts";

function main() {
  const canon = buildActivityLogSheetCanonicalHeaderTitles();
  let live: string[];
  const pathArg = process.argv[2];
  const fromEnv = process.env.LIVE_ROW_JSON?.trim();
  if (pathArg) {
    live = JSON.parse(readFileSync(pathArg, "utf8")) as string[];
  } else if (fromEnv) {
    live = JSON.parse(fromEnv) as string[];
  } else {
    const raw = readFileSync(0, "utf8").trim();
    live = JSON.parse(raw) as string[];
  }
  const n = Math.max(canon.length, live.length);
  let mismatches = 0;
  for (let i = 0; i < n; i++) {
    const c = canon[i] ?? "__MISSING_CANON__";
    const l = live[i] ?? "__MISSING_LIVE__";
    if (c !== l) {
      console.error(
        `mismatch index ${i}: canon=${JSON.stringify(c)} live=${JSON.stringify(l)}`
      );
      mismatches++;
    }
  }
  console.log(
    `canonical=${canon.length} live=${live.length} mismatches=${mismatches}`
  );
  if (mismatches > 0) process.exit(1);
}

main();
