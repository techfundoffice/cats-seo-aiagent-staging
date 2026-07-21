/**
 * Map logical activity-log columns to physical sheet columns using row 1 titles.
 * Composio response parsing follows scripts/verify-composio-sheets-read.mjs.
 */

import {
  ACTIVITY_LOG_SHEET_COLUMN_STEP_HEADER,
  ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
} from "./activityLogSheetColumns";
import { getComposioEnvelopeCandidates, parseObjectLike } from "./objectLike";

function isScalarSheetCell(value: unknown): boolean {
  return (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isScalarSheetRow(
  value: unknown
): value is Array<string | number | boolean | null | undefined> {
  return Array.isArray(value) && value.every((cell) => isScalarSheetCell(cell));
}

function isScalarSheetGrid(
  value: unknown
): value is Array<Array<string | number | boolean | null | undefined>> {
  return (
    Array.isArray(value) && value.length > 0 && value.every(isScalarSheetRow)
  );
}

const SHEET_VALUES_PRIORITY_KEYS = [
  "values",
  "valueRanges",
  "data",
  "response_data",
  "responseData",
  "response"
] as const;

function findValues2d(
  x: unknown,
  depth = 0,
  visited = new WeakSet<object>()
): string[][] | null {
  if (depth > 12) return null;
  if (x && typeof x === "object") {
    if (visited.has(x)) return null;
    visited.add(x);
  }
  if (Array.isArray(x)) {
    if (x.length === 0) return null;
    if (isScalarSheetGrid(x)) {
      return x.map((row) => row.map((c) => (c == null ? "" : String(c))));
    }
    if (isScalarSheetRow(x)) {
      return [x.map((c) => (c == null ? "" : String(c)))];
    }
    for (const el of x) {
      const g = findValues2d(el, depth + 1, visited);
      if (g) return g;
    }
    return null;
  }
  if (x && typeof x === "object") {
    const record = x as Record<string, unknown>;
    const seen = new Set<string>();
    for (const key of SHEET_VALUES_PRIORITY_KEYS) {
      if (!Object.hasOwn(record, key)) continue;
      seen.add(key);
      const g = findValues2d(record[key], depth + 1, visited);
      if (g) return g;
    }
    for (const k of Object.keys(record)) {
      if (seen.has(k)) continue;
      const g = findValues2d(record[k], depth + 1, visited);
      if (g) return g;
    }
  }
  return null;
}

/**
 * Extracts the first sheet-like 2D values grid from a Composio response payload.
 *
 * Composio wrappers vary by toolkit/version (`response`, `response_data`,
 * `responseData`, `data`) and can be JSON-stringified in some responses,
 * so this scans common envelope shapes and returns normalized string cells.
 */
export function parseComposioSheetValuesGrid(raw: unknown): string[][] | null {
  for (const bucket of getComposioEnvelopeCandidates(raw)) {
    const grid = findValues2d(bucket);
    if (grid) return grid;
  }
  return null;
}

/** First row of values from Composio `GOOGLESHEETS_VALUES_GET` / `BATCH_GET`. */
export function extractFirstRowFromComposioValuesResult(
  raw: unknown
): string[] | null {
  const grid = parseComposioSheetValuesGrid(raw);
  const row0 = grid?.[0];
  if (row0 && Array.isArray(row0)) {
    return row0.map((c) => (c == null ? "" : String(c)));
  }
  for (const bucket of getComposioEnvelopeCandidates(raw)) {
    const record = parseObjectLike(bucket);
    if (!record) continue;
    const vrs = Array.isArray(record.valueRanges) ? record.valueRanges : null;
    const vr0 = parseObjectLike(vrs?.[0]);
    const vals = Array.isArray(vr0?.values) ? vr0.values : null;
    if (Array.isArray(vals) && vals.length > 0 && Array.isArray(vals[0])) {
      return vals[0].map((c) => (c == null ? "" : String(c)));
    }
  }
  return null;
}

/**
 * Normalizes row-1 header cells to the expected logical width by coercing
 * each cell to string, then right-padding/truncating to `width`.
 */
function padActivityLogHeaderRow1(
  cells: unknown[],
  width = ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
): string[] {
  const s = cells.map((c) => (c == null ? "" : String(c)));
  while (s.length < width) s.push("");
  return s.slice(0, width);
}

function countCanonicalTitles(
  canonicalTitles: readonly string[]
): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of canonicalTitles) {
    const k = t.trim();
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function normalizeActivityLogHeaderText(s: string): string {
  let t = s.trim();
  try {
    t = t.normalize("NFC");
  } catch {
    /* ignore */
  }
  return t.replace(/\uFF03/g, "#");
}

function stepHeaderCellMeansStepNumber(headerNorm: string): boolean {
  const h = headerNorm.toLowerCase().replace(/\s+/g, " ").trim();
  if (h === "step #") return true;
  if (h === "step") return true;
  if (h === "step#") return true;
  if (h === "step number") return true;
  if (h === "step no" || h === "step no.") return true;
  return false;
}

function headerCellEqualsCanonical(
  headerCell: string,
  canonicalTitle: string
): boolean {
  const h = normalizeActivityLogHeaderText(headerCell);
  const t = normalizeActivityLogHeaderText(canonicalTitle);
  if (h === t) return true;
  if (h.toLowerCase() === t.toLowerCase()) return true;
  if (
    t === ACTIVITY_LOG_SHEET_COLUMN_STEP_HEADER &&
    stepHeaderCellMeansStepNumber(h)
  ) {
    return true;
  }
  return false;
}

/**
 * First physical column whose row-1 header matches `canonicalTitle` (same
 * matching rules as permutation). Used to pin high-signal fields (e.g.
 * **Category**) when reordering would otherwise leave the labeled column blank.
 */
export function findPhysicalColumnIndexForCanonicalTitle(
  headerRow1: string[],
  canonicalTitle: string,
  width = ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
): number {
  const t = normalizeActivityLogHeaderText(canonicalTitle);
  if (!t) return -1;
  const header = padActivityLogHeaderRow1(headerRow1, width);
  for (let j = 0; j < width; j++) {
    if (headerCellEqualsCanonical(header[j], canonicalTitle)) return j;
  }
  return -1;
}

/**
 * Unique non-empty canonical titles that do not appear anywhere in row 1
 * (same matching rules as permutation). When non-empty, callers should not
 * `resolveActivityLogColumnPermutation` against this header row — e.g. after
 * adding a new column title, old sheets lack that cell and permuting would
 * glue `Message` to the wrong physical column.
 */
export function activityLogUniqueCanonicalTitlesMissingFromHeader(
  headerRow1: string[],
  canonicalTitles: readonly string[],
  width = ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
): string[] {
  const header = padActivityLogHeaderRow1(headerRow1, width);
  const titles = canonicalTitles.slice(0, width);
  while (titles.length < width) titles.push("");
  const counts = countCanonicalTitles(titles);
  const missing: string[] = [];
  for (let i = 0; i < width; i++) {
    const t = titles[i].trim();
    if (t === "" || (counts.get(t) ?? 0) > 1) continue;
    let found = false;
    for (let j = 0; j < width; j++) {
      if (headerCellEqualsCanonical(header[j], t)) {
        found = true;
        break;
      }
    }
    if (!found) missing.push(titles[i]);
  }
  return missing;
}

/**
 * For each logical index `i`, returns the physical column index for that field.
 * Unique non-empty canonical titles match row 1 headers (trimmed; case-insensitive
 * fallback). Blank titles and titles duplicated in `canonicalTitles` fill the
 * remaining physical columns in order, preferring default index `i` when it is
 * still free — so the result is always a bijection (no duplicate physical columns).
 */
export function resolveActivityLogColumnPermutation(
  headerRow1: string[],
  canonicalTitles: readonly string[],
  width = ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
): number[] {
  const header = padActivityLogHeaderRow1(headerRow1, width);
  const titles = canonicalTitles.slice(0, width);
  while (titles.length < width) titles.push("");
  const counts = countCanonicalTitles(titles);

  const perm: number[] = Array.from({ length: width }, () => -1);
  const usedPhysical = new Set<number>();
  const pendingLogical: number[] = [];

  for (let i = 0; i < width; i++) {
    const t = titles[i].trim();
    if (t === "" || (counts.get(t) ?? 0) > 1) {
      pendingLogical.push(i);
      continue;
    }
    let jFound = -1;
    for (let j = 0; j < width; j++) {
      if (usedPhysical.has(j)) continue;
      if (headerCellEqualsCanonical(header[j], t)) {
        jFound = j;
        break;
      }
    }
    if (jFound < 0) {
      pendingLogical.push(i);
    } else {
      perm[i] = jFound;
      usedPhysical.add(jFound);
    }
  }

  const freePhysical: number[] = [];
  for (let j = 0; j < width; j++) {
    if (!usedPhysical.has(j)) freePhysical.push(j);
  }
  freePhysical.sort((a, b) => a - b);
  pendingLogical.sort((a, b) => a - b);

  if (pendingLogical.length !== freePhysical.length) {
    return identityActivityLogColumnPermutation(width);
  }

  for (const i of pendingLogical) {
    const prefer = i;
    const ix = freePhysical.indexOf(prefer);
    if (ix >= 0) {
      perm[i] = prefer;
      freePhysical.splice(ix, 1);
    } else {
      const j = freePhysical.shift();
      if (j === undefined) {
        return identityActivityLogColumnPermutation(width);
      }
      perm[i] = j;
    }
  }

  return perm;
}

/**
 * Guards permutation arrays before use: must cover exactly `width` columns and
 * be a true bijection of integer indices from `0` to `width - 1`.
 */
export function isActivityLogColumnPermutationValid(
  perm: readonly number[],
  width = ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
): boolean {
  const safeWidth =
    Number.isSafeInteger(width) && width > 0
      ? width
      : ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT;
  if (perm.length !== safeWidth) return false;
  const s = new Set(perm);
  if (s.size !== safeWidth) return false;
  for (const n of perm) {
    if (!Number.isInteger(n) || n < 0 || n >= safeWidth) return false;
  }
  return true;
}

/**
 * Maps a logical row into physical sheet-column order using a validated
 * permutation, falling back to identity ordering if `perm` is invalid.
 */
export function permuteActivityLogLogicalRowToPhysical(
  logical: readonly string[],
  perm: readonly number[],
  width = ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
): string[] {
  const safeWidth =
    Number.isSafeInteger(width) && width > 0
      ? width
      : ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT;
  const safePerm = isActivityLogColumnPermutationValid(perm, safeWidth)
    ? perm
    : identityActivityLogColumnPermutation(safeWidth);
  const out = Array.from({ length: safeWidth }, () => "");
  for (let i = 0; i < safePerm.length && i < logical.length; i++) {
    const p = safePerm[i];
    out[p] = logical[i] ?? "";
  }
  return out;
}

/**
 * Identity logical->physical column mapping.
 *
 * Invalid widths (non-integer/<=0) fall back to the canonical logical width so
 * callers using untrusted width inputs do not throw on `Array.from`.
 */
export function identityActivityLogColumnPermutation(
  width = ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT
): number[] {
  const safeWidth =
    Number.isSafeInteger(width) && width > 0
      ? width
      : ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT;
  return Array.from({ length: safeWidth }, (_, i) => i);
}
