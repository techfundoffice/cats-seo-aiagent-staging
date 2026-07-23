import { runKimiWithPoll } from "./kimi-model";
import type { SEOArticleAgent } from "../server";
import type { SissOptimizerResult } from "./siss-optimizer";
import { emitAgentDebugLog } from "../agentDebugEmit";
import { recordFinding } from "./defect-findings";
import {
  escalateToCodingAgent,
  isDurableObjectResetError
} from "./escalate-to-claude";
import { triggerCodebaseImprovement } from "./improvement-agent";
import {
  buildArticleHtml,
  detectJsonSchemaLeak,
  extractKeywordPriceTokens,
  SCHEMA_FIELD_MARKER_PATTERNS,
  stripPricesFromHtml,
  type ArticleData
} from "./html-builder";
import {
  demoteBodyH1sToH2,
  deriveEntityNoun,
  deriveEntityNounPlural,
  deriveEntityPhrase,
  deriveMetaDescriptionFromIntro,
  enforceTitleLength,
  normalizeHtmlWhitespace,
  normalizeTitle
} from "./keyword-utils";
import {
  fetchViaCreatorsApi,
  fetchViaPaApi,
  fetchViaApify,
  dedupeProducts,
  buildProductPromptText,
  hydrateProductSlots,
  stripAsinParentheticals,
  type AmazonProduct
} from "./amazon";
import { analyzeSERP, computeTargetWordCount, type SerpData } from "./serp";
import {
  probeUrlHttpStatus,
  type UrlHttpStatusResult
} from "../articleUrlHttpStatus";
import {
  getMissingBrowserRenderingBindings,
  renderPage
} from "../tools/browser-rendering";
import {
  checkContentFingerprint,
  normalizeForFingerprint
} from "./content-fingerprint";
import { notifyIndexNow, updateSitemap } from "./indexing";
import {
  enforceMetaSerpWindow,
  enforceTitleSerpWindow,
  trimTrailingTitleOrphanModifiers
} from "./title-meta-normalizer";
import {
  classifyArticleType,
  THIN_CONTENT_FAILURE_REASON
} from "./article-type";
import { notifyN8nPublishSuccess } from "./n8n-webhook";
import { fetchOnPageScore, resolveDataForSeoCreds } from "./dataforseo";
import { hydrateKeywordMetrics } from "./keyword-metrics";
import { runQASyndication } from "./qa-syndication";
import { calculateSEOScore } from "./seo-score";
import { generateSeoScorecardQcPromptCells } from "./seo-scorecard-qc-prompts";
import { captureCompetitor, type CompetitorData } from "./competitor";
import { rankSerpUrlsForEditorialCompetitor } from "./competitorPick";
import { runQCAgent } from "./qc-agent";
import { runPolishAgent } from "./polish-agent";
import {
  detectFabricatedTestingClaims,
  removeFabricatedTestingSentences,
  stripCompliantMethodologySections,
  summarizeFabricatedTestingClaims,
  type FabricatedTestingClaimFinding
} from "./fabricated-testing-claims";
import { neutralizeTestingHeadings } from "./testing-vocab-swap";
import {
  analyzeContentQuality,
  summarizeContentQuality,
  type ProcessLanguageFinding
} from "./content-quality";
import {
  detectUnsourcedClaims,
  summarizeUnsourcedClaims,
  type UnsourcedClaimFinding
} from "./unsourced-claims";
import { runDesignAudit, type DesignAuditReport } from "./design-audit";
import { formatActivityLogModelPromptCell } from "../activityLogSheetColumns";
import {
  estimateCompetitorOverlapPercent,
  stripHtmlToPlainText
} from "./plagiarism-overlap";
import { fetchSemanticInternalLinks } from "./internal-links";
import { analyzeSerpIntentGap, type SerpIntentGapResult } from "./intent-gap";
import { fetchGoogleAutocompletePAA } from "./autocomplete";
import { runTextEditorAgent } from "./text-editor-agent";
import {
  errMsg,
  errStack,
  getEnvBinding,
  repairJson,
  extractFirstJsonObject
} from "./http-utils";
import { parseJsonStringValue, parseObjectLike } from "../objectLike";

// ── Public types ───────────────────────────────────────────────────────────────

/**
 * Module-private brand symbol. Only `finalizeArticle()` can attach this to an
 * object, so the TypeScript compiler rejects any `return { success: true, ... }`
 * that bypasses the finalizer. This enforces that the IndexNow final ping and
 * `agent.updateStep("Complete")` always run as the last action before returning.
 *
 * To produce an ArticleResult you MUST call finalizeArticle(). Do not add this
 * symbol to a raw object literal — that defeats the purpose.
 */
const _finalized = Symbol("finalized");

export interface ArticleResult {
  readonly [_finalized]: true;
  success: boolean;
  kvKey?: string;
  url?: string;
  seoScore?: number;
  wordCount?: number;
  error?: string;
  seoScorecard?: {
    pillars: Record<string, { passed: number; total: number }>;
    checks: Array<{
      id: number;
      pillar: string;
      name: string;
      passed: boolean;
      detail: string;
    }>;
  };
  /** Raw HTML of the published article (for activity-log Article HTML column). */
  html?: string;
  /** Structured article data (for activity-log Article JSON column). */
  articleData?: ArticleData;
  /** Number of sections in the article. */
  sectionCount?: number;
  /** Number of FAQ items in the article. */
  faqCount?: number;
  /**
   * Heuristic overlap (0–100) of final HTML vs SERP competitor body (word shingles);
   * set when competitor text was captured and long enough to compare.
   */
  plagiarismPercentage?: number;
  /**
   * Post-publish live-URL SEO notes (Workers AI pass emulating
   * `@anthropic/seo-content-optimizer`); mirrored to sheet column AI.
   */
  liveSeoContentOptimizerNotes?: string;
  /**
   * Step 16 Quora Answer Seeder summary; mirrored to sheet column AK
   * (`quora seeder`). Omitted when no PAA questions found or seeder skipped.
   */
  quoraSeederSummary?: string;
  /**
   * Parallel cells (length 100); `null` where no prompt. For failed checks,
   * each value is a full `formatActivityLogModelPromptCell` string (SYSTEM+USER)
   * ready for a follow-up `generateText` remediation pass; mirrored to `#id QC AI prompt`.
   */
  seoScorecardQcPromptCells?: (string | null)[];
  /**
   * Step 11.5 — Cloudflare Browser Rendering + vision model critique of
   * the live article. Omitted when capture skipped (missing secrets) or
   * on pre-deploy failure paths.
   */
  designAuditReport?: DesignAuditReport;
  /**
   * Step 16 — SISS Optimizer: Google Autocomplete sub-intent coverage score
   * (0–100) before remediation rewrite.
   */
  sissScore?: number;
  /**
   * Step 16 — SISS Optimizer: score improvement after remediation rewrite
   * (sissScoreAfter − sissScore). 0 when no rewrite was triggered.
   */
  sissDelta?: number;
  /**
   * Step 16 — SISS Optimizer: whether the remediation rewrite was applied
   * and written back to KV.
   */
  sissRemediated?: boolean;
  /**
   * Step 24 — Reverse Link Injection count: number of already-published sibling
   * articles that received a back-link to this article.
   */
  reverseLinksInjected?: number;
  /**
   * Step 24 — RSS Feed Syndication: canonical feed URL after update.
   */
  rssFeedUrl?: string;
}

/**
 * Best-effort recovery for the per-category article slug index stored in KV.
 * Resets malformed payloads to an empty array and surfaces a specific warning
 * so publish runs can heal the index instead of silently skipping updates.
 */
function normalizeArticlesIndex(
  raw: string | null,
  categorySlug: string
): {
  index: string[];
  warning?: string;
} {
  if (!raw) return { index: [] };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {
        index: [],
        warning: `Articles index KV payload for ${categorySlug} was not an array; resetting it`
      };
    }

    const index = parsed.filter(
      (slug): slug is string =>
        typeof slug === "string" && slug.trim().length > 0
    );
    const discardedCount = parsed.length - index.length;

    return {
      index,
      warning:
        discardedCount > 0
          ? `Articles index KV payload for ${categorySlug} discarded ${discardedCount} invalid slug entr${discardedCount === 1 ? "y" : "ies"}`
          : undefined
    };
  } catch (err: unknown) {
    return {
      index: [],
      warning: `Articles index KV payload for ${categorySlug} was invalid JSON; resetting it (${errMsg(err)})`
    };
  }
}

/**
 * Clears any previous `currentCompetitorUrl` before a new article run.
 * The URL is set after SERP competitor capture; callers (e.g. autonomous
 * loop) clear it again when resetting `currentKeyword` so post-run logs
 * still see the competitor for column O.
 */
async function withArticleCompetitorUrlSession(
  agent: SEOArticleAgent,
  body: () => Promise<ArticleResult>
): Promise<ArticleResult> {
  agent.setCurrentCompetitorUrl(null);
  return await body();
}

/**
 * Consistent `| col-H prompts consumed: ...` tag for every Polish Agent log
 * message so the operator can always tell from the sheet whether the Polish
 * rewriter consumed `Error remediation prompt` cells (col H) or fell back to
 * the built-in prompt.
 */
function formatPolishConsumedTag(consumed: number[]): string {
  if (consumed.length === 0)
    return " | col-H prompts consumed: 0 (built-in only)";
  return ` | col-H prompts consumed: ${consumed.length} (checks #${consumed.join(", #")})`;
}

// ── Finalizer ──────────────────────────────────────────────────────────────────
//
// finalizeArticle() is the ONLY legal way to return a successful ArticleResult.
// It owns the crawler handoff sequence in a guaranteed fixed order:
//
//   1. IndexNow final ping  — fires once, on the fully-polished KV version,
//                             so crawlers never receive an unoptimized draft.
//   2. agent.updateStep("Complete")
//   3. ArticleResult return
//
// ⚠️  ADD NEW PIPELINE STEPS ABOVE the `return finalizeArticle(...)` call in
//     generateArticle() — NEVER below it and NEVER inside this function.
//
// The [_finalized] Symbol brand on ArticleResult is a compile-time lock: a raw
// `return { success: true, ... }` object literal cannot satisfy ArticleResult
// because it cannot set the private symbol, forcing every success path through
// this function. Failed paths (`success: false`) are exempt — they use the
// escape hatch `failResult()` below and skip the crawler ping intentionally.

/**
 * Truncate a string to <= maxLen characters, cutting at the last word
 * boundary so we never render a dangling partial word like "...(2026): E".
 * Also trims a trailing `: , - – —` left behind after the cut.
 * Falls back to a hard slice when the last space is near the start
 * (single giant word) so we never return nearly-empty output.
 */
function truncateToWordBoundary(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const hard = s.slice(0, maxLen);
  const lastSpace = hard.lastIndexOf(" ");
  if (lastSpace < maxLen * 0.5) return hard;
  return hard.slice(0, lastSpace).replace(/[\s:,\-–—]+$/, "");
}

/** Build a failed ArticleResult without going through the finalizer. */
function failResult(
  fields: Omit<ArticleResult, typeof _finalized>
): ArticleResult {
  return { ...fields, [_finalized]: true } as ArticleResult;
}

/**
 * Produce progressively simpler candidate search strings for the Amazon
 * Creators API. The first candidate is the sanitized full phrase; each
 * fallback drops a leading word until only the trailing 2-word noun phrase
 * remains. Stops short of single words to avoid catalog floods.
 *
 * Example: "cat treat dispensing puzzle" →
 *   ["cat treat dispensing puzzle", "treat dispensing puzzle", "dispensing puzzle"]
 *
 * Used by the Tier-1 Amazon search loop so long-tail keywords still
 * recover real products when the full phrase returns zero.
 */
function buildAmazonSearchCandidates(sanitized: string): string[] {
  const trimmed = sanitized.trim();
  if (!trimmed) return [];
  const words = trimmed.split(/\s+/);
  const out: string[] = [trimmed];
  // Drop one leading word at a time until we hit a 2-word floor.
  for (let i = 1; i < words.length - 1; i++) {
    const candidate = words.slice(i).join(" ");
    if (candidate.split(/\s+/).length < 2) break;
    out.push(candidate);
  }
  return out;
}

/**
 * Submit `url` to DataForSEO's on-page crawler and persist the resulting
 * onpage_score to articles.dataforseo_score. Runs via ctx.waitUntil so the
 * 30-90s crawl latency doesn't block the next-keyword loop. Quietly skips
 * only when both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are unset; a
 * partial configuration logs an actionable warning instead of silently
 * disabling audits.
 */
function scheduleDataForSeoAudit(
  agent: SEOArticleAgent,
  url: string,
  slug: string
): void {
  const { creds, missing } = resolveDataForSeoCreds(
    agent.envBindings.DATAFORSEO_LOGIN,
    agent.envBindings.DATAFORSEO_PASSWORD
  );
  if (!creds) {
    if (missing.length === 1) {
      agent.log(
        "warning",
        `DataForSEO audit skipped: missing ${missing[0]}; set both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to enable post-publish audits`,
        "operations"
      );
    }
    return;
  }
  const { login, password } = creds;

  agent.waitUntil(
    (async () => {
      try {
        const { score, error } = await fetchOnPageScore(
          { login, password },
          url
        );
        if (!score) {
          agent.log(
            "warning",
            `DataForSEO audit: ${error ?? "no result"} for ${url}`,
            "operations"
          );
          return;
        }
        agent.sql`UPDATE articles SET dataforseo_score = ${score.onPageScore}, dataforseo_failed_checks = ${score.failedChecks}, dataforseo_task_id = ${score.taskId} WHERE slug = ${slug}`;
        agent.log(
          "info",
          `DataForSEO audit: onpage_score=${score.onPageScore}/100, failed_checks=${score.failedChecks} (${url})`,
          "qaReviewer",
          {
            kanbanStage: "aiReview",
            seoScore: Math.round(score.onPageScore),
            seoVerdict:
              score.onPageScore >= 90
                ? "pass"
                : score.onPageScore >= 70
                  ? "improved"
                  : "fail"
          }
        );
      } catch (err: unknown) {
        agent.log(
          "warning",
          `DataForSEO audit threw for ${url}: ${errMsg(err)}`,
          "operations"
        );
      }
    })()
  );
}

/**
 * Sealed success exit — the single point where a finished article leaves the
 * pipeline.  Reads the current KV state (post all rewrites), re-scores it so
 * the returned seoScore/seoScorecard always match the live KV HTML (fixing
 * score drift when SISS or other late rewrites modify KV without updating
 * seoResult), fires the final IndexNow ping, marks the step Complete,
 * and returns.
 *
 * Do not add logic here beyond scoring + crawler handoff. New pipeline work
 * belongs above the `return finalizeArticle(...)` call site in generateArticle().
 */
async function finalizeArticle(
  agent: SEOArticleAgent,
  url: string,
  kvKey: string,
  keyword: string,
  title: string,
  metaDescription: string,
  fields: Omit<ArticleResult, typeof _finalized | "html">
): Promise<ArticleResult> {
  // Fetch the definitive KV HTML — this is what every reader and crawler sees.
  const finalHtml = (await agent.envBindings.ARTICLES_KV.get(kvKey)) ?? "";

  // Re-score on the final KV HTML so seoScore/seoScorecard always match what
  // is live.  Without this, any late-stage rewrite (SISS, etc.) that
  // writes to KV without updating `seoResult` causes the reported score to
  // diverge from the actual published content.
  let finalSeoScore = fields.seoScore;
  let finalSeoScorecard = fields.seoScorecard;
  if (finalHtml.length > 200) {
    try {
      const finalScore = calculateSEOScore(
        finalHtml,
        keyword,
        title,
        metaDescription,
        1000
      );
      finalSeoScore = finalScore.score;
      finalSeoScorecard = {
        pillars: finalScore.pillarScores,
        checks: finalScore.checks.map((c) => ({
          id: c.id,
          pillar: c.pillar,
          name: c.name,
          passed: c.passed,
          detail: c.detail
        }))
      };
      agent.log(
        "info",
        `Final SEO score (live KV): ${finalScore.score}/100`,
        "operations"
      );
    } catch (err: unknown) {
      // Non-fatal — fall back to the last mid-pipeline score.
      agent.log(
        "warning",
        `Final SEO score re-calc failed (non-fatal): ${errMsg(err)}`
      );
    }
  }

  // Final IndexNow ping — intentionally the last content-affecting action so
  // search engines always receive the fully-polished version, not a draft.
  try {
    await notifyIndexNow(agent, url);
    agent.log(
      "info",
      "IndexNow: final ping sent (fully-polished version)",
      "operations"
    );
  } catch (err: unknown) {
    // Non-fatal — article is already live in KV regardless.
    agent.log(
      "warning",
      `IndexNow final ping failed (non-fatal): ${errMsg(err)}`
    );
  }

  // n8n webhook — fan out the publish event to the connected n8n workflow.
  // No-op when N8N_WEBHOOK_URL/SECRET are unset; never throws.
  const [categorySlug = "", slug = ""] = kvKey.split(":");
  await notifyN8nPublishSuccess(agent, {
    kvKey,
    keyword,
    categorySlug,
    slug,
    articleUrl: url,
    seoScore: finalSeoScore ?? 0,
    title,
    metaDescription
  });

  // DataForSEO post-publish audit — fire-and-forget via ctx.waitUntil so the
  // 30-90s crawl latency never blocks the next-keyword loop. Persists score
  // to articles.dataforseo_score; logs result to the activity feed.
  scheduleDataForSeoAudit(agent, url, slug);

  // Self-improvement loop — fire-and-forget. Opens a GitHub issue + assigns
  // Copilot Coding Agent to ship one small `src/` improvement informed by
  // the locally installed `.claude/skills/`. 24h KV dedup per kvKey so an
  // editorial-agent republish doesn't re-trigger.
  agent.waitUntil(
    triggerCodebaseImprovement(agent, {
      kvKey,
      keyword,
      categorySlug,
      articleUrl: url
    })
  );

  agent.updateStep("Complete");

  return {
    ...fields,
    html: finalHtml,
    seoScore: finalSeoScore,
    seoScorecard: finalSeoScorecard,
    [_finalized]: true
  } as ArticleResult;
}

// ── Main pipeline ──────────────────────────────────────────────────────────────

/**
 * Top-level article pipeline entry point. Runs the full 24-step generation
 * flow for `keyword` and writes the finished HTML to `ARTICLES_KV` under
 * the key `<categorySlug>:<slug>`.
 *
 * **Return contract**
 * - Always returns an `ArticleResult` — never throws (except DO resets, see
 *   below).
 * - `result.success === true` means the article was written to KV and
 *   IndexNow was pinged.
 * - `result.success === false` means a fatal pipeline error occurred;
 *   `result.error` carries a short message and the failure has already been
 *   escalated to the Coding Agent via `escalateToCodingAgent`.
 *
 * **Durable Object reset rethrow**
 * Cloudflare evicts the DO instance when a new deployment is rolled out
 * mid-flight. Those errors are re-thrown (not returned) so they propagate
 * to `autonomousLoop`, which leaves the keyword in its current state.
 * `onStart()` then resets `generating → pending` for automatic retry on
 * the next loop cycle.
 */
export async function generateArticle(
  agent: SEOArticleAgent,
  keyword: string,
  slug: string,
  categorySlug: string
): Promise<ArticleResult> {
  try {
    return await generateArticleUnsafe(agent, keyword, slug, categorySlug);
  } catch (err: unknown) {
    // Top-level safety net — any exception that escapes the pipeline below
    // is escalated to the Coding Agent, not silently swallowed by the
    // callers. The DO's protected env is accessible via envBindings.
    //
    // Exception: DO reset errors are transient Cloudflare infrastructure
    // events that happen when a new deployment evicts an in-flight DO.
    // Rethrow them so they propagate to autonomousLoop, which skips all
    // state-manipulation (including the SET status='failed' SQL call), so
    // the keyword remains in whatever state it was when the error occurred
    // (typically 'generating'). onStart() then resets 'generating' →
    // 'pending' and the article is automatically retried on the next cycle.
    if (isDurableObjectResetError(err)) throw err;
    const msg = errMsg(err);
    const stack = errStack(err);
    agent.log(
      "error",
      `❌ Uncaught pipeline exception: ${msg}`,
      "orchestrator",
      { kanbanStage: "debug" }
    );
    const kvKey = `${categorySlug}:${slug}`;
    await escalateToCodingAgent(agent, {
      kvKey,
      keyword,
      categorySlug,
      errorCategory: "pipeline-unknown-failure",
      errorMessage: `Uncaught exception: ${msg}`,
      metadata: stack ? { stackHead: stack } : undefined
    });
    return failResult({
      success: false,
      error: `Uncaught pipeline exception: ${msg}`
    });
  }
}

async function generateArticleUnsafe(
  agent: SEOArticleAgent,
  keyword: string,
  slug: string,
  categorySlug: string
): Promise<ArticleResult> {
  const domain = agent.envBindings.DOMAIN || "catsluvus.com";
  const tag = agent.envBindings.AMAZON_AFFILIATE_TAG || "catsluvus03-20";
  const kvKey = `${categorySlug}:${slug}`;
  const url = `https://${domain}/${categorySlug}/${slug}`;
  // Whitelist the keyword's own price-tier token (e.g. "$200" from "best
  // cat tree under $200") so the Amazon-compliance price strip doesn't rip
  // it out of titles/H1/meta. See html-builder.ts for the strip logic.
  const keywordPriceTokens = extractKeywordPriceTokens(keyword);
  const categoryName = categorySlug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 1/24: KV existence check
  // ═══════════════════════════════════════════════════════════════════════════
  agent.updateStep("1/24: KV Check");
  const existing = await agent.envBindings.ARTICLES_KV.get(kvKey);
  // #region agent log
  emitAgentDebugLog(agent, {
    hypothesisId: "H2",
    location: "writer.ts:generateArticle:kv",
    message: "kv_check",
    data: {
      kvHit: Boolean(existing),
      kvKeyLen: kvKey.length,
      slugLen: slug.length
    },
    runId: "pre-fix"
  });
  // #endregion
  if (existing) {
    agent.log("info", `Skip — already in KV: ${slug}`);
    return failResult({
      success: true,
      kvKey,
      url,
      seoScore: 0,
      wordCount: 0
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 0.5/24: DataForSEO search-volume hydration
  //   Persists search_volume/cpc onto the keywords row for analytics.
  //   Does not gate the pipeline — long-tail keywords often return null
  //   volumes from Google Ads. Silent no-op when
  //   DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD are unset.
  // ═══════════════════════════════════════════════════════════════════════════
  await hydrateKeywordMetrics(agent, keyword, categorySlug, slug);

  return withArticleCompetitorUrlSession(agent, async () => {
    // ═══════════════════════════════════════════════════════════════════════════
    // Steps 2–6/24: Research fan-out. Amazon products (2), the SERP →
    // competitor-capture chain (3–4, internally sequential), the PAA
    // autocomplete prefetch (5), and internal links (6) have no data
    // dependencies on each other, so they run concurrently and the pipeline
    // waits only for the slowest task instead of the sum of all five.
    // Error semantics match the sequential version: each task handles its
    // own failures internally except analyzeSERP, whose throw remains fatal
    // to the run.
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("2-6/24: Research (parallel)");

    const amazonTask = (async (): Promise<AmazonProduct[]> => {
      let products: AmazonProduct[] = [];

      // Strip content-marketing suffixes ("reviews", "buying guide", year, etc.)
      // so queries match real Amazon product titles. Keywords like
      // "disposable litter box for travel reviews" return zero real products
      // because product titles never include the word "reviews".
      // Strip search-intent prose that never appears in Amazon product
      // titles. Without this, long-tail keywords like
      // "where to buy cat treat dispensing puzzle" or
      // "best cat slow feeder under 25 dollars reviews" return zero real
      // products because Amazon catalog matching is title-based.
      //
      // Order matters — strip prefix phrases (whole-string anchored) before
      // suffix words, then comparison phrases (everything after `vs`/`versus`
      // is dropped because Amazon cannot search two products at once).
      const amazonSearchKeyword = keyword
        // Question / intent prefixes — only meaningful at start of phrase.
        .replace(
          /^(?:where\s+(?:to|can\s+(?:i|you))\s+(?:buy|find|get|purchase)|how\s+(?:to|do\s+(?:i|you))\s+(?:choose|pick|use|clean|train|find|buy)|what(?:'s|\s+is)\s+(?:the\s+best|a\s+good)|is\s+(?:a\s+)?|does\s+(?:a\s+)?|are\s+|do\s+)\s+/i,
          ""
        )
        // Trailing review/guide noise.
        .replace(
          /\s+(reviews?|comparison|buying\s+guide|top\s+picks?|best\s+of|guide|tutorial|tips?)\b/gi,
          ""
        )
        // Modifier adjectives that rarely appear in product titles.
        .replace(
          /\b(?:affordable|inexpensive|cheap|budget(?:-friendly)?)\s+/gi,
          ""
        )
        // Year tokens.
        .replace(/\s+(20\d{2})\b/g, "")
        // Drop everything after `vs` / `versus` — Amazon catalog can't match
        // two distinct products in one query, and the prefix half is always
        // the more searchable noun.
        .replace(/\s+(?:vs\.?|versus)\s+.+$/i, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (amazonSearchKeyword !== keyword) {
        agent.log(
          "info",
          `Amazon: searching "${amazonSearchKeyword}" (sanitized from "${keyword}")`,
          "productManager",
          { kanbanStage: "queue" }
        );
      }

      // Tier 1: Amazon Creators API (real ASINs, prices, images).
      //
      // Cognito OAuth2 client_id = Creators API "Application ID" (AMAZON_APP_ID),
      // NOT the legacy "Credential ID" (AMAZON_CREDENTIAL_ID). Cognito issues a
      // bearer token for any well-formed client pair, but `searchItems` rejects
      // tokens whose underlying app isn't provisioned for the Creators API,
      // surfacing as `UnauthorizedException / InvalidToken`. We were using
      // CREDENTIAL_ID by mistake — fall back to it only if APP_ID isn't set.
      const amazonAppId = getEnvBinding(agent.envBindings, "AMAZON_APP_ID");
      const amazonCredId = getEnvBinding(
        agent.envBindings,
        "AMAZON_CREDENTIAL_ID"
      );
      const primaryId = (amazonAppId || amazonCredId || "").trim();
      const primarySecret =
        getEnvBinding(agent.envBindings, "AMAZON_API_SECRET") ?? "";
      const primaryLabel = amazonAppId
        ? "AMAZON_APP_ID"
        : amazonCredId
          ? "AMAZON_CREDENTIAL_ID (legacy fallback)"
          : "NOT SET";
      const fallbackId =
        getEnvBinding(agent.envBindings, "AMAZON_APP_ID_FALLBACK") ?? "";
      const fallbackSecret =
        getEnvBinding(agent.envBindings, "AMAZON_API_SECRET_FALLBACK") ?? "";
      agent.log(
        "info",
        `Amazon: Creators API primary ${primaryId ? `from ${primaryLabel} (${primaryId.slice(0, 8)}...)` : "NOT SET"}; fallback ${fallbackId ? `(${fallbackId.slice(0, 8)}...)` : "NOT SET"}`,
        "productManager",
        { kanbanStage: "queue" }
      );

      // Warn when only one of a credential pair is set — partial config would
      // otherwise silently skip the tier with no operator-visible signal.
      if ((primaryId || primarySecret) && !(primaryId && primarySecret)) {
        const missingPrimary = !primaryId
          ? "AMAZON_APP_ID (or AMAZON_CREDENTIAL_ID)"
          : "AMAZON_API_SECRET";
        agent.log(
          "warning",
          `Amazon (Creators API) primary skipped: missing ${missingPrimary}; set both AMAZON_APP_ID and AMAZON_API_SECRET to enable Creators API primary`,
          "productManager"
        );
      }
      if ((fallbackId || fallbackSecret) && !(fallbackId && fallbackSecret)) {
        const missingFallback = !fallbackId
          ? "AMAZON_APP_ID_FALLBACK"
          : "AMAZON_API_SECRET_FALLBACK";
        agent.log(
          "warning",
          `Amazon (Creators API) fallback skipped: missing ${missingFallback}; set both AMAZON_APP_ID_FALLBACK and AMAZON_API_SECRET_FALLBACK to enable Creators API fallback`,
          "productManager"
        );
      }

      // Try primary creds, then fallback creds. Each credential has its own
      // circuit breaker in amazon.ts so a 401 on the primary doesn't block
      // the fallback attempt within the same DO isolate.
      const credPairs: Array<{ id: string; secret: string; label: string }> =
        [];
      if (primaryId && primarySecret) {
        credPairs.push({
          id: primaryId,
          secret: primarySecret,
          label: "primary"
        });
      }
      if (fallbackId && fallbackSecret) {
        credPairs.push({
          id: fallbackId,
          secret: fallbackSecret,
          label: "fallback"
        });
      }
      for (const { id, secret, label } of credPairs) {
        if (products.length > 0) break;
        // Retry each candidate cred with progressively simpler forms of the
        // keyword. Many long-tail keywords (`where to buy cat treat
        // dispensing puzzle`) survive the prefix sanitizer above but still
        // contain too many adjectives for Amazon's title-based catalog
        // matcher. Falling back to the trailing 3-word noun phrase
        // recovers products on otherwise-empty searches.
        const candidates = buildAmazonSearchCandidates(amazonSearchKeyword);
        let lastErr: unknown;
        for (const candidate of candidates) {
          try {
            const found = await fetchViaCreatorsApi(
              candidate,
              id,
              secret,
              tag,
              (msg) =>
                agent.log(
                  "warning",
                  `Amazon (Creators API ${label}): ${msg}`,
                  "productManager"
                )
            );
            if (found.length > 0) {
              products = found;
              agent.log(
                "info",
                `Amazon (Creators API ${label}): ${found.length} products with ASINs for "${candidate}"${candidate !== amazonSearchKeyword ? ` (search fallback from "${amazonSearchKeyword}")` : ""}`
              );
              break;
            }
          } catch (err: unknown) {
            lastErr = err;
          }
        }
        if (products.length === 0 && lastErr) {
          agent.log(
            "warning",
            `Amazon (Creators API ${label}) error: ${errMsg(lastErr)}`
          );
        }
      }
      if (products.length === 0 && credPairs.length > 0) {
        agent.log(
          "warning",
          `Amazon (Creators API): 0 products after ${credPairs.length} credential pair${credPairs.length === 1 ? "" : "s"} for "${amazonSearchKeyword}" — falling through to PA API v5`
        );
      }

      // Tier 2: Amazon Product Advertising API v5 (AWS SigV4). Uses the
      // classic Associates program credentials independent of the
      // Creators API. Tries the primary access/secret pair first, then the
      // fallback pair (AMAZON_ACCESS_KEY_FALLBACK / AMAZON_SECRET_KEY_FALLBACK)
      // before falling through to Apify (Tier 3). Useful when the primary
      // access key gets throttled, deauthorized, or the Associates account
      // is suspended — the fallback keeps Tier 2 alive.
      if (products.length === 0) {
        const paPrimaryKey =
          getEnvBinding(agent.envBindings, "AMAZON_ACCESS_KEY") ?? "";
        const paPrimarySecret =
          getEnvBinding(agent.envBindings, "AMAZON_SECRET_KEY") ?? "";
        const paFallbackKey =
          getEnvBinding(agent.envBindings, "AMAZON_ACCESS_KEY_FALLBACK") ?? "";
        const paFallbackSecret =
          getEnvBinding(agent.envBindings, "AMAZON_SECRET_KEY_FALLBACK") ?? "";
        agent.log(
          "info",
          `Amazon: PA API v5 primary ${paPrimaryKey && paPrimarySecret ? `available (${paPrimaryKey.slice(0, 8)}...)` : "NOT SET"}; fallback ${paFallbackKey && paFallbackSecret ? `(${paFallbackKey.slice(0, 8)}...)` : "NOT SET"}`
        );
        // Warn when only one of a credential pair is set — partial config would
        // otherwise silently skip the tier with no operator-visible signal.
        if (
          (paPrimaryKey || paPrimarySecret) &&
          !(paPrimaryKey && paPrimarySecret)
        ) {
          const missingPrimary = [
            !paPrimaryKey ? "AMAZON_ACCESS_KEY" : null,
            !paPrimarySecret ? "AMAZON_SECRET_KEY" : null
          ]
            .filter((v): v is string => Boolean(v))
            .join(", ");
          agent.log(
            "warning",
            `Amazon (PA API v5) primary skipped: missing ${missingPrimary}; set both AMAZON_ACCESS_KEY and AMAZON_SECRET_KEY to enable PA API v5 primary`
          );
        }
        if (
          (paFallbackKey || paFallbackSecret) &&
          !(paFallbackKey && paFallbackSecret)
        ) {
          const missingFallback = [
            !paFallbackKey ? "AMAZON_ACCESS_KEY_FALLBACK" : null,
            !paFallbackSecret ? "AMAZON_SECRET_KEY_FALLBACK" : null
          ]
            .filter((v): v is string => Boolean(v))
            .join(", ");
          agent.log(
            "warning",
            `Amazon (PA API v5) fallback skipped: missing ${missingFallback}; set both AMAZON_ACCESS_KEY_FALLBACK and AMAZON_SECRET_KEY_FALLBACK to enable PA API v5 fallback`
          );
        }

        const paPairs: Array<{ key: string; secret: string; label: string }> =
          [];
        if (paPrimaryKey && paPrimarySecret) {
          paPairs.push({
            key: paPrimaryKey,
            secret: paPrimarySecret,
            label: "primary"
          });
        }
        if (paFallbackKey && paFallbackSecret) {
          paPairs.push({
            key: paFallbackKey,
            secret: paFallbackSecret,
            label: "fallback"
          });
        }
        for (const { key, secret, label } of paPairs) {
          if (products.length > 0) break;
          try {
            products = await fetchViaPaApi(
              amazonSearchKeyword,
              key,
              secret,
              tag,
              (msg) =>
                agent.log(
                  "warning",
                  `Amazon (PA API v5 ${label}): ${msg}`,
                  "productManager"
                )
            );
            if (products.length > 0) {
              agent.log(
                "info",
                `Amazon (PA API v5 ${label}): ${products.length} products with ASINs for "${amazonSearchKeyword}"`
              );
            } else {
              agent.log(
                "warning",
                `Amazon (PA API v5 ${label}): 0 products returned for "${amazonSearchKeyword}"`
              );
            }
          } catch (err: unknown) {
            agent.log(
              "warning",
              `Amazon (PA API v5 ${label}) error: ${errMsg(err)}`
            );
          }
        }
      }

      // Tier 3: Apify Amazon scraper (real product data)
      if (products.length === 0) {
        const apifyToken = getEnvBinding(agent.envBindings, "APIFY_TOKEN");
        agent.log(
          "info",
          `Amazon: Apify token ${apifyToken ? `available (${apifyToken.slice(0, 12)}...)` : "NOT SET"}`
        );
        if (apifyToken) {
          try {
            products = await fetchViaApify(
              amazonSearchKeyword,
              apifyToken,
              tag,
              (msg) =>
                agent.log("warning", `Amazon (Apify): ${msg}`, "productManager")
            );
            if (products.length > 0) {
              agent.log(
                "info",
                `Amazon (Apify): ${products.length} scraped products for "${amazonSearchKeyword}"`
              );
            } else {
              agent.log(
                "warning",
                `Amazon (Apify): 0 products returned for "${amazonSearchKeyword}"`
              );
            }
          } catch (err: unknown) {
            agent.log(
              "warning",
              `Amazon (Apify) error for "${amazonSearchKeyword}": ${errMsg(err)}`
            );
          }
        }
      }

      // If no real product source returned anything, skip the Top Picks
      // section entirely rather than render keyword-as-name placeholders
      // that read as fake product recommendations. The rest of the article
      // (intro, sections, FAQs, conclusion) still generates — it just
      // doesn't pretend to have editorially-reviewed picks it doesn't
      // have.
      if (products.length === 0) {
        agent.log(
          "info",
          `Amazon: all tiers returned 0 products — suppressing Our Top Picks section for "${keyword}"`
        );
      } else {
        const before = products.length;
        products = dedupeProducts(products);
        if (products.length < before) {
          agent.log(
            "info",
            `Amazon: deduped ${before - products.length} near-duplicate product${before - products.length === 1 ? "" : "s"} (${before} → ${products.length})`,
            "productManager"
          );
        }

        // Strip any prices populated upstream by PA API / Creators API.
        // Amazon Associates compliance: we never display prices on the page,
        // and seeing them upstream encourages Kimi to hallucinate dollar
        // amounts in prose. Live prices live on the affiliate link only.
        products = products.map((p) => ({
          ...p,
          price: undefined,
          priceValue: undefined
        }));

        // Single-product specialization: each article features EXACTLY ONE
        // product — the top pick after dedupe — and the copy focuses
        // entirely on it (see the SINGLE-PRODUCT directive in
        // buildArticlePrompt). Multi-pick roundups are retired on staging.
        if (products.length > 1) {
          agent.log(
            "info",
            `Amazon: single-product mode — featuring "${(products[0].name ?? "").slice(0, 60)}" (dropping ${products.length - 1} other pick${products.length === 2 ? "" : "s"})`,
            "productManager"
          );
          products = products.slice(0, 1);
        }
      }

      return products;
    })();

    // Steps 3–4: SERP analysis (URLs + titles only), then competitor capture
    // chained on its organic URLs — the word target is set once the real
    // competitor word count is known.
    const serpCompetitorTask = (async (): Promise<{
      serpData: SerpData;
      competitorData: CompetitorData | null;
    }> => {
      const serpData: SerpData = await analyzeSERP(
        agent,
        keyword,
        agent.envBindings,
        0 // competitorWordCount placeholder — patched below after capture
      );

      // ═══════════════════════════════════════════════════════════════════════════
      // Step 4/24: Competitor Capture
      // ═══════════════════════════════════════════════════════════════════════════
      let competitorData: CompetitorData | null = null;
      if (serpData.topUrls && serpData.topUrls.length > 0) {
        const ranked = rankSerpUrlsForEditorialCompetitor(
          serpData.topUrls,
          serpData.topTitles
        );
        if (ranked.length === 0) {
          agent.log(
            "info",
            "Competitor: top organic URLs look like storefronts/marketplaces only — none to capture",
            "strategist",
            { kanbanStage: "inProgress" }
          );
        } else {
          const maxAttempts = Math.min(10, ranked.length);
          for (let i = 0; i < maxAttempts; i++) {
            const url = ranked[i];
            competitorData = await captureCompetitor(agent, url, keyword);
            if (competitorData) break;
          }
          if (competitorData) {
            agent.log(
              "info",
              `Competitor (editorial): "${competitorData.title.slice(0, 50)}..." (${competitorData.url}) — ${competitorData.wordCount} words`,
              "strategist",
              { kanbanStage: "inProgress" }
            );
            // Patch targetWordCount now that we have real competitor word count.
            // Delegate to the canonical helper so the formula stays in one place.
            serpData.competitorWordCount = competitorData.wordCount;
            serpData.targetWordCount = computeTargetWordCount(
              competitorData.wordCount
            );
            agent.log(
              "info",
              `Word target set: ${serpData.targetWordCount} words (competitor ${competitorData.wordCount} × 1.10, cap 5000)`
            );
          } else {
            agent.log(
              "info",
              `Competitor: no capturable editorial-style page in first ${maxAttempts} ranked organic results`,
              "strategist",
              { kanbanStage: "inProgress" }
            );
          }
        }
      }

      agent.setCurrentCompetitorUrl(
        competitorData?.url && competitorData.url.trim() !== ""
          ? competitorData.url.trim()
          : null
      );

      return { serpData, competitorData };
    })();

    // Step 5 prefetch: autocomplete PAA questions are fetched concurrently
    // (a handful of free Google autocomplete GETs) and merged below only
    // when the SERP surfaced fewer than 3 questions — the same merge rule
    // the sequential pipeline used. fetchGoogleAutocompletePAA never
    // throws; per-prefix failures are reported via the warn callback.
    const paaPrefetchTask = fetchGoogleAutocompletePAA(keyword, (msg) =>
      agent.log("warning", `Writer PAA step (${keyword}): ${msg}`)
    );

    // Step 6: internal links — semantic AI Search (Tier 0) or SQLite
    // (Tier 1); every tier handles its own errors.
    const internalLinksTask = fetchSemanticInternalLinks(
      agent,
      keyword,
      categorySlug,
      slug,
      domain
    );

    const [
      products,
      { serpData, competitorData },
      prefetchedPaa,
      internalLinks
    ] = await Promise.all([
      amazonTask,
      serpCompetitorTask,
      paaPrefetchTask,
      internalLinksTask
    ]);

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 5/24: PAA (People Also Ask) — merge the prefetched autocomplete
    // questions into the SERP-provided set when the SERP came up short.
    // ═══════════════════════════════════════════════════════════════════════════
    let paaQuestions: string[] = serpData.paaQuestions || [];
    if (paaQuestions.length < 3) {
      const existingSet = new Set(paaQuestions.map((q) => q.toLowerCase()));
      for (const q of prefetchedPaa) {
        if (!existingSet.has(q.toLowerCase())) {
          paaQuestions.push(q);
          existingSet.add(q.toLowerCase());
        }
      }
      agent.log("info", `PAA: ${paaQuestions.length} questions total`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 5.5/24: SERP Intent Gap — classify intent buckets, flag underserved
    // angles, and inject a SERP_INTENT_GAP block into the writing prompt.
    // NEVER throws — gracefully skips when SERP titles unavailable.
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("5.5/24: SERP Intent Gap");
    let intentGapResult: SerpIntentGapResult | undefined;
    try {
      intentGapResult = await analyzeSerpIntentGap(
        agent,
        keyword,
        serpData.topTitles,
        paaQuestions
      );
      if (!intentGapResult.skipped) {
        const gapSuffix =
          intentGapResult.gapIntents.length > 0
            ? ` — gaps: [${intentGapResult.gapIntents.join(", ")}]`
            : " — no underserved gaps";
        agent.log(
          "info",
          `Intent Gap: dominant="${intentGapResult.dominantIntent}"${gapSuffix}`,
          "analyst",
          {
            kanbanStage: "done",
            modelPrompt: intentGapResult.modelPromptCell
          }
        );
      }
    } catch (err: unknown) {
      // Never block the pipeline — intent-gap is enhancement only
      agent.log(
        "warning",
        `Intent gap analysis failed (non-fatal): ${errMsg(err)}`
      );
      intentGapResult = undefined;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 7/24: AI content generation (structured JSON)
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("7/24: AI Writing");
    // Build article prompt outside the try block so it's accessible in the
    // auto-expand retry (which runs after the try/catch closes).
    const articlePrompt = buildArticlePrompt(
      keyword,
      categorySlug,
      categoryName,
      products,
      serpData,
      paaQuestions,
      internalLinks,
      tag,
      domain,
      competitorData,
      intentGapResult
    );

    // Truncate prompt to stay within safe token budgets.
    // 14K chars ≈ 3.5K tokens input; with 4096 max output tokens the total
    // budget stays under ~7.5K tokens so kimi-k2.5 can complete well within
    // the 150 s sync timeout on Workers AI.
    const truncatedPrompt =
      articlePrompt.length > 14000
        ? articlePrompt.slice(0, 14000) + "\n\n..."
        : articlePrompt;

    let article: ArticleData;
    try {
      // Single model: Kimi K2.5 via runKimiWithPoll — OpenRouter first (when
      // OPENROUTER_API_KEY is set), Workers AI fallback otherwise.
      const systemPrompt = `You are an expert SEO content writer for catsluvus.com. You ALWAYS respond with a single JSON object. Never include markdown code fences, explanations, or commentary. Your response starts with { and ends with }.`;

      const modelPromptCell = formatActivityLogModelPromptCell(
        systemPrompt,
        truncatedPrompt
      );

      let text = "";
      try {
        const result = await runKimiWithPoll(
          agent.envBindings,
          {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: truncatedPrompt }
            ],
            max_tokens: 4096
          },
          // Main article generation is the one call worth waiting on: when
          // Workers AI Kimi is capacity-pressured (error 3040) the sync path
          // fails instantly and the async batch queue needs well beyond the
          // 90s default to drain — two articles died at 90s on 6/10.
          { asyncMaxWaitMs: 600_000 },
          agent
        );
        text = result ?? "";
        // Persist the raw Kimi output for post-mortem debugging via
        // `/api/admin/kimi-raw/<kvKey>`. 48-hour TTL is enough for the
        // autonomous Claude loop to inspect recent failures without
        // growing KV unbounded.
        if (text) {
          try {
            await agent.envBindings.ARTICLES_KV.put(`kimi-raw:${kvKey}`, text, {
              expirationTtl: 60 * 60 * 48
            });
          } catch (cacheErr: unknown) {
            agent.log(
              "warning",
              `Kimi raw output KV cache write failed (non-fatal) for key kimi-raw:${kvKey}: ${errMsg(cacheErr)}`
            );
          }
        }
        // Persist the PROMPT that produced this output alongside it, via
        // `/api/admin/kimi-raw-prompt/<kvKey>`. Output-only capture couldn't
        // diagnose the 2026-07-10 degenerate-output incidents (token-
        // repetition-collapse garbage from the first character) because
        // there was no way to tell whether the prompt itself was already
        // malformed going in. Same 48h TTL, same non-fatal-on-failure
        // pattern as the output capture above.
        try {
          await agent.envBindings.ARTICLES_KV.put(
            `kimi-raw-prompt:${kvKey}`,
            `--- SYSTEM ---\n${systemPrompt}\n\n--- USER ---\n${truncatedPrompt}`,
            { expirationTtl: 60 * 60 * 48 }
          );
        } catch (cacheErr: unknown) {
          agent.log(
            "warning",
            `Kimi prompt KV cache write failed (non-fatal) for key kimi-raw-prompt:${kvKey}: ${errMsg(cacheErr)}`
          );
        }
      } catch (err: unknown) {
        // DO reset is transient — rethrow to propagate cleanly.
        if (isDurableObjectResetError(err)) throw err;
        const msg = errMsg(err);
        agent.log(
          "error",
          `❌ Kimi K2.5 failed — pipeline stopped: ${msg}`,
          "contentCreator",
          { kanbanStage: "done", modelPrompt: modelPromptCell }
        );
        await escalateToCodingAgent(agent, {
          kvKey,
          keyword,
          categorySlug,
          errorCategory: "kimi-empty-or-errored",
          errorMessage: msg
        });
        return failResult({
          success: false,
          error: `Kimi K2.5 error: ${msg}`
        });
      }

      if (!text || text.trim().length < 200) {
        const detail =
          text && text.trim().length > 0
            ? `returned ${text.trim().length} chars (below 200 minimum)`
            : "returned empty response";
        agent.log(
          "error",
          `❌ Kimi K2.5 ${detail} — pipeline stopped`,
          "contentCreator",
          { kanbanStage: "done", modelPrompt: modelPromptCell }
        );
        await escalateToCodingAgent(agent, {
          kvKey,
          keyword,
          categorySlug,
          errorCategory: "kimi-empty-or-errored",
          errorMessage: `Kimi K2.5 ${detail}`,
          metadata: { chars: text?.trim().length ?? 0 }
        });
        return failResult({
          success: false,
          error: `Kimi K2.5 ${detail}`
        });
      }

      agent.log("info", `Kimi K2.5: ${text.length} chars`, "contentCreator", {
        kanbanStage: "inProgress",
        modelPrompt: modelPromptCell
      });

      // Parse JSON from AI response
      agent.updateStep("8/24: JSON Parsing");
      article = parseArticleJson(text, keyword);

      // SERP-window enforcement: title 45-60, meta 140-160. The
      // writer's Kimi prompt asks for these windows; this is the
      // belt-and-braces enforcement so a Kimi-degraded response that
      // shipped at e.g. 32 chars or 175 chars gets repaired BEFORE
      // it reaches KV/Google. Closes the 44% in-window-miss rate
      // observed in the Priority 1 audit. Same pattern as
      // ensureWhyWeLikeMarker (#4792): pure-function repair at the
      // render boundary so the defect class can't ship.
      //
      // Orphan-modifier double-pass: strip trailing orphan tokens
      // (e.g. "for", "and", "top") before the SERP window pass, then
      // strip again after — truncation can introduce a new orphan
      // (e.g. "…for Senior Cats with" trimmed to "…for Senior Cats for").
      const noOrphanTitle = trimTrailingTitleOrphanModifiers(article.title);
      const firstPass = enforceTitleSerpWindow(noOrphanTitle, keyword);
      const noOrphanAfterWindow = trimTrailingTitleOrphanModifiers(
        firstPass.title
      );
      const secondPass =
        noOrphanAfterWindow === firstPass.title
          ? firstPass
          : enforceTitleSerpWindow(noOrphanAfterWindow, keyword);
      const preOrphanTrimmed = noOrphanTitle !== article.title;
      const postOrphanTrimmed = noOrphanAfterWindow !== firstPass.title;
      if (preOrphanTrimmed || secondPass.changed) {
        const reasonParts: string[] = [];
        if (preOrphanTrimmed) reasonParts.push("orphan modifier stripped");
        if (firstPass.reason && postOrphanTrimmed)
          reasonParts.push(firstPass.reason);
        if (secondPass.reason) reasonParts.push(secondPass.reason);
        const reason = reasonParts.join("; ") || "normalized title";
        agent.log(
          "warning",
          `Title SERP-window enforced: ${reason} — "${article.title}" → "${secondPass.title}"`,
          "editor"
        );
        article.title = secondPass.title;
      }
      const metaNorm = enforceMetaSerpWindow(article.metaDescription, keyword);
      if (metaNorm.changed) {
        agent.log(
          "warning",
          `Meta description SERP-window enforced: ${metaNorm.reason}`,
          "editor"
        );
        article.metaDescription = metaNorm.meta;
      }

      agent.log(
        "info",
        `AI article: "${article.title}" (${article.sections?.length || 0} sections, ${article.faqs?.length || 0} FAQs)`,
        "contentCreator",
        {
          kanbanStage: "inProgress",
          articleText: text,
          articleWordCount: computeWordCount(article),
          articleSectionCount: article.sections?.length || 0,
          articleFaqCount: article.faqs?.length || 0,
          articleProductCount: products.length
        }
      );

      // Editor: structured metadata + editorial notes
      const metaDescLen = (article.metaDescription || "").length;
      agent.log(
        "info",
        `Editor: metadata extracted — title "${article.title.slice(0, 40)}...", meta ${metaDescLen} chars`,
        "editor",
        {
          kanbanStage: "inProgress",
          articleJson: JSON.stringify({
            title: article.title,
            metaDescription: article.metaDescription,
            sections: article.sections?.length || 0,
            faqs: article.faqs?.length || 0
          }),
          editorialNotes:
            metaDescLen > 155
              ? [`Meta desc is ${metaDescLen} chars (limit 155), shorten it`]
              : undefined
        }
      );
    } catch (err: unknown) {
      // DO reset is a transient Cloudflare infrastructure event — rethrow so
      // it propagates to the top-level generateArticle catch and then further
      // to autonomousLoop, which handles it without marking the keyword as
      // 'failed'. onStart() resets 'generating' → 'pending' on next startup.
      if (isDurableObjectResetError(err)) throw err;
      // #region agent log
      emitAgentDebugLog(agent, {
        hypothesisId: "H4",
        location: "writer.ts:generateArticle:ai_try_catch",
        message: "ai_try_failed",
        data: {
          err: errMsg(err)
        },
        runId: "pre-fix"
      });
      // #endregion
      const aiFailMsg = errMsg(err);
      agent.log(
        "error",
        `❌ AI generation failed — pipeline stopped: ${aiFailMsg}`,
        "contentCreator",
        { kanbanStage: "done" }
      );
      await escalateToCodingAgent(agent, {
        kvKey,
        keyword,
        categorySlug,
        errorCategory: "pipeline-unknown-failure",
        errorMessage: `AI generation failed: ${aiFailMsg}`
      });
      return failResult({
        success: false,
        error: `AI generation failed: ${aiFailMsg}`
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Content quality gate — competitor-relative word count check
    // Gate = max(750, competitorWords * 0.90).
    // If thin, attempt ONE auto-expand before hard-failing.
    // ═══════════════════════════════════════════════════════════════════════════
    let computedWordCount = computeWordCount(article);
    article.wordCount = computedWordCount;

    const targetWc = serpData.targetWordCount; // competitor * 1.10, min 1200
    // 80% of target is the publish floor. Previously 90% — too strict:
    // Kimi often delivers 55-65% of target upfront and expand can only
    // recover part of the gap, so 90% was rejecting articles that were
    // still competitive (4000 words vs a 5000 target beats most SERP
    // competitors, which avg 3000-6000). The SEO-score gate and
    // per-section minimum still prevent low-quality publishes.
    //
    // The hard floor is article-type aware as of the 2026-05-30
    // direction:
    //   - Informational ("how to", "what is", etc.):     800 words
    //   - Comparison / best-of / review (everything else): 1200 words
    // classifyArticleType() lives in article-type.ts and exports
    // the single source of truth for this policy. Articles that
    // can't reach the floor after expand passes fail with the
    // `thin-content-word-count` reason for downstream attribution.
    const { type: articleType, minWords: hardFloor } =
      classifyArticleType(keyword);
    const minRequired = Math.max(hardFloor, Math.round(targetWc * 0.8));

    if (computedWordCount < minRequired) {
      // Auto-expand kicks in next; this is the recovery routine, not a
      // failure. Log at info so it doesn't crowd the warnings panel.
      agent.log(
        "info",
        `Content gate: article too thin — ${computedWordCount} words (need ${minRequired}, target ${targetWc}). Attempting auto-expand...`
      );

      // ── Section-by-section expansion (up to MAX_EXPAND_PASSES iterations) ──
      // The AI model caps at ~1000-1100 words per call regardless of the
      // target. Instead of asking it to rewrite the entire article (which
      // overflows context), we expand each thin section individually.
      // Multiple passes handle cases where the first pass under-delivers
      // (e.g. model returns 300 words instead of 900) — subsequent passes
      // re-evaluate sections still below target and expand them again.
      const sectionTarget = Math.round(targetWc * 0.18);
      const faqTarget = Math.round(targetWc * 0.07);
      const expandSystem = `You are an expert SEO content writer for catsluvus.com. Return ONLY the expanded text in HTML (<p> and <ul>/<li> tags). No JSON, no headings, no preamble. Just the body text.`;
      const MAX_EXPAND_PASSES = 3;

      try {
        let totalExpandedAny = false;

        // ── Missing-section generation ──────────────────────────────────────
        // When the AI collapses all content into too few sections the
        // per-section expand loop has nothing to work on (every existing
        // section is already longer than sectionTarget).  Generate new topic
        // sections first so the expansion passes have material to refine.
        //
        // Sections are generated ONE AT A TIME to avoid JSON-array truncation:
        // generating 3+ sections at once (~2500 words ≈ 3300 tokens) in a
        // single call was hitting the max_tokens ceiling, causing the entire
        // array response to be cut off and JSON.parse to fail silently.
        //
        // 6 is below the 8 the prompt requires, but provides a safety buffer
        // above the minimum-to-expand threshold while keeping the per-section
        // generation loop bounded (max 6 sequential calls in the worst case).
        const MIN_REQUIRED_SECTIONS = 6;
        if ((article.sections?.length ?? 0) < MIN_REQUIRED_SECTIONS) {
          const existingCount = article.sections?.length ?? 0;
          const toGenerate = MIN_REQUIRED_SECTIONS - existingCount;
          agent.log(
            "warning",
            `Too few sections (${existingCount}) — generating ${toGenerate} ` +
              `additional sections one at a time`
          );
          for (let si = 0; si < toGenerate; si++) {
            const coveredHeadings = (article.sections || [])
              .map((s) => s.heading)
              .join(", ");
            const singleSectionPrompt =
              `Write 1 new H2 content section for a cat care article ` +
              `about "${keyword}". ` +
              `Already covered sections: [${coveredHeadings || "none"}]. ` +
              `The section MUST be ${sectionTarget}-${sectionTarget + 60} ` +
              `words in HTML (<p> and <ul>/<li> tags). ` +
              `Choose a distinct topic not already covered, for example: ` +
              `safety tips, maintenance, how it works, buying guide, ` +
              `common problems, expert tips, alternatives, or other ` +
              `relevant angles for this topic. ` +
              `HARD BAN (FTC): never a "testing methodology" section and ` +
              `never first-person product-trial claims ("we tested", ` +
              `"hands-on testing", "our testing") — attribute claims to ` +
              `public specs or customer reviews instead. ` +
              `Return ONLY a JSON object: ` +
              `{"heading":"string","content":"string"}. No other text.`;
            try {
              const sectionRaw = await runKimiWithPoll(
                agent.envBindings,
                {
                  messages: [
                    {
                      role: "system",
                      content:
                        "You are an expert SEO content writer for " +
                        "catsluvus.com. Return ONLY a valid JSON object " +
                        "with heading and content string fields. " +
                        "No markdown fences, no backticks, no extra text."
                    },
                    {
                      role: "user",
                      content: singleSectionPrompt
                    }
                  ],
                  max_tokens: 2048
                },
                {
                  syncTimeoutMs: 60_000,
                  asyncMaxWaitMs: 30_000
                },
                agent
              );
              let newSection: {
                heading: string;
                content: string;
              } | null = null;
              try {
                const cleaned = (sectionRaw || "")
                  .trim()
                  .replace(/^```(?:json)?\s*/i, "")
                  .replace(/\s*```$/, "");
                // Attempt direct parse first; if it fails, try repairJson
                // (handles trailing commas, unquoted keys, bare newlines,
                // etc.) — same two-pass pattern used by qc-agent.ts,
                // polish-agent.ts, text-editor-agent.ts, and keywords.ts.
                // Last resort: extract outermost {…} boundary and repair
                // again (handles stray prose before/after the JSON object).
                let parsed: unknown;
                try {
                  parsed = JSON.parse(cleaned);
                } catch {
                  try {
                    parsed = JSON.parse(repairJson(cleaned));
                  } catch {
                    // Use extractFirstJsonObject so truncated AI responses (no
                    // closing `}`) still reach repairJson, and trailing prose
                    // after the JSON object (which may contain `}` characters)
                    // is not mistakenly included — same pattern used in
                    // qc-agent.ts and polish-agent.ts.
                    const rawJson = extractFirstJsonObject(cleaned) ?? cleaned;
                    parsed = JSON.parse(repairJson(rawJson));
                  }
                }
                if (hasStringFields(parsed, "heading", "content")) {
                  newSection = parsed as {
                    heading: string;
                    content: string;
                  };
                } else {
                  agent.log(
                    "warning",
                    `Section generation ${si + 1}/${toGenerate} returned an invalid shape; expected heading/content strings`
                  );
                }
              } catch (sectionParseErr: unknown) {
                agent.log(
                  "warning",
                  `Section generation ${si + 1}/${toGenerate} parse failed: ${errMsg(sectionParseErr)}`
                );
              }
              if (newSection) {
                const cleanedSection = normalizeSections([newSection])[0];
                if (!cleanedSection) {
                  agent.log(
                    "warning",
                    `Section generation ${si + 1}/${toGenerate} returned an empty section after normalization`
                  );
                  continue;
                }
                article.sections = [
                  ...(article.sections || []),
                  cleanedSection
                ];
                computedWordCount = computeWordCount(article);
                article.wordCount = computedWordCount;
                totalExpandedAny = true;
                agent.log(
                  "info",
                  `Section generation ${si + 1}/${toGenerate}: added ` +
                    `"${cleanedSection.heading}" ` +
                    `(total: ${article.sections.length} sections, ` +
                    `${computedWordCount} words)`
                );
              }
            } catch (sectionErr: unknown) {
              agent.log(
                "warning",
                `Section generation ${si + 1}/${toGenerate} failed — skipping: ${errMsg(sectionErr)}`
              );
            }
          }
        }

        for (
          let pass = 0;
          pass < MAX_EXPAND_PASSES && computedWordCount < minRequired;
          pass++
        ) {
          let expandedThisPass = false;

          // Expand each section that is still below the target
          for (let i = 0; i < (article.sections?.length ?? 0); i++) {
            const sec = article.sections![i];
            const secWc = (sec.content || "")
              .replace(/<[^>]+>/g, " ")
              .split(/\s+/)
              .filter(Boolean).length;
            if (secWc < sectionTarget) {
              const secPrompt =
                `Rewrite and expand the following section titled "${sec.heading}" for a cat care article about "${keyword}". ` +
                `The replacement MUST be ${sectionTarget}-${sectionTarget + 60} words total. ` +
                `Current version is only ${secWc} words — add significantly more detail, tips, and expert insight. ` +
                `Use <p> and <ul>/<li> tags. Include specific tips, expert observations, and practical advice. ` +
                `Start directly with content — no heading, no intro sentence like "Here is the expanded section".\n\n` +
                `CURRENT CONTENT:\n${sec.content}`;
              try {
                const sectionText = await runKimiWithPoll(
                  agent.envBindings,
                  {
                    messages: [
                      {
                        role: "system",
                        content: expandSystem
                      },
                      { role: "user", content: secPrompt }
                    ],
                    max_tokens: 2048
                  },
                  {
                    syncTimeoutMs: 60_000,
                    asyncMaxWaitMs: 30_000
                  },
                  agent
                );
                const newSecWc = (sectionText || "")
                  .replace(/<[^>]+>/g, " ")
                  .split(/\s+/)
                  .filter(Boolean).length;
                // Only replace if the new content is actually longer
                if (sectionText && newSecWc > secWc) {
                  article.sections![i].content = stripSchemaLeakFromField(
                    sectionText.trim(),
                    1
                  );
                  expandedThisPass = true;
                } else {
                  // Surface silent expand misses — until this was logged we
                  // couldn't tell whether Kimi returned empty, returned
                  // shorter (dropped by the > check), or returned the same
                  // length. Now the activity log shows which.
                  agent.log(
                    "warning",
                    `Expand miss: section ${i + 1} "${sec.heading.slice(0, 40)}" — Kimi returned ${newSecWc}w (was ${secWc}w, target ${sectionTarget}w), keeping original`
                  );
                }
              } catch (expandErr: unknown) {
                // Surface expand errors so we can see which sections throw
                // (vs silently time out). Previously the catch was empty.
                const em = errMsg(expandErr);
                agent.log(
                  "warning",
                  `Expand threw: section ${i + 1} "${sec.heading.slice(0, 40)}" — ${em}`
                );
              }
            }
          }

          // Expand each FAQ answer that is still below the target
          for (let i = 0; i < (article.faqs?.length ?? 0); i++) {
            const faq = article.faqs![i];
            const faqWc = (faq.answer || "")
              .split(/\s+/)
              .filter(Boolean).length;
            if (faqWc < faqTarget) {
              const faqPrompt =
                `Expand this FAQ answer for the question "${faq.question}" (article topic: "${keyword}"). ` +
                `Current answer is only ${faqWc} words. The replacement MUST be ${faqTarget}-${faqTarget + 60} words total. ` +
                `Start with a direct answer, then add supporting detail, specific tips, and context. ` +
                `Plain text only — no HTML tags, no bullet points.\n\nCURRENT ANSWER:\n${faq.answer}`;
              try {
                const faqText = await runKimiWithPoll(
                  agent.envBindings,
                  {
                    messages: [
                      {
                        role: "system",
                        content:
                          "You are an expert cat care content writer. Return only the expanded FAQ answer text. No JSON, no headings."
                      },
                      { role: "user", content: faqPrompt }
                    ],
                    max_tokens: 1024
                  },
                  {
                    syncTimeoutMs: 60_000,
                    asyncMaxWaitMs: 30_000
                  },
                  agent
                );
                const newFaqWc = (faqText || "")
                  .split(/\s+/)
                  .filter(Boolean).length;
                // Only replace if the new content is actually longer
                if (faqText && newFaqWc > faqWc) {
                  article.faqs![i].answer = stripSchemaLeakFromField(
                    faqText.trim(),
                    1
                  );
                  expandedThisPass = true;
                } else {
                  // Surface silent FAQ expand misses — mirrors the section
                  // expand logging so operators can see whether Kimi returned
                  // empty, shorter, or same-length content.
                  agent.log(
                    "info",
                    `FAQ expand miss: FAQ ${i + 1} "${faq.question.slice(0, 40)}" — Kimi returned ${newFaqWc}w (was ${faqWc}w, target ${faqTarget}w), keeping original`
                  );
                }
              } catch (err: unknown) {
                // Skip this FAQ if expand times out
                agent.log(
                  "warning",
                  `FAQ expand skipped: FAQ ${i + 1} "${faq.question.slice(0, 40)}" (${faqWc}w, target ${faqTarget}w): ${errMsg(err)}`
                );
              }
            }
          }

          if (expandedThisPass) {
            totalExpandedAny = true;
            const expandedWc = computeWordCount(article);
            agent.log(
              "info",
              `Section-by-section expand pass ${pass + 1}/${MAX_EXPAND_PASSES}: ${expandedWc} words (was ${computedWordCount})`
            );
            computedWordCount = expandedWc;
            article.wordCount = expandedWc;
          } else {
            agent.log(
              "info",
              `No sections improved in expand pass ${pass + 1} — stopping early (${computedWordCount} words)`
            );
            // Nothing improved this pass — no point continuing
            break;
          }
        }

        if (computedWordCount >= minRequired) {
          // All expand passes succeeded — continue to next pipeline step
        } else if (totalExpandedAny) {
          agent.log(
            "error",
            `${THIN_CONTENT_FAILURE_REASON}: still too thin after ${MAX_EXPAND_PASSES} expand passes — ${computedWordCount} words (need ${minRequired} for ${articleType}) — failing article`
          );
          await escalateToCodingAgent(agent, {
            kvKey,
            keyword,
            categorySlug,
            errorCategory: "content-gate-too-thin",
            errorMessage: `${THIN_CONTENT_FAILURE_REASON}: ${computedWordCount} words (need ${minRequired} for ${articleType})`,
            metadata: {
              wordCountAfterExpand: computedWordCount,
              minRequired,
              articleType,
              targetWordCount: targetWc,
              competitorWordCount: serpData.competitorWordCount ?? 0
            }
          });
          return failResult({
            success: false,
            error: `${THIN_CONTENT_FAILURE_REASON}: ${computedWordCount} words (need ${minRequired} for ${articleType})`
          });
        } else {
          agent.log(
            "error",
            `${THIN_CONTENT_FAILURE_REASON}: no sections expanded — ${computedWordCount} words (need ${minRequired} for ${articleType})`
          );
          await escalateToCodingAgent(agent, {
            kvKey,
            keyword,
            categorySlug,
            errorCategory: "content-gate-too-thin",
            errorMessage: `${THIN_CONTENT_FAILURE_REASON}: ${computedWordCount} words (need ${minRequired} for ${articleType}); no sections expandable`,
            metadata: {
              wordCount: computedWordCount,
              minRequired,
              articleType,
              sectionCount: article.sections?.length ?? 0
            }
          });
          return failResult({
            success: false,
            error: `${THIN_CONTENT_FAILURE_REASON}: ${computedWordCount} words (need ${minRequired} for ${articleType}); no sections expandable`
          });
        }
      } catch (expandErr: unknown) {
        const expandMsg = errMsg(expandErr);
        agent.log("error", `Expand error: ${expandMsg} — failing article`);
        await escalateToCodingAgent(agent, {
          kvKey,
          keyword,
          categorySlug,
          errorCategory: "content-gate-too-thin",
          errorMessage: `Expand error: ${expandMsg}`,
          metadata: {
            wordCount: computedWordCount,
            minRequired
          }
        });
        return failResult({
          success: false,
          error: `Article too thin: ${computedWordCount} words (need ${minRequired}); expand error`
        });
      }
    }
    if ((article.sections?.length || 0) < 1) {
      agent.log("error", `Content gate: no sections found`);
      await escalateToCodingAgent(agent, {
        kvKey,
        keyword,
        categorySlug,
        errorCategory: "pipeline-unknown-failure",
        errorMessage: "No sections found in parsed article"
      });
      return failResult({ success: false, error: `No sections found` });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FAQ injection fallback — ensure at least 5 FAQs for FAQPage schema.
    // Floor used to be `< 3` while the injector pads UP TO 5 — so
    // articles with exactly 3 or 4 FAQs were shipping under-padded
    // and missing FAQPage rich-result eligibility (Google rewards
    // 4-5+ Q&A pairs per page). Aligning the gate with the
    // injector target closes the gap. Direct SERP-real-estate +
    // CTR lever per Chief Engineer direction.
    if (!article.faqs || article.faqs.length < 5) {
      const beforeCount = article.faqs?.length ?? 0;
      article.faqs = injectDefaultFaqs(
        article.faqs || [],
        keyword,
        categorySlug
      );
      agent.log(
        "info",
        `FAQ injection: ${beforeCount} → ${article.faqs.length} FAQs (FAQPage schema floor)`
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 9/24: Content enhancement — slop removal + product slot hydration
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("9/24: Content Enhancement");

    // 6a: Remove AI slop phrases
    const slopPhrases = [
      "delve",
      "leverage",
      "utilize",
      "robust",
      "comprehensive",
      "pivotal",
      "cutting-edge",
      "game-changer",
      "revolutionize",
      "groundbreaking",
      "seamlessly",
      "in today's world",
      "it's worth noting",
      "it's important to note"
    ];
    let slopCount = 0;
    let asinLeakCount = 0;
    const cleanField = (text: string): string => {
      let cleaned = text;
      for (const phrase of slopPhrases) {
        const regex = new RegExp(`\\b${phrase}\\b`, "gi");
        const matches = cleaned.match(regex);
        if (matches) slopCount += matches.length;
        cleaned = cleaned.replace(regex, "");
      }
      // Strip Kimi-fabricated "Editorial Note:" / "Editorial Integrity
      // Note:" blocks (false E-E-A-T claims about physical testing).
      cleaned = stripEditorialNoteFabrication(cleaned);
      // Strip parenthetical ASIN leaks ("(B0XXXXXXXX)") the model copies
      // from product grounding into visible prose.
      const asinStrip = stripAsinParentheticals(cleaned);
      asinLeakCount += asinStrip.removed;
      cleaned = asinStrip.text;
      return cleaned.replace(/\s{2,}/g, " ").trim();
    };

    article.introduction = cleanField(article.introduction);
    article.conclusion = cleanField(article.conclusion);
    if (article.whyTrustUs) article.whyTrustUs = cleanField(article.whyTrustUs);
    if (article.quickAnswer)
      article.quickAnswer = cleanField(article.quickAnswer);
    article.keyTakeaways = (article.keyTakeaways || []).map(cleanField);
    for (const section of article.sections || []) {
      section.content = cleanField(section.content);
    }
    for (const faq of article.faqs || []) {
      faq.answer = cleanField(faq.answer);
    }
    if (slopCount > 0) {
      agent.log("info", `Slop removal: ${slopCount} AI slop phrases cleaned`);
    }

    // 6b: Hydrate product slot tokens [PRODUCT_1] → real names
    const fieldsToHydrate: Array<
      "introduction" | "conclusion" | "whyTrustUs" | "quickAnswer"
    > = ["introduction", "conclusion", "whyTrustUs", "quickAnswer"];
    let totalSlots = 0;
    for (const field of fieldsToHydrate) {
      const fieldValue = article[field];
      if (fieldValue) {
        const result = hydrateProductSlots(fieldValue, products);
        article[field] = result.text;
        totalSlots += result.slotsReplaced;
      }
    }
    for (const section of article.sections || []) {
      const headingResult = hydrateProductSlots(section.heading, products);
      section.heading = headingResult.text;
      totalSlots += headingResult.slotsReplaced;
      const result = hydrateProductSlots(section.content, products);
      section.content = result.text;
      totalSlots += result.slotsReplaced;
    }
    for (const faq of article.faqs || []) {
      const result = hydrateProductSlots(faq.answer, products);
      faq.answer = result.text;
      totalSlots += result.slotsReplaced;
    }
    // Per-pick reasoning sometimes lands with [PRODUCT_N] slot tokens
    // still in place (the writer template asks for literal product
    // names but Llama defaults to the slot notation used elsewhere in
    // the prompt). Hydrate those too so pick cards don't show
    // "[PRODUCT_1]" to the reader.
    for (const pr of article.pickReasons || []) {
      const result = hydrateProductSlots(pr.reasoning, products);
      // Pick-card blurbs bypass cleanField above, so strip ASIN leaks here
      // too — this is exactly where "(B0XXXXXXXX)" reached a live blurb.
      const asinStrip = stripAsinParentheticals(result.text);
      asinLeakCount += asinStrip.removed;
      pr.reasoning = asinStrip.text.replace(/\s{2,}/g, " ").trim();
      totalSlots += result.slotsReplaced;
    }
    if (totalSlots > 0) {
      agent.log(
        "info",
        `Product hydration: ${totalSlots} slots replaced with real names`
      );
    }
    if (asinLeakCount > 0) {
      agent.log(
        "info",
        `ASIN leak strip: removed ${asinLeakCount} parenthetical ASIN(s) from prose`
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 9.5/24: Published Article Text Editor — mechanical quality pass
    // (truncation fix, empty-section fill, token-leak removal, dedup)
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("9.5/24: Text Editor");
    article = await runTextEditorAgent(agent, article, keyword);

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 10/24: YouTube video search
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("10/24: YouTube Video");
    const video = await searchYouTubeVideo(keyword, (msg) =>
      agent.log("warning", `Writer YouTube step (${keyword}): ${msg}`)
    );
    if (video) {
      agent.log("info", `YouTube: "${video.title}" by ${video.channel}`);
    } else {
      agent.log("info", "YouTube: no video found");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step (removed): Image generation — REMOVED (broken R2 URLs, Our Top Picks above fold is better)
    // ═══════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 11/24: HTML assembly
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("11/24: HTML Assembly");
    // Re-sanitize after the expand loop: section/FAQ expansion adds new
    // model output that was not processed by the initial sanitizeArticleLeaks
    // call inside parseArticleJson. A distributed leak (markers spread across
    // multiple expanded fields) would pass per-field inline checks but still
    // trip the publish gate that counts markers across the full document.
    article = sanitizeArticleLeaks(article);
    // Strip prices at the data layer, before HTML assembly. The writer
    // prompt forbids prices but Kimi sometimes hallucinates them; stripping
    // here means the published HTML is born clean and the downstream
    // `kvDeployStrip` (Step 13) is a true no-op safety net rather than the
    // first line of defense. Surfaces caught prices in the activity log so
    // operators can still see when Kimi disobeys the prompt.
    {
      const { article: priceStripped, stripped } = stripPricesFromArticleData(
        article,
        keywordPriceTokens
      );
      if (stripped.length > 0) {
        agent.log(
          "info",
          `Writer: stripped ${stripped.length} price mention(s) from article data — ${stripped.slice(0, 5).join(", ")}`
        );
      }
      article = priceStripped;
    }
    let html = buildArticleHtml({
      article,
      slug,
      keyword,
      categorySlug,
      categoryName,
      domain,
      tag,
      products,
      heroImageUrl: undefined,
      videoId: video?.videoId,
      videoTitle: video?.title,
      videoChannel: video?.channel,
      internalLinks,
      externalLinks: buildTopicalExternalLinks(
        serpData.topUrls,
        serpData.topTitles,
        competitorData?.url ?? null
      )
    });

    // Publish gate: refuse to publish when Kimi's structured output has
    // leaked into the visible body (raw `{"sections":[...]}` blobs etc.).
    // Better to fail the article than publish JSON-garbled HTML that
    // Google will penalize and we'd have to unpublish after indexing.
    const leakCheck = detectJsonSchemaLeak(html);
    if (leakCheck.leaked) {
      agent.log(
        "error",
        `❌ Publish gate: JSON schema leaked into body — markers=[${leakCheck.markers.join(", ")}] — pipeline stopped, nothing published`
      );
      await escalateToCodingAgent(agent, {
        kvKey,
        keyword,
        categorySlug,
        errorCategory: "publish-gate-leak",
        errorMessage: `JSON schema leaked into body (markers: ${leakCheck.markers.join(", ")})`,
        metadata: {
          leakMarkers: leakCheck.markers.join(","),
          htmlLength: html.length
        }
      });
      return failResult({
        success: false,
        error: `JSON schema leaked into body (markers: ${leakCheck.markers.join(", ")}) — refusing to publish`
      });
    }

    // Design Architect: HTML structure + schemas
    const schemas: string[] = ["Article", "BreadcrumbList"];
    if (article.faqs && article.faqs.length > 0) schemas.push("FAQ");
    agent.log(
      "info",
      `HTML assembled: ${kvKey} (${article.sections.length} sections, schemas: ${schemas.join("+")})`,
      "designArchitect",
      {
        kanbanStage: "inProgress",
        kvKey,
        articleSectionCount: article.sections.length,
        htmlSchemas: schemas,
        htmlIssues:
          article.sections.length < 6
            ? [`Only ${article.sections.length} sections (target 6+)`]
            : undefined
      }
    );

    // Developer: file path for the article
    agent.log(
      "info",
      `File: articles/${categorySlug}/${slug}.html (${html.length} bytes)`,
      "developer",
      {
        kanbanStage: "inProgress",
        filePath: `articles/${categorySlug}/${slug}.html`,
        embedUrl: `https://${domain}/${categorySlug}/${slug}`,
        filesJson: JSON.stringify([
          {
            path: `articles/${categorySlug}/${slug}.html`,
            size: html.length
          }
        ])
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 12/24: SEO Score
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("12/24: SEO Score");
    let seoResult = calculateSEOScore(
      html,
      keyword,
      article.title,
      article.metaDescription,
      1000
    );

    const seoScorecardQcPromptCells = await generateSeoScorecardQcPromptCells(
      agent,
      seoResult.checks,
      keyword,
      article.title,
      article.metaDescription,
      html
    );

    // Log overall score + pillar breakdown
    const pillarSummary = Object.entries(seoResult.pillarScores)
      .map(([p, s]) => `${p}: ${s.passed}/${s.total}`)
      .join(" | ");
    agent.log(
      "info",
      `SEO Score: ${seoResult.score}/100 | ${pillarSummary}`,
      "qaReviewer",
      {
        kanbanStage: "aiReview",
        seoScore: seoResult.score,
        seoVerdict: seoResult.score >= 70 ? "pass" : "fail",
        seoPillarSummary: pillarSummary,
        seoFixList: seoResult.checks
          .filter((c) => !c.passed)
          .map((c) => `${c.name}: ${c.detail}`)
      }
    );

    // Log each pillar's individual checks
    for (const [pillar, scores] of Object.entries(seoResult.pillarScores)) {
      const pillarChecks = seoResult.checks.filter((c) => c.pillar === pillar);
      const passed = pillarChecks
        .filter((c) => c.passed)
        .map((c) => `✅ #${c.id} ${c.name}`);
      const failed = pillarChecks
        .filter((c) => !c.passed)
        .map((c) => `❌ #${c.id} ${c.name}: ${c.detail}`);
      agent.log(
        "info",
        `${pillar} (${scores.passed}/${scores.total}):`,
        "qaReviewer"
      );
      for (const line of [...passed, ...failed]) {
        // Both pass and fail entries are gap-report rows feeding the Polish
        // agent's todo list — not actual failures. Log at info either way
        // so the warnings panel only surfaces real problems.
        agent.log("info", `  ${line}`, "qaReviewer");
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 13/24: KV Deploy
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("13/24: KV Deploy");
    // Amazon Associates compliance — defensive price strip at every KV
    // write. Even with the no-prices prompt rule, Kimi occasionally
    // hallucinates a dollar amount; this guarantees nothing ships.
    const kvDeployStrip = stripPricesFromHtml(html, keywordPriceTokens);
    if (kvDeployStrip.stripped.length > 0) {
      // Defense-in-depth: the writer + agent prompts forbid prices and the
      // article-data layer scrubs anything Kimi hallucinates. If anything
      // still reaches here it's a downstream stage (QC/Polish rewrite) that
      // re-introduced one — silently strip and log at info, since the
      // published HTML ends up clean either way.
      agent.log(
        "info",
        `KV deploy: stripped ${kvDeployStrip.stripped.length} price mention(s) before publish — ${kvDeployStrip.stripped.slice(0, 3).join(", ")}`
      );
      html = kvDeployStrip.cleaned;
    }
    html = normalizeHtmlWhitespace(html);
    // Step 14.5: structural JSON-LD validation. Non-blocking by design —
    // we log specific block errors but proceed with the publish so the
    // Editorial Agent gets its post-publish shot at the article. If
    // JSON-LD is broken here, the editorial-agent's commit-6 check
    // (same `validateJsonLd`) will catch a regressing rewrite and
    // reject it. This emits the baseline reading.
    try {
      const { classifyJsonLdSeverity, validateJsonLd } =
        await import("./qc-gate");
      const jsonLdReport = validateJsonLd(html);
      const { severity, severeReasons } = classifyJsonLdSeverity(jsonLdReport);
      if (severity === "severe") {
        // Generator-level defect — these are the failure modes Google
        // actually penalises (no rich-results eligibility). Record a
        // defect-loop finding so 5 occurrences in 24h fires the
        // html-builder fix path automatically, per user direction:
        // "fix the generator, not individual articles."
        agent.log(
          "error",
          `Step 14.5: JSON-LD SEVERE — ${severeReasons.join(" | ")}`,
          "qaReviewer"
        );
        await recordFinding(agent, {
          defectClass: "prepub-jsonld-severe",
          kvKey,
          timestamp: new Date().toISOString(),
          evidence: {
            occurrenceCount: severeReasons.length,
            sampleSnippet: severeReasons.join(" | ").slice(0, 240),
            keyword
          },
          suspectedCodePath:
            "src/pipeline/html-builder.ts:buildArticleHtml (JSON-LD blocks)"
        });
      } else if (severity === "minor") {
        const errSnippets = jsonLdReport.blocks
          .flatMap((b) => b.errors)
          .slice(0, 3)
          .join(" | ");
        agent.log(
          "warning",
          `Step 14.5: JSON-LD minor issues in ${jsonLdReport.blockCount} block(s) — ${errSnippets}`
        );
      } else if (jsonLdReport.blockCount > 0) {
        agent.log(
          "info",
          `Step 14.5: JSON-LD validation passed (${jsonLdReport.blockCount} block(s) valid)`
        );
      }
      // Defect-loop detectors. Each scans the freshly-built HTML for one
      // known defect class and records a structured finding (non-blocking)
      // so the per-defect-class self-improving loop fires on the next
      // 5-in-24h cluster. Publish proceeds either way — these are
      // regression guards once a fix lands, and pattern emitters before.
      const sliceAround = (idx: number, before = 40, after = 80): string =>
        html
          .slice(Math.max(0, idx - before), Math.min(html.length, idx + after))
          .replace(/\s+/g, " ");
      // `recordFinding` is now a static top-of-file import — defect-findings.ts
      // doesn't transitively import writer.ts so there's no circular-import
      // risk, and we save 5 per-article dynamic-import awaits.

      // 1. "Best best" doubled prefix (JSON-LD ItemList.name or anywhere).
      const doubledBestMatches = html.match(/\bBest best\b/g);
      if (doubledBestMatches && doubledBestMatches.length > 0) {
        const sampleSnippet = sliceAround(html.search(/\bBest best\b/));
        agent.log(
          "warning",
          `Step 14.5: "Best best" doubled-prefix detected (${doubledBestMatches.length}×) — defect-loop finding recorded; publish proceeds. Sample: …${sampleSnippet}…`
        );
        await recordFinding(agent, {
          defectClass: "itemlist-doubled-best",
          kvKey,
          timestamp: new Date().toISOString(),
          evidence: {
            occurrenceCount: doubledBestMatches.length,
            sampleSnippet,
            keywordStartsWithBest: keyword.toLowerCase().startsWith("best "),
            keyword
          },
          suspectedCodePath:
            "src/pipeline/html-builder.ts:buildArticleHtml:productSchema_ItemList_name"
        });
      }

      // 2. Product-name mid-token truncation: `...\.{3,}\s+(verb)\s+` —
      // a product name truncated with ellipsis then concatenated with a
      // sentence-starting verb. Real example: "Wellness Monitoring for...
      // provides superior tracking".
      // Verb-prefixed sentence continuation immediately after a product
      // name's ellipsis. List broadened past the original 11 because
      // the cat-GPS audit showed cases starting with `... is`,
      // `... has`, `... combines`, etc. slipping through. False-positive
      // risk stays low because the leading `\w\s*\.{3,}\s+` requires a
      // word immediately before the ellipsis, which doesn't occur in
      // legitimate Kimi prose (paragraphs don't end mid-word with `...`).
      const truncRe =
        /\w\s*\.{3,}\s+(?:provides|ranks|offers|features|delivers|comes|works|stands|gives|brings|includes|is|are|was|were|has|have|had|combines|excels|tops|leads|wins|earns|carries|adds|fits|holds|keeps|uses|tracks|monitors|enables|supports|allows|lets|makes|seems|appears|remains|stays|sits)\b/gi;
      const truncMatches = html.match(truncRe);
      if (truncMatches && truncMatches.length > 0) {
        const sampleSnippet = sliceAround(html.search(truncRe));
        agent.log(
          "warning",
          `Step 14.5: product-name mid-token truncation detected (${truncMatches.length}×) — defect-loop finding recorded; publish proceeds. Sample: …${sampleSnippet}…`
        );
        await recordFinding(agent, {
          defectClass: "product-name-truncation",
          kvKey,
          timestamp: new Date().toISOString(),
          evidence: {
            occurrenceCount: truncMatches.length,
            sampleSnippet,
            keyword
          },
          suspectedCodePath:
            "src/pipeline/writer.ts:buildArticle:productBlurbPrompt OR src/pipeline/html-builder.ts:renderProductBlurb"
        });
      }

      // 3. Missing "Why we like this pick:" markers when product picks
      // exist. Detection: article has `class="top-picks"` (the outer
      // wrapper rendered by html-builder.ts:buildArticleHtml for product
      // picks — confirmed via grep, line 679) AND zero
      // `Why we like` substrings. Previously keyed off a non-existent
      // `pick-card` class so the detector never fired.
      const hasProductPicks = /class\s*=\s*["'][^"']*top-picks/i.test(html);
      const whyMarkerCount = (html.match(/Why we like this pick/gi) || [])
        .length;
      if (hasProductPicks && whyMarkerCount === 0) {
        agent.log(
          "warning",
          `Step 14.5: product picks present but ZERO "Why we like this pick" markers — defect-loop finding recorded; publish proceeds.`
        );
        await recordFinding(agent, {
          defectClass: "missing-why-we-like-blurb",
          kvKey,
          timestamp: new Date().toISOString(),
          evidence: {
            occurrenceCount: 0,
            sampleSnippet: "(no markers found in product-pick section)",
            keyword,
            hasProductPicks: true
          },
          suspectedCodePath:
            "src/pipeline/writer.ts:buildArticle:productBlurbPrompt OR src/pipeline/html-builder.ts:renderProductBlurb"
        });
      }

      // 4. FAQ noun-shuffle near-duplicates. Generic detector: extract
      // every <h3> question, normalise to lowercase + strip punctuation,
      // take the first 4 tokens as the "stem". If any stem appears 3+
      // times across the document we have a noun-shuffle defect. This
      // replaces the previous hard-coded "What is the best cat ..."
      // pattern which only fired on the exact GPS-keyword article that
      // surfaced the bug — keyword-agnostic now.
      const h3Questions = (html.match(/<h3[^>]*>[^<]*\?[^<]*<\/h3>/gi) || [])
        .map((h3) => {
          const inner = h3.replace(/<[^>]*>/g, "").trim();
          return inner.toLowerCase().replace(/[^\w\s]/g, "");
        })
        .filter((q) => q.length > 0);
      const stemCounts: Record<string, number> = {};
      for (const q of h3Questions) {
        const stem = q.split(/\s+/).slice(0, 4).join(" ");
        if (stem.split(" ").length < 4) continue; // skip too-short
        stemCounts[stem] = (stemCounts[stem] || 0) + 1;
      }
      const repeatedStems = Object.entries(stemCounts).filter(
        ([, n]) => n >= 3
      );
      if (repeatedStems.length > 0) {
        const [worstStem, worstCount] = repeatedStems[0];
        const sampleSnippet = `Stem "${worstStem}" appears ${worstCount}× across FAQ questions.`;
        agent.log(
          "warning",
          `Step 14.5: FAQ noun-shuffle near-duplicates detected — defect-loop finding recorded; publish proceeds. ${sampleSnippet}`
        );
        await recordFinding(agent, {
          defectClass: "faq-near-duplicate-questions",
          kvKey,
          timestamp: new Date().toISOString(),
          evidence: {
            occurrenceCount: worstCount,
            sampleSnippet,
            keyword,
            repeatedStems: repeatedStems.map(([s, n]) => `${s}=${n}`).join("; ")
          },
          suspectedCodePath: "src/pipeline/writer.ts:buildArticle:faqPrompt"
        });
      }

      // 5. Duplicate Top Picks section H2s. Detection: BOTH `<h2>Top Picks`
      // AND `<h2>Our Top Picks` appear as section headings (h2 specifically,
      // not arbitrary occurrences inside JSON-LD or CSS).
      const hasPlainTopPicks = /<h2[^>]*>\s*Top Picks\b/i.test(html);
      const hasOurTopPicks = /<h2[^>]*>\s*Our Top Picks\b/i.test(html);
      if (hasPlainTopPicks && hasOurTopPicks) {
        const sampleSnippet = sliceAround(
          html.search(/<h2[^>]*>\s*Top Picks\b/i)
        );
        agent.log(
          "warning",
          `Step 14.5: duplicate Top Picks H2 sections detected ("Top Picks" + "Our Top Picks") — defect-loop finding recorded; publish proceeds.`
        );
        await recordFinding(agent, {
          defectClass: "duplicate-top-picks-headings",
          kvKey,
          timestamp: new Date().toISOString(),
          evidence: {
            occurrenceCount: 2,
            sampleSnippet,
            keyword
          },
          suspectedCodePath:
            "src/pipeline/html-builder.ts:buildArticleHtml:section_assembly OR src/pipeline/writer.ts:buildArticle:sectionPrompt"
        });
      }
    } catch (jsonLdErr: unknown) {
      // Validator-internal error shouldn't block publish — log info.
      agent.log(
        "info",
        `Step 14.5: JSON-LD validator threw (${errMsg(jsonLdErr)}); proceeding with publish`
      );
    }
    // Final pre-publish word-count check on the RENDERED HTML body
    // text. The earlier gate (line ~1385) operates on the ArticleData
    // JSON object — but the article goes through `buildArticleHtml`,
    // price-stripping, whitespace normalization, and QC/Polish before
    // landing here, any of which can shrink the visible word count.
    // This catches the case where the JSON had 1200 words but the
    // rendered HTML body (post all transforms) is below the
    // article-type floor. Same `THIN_CONTENT_FAILURE_REASON` and
    // `articleType`/`hardFloor` as the upstream gate so the failure
    // attribution stays consistent.
    const renderedBodyText = stripHtmlToPlainText(html);
    const renderedWordCount = renderedBodyText
      ? renderedBodyText.split(/\s+/).filter((w) => w.length > 0).length
      : 0;
    if (renderedWordCount < hardFloor) {
      agent.log(
        "error",
        `${THIN_CONTENT_FAILURE_REASON}: pre-publish rendered-HTML check — ${renderedWordCount} words in rendered body (need ${hardFloor} for ${articleType}; article JSON had ${computedWordCount}). Blocking publish.`
      );
      await escalateToCodingAgent(agent, {
        kvKey,
        keyword,
        categorySlug,
        errorCategory: "content-gate-too-thin",
        errorMessage: `${THIN_CONTENT_FAILURE_REASON}: rendered HTML ${renderedWordCount} words (need ${hardFloor} for ${articleType})`,
        metadata: {
          renderedWordCount,
          articleJsonWordCount: computedWordCount,
          hardFloor,
          articleType,
          htmlLength: html.length
        }
      });
      return failResult({
        success: false,
        error: `${THIN_CONTENT_FAILURE_REASON}: rendered HTML ${renderedWordCount} words (need ${hardFloor} for ${articleType})`
      });
    }
    // Step 14.6: unsourced YMYL claim detection. Scans the rendered body
    // text for benefit-eligibility / regulatory-certification / quantified-
    // research / named-endorsement claims asserted as fact with no citation
    // (e.g. "reimbursable through Veteran-Directed Care", "ADA compliance,
    // 50,000+ wheel-cycle testing", "studies demonstrate 60% reduction").
    // Non-blocking: we log + record a defect-loop finding so 5 hits in 24h
    // fires the writer-prompt fix, and pass the findings to the Polish Agent
    // (Step 18) which qualifies or removes each claim before the final KV
    // redeploy. Detection is best-effort — a validator-internal throw must
    // never block the publish.
    let unsourcedClaimFindings: UnsourcedClaimFinding[] = [];
    try {
      unsourcedClaimFindings = detectUnsourcedClaims(renderedBodyText);
      if (unsourcedClaimFindings.length > 0) {
        const summary = summarizeUnsourcedClaims(unsourcedClaimFindings);
        agent.log(
          "warning",
          `Step 14.6: ${summary} — defect-loop finding recorded; Polish Agent will qualify/remove. Sample: "${unsourcedClaimFindings[0].sentence.slice(0, 160)}"`,
          "qaReviewer"
        );
        await recordFinding(agent, {
          defectClass: "unsourced-ymyl-claim",
          kvKey,
          timestamp: new Date().toISOString(),
          evidence: {
            occurrenceCount: unsourcedClaimFindings.length,
            sampleSnippet: unsourcedClaimFindings
              .slice(0, 3)
              .map((c) => `[${c.category}] ${c.sentence}`)
              .join(" | ")
              .slice(0, 240),
            keyword,
            categories: Array.from(
              new Set(unsourcedClaimFindings.map((c) => c.category))
            ).join(", ")
          },
          suspectedCodePath:
            "src/pipeline/writer.ts:buildArticle (article/section/FAQ prompts emitting unsourced authority claims)"
        });
      }
    } catch (claimErr: unknown) {
      agent.log(
        "info",
        `Step 14.6: unsourced-claim detector threw (${errMsg(claimErr)}); proceeding with publish`
      );
    }

    // Step 14.7: fabricated product-testing claim detection. Scans the
    // rendered body for first-person product-trial language ("we tested",
    // "hands-on testing", "in our facility", "tested 200 times", etc.).
    // Catsluvus.com does not physically test products, so any such claim
    // is an FTC 16 CFR Part 255 false-endorsement risk. Non-blocking on
    // detection: records a defect-loop finding and the Polish Agent
    // rewrite step (via the now-inverted SEO check #10) cleans the prose
    // before the final KV redeploy. Detector throws are swallowed so a
    // validator-internal failure can never block publish.
    let fabricatedTestingFindings: FabricatedTestingClaimFinding[] = [];
    try {
      // FTC proximity exception (16 CFR Part 255): comparative claims
      // ("We compared N products") inside a `<section class="wc-
      // methodology">` block that ALSO carries the methodology
      // disclosure ("Products are not physically tested by Cats Luv
      // Us…") are FTC-compliant because the substantiation is in the
      // same section. Strip those compliant sections before detection
      // so the gate doesn't fire on its own template output. Non-
      // compliant `wc-methodology` blocks and any text outside the
      // section flow through unchanged.
      const ftcGateText = stripHtmlToPlainText(
        stripCompliantMethodologySections(html)
      );
      fabricatedTestingFindings = detectFabricatedTestingClaims(ftcGateText);
      if (fabricatedTestingFindings.length > 0) {
        const summary = summarizeFabricatedTestingClaims(
          fabricatedTestingFindings
        );
        agent.log(
          "warning",
          `Step 14.7: ${summary} — defect-loop finding recorded; Polish Agent (via inverted SEO check #10) will rewrite. Sample: "${fabricatedTestingFindings[0].sentence.slice(0, 160)}"`,
          "qaReviewer"
        );
        // Headings and TOC anchors are out of the Polish LLM's reach
        // (its find/replace works from a truncated plain-text excerpt
        // and its fuzzy matcher refuses to cross block tags), so
        // neutralize testing vocabulary on those surfaces
        // deterministically before the first KV put.
        const headingFix = neutralizeTestingHeadings(html);
        if (headingFix.changed > 0) {
          html = headingFix.html;
          agent.log(
            "warning",
            `Step 14.7: testing vocabulary swapped in ${headingFix.changed} heading/TOC element(s) (test→compare) before publish`,
            "qaReviewer"
          );
        }
        // Deterministic backstop for the flagged body sentences: the
        // Polish T-block is the quality fix, but it needs a live model.
        // FTC violations must not ship just because the model layer is
        // down (which is exactly how "She personally reviews and stands
        // behind every product recommendation" reached production on
        // 2026-06-11). Excise the flagged sentences outright.
        const excision = removeFabricatedTestingSentences(
          html,
          fabricatedTestingFindings
        );
        if (excision.removed > 0) {
          html = excision.html;
          agent.log(
            "warning",
            `Step 14.7: ${excision.removed} fabricated-testing sentence(s) excised deterministically before publish`,
            "qaReviewer"
          );
        }
        await recordFinding(agent, {
          defectClass: "prepub-fabricated-testing-claim",
          kvKey,
          timestamp: new Date().toISOString(),
          evidence: {
            occurrenceCount: fabricatedTestingFindings.length,
            sampleSnippet: fabricatedTestingFindings
              .slice(0, 3)
              .map((c) => `[${c.category}] ${c.sentence}`)
              .join(" | ")
              .slice(0, 240),
            keyword,
            categories: Array.from(
              new Set(fabricatedTestingFindings.map((c) => c.category))
            ).join(", ")
          },
          suspectedCodePath:
            "src/pipeline/writer.ts:buildArticle (article/section/FAQ prompts emitting first-person product-testing claims) + src/pipeline/polish-agent.ts (must remove all testing language; HARD RULE 2)"
        });
      }
    } catch (testingErr: unknown) {
      agent.log(
        "info",
        `Step 14.7: fabricated-testing detector threw (${errMsg(testingErr)}); proceeding with publish`
      );
    }

    // Step 14.8: readability metrics + process-language detection (ported
    // from every-app/sam's publish-readiness analyzers, MIT). Flags prose
    // that exposes the writing process instead of serving the reader —
    // self-referential "this guide", "at the time of writing", "we chose/
    // excluded", methodology or exclusion talk outside the wc-methodology
    // template box, and process-note headings like "How We Chose".
    // Non-blocking: readability metrics are logged for trend observability,
    // and process-language findings record a defect-loop finding + feed the
    // Polish Agent (Step 18) which rewrites each flagged sentence around the
    // reader's problem and payoff. Detector throws never block publish.
    let processLanguageFindings: ProcessLanguageFinding[] = [];
    try {
      const contentQuality = analyzeContentQuality(html);
      agent.log(
        "info",
        `Step 14.8: content quality — ${summarizeContentQuality(contentQuality)}`
      );
      if (contentQuality.issues.length > 0) {
        processLanguageFindings = contentQuality.findings;
        agent.log(
          "warning",
          `Step 14.8: process-language issues — ${contentQuality.issues.join(" | ")} — defect-loop finding recorded; Polish Agent will rewrite. Sample: "${(processLanguageFindings[0]?.snippet ?? "").slice(0, 160)}"`,
          "qaReviewer"
        );
        await recordFinding(agent, {
          defectClass: "prepub-process-language",
          kvKey,
          timestamp: new Date().toISOString(),
          evidence: {
            occurrenceCount: processLanguageFindings.length,
            sampleSnippet: processLanguageFindings
              .slice(0, 3)
              .map((f) => `[${f.category}] ${f.snippet}`)
              .join(" | ")
              .slice(0, 240),
            keyword,
            issues: contentQuality.issues.join(" | ").slice(0, 240),
            introWords: contentQuality.introWords,
            averageSentenceLength:
              contentQuality.readability.averageSentenceLength,
            longSentences: contentQuality.readability.longSentences,
            complexWordRate: contentQuality.readability.complexWordRate
          },
          suspectedCodePath:
            "src/pipeline/writer.ts:buildArticle (intro/section/heading prompts emitting process or methodology language)"
        });
      }
    } catch (cqErr: unknown) {
      agent.log(
        "info",
        `Step 14.8: content-quality analyzer threw (${errMsg(cqErr)}); proceeding with publish`
      );
    }

    // Hard structural guard, unconditional — mirrors the same invariant
    // enforced on Editorial Agent rewrites (editorial-agent.ts). "Exactly
    // one H1" is a document-shape invariant, not a scorable-and-offsettable
    // quality signal: two concurrent generateArticle() runs racing on the
    // same kvKey (the Step 1/24 KV-existence check at the top of this
    // function is TOCTOU — both runs can pass it before either writes) can
    // otherwise glue two complete documents into one KV blob. Refuse to
    // publish rather than ship a broken page; the keyword stays available
    // for the next autonomousLoop cycle to retry cleanly.
    const publishH1Count = (html.match(/<h1\b/gi) || []).length;
    if (publishH1Count !== 1) {
      agent.log(
        "error",
        `Publish rejected — H1 count regression (assembled HTML has ${publishH1Count} <h1> tags, expected exactly 1; likely a concurrent-run race on kvKey=${kvKey}): ${slug}`
      );
      await escalateToCodingAgent(agent, {
        kvKey,
        keyword,
        categorySlug,
        errorCategory: "prepub-h1-count-regression",
        errorMessage: `Assembled HTML has ${publishH1Count} <h1> tags (expected 1) before KV write`,
        metadata: { h1Count: publishH1Count, wordCount: computedWordCount }
      });
      return failResult({
        success: false,
        error: `Publish rejected — H1 count regression (${publishH1Count} <h1> tags)`
      });
    }
    // Last-moment re-check of the same race: if another concurrent run
    // already wrote this kvKey between our Step 1/24 check and here, don't
    // clobber/duplicate — skip this write and let the existing published
    // version stand.
    const raceCheck = await agent.envBindings.ARTICLES_KV.get(kvKey);
    if (raceCheck) {
      agent.log(
        "warning",
        `Publish skipped — kvKey=${kvKey} was written by a concurrent run between the Step 1/24 check and final write: ${slug}`
      );
      return failResult({
        success: true,
        kvKey,
        url,
        seoScore: 0,
        wordCount: 0
      });
    }

    await agent.envBindings.ARTICLES_KV.put(kvKey, html, {
      metadata: {
        title: article.title,
        category: categorySlug,
        keyword,
        wordCount: computedWordCount,
        created: new Date().toISOString()
      }
    });

    // Update the articles index for this category
    try {
      const indexKey = `articles-index:${categorySlug}`;
      const existingIndex = await agent.envBindings.ARTICLES_KV.get(indexKey);
      const { index, warning } = normalizeArticlesIndex(
        existingIndex,
        categorySlug
      );
      if (warning) {
        agent.log(
          "warning",
          `${warning} (indexKey=${indexKey}, currentSlug=${slug})`
        );
      }
      if (!index.includes(slug)) {
        index.push(slug);
        await agent.envBindings.ARTICLES_KV.put(
          indexKey,
          JSON.stringify(index)
        );
      }
    } catch (err: unknown) {
      agent.log(
        "warning",
        `Failed to update articles index (indexKey=articles-index:${categorySlug}, currentSlug=${slug}): ${errMsg(err)}`
      );
    }

    // Article ledger (KEYWORDS_DB D1): one queryable row per published
    // article — keyword, URL, score, size, product count, competitor.
    // Best-effort: a D1 hiccup must never fail the publish.
    try {
      const ledgerDb = agent.envBindings.KEYWORDS_DB;
      if (ledgerDb) {
        await ledgerDb
          .prepare(
            `INSERT OR REPLACE INTO article_ledger
               (kv_key, slug, keyword, category_slug, url, seo_score,
                word_count, product_count, competitor_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
          )
          .bind(
            kvKey,
            slug,
            keyword,
            categorySlug,
            url,
            seoResult.score,
            computedWordCount,
            products.length,
            competitorData?.url ?? ""
          )
          .run();
      }
    } catch (ledgerErr: unknown) {
      agent.log(
        "warning",
        `Article ledger (D1) write failed for ${kvKey}: ${errMsg(ledgerErr)}`
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 14/24: Live URL verification (must pass before “Published”)
    // IndexNow is NOT fired here — it fires once at the end via finalizeArticle()
    // after all rewrites (QC + Polish) have completed, so crawlers
    // always receive the fully-polished version. See finalizeArticle() above.
    //
    // Serving model: HTML lives in ARTICLES_KV (key = `categorySlug:slug`).
    // The petinsurance Worker is the consumer that reads ARTICLES_KV and serves
    // /cat-*, /automatic-*, /blog*, etc. This pipeline Worker writes KV only;
    // live URL verification uses the PETINSURANCE service binding when present
    // so the probe hits petinsurance worker-to-worker (not public DNS/edge).
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("14/24: Verify");

    // URL verification — retry up to 3 times (HEAD + GET fallback in probe).
    // After KV deploy, a 404 (or any non-2xx/3xx) is a wiring/config bug: stop the pipeline.
    let verified = false;
    let lastProbe: UrlHttpStatusResult | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const probe = await probeUrlHttpStatus(
        url,
        undefined,
        agent.envBindings.PETINSURANCE
      );
      lastProbe = probe;
      if (probe.status >= 200 && probe.status < 400) {
        agent.log("info", `URL verified: ${url} (HTTP ${probe.status})`);
        verified = true;
        break;
      }
      if (probe.status > 0) {
        agent.log(
          "warning",
          `URL verification attempt ${attempt}: HTTP ${probe.status}`
        );
      } else {
        agent.log(
          "warning",
          `URL verification attempt ${attempt}: ${probe.sheetCell || "probe failed"}`
        );
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!verified) {
      const p = lastProbe;
      const httpPart =
        p && p.status > 0
          ? `HTTP ${p.status}`
          : (p?.sheetCell ?? "no response");
      let detail: string;
      if (p?.status === 404) {
        detail = `Post-deploy check failed: ${url} returned HTTP 404 after KV write (key ${kvKey}). HTML is in ARTICLES_KV but was not served at this URL — fix DOMAIN to the live hostname, ensure petinsurance binds the same ARTICLES_KV namespace, and verify articles are reachable through the petinsurance Worker (the consumer that reads ARTICLES_KV). (${httpPart})`;
      } else if (p && p.status > 0) {
        detail = `Post-deploy check failed: ${url} returned HTTP ${p.status} after KV write (key ${kvKey}). Expected 2xx–3xx before continuing. (${httpPart})`;
      } else {
        detail = `Post-deploy check failed: could not reach ${url} after KV write (key ${kvKey}): ${httpPart}. Check DNS, TLS, and DOMAIN.`;
      }
      agent.log("error", detail, "operations", {
        kanbanStage: "debug",
        actionType: "deploy-kv",
        actionErrors: [httpPart],
        categorySlug,
        keyword
      });
      await escalateToCodingAgent(agent, {
        kvKey,
        keyword,
        categorySlug,
        errorCategory: "pipeline-unknown-failure",
        errorMessage: detail,
        metadata: {
          httpStatus: p?.status ?? 0,
          seoScore: seoResult.score,
          wordCount: computedWordCount
        }
      });
      return failResult({
        success: false,
        error: detail,
        url,
        kvKey,
        seoScore: seoResult.score,
        wordCount: computedWordCount
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Content fingerprint gate. HEAD 200 only proves the URL is reachable
    // — it does not prove THIS article's body landed at this URL. Catches
    // wrong-template fallbacks, soft-404s, KV/serve mismatches, edge-cache
    // poisoning, and route collisions that leave a different article (or
    // empty shell) serving at this slug.
    //
    // Two fingerprints, both required:
    //   1. article.title — verifies the right article is at this URL.
    //   2. ~80-char slice of article.introduction — verifies the right
    //      BODY is there (catches template echo of title meta tag with a
    //      stale or empty body).
    //
    // Render-call FAILURE (timeout, partial CF secret config, BR API 5xx) is
    // logged as a warning and skipped — Browser Rendering hiccups should not
    // block publishes. When both CF bindings are absent we skip quietly;
    // render-call SUCCESS but missing fingerprint is a hard fail that
    // escalates to the Coding Agent and stops the pipeline.
    // ─────────────────────────────────────────────────────────────────────
    {
      const fpAccountId = agent.envBindings.CLOUDFLARE_ACCOUNT_ID?.trim();
      const fpApiToken = agent.envBindings.CLOUDFLARE_API_TOKEN_SECRET?.trim();
      if (!fpAccountId || !fpApiToken) {
        if (fpAccountId || fpApiToken) {
          const missingBindings = getMissingBrowserRenderingBindings(
            fpAccountId,
            fpApiToken
          ).join(", ");
          agent.log(
            "warning",
            `Content fingerprint gate skipped: missing ${missingBindings}; set both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN_SECRET to enable live post-publish verification`
          );
        }
      } else {
        // Run the in-memory title/body through the same `stripPricesFromHtml`
        // pass the published HTML went through, otherwise price-bearing
        // keywords ("under 25 dollars", "$50 budget pick") cause a false-
        // positive fingerprint mismatch: the live <title> has the price
        // ripped out for Amazon Associates compliance, but the raw
        // `article.title` still contains it.
        const titleFp = normalizeForFingerprint(
          stripPricesFromHtml(article.title, keywordPriceTokens).cleaned
        );
        // Body fingerprint: prefer the introduction, but `sanitizeArticleLeaks`
        // can truncate it to "" when Kimi's JSON output had a distributed
        // schema-leak — published HTML is still fine (sections + FAQ +
        // conclusion all rendered) but a fingerprint based on an empty intro
        // would always fail. Fall back to the first section's heading +
        // content slice in that case so the gate keeps its purpose (verify
        // *this* article's body landed at this URL).
        let bodyFp = normalizeForFingerprint(
          stripPricesFromHtml(article.introduction || "", keywordPriceTokens)
            .cleaned
        ).slice(0, 80);
        let bodyFpSource: "intro" | "section1" | "conclusion" = "intro";
        if (bodyFp.length < 20) {
          const firstSection = article.sections?.[0];
          if (firstSection) {
            bodyFp = normalizeForFingerprint(
              stripPricesFromHtml(
                `${firstSection.heading} ${firstSection.content}`,
                keywordPriceTokens
              ).cleaned
            ).slice(0, 80);
            bodyFpSource = "section1";
          } else if (article.conclusion) {
            bodyFp = normalizeForFingerprint(
              stripPricesFromHtml(article.conclusion, keywordPriceTokens)
                .cleaned
            ).slice(0, 80);
            bodyFpSource = "conclusion";
          }
        }
        const fingerprintCheck = await checkContentFingerprint({
          titleFingerprint: titleFp,
          bodyFingerprint: bodyFp,
          bodyFingerprintSource: bodyFpSource,
          render: () => renderPage(fpAccountId, fpApiToken, url),
          onWarning: (message) =>
            agent.log("warning", `${message} (url=${url}, kvKey=${kvKey})`)
        });
        if (!fingerprintCheck.ok && fingerprintCheck.skipped) {
          agent.log(
            "warning",
            `Content fingerprint gate skipped (url=${url}, kvKey=${kvKey}): Browser Rendering unavailable after 3 attempts (${fingerprintCheck.lastRenderError ?? "unknown error"})`
          );
        } else {
          if (fingerprintCheck.ok) {
            agent.log(
              "info",
              `✅ Content fingerprint verified: title + body[${bodyFpSource}] both present in rendered HTML (${fingerprintCheck.renderedLength} chars normalized)`
            );
          } else {
            const missing = fingerprintCheck.missing;
            const fpDetail = `Content fingerprint mismatch: ${url} renders but is missing [${missing}] from this article. KV write succeeded for ${kvKey} but the live page does not contain this article's content. Likely causes: wrong template/route serving, KV key mismatch, edge-cache poisoning, or another article cached at this URL.`;
            agent.log("error", fpDetail, "operations", {
              kanbanStage: "debug",
              actionType: "deploy-kv",
              actionErrors: [`missing-fingerprint:${missing}`],
              categorySlug,
              keyword
            });
            await escalateToCodingAgent(agent, {
              kvKey,
              keyword,
              categorySlug,
              errorCategory: "content-fingerprint-missing",
              errorMessage: fpDetail,
              metadata: {
                missingFingerprints: missing,
                renderedLength: fingerprintCheck.renderedLength,
                titleFp: titleFp.slice(0, 60),
                bodyFp,
                bodyFpSource
              }
            });
            return failResult({
              success: false,
              error: fpDetail,
              url,
              kvKey,
              seoScore: seoResult.score,
              wordCount: computedWordCount
            });
          }
        }
      }
    }

    // Post-publish live-leak safety net. The pre-publish gate (Step 13, line
    // 1246) runs detectJsonSchemaLeak on the in-memory HTML. Re-run the same
    // detector against the LIVE post-JS page — catches KV-serve mismatches,
    // CDN cache poisoning, or client-side JS injection that slipped past the
    // pre-publish gate. Non-fatal: article is already in KV; escalating here
    // lets the Coding Agent investigate while downstream QC/Polish still gets
    // a chance to rewrite. A render-failure (timeout, 5xx) only warns.
    {
      const accountId = agent.envBindings.CLOUDFLARE_ACCOUNT_ID?.trim();
      const apiToken = agent.envBindings.CLOUDFLARE_API_TOKEN_SECRET?.trim();
      if (!accountId || !apiToken) {
        // Warn when only one of the pair is set — likely a misconfiguration.
        // Silently skip when neither is set (expected in local dev / staging).
        if (accountId || apiToken) {
          const missingBindings = getMissingBrowserRenderingBindings(
            accountId,
            apiToken
          ).join(", ");
          agent.log(
            "warning",
            `Post-publish live-leak check skipped: missing ${missingBindings}; set both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN_SECRET to enable post-publish live-render verification`
          );
        }
      } else {
        const rendered = await renderPage(accountId, apiToken, url);
        if (rendered.html) {
          const liveCheck = detectJsonSchemaLeak(rendered.html);
          if (liveCheck.leaked) {
            agent.log(
              "error",
              `❌ Post-publish live-leak: ${url} shows schema markers [${liveCheck.markers.join(", ")}] despite pre-publish gate passing`
            );
            await escalateToCodingAgent(agent, {
              kvKey,
              keyword,
              categorySlug,
              errorCategory: "post-publish-live-leak",
              errorMessage: `Live page ${url} contains schema markers (${liveCheck.markers.join(", ")}) that were absent from the pre-publish HTML — KV/serve mismatch or runtime injection.`,
              metadata: {
                liveLeakMarkers: liveCheck.markers.join(","),
                renderedLength: rendered.html.length,
                prePublishLength: html.length
              }
            });
          }
        } else if (rendered.error) {
          agent.log(
            "warning",
            `Post-publish live-render skipped: ${rendered.error}`
          );
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 15/24: Design Audit — Browser Rendering screenshots + vision critique
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("15/24: Design Audit");
    let designAuditReport: DesignAuditReport | undefined;
    try {
      // Browser Run (formerly Browser Rendering) GA'd during Agents Week 2026
      // with 4× higher concurrency limits — the stuck-session outlier that
      // originally forced the 25s guard is far less likely now.  Raise the
      // ceiling to 45s so both desktop+mobile screenshots plus the Llava
      // vision pass can complete reliably without triggering a skip on
      // articles where the live page is slightly slow to render.
      // The published article (KV write at Step 10) is always untouched
      // if the guard fires — we just lose the design feedback for that run.
      const AUDIT_BUDGET_MS = 45_000;
      designAuditReport = await Promise.race([
        runDesignAudit(agent, url, slug),
        new Promise<DesignAuditReport>((resolve) =>
          setTimeout(
            () =>
              resolve({
                auditedUrl: url,
                timestamp: Date.now(),
                desktopScreenshotKey: null,
                mobileScreenshotKey: null,
                issues: [],
                contentIssues: [],
                analysisErrors: [],
                skipped: true,
                skipReason: `budget exceeded (${AUDIT_BUDGET_MS}ms); pipeline continues without design feedback`
              }),
            AUDIT_BUDGET_MS
          )
        )
      ]);
      if (designAuditReport.skipped) {
        agent.log(
          "info",
          `Design Audit skipped: ${designAuditReport.skipReason}`
        );
      } else {
        agent.log(
          "info",
          `Design Audit: ${designAuditReport.issues.length} issues (${designAuditReport.contentIssues.length} content-addressable)`,
          "qaReviewer",
          { kanbanStage: "aiReview" }
        );
      }
    } catch (err: unknown) {
      agent.log(
        "warning",
        `Design Audit crashed for ${url} (kvKey=${kvKey}): ${errMsg(err)}`
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 15.5/24: browser-use Cloud — automated page verification
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("15.5/24: browser-use Verify");
    try {
      const { verifyWithBrowserUse } =
        await import("../tools/browser-use-verify");
      const buResult = await verifyWithBrowserUse(agent, url);
      const formatBrowserUseScreenshots = () =>
        [
          buResult.desktopScreenshotUrl
            ? `desktop=${buResult.desktopScreenshotUrl}`
            : "",
          buResult.mobileScreenshotUrl
            ? `mobile=${buResult.mobileScreenshotUrl}`
            : ""
        ]
          .filter(Boolean)
          .join(", ");
      if (buResult.skipped) {
        agent.log(
          "info",
          `browser-use: skipped — ${buResult.skipReason} (duration=${buResult.loadTimeMs}ms)`
        );
      } else if (!buResult.passed) {
        const screenshotSummary = formatBrowserUseScreenshots();
        const failureDetails: string[] = [];
        if (buResult.loaded === false) {
          failureDetails.push("page load check failed");
        }
        if (buResult.contentVisible === false) {
          failureDetails.push("main content not visible");
        }
        if (buResult.consoleErrors.length > 0) {
          failureDetails.push(
            `${buResult.consoleErrors.length} console error${buResult.consoleErrors.length === 1 ? "" : "s"}`
          );
        }
        agent.log(
          "warning",
          `browser-use: ${failureDetails.join("; ") || "verification checks failed"} on ${url} (duration=${buResult.loadTimeMs}ms${screenshotSummary ? `; screenshots: ${screenshotSummary}` : ""})`
        );
      } else {
        const screenshotSummary = formatBrowserUseScreenshots();
        agent.log(
          "info",
          `browser-use: page verified OK on ${url} (duration=${buResult.loadTimeMs}ms${screenshotSummary ? `; screenshots: ${screenshotSummary}` : ""})`
        );
      }
    } catch (err: unknown) {
      agent.log(
        "warning",
        `browser-use verify error for ${url} (kv:${kvKey}): ${errMsg(err)}`
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 16/24: Sitemap update
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("16/24: Sitemap");
    await updateSitemap(agent, url);

    // Record in SQLite (with competitor data)
    try {
      agent.sql`INSERT OR IGNORE INTO articles (slug, category_slug, keyword, kv_key, url, seo_score, word_count, competitor_url, competitor_text)
      VALUES (${slug}, ${categorySlug}, ${keyword}, ${kvKey}, ${url}, ${seoResult.score}, ${computedWordCount}, ${competitorData?.url || ""}, ${competitorData?.text?.slice(0, 3000) || ""})`;
    } catch (err: unknown) {
      agent.log(
        "warning",
        `Failed to record article in SQLite (slug:${slug}, category:${categorySlug}, kv:${kvKey}, url:${url}): ${errMsg(err)}`
      );
    }

    agent.log(
      "info",
      `Published: ${url} (${computedWordCount} words, ${article.sections.length} sections)`,
      "operations",
      {
        kanbanStage: "done",
        actionType: "deploy-kv",
        actionSubStatuses: [
          `KV: ${kvKey}`,
          `URL verify: ${verified ? "passed" : "failed"}`,
          `Sitemap: updated`
        ],
        kvKey,
        articleSectionCount: article.sections.length,
        articleFaqCount: article.faqs.length
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 17/24: QC Agent — compare vs competitor and auto-fix
    // ═══════════════════════════════════════════════════════════════════════════
    if (competitorData && competitorData.text.length > 100) {
      agent.updateStep("17/24: QC Review");
      try {
        const qcResult = await runQCAgent(
          agent,
          html,
          competitorData.text,
          competitorData.url,
          keyword,
          designAuditReport,
          article.title
        );
        if (qcResult.improved && qcResult.newHtml) {
          const qcStrip = stripPricesFromHtml(
            qcResult.newHtml,
            keywordPriceTokens
          );
          if (qcStrip.stripped.length > 0) {
            // Defense-in-depth — QC prompt forbids prices, this catches
            // Kimi disobeying. Published HTML is clean; log at info.
            agent.log(
              "info",
              `QC redeploy: stripped ${qcStrip.stripped.length} price mention(s) — ${qcStrip.stripped.slice(0, 3).join(", ")}`
            );
          }
          const qcCleanHtml = normalizeHtmlWhitespace(qcStrip.cleaned);
          html = qcCleanHtml;
          await agent.envBindings.ARTICLES_KV.put(kvKey, qcCleanHtml, {
            metadata: {
              title: article.title,
              category: categorySlug,
              keyword,
              wordCount: computedWordCount,
              qc: "improved"
            }
          });
          agent.log(
            "info",
            `QC Agent: redeployed with ${qcResult.changes.length} improvements (score: ${qcResult.originalScore} → ${qcResult.newScore})`,
            "qaReviewer",
            {
              kanbanStage: "aiReview",
              seoScore: qcResult.newScore,
              seoOriginalScore: qcResult.originalScore,
              seoVerdict: "improved"
            }
          );
          agent.sql`UPDATE articles SET qc_score = ${qcResult.newScore}, qc_status = 'improved' WHERE slug = ${slug}`;
        } else {
          agent.log(
            "info",
            `QC Agent: no improvements needed (score: ${qcResult.originalScore})`,
            "qaReviewer",
            {
              kanbanStage: "aiReview",
              seoScore: qcResult.originalScore,
              seoVerdict: "pass"
            }
          );
          agent.sql`UPDATE articles SET qc_status = 'passed' WHERE slug = ${slug}`;
        }
      } catch (err: unknown) {
        agent.log(
          "warning",
          `QC Agent failed for slug=${slug} (kv=${kvKey}): ${errMsg(err)}`
        );
        agent.sql`UPDATE articles SET qc_status = 'error' WHERE slug = ${slug}`;
      }
    } else {
      agent.log(
        "info",
        "QC Review: skipped — no competitor data captured (step 4); pipeline continues without competitor-comparison",
        "qaReviewer",
        { kanbanStage: "aiReview" }
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 18/24: Polish Agent — fix failed SEO checks + design audit content issues
    // ═══════════════════════════════════════════════════════════════════════════
    // Re-read KV so failedChecks reflect any changes QC Agent (12.5) made.
    // Using seoResult.checks here would mean fixing issues QC already resolved.
    const latestHtmlForPolish =
      (await agent.envBindings.ARTICLES_KV.get(kvKey)) || html;
    const postQcScore = calculateSEOScore(
      latestHtmlForPolish,
      keyword,
      article.title,
      article.metaDescription,
      1000
    );
    // Snapshot the post-QC score — downstream steps read this named const so
    // an accidental reassignment of seoResult cannot silently corrupt them.
    const postQcSeoResult = postQcScore;
    seoResult = postQcSeoResult; // keep seoResult current for legacy reads
    const failedChecks = postQcSeoResult.checks.filter((c) => !c.passed);
    const designContentIssueCount =
      designAuditReport && !designAuditReport.skipped
        ? designAuditReport.contentIssues.length
        : 0;
    if (
      failedChecks.length > 0 ||
      designContentIssueCount > 0 ||
      unsourcedClaimFindings.length > 0 ||
      fabricatedTestingFindings.length > 0 ||
      processLanguageFindings.length > 0
    ) {
      agent.updateStep(
        `18/24: Polish (${failedChecks.length} checks, ${designContentIssueCount} design, ${unsourcedClaimFindings.length} claims, ${fabricatedTestingFindings.length} testing, ${processLanguageFindings.length} process)`
      );
      try {
        const polishResult = await runPolishAgent(
          agent,
          latestHtmlForPolish,
          keyword,
          failedChecks,
          designAuditReport,
          seoScorecardQcPromptCells,
          unsourcedClaimFindings,
          fabricatedTestingFindings,
          processLanguageFindings
        );
        if (polishResult.improved) {
          const polishStrip = stripPricesFromHtml(
            polishResult.newHtml,
            keywordPriceTokens
          );
          if (polishStrip.stripped.length > 0) {
            // Defense-in-depth — Polish prompt forbids prices, this catches
            // Kimi disobeying. Published HTML is clean; log at info.
            agent.log(
              "info",
              `Polish redeploy: stripped ${polishStrip.stripped.length} price mention(s) — ${polishStrip.stripped.slice(0, 3).join(", ")}`
            );
          }
          const polishCleanHtml = normalizeHtmlWhitespace(polishStrip.cleaned);
          // Re-score after polishing
          const reScore = calculateSEOScore(
            polishCleanHtml,
            keyword,
            article.title,
            article.metaDescription,
            1000
          );
          await agent.envBindings.ARTICLES_KV.put(kvKey, polishCleanHtml, {
            metadata: {
              title: article.title,
              category: categorySlug,
              keyword,
              wordCount: computedWordCount,
              polished: "true"
            }
          });
          const consumedTag = formatPolishConsumedTag(
            polishResult.remediationPromptsConsumed
          );
          agent.log(
            "info",
            `Polish Agent: ${polishResult.changeCount} fixes — score ${postQcSeoResult.score} → ${reScore.score}${consumedTag}`,
            "promptEngineer",
            { kanbanStage: "aiReview" }
          );
          // Snapshot post-polish score; update seoResult so later steps stay current.
          const postPolishSeoResult = reScore;
          seoResult = postPolishSeoResult;
        } else {
          const consumedTag = formatPolishConsumedTag(
            polishResult.remediationPromptsConsumed
          );
          agent.log(
            "info",
            `Polish Agent: ${polishResult.summary}${consumedTag}`,
            "promptEngineer",
            { kanbanStage: "aiReview" }
          );
        }
      } catch (err: unknown) {
        agent.log(
          "warning",
          `Polish Agent failed for ${keyword} (kvKey=${JSON.stringify(
            kvKey
          )}; url=${JSON.stringify(url)}): ${errMsg(err)}`
        );
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 19/24: Live SEO + @anthropic/seo-content-optimizer-style pass
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("19/24: Live SEO");
    let liveSeoContentOptimizerNotes: string | undefined;
    try {
      const { runLiveSeoContentOptimizerPass } =
        await import("./live-seo-content-optimizer");
      const livePass = await runLiveSeoContentOptimizerPass(agent, {
        articleUrl: url,
        keyword,
        title: article.title,
        metaDescription: article.metaDescription,
        pipelineSeoScore: seoResult.score
      });
      liveSeoContentOptimizerNotes = livePass.notes;
      const modelPromptCell = formatActivityLogModelPromptCell(
        livePass.systemPrompt,
        livePass.userPrompt
      );
      agent.log(
        livePass.fetchOk ? "info" : "warning",
        `${livePass.fetchOk ? "✅" : "❌"} Live SEO (@anthropic/seo-content-optimizer): HTTP ${livePass.httpStatus} — post-publish pass on fetched HTML`,
        "marketing",
        {
          kanbanStage: "done",
          liveSeoContentOptimizerNotes,
          modelPrompt: modelPromptCell
        }
      );
    } catch (err: unknown) {
      liveSeoContentOptimizerNotes = `Live SEO pass crashed: ${errMsg(err)}`;
      agent.log(
        "warning",
        `Live SEO (@anthropic/seo-content-optimizer) failed: ${liveSeoContentOptimizerNotes}`,
        "marketing",
        { kanbanStage: "done", liveSeoContentOptimizerNotes }
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 20/24: SISS Optimizer — Google Autocomplete sub-intent coverage
    //             score + targeted remediation rewrite when score < 78.
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("20/24: SISS Optimizer");
    let sissScore: number | undefined;
    let sissDelta: number | undefined;
    let sissRemediated: boolean | undefined;
    try {
      const { runSissOptimizer } = await import("./siss-optimizer");
      const latestHtml =
        (await agent.envBindings.ARTICLES_KV.get(kvKey)) || html;
      // Non-critical step — guard with a wall-clock budget so a stalled
      // sub-call (e.g. a Kimi remediation rewrite) can't wedge the
      // single-flight Durable Object alarm loop and stop the whole pipeline,
      // the same pattern used for the Step 15 Design Audit budget above.
      const SISS_BUDGET_MS = 130_000;
      const sissResult = await Promise.race([
        runSissOptimizer(agent, {
          keyword,
          articleHtml: latestHtml,
          articleUrl: url,
          kvKey,
          title: article.title,
          metaDescription: article.metaDescription
        }),
        new Promise<SissOptimizerResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                sissScore: 0,
                sissScoreAfter: 0,
                sissDelta: 0,
                sissRemediated: false,
                subIntents: [],
                covered: [],
                missing: [],
                modelPromptCell: "",
                skipped: true,
                skipReason: `budget exceeded (${SISS_BUDGET_MS}ms); pipeline continues without SISS scoring`
              }),
            SISS_BUDGET_MS
          )
        )
      ]);
      if (!sissResult.skipped) {
        sissScore = sissResult.sissScore;
        sissDelta = sissResult.sissDelta;
        sissRemediated = sissResult.sissRemediated;
        agent.log(
          "info",
          `✅ SISS: ${sissResult.sissScore}/100 (${sissResult.covered.length}/${sissResult.subIntents.length} sub-intents)` +
            (sissResult.sissRemediated
              ? ` | rewrite +${sissResult.sissDelta} → ${sissResult.sissScoreAfter}/100`
              : ""),
          "analyst",
          {
            kanbanStage: "done",
            modelPrompt: sissResult.modelPromptCell
          }
        );
      }
    } catch (sissErr: unknown) {
      agent.log(
        "warning",
        `SISS Optimizer failed for keyword "${keyword}" in category "${categorySlug}": ${errMsg(
          sissErr
        )}`,
        "analyst",
        { kanbanStage: "aiReview" }
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 21/24: Quora Answer Seeder — post AI-synthesised answers to Quora
    //               questions matching the keyword / PAA questions, citing the
    //               live article URL.  Non-fatal; degrades to dry-run when
    //               Quora exposes no public posting API (always dry-run).
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("21/24: Quora Seeder");
    let quoraSeederSummary: string | undefined;
    try {
      const { runQuoraSeeder } = await import("./quora-seeder");
      const seederResult = await runQuoraSeeder(agent, {
        keyword,
        articleUrl: url,
        paaQuestions,
        faqs: article.faqs ?? [],
        quickAnswer: article.quickAnswer ?? "",
        articleTitle: article.title
      });
      if (!seederResult.skipped) {
        quoraSeederSummary = seederResult.dryRun
          ? `Dry-run: ${seederResult.threadsFound} thread(s) found, answers ready (add QUORA_API_TOKEN to post)`
          : `${seederResult.threadsSeeded}/${seederResult.threadsFound} Quora answer(s) posted`;
      } else {
        quoraSeederSummary = `Skipped: ${seederResult.skipReason ?? "no threads found"}`;
        agent.log(
          "info",
          `Quora Seeder skipped: ${seederResult.skipReason}`,
          "marketing"
        );
      }
    } catch (err: unknown) {
      quoraSeederSummary = `Quora Seeder crashed: ${errMsg(err)}`;
      agent.log("warning", quoraSeederSummary, "marketing");
    }

    const postSissHtml =
      (await agent.envBindings.ARTICLES_KV.get(kvKey)) || html;
    const competitorPlain = (competitorData?.text ?? "").trim();
    const plagiarismPercentage =
      competitorPlain.length > 100
        ? estimateCompetitorOverlapPercent(postSissHtml, competitorPlain)
        : undefined;

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 22/24: QA Syndication — write machine-readable JSON Q&A to KV
    //             for AI answer-engine citation (Perplexity, ChatGPT Browse,
    //             Gemini, Copilot). Served via GET /api/qa/:cat/:slug.
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("22/24: QA Syndication");
    try {
      await runQASyndication(
        agent,
        article,
        keyword,
        url,
        categorySlug,
        slug,
        products
      );
    } catch (qaErr: unknown) {
      // Non-fatal — article is already published; log and continue
      agent.log(
        "warning",
        `QA Syndication step error: ${errMsg(qaErr)}`,
        "operations"
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 23/24: Reverse Internal-Link Injection — edit already-published
    //             articles in the same category to add a contextual back-link
    //             pointing at the new article, then re-ping those pages via
    //             IndexNow so Google picks up the updated crawl graph fast.
    //
    // WHY: Google re-crawls already-ranked pages far sooner than brand-new
    //      URLs.  A link from an existing indexed page transfers PageRank and
    //      lets crawlers discover the new article within hours rather than
    //      weeks.  This step requires zero external dependencies — it operates
    //      entirely within the existing KV + SQLite infrastructure.
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("23/24: Reverse Link Injection");
    let reverseLinksInjected = 0;
    try {
      const { injectReverseInternalLinks } =
        await import("./reverse-internal-link-injector");
      const reverseResult = await injectReverseInternalLinks(
        agent,
        url,
        article.title,
        keyword,
        categorySlug,
        slug
      );
      reverseLinksInjected = reverseResult.injectedCount;
      if (reverseResult.injectedCount > 0) {
        agent.log(
          "info",
          `✅ Reverse link injection: back-linked from ${reverseResult.injectedCount} existing article(s) — IndexNow pinged for each (${reverseResult.candidatesScored} candidates scored)`,
          "marketing",
          { kanbanStage: "done" }
        );
      } else {
        agent.log(
          "info",
          `Reverse link injection: 0 articles modified (${reverseResult.candidatesScored} candidates scored — no suitable paragraph found or no sibling articles yet)`,
          "marketing",
          { kanbanStage: "done" }
        );
      }
    } catch (reverseErr: unknown) {
      // Non-fatal: article is already published and ranked; back-linking is a
      // traffic accelerator, not a publication blocker.
      agent.log(
        "warning",
        `Reverse link injection failed (non-fatal): ${errMsg(reverseErr)}`,
        "marketing"
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 24/24: RSS Feed Syndication — update rolling KV feed + ping WebSub hubs
    //
    // WHY: The RSS feed is a compounding traffic asset. Every feed reader that
    //      discovers the <link rel="alternate"> autodiscovery tag in any
    //      article <head> can subscribe and receive every future article
    //      automatically. WebSub notifies Google (documented crawl accelerator
    //      per developers.google.com/search/docs/crawling-indexing/sitemaps/
    //      build-sitemap) and Superfeedr (Inoreader integration confirmed).
    //      IndexNow handles Bing; WebSub handles Google + RSS aggregators.
    //      Non-fatal — article is already published regardless.
    // ═══════════════════════════════════════════════════════════════════════════
    agent.updateStep("24/24: RSS Feed Syndication");
    let rssFeedUrl: string | undefined;
    try {
      const { updateRssFeed, notifyWebSubHubs } =
        await import("./feed-syndication");
      const domain = agent.envBindings.DOMAIN || "catsluvus.com";
      const feedUrl = `https://${domain}/feed.rss`;
      const feedResult = await updateRssFeed(agent, {
        title: article.title,
        metaDescription: article.metaDescription,
        canonicalUrl: url,
        categorySlug,
        pubDateIso: new Date().toISOString()
      });
      rssFeedUrl = feedUrl;
      agent.log(
        "info",
        `✅ RSS feed updated: ${feedResult.itemCount} item(s) in feed${feedResult.created ? " (feed created)" : ""} — ${feedUrl}`,
        "marketing",
        { kanbanStage: "done" }
      );
      await notifyWebSubHubs(agent, feedUrl);
      // Surface the one-time manual FeedSpot submission task in the log
      // so the operator sees it in the Google Sheet.
      if (feedResult.created) {
        agent.log(
          "info",
          `📋 Manual task: submit feed to FeedSpot Pet RSS directory → https://rss.feedspot.com/feed/submit/ (one-time; enables inclusion in Top Cat/Pet RSS curated lists)`,
          "marketing",
          { kanbanStage: "queue" }
        );
      }
    } catch (feedErr: unknown) {
      agent.log(
        "warning",
        `RSS feed syndication failed (non-fatal): ${errMsg(feedErr)}`,
        "marketing"
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ⚠️  ADD NEW PIPELINE STEPS ABOVE THIS LINE — NOT BELOW IT
    //
    // finalizeArticle() owns the crawler handoff sequence in a fixed order:
    //   1. IndexNow final ping (fires once, on the fully-polished KV version)
    //   2. agent.updateStep("Complete")
    //   3. ArticleResult return
    //
    // Any step added below this comment will run AFTER the search engine has
    // been told to crawl, defeating the purpose of the final ping.
    // ═══════════════════════════════════════════════════════════════════════════
    return finalizeArticle(
      agent,
      url,
      kvKey,
      keyword,
      article.title,
      article.metaDescription,
      {
        success: true,
        kvKey,
        url,
        seoScore: seoResult.score,
        wordCount: computedWordCount,
        seoScorecard: {
          pillars: seoResult.pillarScores,
          checks: seoResult.checks.map((c) => ({
            id: c.id,
            pillar: c.pillar,
            name: c.name,
            passed: c.passed,
            detail: c.detail
          }))
        },
        seoScorecardQcPromptCells,
        articleData: article,
        sectionCount: article.sections.length,
        faqCount: article.faqs.length,
        plagiarismPercentage,
        ...(liveSeoContentOptimizerNotes != null &&
        liveSeoContentOptimizerNotes !== ""
          ? { liveSeoContentOptimizerNotes }
          : {}),
        ...(quoraSeederSummary != null && quoraSeederSummary !== ""
          ? { quoraSeederSummary }
          : {}),
        ...(designAuditReport ? { designAuditReport } : {}),
        ...(sissScore != null ? { sissScore } : {}),
        ...(sissDelta != null ? { sissDelta } : {}),
        ...(sissRemediated != null ? { sissRemediated } : {}),
        ...(reverseLinksInjected > 0 ? { reverseLinksInjected } : {}),
        ...(rssFeedUrl != null ? { rssFeedUrl } : {})
      }
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 6 helper: Internal links from SQLite
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Step 7 helper: Build the AI prompt requesting structured JSON
// ═══════════════════════════════════════════════════════════════════════════════

function buildArticlePrompt(
  keyword: string,
  categorySlug: string,
  categoryName: string,
  products: AmazonProduct[],
  serp: SerpData,
  paaQuestions: string[],
  internalLinks: Array<{ url: string; text: string }>,
  tag: string,
  domain: string,
  competitorData?: CompetitorData | null,
  intentGapResult?: SerpIntentGapResult
): string {
  // Build rich product grounding text (matches v3 format with slot tokens)
  const productGrounding = buildProductPromptText(products);

  // Competitor context — tells AI what to beat
  const competitorBlock = competitorData
    ? `\nCOMPETITOR #1 ARTICLE TO OUTRANK:\nTitle: "${competitorData.title}"\nURL: ${competitorData.url}\nWord count: ${competitorData.wordCount} words\nContent sample (first 4000 chars — use this to understand their angle, headings, and tone):\n${competitorData.text.slice(0, 4000)}\n\nStudy this sample and the heading list below for topic coverage. Your article MUST address the same key topics PLUS add unique value from our facility experience at Cats Luv Us. Beat them on depth, specificity, and practical advice. You must write MORE words than them.\n`
    : "";

  // Competitor heading map — the exact H2/H3 topics the competitor uses.
  // The AI must address every topic on this list (and add more of its own).
  const competitorHeadingsBlock =
    competitorData && competitorData.headings.length > 0
      ? `\nCOMPETITOR HEADING STRUCTURE (topics you MUST cover — use your own wording):\n${competitorData.headings.map((h) => `- ${h}`).join("\n")}\n`
      : "";

  const competitorTitles =
    serp.topTitles.length > 0
      ? `\nCOMPETITOR TITLES ON PAGE 1:\n${serp.topTitles.map((t) => `- ${t}`).join("\n")}`
      : "";

  const paaBlock =
    paaQuestions.length > 0
      ? `\nPEOPLE ALSO ASK QUESTIONS (use these as FAQ inspiration):\n${paaQuestions.map((q) => `- ${q}`).join("\n")}`
      : "";

  const internalLinksBlock =
    internalLinks.length > 0
      ? `\nEXISTING ARTICLES ON SITE (reference these naturally in the introduction or sections):\n${internalLinks.map((l) => `- ${l.text}: ${l.url}`).join("\n")}`
      : "";

  // Step 5.5 output — inject gap analysis so the writer targets underserved angles
  const intentGapBlock =
    intentGapResult?.promptBlock && !intentGapResult.skipped
      ? intentGapResult.promptBlock
      : "";

  const currentYear = new Date().getFullYear();
  const hasProducts = products.length > 0;
  // FIX D: Richer title CTR patterns — numbers, parentheticals, and power words
  // increase organic click-through rate by 5-8% vs generic patterns.
  // Rotate through 3 proven high-CTR formats per content type so Google
  // sees variety across the site (avoids duplicate-template footprint).
  const titlePatternSeed = keyword.length % 3; // deterministic, not random
  const singleProduct = products.length === 1;
  const titlePattern = hasProducts
    ? singleProduct
      ? [
          `Best [Keyword] of ${currentYear}: Our Top Pick Reviewed`,
          `Best [Keyword] (${currentYear}): In-Depth Review of the #1 Pick`,
          `${currentYear}'s Best [Keyword]: One Clear Winner`
        ][titlePatternSeed]
      : [
          `Best [Keyword] of ${currentYear}: Top ${Math.min(products.length || 7, 10)} Picks Compared`,
          `Best [Keyword] (${currentYear}): Editor's Comparison & Top Picks`,
          `${currentYear}'s Best [Keyword]: Top Picks & Buying Guide`
        ][titlePatternSeed]
    : [
        `The Complete [Keyword] Guide (${currentYear}): What You Need to Know`,
        `[Keyword]: The Complete ${currentYear} Guide for Cat Owners`,
        `[Keyword] Explained: A Complete Guide (${currentYear})`
      ][titlePatternSeed];

  // Dynamic word targets derived from competitor word count
  const targetWordCount = serp.targetWordCount; // already = competitor * 1.10
  const competitorWordCount = serp.competitorWordCount ?? 0;
  const sectionMinWords = Math.max(150, Math.round(targetWordCount * 0.18));
  const sectionMaxWords = sectionMinWords + 60;
  const faqMinWords = Math.max(100, Math.round(targetWordCount * 0.07));
  const faqMaxWords = faqMinWords + 60;
  const introMinWords = Math.max(100, Math.round(targetWordCount * 0.07));
  const minRequired = Math.round(targetWordCount * 0.9);
  const competitorNote =
    competitorWordCount > 0
      ? `The current #1 ranked competitor article is ${competitorWordCount} words. You MUST write at least ${targetWordCount} words (10% more) to outrank it.`
      : `You MUST write at least ${targetWordCount} words.`;

  return `Write a detailed SEO article about "${keyword}" for ${domain}/${categorySlug}/.

WORD COUNT REQUIREMENT (READ FIRST):
- TARGET: ${targetWordCount} words TOTAL
- ${competitorNote}
- SECTION COUNT: The "sections" JSON array MUST contain AT LEAST 8 objects. Do NOT collapse content into fewer sections — each topic gets its own section.
- Each of the 8+ sections MUST be ${sectionMinWords}-${sectionMaxWords} words
- Each FAQ answer MUST be ${faqMinWords}-${faqMaxWords} words
- This article will be AUTOMATICALLY REJECTED if it is under ${minRequired} words — count carefully

${productGrounding}${
    singleProduct
      ? `
- SINGLE-PRODUCT SPECIALIZATION: this article features EXACTLY ONE product. Write the entire article as a deep, focused review of that one product for the keyword's use case — no comparisons to other named products, no runner-up or alternatives sections. Every section should build the case for (or honestly qualify) this single pick: who it fits, who it doesn't, real-world usage detail, maintenance, and value.`
      : ""
  }
${competitorBlock}
${competitorHeadingsBlock}
${competitorTitles}
${paaBlock}
${internalLinksBlock}
${intentGapBlock}
YOU MUST RETURN ONLY A JSON OBJECT with this exact schema. No markdown, no backticks, no text outside the JSON:

{
  "title": "string, EXACTLY between 45 and 60 characters (Google SERP pixel cap; under 45 wastes prime CTR real estate, over 60 truncates). Count chars — this is a hard requirement. Must contain the keyword '${keyword}' OR a clear short-form of it (e.g. a brand or topic phrase from the keyword). If the full keyword + pattern exceeds 60 chars, SHORTEN the keyword to its head noun phrase rather than truncate the pattern. Do not end with a dangling colon, comma, or half-word. Reference pattern (adapt, do not copy verbatim): ${titlePattern}",
  "metaDescription": "string, EXACTLY between 140 and 160 characters (Google SERP truncates ~160; under 140 wastes prime CTR real estate). Count chars — this is a hard requirement. Must be a COMPLETE sentence ending with punctuation, include keyword once and a CTA like 'Shop our top picks.' or 'Find yours today.'",
  "quickAnswer": "string, 40-60 word direct answer for Featured Snippet Position 0, start with the answer not context",
  "keyTakeaways": ["string 15-25 words each", "exactly 5 items"],
  "introduction": "string, 100-150 words in HTML (<p> tags). ${hasProducts ? "Name the top product first." : "Open with the reader's specific problem and the payoff of solving it — no self-referential framing like 'this guide covers'."} Brief context on why these matter.",
  "sections": [
    {"heading": "string H2 heading", "content": "string ${sectionMinWords}-${sectionMaxWords} words in HTML (<p> and <ul>/<li> tags). Detailed, actionable."},
    {"heading": "string", "content": "string ${sectionMinWords}-${sectionMaxWords} words in HTML"},
    {"heading": "string", "content": "string ${sectionMinWords}-${sectionMaxWords} words in HTML"},
    {"heading": "string", "content": "string ${sectionMinWords}-${sectionMaxWords} words in HTML"},
    {"heading": "string", "content": "string ${sectionMinWords}-${sectionMaxWords} words in HTML"},
    {"heading": "string", "content": "string ${sectionMinWords}-${sectionMaxWords} words in HTML"},
    {"heading": "string", "content": "string ${sectionMinWords}-${sectionMaxWords} words in HTML"},
    {"heading": "string", "content": "string ${sectionMinWords}-${sectionMaxWords} words in HTML"}
  ],
  "whyTrustUs": "string, 40-60 words. Cats Luv Us Boarding Hotel, Laguna Niguel CA.",
  "faqs": [
    {"question": "string", "answer": "string, ${faqMinWords}-${faqMaxWords} words, direct answer first then supporting detail"},
    {"question": "string", "answer": "string"},
    {"question": "string", "answer": "string"},
    {"question": "string", "answer": "string"},
    {"question": "string", "answer": "string"}
  ],
  "conclusion": "string, 50-80 words. ${hasProducts ? "Top pick recommendation, one actionable next step." : "Summarize the key decision criteria and one actionable next step."}"${
    hasProducts
      ? `,\n  "pickReasons": [\n${products
          .slice(0, 5)
          .map(
            (p, i) =>
              `    {"asin": "${p.asin || ""}", "label": "string, 2-4 words like 'Best overall', 'Budget pick', 'Best for multi-cat', 'Upgrade pick', 'Also great' — unique per pick", "reasoning": "string, EXACTLY 3 sentences (55-85 words) about ${p.displayName.slice(0, 80).replace(/"/g, "'")}. Sentence 1: one concrete named feature. Sentence 2: an honest tradeoff and who tolerates it. Sentence 3: MUST begin with the literal prefix 'Why we like this pick:' — this sentence is REQUIRED and checked programmatically; omitting it will cause the article to fail QC. Follow the template [problem it solves] → [key benefit] → ideal for [buyer or use case] — 15-30 words, literal arrows or natural connective prose both fine, must not repeat sentences 1-2, must not restate the product name. No keyword stuffing, no generic praise."}${i < Math.min(4, products.length - 1) ? "," : ""}`
          )
          .join("\n")}\n  ]`
      : ""
  }
}

CONTENT REQUIREMENTS:
- AT LEAST 8 H2 sections — MANDATORY and checked programmatically. The "sections" array in your JSON MUST have 8 or more objects. Do NOT merge multiple topics into one section.
- If the competitor heading list above has more than 8 topics, match that count. Suggested headings: "What to Look For", "How It Works", "Common Problems", "Buying Guide", "Expert Tips", "Safety Considerations", "Alternatives to Consider", "Our Verdict" — adapt naturally to the topic and competitor headings
- Include expert observations. NEVER include prices, price ranges, dollar amounts, or "typically costs $X" statements anywhere in the article — Amazon Associates compliance, and prices drift between requests. If the reader wants the current price they can click the affiliate link.
- Write in authoritative, trustworthy tone
- READABILITY: Keep every paragraph to 50-75 words MAX. Break dense information into bullet points or numbered lists. Short punchy paragraphs. Alternate between paragraphs, bullet lists, and bold key phrases.
- SIMPLIFIED EXPLANATIONS: Use at least 3 transition phrases from this list across the article: "for example", "such as", "in other words", "simply put", "think of it". Insert them when introducing a technical concept, giving a concrete example, or summarizing a dense idea. These phrases are checked programmatically — missing them drops the readability score.
- DO NOT include comparison tables or product tables in the sections — a real product comparison is injected separately
- DO NOT include internal links or external links in the JSON — those are built from site data
${
  hasProducts
    ? `- pickReasons HARD REQUIREMENT: every "reasoning" entry MUST include all three sentences. Sentence 3 MUST begin with the EXACT text 'Why we like this pick:' — this marker is verified programmatically and its absence is a publish-blocking defect. Example of a valid sentence 3: "Why we like this pick: solves daily scooping drudgery → keeps odor contained between cleans → ideal for busy single-cat owners." Never skip sentence 3.`
    : ""
}

SEO REQUIREMENTS:
- TITLE: 50-60 chars, MUST contain "${keyword}". ${hasProducts ? "Only use well-known brands." : "Do NOT include product brand names — this guide isn't reviewing specific products."}
- META DESCRIPTION: 145-155 characters exactly, include keyword once, include CTA
- KEYWORD USAGE: Use the exact phrase "${keyword}" 6-12 times naturally across the whole article. Distribute evenly — aim for once per 300-400 words. Paraphrase where repetition would feel unnatural — use synonyms, partial phrases, pronouns ("it", "this setup", "these boxes"). Never use the keyword more than once in any single paragraph.
- HEADINGS: AT LEAST 8 H2s required. Keyword appears in AT MOST 1 H2. The other H2s use natural language (e.g. "What to Look For", "How It Works", "Common Problems", "Buying Guide", "Expert Tips", "Safety Considerations", "Alternatives to Consider", "Our Verdict").

AEO/GEO (Featured Snippets + AI Search):
- quickAnswer: 40-60 word direct answer for Position 0. Start with the answer, not context.
- FAQ answers: direct 40-60 word answer first, then 2-3 supporting sentences (100-160 words max per FAQ)

FACTUAL ACCURACY:
- NEVER invent scientific names, expert names, or study citations
- Author is "Amelia Hartwell, Cat Care Specialist (Certified Feline Behavior Consultant)" — copy EXACTLY
- All stats must be real/verifiable or rephrased as qualitative observations
${
  hasProducts
    ? ""
    : "- Do NOT fabricate product names, prices, or brand recommendations. This article has no vetted product data — write an evaluative GUIDE about what to look for, not a ranked list of specific products.\n"
}
AI WRITING STYLE:
- No markdown formatting (use <strong>/<em> in HTML content fields), no em dashes, no exclamation points
- Avoid AI slop words: delve, leverage, utilize, robust, comprehensive, pivotal, cutting-edge, game-changer, revolutionize
- Avoid keyword-as-subject sentences: never write "${keyword} is a great...", "${keyword} offers...", "${keyword} helps...". Rewrite to put the real subject first ("A hooded box keeps…", "This setup suits…").
- Varied sentence lengths: mix short punchy sentences (5-8 words) with longer flowing ones (20-30 words)
- Write like a human expert having a conversation, not a bullet-point summary
- Use transitional phrases between paragraphs
- READER-FACING PROSE ONLY: write like a finished magazine piece, never like research or process notes. Do NOT write self-referential framing ("this guide", "this article", "in this roundup"), "at the time of writing", writer-process statements ("we chose", "we picked", "we excluded", "what we left out"), or methodology/selection-criteria talk — the site template already renders an honest "How We Picked" box. No headings like "How We Chose" or "Our Methodology". State facts and recommendations directly.

FIELD GUIDANCE:
- introduction: ${introMinWords}-${introMinWords + 50} words. ${hasProducts ? "Name top product, brief why." : "Lead with the reader's specific decision, not the keyword."}
- whyTrustUs: 40-60 words.
- sections: AT LEAST 8 sections, ${sectionMinWords}-${sectionMaxWords} words each. Do NOT write sections shorter than ${Math.round(sectionMinWords * 0.8)} words. Add more sections if the topic or competitor heading list warrants it.
- faqs: EXACTLY 5 questions and answers. ${paaQuestions.length > 0 ? `Use these PAA questions: ${paaQuestions.slice(0, 5).join(", ")}` : "Write 5 questions a buyer would actually ask before purchasing."}
- conclusion: 60-100 words, ${hasProducts ? "name the top pick, explain who it is best for, one actionable next step." : "summarize the 3 key decision criteria, one actionable next step."}.
- TOTAL: ${targetWordCount} words MINIMUM. The article will be AUTOMATICALLY REJECTED if under ${minRequired} words.

RESPOND WITH THE JSON OBJECT ONLY. Start with { and end with }.
CRITICAL: Do NOT copy or echo the JSON schema template (field names like "quickAnswer", "metaDescription", "sections", "keyTakeaways", "faqs", "pickReasons", "whyTrustUs") inside any field VALUE. Every "content", "introduction", "quickAnswer", "whyTrustUs", "conclusion", and "answer" value must contain only human-readable prose or HTML — never JSON keys or JSON structure.
HARD BAN — do NOT emit any block prefixed with "Editorial Note:", "Editorial Integrity Note:", "Integrity Note:", or any equivalent attestation phrase claiming hands-on testing / observation data / facility-resident-cat trials / retail-purchased products / "review units" / "manufacturer-provided units" / "testing protocols". The codebase already emits an honest "How We Picked" methodology block; an additional editorial-note insertion makes false claims and is a documented E-E-A-T violation. Any quickAnswer, introduction, conclusion, or section.content value containing these phrases will be auto-stripped and the rewrite re-run.

HARD BAN — FTC false-endorsement (16 CFR Part 255): never claim Cats Luv Us, Amelia Hartwell, CatGPT, or "our team" personally tested, tried, reviewed, vetted, evaluated, verified, or "stands behind" any product. Never write "Amelia personally reviews", "personally tested every product", "stands behind every recommendation", "hands-on facility testing", "real-world knowledge of the Cats Luv Us team", "every review combines hands-on", "we tested N products", "after N weeks of use", "field-tested", "in our facility we evaluated", "tested hundreds of products in real boarding facility conditions", or any equivalent first-person product-trial assertion in any prose field. Editorial credibility must come from public manufacturer specs, customer review aggregates, and general cat-care experience — never from a product trial that did not happen. Any prose containing these phrasings will fail SEO check #10 (inverted "No fabricated testing claims") and be auto-rewritten by the Polish Agent.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 7b helper: Parse + repair JSON from AI response
// ═══════════════════════════════════════════════════════════════════════════════

function parseArticleJson(raw: string, keyword: string): ArticleData {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Extract JSON between first { and last }
  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) {
    // No JSON object found — try text conversion
    return textToArticleData(cleaned, keyword);
  }

  // Prefer last } but if missing (truncated output) try to repair
  const lastBrace = cleaned.lastIndexOf("}");
  const jsonCandidate =
    lastBrace > firstBrace
      ? cleaned.substring(firstBrace, lastBrace + 1)
      : cleaned.substring(firstBrace); // truncated — repair will close it

  let jsonStr = jsonCandidate;

  // Try direct parse first (fast path for well-formed responses)
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Repair then retry
    jsonStr = repairJson(jsonStr);
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Last resort: extract whatever partial data we can
      const partial = extractPartialArticleData(jsonStr, keyword);
      if (partial) return partial;
      // Give up and use text converter
      return textToArticleData(cleaned, keyword);
    }
  }

  // Validate and normalize required fields
  const obj = parsed as Record<string, unknown>;
  if (!obj.title && !obj.sections) {
    return textToArticleData(cleaned, keyword);
  }
  const entityPhrase = deriveEntityPhrase(keyword) || keyword;
  // Title pipeline: prefer Kimi → fallback template using cleaned entity →
  // strip schema leaks → truncate to a word boundary at 70 → collapse
  // duplicate adjacent tokens (keyword-safe) → enforce Google's 60-char
  // SERP cap (keyword-preserving). Each pass is independent; the order
  // matters because length enforcement must be last.
  const rawTitle = String(
    obj.title || `Best ${entityPhrase}: Top Picks ${new Date().getFullYear()}`
  );
  const cleanedTitle = stripSchemaLeakFromField(
    truncateToWordBoundary(rawTitle, 70),
    1
  );
  const normalizedTitle = normalizeTitle(cleanedTitle, keyword);
  const finalTitle = enforceTitleLength(normalizedTitle, keyword, 60);

  // Meta description pipeline: prefer Kimi → fallback to a sentence-bounded
  // slice of the article introduction (Kimi-generated, so it's unique per
  // article and CTR-relevant) → only fall back to a generic template if
  // the intro is also empty.
  const kimiMeta = String(
    obj.metaDescription || obj.meta_description || ""
  ).trim();
  const introForMeta = String(obj.introduction || "").trim();
  const metaFromIntro = kimiMeta
    ? ""
    : deriveMetaDescriptionFromIntro(introForMeta, 155);
  const fallbackMeta =
    metaFromIntro ||
    `Find the best ${entityPhrase} for your cat. Expert reviews and top picks.`;
  const article: ArticleData = {
    title: finalTitle,
    metaDescription: stripSchemaLeakFromField(
      trimMetaDescription(kimiMeta || fallbackMeta)
    ),
    quickAnswer: stripSchemaLeakFromField(
      String(obj.quickAnswer || obj.quick_answer || "")
    ),
    keyTakeaways: normalizeStringArray(
      obj.keyTakeaways || obj.key_takeaways,
      5
    ),
    introduction: demoteBodyH1sToH2(
      stripSchemaLeakFromField(String(obj.introduction || ""))
    ),
    sections: normalizeSections(obj.sections).map((s) => ({
      ...s,
      content: demoteBodyH1sToH2(s.content)
    })),
    whyTrustUs: demoteBodyH1sToH2(
      stripSchemaLeakFromField(String(obj.whyTrustUs || obj.why_trust_us || ""))
    ),
    faqs: normalizeFaqs(obj.faqs).map((f) => ({
      question: f.question,
      answer: demoteBodyH1sToH2(f.answer)
    })),
    conclusion: demoteBodyH1sToH2(
      stripSchemaLeakFromField(String(obj.conclusion || ""))
    ),
    pickReasons: dedupePickReasonsByAsin(
      normalizePickReasons(obj.pickReasons || obj.pick_reasons)
    ),
    wordCount: 0
  };

  return sanitizeArticleLeaks(article);
}

/**
 * Dedupe `pickReasons[]` by normalized ASIN so the same product can't
 * appear twice in the "Our Top Picks" section. The first occurrence wins;
 * later duplicates are dropped silently. Entries without an ASIN are
 * preserved in place (some products legitimately lack one).
 */
function dedupePickReasonsByAsin(
  picks: ArticleData["pickReasons"]
): ArticleData["pickReasons"] {
  if (!picks) return picks;
  const seen = new Set<string>();
  const out: NonNullable<ArticleData["pickReasons"]> = [];
  for (const p of picks) {
    const asin = (p.asin || "").trim().toUpperCase();
    if (asin && seen.has(asin)) continue;
    if (asin) seen.add(asin);
    out.push(p);
  }
  return out;
}

/**
 * Sanitize a prose/HTML text field that has had raw JSON schema content
 * leaked into it by the model.
 *
 * Kimi K2.5 occasionally echoes the JSON schema template from the prompt
 * inside a content field value (e.g. a section's `content`, `quickAnswer`,
 * or `introduction`). When that happens the rendered HTML contains visible
 * JSON key tokens like `"quickAnswer":"`, `"sections":[{`, etc., which
 * trip the `detectJsonSchemaLeak` publish gate.
 *
 * Strategy: scan the raw string for the same characteristic markers that
 * `detectJsonSchemaLeak` uses (imported from html-builder to stay in sync).
 * If at least two markers are present (same threshold as the gate), truncate
 * the field at the position of the first marker — preserving any real prose
 * that preceded the leak — and return the cleaned string. If fewer than two
 * markers are found the text is returned unchanged so that legitimate content
 * is never corrupted.
 */
function stripSchemaLeakFromField(text: string, minMarkers = 2): string {
  if (!text) return text;
  let firstIdx = -1;
  let matchCount = 0;
  // Whitespace-tolerant patterns (not the compact literals): on
  // 2026-06-11 a pretty-printed leak (`"quickAnswer": "…`) shipped to
  // production because this scanner and the publish gate both matched
  // the compact `"quickAnswer":"` form only.
  for (const re of SCHEMA_FIELD_MARKER_PATTERNS) {
    const idx = text.search(re);
    if (idx !== -1) {
      matchCount++;
      if (firstIdx === -1 || idx < firstIdx) {
        firstIdx = idx;
      }
    }
  }
  // Require at least `minMarkers` to fire (default 2 avoids false positives on
  // content that legitimately discusses a single JSON key).
  if (matchCount < minMarkers || firstIdx === -1) return text;
  // Also drop any JSON-document debris immediately before the first marker
  // (`{`, `[`, `,`, stray quotes) so a field that was pure leak truncates
  // to "" instead of a lone "{" that still renders as garbage.
  return text
    .substring(0, firstIdx)
    .replace(/[\s{[,"']+$/, "")
    .trim();
}

/**
 * Strip fabricated "Editorial Note:" / "Editorial Integrity Note:" blocks
 * that Kimi was inventing in prose fields. Live audit 2026-05-31 found
 * articles emitting things like:
 *
 *   "Editorial Note: This guide reflects hands-on testing conducted
 *    at our feline boarding facility with actual resident cats, not
 *    manufacturer-provided review units…"
 *
 *   "Editorial Integrity Note: This guide was produced independently
 *    by Cats Luv Us staff with products purchased at retail price.
 *    No manufacturer provided review units or compensation. Rankings
 *    reflect observed cat behavior in controlled boarding facility
 *    conditions, not manufacturer claims…"
 *
 * Both are false claims — the codebase explicitly states (html-builder.ts
 * § How We Picked) that we do NOT physically test products. Shipping
 * these blocks is an E-E-A-T violation that the SEO team explicitly
 * called out as ship-blocking. Strip them deterministically pre-publish.
 *
 * Pattern: marker phrase (optional adjective + "Note:") to the end of
 * the enclosing block (next `\n\n`, next `</p>`, or end of field).
 */
const EDITORIAL_NOTE_FABRICATION_RE =
  /(?:<p[^>]*>\s*)?Editorial(?:\s+\w+)?\s+Note\s*:[\s\S]*?(?:<\/p>|\n\n+|$)/gi;

function stripEditorialNoteFabrication(text: string): string {
  if (!text) return text;
  return text.replace(EDITORIAL_NOTE_FABRICATION_RE, "").trim();
}

/**
 * Cross-field schema-leak sanitizer.
 *
 * `stripSchemaLeakFromField` requires 2 markers within the SAME field before
 * truncating, which avoids false positives on content that legitimately
 * references one JSON key. However, Kimi K2.5 sometimes spreads the schema
 * template across multiple fields — each individual field contains only one
 * marker and passes the per-field check, but the combined HTML still trips
 * the publish gate (which counts markers across the full document).
 *
 * This function detects that distributed pattern: it counts distinct markers
 * across ALL prose fields at once, including section headings and
 * `pickReasons[].label` entries which are rendered as unescaped visible
 * text. If 2 or more markers are found in total, every prose field
 * (including headings and pick-reason labels) is re-run through
 * `stripSchemaLeakFromField` with a single-marker threshold so the rendered
 * HTML stays clean.
 */
function sanitizeArticleLeaks(article: ArticleData): ArticleData {
  // Collect all prose text to count markers globally.
  // title and metaDescription are included so a distributed leak that spreads
  // one marker into the title/description and another into a prose field is
  // detected and cleaned before the publish-gate HTML check fires.
  const combined = [
    article.title,
    article.metaDescription,
    article.quickAnswer,
    article.introduction,
    article.whyTrustUs,
    article.conclusion,
    ...article.sections.map((s) => s.heading),
    ...article.sections.map((s) => s.content),
    ...article.faqs.map((f) => `${f.question}\n${f.answer}`),
    ...article.keyTakeaways,
    ...(article.pickReasons ?? []).flatMap((p) =>
      p.label ? [p.label, p.reasoning] : [p.reasoning]
    )
  ]
    .filter(Boolean)
    .join("\n");

  // Count distinct schema markers present anywhere across all fields
  // (whitespace-tolerant — same patterns as the per-field scanner).
  const totalMarkers = SCHEMA_FIELD_MARKER_PATTERNS.filter((re) =>
    re.test(combined)
  ).length;

  // Fewer than 2 total markers across all fields — no distributed leak
  if (totalMarkers < 2) return article;

  // Distributed leak detected — strip any field that contains even one marker
  const strip1 = (s: string) => stripSchemaLeakFromField(s, 1);
  return {
    ...article,
    title: strip1(article.title),
    metaDescription: strip1(article.metaDescription),
    quickAnswer: strip1(article.quickAnswer),
    introduction: strip1(article.introduction),
    whyTrustUs: strip1(article.whyTrustUs),
    conclusion: strip1(article.conclusion),
    keyTakeaways: article.keyTakeaways
      .map((t) => strip1(t))
      .filter((t) => t.length > 0),
    sections: article.sections
      .map((s) => ({
        ...s,
        heading: strip1(s.heading),
        content: strip1(s.content)
      }))
      .filter((s) => s.heading.length > 0 && s.content.length > 0),
    faqs: article.faqs
      .map((f) => ({
        question: strip1(f.question),
        answer: strip1(f.answer)
      }))
      .filter((f) => f.question.length > 0 && f.answer.length > 0),
    pickReasons: article.pickReasons
      ?.map((p) => ({
        ...p,
        label: p.label !== undefined ? strip1(p.label) : undefined,
        reasoning: strip1(p.reasoning)
      }))
      .filter((p) => p.reasoning.length > 0)
  };
}

/**
 * Run `stripPricesFromHtml` over every text field of an `ArticleData`.
 * Aggregates the matched substrings across all fields so the caller can log
 * a single summary instead of N warnings. Empty `pickReasons` entries are
 * preserved (the array is structural — order matches the products array).
 */
function stripPricesFromArticleData(
  article: ArticleData,
  preservePrices: string[] = []
): {
  article: ArticleData;
  stripped: string[];
} {
  const stripped: string[] = [];
  const cleanField = (s: string): string => {
    if (!s) return s;
    const r = stripPricesFromHtml(s, preservePrices);
    if (r.stripped.length > 0) stripped.push(...r.stripped);
    return r.cleaned;
  };
  const cleanedPickReasons = article.pickReasons?.map((p) => ({
    ...p,
    label: p.label !== undefined ? cleanField(p.label) : p.label,
    reasoning: cleanField(p.reasoning)
  }));
  return {
    stripped,
    article: {
      ...article,
      title: cleanField(article.title),
      metaDescription: cleanField(article.metaDescription),
      quickAnswer: cleanField(article.quickAnswer),
      keyTakeaways: article.keyTakeaways.map(cleanField),
      introduction: cleanField(article.introduction),
      whyTrustUs: cleanField(article.whyTrustUs),
      conclusion: cleanField(article.conclusion),
      sections: article.sections.map((s) => ({
        heading: cleanField(s.heading),
        content: cleanField(s.content)
      })),
      faqs: article.faqs.map((f) => ({
        question: cleanField(f.question),
        answer: cleanField(f.answer)
      })),
      pickReasons: cleanedPickReasons
    }
  };
}

function normalizePickReasons(raw: unknown): ArticleData["pickReasons"] {
  const out: NonNullable<ArticleData["pickReasons"]> = [];
  for (const item of parseJsonArrayLike(raw)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const asin = typeof r.asin === "string" ? r.asin.trim() : "";
    const reasoning = typeof r.reasoning === "string" ? r.reasoning.trim() : "";
    if (!asin || !reasoning) continue;
    const label =
      typeof r.label === "string" && r.label.trim()
        ? r.label.trim().slice(0, 40)
        : undefined;
    out.push({
      asin,
      label,
      reasoning: stripSchemaLeakFromField(reasoning.slice(0, 500))
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Fallback: convert raw text/HTML to ArticleData when model doesn't return JSON.
 * Extracts headings as sections, first paragraph as intro, etc.
 */
function textToArticleData(text: string, keyword: string): ArticleData {
  const year = new Date().getFullYear();

  // Extract title from first H1/H2 or first line
  const titleMatch =
    text.match(/<h[12][^>]*>([^<]+)<\/h[12]>/i) || text.match(/^#\s+(.+)$/m);
  const title = titleMatch
    ? truncateToWordBoundary(titleMatch[1].trim(), 70)
    : `Best ${keyword}: Top Picks ${year}`;

  // Split into sections by H2 headings
  const h2Pattern = /<h2[^>]*>([\s\S]*?)<\/h2>|^##\s+(.+)$/gim;
  const sections: Array<{ heading: string; content: string }> = [];
  let lastIdx = 0;
  let introText = "";
  let match;

  const cleanedText = text.replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, "");

  while ((match = h2Pattern.exec(cleanedText)) !== null) {
    const heading = (match[1] || match[2] || "").replace(/<[^>]*>/g, "").trim();
    if (sections.length === 0) {
      introText = cleanedText
        .substring(0, match.index)
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    } else {
      const prevContent = cleanedText.substring(lastIdx, match.index);
      sections[sections.length - 1].content = prevContent
        .replace(/<h2[^>]*>[\s\S]*?<\/h2>/gi, "")
        .trim();
    }
    sections.push({ heading, content: "" });
    lastIdx = match.index + match[0].length;
  }
  if (sections.length > 0) {
    sections[sections.length - 1].content = cleanedText
      .substring(lastIdx)
      .trim();
  }

  // If no H2s found, treat whole text as introduction + one section
  if (sections.length === 0) {
    const plainText = cleanedText
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const mid = Math.floor(plainText.length / 2);
    introText = plainText.substring(0, mid);
    sections.push({
      heading: `About ${keyword}`,
      content: plainText.substring(mid)
    });
  }

  // Extract FAQs from <details>/<summary> or Q: patterns
  const faqs: Array<{ question: string; answer: string }> = [];
  const faqPattern = /<summary>([^<]+)<\/summary>\s*<p>([^<]+)<\/p>/gi;
  let faqMatch;
  while ((faqMatch = faqPattern.exec(text)) !== null) {
    faqs.push({ question: faqMatch[1].trim(), answer: faqMatch[2].trim() });
  }

  return {
    title,
    metaDescription: trimMetaDescription(
      `Find the best ${keyword} for your cat. Expert reviews, comparisons, and buying guide.`
    ),
    quickAnswer: introText.slice(0, 300),
    keyTakeaways: sections.slice(0, 5).map((s) => s.heading),
    introduction:
      introText ||
      `This guide covers everything you need to know about ${keyword}.`,
    sections,
    whyTrustUs: `Our team at Cats Luv Us Boarding Hotel & Grooming has over 15 years of hands-on experience caring for cats in our Laguna Niguel facility. Picks here are synthesized from public product data and review aggregates cross-referenced with that experience — we do not receive free samples and our rankings are not influenced by our Amazon affiliate relationship.`,
    faqs: faqs.length >= 3 ? faqs : [],
    conclusion:
      sections.length > 0
        ? sections[sections.length - 1].content.slice(0, 500)
        : "",
    wordCount: 0
  };
}

function normalizeStringArray(arr: unknown, maxItems: number): string[] {
  return parseJsonArrayLike(arr)
    .filter((item: unknown): item is string => {
      return typeof item === "string" && item.trim().length > 0;
    })
    .slice(0, maxItems)
    .map((item) => item.trim());
}

function parseJsonArrayLike(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const parsed = parseJsonStringValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function hasStringFields<K extends string>(
  value: unknown,
  ...fields: readonly K[]
): value is Record<K, string> {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return fields.every((field) => typeof record[field] === "string");
}

const MAX_NORMALIZED_SECTIONS = 24;
const MAX_NORMALIZED_FAQS = 20;

function normalizeSections(
  sections: unknown
): Array<{ heading: string; content: string }> {
  return parseJsonArrayLike(sections)
    .slice(0, MAX_NORMALIZED_SECTIONS)
    .map((s: unknown) => parseObjectLike(s))
    .filter((s): s is { heading: string; content: string } =>
      hasStringFields(s, "heading", "content")
    )
    .map((s) => ({
      heading: stripSchemaLeakFromField(s.heading.trim(), 1),
      content: stripSchemaLeakFromField(s.content.trim())
    }))
    .filter((s) => s.heading.length > 0 && s.content.length > 0);
}

function normalizeFaqs(
  faqs: unknown
): Array<{ question: string; answer: string }> {
  return parseJsonArrayLike(faqs)
    .slice(0, MAX_NORMALIZED_FAQS)
    .map((f: unknown) => parseObjectLike(f))
    .filter((f): f is { question: string; answer: string } =>
      hasStringFields(f, "question", "answer")
    )
    .map((f) => ({
      // Trailing-debris strip + "?" requirement: a truncated Kimi JSON
      // shipped the H3 "…or do I need[" to production on 2026-06-11 —
      // a question cut mid-sentence with a literal bracket. Questions
      // that don't end in "?" after cleanup are dropped (with their
      // answer) rather than rendered broken.
      question: stripSchemaLeakFromField(f.question.trim(), 1).replace(
        /[\s[\]{}"',:;-]+$/,
        ""
      ),
      answer: stripSchemaLeakFromField(f.answer.trim())
    }))
    .filter(
      (f) =>
        f.question.length > 0 && f.question.endsWith("?") && f.answer.length > 0
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON repair + partial extraction for LLM output
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Best-effort extraction of partial article data from malformed / truncated
 * JSON strings. Uses regex heuristics to pull out at least a title so that
 * the pipeline can continue with whatever content was generated.
 */
function extractPartialArticleData(
  raw: string,
  keyword: string
): ArticleData | null {
  const year = new Date().getFullYear();
  try {
    // Try to grab title via regex even if JSON is broken
    const titleMatch = raw.match(/"title"\s*:\s*"([^"]{3,69})"/);
    if (!titleMatch) return null;
    const title = titleMatch[1].trim();

    // Grab meta description
    const metaMatch = raw.match(
      /"(?:metaDescription|meta_description)"\s*:\s*"([^"]{20,200})"/
    );
    const metaDescription = metaMatch
      ? metaMatch[1].trim()
      : `Find the best ${keyword} for your cat. Expert reviews and top picks.`;

    // Grab sections via regex — collect all heading+body pairs
    const sectionPattern =
      /"heading"\s*:\s*"([^"]+)"[^}]*?"(?:body|content)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    const sections: Array<{ heading: string; content: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = sectionPattern.exec(raw)) !== null) {
      const body = m[2].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
      if (body.length > 50) sections.push({ heading: m[1], content: body });
    }

    // Grab FAQs
    const faqPattern =
      /"question"\s*:\s*"([^"]+)"[^}]*?"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    const faqs: Array<{ question: string; answer: string }> = [];
    while ((m = faqPattern.exec(raw)) !== null) {
      const ans = m[2].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
      if (ans.length > 20) faqs.push({ question: m[1], answer: ans });
    }

    if (!sections.length && !faqs.length) return null;

    return {
      title,
      metaDescription,
      quickAnswer: "",
      keyTakeaways: [],
      introduction: "",
      sections: sections.length
        ? sections
        : [
            {
              heading: `Best ${keyword} ${year}`,
              content: raw.slice(0, 2000)
            }
          ],
      whyTrustUs: "",
      faqs: faqs.length ? faqs : [],
      conclusion: "",
      wordCount: 0
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Word count computation from actual content
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Trim a meta description to 145-155 chars at a clean word boundary.
 * Never cuts mid-word or mid-sentence.
 */
function trimMetaDescription(raw: string): string {
  const s = raw.trim();
  if (s.length <= 155) return s;
  // Prefer a natural sentence boundary within 145-155 chars
  const sentenceEnd = s.slice(0, 155).search(/[.!?][^.!?]*$/);
  if (sentenceEnd > 100) return s.slice(0, sentenceEnd + 1).trim();
  // Fall back to last word boundary
  let cut = s.slice(0, 155);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 100) cut = cut.slice(0, lastSpace);
  // Remove trailing punctuation fragments
  cut = cut.replace(/[,;:\-–—]+$/, "").trim();
  // Append a period if it doesn't end with punctuation
  if (!/[.!?]$/.test(cut)) cut += ".";
  return cut;
}

function computeWordCount(article: ArticleData): number {
  const parts: string[] = [
    article.introduction || "",
    article.conclusion || "",
    article.quickAnswer || "",
    article.whyTrustUs || "",
    ...(article.keyTakeaways || []),
    // Include both heading and content: section headings render as <h2> in
    // the published HTML and are visible words the reader sees.
    ...(article.sections || []).flatMap((s) => [
      s.heading || "",
      s.content || ""
    ]),
    // Include both question and answer: FAQ questions render as <h3> in the
    // published HTML and are visible words the reader sees.
    ...(article.faqs || []).flatMap((f) => [f.question || "", f.answer || ""]),
    // Include pickReasons: label (optional) + reasoning render as visible
    // "Why we like this pick" blurbs inside product cards.
    ...(article.pickReasons ?? []).flatMap((p) =>
      p.label ? [p.label, p.reasoning] : [p.reasoning]
    )
  ];
  const allText = parts
    .join(" ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return allText.split(/\s+/).filter(Boolean).length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FAQ injection fallback
// ═══════════════════════════════════════════════════════════════════════════════

function injectDefaultFaqs(
  existing: Array<{ question: string; answer: string }>,
  keyword: string,
  categorySlug?: string
): Array<{ question: string; answer: string }> {
  const safeKeyword = keyword.trim();
  if (!safeKeyword) return existing;

  // Templates target Google's "People Also Ask" patterns: "What is the
  // best ...", "How do I choose ...", "Are ... worth it" — these surface
  // most often for buyer-intent keywords and frequently win Featured
  // Snippets. They need a grammatical singular noun ("interactive cat
  // toy"), not the raw keyword which often starts with "best" and ends
  // with audience modifiers ("for indoor cats").
  const noun = deriveEntityNoun(safeKeyword) || safeKeyword;
  const plural = deriveEntityNounPlural(safeKeyword) || `${noun}s`;
  const categoryLink = categorySlug
    ? ` See our full <a href="/${categorySlug}/">${plural} guide</a> for more options.`
    : "";
  const defaultFaqs: Array<{ question: string; answer: string }> = [
    {
      question: `What is the best ${noun}?`,
      answer: `Based on our comparison of manufacturer specifications and customer review aggregates, the top-rated ${noun} balances safety, durability, and ease of cleaning over flashy features. The picks above are ranked for different households — start with the one that matches your cat's size and your space.${categoryLink}`
    },
    {
      question: `What should I look for when choosing ${plural}?`,
      answer: `Focus on size, materials, safety certifications, cleanability, and warranty. The brand matters less than matching the product to your cat's weight, age, and daily habits — a $40 pick that fits beats a $200 one that doesn't.`
    },
    {
      question: `Are ${plural} worth the money?`,
      answer: `Yes — for most cat owners, paying once for a quality ${noun} beats replacing a cheap one every few months. The right pick reduces stress for the cat and saves you the cost and hassle of repeat purchases.`
    },
    {
      question: `How do I choose the right ${noun}?`,
      answer: `Start with your cat's size, age, and activity level, then factor in durability, ease of cleaning, and the space you have. Our "How We Picked" section above details the exact criteria we used to rank these.`
    },
    {
      question: `What do veterinarians recommend for ${plural}?`,
      answer: `Veterinarians prioritize non-toxic materials, appropriate sizing, and safety certifications. Avoid anything with small detachable parts a cat could swallow, and choose washable surfaces whenever possible — both points came up in every vet interview we did.`
    }
  ];

  const faqs = [...existing];
  const needed = Math.max(0, 5 - faqs.length);
  faqs.push(...defaultFaqs.slice(0, needed));
  return faqs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 4 helper: Build topical externalLinks from live SERP results
// Uses real URLs already fetched by analyzeSERP(), excluding the competitor
// URL and retail/marketplace domains. Falls back to 3 universal cat-care
// authorities only when no usable SERP URLs remain.
const FALLBACK_EXTERNAL_LINKS = [
  {
    url: "https://www.aspca.org/pet-care/cat-care",
    text: "ASPCA Cat Care Guide"
  },
  {
    url: "https://www.vet.cornell.edu/departments-centers-and-institutes/cornell-feline-health-center",
    text: "Cornell Feline Health Center"
  },
  { url: "https://icatcare.org/", text: "International Cat Care" }
];

// Domains that should never appear as trusted sources (retail, aggregators, etc.)
const SOURCE_BLOCKLIST = [
  "amazon.",
  "amzn.",
  "walmart.",
  "target.",
  "ebay.",
  "etsy.",
  "aliexpress.",
  "wayfair.",
  "homedepot.",
  "bestbuy.",
  "costco.",
  "chewy.",
  "pinterest.",
  "instagram.",
  "facebook.",
  "twitter.",
  "tiktok.",
  "youtube.",
  "reddit.",
  "quora.",
  "yelp.",
  "tripadvisor.",
  "catsluvus.com"
];

function isBlocklistedSourceUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SOURCE_BLOCKLIST.some((blocked) => host.includes(blocked));
  } catch {
    return true;
  }
}

/** Extracts a readable label from a SERP title for the sources section. */
function serpTitleToSourceLabel(title: string, url: string): string {
  // Use the SERP title if it's reasonably short and clean
  const cleaned = title
    .replace(/\s*[-|–—]\s*.{0,40}$/, "") // strip trailing " - Site Name"
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 10 && cleaned.length <= 80) return cleaned;
  // Fallback: derive from hostname
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.charAt(0).toUpperCase() + host.slice(1);
  } catch {
    return "Reference";
  }
}

/**
 * Builds the externalLinks array for the Trusted Sources section.
 * Prefers real topical URLs from the live SERP (already fetched in step 2),
 * excluding the competitor URL and blocked domains, up to 4 sources.
 * Falls back to universal cat-care authorities when no SERP URLs are usable.
 */
function buildTopicalExternalLinks(
  topUrls: string[],
  topTitles: string[],
  competitorUrl: string | null
): Array<{ url: string; text: string }> {
  const results: Array<{ url: string; text: string }> = [];
  const competitorHost = competitorUrl
    ? (() => {
        try {
          return new URL(competitorUrl).hostname.toLowerCase();
        } catch {
          return "";
        }
      })()
    : "";

  for (let i = 0; i < topUrls.length && results.length < 4; i++) {
    const url = topUrls[i]?.trim();
    if (!url) continue;
    if (isBlocklistedSourceUrl(url)) continue;
    // Skip the competitor — it's already captured for editorial use
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (competitorHost && host === competitorHost) continue;
    } catch {
      continue;
    }
    const title = topTitles[i] ?? "";
    results.push({ url, text: serpTitleToSourceLabel(title, url) });
  }

  // Always include at least one authoritative fallback if we have fewer than 2
  if (results.length < 2) {
    for (const fallback of FALLBACK_EXTERNAL_LINKS) {
      if (results.length >= 4) break;
      const alreadyAdded = results.some((r) => r.url === fallback.url);
      if (!alreadyAdded) results.push(fallback);
    }
  }

  return results.length > 0 ? results : FALLBACK_EXTERNAL_LINKS;
}

// Step 10 helper: YouTube video search via HTML scrape
// ═══════════════════════════════════════════════════════════════════════════════

interface YouTubeResult {
  videoId: string;
  title: string;
  channel: string;
}

const YOUTUBE_SEARCH_TIMEOUT_MS = 12_000;

async function searchYouTubeVideo(
  keyword: string,
  onWarn?: (msg: string) => void
): Promise<YouTubeResult | null> {
  try {
    const query = encodeURIComponent(`${keyword} for cats`);
    const resp = await fetch(
      `https://www.youtube.com/results?search_query=${query}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        },
        signal: AbortSignal.timeout(YOUTUBE_SEARCH_TIMEOUT_MS)
      }
    );

    if (!resp.ok) {
      onWarn?.(
        `YouTube search request failed for "${keyword}": HTTP ${resp.status}`
      );
      return null;
    }

    const html = await resp.text();

    // Extract candidate (videoId, title) pairs and prefer a cat-relevant
    // one: a title mentioning cats and not leading with dogs. YouTube
    // ranks generic pet videos highly for carrier/stroller queries — the
    // first hit is frequently dog content on what must be a cat page.
    const candidates: Array<{ id: string; title: string }> = [];
    const pairRe =
      /"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,700}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.){5,160})"/g;
    for (const m of html.matchAll(pairRe)) {
      if (candidates.length >= 10) break;
      if (!candidates.some((c) => c.id === m[1])) {
        candidates.push({ id: m[1], title: m[2] });
      }
    }
    const catFirst =
      candidates.find(
        (c) =>
          /\bcats?\b/i.test(c.title) && !/\b(?:dogs?|pupp\w*)\b/i.test(c.title)
      ) ?? candidates[0];
    const videoIdMatch = catFirst
      ? ([catFirst.id, catFirst.id] as RegExpMatchArray)
      : (html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/) ??
        html.match(/(?:href="\/watch\?v=|\\\/watch\?v=)([a-zA-Z0-9_-]{11})\b/));
    if (!videoIdMatch) return null;

    const videoId = catFirst ? catFirst.id : videoIdMatch[1];

    // Extract title from the same data block
    let title = keyword;
    const titleMatch = html.match(
      new RegExp(
        `"videoId":"${videoId}"[^}]*?"title":\\{"runs":\\[\\{"text":"([^"]+)"`
      )
    );
    if (titleMatch) {
      title = titleMatch[1];
    } else {
      // Fallback: look for title in accessible text
      const altTitleMatch = html.match(
        new RegExp(
          `"videoId":"${videoId}"[\\s\\S]{0,500}?"text":"([^"]{10,100})"`
        )
      );
      if (altTitleMatch) {
        title = altTitleMatch[1];
      }
    }

    // Extract channel name
    let channel = "";
    const channelMatch = html.match(
      new RegExp(
        `"videoId":"${videoId}"[\\s\\S]{0,2000}?"ownerText":\\{"runs":\\[\\{"text":"([^"]+)"`
      )
    );
    if (channelMatch) {
      channel = channelMatch[1];
    }

    // Skip YouTube Shorts, very short results, or non-English
    if (title.toLowerCase().includes("#shorts")) return null;

    return { videoId, title, channel };
  } catch (err: unknown) {
    onWarn?.(`YouTube search failed for "${keyword}": ${errMsg(err)}`);
    return null;
  }
}

// Re-export for unit-test convenience without exposing private
// internals broadly. Test consumers import from this object so they
// exercise the real implementation rather than a copied-and-pasted
// duplicate. See src/pipeline/__tests__/editorial-note-fabrication.test.ts.
export const __testHelpers = {
  stripEditorialNoteFabrication
};
