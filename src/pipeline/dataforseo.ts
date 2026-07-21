import { errMsg } from "./http-utils";

/** Network timeout for DataForSEO endpoints, by endpoint shape. */
const DFSEO_TIMEOUT_SUBMIT_MS = 15_000;
const DFSEO_TIMEOUT_POLL_MS = 10_000;
const DFSEO_TIMEOUT_DEFAULT_MS = 30_000;
/**
 * DataForSEO on-page audit — submits the just-published article URL to the
 * DataForSEO crawler, polls until the crawl finishes, returns the crawl's
 * onpage_score (0-100) and the failed-checks count. Wired from
 * finalizeArticle() in writer.ts via ctx.waitUntil so polling never blocks
 * the pipeline return.
 *
 * Auth: HTTP Basic (DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD worker secrets).
 * Login is the account email; password is the API password from
 * app.dataforseo.com/api-access (NOT the dashboard login).
 */

const TASK_POST_URL = "https://api.dataforseo.com/v3/on_page/task_post";
const SUMMARY_URL = "https://api.dataforseo.com/v3/on_page/summary";
const CRAWL_COMPLETE_STATUSES = new Set(["finished", "done", "completed"]);
const CRAWL_COMPLETE_PERCENT_RE = /^100(?:\.0+)?\s*%/;
// Some API responses include suffix text after the percent (for example
// "100% (finished)"), so percentage completion stays a prefix check below.

/**
 * HTTP Basic credentials for the DataForSEO API.
 * `login` is the account email; `password` is the API password from
 * app.dataforseo.com/api-access (NOT the dashboard login password).
 */
export interface DataForSeoCreds {
  login: string;
  password: string;
}

type DataForSeoMissingBinding = "DATAFORSEO_LOGIN" | "DATAFORSEO_PASSWORD";

/**
 * On-page audit result returned by `fetchOnPageScore` once the crawl finishes.
 */
export interface OnPageScore {
  /** DataForSEO task ID assigned at submission time. */
  taskId: string;
  /** Overall on-page quality score (0–100). Higher is better. */
  onPageScore: number;
  /** Number of on-page checks that failed (lower is better). */
  failedChecks: number;
  /** Raw crawl-progress string from DataForSEO (e.g. "finished", "100% (finished)"). */
  crawlProgress: string;
}

/**
 * Resolves DataForSEO credentials from raw binding values.
 *
 * - Both present → `{ creds: DataForSeoCreds, missing: [] }`
 * - Both absent  → `{ creds: null, missing: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"] }` (silent skip)
 * - One absent   → `{ creds: null, missing: ["DATAFORSEO_LOGIN" | "DATAFORSEO_PASSWORD"] }` (warn)
 *
 * Typical usage pattern shared across DataForSEO callers:
 * ```ts
 * const { creds, missing } = resolveDataForSeoCreds(
 *   agent.envBindings.DATAFORSEO_LOGIN,
 *   agent.envBindings.DATAFORSEO_PASSWORD
 * );
 * if (!creds) {
 *   if (missing.length === 1) {
 *     agent.log("warning", `…missing ${missing[0]}; set both …`);
 *   }
 *   return;
 * }
 * ```
 */
export function resolveDataForSeoCreds(
  login: string | undefined,
  password: string | undefined
):
  | { creds: DataForSeoCreds; missing: [] }
  | { creds: null; missing: DataForSeoMissingBinding[] } {
  const l = login?.trim() ?? "";
  const p = password?.trim() ?? "";
  const missing: DataForSeoMissingBinding[] = [];
  if (!l) missing.push("DATAFORSEO_LOGIN");
  if (!p) missing.push("DATAFORSEO_PASSWORD");
  if (missing.length > 0) return { creds: null, missing };
  return { creds: { login: l, password: p }, missing: [] };
}

/** @internal Shared by dataforseo-ranked-keywords.ts */
export function authHeader({ login, password }: DataForSeoCreds): string {
  return `Basic ${btoa(`${login}:${password}`)}`;
}

/** @internal Shared by dataforseo-ranked-keywords.ts */
export interface JsonObj {
  [k: string]: unknown;
}
/** @internal Shared by dataforseo-ranked-keywords.ts */
export function pick<T = unknown>(
  obj: unknown,
  path: readonly (string | number)[]
): T | undefined {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") {
      cur = (cur as JsonObj)[String(k)];
    } else return undefined;
  }
  return cur as T | undefined;
}

/**
 * Result of submitting a single-page on-page crawl task to DataForSEO.
 * On success: `{ ok: true, taskId }`. On failure: `{ ok: false, errorStatus?, errorMessage? }`.
 */
interface SubmitResult {
  /** True when DataForSEO accepted the task and returned a valid task ID. */
  ok: boolean;
  /** DataForSEO task ID; present only when `ok` is true. */
  taskId?: string;
  /** HTTP status code returned by DataForSEO; present on non-2xx responses. */
  errorStatus?: number;
  /** Human-readable error description; present on any failure mode. */
  errorMessage?: string;
}

/**
 * Submit a single-page on-page crawl task to DataForSEO.
 * Returns `{ ok: true, taskId }` on success, or an error shape on any
 * failure (network, non-2xx, bad API status). Never throws.
 * Called by `fetchOnPageScore`; use that for the combined submit-and-poll
 * flow.
 */
async function submitOnPageTask(
  creds: DataForSeoCreds,
  url: string
): Promise<SubmitResult> {
  let res: Response;
  try {
    res = await fetch(TASK_POST_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json"
      },
      body: JSON.stringify([{ target: url, max_crawl_pages: 1 }]),
      signal: AbortSignal.timeout(DFSEO_TIMEOUT_SUBMIT_MS)
    });
  } catch (err: unknown) {
    return {
      ok: false,
      errorMessage: errMsg(err)
    };
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, errorStatus: res.status, errorMessage: body };
  }
  const json = (await res.json().catch(() => null)) as unknown;
  const apiStatus = pick<number>(json, ["status_code"]);
  if (apiStatus !== 20000) {
    return {
      ok: false,
      errorStatus: apiStatus,
      errorMessage: String(pick<string>(json, ["status_message"]) ?? "")
    };
  }
  const taskId = pick<string>(json, ["tasks", 0, "id"]);
  return taskId
    ? { ok: true, taskId }
    : { ok: false, errorMessage: "no task id" };
}

/**
 * One-poll result from `pollOnPageSummary`. The caller loops until `done` is
 * true or a timeout is reached.
 */
interface PollResult {
  /** True when the crawl has finished (successfully or with an error). */
  done: boolean;
  /** On-page audit result; present only when `done` is true and the crawl succeeded. */
  score?: OnPageScore;
  /** Error description when polling fails or the crawl returns an error status. */
  errorMessage?: string;
}

/**
 * Poll the DataForSEO on-page summary endpoint for a previously submitted
 * task. Returns `{ done: false }` while the crawl is still in progress, and
 * `{ done: true, score }` once finished. Returns `done: false` with an
 * `errorMessage` on any failure (network, non-2xx, bad API status). Never
 * throws. Called in a polling loop by `fetchOnPageScore`.
 */
async function pollOnPageSummary(
  creds: DataForSeoCreds,
  taskId: string
): Promise<PollResult> {
  let res: Response;
  try {
    res = await fetch(`${SUMMARY_URL}/${taskId}`, {
      method: "GET",
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(DFSEO_TIMEOUT_POLL_MS)
    });
  } catch (err: unknown) {
    return {
      done: false,
      errorMessage: errMsg(err)
    };
  }
  if (!res.ok) {
    return { done: false, errorMessage: `HTTP ${res.status}` };
  }
  const json = (await res.json().catch(() => null)) as unknown;
  const apiStatus = pick<number>(json, ["status_code"]);
  if (apiStatus !== 20000) {
    return {
      done: false,
      errorMessage: `status_code=${apiStatus}: ${pick<string>(json, ["status_message"])}`
    };
  }
  const result = pick(json, ["tasks", 0, "result", 0]);
  const rawCrawlProgress = pick<string>(result, ["crawl_progress"]);
  const crawlProgress = rawCrawlProgress?.trim() || "unknown";
  const normalizedCrawlProgress = crawlProgress.toLowerCase();
  const crawlComplete =
    CRAWL_COMPLETE_STATUSES.has(normalizedCrawlProgress) ||
    CRAWL_COMPLETE_PERCENT_RE.test(normalizedCrawlProgress);
  if (!crawlComplete) {
    return { done: false };
  }
  const pageMetrics = pick<JsonObj>(result, ["page_metrics"]);
  if (!pageMetrics) {
    return { done: false, errorMessage: "summary missing page_metrics" };
  }
  const onPageScore = pick<number>(pageMetrics, ["onpage_score"]);
  if (typeof onPageScore !== "number" || !Number.isFinite(onPageScore)) {
    return { done: false, errorMessage: "summary missing onpage_score" };
  }
  const checks = pick<JsonObj>(pageMetrics, ["checks"]) ?? {};
  let failedChecks = 0;
  for (const v of Object.values(checks)) {
    if (typeof v === "number") failedChecks += v;
  }
  return {
    done: true,
    score: { taskId, onPageScore, failedChecks, crawlProgress }
  };
}

/**
 * Submit + poll until done or timeout. DataForSEO crawls typically finish in
 * 30-90s for a single page; we poll every 8s for up to 4 minutes total.
 * Returns null on any failure or timeout — caller should treat absence as
 * "no signal", never as "score=0".
 */
export async function fetchOnPageScore(
  creds: DataForSeoCreds,
  url: string,
  opts: { maxWaitMs?: number; pollIntervalMs?: number } = {}
): Promise<{ score?: OnPageScore; error?: string }> {
  const submitResult = await submitOnPageTask(creds, url);
  if (!submitResult.ok || !submitResult.taskId) {
    return {
      error: `task_post failed: ${submitResult.errorMessage ?? submitResult.errorStatus}`
    };
  }

  const taskId = submitResult.taskId;
  const maxWaitMs = opts.maxWaitMs ?? 4 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 8_000;
  const startedAt = Date.now();

  // Wait once before the first poll — task_post returns instantly but the
  // crawl needs a few seconds to even start.
  await new Promise((r) => setTimeout(r, pollIntervalMs));

  while (Date.now() - startedAt < maxWaitMs) {
    const poll = await pollOnPageSummary(creds, taskId);
    if (poll.done && poll.score) return { score: poll.score };
    if (poll.errorMessage && !poll.done) {
      // Transient errors are common while the task is queued; only abort on
      // auth/quota errors.
      if (
        poll.errorMessage.includes("40100") ||
        poll.errorMessage.includes("40200") ||
        poll.errorMessage.startsWith("HTTP 401") ||
        poll.errorMessage.startsWith("HTTP 403") ||
        poll.errorMessage.startsWith("HTTP 429")
      ) {
        return { error: poll.errorMessage };
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return {
    error: `timeout after ${Math.round((Date.now() - startedAt) / 1000)}s`
  };
}

// ── SERP Live Advanced ──────────────────────────────────────────────────────
const SERP_LIVE_URL =
  "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";

/**
 * Structured SERP data returned by `fetchSerpLive` for a single keyword.
 */
export interface SerpLiveResult {
  /** Page titles of the top organic results (up to 10). */
  topTitles: string[];
  /** URLs of the top organic results (up to 10). */
  topUrls: string[];
  /** "People also ask" questions extracted from the SERP (may be empty). */
  paaQuestions: string[];
  /** Featured snippet description text, when present in the SERP. */
  featuredSnippet?: string;
}

/**
 * Fetch Google SERP for `keyword` via DataForSEO's Live Advanced endpoint.
 * Returns clean structured organic + PAA + featured snippets in a single
 * synchronous call (no submit/poll). Used as the top-priority tier in the
 * SERP fallback chain in src/pipeline/serp.ts; silent no-op when creds
 * unset (caller checks).
 */
export async function fetchSerpLive(
  creds: DataForSeoCreds,
  keyword: string
): Promise<{ ok: true; data: SerpLiveResult } | { error: string }> {
  let res: Response;
  try {
    res = await fetch(SERP_LIVE_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json"
      },
      body: JSON.stringify([
        {
          keyword,
          language_code: "en",
          location_code: 2840,
          depth: 10
        }
      ]),
      signal: AbortSignal.timeout(DFSEO_TIMEOUT_DEFAULT_MS)
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
    return { error: "no items in result" };
  }

  const topTitles: string[] = [];
  const topUrls: string[] = [];
  const paaQuestions: string[] = [];
  let featuredSnippet: string | undefined;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = (item as JsonObj).type as string | undefined;
    if (type === "organic") {
      const title = (item as JsonObj).title;
      const url = (item as JsonObj).url;
      if (typeof title === "string" && title.trim()) topTitles.push(title);
      if (typeof url === "string" && url.trim()) topUrls.push(url);
    } else if (type === "featured_snippet") {
      const desc = (item as JsonObj).description;
      if (typeof desc === "string" && desc.trim()) {
        featuredSnippet = desc;
      }
    } else if (type === "people_also_ask") {
      const paaItems = (item as JsonObj).items;
      if (Array.isArray(paaItems)) {
        for (const paa of paaItems) {
          if (!paa || typeof paa !== "object") continue;
          const q = (paa as JsonObj).title;
          if (typeof q === "string" && q.trim()) paaQuestions.push(q);
        }
      }
    }
  }

  return {
    ok: true,
    data: { topTitles, topUrls, paaQuestions, featuredSnippet }
  };
}

// ── DataForSEO Labs: Keyword Suggestions ────────────────────────────────────
const KEYWORD_SUGGESTIONS_URL =
  "https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live";

/**
 * One long-tail keyword suggestion from `fetchKeywordSuggestions`.
 */
export interface KeywordSuggestion {
  /** The suggested keyword string. */
  keyword: string;
  /** Monthly Google search volume (0 when DataForSEO has no data). */
  searchVolume: number;
  /** Avg. cost-per-click in USD from Google Ads (0 when unavailable). */
  cpc: number;
  /** Keyword difficulty score (0–100); higher means harder to rank for. */
  keywordDifficulty: number;
}

/**
 * Expand a seed keyword into long-tail candidates with real demand data.
 * Returns up to `opts.limit` (default 50) suggestions, each with monthly
 * search volume, CPC, and difficulty (0-100). Caller ranks them by ROI
 * proxy. Silent error-shape return on failure (never throws).
 */
export async function fetchKeywordSuggestions(
  creds: DataForSeoCreds,
  seedKeyword: string,
  opts: { limit?: number } = {}
): Promise<{ ok: true; suggestions: KeywordSuggestion[] } | { error: string }> {
  const normalizedSeedKeyword = seedKeyword.trim();
  if (normalizedSeedKeyword.length === 0) {
    return { ok: true, suggestions: [] };
  }
  const limit = opts.limit ?? 50;
  let res: Response;
  try {
    res = await fetch(KEYWORD_SUGGESTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json"
      },
      body: JSON.stringify([
        {
          keyword: normalizedSeedKeyword,
          language_code: "en",
          location_code: 2840,
          limit,
          include_serp_info: false
        }
      ]),
      signal: AbortSignal.timeout(DFSEO_TIMEOUT_DEFAULT_MS)
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
    return { ok: true, suggestions: [] };
  }

  const suggestions: KeywordSuggestion[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const keyword = (item as JsonObj).keyword;
    if (typeof keyword !== "string" || !keyword.trim()) continue;
    const searchVolume =
      pick<number>(item, ["keyword_info", "search_volume"]) ?? 0;
    const cpc = pick<number>(item, ["keyword_info", "cpc"]) ?? 0;
    const keywordDifficulty =
      pick<number>(item, ["keyword_properties", "keyword_difficulty"]) ?? 0;
    suggestions.push({
      keyword,
      searchVolume,
      cpc,
      keywordDifficulty
    });
  }

  return { ok: true, suggestions };
}

// ── Google Ads Search Volume ────────────────────────────────────────────────
const SEARCH_VOLUME_URL =
  "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live";

export interface SearchVolumeRow {
  keyword: string;
  /**
   * Monthly search volume as returned by DataForSEO, or `null` when the API
   * does not have volume data for the keyword (common for ultra-long-tail
   * terms). Callers must treat `null` as "no data" rather than "zero traffic".
   */
  searchVolume: number | null;
  cpc: number;
  competition: number;
}

/**
 * Fetch monthly Google search volume + CPC + competition for up to 1000
 * keywords in a single call. Used by the writer pipeline to gate Kimi
 * spend on dead keywords (search_volume<50 → skip article).
 *
 * Input keywords are trimmed and de-duplicated (first occurrence wins) before
 * sending the API request, so repeated keywords do not waste request budget.
 *
 * Returns one row per keyword that DataForSEO recognised; keywords with no
 * data are silently absent from the result set. Caller must look up by
 * normalised keyword text. Silent error-shape return on failure.
 */
export async function fetchSearchVolume(
  creds: DataForSeoCreds,
  keywords: string[]
): Promise<{ ok: true; rows: SearchVolumeRow[] } | { error: string }> {
  if (keywords.length === 0) return { ok: true, rows: [] };
  const trimmed: string[] = [];
  const seenKeywords = new Set<string>();
  for (const rawKeyword of keywords) {
    const keyword = rawKeyword.trim();
    if (!keyword || seenKeywords.has(keyword)) continue;
    seenKeywords.add(keyword);
    trimmed.push(keyword);
    if (trimmed.length >= 1000) break;
  }
  if (trimmed.length === 0) return { ok: true, rows: [] };

  let res: Response;
  try {
    res = await fetch(SEARCH_VOLUME_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json"
      },
      body: JSON.stringify([
        {
          keywords: trimmed,
          language_code: "en",
          location_code: 2840
        }
      ]),
      signal: AbortSignal.timeout(DFSEO_TIMEOUT_DEFAULT_MS)
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
  const result = pick(json, ["tasks", 0, "result"]);
  if (!Array.isArray(result)) {
    return { ok: true, rows: [] };
  }

  const rows: SearchVolumeRow[] = [];
  for (const r of result) {
    if (!r || typeof r !== "object") continue;
    const keyword = (r as JsonObj).keyword;
    if (typeof keyword !== "string") continue;
    rows.push({
      keyword,
      // Preserve null from the API response — undefined is normalised to null.
      // Callers (keyword-metrics.ts) rely on null to detect "no data" and
      // skip the DB write so ultra-long-tail keywords aren't recorded as
      // having zero monthly searches.
      searchVolume:
        ((r as JsonObj).search_volume as number | null | undefined) ?? null,
      cpc: ((r as JsonObj).cpc as number | null | undefined) ?? 0,
      competition:
        ((r as JsonObj).competition as number | null | undefined) ?? 0
    });
  }

  return { ok: true, rows };
}
