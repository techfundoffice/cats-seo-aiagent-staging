/**
 * DataForSEO keyword-metrics hydration. Runs at the very start of the
 * pipeline and persists search_volume / cpc onto the `keywords` row for
 * analytics. Does NOT gate the pipeline — this site targets long-tail
 * keywords (search_volume often null because Google Ads doesn't aggregate
 * ultra-long-tails), so a low-volume gate skipped 100% of articles.
 *
 * Quietly skips only when both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are
 * unset; partial configuration logs an actionable warning instead of silently
 * disabling keyword-metrics hydration.
 */
import type { SEOArticleAgent } from "../server";
import { fetchSearchVolume, resolveDataForSeoCreds } from "./dataforseo";
import { errMsg } from "./http-utils";

/**
 * Hydrate keyword-level search metrics from DataForSEO onto the keyword row.
 *
 * This helper never blocks article generation: missing credentials, API errors,
 * unmatched keywords, and null search-volume responses all degrade to a no-op.
 * When only one DataForSEO credential is configured, it logs a warning so the
 * missing binding is visible in the activity feed.
 */
export async function hydrateKeywordMetrics(
  agent: SEOArticleAgent,
  keyword: string,
  categorySlug: string,
  slug: string
): Promise<void> {
  const normalizedKeyword = keyword.trim();
  if (normalizedKeyword === "") return;

  const { creds, missing } = resolveDataForSeoCreds(
    agent.envBindings.DATAFORSEO_LOGIN,
    agent.envBindings.DATAFORSEO_PASSWORD
  );
  if (!creds) {
    if (missing.length === 1) {
      agent.log(
        "warning",
        `DataForSEO search_volume skipped for "${normalizedKeyword}": missing ${missing[0]}; set both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to enable keyword metrics`,
        "operations",
        { categorySlug, keyword }
      );
    }
    return;
  }
  const { login, password } = creds;

  const result = await fetchSearchVolume({ login, password }, [
    normalizedKeyword
  ]);
  if ("error" in result) {
    agent.log(
      "warning",
      `DataForSEO search_volume: ${result.error}`,
      "operations",
      { categorySlug, keyword }
    );
    return;
  }

  const target = normalizeKeywordMatchKey(normalizedKeyword);
  const row = result.rows.find(
    (r) => normalizeKeywordMatchKey(r.keyword) === target
  );
  if (!row || row.searchVolume == null) {
    // Long-tail terms commonly return null search_volume from DataForSEO —
    // that's expected, not a failure. Absent rows (keyword not recognised by
    // the API) are caught by `!row`; null-volume rows are caught by
    // `row.searchVolume == null`. Both cases skip the DB write so ultra-
    // long-tail keywords are not recorded as having zero monthly searches.
    return;
  }

  const id = `${categorySlug}:${slug}`;
  try {
    agent.sql`UPDATE keywords
      SET search_volume = ${row.searchVolume},
          cpc = ${row.cpc}
      WHERE id = ${id}`;
  } catch (sqlErr: unknown) {
    // The SQL update is analytics-only; a schema mismatch or missing row must
    // never prevent article generation (consistent with the "never blocks"
    // contract in the JSDoc above).
    agent.log(
      "warning",
      `DataForSEO search_volume: SQL update failed for "${normalizedKeyword}": ${errMsg(sqlErr)}`,
      "operations",
      { categorySlug, keyword }
    );
    return;
  }

  agent.log(
    "info",
    `DataForSEO search_volume="${normalizedKeyword}": ${row.searchVolume}/mo, cpc=$${(row.cpc ?? 0).toFixed(2)}`,
    "strategist",
    { categorySlug, keyword }
  );
}

function normalizeKeywordMatchKey(keyword: string): string {
  return keyword.trim().replace(/\s+/g, " ").toLowerCase();
}
