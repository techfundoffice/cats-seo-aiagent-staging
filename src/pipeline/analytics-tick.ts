/**
 * Analytics tick — pulls DataForSEO Labs ranked-keywords for stale published
 * articles and persists each row into the DO-local `article_rankings` table.
 * Driven by the every-minute `scheduled()` handler in src/server.ts; each
 * tick processes a small batch so the daily refresh is naturally paced and
 * never bursts the DataForSEO budget.
 *
 * Staleness rule: an article is "stale" when its newest article_rankings
 * snapshot is older than `staleAfterHours` (default 168 = 7 days). Google
 * organic rankings churn slowly — daily refresh produced too much noise
 * (and ~$17/day in DataForSEO Labs `ranked_keywords` cost across 1,700
 * articles) for signal that meaningfully changes weekly at most.
 * Articles never pulled before are picked first.
 *
 * Silent no-op when both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are unset;
 * partial configuration (only one binding set) logs an actionable warning.
 */

import { errMsg } from "./http-utils";
import type { SEOArticleAgent } from "../server";
import { fetchRankedKeywords } from "./dataforseo-ranked-keywords";
import { resolveDataForSeoCreds } from "./dataforseo";

export interface AnalyticsTickResult {
  /** Whether the tick ran (false when creds missing). */
  ran: boolean;
  /** Number of kvKeys actually attempted this tick (may be less than batch size on early auth error). */
  pulled: number;
  /** Total ranking rows inserted across all kvKeys. */
  rowsInserted: number;
  /** Number of kvKeys where DataForSEO returned an API error. */
  errors: number;
  /** Number of kvKeys where DataForSEO returned 0 rankings (sentinel written). */
  zeroRankings: number;
  /** First-line error if the tick failed before processing any kvKey. */
  error?: string;
}

interface ArticleRow {
  kv_key: string;
  url: string;
}

/**
 * KV key that short-circuits the whole tick after a hard quota / rate-limit
 * signal. Mirrors the scout's `scout-dataforseo-tier0-backoff` pattern: the
 * tick runs every minute, so without this a dead quota re-logs 5 warnings
 * per minute (the dominant dashboard-warning class on 6/10-6/11).
 */
const ANALYTICS_BACKOFF_KEY = "analytics-dataforseo-backoff";
const ANALYTICS_BACKOFF_TTL_SECONDS = 60 * 60;

/** Hard quota / rate-limit detection on the fetchRankedKeywords error string. */
function isDataForSeoQuotaError(error: string): boolean {
  return /^HTTP\s*(?:402|429)\b|status_code=402\d{2}\b|\bquota\b|\bcredit/i.test(
    error
  );
}

/**
 * One tick of the analytics pull. Selects up to `batchSize` published
 * articles whose newest article_rankings snapshot is older than
 * `staleAfterHours` (or which have never been pulled), calls
 * `fetchRankedKeywords` for each, and writes the results.
 *
 * Returns a summary the caller can log. Never throws — the initial SQL
 * query is wrapped in a try-catch (returns `{ ran: false, error }` on
 * table-missing or other DB errors); per-kvKey fetch/write failures are
 * caught and counted in `errors`; articles with 0 ranked keywords are
 * counted in `zeroRankings`.
 */
export async function runAnalyticsTick(
  agent: SEOArticleAgent,
  opts: { batchSize?: number; staleAfterHours?: number } = {}
): Promise<AnalyticsTickResult> {
  const batchSize = opts.batchSize ?? 5;
  const staleAfterHours =
    typeof opts.staleAfterHours === "number" &&
    opts.staleAfterHours > 0 &&
    Number.isFinite(opts.staleAfterHours)
      ? opts.staleAfterHours
      : 168;

  const { creds, missing } = resolveDataForSeoCreds(
    agent.envBindings.DATAFORSEO_LOGIN,
    agent.envBindings.DATAFORSEO_PASSWORD
  );
  if (!creds) {
    if (missing.length === 1) {
      agent.log(
        "warning",
        `Analytics tick skipped: missing ${missing[0]}; set both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to enable ranked-keyword tracking`,
        "rankTracker"
      );
    }
    return {
      ran: false,
      pulled: 0,
      rowsInserted: 0,
      errors: 0,
      zeroRankings: 0
    };
  }
  const { login, password } = creds;

  // Quota backoff: if a recent tick hit a hard 402/429, skip silently
  // until the TTL expires. The activation log line was written when the
  // backoff was set; re-logging every minute is exactly the spam this
  // prevents.
  try {
    const backedOff = await agent.envBindings.ARTICLES_KV.get(
      ANALYTICS_BACKOFF_KEY
    );
    if (backedOff) {
      return {
        ran: true,
        pulled: 0,
        rowsInserted: 0,
        errors: 0,
        zeroRankings: 0
      };
    }
  } catch {
    /* best-effort; fall through to the normal tick */
  }

  // Pick stale + never-pulled articles. The LEFT JOIN finds the newest
  // ranking snapshot per kv_key (or NULL if never pulled); the WHERE keeps
  // articles whose newest snapshot is older than the staleness threshold.
  // Threshold is expressed in hours as a SQL `datetime('now', '-N hours')`
  // modifier — integer-only so we never depend on SQLite's decimal-modifier
  // parsing — then truncated to a yyyy-mm-dd string with date() so it lines
  // up with the date-only values stored in article_rankings.date.
  const staleModifier = `-${Math.max(1, Math.round(staleAfterHours))} hours`;
  // Use a.kv_key directly from the articles table (rather than recomputing
  // `${category_slug}:${slug}`) so any future change to kv_key formatting
  // is automatically picked up by the analytics tick without drift.
  let stale: ArticleRow[];
  try {
    stale = agent.sql<ArticleRow>`
      SELECT a.kv_key, a.url
      FROM articles a
      LEFT JOIN (
        SELECT kv_key, MAX(date) AS last_date
        FROM article_rankings
        WHERE country = 'US'
        GROUP BY kv_key
      ) r ON r.kv_key = a.kv_key
      WHERE a.url <> ''
        AND (
          r.last_date IS NULL
          OR r.last_date < date('now', ${staleModifier})
        )
      ORDER BY r.last_date IS NOT NULL, r.last_date ASC
      LIMIT ${batchSize}
    `;
  } catch (err: unknown) {
    // article_rankings table may not exist yet on fresh DO instances before
    // the first article is published. Return the error shape so the function
    // never throws — matching the "Never throws" contract in the JSDoc.
    return {
      ran: false,
      pulled: 0,
      rowsInserted: 0,
      errors: 0,
      zeroRankings: 0,
      error: errMsg(err)
    };
  }

  if (stale.length === 0) {
    return {
      ran: true,
      pulled: 0,
      rowsInserted: 0,
      errors: 0,
      zeroRankings: 0
    };
  }

  let pulled = 0;
  let rowsInserted = 0;
  let errors = 0;
  let zeroRankings = 0;
  const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd UTC

  for (const article of stale) {
    pulled++;
    const kvKey = article.kv_key;
    try {
      const result = await fetchRankedKeywords(
        { login, password },
        article.url,
        {
          limit: 100,
          locationCode: 2840
        }
      );
      if ("error" in result) {
        errors++;
        if (/^(?:HTTP 401\b|status_code=401\d{2}\b)/i.test(result.error)) {
          agent.log(
            "warning",
            `Analytics tick: DataForSEO unauthorized — verify DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD and rotate credentials if needed`,
            "rankTracker"
          );
          break; // All remaining articles will fail with the same 401; stop the batch.
        }
        if (isDataForSeoQuotaError(result.error)) {
          // The previous pattern only matched "HTTP 429"/"status_code=402xx"
          // and missed the live "HTTP 402: {...}" shape, so the batch kept
          // going and every per-minute tick re-logged 5 warnings.
          try {
            const until = new Date(
              Date.now() + ANALYTICS_BACKOFF_TTL_SECONDS * 1000
            ).toISOString();
            await agent.envBindings.ARTICLES_KV.put(
              ANALYTICS_BACKOFF_KEY,
              until,
              { expirationTtl: ANALYTICS_BACKOFF_TTL_SECONDS }
            );
          } catch {
            /* best-effort */
          }
          agent.log(
            "warning",
            `Analytics tick: DataForSEO rate-limited or quota-exceeded (${result.error.slice(0, 60)}) — stopping batch and backing off for 60 min`,
            "rankTracker"
          );
          break; // Rate-limit or quota exhaustion is account-wide; continuing wastes quota.
        }
        agent.log(
          "warning",
          `Analytics tick: ranked_keywords failed for ${kvKey}: ${result.error}`,
          "rankTracker"
        );
        continue;
      }
      if (result.rows.length === 0) {
        // Article exists but ranks for nothing in the requested location yet.
        // Insert a single zero-row sentinel so the tick doesn't re-pick this
        // article every minute. Sentinel uses keyword='__none__' to disambiguate.
        agent.sql`
          INSERT OR REPLACE INTO article_rankings
            (kv_key, keyword, date, position, search_volume,
             est_traffic, cpc, serp_features, country)
          VALUES (${kvKey}, '__none__', ${today}, 0, 0, 0, 0, '', 'US')
        `;
        zeroRankings++;
        agent.log(
          "info",
          `Analytics tick: ${kvKey} ranks for 0 keywords (sentinel written)`,
          "rankTracker"
        );
        continue;
      }
      for (const row of result.rows) {
        agent.sql`
          INSERT OR REPLACE INTO article_rankings
            (kv_key, keyword, date, position, search_volume,
             est_traffic, cpc, serp_features, country)
          VALUES (
            ${kvKey},
            ${row.keyword},
            ${today},
            ${row.position},
            ${row.searchVolume},
            ${row.estTraffic},
            ${row.cpc},
            ${row.serpFeatures.join(",")},
            'US'
          )
        `;
        rowsInserted++;
      }
      // Mirror the same rows into the queryable KEYWORDS_DB D1 ledger.
      // Best-effort: a D1 hiccup must never fail the analytics tick.
      try {
        const db = agent.envBindings.KEYWORDS_DB;
        if (db) {
          const stmt = db.prepare(
            `INSERT OR REPLACE INTO article_rankings
               (kv_key, keyword, date, position, search_volume,
                est_traffic, cpc, serp_features, country)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'US')`
          );
          await db.batch(
            result.rows.map((row) =>
              stmt.bind(
                kvKey,
                row.keyword,
                today,
                row.position,
                row.searchVolume,
                row.estTraffic,
                row.cpc,
                row.serpFeatures.join(",")
              )
            )
          );
        }
      } catch (d1Err: unknown) {
        agent.log(
          "warning",
          `Analytics tick: D1 rankings mirror failed for ${kvKey}: ${errMsg(d1Err)}`,
          "rankTracker"
        );
      }
      const top = result.rows[0];
      agent.log(
        "info",
        `Analytics tick: ${kvKey} — ${result.rows.length} ranked keywords (top: "${top.keyword}" at #${top.position}, est ${Math.round(top.estTraffic)} traffic)`,
        "rankTracker",
        { kanbanStage: "done" }
      );
    } catch (err: unknown) {
      errors++;
      agent.log(
        "warning",
        `Analytics tick: unexpected failure for ${kvKey}: ${errMsg(err)}`,
        "rankTracker"
      );
    }
  }

  return {
    ran: true,
    pulled,
    rowsInserted,
    errors,
    zeroRankings
  };
}
