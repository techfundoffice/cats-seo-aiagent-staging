/**
 * Optional Google Sheet tab for scout / keyword ROI inputs: API columns A–F and
 * H–I plus sheet formulas for G, J, K (Avg commission, Relative demand,
 * Commission potential score).
 */
import {
  getComposioEnvelopeCandidates,
  parseJsonStringValue,
  parseObjectLike
} from "./objectLike";

/** Bump when headers or formulas change so Durable Objects refresh the tab. */
export const SCOUT_KEYWORD_ROI_SHEET_LAYOUT_VERSION = 1;

/** Worksheet tab created under the same spreadsheet as the activity log. */
export const SCOUT_KEYWORD_ROI_SHEET_TAB_NAME = "Scout keyword ROI";

/** Returns the single-quoted, Sheets-escaped tab name for A1 ranges. */
export function quoteScoutKeywordRoiSheetTab(): string {
  return `'${SCOUT_KEYWORD_ROI_SHEET_TAB_NAME.replace(/'/g, "''")}'`;
}

/** Row 1 headers: A–L (Keyword … Notes). */
export const SCOUT_KEYWORD_ROI_HEADER_ROW: readonly string[] = [
  "Keyword",
  "Search Volume",
  "KD",
  "SERP Notes",
  "Avg Product Price",
  "Commission Rate",
  "Avg Commission per Sale",
  "Avg Reviews",
  "Recent Reviews",
  "Relative Demand",
  "Commission Potential Score",
  "Notes"
] as const;

/**
 * ARRAYFORMULA in G2: price × commission. E = price (allows $ and commas), F =
 * decimal rate (0.03) or percent text ("3%").
 */
export const SCOUT_KEYWORD_ROI_FORMULA_AVG_COMMISSION =
  "=ARRAYFORMULA(IF(LEN(A2:A)=0,,IFERROR(" +
  'VALUE(REGEXREPLACE(TO_TEXT(E2:E),"[^0-9.]",""))*' +
  'IF(REGEXMATCH(TO_TEXT(F2:F),"%"),' +
  'VALUE(REGEXREPLACE(TO_TEXT(F2:F),"[^0-9.]",""))/100,' +
  'VALUE(F2:F)),"")))';

/**
 * ARRAYFORMULA in J2: min(1, recent / max(avg reviews, 1)). H = Avg reviews, I
 * = Recent reviews.
 */
export const SCOUT_KEYWORD_ROI_FORMULA_RELATIVE_DEMAND =
  "=ARRAYFORMULA(IF(LEN(A2:A)=0,,IFERROR(" +
  'MIN(1,I2:I/IF(H2:H>0,H2:H,1)),"")))';

/**
 * ARRAYFORMULA in K2: (volume × avg commission × relative demand) / KD, same
 * shape as cats-amazon-roi-scout CommissionOpportunityScore; KD floored at 1.
 */
export const SCOUT_KEYWORD_ROI_FORMULA_COMMISSION_POTENTIAL =
  "=ARRAYFORMULA(IF(LEN(A2:A)=0,,IFERROR(" +
  'VALUE(REGEXREPLACE(TO_TEXT(B2:B),"[^0-9.]",""))*' +
  'VALUE(REGEXREPLACE(TO_TEXT(E2:E),"[^0-9.]",""))*' +
  'IF(REGEXMATCH(TO_TEXT(F2:F),"%"),' +
  'VALUE(REGEXREPLACE(TO_TEXT(F2:F),"[^0-9.]",""))/100,' +
  "VALUE(F2:F))*" +
  "MIN(1,I2:I/IF(H2:H>0,H2:H,1))/" +
  'IF(C2:C>0,C2:C,1),"")))';

export type ComposioSheetExecute = (
  slug: string,
  args: Record<string, unknown>
) => Promise<unknown>;
export type GoogleSheetTitlesFetchErrorHandler = (
  slug: string,
  error: unknown
) => void;

function normalizeSheetTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  return title === "" ? null : title;
}

function normalizeSheetTitleCandidate(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = parseJsonStringValue(value);
    if (typeof parsed === "string") {
      return normalizeSheetTitle(parsed);
    }
  }
  return normalizeSheetTitle(value);
}

function dedupeSheetTitles(titles: string[]): string[] {
  return [...new Set(titles)];
}

function extractNormalizedTitleList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupeSheetTitles(
      value.flatMap((item) => extractNormalizedTitleList(item))
    );
  }
  if (typeof value === "string") {
    const parsed = parseJsonStringValue(value);
    if (parsed !== undefined && parsed !== value) {
      return extractNormalizedTitleList(parsed);
    }
    const normalized = normalizeSheetTitle(value);
    return normalized ? [normalized] : [];
  }
  const normalized = normalizeSheetTitleCandidate(value);
  return normalized ? [normalized] : [];
}

function parseSheetTitleRow(
  item: unknown,
  parsedStringObject?: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (typeof item === "string") {
    return parsedStringObject ?? parseObjectLike(item);
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  return item as Record<string, unknown>;
}

function extractSheetTitlesFromArray(items: unknown[]): string[] {
  const titles: string[] = [];
  const objectTitles: string[] = [];
  for (const item of items) {
    const parsedStringObject =
      typeof item === "string" ? parseObjectLike(item) : null;
    const directTitle =
      parsedStringObject !== null ? null : normalizeSheetTitleCandidate(item);
    if (directTitle) {
      titles.push(directTitle);
      continue;
    }

    const row = parseSheetTitleRow(item, parsedStringObject);
    if (!row) continue;
    const props = parseObjectLike(row.properties);
    const normalizedTitle =
      normalizeSheetTitleCandidate(row.title) ??
      normalizeSheetTitleCandidate(props?.title) ??
      normalizeSheetTitleCandidate(row.sheetName) ??
      normalizeSheetTitleCandidate(row.name);
    if (normalizedTitle) objectTitles.push(normalizedTitle);
  }
  return dedupeSheetTitles([...titles, ...objectTitles]);
}

function extractSheetTitlesFromCollection(value: unknown): string[] {
  if (Array.isArray(value)) {
    return extractSheetTitlesFromArray(value);
  }
  if (typeof value === "string") {
    const parsed = parseJsonStringValue(value);
    if (parsed !== undefined && parsed !== value) {
      return extractSheetTitlesFromCollection(parsed);
    }
  }
  const bucket = parseObjectLike(value);
  if (!bucket) {
    return [];
  }
  const directTitles = extractSheetTitlesFromArray([bucket]);
  if (directTitles.length > 0) {
    return directTitles;
  }
  for (const nested of [
    bucket.sheets,
    bucket.data,
    bucket.items,
    bucket.value
  ]) {
    const titles = extractSheetTitlesFromCollection(nested);
    if (titles.length > 0) {
      return titles;
    }
  }
  return [];
}

/**
 * Extracts worksheet tab titles from the varying object/array payload
 * shapes returned by Composio Google Sheets tools.
 */
export function extractSheetTabTitlesFromComposio(raw: unknown): string[] {
  for (const b of getComposioEnvelopeCandidates(raw)) {
    if (Array.isArray(b)) {
      const titles = extractSheetTitlesFromArray(b);
      if (titles.length > 0) {
        return titles;
      }
      continue;
    }
    const data = parseObjectLike(b);
    if (!data) continue;
    const sn = data.sheet_names ?? data.sheetNames;
    const normalizedSheetNames = extractNormalizedTitleList(sn);
    if (normalizedSheetNames.length > 0) {
      return normalizedSheetNames;
    }
    const titles = extractSheetTitlesFromCollection(data.sheets);
    if (titles.length > 0) {
      return titles;
    }
  }
  return [];
}

/**
 * Retrieves worksheet tab titles for a Google Spreadsheet via Composio.
 * Tries the sheet-names endpoint first, then falls back to spreadsheet-info,
 * and reports per-endpoint errors through `onError` without throwing.
 */
export async function fetchGoogleSpreadsheetSheetTitles(
  exec: ComposioSheetExecute,
  spreadsheetId: string,
  onError?: GoogleSheetTitlesFetchErrorHandler
): Promise<string[]> {
  const trimmedSpreadsheetId = spreadsheetId.trim();
  if (trimmedSpreadsheetId === "") return [];

  const sheetTitleFetchSlugs = [
    "GOOGLESHEETS_GET_SHEET_NAMES",
    "GOOGLESHEETS_GET_SPREADSHEET_INFO"
  ] as const;
  for (const [index, slug] of sheetTitleFetchSlugs.entries()) {
    try {
      const raw = await exec(slug, { spreadsheet_id: trimmedSpreadsheetId });
      const titles = extractSheetTabTitlesFromComposio(raw);
      if (titles.length > 0) return titles;
      if (index === sheetTitleFetchSlugs.length - 1) {
        onError?.(
          slug,
          new Error(
            `Sheet list returned no parseable tab titles from any endpoint (tried: ${sheetTitleFetchSlugs.join(", ")})`
          )
        );
      }
    } catch (error: unknown) {
      onError?.(slug, error);
    }
  }
  return [];
}
