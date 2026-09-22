import { errMsg, getEnvBinding } from "./http-utils";
import { enforceNoFabricatedTestingClaims } from "./fabricated-testing-claims";
import { removeTrustBox } from "./trust-box-removal";
import { calculateSEOScore } from "./seo-score";
import {
  articlePathToKvKey,
  prefixReviewsOnArticlePath,
  prodArticlePath,
  prodArticleUrl
} from "./article-public-url";

/**
 * prod-publish.ts — direct-to-production article publishing.
 *
 * catsluvus.com is the money site; the staging workers.dev domain is a
 * workshop. Every article that clears the quality bar
 * (PROD_PUBLISH_MIN_SCORE, default 90) ships to production as the final
 * pipeline step: its HTML is rewritten for the production domain,
 * written into the production ARTICLES_KV namespace (which catsluvus.com
 * serves), registered in the production category + global indexes, and
 * the staging URL becomes a 301 so the two domains never compete.
 * Articles below the bar stay staging-only for revision — catsluvus.com
 * never receives an article that failed the bar.
 *
 * article_ledger columns googlebot_hits / human_views / last_crawled_at
 * (incremented by the Worker fetch handler on staging serves) remain as
 * observability; promotion_status records 'published-prod' on ship.
 */

/** Default production target when PROMOTION_TARGET_DOMAIN is unset. */
export const DEFAULT_PROMOTION_TARGET_DOMAIN = "catsluvus.com";

/**
 * Quality bar for shipping an article to catsluvus.com.
 * Overridable with the PROD_PUBLISH_MIN_SCORE binding. Empty, non-numeric,
 * and non-positive values stay at the default so a blank binding cannot
 * publish every staging article.
 */
export const DEFAULT_PROD_PUBLISH_MIN_SCORE = 90;

/** Articles fetched per backlog request. Kept small so a DO request finishes. */
export const PROMOTE_BACKLOG_BATCH_DEFAULT = 5;
export const PROMOTE_BACKLOG_BATCH_MAX = 15;

export function resolveProdPublishMinScore(
  raw: string | undefined | null
): number {
  if (raw == null) return DEFAULT_PROD_PUBLISH_MIN_SCORE;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_PROD_PUBLISH_MIN_SCORE;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PROD_PUBLISH_MIN_SCORE;
  return n;
}

/**
 * A caller may ask for a stricter bar. A lower request is ignored so the
 * backlog script cannot undercut PROD_PUBLISH_MIN_SCORE.
 */
export function clampProdPublishMinScore(
  configured: number,
  requested: number | undefined
): number {
  if (requested == null || !Number.isFinite(requested)) return configured;
  return Math.max(configured, requested);
}

export function clampPromoteBatchLimit(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw))
    return PROMOTE_BACKLOG_BATCH_DEFAULT;
  const n = Math.floor(raw);
  if (n < 1) return PROMOTE_BACKLOG_BATCH_DEFAULT;
  return Math.min(n, PROMOTE_BACKLOG_BATCH_MAX);
}

/**
 * Production ARTICLES_KV namespace (the one catsluvus.com reads).
 * Discoverable via the CF API from the `cats-seo-aiagent` worker's
 * bindings; overridable via PROD_ARTICLES_KV_NAMESPACE_ID.
 */
export const DEFAULT_PROD_ARTICLES_KV_NAMESPACE_ID =
  "bd3b856b2ae147ada9a8d236dd4baf30";

/**
 * REST access to the production ARTICLES_KV namespace. Cross-namespace
 * reads/writes are impossible through bindings (staging only binds its
 * own KV), so post-publish consumers (Editorial Agent, idle-tick CTR
 * rewrites) go through the Cloudflare API. Returns null when the worker
 * is missing CF credentials.
 */
export function prodKvRestApi(env: unknown): {
  base: string;
  headers: Record<string, string>;
} | null {
  const accountId = getEnvBinding(env, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = getEnvBinding(env, "CLOUDFLARE_API_TOKEN");
  const ns =
    getEnvBinding(env, "PROD_ARTICLES_KV_NAMESPACE_ID") ??
    DEFAULT_PROD_ARTICLES_KV_NAMESPACE_ID;
  if (!accountId || !apiToken) return null;
  return {
    base: `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${ns}/values`,
    headers: { Authorization: `Bearer ${apiToken}` }
  };
}

/**
 * Rewrite every reference to the staging host into the production host:
 * canonical link, og:url, JSON-LD @id/url fields, internal links,
 * breadcrumbs — anything carrying the old origin. Scheme-qualified and
 * protocol-relative forms both covered.
 *
 * Two-segment article paths (`/{category}/{slug}`) also gain the
 * production `/reviews` prefix. One-segment assets (logo, feed, category
 * index) stay put, and a path that already starts with `/reviews` is
 * not prefixed again.
 */
export function rewriteHtmlForDomain(
  html: string,
  fromHost: string,
  toHost: string
): { html: string; replacements: number } {
  if (!fromHost || fromHost === toHost) return { html, replacements: 0 };
  const escaped = fromHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let replacements = 0;
  const rewritten = html.replace(
    new RegExp(`(https?:)?//${escaped}([^\\s"'<>)]*)`, "gi"),
    (_full, _scheme: string, rest: string) => {
      replacements++;
      const suffix = rest ?? "";
      const path = suffix.startsWith("/")
        ? prefixReviewsOnArticlePath(suffix)
        : suffix;
      return `https://${toHost}${path}`;
    }
  );
  return { html: rewritten, replacements };
}

/** UA classification for the serve-time tracking hook. */
export function classifyUserAgent(
  ua: string
): "googlebot" | "other-bot" | "human" {
  if (/googlebot|google-inspectiontool/i.test(ua)) return "googlebot";
  if (
    /bot\b|crawler|spider|slurp|bingpreview|python-requests|python-httpx|curl\/|wget\/|headless|lighthouse|pagespeed|dataforseo|ahrefs|semrush|petalbot|bytespider|facebookexternalhit/i.test(
      ua
    )
  ) {
    return "other-bot";
  }
  return "human";
}

export interface ProdPublishResult {
  ok: boolean;
  kvKey: string;
  prodUrl?: string;
  replacements?: number;
  bytes?: number;
  dryRun?: boolean;
  indexes?: { category: boolean; global: boolean };
  /**
   * Fabricated testing/expert sentences the pre-prod FTC gate had to
   * excise. Non-zero means a post-Step-14.7 model rewrite reintroduced
   * a violation and this gate caught it — worth alerting on.
   */
  ftcRemoved?: number;
  /** Sample of the first excised sentence, for the alert log. */
  ftcSample?: string;
  /**
   * "Why You Should Trust Us" blocks removed at the prod boundary.
   * Non-zero means a model rewrite reinvented a block the template no
   * longer emits — worth alerting on.
   */
  trustBoxRemoved?: number;
  error?: string;
}

/**
 * Extract the article's display title for the production index: the H1
 * text when present, else the <title> minus its " | …" / " — …" suffix.
 */
export function extractArticleTitleForIndex(
  html: string,
  fallbackSlug: string
): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const raw = h1
    ? h1[1]
    : (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const text = raw
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = h1 ? text : text.replace(/\s*[|—–]\s+[^|—–]*$/, "").trim();
  return (
    cleaned ||
    fallbackSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** Append a slug to a per-category index array, deduped; null input = new. */
export function mergeCategoryIndex(
  existingJson: string | null,
  slug: string
): { json: string; changed: boolean } {
  let arr: string[] = [];
  try {
    const parsed = existingJson ? JSON.parse(existingJson) : [];
    if (Array.isArray(parsed))
      arr = parsed.filter((s) => typeof s === "string");
  } catch {
    arr = [];
  }
  if (arr.includes(slug)) return { json: JSON.stringify(arr), changed: false };
  arr.push(slug);
  return { json: JSON.stringify(arr), changed: true };
}

export interface GlobalIndexEntry {
  slug: string;
  url: string;
  title: string;
  category: string;
  image: string | null;
}

/** Append an entry to the global v2_articles_index, deduped by slug+category. */
export function mergeGlobalIndex(
  existingJson: string | null,
  entry: GlobalIndexEntry
): { json: string; changed: boolean } {
  let arr: GlobalIndexEntry[] = [];
  try {
    const parsed = existingJson ? JSON.parse(existingJson) : [];
    if (Array.isArray(parsed)) arr = parsed as GlobalIndexEntry[];
  } catch {
    arr = [];
  }
  const exists = arr.some(
    (e) => e && e.slug === entry.slug && e.category === entry.category
  );
  if (exists) return { json: JSON.stringify(arr), changed: false };
  arr.push(entry);
  return { json: JSON.stringify(arr), changed: true };
}

const ARTICLE_KV_KEY_RE = /^[^:]+:[^:]+$/;

/** Ledger `seo_score` of 0 is the column default, not a measured failure. */
export function usableLedgerScore(
  score: number | null | undefined
): number | null {
  if (typeof score !== "number" || !Number.isFinite(score) || score <= 0) {
    return null;
  }
  return score;
}

export type ProdPromoteSkipReason =
  | "invalid-key"
  | "already-promoted"
  | "missing-html"
  | "below-bar"
  | "unscored";

export type ProdPromoteScoreSource =
  | "ledger"
  | "rescore"
  | "unscored-completed";

export type ProdPromoteDecision = {
  score: number | null;
  scoreSource: ProdPromoteScoreSource | null;
} & (
  | { promote: true; reason: "promote" }
  | { promote: false; reason: ProdPromoteSkipReason }
);

/**
 * Whether one staging article may be written to production KV.
 *
 * When `rescored` is set it is the score of the HTML about to be
 * copied and it decides eligibility. A ledger score is the fallback
 * when that rescore could not be computed. `allowUnscoredCompleted`
 * ships completed staging HTML only when no score can be computed; it
 * does not publish articles that scored under the bar.
 */
export function decideProdPromotion(input: {
  kvKey: string;
  minScore: number;
  ledgerScore: number | null;
  hasStagingHtml: boolean;
  hasRedirectTombstone: boolean;
  rescored: number | null;
  allowUnscoredCompleted: boolean;
}): ProdPromoteDecision {
  if (!ARTICLE_KV_KEY_RE.test(input.kvKey)) {
    return {
      promote: false,
      reason: "invalid-key",
      score: null,
      scoreSource: null
    };
  }
  const ledger = usableLedgerScore(input.ledgerScore);
  if (input.hasRedirectTombstone) {
    return {
      promote: false,
      reason: "already-promoted",
      score: ledger,
      scoreSource: ledger == null ? null : "ledger"
    };
  }
  if (!input.hasStagingHtml) {
    return {
      promote: false,
      reason: "missing-html",
      score: ledger,
      scoreSource: ledger == null ? null : "ledger"
    };
  }
  // A live rescore of the HTML about to be copied is the same bar the
  // pipeline applies (`calculateSEOScore` >= PROD_PUBLISH_MIN_SCORE).
  // It wins over a stored ledger score so a stale below-bar row cannot
  // block a completed article that now clears the bar, and a stale
  // above-bar row cannot ship HTML that no longer does.
  if (input.rescored != null && Number.isFinite(input.rescored)) {
    if (input.rescored >= input.minScore) {
      return {
        promote: true,
        reason: "promote",
        score: input.rescored,
        scoreSource: "rescore"
      };
    }
    return {
      promote: false,
      reason: "below-bar",
      score: input.rescored,
      scoreSource: "rescore"
    };
  }
  if (ledger != null) {
    if (ledger >= input.minScore) {
      return {
        promote: true,
        reason: "promote",
        score: ledger,
        scoreSource: "ledger"
      };
    }
    return {
      promote: false,
      reason: "below-bar",
      score: ledger,
      scoreSource: "ledger"
    };
  }
  if (input.allowUnscoredCompleted) {
    return {
      promote: true,
      reason: "promote",
      score: null,
      scoreSource: "unscored-completed"
    };
  }
  return {
    promote: false,
    reason: "unscored",
    score: null,
    scoreSource: null
  };
}

/** Keyword for a rescore: the ledger keyword, else the category slug. */
export function keywordForProdRescore(
  categorySlug: string,
  ledgerKeyword: string | null | undefined
): string {
  const kw = ledgerKeyword?.trim() ?? "";
  if (kw) return kw;
  return categorySlug.replace(/-/g, " ");
}

/** Current scorecard score for staging HTML that has no ledger score. */
export function rescoreStagingArticle(html: string, keyword: string): number {
  const title = extractArticleTitleForIndex(html, keyword);
  return calculateSEOScore(html, keyword, title, "").score;
}

export function assessStagingArticleForPromotion(input: {
  kvKey: string;
  html: string | null;
  minScore: number;
  ledgerScore: number | null;
  ledgerKeyword: string | null;
  hasRedirectTombstone: boolean;
  allowUnscoredCompleted: boolean;
}): ProdPromoteDecision {
  const parts = input.kvKey.split(":");
  const categorySlug = parts[0] ?? "";
  let rescored: number | null = null;
  let rescoreFailed = false;
  const needsRescore = input.html != null && !input.hasRedirectTombstone;
  if (needsRescore && input.html != null) {
    try {
      rescored = rescoreStagingArticle(
        input.html,
        keywordForProdRescore(categorySlug, input.ledgerKeyword)
      );
    } catch {
      rescoreFailed = true;
      rescored = null;
    }
  }
  return decideProdPromotion({
    kvKey: input.kvKey,
    minScore: input.minScore,
    ledgerScore: input.ledgerScore,
    hasStagingHtml: input.html != null,
    hasRedirectTombstone: input.hasRedirectTombstone,
    rescored,
    allowUnscoredCompleted: input.allowUnscoredCompleted && rescoreFailed
  });
}

export interface SitemapArticleRef {
  kvKey: string;
  url: string;
}

/** Article URLs in a sitemap, deduped by kvKey and sorted by that key. */
export function articleEntriesFromSitemap(xml: string): SitemapArticleRef[] {
  const byKey = new Map<string, string>();
  const re = /<loc>([\s\S]*?)<\/loc>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const raw = match[1]?.trim().replace(/&amp;/g, "&") ?? "";
    if (!raw) continue;
    let pathname = raw;
    try {
      pathname = new URL(raw).pathname;
    } catch {
      continue;
    }
    const kvKey = articlePathToKvKey(pathname);
    if (kvKey && !byKey.has(kvKey)) byKey.set(kvKey, raw);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kvKey, url]) => ({ kvKey, url }));
}

/** Article kvKeys (`category:slug`) advertised in a sitemap document. */
export function articleKvKeysFromSitemap(xml: string): string[] {
  return articleEntriesFromSitemap(xml).map((entry) => entry.kvKey);
}

export interface LedgerPromotionRow {
  seoScore: number | null;
  keyword: string | null;
  promotionStatus: string | null;
}

export interface PromotionCandidateSummary {
  minScore: number;
  sitemapArticles: number;
  alreadyPromoted: number;
  eligibleByLedger: number;
  belowBar: number;
  /** In the sitemap, not tombstoned, and no usable ledger score. */
  unscored: number;
  sampleEligible: string[];
  sampleUnscored: string[];
}

/**
 * Counts from the sitemap, redirect tombstones, and ledger scores.
 * Does not fetch HTML or rescore — `unscored` still needs a rescore
 * pass before it can be promoted.
 */
export function summarizePromotionCandidates(input: {
  kvKeys: readonly string[];
  tombstones: ReadonlySet<string>;
  ledger: ReadonlyMap<string, Pick<LedgerPromotionRow, "seoScore">>;
  minScore: number;
}): PromotionCandidateSummary {
  const summary: PromotionCandidateSummary = {
    minScore: input.minScore,
    sitemapArticles: input.kvKeys.length,
    alreadyPromoted: 0,
    eligibleByLedger: 0,
    belowBar: 0,
    unscored: 0,
    sampleEligible: [],
    sampleUnscored: []
  };
  for (const kvKey of input.kvKeys) {
    if (input.tombstones.has(kvKey)) {
      summary.alreadyPromoted++;
      continue;
    }
    const ledger = usableLedgerScore(input.ledger.get(kvKey)?.seoScore);
    if (ledger == null) {
      summary.unscored++;
      if (summary.sampleUnscored.length < 20)
        summary.sampleUnscored.push(kvKey);
      continue;
    }
    if (ledger >= input.minScore) {
      summary.eligibleByLedger++;
      if (summary.sampleEligible.length < 20)
        summary.sampleEligible.push(kvKey);
      continue;
    }
    summary.belowBar++;
  }
  return summary;
}

/**
 * Publish one staging article to production:
 *  1. read staging HTML from ARTICLES_KV
 *  2. rewrite staging host → production host and insert `/reviews`
 *     on two-segment article paths
 *  3. PUT into the production ARTICLES_KV namespace via the CF REST API
 *  4. replace the staging copy with a `redirect:<kvKey>` tombstone
 *     (served as a 301) and delete the staging HTML
 *  5. mark the ledger row promoted
 *
 * `dryRun` performs steps 1-2 only and reports what would happen.
 *
 * `updateSitemap: false` leaves sitemap maintenance to a later
 * `pruneRedirectedFromSitemap` call (the backlog script does this once).
 * `skipStagingCleanupWrite` keeps a dry run from rewriting staging KV
 * when the FTC / trust-box gates would otherwise persist a cleanup.
 */
export async function publishArticleToProduction(
  env: unknown,
  articlesKv: KVNamespace,
  keywordsDb: D1Database | undefined,
  kvKey: string,
  dryRun: boolean,
  options?: {
    updateSitemap?: boolean;
    skipStagingCleanupWrite?: boolean;
  }
): Promise<ProdPublishResult> {
  const stagingHost = getEnvBinding(env, "DOMAIN") ?? "";
  const targetHost =
    getEnvBinding(env, "PROMOTION_TARGET_DOMAIN") ??
    DEFAULT_PROMOTION_TARGET_DOMAIN;

  const stagingHtml = await articlesKv.get(kvKey);
  if (stagingHtml === null) {
    return { ok: false, kvKey, error: "staging article not found in KV" };
  }

  // Last line of defense before the public site. Every article that
  // reaches catsluvus.com passes through prepareProductionArticle,
  // whichever pipeline step last wrote staging KV. On 2026-07-29 a
  // Polish-stage rewrite injected a fabricated expert into the
  // template after Step 14.7 had already passed.
  const prepared = prepareProductionArticle({
    kvKey,
    html: stagingHtml,
    fromHost: stagingHost,
    toHost: targetHost
  });
  if (!prepared.ok) return prepared;

  const { categorySlug, slug, rewritten, replacements, prodUrl } = prepared;
  if (prepared.changed && options?.skipStagingCleanupWrite !== true) {
    // Write the cleaned copy back to staging too, so the two
    // namespaces do not diverge and a later re-publish cannot
    // resurrect the excised text.
    await articlesKv.put(kvKey, prepared.cleanedHtml).catch(() => {});
  }

  if (dryRun) {
    return {
      ok: true,
      kvKey,
      prodUrl,
      replacements,
      bytes: rewritten.length,
      dryRun: true,
      ftcRemoved: prepared.ftcRemoved,
      ftcSample: prepared.ftcSample,
      trustBoxRemoved: prepared.trustBoxRemoved
    };
  }

  const auth = prodKvAuthFromEnv(env);
  if (!auth) {
    return {
      ok: false,
      kvKey,
      error:
        "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not configured on this worker"
    };
  }

  // 3. Write to the production namespace via REST (cross-namespace writes
  // are not possible through bindings — staging only binds its own KV).
  const putRes = await putProdKvValue(
    auth,
    kvKey,
    rewritten,
    "text/plain; charset=UTF-8"
  );
  if (!putRes.ok) {
    return { ok: false, kvKey, error: putRes.error };
  }

  // 3b. Register the article in the production indexes so catsluvus.com
  // links to it from category pages and includes it in the category
  // sitemap (petinsurance builds both from `articles-index:<category>`,
  // and site-wide listings from `v2_articles_index`). Without this a
  // promoted article is an orphan page. Best-effort read-modify-write.
  const indexes = { category: false, global: false };
  try {
    const registered = await registerProdIndexBatch(env, [
      {
        categorySlug,
        slug,
        title: extractArticleTitleForIndex(rewritten, slug)
      }
    ]);
    indexes.category = registered.categoriesUpdated > 0;
    indexes.global = registered.globalUpdated;
  } catch {
    // Index registration is best-effort — the article itself is already
    // live; a failed index write only delays internal-link discovery.
  }

  // 4. Tombstone: staging URL now 301s to production. Order matters —
  // write the redirect BEFORE deleting the HTML so there is no window
  // where the staging URL 404s.
  await articlesKv.put(`redirect:${kvKey}`, prodUrl);
  await articlesKv.delete(kvKey);

  // Drop the now-redirecting staging URL from the staging sitemap. A sitemap
  // must advertise canonical, indexable URLs; a promoted URL only 301s to
  // production, so leaving it listed surfaces it in Search Console as "Page
  // with redirect" and wastes crawl budget. Best-effort — the promotion has
  // already succeeded and must not be failed by sitemap bookkeeping.
  if (stagingHost && options?.updateSitemap !== false) {
    // Dynamic import: indexing.ts type-imports the agent, and server.ts
    // value-imports this module. A top-level import cycles at load.
    const { removeUrlFromSitemap } = await import("./indexing");
    await removeUrlFromSitemap(
      articlesKv,
      `https://${stagingHost}/${categorySlug}/${slug}`
    );
  }

  // 5. Ledger bookkeeping (best-effort — the publish already happened).
  if (keywordsDb) {
    try {
      await keywordsDb
        .prepare(
          `UPDATE article_ledger
              SET promotion_status = 'published-prod',
                  promoted_at = datetime('now'),
                  prod_url = ?1
            WHERE kv_key = ?2`
        )
        .bind(prodUrl, kvKey)
        .run();
    } catch (err: unknown) {
      return {
        ok: true,
        kvKey,
        prodUrl,
        replacements,
        bytes: rewritten.length,
        indexes,
        error: `promoted, but ledger update failed: ${errMsg(err)}`
      };
    }
  }

  return {
    ok: true,
    kvKey,
    prodUrl,
    replacements,
    bytes: rewritten.length,
    indexes,
    ftcRemoved: prepared.ftcRemoved,
    ftcSample: prepared.ftcSample,
    trustBoxRemoved: prepared.trustBoxRemoved
  };
}

interface LedgerSqlRow {
  kv_key: string;
  seo_score: number | null;
  keyword: string | null;
  promotion_status: string | null;
}

function isLedgerSqlRow(value: unknown): value is LedgerSqlRow {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { kv_key?: unknown }).kv_key === "string";
}

async function queryLedgerPromotionPage(
  keywordsDb: D1Database,
  offset: number,
  pageSize: number,
  includePromotionStatus: boolean
): Promise<LedgerSqlRow[]> {
  const sql = includePromotionStatus
    ? `SELECT kv_key, seo_score, keyword, promotion_status
         FROM article_ledger
        ORDER BY kv_key
        LIMIT ?1 OFFSET ?2`
    : `SELECT kv_key, seo_score, keyword
         FROM article_ledger
        ORDER BY kv_key
        LIMIT ?1 OFFSET ?2`;
  const result = await keywordsDb
    .prepare(sql)
    .bind(pageSize, offset)
    .all<LedgerSqlRow>();
  return (result.results ?? []).filter(isLedgerSqlRow);
}

export async function loadLedgerPromotionRows(
  keywordsDb: D1Database
): Promise<Map<string, LedgerPromotionRow>> {
  const map = new Map<string, LedgerPromotionRow>();
  const pageSize = 500;
  let includePromotionStatus = true;
  for (let offset = 0; offset < 100_000; offset += pageSize) {
    let rows: LedgerSqlRow[];
    try {
      rows = await queryLedgerPromotionPage(
        keywordsDb,
        offset,
        pageSize,
        includePromotionStatus
      );
    } catch (err: unknown) {
      if (!includePromotionStatus) throw err;
      includePromotionStatus = false;
      rows = await queryLedgerPromotionPage(
        keywordsDb,
        offset,
        pageSize,
        false
      );
    }
    for (const row of rows) {
      map.set(row.kv_key, {
        seoScore: typeof row.seo_score === "number" ? row.seo_score : null,
        keyword: typeof row.keyword === "string" ? row.keyword : null,
        promotionStatus:
          typeof row.promotion_status === "string" ? row.promotion_status : null
      });
    }
    if (rows.length < pageSize) break;
  }
  return map;
}

export async function listRedirectTombstones(
  articlesKv: KVNamespace
): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const listed = await articlesKv.list({
      prefix: "redirect:",
      ...(cursor ? { cursor } : {})
    });
    for (const key of listed.keys) {
      const name = key.name.startsWith("redirect:")
        ? key.name.slice("redirect:".length)
        : key.name;
      if (name) out.add(name);
    }
    if (listed.list_complete) break;
    if (!listed.cursor || listed.cursor === cursor) break;
    cursor = listed.cursor;
  }
  return out;
}

export async function loadPromotionCatalog(
  articlesKv: KVNamespace,
  keywordsDb: D1Database | undefined
): Promise<{
  kvKeys: string[];
  tombstones: Set<string>;
  ledger: Map<string, LedgerPromotionRow>;
}> {
  // Dynamic import: see publishArticleToProduction. The sitemap key must
  // stay the one indexing.ts writes.
  const { SITEMAP_KV_KEY } = await import("./indexing");
  const xml = (await articlesKv.get(SITEMAP_KV_KEY)) ?? "";
  const [kvKeys, tombstones, ledger] = await Promise.all([
    Promise.resolve(articleKvKeysFromSitemap(xml)),
    listRedirectTombstones(articlesKv),
    keywordsDb
      ? loadLedgerPromotionRows(keywordsDb)
      : Promise.resolve(new Map<string, LedgerPromotionRow>())
  ]);
  return { kvKeys, tombstones, ledger };
}

export interface PromotionBacklogItem {
  kvKey: string;
  prodUrl?: string;
  score: number | null;
  scoreSource: ProdPromoteScoreSource | null;
  dryRun: boolean;
  ok: boolean;
  error?: string;
}

export interface PromotionBacklogBatchResult {
  ok: boolean;
  dryRun: boolean;
  minScore: number;
  allowUnscoredCompleted: boolean;
  cursor: string;
  nextCursor: string | null;
  done: boolean;
  fetched: number;
  promoted: PromotionBacklogItem[];
  skipped: {
    alreadyPromoted: number;
    belowBar: number;
    unscored: number;
    missingHtml: number;
    invalidKey: number;
    publishFailed: number;
  };
  stoppedOn?: { kvKey: string; error: string };
  error?: string;
}

function emptySkipCounts(): PromotionBacklogBatchResult["skipped"] {
  return {
    alreadyPromoted: 0,
    belowBar: 0,
    unscored: 0,
    missingHtml: 0,
    invalidKey: 0,
    publishFailed: 0
  };
}

function bumpSkip(
  skipped: PromotionBacklogBatchResult["skipped"],
  reason: ProdPromoteSkipReason
): void {
  switch (reason) {
    case "already-promoted":
      skipped.alreadyPromoted++;
      break;
    case "below-bar":
      skipped.belowBar++;
      break;
    case "unscored":
      skipped.unscored++;
      break;
    case "missing-html":
      skipped.missingHtml++;
      break;
    case "invalid-key":
      skipped.invalidKey++;
      break;
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
    }
  }
}

/**
 * Promote the next slice of sitemap articles that clear the production bar.
 *
 * Walks sitemap kvKeys after `cursor`. Ledger scores at or above `minScore`
 * publish immediately. Rows with no usable score are rescored with the
 * same `calculateSEOScore` the pipeline uses. Below-bar articles stay in
 * staging. One failed production write stops the batch so the cursor
 * retries that key instead of skipping it.
 */
export async function runPromotionBacklogBatch(
  env: unknown,
  articlesKv: KVNamespace,
  keywordsDb: D1Database | undefined,
  request: {
    dryRun: boolean;
    limit: number;
    cursor: string;
    minScore: number;
    allowUnscoredCompleted: boolean;
  }
): Promise<PromotionBacklogBatchResult> {
  const limit = clampPromoteBatchLimit(request.limit);
  const base: PromotionBacklogBatchResult = {
    ok: true,
    dryRun: request.dryRun,
    minScore: request.minScore,
    allowUnscoredCompleted: request.allowUnscoredCompleted,
    cursor: request.cursor,
    nextCursor: null,
    done: false,
    fetched: 0,
    promoted: [],
    skipped: emptySkipCounts()
  };
  let catalog: Awaited<ReturnType<typeof loadPromotionCatalog>>;
  try {
    catalog = await loadPromotionCatalog(articlesKv, keywordsDb);
  } catch (err: unknown) {
    return {
      ...base,
      ok: false,
      error: `promotion catalog failed: ${errMsg(err)}`
    };
  }

  let index = 0;
  if (request.cursor) {
    while (
      index < catalog.kvKeys.length &&
      catalog.kvKeys[index]! <= request.cursor
    ) {
      index++;
    }
  }

  let lastCommitted = request.cursor;
  let stoppedOn: { kvKey: string; error: string } | undefined;
  while (index < catalog.kvKeys.length && base.fetched < limit) {
    const kvKey = catalog.kvKeys[index]!;
    const row = catalog.ledger.get(kvKey);
    const tombstone = catalog.tombstones.has(kvKey);
    if (tombstone) {
      bumpSkip(base.skipped, "already-promoted");
      lastCommitted = kvKey;
      index++;
      continue;
    }

    base.fetched++;
    const html = await articlesKv.get(kvKey);
    const decision = assessStagingArticleForPromotion({
      kvKey,
      html,
      minScore: request.minScore,
      ledgerScore: row?.seoScore ?? null,
      ledgerKeyword: row?.keyword ?? null,
      hasRedirectTombstone: tombstone,
      allowUnscoredCompleted: request.allowUnscoredCompleted
    });
    if (!decision.promote) {
      bumpSkip(base.skipped, decision.reason);
      lastCommitted = kvKey;
      index++;
      continue;
    }

    const published = await publishArticleToProduction(
      env,
      articlesKv,
      keywordsDb,
      kvKey,
      request.dryRun,
      {
        updateSitemap: false,
        skipStagingCleanupWrite: request.dryRun
      }
    );
    if (!published.ok) {
      base.skipped.publishFailed++;
      stoppedOn = {
        kvKey,
        error: published.error ?? "production publish failed"
      };
      break;
    }
    base.promoted.push({
      kvKey,
      prodUrl: published.prodUrl,
      score: decision.score,
      scoreSource: decision.scoreSource,
      dryRun: request.dryRun,
      ok: true,
      ...(published.error ? { error: published.error } : {})
    });
    if (!request.dryRun) catalog.tombstones.add(kvKey);
    lastCommitted = kvKey;
    index++;
  }

  const done = stoppedOn == null && index >= catalog.kvKeys.length;
  return {
    ...base,
    done,
    nextCursor: done ? null : lastCommitted,
    ...(stoppedOn ? { stoppedOn } : {})
  };
}

export interface PreparedProductionArticle {
  ok: true;
  kvKey: string;
  categorySlug: string;
  slug: string;
  cleanedHtml: string;
  rewritten: string;
  replacements: number;
  prodUrl: string;
  ftcRemoved: number;
  ftcSample?: string;
  trustBoxRemoved: number;
  changed: boolean;
}

/**
 * FTC cleanup, trust-box removal, and host + `/reviews` rewrite.
 * Does not write KV. Shared by the worker publish path and the local
 * backlog script so both ship the same bytes.
 */
export function prepareProductionArticle(input: {
  kvKey: string;
  html: string;
  fromHost: string;
  toHost: string;
}): PreparedProductionArticle | { ok: false; kvKey: string; error: string } {
  const m = input.kvKey.match(/^([^:]+):([^:]+)$/);
  if (!m) {
    return {
      ok: false,
      kvKey: input.kvKey,
      error: "kvKey must be categorySlug:slug"
    };
  }
  const categorySlug = m[1] ?? "";
  const slug = m[2] ?? "";
  const ftc = enforceNoFabricatedTestingClaims(input.html);
  const trust = removeTrustBox(ftc.html);
  const { html: rewritten, replacements } = rewriteHtmlForDomain(
    trust.html,
    input.fromHost,
    input.toHost
  );
  return {
    ok: true,
    kvKey: input.kvKey,
    categorySlug,
    slug,
    cleanedHtml: trust.html,
    rewritten,
    replacements,
    prodUrl: prodArticleUrl(input.toHost, categorySlug, slug),
    ftcRemoved: ftc.removed,
    ftcSample: ftc.findings[0]?.sentence.slice(0, 200),
    trustBoxRemoved: trust.removed,
    changed: trust.removed > 0 || ftc.removed > 0 || ftc.headingsChanged > 0
  };
}

export interface ProdKvAuth {
  accountId: string;
  apiToken: string;
  namespaceId: string;
}

export function prodKvAuthFromEnv(env: unknown): ProdKvAuth | null {
  const accountId = getEnvBinding(env, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = getEnvBinding(env, "CLOUDFLARE_API_TOKEN");
  if (!accountId || !apiToken) return null;
  return {
    accountId,
    apiToken,
    namespaceId:
      getEnvBinding(env, "PROD_ARTICLES_KV_NAMESPACE_ID") ??
      DEFAULT_PROD_ARTICLES_KV_NAMESPACE_ID
  };
}

function kvValueUrl(auth: ProdKvAuth, key: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/storage/kv/namespaces/${auth.namespaceId}/values/${encodeURIComponent(key)}`;
}

export async function putProdKvValue(
  auth: ProdKvAuth,
  key: string,
  body: string,
  contentType: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(kvValueUrl(auth, key), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${auth.apiToken}`,
      "Content-Type": contentType
    },
    body
  });
  if (res.ok) return { ok: true };
  const detail = await res.text().catch(() => "");
  return {
    ok: false,
    error: `prod KV write failed: HTTP ${res.status} ${detail.slice(0, 200)}`
  };
}

export async function getProdKvValue(
  auth: ProdKvAuth,
  key: string
): Promise<string | null> {
  const res = await fetch(kvValueUrl(auth, key), {
    headers: { Authorization: `Bearer ${auth.apiToken}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return await res.text();
}

export async function deleteProdKvValue(
  auth: ProdKvAuth,
  key: string
): Promise<boolean> {
  const res = await fetch(kvValueUrl(auth, key), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${auth.apiToken}` }
  });
  return res.ok || res.status === 404;
}

export interface ProdIndexWrite {
  categorySlug: string;
  slug: string;
  title: string;
}

/**
 * Merge many articles into production `articles-index:<category>` and
 * `v2_articles_index` with one read/write per category plus one global
 * write. Used by single-article publish and by the local backlog script.
 */
export async function registerProdIndexBatch(
  env: unknown,
  entries: readonly ProdIndexWrite[]
): Promise<{
  categoriesUpdated: number;
  globalUpdated: boolean;
  error?: string;
}> {
  if (entries.length === 0) {
    return { categoriesUpdated: 0, globalUpdated: false };
  }
  const auth = prodKvAuthFromEnv(env);
  if (!auth) {
    return {
      categoriesUpdated: 0,
      globalUpdated: false,
      error: "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not configured"
    };
  }
  const byCategory = new Map<string, string[]>();
  for (const entry of entries) {
    const slugs = byCategory.get(entry.categorySlug) ?? [];
    slugs.push(entry.slug);
    byCategory.set(entry.categorySlug, slugs);
  }
  let categoriesUpdated = 0;
  for (const [categorySlug, slugs] of byCategory) {
    const key = `articles-index:${categorySlug}`;
    const existing = await getProdKvValue(auth, key);
    let merged = existing;
    let changed = false;
    for (const slug of slugs) {
      const next = mergeCategoryIndex(merged, slug);
      merged = next.json;
      changed = changed || next.changed;
    }
    if (changed && merged != null) {
      const put = await putProdKvValue(auth, key, merged, "application/json");
      if (put.ok) categoriesUpdated++;
    }
  }
  const globalExisting = await getProdKvValue(auth, "v2_articles_index");
  let globalJson = globalExisting;
  let globalChanged = false;
  for (const entry of entries) {
    const next = mergeGlobalIndex(globalJson, {
      slug: entry.slug,
      url: prodArticlePath(entry.categorySlug, entry.slug),
      title: entry.title,
      category: entry.categorySlug,
      image: null
    });
    globalJson = next.json;
    globalChanged = globalChanged || next.changed;
  }
  let globalUpdated = false;
  if (globalChanged && globalJson != null) {
    const put = await putProdKvValue(
      auth,
      "v2_articles_index",
      globalJson,
      "application/json"
    );
    globalUpdated = put.ok;
  }
  return { categoriesUpdated, globalUpdated };
}
