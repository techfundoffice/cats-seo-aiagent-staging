import { writeFileSync } from "node:fs";
import {
  ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT,
  buildActivityLogSheetCanonicalHeaderTitles,
  sheetColumnIndex1BasedToA1Letters
} from "../src/activityLogSheetColumns.ts";

const headers = buildActivityLogSheetCanonicalHeaderTitles();
const last = sheetColumnIndex1BasedToA1Letters(
  ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
);
const qc = headers.filter((x) => /QC AI prompt/.test(String(x)));
const out = {
  count: headers.length,
  lastCol: last,
  range: `'cats-seo-aiagent-cloudflare'!A1:${last}1`,
  firstQcHeaders: qc.slice(0, 3),
  tailHeaders: headers.slice(-4),
  headers
};
writeFileSync("scripts/tmp-canonical-headers.json", JSON.stringify(out));
console.log(
  JSON.stringify({
    count: out.count,
    lastCol: out.lastCol,
    range: out.range,
    firstQcHeaders: out.firstQcHeaders,
    tailHeaders: out.tailHeaders,
    wrote: "scripts/tmp-canonical-headers.json"
  })
);
