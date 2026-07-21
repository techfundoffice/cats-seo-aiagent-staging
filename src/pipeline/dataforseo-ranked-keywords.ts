/**
 * DataForSEO Labs — Ranked Keywords (live).
 *
 * For a given target URL, returns every keyword the URL currently ranks for
 * within the requested location, with position, search volume, CPC, and
 * estimated traffic. This is the core signal that closes the SEO feedback
 * loop — published article URLs feed in, real ranking data feeds out, the
 * dashboard surfaces it, and the refresh queue acts on decay.
 *
 * Endpoint: POST /v3/dataforseo_labs/google/ranked_keywords/live
 * Auth: HTTP Basic (DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD).
 *
 * Silent error-shape return on failure (never throws). Caller treats absence
 * as "no signal", never as "0 rankings".
 */

import { errMsg } from "./http-utils";
import type { DataForSeoCreds } from "./dataforseo";
import { authHeader, pick } from "./dataforseo";

const RANKED_KEYWORDS_URL =
  "https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live";
/** Default limit when caller doesn't override. 100 is DataForSEO's typical page size. */
const DEFAULT_RANKED_KEYWORDS_LIMIT = 100;

export interface RankedKeywordRow {
  keyword: string;
  position: number;
  searchVolume: number;
  cpc: number;
  estTraffic: number;
  serpFeatures: string[];
}

/**
 * Pull every keyword the target URL ranks for in the requested country.
 * `target` should be the bare hostname+path with no protocol — DataForSEO
 * matches both http and https variants automatically.
 *
 * Default location_code 2840 = United States. Pass alternate codes (2826 UK,
 * 2124 CA, 2036 AU) to capture geo-segmented rankings.
 *
 * Default limit 100 covers the long tail of nearly every published article;
 * raise via opts.limit for pillar pages with hundreds of ranking keywords.
 */
export async function fetchRankedKeywords(
  creds: DataForSeoCreds,
  target: string,
  opts: { limit?: number; locationCode?: number } = {}
): Promise<{ ok: true; rows: RankedKeywordRow[] } | { error: string }> {
  const limit = opts.limit ?? DEFAULT_RANKED_KEYWORDS_LIMIT;
  const locationCode = opts.locationCode ?? 2840;
  // DataForSEO expects bare hostname+path (no protocol/query/hash).
  const cleanTarget = normalizeRankedKeywordTarget(target);
  if (!cleanTarget) return { error: "empty target" };

  let res: Response;
  try {
    res = await fetch(RANKED_KEYWORDS_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json"
      },
      body: JSON.stringify([
        {
          target: cleanTarget,
          language_code: "en",
          location_code: locationCode,
          limit,
          ignore_synonyms: true,
          load_rank_absolute: true,
          // Skip results past pos 100 — they have negligible traffic potential
          // and inflate the row count.
          filters: [["ranked_serp_element.serp_item.rank_group", "<=", 100]]
        }
      ]),
      signal: AbortSignal.timeout(45_000)
    });
  } catch (err: unknown) {
    return { error: errMsg(err) };
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    return { error: `HTTP ${res.status}: ${body}` };
  }
  const json = (await res.json().catch(() => null)) as unknown;
  const apiStatus = pick<number>(json, ["status_code"]);
  if (apiStatus !== 20000) {
    return {
      error: `status_code=${apiStatus}: ${pick<string>(json, ["status_message"])}`
    };
  }
  const items = pick(json, ["tasks", 0, "result", 0, "items"]);
  if (!Array.isArray(items)) {
    return { ok: true, rows: [] };
  }

  const rows: RankedKeywordRow[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const keyword = pick(item, ["keyword_data", "keyword"]);
    if (typeof keyword !== "string" || !keyword.trim()) continue;
    const position = pick(item, [
      "ranked_serp_element",
      "serp_item",
      "rank_group"
    ]);
    if (typeof position !== "number") continue;
    // Skip non-organic rank_group=0 rows (AI Overview, knowledge panel,
    // etc.). They share the items[] payload but have no real organic
    // position, and writing position=0 to article_rankings would corrupt
    // delta/sparkline charts.
    if (position <= 0) continue;
    const searchVolume =
      pick<number | null>(item, [
        "keyword_data",
        "keyword_info",
        "search_volume"
      ]) ?? 0;
    const cpc =
      pick<number | null>(item, ["keyword_data", "keyword_info", "cpc"]) ?? 0;
    const estTraffic =
      pick<number | null>(item, ["ranked_serp_element", "serp_item", "etv"]) ??
      0;
    // SERP-feature flags — capture presence of featured_snippet, paa,
    // ai_overview etc. so the refresh-queue scorer can target them.
    // DataForSEO can populate the same flag through two fields
    // (`serp_item.type` AND `serp_item.is_featured_snippet=true`); use a
    // Set to dedup so we never emit ["featured_snippet","featured_snippet"].
    const featureSet = new Set<string>();
    const itemType = pick(item, ["ranked_serp_element", "serp_item", "type"]);
    if (typeof itemType === "string" && itemType !== "organic") {
      featureSet.add(itemType);
    }
    const isFeaturedSnippet = pick(item, [
      "ranked_serp_element",
      "serp_item",
      "is_featured_snippet"
    ]);
    if (isFeaturedSnippet === true) featureSet.add("featured_snippet");

    rows.push({
      keyword: keyword.trim(),
      position,
      searchVolume,
      cpc,
      estTraffic,
      serpFeatures: [...featureSet]
    });
  }

  return { ok: true, rows };
}

function normalizeRankedKeywordTarget(target: string): string {
  const raw = target.trim();
  if (!raw) return "";

  // Accept both fully-qualified URLs and bare host/path input.
  const asUrl = /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(asUrl);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    // Fall back to conservative string cleanup on malformed inputs.
    return raw
      .replace(/^https?:\/\//i, "")
      .split(/[?#]/, 1)[0]
      .replace(/\/$/, "");
  }
}

// Re-exports for unit-test convenience without exposing private regex state.
export const __testHelpers = {
  normalizeRankedKeywordTarget
};
