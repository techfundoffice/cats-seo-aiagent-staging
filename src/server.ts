import { Agent, routeAgentRequest, callable } from "agents";
import { generateText, stepCountIs, type ToolSet } from "ai";
import {
  getKimiModel,
  getKimiProviderOptions,
  setRotatedOpenRouterKey
} from "./pipeline/kimi-model";
import {
  escalateToCodingAgent,
  isDurableObjectResetError,
  maybeEscalateParserError
} from "./pipeline/escalate-to-claude";
import { runDefectEval } from "./pipeline/defect-eval-runner";
import { GoogleSheetsDirectClient } from "./pipeline/google-sheets-direct";
import { runObserverTick } from "./pipeline/observer-agent";
import { runLiveQualityProbe } from "./pipeline/live-quality-probe";
import { runTopSellerScoutSweep } from "./pipeline/top-seller-scout";
import { classifyUserAgent } from "./pipeline/prod-publish";
import {
  isCodebaseSearchEnabled,
  searchCodebase,
  type CodebaseSearchEnv
} from "./lib/codebase-search";
import {
  aggregateOpenAiCalls,
  formatUsdCompact,
  parseMilvusActivityMsg,
  parseOpenAiActivityMsg
} from "./pipeline/infra-activity-monitor";
import {
  formatBreakdownOneLine,
  summarizeFailureBreakdown
} from "./pipeline/failure-breakdown";
import { runEditorialAgent } from "./pipeline/editorial-agent";
import { loggedFetch } from "./pipeline/api-logger";
import {
  errMsg,
  getEnvBinding,
  keywordToSlug,
  normalizeSingleLine,
  redactSecrets
} from "./pipeline/http-utils";
import { appendToRingBuffer } from "./pipeline/ring-buffer";
import { createArticleResponseHeaders } from "./article-response";
import { wrapWithSiteChrome } from "./pipeline/site-chrome";
import {
  getMissingBrowserRenderingBindings,
  renderPage
} from "./tools/browser-rendering";
import {
  ACTIVITY_LOG_AGENT_CONTEXT_MD_LOGICAL_INDEX,
  ACTIVITY_LOG_AGENT_CONTEXT_MD_URL,
  ACTIVITY_LOG_AGENT_STATUS_LOGICAL_INDEX,
  ACTIVITY_LOG_AGENTS_SKILL_LOGICAL_INDEX,
  ACTIVITY_LOG_ARTICLE_URL_LOGICAL_INDEX,
  ACTIVITY_LOG_CATEGORY_LOGICAL_INDEX,
  ACTIVITY_LOG_COMPETITOR_URL_LOGICAL_INDEX,
  ACTIVITY_LOG_DASHBOARD_URL,
  ACTIVITY_LOG_DASHBOARD_URL_LOGICAL_INDEX,
  ACTIVITY_LOG_DO_CLASS_LOGICAL_INDEX,
  ACTIVITY_LOG_ARTICLE_BACKED_UP_TO_GITHUB_LOGICAL_INDEX,
  ACTIVITY_LOG_ERROR_MESSAGE_LOGICAL_INDEX,
  ACTIVITY_LOG_ERROR_REMEDIATION_PROMPT_LOGICAL_INDEX,
  ACTIVITY_LOG_KEYWORD_LOGICAL_INDEX,
  ACTIVITY_LOG_LEVEL_LOGICAL_INDEX,
  ACTIVITY_LOG_MESSAGE_LOGICAL_INDEX,
  ACTIVITY_LOG_MESSAGE_PASS_OR_FAIL_LOGICAL_INDEX,
  ACTIVITY_LOG_MCP_TOOL_LOGICAL_INDEX,
  ACTIVITY_LOG_MODEL_PROMPT_LOGICAL_INDEX,
  ACTIVITY_LOG_PAGE_HTTP_LOGICAL_INDEX,
  ACTIVITY_LOG_PLAGIARISM_PERCENT_LOGICAL_INDEX,
  ACTIVITY_LOG_PUBLISHED_PENDING_LOGICAL_INDEX,
  ACTIVITY_LOG_SEO_CHECK_BASE_LOGICAL_INDEX,
  ACTIVITY_LOG_SEO_CHECK_COUNT,
  ACTIVITY_LOG_SEO_CONTENT_OPTIMIZER_LOGICAL_INDEX,
  ACTIVITY_LOG_SISS_SCORE_LOGICAL_INDEX,
  ACTIVITY_LOG_SISS_DELTA_LOGICAL_INDEX,
  ACTIVITY_LOG_QUORA_SEEDER_LOGICAL_INDEX,
  ACTIVITY_LOG_REVERSE_LINKS_INJECTED_LOGICAL_INDEX,
  ACTIVITY_LOG_RSS_FEED_URL_LOGICAL_INDEX,
  ACTIVITY_LOG_SEO_SCORE_LOGICAL_INDEX,
  ACTIVITY_LOG_SHEET_COLUMN_STEP_HEADER,
  ACTIVITY_LOG_SHEET_HEADER_ERROR_MESSAGE,
  ACTIVITY_LOG_SHEET_HEADER_ERROR_REMEDIATION_PROMPT,
  ACTIVITY_LOG_SHEET_HEADER_ARTICLE_BACKED_UP_TO_GITHUB,
  ACTIVITY_LOG_SHEET_HEADER_PROMPT,
  ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT,
  ACTIVITY_LOG_SHEET_TAB_NAME as SHEET_TAB_NAME,
  buildActivityLogSheetCanonicalHeaderTitles,
  formatActivityLogAgentskillCell,
  formatActivityLogModelPromptCell,
  formatActivityLogMessagePassOrFail,
  formatActivityLogPublishedPendingCell,
  formatActivityLogSheetKeyword,
  getActivityLogSheetColumnLegendLines,
  sheetColumnIndex1BasedToA1Letters,
  truncateActivityLogSheetPromptCell,
  type AgentRole
} from "./activityLogSheetColumns";
import {
  activityLogUniqueCanonicalTitlesMissingFromHeader,
  extractFirstRowFromComposioValuesResult,
  findPhysicalColumnIndexForCanonicalTitle,
  identityActivityLogColumnPermutation,
  isActivityLogColumnPermutationValid,
  parseComposioSheetValuesGrid,
  permuteActivityLogLogicalRowToPhysical,
  resolveActivityLogColumnPermutation
} from "./activityLogSheetLayout";
import { applyAgentFillers, type PipelineContext } from "./agentColumnFillers";
import { probeUrlHttpStatus } from "./articleUrlHttpStatus";
import { emitAgentDebugLog, normalizeDebugSessionId } from "./agentDebugEmit";
import {
  isActivityLogErrorLevel,
  isActivityLogWarningLevel,
  normalizeActivityLogLevel
} from "./activityLogLevels";
import {
  SCOUT_KEYWORD_ROI_FORMULA_AVG_COMMISSION,
  SCOUT_KEYWORD_ROI_FORMULA_COMMISSION_POTENTIAL,
  SCOUT_KEYWORD_ROI_FORMULA_RELATIVE_DEMAND,
  SCOUT_KEYWORD_ROI_HEADER_ROW,
  SCOUT_KEYWORD_ROI_SHEET_LAYOUT_VERSION,
  SCOUT_KEYWORD_ROI_SHEET_TAB_NAME,
  fetchGoogleSpreadsheetSheetTitles,
  quoteScoutKeywordRoiSheetTab
} from "./scoutKeywordRoiSheet";
import {
  activityLogLevelsQualifyForErrorRemediation,
  generateActivityLogErrorRemediationCell
} from "./pipeline/activity-log-error-remediation";
import { filterObjectArrayEntries, parseObjectLike } from "./objectLike";
import { createDesignAuditTools } from "./tools";
import { handleSkillFetchBatch } from "./skills/consumer";
import { handleMcpRequest } from "./skills/mcp";
import { runCrawlTick } from "./skills/producer";
import { handleSkillsRoute, isSkillsRoute } from "./skills/routes";
import type { SkillFetchJob } from "./skills/schema";
import type { AnalyticsTickResult } from "./pipeline/analytics-tick";
import { applyArticleCssFixes } from "./pipeline/patch-css";

export type ActivityLogEntry = {
  timeDate: string;
  timeTime: string;
  level: string;
  msg: string;
  /** Canonical article URL when in scope, else empty string. */
  articleUrl: string;
  /**
   * Sheet column H: real keyword when known; else `ERROR` or the scout
   * sentinel from `formatActivityLogSheetKeyword` when none resolves.
   */
  keyword: string;
  /**
   * Sheet column I: category slug captured at log time (not live
   * `state.currentCategory`).
   */
  categorySlug: string;
  /**
   * Sheet column P: competitor URL for this row — same as the active article’s
   * captured competitor while generating (`state.currentCompetitorUrl`), with
   * optional override from the log message when it mentions a competitor URL.
   */
  competitorUrl: string;
  /** Parsed from message when present (sheet column Q). */
  seoScore: number | "";
  /**
   * Final article vs competitor overlap (0–100), from log context when set
   * (sheet column after article outputs; header `Plagiarism Percentage`). Omitted on older log rows.
   */
  plagiarismPercentage?: number | "";
  /**
   * Live-URL post-publish SEO notes (`@anthropic/seo-content-optimizer`-style pass;
   * sheet column beside plagiarism %).
   */
  liveSeoContentOptimizerNotes?: string;
  /**
   * Step 16 SISS Optimizer score (0–100): Google Autocomplete sub-intent
   * coverage score written to the `SISS Score` sheet column (default AK).
   * Omitted when the step was skipped.
   */
  sissScore?: number;
  /**
   * Step 16 SISS Optimizer delta: improvement in SISS score after
   * remediation rewrite, written to the `SISS Delta` sheet column (default AL).
   * 0 when no rewrite was triggered; omitted when the step was skipped.
   */
  sissDelta?: number;
  /**
   * Step 16.5 Quora Seeder summary; written to the
   * `quora seeder` sheet column (default AL).
   * Omitted when seeder skipped or no PAA questions available.
   */
  quoraSeederSummary?: string;
  /**
   * Step 24 Reverse Link Injection count: number of already-published sibling
   * articles that received a contextual back-link to the new article.
   */
  reverseLinksInjected?: number;
  /**
   * Step 24 RSS feed canonical URL updated during feed syndication (e.g.
   * `https://catsluvus.com/feed.rss`); omitted when syndication was skipped.
   */
  rssFeedUrl?: string;
  /**
   * Prefix **Article Backed Up To Github** cell: short outcome from
   * `publishArticleToGitHub` on **Published** rows (`skipped`, PR URL, or error).
   */
  articleBackedUpToGithub?: string;
  /** Monotonic backend log reference (Google Sheet column B; stable across trim). */
  logRef: number;
  /**
   * Google Sheet column **Step #** (E): pipeline numerator (+ optional letter)
   * from `updateStep` (e.g. `1/15: …` → `1`, `5b/15: …` → `5b`), or
   * `Complete`, or **`0`** when idle / no numbered pipeline step.
   */
  stepNumber: string;
  /** Agent role active when this entry was created (for column fillers). */
  activeRole?: AgentRole;
  /**
   * Full `updateStep` label when known (e.g. `5/15: AI Writing`); used with
   * **Step #** to populate Agentskill.sh (role + skill slug).
   */
  pipelineStepLabel?: string;
  /** Pipeline context for agent column fillers (GitHub / Kanban block). */
  pipelineContext?: PipelineContext;
  /**
   * Sheet column CA (`MCP Tool`): tool names from MCP / AI SDK calls when logged
   * (e.g. `search`, `execute`); otherwise blank.
   */
  mcpTool?: string;
  /**
   * Trailing SEO scorecard columns (default CB–FW): `1` = check passed, `0` =
   * failed, when `lastSeoScorecard` had 100 checks at `log()` time; omitted or
   * shorter when no snapshot (sheet cells blank).
   */
  seoCheckCells?: readonly (0 | 1)[];
  /**
   * Parallel to `seoCheckCells`: when score is 0, full `modelPrompt`-style cell
   * (`SYSTEM` + `USER` via `formatActivityLogModelPromptCell`) for a follow-up
   * remediation `generateText`; `null`/omitted leaves the prompt cell blank.
   */
  seoCheckQcPromptCells?: readonly (string | null)[];
  /**
   * Prefix **Error message** cell: short Workers AI summary for warning/error
   * rows; omitted or blank for info.
   */
  errorMessage?: string;
  /**
   * Prefix **Error remediation prompt** cell: full SYSTEM+USER Workers AI cell;
   * omitted or blank for info.
   */
  errorRemediationPrompt?: string;
};

/**
 * Durable Object SQLite caps total serialized state; `activityLog` rows can embed
 * huge SEO QC prompt arrays and pipeline blobs. The sheet mirror queue keeps full
 * payloads; persisted state should stay small.
 */
// A keyword that fails (or is swept back from a stuck 'generating' state)
// this many times moves to a terminal 'abandoned' status instead of
// resurrecting to 'pending' forever — see the retry_count migration and its
// call sites in onStart(), the autonomousLoop failure branch, and
// /api/admin/retry.
const MAX_KEYWORD_RETRIES = 3;

// Wall-clock safety net around the whole generateArticle() call in
// autonomousLoop. scheduleEvery(300, "autonomousLoop") can't re-enter while
// this tick is still awaiting — a single unbounded await anywhere in the
// 24-step pipeline (a fetch/generateText call with no per-call timeout)
// wedges the DO's single-flight alarm loop forever, silently, since a hung
// promise never reaches a catch block or the escalation system (see
// #14123, which bounded the one known hang site but not the general case).
// This is the last-resort net for the *next* one: past this budget we stop
// awaiting and let the loop continue: the abandoned call may still resolve
// in the background but its result is ignored.
const ARTICLE_PIPELINE_TIMEOUT_MS = 15 * 60 * 1000;

// Same wall-clock safety-net pattern as ARTICLE_PIPELINE_TIMEOUT_MS above,
// applied to the Top Seller Scout's daily sweep tick. 10 minutes is
// generous for 18 fast PA-API calls + KV/SQL bookkeeping — this tick does
// NOT run the full article-generation pipeline itself (see
// top-seller-scout.ts), it only fetches/diffs/enqueues, so it should
// finish in well under a minute during normal operation.
const TOP_SELLER_SCOUT_TIMEOUT_MS = 10 * 60 * 1000;

const ACTIVITY_LOG_STATE_MAX_MSG_CHARS = 1000;
const ACTIVITY_LOG_STATE_MAX_ERROR_REMEDIATION_CHARS = 8000;
const ACTIVITY_LOG_STATE_MAX_MODEL_PROMPT_CHARS = 2000;
const ACTIVITY_LOG_STATE_MAX_LIVE_SEO_NOTES_CHARS = 4000;
const ACTIVITY_LOG_STATE_MAX_QUORA_SEEDER_CHARS = 1000;
const ACTIVITY_LOG_STATE_MAX_ARTICLE_BACKUP_GITHUB_CHARS = 500;

/** Max activity-log entries kept in persisted DO state (sheet mirror queue holds full history). */
const ACTIVITY_LOG_STATE_MAX_ENTRIES = 200;

/**
 * Cap on the separate errors-only buffer (`state.activityLogErrors`).
 * 200 errors is roughly two weeks of typical pipeline failure rate; far
 * more than enough to debug recent regressions while staying small enough
 * that the buffer adds negligible bytes to the persisted DO state.
 */
const ACTIVITY_LOG_ERRORS_MAX_ENTRIES = 200;

/**
 * Age-based expiry for the errors-only buffer. FIFO eviction alone lets
 * long-solved errors linger for weeks when the error rate drops to zero
 * (the healthier the system, the staler the panel). Entries older than
 * this are pruned on every log() append; entries with unparseable
 * timestamps are kept (never silently drop evidence on a parse bug).
 */
const ACTIVITY_LOG_ERRORS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isActivityLogEntryFresh(
  entry: { timeDate?: string; timeTime?: string },
  nowMs: number
): boolean {
  const parsed = Date.parse(
    `${entry.timeDate ?? ""} ${entry.timeTime ?? ""}`.trim()
  );
  if (!Number.isFinite(parsed)) return true;
  return nowMs - parsed <= ACTIVITY_LOG_ERRORS_MAX_AGE_MS;
}

/**
 * Cap on the separate observer-only buffer (`state.observerLog`). Observer
 * fires once per 15 min and emits 1-2 entries per tick (info + optional
 * warning), so 40 ≈ 10 hours of history retained — survives eviction
 * pressure from the 200-row main buffer when article generation bursts at
 * ~8 entries/min. See `SEOAgentState.observerLog` docstring.
 */
const OBSERVER_LOG_MAX_ENTRIES = 40;

/**
 * Fetch recent PR + workflow-run events from GitHub for the
 * Infrastructure Activity Monitor panel. Best-effort: returns empty
 * arrays on any failure so the dashboard renders cleanly. Per-call
 * timeout to avoid hanging the admin endpoint.
 */
async function fetchGitHubEvents(
  repoSlug: string,
  token: string,
  limit: number
): Promise<{
  workflowRuns: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    headBranch: string;
    event: string;
    createdAt: string;
    htmlUrl: string;
  }>;
  pullRequests: Array<{
    number: number;
    title: string;
    state: string;
    user: string;
    headRef: string;
    updatedAt: string;
    htmlUrl: string;
    merged: boolean;
  }>;
}> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  // Independent timeout per request — a single shared AbortSignal
  // would cancel both fetches if either hit the 8s ceiling, so a
  // slow PR list would wipe out the workflow runs (Copilot review
  // feedback on #5480).
  const [runsRes, prsRes] = await Promise.allSettled([
    fetch(
      `https://api.github.com/repos/${repoSlug}/actions/runs?per_page=${limit}`,
      { headers, signal: AbortSignal.timeout(8000) }
    ),
    fetch(
      `https://api.github.com/repos/${repoSlug}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`,
      { headers, signal: AbortSignal.timeout(8000) }
    )
  ]);
  type RunRow = {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    headBranch: string;
    event: string;
    createdAt: string;
    htmlUrl: string;
  };
  type PrRow = {
    number: number;
    title: string;
    state: string;
    user: string;
    headRef: string;
    updatedAt: string;
    htmlUrl: string;
    merged: boolean;
  };
  const workflowRuns: RunRow[] = [];
  const pullRequests: PrRow[] = [];
  if (runsRes.status === "fulfilled" && runsRes.value.ok) {
    const j = (await runsRes.value.json().catch(() => null)) as {
      workflow_runs?: Array<Record<string, unknown>>;
    } | null;
    for (const r of j?.workflow_runs ?? []) {
      workflowRuns.push({
        id: typeof r.id === "number" ? r.id : 0,
        name: String(r.name ?? ""),
        status: String(r.status ?? ""),
        conclusion:
          typeof r.conclusion === "string" || r.conclusion === null
            ? (r.conclusion as string | null)
            : null,
        headBranch: String(r.head_branch ?? ""),
        event: String(r.event ?? ""),
        createdAt: String(r.created_at ?? ""),
        htmlUrl: String(r.html_url ?? "")
      });
    }
  }
  if (prsRes.status === "fulfilled" && prsRes.value.ok) {
    const j = (await prsRes.value.json().catch(() => null)) as Array<
      Record<string, unknown>
    > | null;
    for (const p of j ?? []) {
      const userObj = (p.user as Record<string, unknown> | undefined) ?? {};
      const headObj = (p.head as Record<string, unknown> | undefined) ?? {};
      pullRequests.push({
        number: typeof p.number === "number" ? p.number : 0,
        title: String(p.title ?? ""),
        state: String(p.state ?? ""),
        user: String(userObj.login ?? ""),
        headRef: String(headObj.ref ?? ""),
        updatedAt: String(p.updated_at ?? ""),
        htmlUrl: String(p.html_url ?? ""),
        merged: Boolean(p.merged_at)
      });
    }
  }
  return { workflowRuns, pullRequests };
}

/**
 * Best-effort live Milvus collection stats for the Infrastructure
 * Activity Monitor panel. Hits the Zilliz REST `/v1/vector/collections/describe`
 * endpoint; returns null fields on any failure (UI shows "—").
 */
async function fetchMilvusCollectionStats(
  address: string,
  token: string,
  collection: string
): Promise<{
  name: string;
  vectorCount: number | null;
  ok: boolean;
  reason?: string;
}> {
  try {
    const res = await fetch(
      `${address.replace(/\/+$/, "")}/v1/vector/collections/describe?collectionName=${encodeURIComponent(collection)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000)
      }
    );
    if (!res.ok) {
      return {
        name: collection,
        vectorCount: null,
        ok: false,
        reason: `HTTP ${res.status}`
      };
    }
    const json = (await res.json().catch(() => null)) as {
      data?: { rowCount?: number; row_count?: number };
    } | null;
    const rowCount = json?.data?.rowCount ?? json?.data?.row_count ?? null;
    return {
      name: collection,
      vectorCount: typeof rowCount === "number" ? rowCount : null,
      ok: true
    };
  } catch (err: unknown) {
    return {
      name: collection,
      vectorCount: null,
      ok: false,
      reason: err instanceof Error ? err.message : String(err)
    };
  }
}

/** Optional sheet-only field on `log()` context; never persisted on `PipelineContext`. */
type ActivityLogPipelineCallContext = Partial<PipelineContext> & {
  articleBackedUpToGithub?: string;
};

function splitArticleGithubBackupFromLogContext(
  ctx?: ActivityLogPipelineCallContext
): {
  pipelineCtx: Partial<PipelineContext>;
  articleBackedUpToGithub?: string;
} {
  if (!ctx) return { pipelineCtx: {} };
  const { articleBackedUpToGithub, ...pipelineCtx } = ctx;
  const cell =
    typeof articleBackedUpToGithub === "string" &&
    articleBackedUpToGithub.trim() !== ""
      ? truncateActivityLogSheetPromptCell(
          articleBackedUpToGithub.trim(),
          ACTIVITY_LOG_STATE_MAX_ARTICLE_BACKUP_GITHUB_CHARS
        )
      : undefined;
  return { pipelineCtx, articleBackedUpToGithub: cell };
}

type ArticleGitHubBackupResult = {
  status: "skipped" | "ok" | "failed";
  detail: string;
};

const EMPTY_PIPELINE_CONTEXT: PipelineContext = {
  currentStep: null,
  keyword: "",
  categorySlug: "",
  articleUrl: "",
  timestamp: ""
};

function compactPipelineContextForPersistedState(
  ctx: PipelineContext | unknown
): PipelineContext {
  if (
    ctx === null ||
    ctx === undefined ||
    typeof ctx !== "object" ||
    Array.isArray(ctx)
  ) {
    // Guard against malformed legacy persisted state values.
    return EMPTY_PIPELINE_CONTEXT;
  }
  const wide = ctx as PipelineContext & {
    articleJson?: string;
    articleText?: string;
    filesJson?: string;
  };
  const {
    articleJson: _aj,
    articleText: _at,
    filesJson: _fj,
    modelPrompt: mp,
    ...rest
  } = wide;
  const out = { ...rest } as PipelineContext;
  if (typeof mp === "string" && mp.trim() !== "") {
    out.modelPrompt = truncateActivityLogSheetPromptCell(
      mp,
      ACTIVITY_LOG_STATE_MAX_MODEL_PROMPT_CHARS
    );
  }
  return out;
}

function compactActivityLogEntryForPersistedState(
  entry: ActivityLogEntry | unknown
): ActivityLogEntry {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      timeDate: "",
      timeTime: "",
      level: "info",
      msg: String(entry ?? ""),
      articleUrl: "",
      keyword: "",
      categorySlug: "",
      competitorUrl: "",
      seoScore: "",
      logRef: 0,
      stepNumber: ""
    };
  }
  const safeEntry = entry as ActivityLogEntry;
  const {
    seoCheckQcPromptCells: _qc,
    pipelineContext: pc,
    errorRemediationPrompt: erp,
    liveSeoContentOptimizerNotes: liveSeo,
    quoraSeederSummary: quoraSummary,
    articleBackedUpToGithub: ghBackup,
    ...rest
  } = safeEntry;
  const timeDate = typeof rest.timeDate === "string" ? rest.timeDate : "";
  const timeTime = typeof rest.timeTime === "string" ? rest.timeTime : "";
  const level =
    normalizeActivityLogLevel(rest.level) ??
    (typeof rest.level === "string" && rest.level.trim() !== ""
      ? rest.level.trim().toLowerCase()
      : "info");
  const articleUrl =
    typeof rest.articleUrl === "string" && rest.articleUrl.trim() !== ""
      ? rest.articleUrl
      : "";
  const keyword = typeof rest.keyword === "string" ? rest.keyword : "";
  const categorySlug =
    typeof rest.categorySlug === "string" ? rest.categorySlug : "";
  const competitorUrl =
    typeof rest.competitorUrl === "string" ? rest.competitorUrl : "";
  const seoScore =
    typeof rest.seoScore === "number" || rest.seoScore === ""
      ? rest.seoScore
      : "";
  const logRef = isValidActivityLogRef(rest.logRef) ? rest.logRef : 0;
  const stepNumber =
    typeof rest.stepNumber === "string"
      ? rest.stepNumber
      : typeof rest.stepNumber === "number" && Number.isFinite(rest.stepNumber)
        ? String(rest.stepNumber)
        : "";
  // Truncate `msg` — it can embed HTML/JSON/large text that bloats SQLite state.
  // Guard against nullish `msg` from old persisted state before calling .length.
  const rawMsg =
    typeof rest.msg === "string" ? rest.msg : String(rest.msg ?? "");
  const compactedMsg =
    rawMsg.length > ACTIVITY_LOG_STATE_MAX_MSG_CHARS
      ? `${rawMsg.slice(0, ACTIVITY_LOG_STATE_MAX_MSG_CHARS)}\n…`
      : rawMsg;
  const out: ActivityLogEntry = {
    ...rest,
    timeDate,
    timeTime,
    level,
    msg: compactedMsg,
    articleUrl,
    keyword,
    categorySlug,
    competitorUrl,
    seoScore,
    logRef,
    stepNumber
  };
  if (pc !== undefined) {
    out.pipelineContext = compactPipelineContextForPersistedState(pc);
  }
  if (typeof erp === "string" && erp !== "") {
    out.errorRemediationPrompt = truncateActivityLogSheetPromptCell(
      erp,
      ACTIVITY_LOG_STATE_MAX_ERROR_REMEDIATION_CHARS
    );
  }
  if (typeof liveSeo === "string" && liveSeo !== "") {
    out.liveSeoContentOptimizerNotes = truncateActivityLogSheetPromptCell(
      liveSeo,
      ACTIVITY_LOG_STATE_MAX_LIVE_SEO_NOTES_CHARS
    );
  }
  if (typeof quoraSummary === "string" && quoraSummary !== "") {
    out.quoraSeederSummary = truncateActivityLogSheetPromptCell(
      quoraSummary,
      ACTIVITY_LOG_STATE_MAX_QUORA_SEEDER_CHARS
    );
  }
  if (typeof ghBackup === "string" && ghBackup !== "") {
    out.articleBackedUpToGithub = truncateActivityLogSheetPromptCell(
      ghBackup,
      ACTIVITY_LOG_STATE_MAX_ARTICLE_BACKUP_GITHUB_CHARS
    );
  }
  // sissScore and sissDelta are small numbers — pass through as-is
  return out;
}

type SheetBridgeLogEntry = {
  time: string;
  status: "success" | "error" | "skipped";
  msg: string;
};

/** One leading indicator column + data through last SEO check column (width from `ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT`). */
const SHEET_ROW_COLUMN_COUNT = ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT;

const SHEET_LAST_COLUMN_A1 = sheetColumnIndex1BasedToA1Letters(
  SHEET_ROW_COLUMN_COUNT
);
/**
 * 1-based row: headers are assumed in row 1; each log inserts a row here so newest is on top.
 */
const SHEET_LOG_WRITE_ROW = 2;
const SHEET_WARNING_THROTTLE_MS = 30_000;
/**
 * Longer throttle for persistent-state sheet failures (403
 * PERMISSION_DENIED, 429 write-quota). These don't clear on their own —
 * the service account needs Editor access / the quota needs to reset —
 * and the 403/429 responses alternate, which defeated the single-slot
 * signature dedup and produced ~20 identical warnings per hour.
 */
const SHEET_PERSISTENT_WARNING_THROTTLE_MS = 30 * 60 * 1000;
const SHEET_PERSISTENT_FAILURE_RE =
  /\b403\b|PERMISSION_DENIED|does not have permission|\b429\b|Quota exceeded/i;
const SHEET_BRIDGE_LOG_MAX = 200;
/**
 * Insert-row to Google Sheets is the slowest single API call we make
 * (large-payload row + index recompute). 45s covers the long tail without
 * masking genuinely-hung requests.
 */
const SHEET_INSERT_ROW_TIMEOUT_MS = 45_000;
const UUID_LIKE_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_NUMBER_RE = /\b\d{4,}\b/g;

/**
 * Bump when the activity-log sheet column layout or header labels change.
 * Durable Objects with a lower stored version receive a header row refresh
 * on the next mirror write.
 */
const ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION = 32;

/** First URL in message when it looks article-related; otherwise `""`. */
function extractArticleUrlFromMessage(message: string): string {
  if (!/published:/i.test(message) && !/https?:\/\//i.test(message)) return "";
  return extractFirstHttpUrl(message);
}

/**
 * Per-category editorial benchmark URLs. The Published Article Editorial
 * Agent uses these as the "equal-or-better-than" target when rewriting.
 * Falls back to the NYT Wirecutter best-automatic-cat-litter-box roundup
 * whenever a category isn't explicitly mapped — Wirecutter's structure
 * (clear picks block, rigorous why-we-like-it bullets, thorough testing
 * methodology, skimmable headings) is a solid default quality floor.
 */
const EDITORIAL_REFERENCE_URLS: Record<string, string> = {
  "litter-boxes":
    "https://www.nytimes.com/wirecutter/reviews/best-automatic-cat-litter-box/",
  "water-fountains":
    "https://www.nytimes.com/wirecutter/reviews/best-pet-water-fountain/"
};
const DEFAULT_EDITORIAL_REFERENCE_URL =
  "https://www.nytimes.com/wirecutter/reviews/best-automatic-cat-litter-box/";

function normalizeSheetWarningSignature(message: string): string {
  return normalizeSingleLine(message)
    .toLowerCase()
    .replace(UUID_LIKE_RE, "<uuid>")
    .replace(LONG_NUMBER_RE, "<n>");
}

function pickEditorialReferenceUrl(
  categorySlug: string | null | undefined
): string {
  const slug = (categorySlug ?? "").trim().toLowerCase();
  return EDITORIAL_REFERENCE_URLS[slug] ?? DEFAULT_EDITORIAL_REFERENCE_URL;
}

/**
 * Extract a plain secret value from a Doppler secrets-get response.
 * Doppler's native REST shape is `{ value: { raw, computed } }`; older
 * proxied responses wrapped that in `data` / `response_data` /
 * `responseData` / `response` envelopes (sometimes stringified). Probe
 * the common paths, return trimmed string or null.
 */
function extractDopplerSecretValue(raw: unknown): string | null {
  const envelope = parseObjectLike(raw);
  const response = parseObjectLike(envelope?.response);
  const outer =
    parseObjectLike(envelope?.data) ??
    parseObjectLike(envelope?.response_data) ??
    parseObjectLike(envelope?.responseData) ??
    response ??
    envelope;
  if (!outer) return null;
  const inner =
    parseObjectLike(outer.data) ??
    parseObjectLike(outer.response_data) ??
    parseObjectLike(outer.responseData) ??
    outer;
  const value = inner.value;
  if (typeof value === "string") return value.trim() || null;
  const valueObject = parseObjectLike(value);
  const v = valueObject?.raw ?? valueObject?.computed;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function extractCompetitorUrlFromMessage(message: string): string {
  if (!/competitor/i.test(message)) return "";
  return extractFirstHttpUrl(message);
}

function extractFirstHttpUrl(message: string): string {
  const match = message.match(/https?:\/\/\S+/i);
  if (!match?.[0]) return "";
  // Logs often include sentence punctuation or markdown wrappers right after
  // URLs (`...,`, `<...>`, `"..."`); trim those so extracted links stay valid.
  const normalized = match[0].replace(/[.,!?;:'"\]>]+$/g, "");
  return trimUnmatchedTrailingCloseParens(normalized);
}

function trimUnmatchedTrailingCloseParens(value: string): string {
  let balance = 0;
  for (const char of value) {
    if (char === "(") balance += 1;
    if (char === ")") balance -= 1;
  }
  let toTrim = Math.max(0, -balance);
  if (toTrim === 0) return value;
  let end = value.length;
  while (toTrim > 0 && end > 0 && value[end - 1] === ")") {
    end -= 1;
    toTrim -= 1;
  }
  return value.slice(0, end);
}

function extractSeoScoreFromMessage(message: string): number | "" {
  const match = [
    /\bSEO\s*(\d{1,3})\b/i,
    /\bSEO\s*:\s*(\d{1,3})\b/i,
    /\bSEO\s*score(?:\s*\([^)]*\))?\s*:?\s*(\d{1,3})(?:\s*\/\s*100)?\b/i
  ]
    .map((pattern) => message.match(pattern))
    .find((m): m is RegExpMatchArray => m !== null);
  if (!match || typeof match[1] !== "string") return "";
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : "";
}

/** `Failed: <keyword> — ...` from autonomous loop error lines (sheet column H). */
function extractKeywordFromFailedMessage(message: string): string {
  const m = message.match(/^Failed:\s*(.+?)\s*—/);
  return m?.[1]?.trim() ?? "";
}

/**
 * Parses `updateStep` labels (`3/15: SERP`, `5b/15: JSON`) into the value for
 * Google Sheet column **Step #** (E): `3`, `5b`, `2.5`, etc., or `Complete`.
 */
function extractPipelineStepNumberForSheet(
  step: string | null | undefined
): string {
  if (step == null) return "";
  const s = String(step).trim();
  if (!s) return "";
  if (/^complete$/i.test(s)) return "Complete";
  const m = s.match(/^(\d+(?:\.\d+)?)([a-zA-Z])?\/\d+:/i);
  if (m) return `${m[1]}${m[2] ?? ""}`;
  return "";
}

/** Coerces persisted log `stepNumber` strings to the same column E format. */
function normalizeActivityLogEntryStepNumber(raw: unknown): string {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw !== "string") return "0";
  const t = raw.trim();
  if (!t) return "0";
  if (/^complete$/i.test(t)) return "Complete";
  const legacy = t.match(/^Step\s+(\d+(?:\.\d+)?[a-zA-Z]?)(?::|\s|$)/i);
  if (legacy) return legacy[1];
  if (/^(Idle|Scouting|Generating|Paused)$/.test(t)) return "0";
  const fromPipe = extractPipelineStepNumberForSheet(t);
  if (fromPipe) return fromPipe;
  if (/^(\d+(?:\.\d+)?[a-zA-Z]?)$/.test(t)) return t;
  if (t === "-") return "0";
  return "0";
}

const ACCEPTED_EXTERNAL_LOG_LEVELS = ["info", "warning", "error"] as const;
type NormalizedExternalLogLevel = (typeof ACCEPTED_EXTERNAL_LOG_LEVELS)[number];
const MAX_EXTERNAL_LOG_MESSAGE_LENGTH = 1000;
const MAX_EXTERNAL_LOG_TAG_FIELD_LENGTH = 120;
const EXTERNAL_LOG_LEVEL_VALIDATION_ERROR =
  "level must be one of info, warning (or warn), error (or err)";

function normalizeExternalLogLevel(
  raw: unknown
): NormalizedExternalLogLevel | null {
  const canonical = normalizeActivityLogLevel(raw);
  return canonical && ACCEPTED_EXTERNAL_LOG_LEVELS.includes(canonical)
    ? canonical
    : null;
}

function formatActivityLogLevelLabel(level: unknown): string {
  const canonical = normalizeActivityLogLevel(level);
  if (canonical) return canonical.toUpperCase();
  if (typeof level === "string" && level.trim() !== "") {
    return level.trim().toUpperCase();
  }
  return "INFO";
}

function renderExternalLogLevelValidationError(raw: string): string {
  const normalized = raw.trim();
  if (!normalized) return EXTERNAL_LOG_LEVEL_VALIDATION_ERROR;
  const preview = normalized.slice(0, 80);
  return `${EXTERNAL_LOG_LEVEL_VALIDATION_ERROR}; received: ${JSON.stringify(preview)}`;
}

function stringifyExternalLogPayload(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : "";
  if (typeof raw === "bigint" || typeof raw === "boolean") {
    return String(raw);
  }
  if (typeof raw === "symbol") return String(raw);
  if (typeof raw === "function") return "";
  if (raw instanceof Error) {
    const name = raw.name.trim() || "Error";
    const message = raw.message.trim();
    if (message) return `${name}: ${message}`;
    return name;
  }
  if (typeof raw !== "object") return "";
  try {
    return JSON.stringify(raw, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
  } catch (err: unknown) {
    return `[unserializable payload: ${errMsg(err)}]`;
  }
}

function normalizeExternalLogMessage(raw: unknown): string {
  const value = stringifyExternalLogPayload(raw);
  if (!value) return "";
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXTERNAL_LOG_MESSAGE_LENGTH);
}

function normalizeExternalLogTagField(raw: unknown): string {
  const value =
    typeof raw === "string"
      ? raw
      : typeof raw === "number" && Number.isFinite(raw)
        ? String(raw)
        : typeof raw === "bigint"
          ? raw.toString()
          : "";
  if (!value) return "";
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXTERNAL_LOG_TAG_FIELD_LENGTH);
}

function parseExternalLogPayload(
  body: Record<string, unknown>
): { level: NormalizedExternalLogLevel; msg: string } | { error: string } {
  if ("level" in body && typeof body.level !== "string") {
    return { error: "level must be a string when provided" };
  }
  const providedLevel = typeof body.level === "string" ? body.level : "info";
  const level = normalizeExternalLogLevel(providedLevel);
  if (!level) {
    return { error: renderExternalLogLevelValidationError(providedLevel) };
  }
  const msg = normalizeExternalLogMessage("msg" in body ? body.msg : undefined);
  const fallbackMessage = normalizeExternalLogMessage(
    "message" in body ? body.message : undefined
  );
  const resolvedMessage = msg || fallbackMessage;
  if (!resolvedMessage) return { error: "msg or message is required" };
  return { level, msg: resolvedMessage };
}

function formatLaTimestampParts(now: Date): {
  timeDate: string;
  timeTime: string;
} {
  const timeDate = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const timeTime = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  return { timeDate, timeTime };
}

/** A1 range tab prefix: quoted so hyphenated tab names always parse reliably. */
function activityLogSheetTabQuoted(): string {
  return `'${SHEET_TAB_NAME.replace(/'/g, "''")}'`;
}

function sheetRowRange(row1Based: number): string {
  return `${activityLogSheetTabQuoted()}!A${row1Based}:${SHEET_LAST_COLUMN_A1}${row1Based}`;
}

function activityLogSheetHeaderReadRange(): string {
  return `${activityLogSheetTabQuoted()}!A1:${SHEET_LAST_COLUMN_A1}1`;
}

function isValidActivityLogRef(logRef: unknown): logRef is number {
  return (
    typeof logRef === "number" && Number.isSafeInteger(logRef) && logRef >= 1
  );
}

/**
 * Parse a `limit` query-parameter string to a clamped integer.
 * Accepts only decimal integer strings (no floats, no hex, no leading signs).
 * Falls back to `fallback` for empty/missing/non-integer/unsafe values and
 * clamps to [1, max].
 */
function parseAdminLimit(
  rawLimit: string | null,
  fallback: number,
  max: number
): number {
  const safeMax = Math.max(1, max);
  const safeFallback = Math.max(1, Math.min(fallback, safeMax));
  if (!rawLimit || rawLimit.trim() === "") return safeFallback;
  const normalized = rawLimit.trim();
  if (!/^\d+$/.test(normalized)) return safeFallback;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed)) return safeFallback;
  return Math.max(1, Math.min(parsed, safeMax));
}

/**
 * Guard against malformed persisted DO state where `activityLog` is not an
 * array or contains non-object / malformed rows (older/corrupt state
 * snapshots). Log readers should degrade to a sanitized list instead of
 * throwing in diagnostics paths.
 */
function activityLogEntriesFromState(state: SEOAgentState): ActivityLogEntry[] {
  return filterObjectArrayEntries<ActivityLogEntry>(state.activityLog).map(
    (entry) => compactActivityLogEntryForPersistedState(entry)
  );
}

function activityLogEntryNeedsLogRef(e: ActivityLogEntry): boolean {
  return !isValidActivityLogRef(e.logRef);
}

function activityLogEntryNeedsStepNumberMigration(
  entry: Record<string, unknown>
): boolean {
  if (!("stepNumber" in entry)) return true;
  const stepNumber = entry.stepNumber;
  if (typeof stepNumber === "number") return true;
  if (typeof stepNumber === "string") {
    const normalized = normalizeActivityLogEntryStepNumber(stepNumber);
    return normalized !== stepNumber.trim();
  }
  return true;
}

/**
 * Assigns sequential refs to entries missing a valid `logRef` (oldest first).
 * Preserves existing valid refs and repairs duplicate refs so every row has a
 * unique identifier. Returns the next counter after the max used.
 */
function fillMissingActivityLogRefs(entries: ActivityLogEntry[]): {
  activityLog: ActivityLogEntry[];
  activityLogNextRef: number;
} {
  let maxExisting = 0;
  for (const e of entries) {
    if (!activityLogEntryNeedsLogRef(e)) {
      maxExisting = Math.max(maxExisting, e.logRef);
    }
  }
  let next = maxExisting + 1;
  const seenAssignedRefs = new Set<number>();
  const activityLog = entries.map((e) => {
    if (!activityLogEntryNeedsLogRef(e) && !seenAssignedRefs.has(e.logRef)) {
      seenAssignedRefs.add(e.logRef);
      return e;
    }
    const repaired = { ...e, logRef: next++ };
    seenAssignedRefs.add(repaired.logRef);
    return repaired;
  });
  return { activityLog, activityLogNextRef: next };
}

function activityLogEntryRefLookupKey(entry: ActivityLogEntry): string {
  return [
    entry.timeDate,
    entry.timeTime,
    entry.level,
    entry.msg,
    entry.articleUrl,
    entry.keyword,
    entry.categorySlug,
    entry.competitorUrl
  ].join("\u0000");
}

/**
 * Backfills missing refs in the dedicated errors buffer from the canonical main
 * activity log so React keys and async enrichment patches keep targeting the
 * same rows after older DO state migrations.
 */
function backfillMissingActivityLogErrorRefs(
  activityLog: ActivityLogEntry[],
  activityLogErrors: ActivityLogEntry[]
): {
  activityLogErrors: ActivityLogEntry[];
  activityLogNextRef: number;
} {
  const refsByKey = new Map<string, number[]>();
  let maxExisting = 0;
  for (const entry of activityLog) {
    const hasLogRef = isValidActivityLogRef(entry.logRef);
    if (hasLogRef) {
      maxExisting = Math.max(maxExisting, entry.logRef);
    }
    if (!isActivityLogErrorLevel(entry.level) || !hasLogRef) continue;
    const key = activityLogEntryRefLookupKey(entry);
    const refs = refsByKey.get(key);
    if (refs) refs.push(entry.logRef);
    else refsByKey.set(key, [entry.logRef]);
  }
  for (const entry of activityLogErrors) {
    if (!activityLogEntryNeedsLogRef(entry)) {
      maxExisting = Math.max(maxExisting, entry.logRef);
    }
  }
  let next = maxExisting + 1;
  const nextErrors = activityLogErrors.map((entry) => {
    if (!activityLogEntryNeedsLogRef(entry)) {
      const key = activityLogEntryRefLookupKey(entry);
      const refs = refsByKey.get(key);
      if (refs) {
        const idx = refs.indexOf(entry.logRef);
        if (idx >= 0) refs.splice(idx, 1);
      }
      return entry;
    }
    // Consume refs in-order so duplicate error rows reuse each matching main-log
    // ref at most once.
    const refs = refsByKey.get(activityLogEntryRefLookupKey(entry));
    const matched = refs?.shift();
    if (typeof matched === "number") {
      return { ...entry, logRef: matched };
    }
    return { ...entry, logRef: next++ };
  });
  return { activityLogErrors: nextErrors, activityLogNextRef: next };
}

/** Full header row (logical columns A through last SEO check column). */
function activityLogSheetHeaderFullRowRange(): string {
  return `${activityLogSheetTabQuoted()}!A1:${SHEET_LAST_COLUMN_A1}1`;
}

/**
 * Collects unique `toolName` values from AI SDK `generateText` steps (MCP tools).
 */
function collectToolNamesFromGenerateTextResult(result: {
  readonly steps?: ReadonlyArray<{
    readonly toolCalls?: ReadonlyArray<{ readonly toolName?: string }>;
    readonly staticToolCalls?: ReadonlyArray<{
      readonly toolName?: string;
    }>;
  }>;
}): string {
  const steps = result.steps;
  if (steps == null || !Array.isArray(steps)) return "";
  const names: string[] = [];
  for (const step of steps) {
    for (const list of [step.toolCalls, step.staticToolCalls] as const) {
      if (list == null || !Array.isArray(list)) continue;
      for (const c of list) {
        const n =
          c != null && typeof c === "object" && typeof c.toolName === "string"
            ? c.toolName.trim()
            : "";
        if (n !== "" && !names.includes(n)) names.push(n);
      }
    }
  }
  return names.join(", ");
}

/**
 * Column A (“ROW HAS DATA”): YES when any sheet data cell in columns B through
 * the last mirrored column (indices `1 .. row.length-1`) is non-empty; otherwise
 * NO. Does not read column A (index 0), which is filled last.
 */
function computeRowHasDataFlag(
  row: Array<string | number | null>
): "YES" | "NO" {
  for (let i = 1; i < row.length; i++) {
    const c = row[i];
    if (c !== null && c !== undefined && String(c).trim() !== "") {
      return "YES";
    }
  }
  return "NO";
}

// ── State shape ─────────────────────────────────────────────────────────────
export type SEOAgentState = {
  status: "idle" | "scouting" | "generating" | "paused";
  currentCategory: string | null;
  currentKeyword: string | null;
  /** Slug for `currentKeyword` while generating; cleared with keyword. */
  currentArticleSlug: string | null;
  currentStep: string | null;
  /**
   * Last parsed pipeline step # for sheet column E when `currentStep` is null
   * (same format as `ActivityLogEntry.stepNumber`, e.g. `5`, `5b`, `Complete`).
   */
  lastSheetStepLabel: string;
  categoriesCompleted: number;
  articlesGenerated: number;
  articlesFailed: number;
  avgSeoScore: number;
  lastActivity: string | null;
  activityLog: Array<ActivityLogEntry>;
  /**
   * Separate, longer-retained buffer of every `level: "error"` entry. Kept
   * out of the rolling 200-row main `activityLog` so error history doesn't
   * get evicted by info/warning chatter; the dashboard's "Activity Log
   * Errors" panel reads from here.
   */
  activityLogErrors: Array<ActivityLogEntry>;
  /**
   * Dedicated, longer-retained ring buffer for `observerAgent` entries.
   * Without this, observer ticks (one per 15 minutes) get evicted from the
   * 200-row main `activityLog` within ~2 minutes during article-generation
   * bursts (~8 entries/min), so the dashboard's AI Observer panel shows
   * "no observations yet" for ~95% of the wall-clock window between ticks.
   * Cap = 40 ⇒ ~10 hours of 15-min ticks survive eviction. Same defense
   * pattern as `activityLogErrors`.
   */
  observerLog: Array<ActivityLogEntry>;
  /** Next value for `ActivityLogEntry.logRef` (starts at 1). */
  activityLogNextRef: number;
  sheetBridgeLog: Array<SheetBridgeLogEntry>;
  /** Next 1-based row for Google Sheet log writes; null forces a resync read. */
  sheetMirrorNextRow: number | null;
  /**
   * Sheet-mirror-failure throttle bookkeeping. Must live in persisted
   * `state`, not a plain instance field: this Durable Object is recycled
   * between ticks, and a plain field silently resets to its initial value
   * on every reconstruction — which defeated the 30-minute persistent-
   * failure throttle below and let a permanent 403 spam a warning every
   * ~60s for days instead of once per 30 minutes.
   */
  lastSheetWarningAt: number;
  lastSheetWarningSignature: string;
  lastSheetHeaderColumnMapWarningAt: number;
  googleSheetUrl: string | null;
  recentGoogleSheets: Array<{ url: string; updatedAt: number }>;
  lastSeoScorecard: {
    keyword: string;
    url: string;
    score: number;
    pillars: Record<string, { passed: number; total: number }>;
    checks: Array<{
      id: number;
      pillar: string;
      name: string;
      passed: boolean;
      detail: string;
    }>;
  } | null;
  /**
   * Parallel array (length 100) of per-check QC AI prompts; `null` when pass
   * or unknown. Cleared with article pipeline resets.
   */
  lastSeoScorecardQcPromptCells: (string | null)[] | null;
  /**
   * SERP competitor URL for the article currently being generated; copied into
   * every activity-log / sheet row (column O) until the loop clears it with
   * `currentKeyword` (e.g. after `generateArticle` returns).
   */
  currentCompetitorUrl: string | null;
  /**
   * When lower than ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION, the next sheet
   * mirror write refreshes row 1 from canonical titles (default A–CA).
   */
  activityLogSheetHeaderLayoutVersion?: number;
  /**
   * When lower than `SCOUT_KEYWORD_ROI_SHEET_LAYOUT_VERSION`, the next activity
   * log mirror ensures the `Scout keyword ROI` tab exists with headers + ROI
   * formulas in G2, J2, and K2.
   */
  scoutKeywordRoiSheetLayoutVersion?: number;
  /**
   * Source-health circuit breaker.  Keyed by source-name (e.g. `"serp:brave"`,
   * `"amazon:apify"`).  When `lastFailAt + cooldownMs > now`, callers skip the
   * source and fall through to the next tier.  Populated on TRANSIENT_HTTP_STATUSES.
   * Optional: reads as `undefined` on pre-existing Durable Object state; no
   * SQLite migration needed because this lives in the DO state blob.
   */
  sourceHealth?: Record<string, { lastFailAt: number; cooldownMs: number }>;
  /**
   * Rolling buffer of the last 50 published articles, newest first. Pushed
   * when `articlesGenerated` increments. Drives the Published Article Log
   * dashboard panel — gives the operator a structured editorial overview
   * (URL, SEO score, word count, kvKey) instead of digging through the
   * activity-log feed.
   */
  recentPublishedArticles?: Array<{
    slug: string;
    keyword: string;
    categorySlug: string;
    url: string;
    kvKey: string;
    seoScore: number;
    wordCount: number;
    publishedAt: number;
  }>;
  /**
   * Counters for the post-publish Editorial Agent rewrite loop. Mirrored
   * from the per-day KV records at `editorial-rewrite-stats:YYYY-MM-DD`
   * so the dashboard can read them straight from `state` without going
   * through the bearer-gated `/api/admin/editorial-stats` endpoint.
   *
   * Optional because existing DO instances were created before this
   * field existed and would otherwise fail type checks on hydration;
   * `incrementEditorialStat` lazily initialises when missing. `reasons`
   * is a frequency histogram of rejection reasons (no cap — KV
   * persistence is authoritative, this is just the dashboard view).
   */
  editorialStats?: {
    success: number;
    fail: number;
    skipped: number;
    reasons: Record<string, number>;
    /**
     * Skip-reason histogram. Lets the dashboard distinguish clean
     * skips (`no-actionable-fixes`) from degraded ones (e.g.
     * `kimi-audit-partial-fail`). Optional for backward compat — DOs
     * persisted before this field shipped will lazy-init it on the
     * next stat increment.
     */
    skipReasons?: Record<string, number>;
    /** UTC ISO timestamp when these counters were last reset (DO instance start). */
    resetAt: string;
  };
};

// ── Agent ────────────────────────────────────────────────────────────────────
/**
 * Durable Object-backed article pipeline agent.
 *
 * Owns the long-lived workflow state for article generation, activity-log
 * mirroring, and post-publish follow-up jobs that need to survive across
 * requests on the same article-processing isolate.
 */
export class SEOArticleAgent extends Agent<Env, SEOAgentState> {
  initialState: SEOAgentState = {
    status: "idle",
    currentCategory: null,
    currentKeyword: null,
    currentArticleSlug: null,
    currentStep: null,
    lastSheetStepLabel: "",
    categoriesCompleted: 0,
    articlesGenerated: 0,
    articlesFailed: 0,
    avgSeoScore: 0,
    lastActivity: null,
    activityLog: [],
    activityLogErrors: [],
    observerLog: [],
    activityLogNextRef: 1,
    sheetBridgeLog: [],
    sheetMirrorNextRow: null,
    lastSheetWarningAt: 0,
    lastSheetWarningSignature: "",
    lastSheetHeaderColumnMapWarningAt: 0,
    googleSheetUrl: null,
    recentGoogleSheets: [],
    lastSeoScorecard: null,
    lastSeoScorecardQcPromptCells: null,
    currentCompetitorUrl: null,
    editorialStats: {
      success: 0,
      fail: 0,
      skipped: 0,
      reasons: {},
      skipReasons: {},
      resetAt: new Date().toISOString()
    }
  };

  /**
   * Transient in-memory buffer for QC prompt cells that must be attached to
   * the NEXT `log()` call (the "Published" sheet row) without being persisted
   * to SQLite state.  Each cell can be up to 27 KB of HTML-embedded guidance;
   * storing 100 of them in the DO state blob causes the isolate to exceed its
   * 128 MB memory limit.  This field is NOT part of `SEOAgentState` — it is
   * never serialised, survives only for the duration of one log call, and is
   * cleared by `log()` immediately after consumption.
   */
  private _pendingQcPromptCells: (string | null)[] | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  onStart() {
    // Shrink oversized activity-log rows before other migrations: serialized DO
    // state must stay under SQLite limits (SQLITE_TOOBIG). Sheet mirror still
    // receives full payloads via `enqueueSheetActivityLog` at `log()` time.
    const prev = this.state;
    const slimActivityLog = Array.isArray(prev.activityLog)
      ? prev.activityLog
          .map(compactActivityLogEntryForPersistedState)
          .slice(-ACTIVITY_LOG_STATE_MAX_ENTRIES)
      : [];
    // Migrate `activityLogErrors`: preserve any valid existing errors and also
    // backfill from errors still present in the main log so stale/corrupt
    // legacy buffers cannot suppress the backfill path.
    const existingErrorBuf = Array.isArray(prev.activityLogErrors)
      ? prev.activityLogErrors
      : [];
    const seedFromMain = Array.isArray(prev.activityLog)
      ? prev.activityLog.filter((e) => isActivityLogErrorLevel(e?.level))
      : [];
    const mergedErrors = existingErrorBuf
      .filter((e) => isActivityLogErrorLevel(e?.level))
      .concat(seedFromMain)
      .map(compactActivityLogEntryForPersistedState)
      .slice(-ACTIVITY_LOG_ERRORS_MAX_ENTRIES);
    this.setState({
      ...prev,
      activityLog: slimActivityLog,
      activityLogErrors: mergedErrors,
      sheetBridgeLog: Array.isArray(prev.sheetBridgeLog)
        ? prev.sheetBridgeLog
        : [],
      // Evict any oversized QC prompt cells that may have been persisted by
      // older code.  Each cell can be ~27 KB; 100 of them would push the DO
      // state blob past the isolate memory limit on every setState().
      lastSeoScorecardQcPromptCells: null
    });
    // Backward-compatible state migration for already-running Durable Objects.
    if (!("sheetMirrorNextRow" in (this.state as object))) {
      const prev = this.state as SEOAgentState;
      this.setState({
        ...prev,
        sheetMirrorNextRow: null
      });
    }
    if (!("currentArticleSlug" in (this.state as object))) {
      this.setState({
        ...this.state,
        currentArticleSlug: null
      });
    }
    if (!("lastSheetStepLabel" in (this.state as object))) {
      this.setState({
        ...this.state,
        lastSheetStepLabel: ""
      });
    }
    if (!("currentCompetitorUrl" in (this.state as object))) {
      this.setState({
        ...this.state,
        currentCompetitorUrl: null
      });
    }

    const rawLog = this.state.activityLog;
    if (Array.isArray(rawLog)) {
      const needsActivityLogMigrate = rawLog.some((e) => {
        const o = e as Record<string, unknown>;
        const legacyTime =
          typeof o.time === "string" && typeof o.timeDate !== "string";
        const missingArticleUrl = typeof o.articleUrl !== "string";
        const missingKeywordCompetitorSeo =
          typeof o.keyword !== "string" ||
          typeof o.competitorUrl !== "string" ||
          !(
            "seoScore" in o &&
            (typeof o.seoScore === "number" || o.seoScore === "")
          );
        return legacyTime || missingArticleUrl || missingKeywordCompetitorSeo;
      });
      if (needsActivityLogMigrate) {
        const mapped = rawLog.map((e) => {
          const o = e as Record<string, unknown>;
          const level = String(o.level ?? "info");
          const msg = String(o.msg ?? "");
          const articleUrl =
            typeof o.articleUrl === "string"
              ? o.articleUrl
              : extractArticleUrlFromMessage(msg) || "";
          const keyword = typeof o.keyword === "string" ? o.keyword : "";
          const competitorUrl =
            typeof o.competitorUrl === "string"
              ? o.competitorUrl
              : extractCompetitorUrlFromMessage(msg);
          const seoScore =
            "seoScore" in o &&
            (typeof o.seoScore === "number" || o.seoScore === "")
              ? (o.seoScore as number | "")
              : extractSeoScoreFromMessage(msg);
          if (
            typeof o.timeDate === "string" &&
            typeof o.timeTime === "string"
          ) {
            return {
              timeDate: o.timeDate,
              timeTime: o.timeTime,
              level,
              msg,
              articleUrl,
              keyword,
              categorySlug: "",
              competitorUrl,
              seoScore,
              logRef: 0,
              stepNumber: ""
            } satisfies ActivityLogEntry;
          }
          if (typeof o.time === "string") {
            const comma = o.time.indexOf(", ");
            if (comma >= 0) {
              return {
                timeDate: o.time.slice(0, comma),
                timeTime: o.time.slice(comma + 2),
                level,
                msg,
                articleUrl,
                keyword,
                categorySlug: "",
                competitorUrl,
                seoScore,
                logRef: 0,
                stepNumber: ""
              } satisfies ActivityLogEntry;
            }
            return {
              timeDate: o.time,
              timeTime: "",
              level,
              msg,
              articleUrl,
              keyword,
              categorySlug: "",
              competitorUrl,
              seoScore,
              logRef: 0,
              stepNumber: ""
            } satisfies ActivityLogEntry;
          }
          return {
            timeDate: String(o.timeDate ?? ""),
            timeTime: String(o.timeTime ?? ""),
            level,
            msg,
            articleUrl,
            keyword,
            categorySlug: "",
            competitorUrl,
            seoScore,
            logRef: 0,
            stepNumber: ""
          } satisfies ActivityLogEntry;
        });
        const { activityLog, activityLogNextRef } =
          fillMissingActivityLogRefs(mapped);
        this.setState({
          ...this.state,
          activityLog,
          activityLogNextRef: Math.max(
            isValidActivityLogRef(this.state.activityLogNextRef)
              ? this.state.activityLogNextRef
              : 1,
            activityLogNextRef
          )
        });
      }
      const cur = this.state.activityLog;
      if (
        Array.isArray(cur) &&
        cur.length > 0 &&
        cur.some((e) => activityLogEntryNeedsLogRef(e))
      ) {
        const { activityLog, activityLogNextRef } =
          fillMissingActivityLogRefs(cur);
        this.setState({
          ...this.state,
          activityLog,
          activityLogNextRef: Math.max(
            isValidActivityLogRef(this.state.activityLogNextRef)
              ? this.state.activityLogNextRef
              : 1,
            activityLogNextRef
          )
        });
      }
      const curErrors = this.state.activityLogErrors;
      if (
        Array.isArray(curErrors) &&
        curErrors.length > 0 &&
        curErrors.some((e) => activityLogEntryNeedsLogRef(e))
      ) {
        const { activityLogErrors, activityLogNextRef } =
          backfillMissingActivityLogErrorRefs(
            activityLogEntriesFromState(this.state),
            curErrors
          );
        this.setState({
          ...this.state,
          activityLogErrors,
          // Preserve any larger in-memory counter if earlier startup migrations
          // already advanced it before we reconciled the errors buffer.
          activityLogNextRef: Math.max(
            isValidActivityLogRef(this.state.activityLogNextRef)
              ? this.state.activityLogNextRef
              : 1,
            activityLogNextRef
          )
        });
      }
      if (!isValidActivityLogRef(this.state.activityLogNextRef)) {
        let max = 0;
        for (const entries of [
          this.state.activityLog,
          this.state.activityLogErrors
        ]) {
          if (!Array.isArray(entries)) continue;
          for (const e of entries) {
            if (!activityLogEntryNeedsLogRef(e)) {
              max = Math.max(max, e.logRef);
            }
          }
        }
        this.setState({
          ...this.state,
          activityLogNextRef: Math.max(1, max + 1)
        });
      }
      const logForStep = this.state.activityLog;
      if (Array.isArray(logForStep)) {
        const needsStepMigrate = logForStep.some((e) =>
          activityLogEntryNeedsStepNumberMigration(e as Record<string, unknown>)
        );
        if (needsStepMigrate) {
          this.setState({
            ...this.state,
            activityLog: logForStep.map((e) => {
              const o = e as Record<string, unknown>;
              const sn = o.stepNumber;
              return {
                ...(e as ActivityLogEntry),
                stepNumber: normalizeActivityLogEntryStepNumber(sn)
              };
            })
          });
        }
      }
      const errorsForStep = this.state.activityLogErrors;
      if (Array.isArray(errorsForStep)) {
        const needsStepMigrate = errorsForStep.some((e) =>
          activityLogEntryNeedsStepNumberMigration(e as Record<string, unknown>)
        );
        if (needsStepMigrate) {
          this.setState({
            ...this.state,
            activityLogErrors: errorsForStep.map((e) => {
              const o = e as Record<string, unknown>;
              const sn = o.stepNumber;
              return {
                ...(e as ActivityLogEntry),
                stepNumber: normalizeActivityLogEntryStepNumber(sn)
              };
            })
          });
        }
      }
      const logForCategorySlug = this.state.activityLog;
      if (Array.isArray(logForCategorySlug)) {
        const needsCategorySlugMigrate = logForCategorySlug.some((e) => {
          const o = e as Record<string, unknown>;
          return typeof o.categorySlug !== "string";
        });
        if (needsCategorySlugMigrate) {
          this.setState({
            ...this.state,
            activityLog: logForCategorySlug.map((e) => {
              const o = e as Record<string, unknown>;
              if (typeof o.categorySlug === "string") {
                return e as ActivityLogEntry;
              }
              return {
                ...(e as ActivityLogEntry),
                categorySlug: ""
              };
            })
          });
        }
      }
    }

    this.sql`CREATE TABLE IF NOT EXISTS categories (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      article_count INTEGER DEFAULT 0,
      expected_count INTEGER DEFAULT 0,
      avg_price TEXT DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS keywords (
      id TEXT PRIMARY KEY,
      category_slug TEXT NOT NULL,
      keyword TEXT NOT NULL,
      slug TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      seo_score INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (category_slug) REFERENCES categories(slug)
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS articles (
      slug TEXT PRIMARY KEY,
      category_slug TEXT NOT NULL,
      keyword TEXT NOT NULL,
      kv_key TEXT NOT NULL,
      url TEXT NOT NULL,
      seo_score INTEGER DEFAULT 0,
      word_count INTEGER DEFAULT 0,
      competitor_url TEXT DEFAULT '',
      competitor_text TEXT DEFAULT '',
      qc_score INTEGER DEFAULT 0,
      qc_status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (category_slug) REFERENCES categories(slug)
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS google_sheets (
      url TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`;

    // Top Seller Scout — tracks the 18 fixed Amazon browse-node categories
    // swept daily for real bestsellers. Deliberately separate from
    // `categories`, whose exclusion semantics (a slug is permanently
    // skipped once scouted, see scoutHighTicketCategory in scout.ts) are
    // the opposite of what a daily-revisit sweep needs. `last_asins`
    // holds the previous sweep's ASIN list as a JSON array so the next
    // sweep can diff against it and only act on genuinely new bestsellers.
    this.sql`CREATE TABLE IF NOT EXISTS bestseller_nodes (
      node_id TEXT PRIMARY KEY,
      category_name TEXT NOT NULL,
      category_slug TEXT NOT NULL,
      last_swept_at INTEGER DEFAULT 0,
      last_asins TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch())
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS agent_debug_ndjson (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      line TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )`;

    // Wireframe ingestion — one row per ingested reference URL. Provenance
    // artifacts live in IMAGES_R2 under `wireframes/<slug>/*`; this table
    // is the searchable index. See src/pipeline/wireframe-ingest.ts.
    this.sql`CREATE TABLE IF NOT EXISTS wireframe_documents (
      slug TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      url_sha256 TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      source_name TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL DEFAULT '',
      fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
      raw_html_r2_key TEXT NOT NULL DEFAULT '',
      raw_md_r2_key TEXT NOT NULL DEFAULT '',
      metadata_r2_key TEXT NOT NULL DEFAULT '',
      outline_r2_key TEXT NOT NULL DEFAULT '',
      chunks_r2_key TEXT NOT NULL DEFAULT '',
      facts_r2_key TEXT NOT NULL DEFAULT '',
      patterns_r2_key TEXT NOT NULL DEFAULT '',
      section_count INTEGER NOT NULL DEFAULT 0,
      pattern_count INTEGER NOT NULL DEFAULT 0
    )`;

    // Debug-only chunk index — prompts consume abstract patterns, not chunks.
    this.sql`CREATE TABLE IF NOT EXISTS wireframe_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      pattern_type TEXT NOT NULL DEFAULT '',
      heading TEXT NOT NULL DEFAULT '',
      token_count INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0
    )`;

    // Migrate: add columns that may be missing on existing tables
    const articleCols = this.sql<{
      name: string;
    }>`PRAGMA table_info(articles)`;
    const colNames = new Set(articleCols.map((c) => c.name));
    if (!colNames.has("competitor_url"))
      this.sql`ALTER TABLE articles ADD COLUMN competitor_url TEXT DEFAULT ''`;
    if (!colNames.has("competitor_text"))
      this.sql`ALTER TABLE articles ADD COLUMN competitor_text TEXT DEFAULT ''`;
    if (!colNames.has("qc_score"))
      this.sql`ALTER TABLE articles ADD COLUMN qc_score INTEGER DEFAULT 0`;
    if (!colNames.has("qc_status"))
      this
        .sql`ALTER TABLE articles ADD COLUMN qc_status TEXT DEFAULT 'pending'`;
    if (!colNames.has("dataforseo_score"))
      this
        .sql`ALTER TABLE articles ADD COLUMN dataforseo_score REAL DEFAULT NULL`;
    if (!colNames.has("dataforseo_failed_checks"))
      this
        .sql`ALTER TABLE articles ADD COLUMN dataforseo_failed_checks INTEGER DEFAULT NULL`;
    if (!colNames.has("dataforseo_task_id"))
      this
        .sql`ALTER TABLE articles ADD COLUMN dataforseo_task_id TEXT DEFAULT ''`;

    // Migrate: keywords table — DataForSEO search-volume metrics columns.
    // Populated by hydrateKeywordMetrics() at the start of generateArticle();
    // gates Kimi spend on dead keywords (search_volume<50 → status='skipped').
    const keywordCols = this.sql<{
      name: string;
    }>`PRAGMA table_info(keywords)`;
    const kwColNames = new Set(keywordCols.map((c) => c.name));
    if (!kwColNames.has("search_volume"))
      this
        .sql`ALTER TABLE keywords ADD COLUMN search_volume INTEGER DEFAULT NULL`;
    if (!kwColNames.has("keyword_difficulty"))
      this
        .sql`ALTER TABLE keywords ADD COLUMN keyword_difficulty INTEGER DEFAULT NULL`;
    if (!kwColNames.has("cpc"))
      this.sql`ALTER TABLE keywords ADD COLUMN cpc REAL DEFAULT NULL`;
    // retry_count — how many times this keyword has failed or been swept
    // back from a stuck 'generating' state. Once it hits MAX_KEYWORD_RETRIES
    // the keyword moves to a terminal 'abandoned' status instead of
    // resurrecting to 'pending' forever, so a deterministically-broken
    // keyword (e.g. a degenerate "best ..." / "... vs ..." template echo)
    // stops burning DataForSEO/Kimi/render quota on every loop cycle.
    if (!kwColNames.has("retry_count"))
      this.sql`ALTER TABLE keywords ADD COLUMN retry_count INTEGER DEFAULT 0`;

    this
      .sql`CREATE INDEX IF NOT EXISTS idx_kw_cat ON keywords(category_slug, status)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_art_cat ON articles(category_slug)`;

    // article_rankings — time-series of DataForSEO Labs `ranked_keywords` pulls
    // for every published URL. One row per (kv_key, keyword, date, country).
    // Populated by runAnalyticsTick() in src/pipeline/analytics-tick.ts via
    // the every-minute `scheduled()` handler; staleness gate inside the tick
    // means each kvKey is re-pulled at most once per ~22h. Read by
    // /api/admin/analytics/<kvKey> and the Rankings dashboard panel.
    this.sql`CREATE TABLE IF NOT EXISTS article_rankings (
      kv_key TEXT NOT NULL,
      keyword TEXT NOT NULL,
      date TEXT NOT NULL,
      position INTEGER NOT NULL,
      search_volume INTEGER DEFAULT 0,
      est_traffic REAL DEFAULT 0,
      cpc REAL DEFAULT 0,
      serp_features TEXT DEFAULT '',
      country TEXT NOT NULL DEFAULT 'US',
      PRIMARY KEY (kv_key, keyword, date, country)
    )`;
    this
      .sql`CREATE INDEX IF NOT EXISTS idx_rank_kv_date ON article_rankings(kv_key, date DESC)`;
    this
      .sql`CREATE INDEX IF NOT EXISTS idx_rank_kw_date ON article_rankings(keyword, date DESC)`;

    // Reset keywords stuck in 'generating' from a previous crash/restart.
    // Each reset counts as a retry so a keyword that deterministically
    // throws on every attempt (e.g. a degenerate keyword that crashes the
    // pipeline before it reaches the clean failResult() path) is abandoned
    // after MAX_KEYWORD_RETRIES instead of resurrecting to 'pending' on
    // every restart forever.
    const stuck = this.sql<{
      id: string;
      keyword: string;
      retry_count: number;
    }>`SELECT id, keyword, retry_count FROM keywords WHERE status='generating'`;
    if (stuck.length > 0) {
      let abandonedCount = 0;
      for (const row of stuck) {
        const nextRetryCount = row.retry_count + 1;
        if (nextRetryCount >= MAX_KEYWORD_RETRIES) {
          this
            .sql`UPDATE keywords SET status='abandoned', retry_count=${nextRetryCount} WHERE id=${row.id}`;
          abandonedCount++;
        } else {
          this
            .sql`UPDATE keywords SET status='pending', retry_count=${nextRetryCount} WHERE id=${row.id}`;
        }
      }
      this.log(
        "info",
        `Reset ${stuck.length} stuck keywords from 'generating'` +
          (abandonedCount > 0
            ? ` (${abandonedCount} abandoned after ${MAX_KEYWORD_RETRIES} retries, ${stuck.length - abandonedCount} → 'pending')`
            : " to 'pending'")
      );
    }

    const recentSheets = this.sql<{ url: string; updated_at: number }>`
      SELECT url, updated_at FROM google_sheets ORDER BY updated_at DESC LIMIT 10`;
    if (recentSheets.length > 0) {
      this.setState({
        ...this.state,
        googleSheetUrl: recentSheets[0].url,
        recentGoogleSheets: recentSheets.map((s) => ({
          url: s.url,
          updatedAt: s.updated_at
        }))
      });
    }

    // Re-establish autonomous schedule if agent was running before deploy/hibernation
    if (
      this.state.status === "generating" ||
      this.state.status === "scouting"
    ) {
      const existing = this.getSchedules();
      const hasLoop = existing.some((s) => s.callback === "autonomousLoop");
      if (!hasLoop) {
        this.scheduleEvery(300, "autonomousLoop");
        this.log("info", "Schedule restored after restart");
      }
    }
    // Observer tick runs unconditionally — even when the worker is idle
    // it should narrate WHY it's idle. Re-register if missing after
    // restart. Fixed 15-min cadence; ~$1/day at OpenRouter Kimi pricing.
    {
      const existing = this.getSchedules();
      const hasObserver = existing.some((s) => s.callback === "observerTick");
      if (!hasObserver) {
        this.scheduleEvery(900, "observerTick");
      }
    }
    // Live quality probe — samples the 10 newest published articles
    // from KV every 30 min, records defect-findings for orphan
    // titles, thin H2 counts, missing FAQ coverage. Same auto-fix
    // loop as the pre-publish gates — 5 hits in 24h → Copilot PR.
    // Zero LLM cost; pure HTML inspection.
    {
      const existing = this.getSchedules();
      const hasProbe = existing.some((s) => s.callback === "qualityProbeTick");
      if (!hasProbe) {
        this.scheduleEvery(1800, "qualityProbeTick");
      }
    }
    // Top Seller Scout — daily sweep of the 18 fixed Amazon browse-node
    // categories for real bestsellers. Runs unconditionally, same as
    // observerTick/qualityProbeTick above. 86400s = 24h.
    {
      const existing = this.getSchedules();
      const hasBestsellerSweep = existing.some(
        (s) => s.callback === "topSellerScoutTick"
      );
      if (!hasBestsellerSweep) {
        this.scheduleEvery(86400, "topSellerScoutTick");
      }
      // scheduleEvery's first fire is now+interval, not immediate — a
      // brand-new 86400s registration would otherwise sit idle for a full
      // day before sweeping a single node. Kick off the first sweep in the
      // background instead of waiting: gated on the table being genuinely
      // empty (not on `hasBestsellerSweep` above, which stays true forever
      // after the one-time registration and would never re-arm this).
      //
      // Live-observed 2026-07-09: `idempotent: true` alone did NOT prevent
      // duplicate one-offs across repeated onStart() calls in the same
      // restart burst — 3 concurrent sweeps of the same 18 nodes ran within
      // seconds of each other, and two concurrent writer runs on the same
      // "best cat supplies" keyword corrupted its published HTML (two full
      // documents concatenated into one KV blob). Explicit belt-and-braces
      // check against `existing` (already fetched above) for a pending
      // "delayed" schedule with this callback closes the race the SDK's own
      // dedup didn't, matching the same idempotent-registration pattern
      // every other tick in this method already uses.
      const hasPendingKick = existing.some(
        (s) => s.callback === "topSellerScoutTick" && s.type === "delayed"
      );
      const sweptRows = this.sql<{ cnt: number }>`
        SELECT COUNT(*) as cnt FROM bestseller_nodes
      `;
      if ((sweptRows[0]?.cnt ?? 0) === 0 && !hasPendingKick) {
        this.schedule(5, "topSellerScoutTick", undefined, {
          idempotent: true
        });
      }
    }
    // Codebase-search readiness log — operator-facing one-line ping at
    // boot so the dashboard can show whether the agent can hit Milvus
    // for semantic code lookup. NEVER throws; degrades to a "skipped"
    // log when secrets aren't set.
    if (
      isCodebaseSearchEnabled(this.envBindings as unknown as CodebaseSearchEnv)
    ) {
      this.log(
        "info",
        "Codebase search: enabled (OPENAI_API_KEY + MILVUS_ADDRESS + MILVUS_TOKEN present)"
      );
    } else {
      this.log(
        "info",
        "Codebase search: disabled (missing one or more of OPENAI_API_KEY, MILVUS_ADDRESS, MILVUS_TOKEN); semantic code lookup unavailable, agent falls back to heuristics"
      );
    }
  }

  // ── Direct external connectors ─────────────────────────────────────────────

  /** Hosted Cloudflare API MCP (Code Mode: `search` + `execute`). */
  private static readonly cloudflareMcpServerName = "cloudflare-api";
  private static readonly cloudflareMcpUrl = "https://mcp.cloudflare.com/mcp";

  /**
   * Direct Google Sheets connector. `undefined` = not yet resolved this
   * isolate; `null` = no service-account secret — the Sheet mirror is
   * unavailable. Built lazily from GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON.
   */
  private _sheetsClient: GoogleSheetsDirectClient | null | undefined =
    undefined;
  private _sheetLogQueue: Promise<void> = Promise.resolve();
  private _isPushingSheetWarning = false;
  private _lastQuadraticConfigWarningAt = 0;
  /**
   * Last parsed step for sheet column **Step #**, set synchronously in
   * `updateStep` before `setState` so `log()` never reads a stale
   * `currentStep` / `lastSheetStepLabel`. Cleared when an article run ends.
   */
  private _sheetStepColumnECache = "";
  /**
   * Full `updateStep` label (e.g. `5/15: AI Writing`), set with
   * `_sheetStepColumnECache` so `log()` can resolve Agentskill.sh without
   * waiting for `setState`.
   */
  private _sheetPipelineLabelCache = "";
  /** Short-lived URL → HTTP status cell cache for sheet mirror writes. */
  private _mirrorPageHttpCache = new Map<
    string,
    { cell: string; until: number }
  >();

  private clearSheetStepColumnECache(): void {
    this._sheetStepColumnECache = "";
    this._sheetPipelineLabelCache = "";
  }

  private bumpSheetStepColumnECacheFromPipelineLabel(
    step: string | null | undefined
  ): void {
    const label = step == null ? "" : String(step).trim();
    this._sheetPipelineLabelCache = label;

    const n = extractPipelineStepNumberForSheet(step).trim();
    if (n !== "") {
      this._sheetStepColumnECache = n;
      return;
    }
    if (step != null && /^complete$/i.test(String(step).trim())) {
      this._sheetStepColumnECache = "Complete";
    }
  }

  /**
   * Lazily build the direct Google Sheets connector from the
   * GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON secret. Returns null (and caches
   * the null) when the secret is absent or malformed — the Sheet mirror
   * is then unavailable. The result is memoised per isolate.
   */
  private getDirectSheetsClient(): GoogleSheetsDirectClient | null {
    if (this._sheetsClient !== undefined) return this._sheetsClient;
    const json = this.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON;
    if (!json) {
      this._sheetsClient = null;
      return null;
    }
    try {
      this._sheetsClient =
        GoogleSheetsDirectClient.fromServiceAccountJson(json);
      this.log(
        "info",
        `Direct Google Sheets connector initialized (service account ${this._sheetsClient.clientEmail})`
      );
    } catch (err: unknown) {
      this.log(
        "warning",
        `Direct Google Sheets connector unavailable (bad GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON?): ${errMsg(err)}`
      );
      this._sheetsClient = null;
    }
    return this._sheetsClient;
  }

  /**
   * Returns the executor used for `GOOGLESHEETS_*` calls — the direct
   * service-account connector. Returns null when
   * GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON is absent or malformed (the sheet
   * mirror is then disabled; callers already treat null as "skip").
   */
  async getSheetsExecutor(): Promise<{
    execute: (slug: string, args: Record<string, unknown>) => Promise<unknown>;
  } | null> {
    const direct = this.getDirectSheetsClient();
    if (direct) {
      return {
        execute: (slug, args) => direct.execute(slug, args)
      };
    }
    return null;
  }

  /**
   * R2 JSON helpers. Used by the wireframe-ingest pipeline to persist
   * extraction artifacts under `wireframes/<slug>/*` in the IMAGES_R2
   * bucket (reused — same bucket serves both images and wireframes
   * under namespaced prefixes).
   */
  async putJsonR2(key: string, data: unknown): Promise<void> {
    await this.envBindings.IMAGES_R2.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
  }

  async getJsonR2<T = unknown>(key: string): Promise<T | null> {
    const obj = await this.envBindings.IMAGES_R2.get(key);
    if (!obj) return null;
    try {
      return (await obj.json()) as T;
    } catch (err: unknown) {
      this.log("warning", `Failed to parse R2 JSON for ${key}: ${errMsg(err)}`);
      return null;
    }
  }

  async putTextR2(
    key: string,
    text: string,
    contentType = "text/plain; charset=utf-8"
  ): Promise<void> {
    await this.envBindings.IMAGES_R2.put(key, text, {
      httpMetadata: { contentType }
    });
  }

  /**
   * Self-heal for Kimi K2.5 auth failures. When the OpenRouter binding on
   * the Worker is dead (expired / revoked), call the Doppler REST API
   * directly (basic auth with the DOPPLER_TOKEN service token) to pull
   * the current value from `replit-n8n-catsluvus/prd`. If Doppler has a
   * different (fresher) value, install it as an in-memory override via
   * `setRotatedOpenRouterKey()` so subsequent Kimi calls pick it up
   * without waiting for a redeploy.
   *
   * Returns the fresh key on successful rotation, or `null` when:
   *   - DOPPLER_TOKEN is unset or the API call fails
   *   - Doppler returned no value or the same dead value
   *   - The response shape was unparseable
   *
   * `context` is a short tag (e.g. "runKimiWithPoll", "writer-step-5") so
   * the activity log shows which call site triggered the rotation.
   */
  async rotateOpenRouterKeyFromDoppler(
    context: string
  ): Promise<string | null> {
    const dopplerToken = this.env.DOPPLER_TOKEN?.trim();
    if (!dopplerToken) {
      this.log(
        "warning",
        `Kimi 401 self-heal (${context}): DOPPLER_TOKEN not set — rotation skipped`
      );
      return null;
    }
    let result: unknown = null;
    try {
      const resp = await fetch(
        "https://api.doppler.com/v3/configs/config/secret?project=replit-n8n-catsluvus&config=prd&name=OPENROUTER_API_KEY",
        {
          headers: {
            Authorization: `Basic ${btoa(`${dopplerToken}:`)}`,
            Accept: "application/json"
          },
          signal: AbortSignal.timeout(10_000)
        }
      );
      if (resp.ok) result = await resp.json();
      else {
        this.log(
          "warning",
          `Kimi 401 self-heal (${context}): Doppler API HTTP ${resp.status} — rotation skipped`
        );
        return null;
      }
    } catch (err: unknown) {
      this.log(
        "warning",
        `Kimi 401 self-heal (${context}): Doppler fetch failed (${errMsg(err)}) — rotation skipped`
      );
      return null;
    }
    const fresh = extractDopplerSecretValue(result);
    const current = this.env.OPENROUTER_API_KEY?.trim() ?? "";
    if (!fresh) {
      this.log(
        "warning",
        `Kimi 401 self-heal (${context}): Doppler response missing value — upstream key rotation needed`
      );
      return null;
    }
    if (fresh === current) {
      this.log(
        "warning",
        `Kimi 401 self-heal (${context}): Doppler key matches Worker env — upstream key rotation needed at OpenRouter`
      );
      return null;
    }
    setRotatedOpenRouterKey(fresh);
    this.log(
      "info",
      `Kimi 401 self-heal (${context}): rotated OPENROUTER_API_KEY from Doppler — next Kimi call will use the fresh key`
    );
    return fresh;
  }

  /**
   * Registers Cloudflare's Code Mode MCP server when `CLOUDFLARE_API_TOKEN_SECRET`
   * is set (Bearer auth — suitable for Workers/DO). No-op without the secret.
   */
  private async ensureCloudflareMcpServer(): Promise<boolean> {
    const token = this.env.CLOUDFLARE_API_TOKEN_SECRET?.trim();
    if (!token) return false;

    const servers = this.mcp.listServers();
    const already = servers.some(
      (s) =>
        s.name === SEOArticleAgent.cloudflareMcpServerName &&
        String(s.server_url).includes("mcp.cloudflare.com")
    );
    if (already) {
      await this.mcp.waitForConnections({ timeout: 20_000 });
      return true;
    }

    try {
      await this.addMcpServer(
        SEOArticleAgent.cloudflareMcpServerName,
        SEOArticleAgent.cloudflareMcpUrl,
        {
          transport: {
            type: "streamable-http",
            headers: { Authorization: `Bearer ${token}` }
          }
        }
      );
      this.log(
        "info",
        "Cloudflare MCP (Code Mode) registered — search + execute tools available",
        "integrationEngineer",
        {
          kanbanStage: "done",
          mcpTool: "cloudflare-api: search, execute (registered)"
        }
      );
    } catch (err: unknown) {
      this.log(
        "warning",
        `Cloudflare MCP connect failed: ${errMsg(err)}`,
        "integrationEngineer",
        {
          kanbanStage: "debug",
          mcpTool: "cloudflare-api (connect failed)"
        }
      );
      return false;
    }

    await this.mcp.waitForConnections({ timeout: 20_000 });
    return true;
  }

  private getCloudflareMcpAiTools(): ToolSet {
    if (!this.env.CLOUDFLARE_API_TOKEN_SECRET?.trim()) {
      return {} as ToolSet;
    }
    return this.mcp.getAITools({
      serverName: SEOArticleAgent.cloudflareMcpServerName
    }) as ToolSet;
  }

  // ── Callable methods (dashboard controls) ──────────────────────────────────

  @callable()
  async start() {
    if (
      this.state.status === "generating" ||
      this.state.status === "scouting"
    ) {
      return { error: "Already running" };
    }
    this.setState({
      ...this.state,
      status: "scouting",
      currentCategory: null,
      currentKeyword: null,
      currentArticleSlug: null,
      currentStep: null,
      lastSheetStepLabel: ""
    });
    this.clearSheetStepColumnECache();
    this.log("info", "Autonomous mode started");
    // Run immediately, then every 5 minutes
    this.autonomousLoop();
    this.scheduleEvery(300, "autonomousLoop");
    // AI Observer tick — narrates worker state every 15 minutes. Runs
    // independently of autonomousLoop so observation continues even when
    // the article pipeline pauses. Also kick a one-shot tick now so the
    // dashboard panel shows its first observation in seconds, not 15
    // minutes — operators starting the worker want immediate signal.
    const observerSchedules = this.getSchedules();
    if (!observerSchedules.some((s) => s.callback === "observerTick")) {
      this.scheduleEvery(900, "observerTick");
    }
    // Fire-and-forget: observerTick wraps its own keepAlive + catch.
    // Outer .catch logs at info so a structural failure (e.g. method
    // missing, scheduler crash) is visible — observer never breaks the
    // start flow, but silent swallow makes debugging impossible.
    this.observerTick().catch((err: unknown) => {
      const msg =
        err instanceof Error ? err.message : String(err ?? "(no error)");
      this.log(
        "info",
        `Observer: immediate-on-start tick threw — ${msg}`,
        "observerAgent",
        { kanbanStage: "debug" }
      );
    });
    return { success: true };
  }

  @callable()
  async stop() {
    const schedules = this.getSchedules();
    for (const s of schedules) {
      this.cancelSchedule(s.id);
    }
    this.setState({
      ...this.state,
      status: "paused",
      currentCategory: null,
      currentKeyword: null,
      currentArticleSlug: null,
      currentStep: null,
      lastSheetStepLabel: ""
    });
    this.clearSheetStepColumnECache();
    this.log("info", "Autonomous mode stopped");
    return { success: true };
  }

  /**
   * Post-deploy verification of the Step 11.5 design-audit chain:
   *   - CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN_SECRET resolvable
   *   - Browser Rendering screenshot against `testUrl`
   *   - Workers AI Llava via AI Gateway
   * Returns a structured, serializable report. Safe to invoke from the UI
   * or HTTP (`POST /api/verify-design-audit`). Does NOT touch the article
   * pipeline or any persisted state other than the R2 screenshot bucket
   * (written to `design-audits/_verify/...`).
   */
  @callable()
  async verifyDesignAudit(testUrl?: string): Promise<{
    ok: boolean;
    accountIdPresent: boolean;
    apiTokenPresent: boolean;
    report: import("./pipeline/design-audit").DesignAuditReport | null;
    error?: string;
  }> {
    const url = (testUrl && testUrl.trim()) || `https://${this.env.DOMAIN}`;
    const accountIdPresent = !!this.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const apiTokenPresent = !!this.env.CLOUDFLARE_API_TOKEN_SECRET?.trim();
    try {
      const { runDesignAudit } = await import("./pipeline/design-audit");
      const report = await runDesignAudit(this, url, "_verify");
      // ok = chain executed end-to-end: env present, at least one
      // screenshot captured, and Llava returned without erroring on
      // any viewport. Zero issues with zero analysisErrors = clean
      // page. Zero issues with non-empty analysisErrors = vision
      // chain is broken and the report is NOT trustworthy.
      const ok =
        !report.skipped &&
        report.analysisErrors.length === 0 &&
        (!!report.desktopScreenshotKey || !!report.mobileScreenshotKey);
      return { ok, accountIdPresent, apiTokenPresent, report };
    } catch (err: unknown) {
      return {
        ok: false,
        accountIdPresent,
        apiTokenPresent,
        report: null,
        error: errMsg(err)
      };
    }
  }

  @callable()
  async status() {
    const cats = this.sql<{
      cnt: number;
    }>`SELECT COUNT(*) as cnt FROM categories WHERE status='completed'`;
    const arts = this.sql<{
      cnt: number;
    }>`SELECT COUNT(*) as cnt FROM articles`;
    const pending = this.sql<{
      cnt: number;
    }>`SELECT COUNT(*) as cnt FROM keywords WHERE status='pending'`;
    const schedules = this.getSchedules();
    const autonomousLoopScheduled = schedules.some(
      (s) => s.callback === "autonomousLoop"
    );
    return {
      ...this.state,
      activityStepNumber: this.resolveSheetStepColumnE(),
      dbCategories: cats[0]?.cnt ?? 0,
      dbArticles: arts[0]?.cnt ?? 0,
      dbPendingKeywords: pending[0]?.cnt ?? 0,
      autonomousLoopScheduled,
      scheduleCount: schedules.length
    };
  }

  @callable()
  async scoutNow() {
    this.setState({
      ...this.state,
      status: "scouting",
      currentCategory: null
    });
    this.log("info", "Manual scout triggered — claiming from Scout DB");
    const claimed = await this.claimNextScoutKeyword();
    if (claimed) {
      this.enqueueClaimedScoutKeyword(claimed);
      this.log(
        "info",
        `Scout DB: claimed "${claimed.keyword}" (${claimed.category_slug}) — queued`,
        "analyst",
        {
          categorySlug: claimed.category_slug,
          kanbanStage: "queue"
        }
      );
      this.setState({ ...this.state, status: "idle" });
      return claimed;
    }
    this.log(
      "warning",
      "Scout database empty — import keywords via POST /api/admin/keywords/import"
    );
    this.setState({ ...this.state, status: "idle" });
    return null;
  }

  @callable()
  async setGoogleSheet(input: { url: string }) {
    const raw = (input?.url || "").trim();
    if (!raw) return { error: "URL is required" };

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { error: "Invalid URL" };
    }

    if (parsed.protocol !== "https:") {
      return { error: "URL must start with https://" };
    }
    if (
      parsed.hostname !== "docs.google.com" ||
      !parsed.pathname.startsWith("/spreadsheets/")
    ) {
      return { error: "Please provide a valid Google Sheets URL" };
    }

    const normalized = parsed.toString();
    this
      .sql`INSERT INTO google_sheets (url, updated_at) VALUES (${normalized}, unixepoch())
      ON CONFLICT(url) DO UPDATE SET updated_at=excluded.updated_at`;
    const recent = this.sql<{ url: string; updated_at: number }>`
      SELECT url, updated_at FROM google_sheets ORDER BY updated_at DESC LIMIT 10`;

    this.setState({
      ...this.state,
      googleSheetUrl: normalized,
      sheetMirrorNextRow: null,
      recentGoogleSheets: recent.map((s) => ({
        url: s.url,
        updatedAt: s.updated_at
      })),
      activityLogSheetHeaderLayoutVersion: 0,
      scoutKeywordRoiSheetLayoutVersion: 0
    });
    this.log("info", `Google Sheet saved: ${normalized}`);

    return { success: true, googleSheetUrl: normalized };
  }

  /**
   * Writes row 1 for `A1:CA1` in **canonical column order** (logical A→CA =
   * physical A→CA). Log data rows still follow row 1 titles via permutation on
   * each mirror write. Bumps the stored layout version so mirrors skip redundant
   * header work until the next bump.
   */
  @callable()
  async syncActivityLogSheetHeaders() {
    const spreadsheetId = this.extractSpreadsheetId(this.state.googleSheetUrl);
    if (!spreadsheetId) {
      return { error: "No Google Sheet URL configured" };
    }
    if (!(await this.getSheetsExecutor())) {
      return { error: "No Sheets backend available" };
    }
    try {
      await this.writeActivityLogSheetHeaders(spreadsheetId, {
        matchLiveHeaderOrder: false
      });
      this.setState({
        ...this.state,
        activityLogSheetHeaderLayoutVersion:
          ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION
      });
      return { success: true };
    } catch (err: unknown) {
      return { error: errMsg(err) };
    }
  }

  /**
   * Ensures tab `Scout keyword ROI` exists and writes row 1 (A–L) plus
   * ARRAYFORMULA cells G2, J2, and K2 for commission and demand scores.
   */
  @callable()
  async syncScoutKeywordRoiSheet() {
    const spreadsheetId = this.extractSpreadsheetId(this.state.googleSheetUrl);
    if (!spreadsheetId) {
      return { error: "No Google Sheet URL configured" };
    }
    if (!(await this.getSheetsExecutor())) {
      return { error: "No Sheets backend available" };
    }
    try {
      await this.writeScoutKeywordRoiSheetLayout(spreadsheetId);
      this.setState({
        ...this.state,
        scoutKeywordRoiSheetLayoutVersion:
          SCOUT_KEYWORD_ROI_SHEET_LAYOUT_VERSION
      });
      return { success: true, tab: SCOUT_KEYWORD_ROI_SHEET_TAB_NAME };
    } catch (err: unknown) {
      const msg = errMsg(err);
      return { error: msg };
    }
  }

  @callable()
  async useRecentGoogleSheet(input: { url: string }) {
    return await this.setGoogleSheet(input);
  }

  /**
   * Published Article Editorial Agent — callable from the dashboard.
   * Fire-and-forget orchestrator: reads KV → browser-screenshots live page
   * → writes audit report → rewrites + republishes. Progress streams to
   * the dashboard under role=editorialAgent.
   */
  @callable()
  async editorialReview(input: {
    kvKey: string;
    referenceUrl?: string;
    applyFix?: boolean;
  }) {
    const kvKey = input?.kvKey?.trim();
    if (!kvKey) return { error: "kvKey is required" };
    if (typeof input?.applyFix === "boolean") {
      this.log(
        "warning",
        `Editorial Agent: ignored editorialReview applyFix=${input.applyFix}; rewrite mode is disabled and runs are report-only`,
        "editorialAgent"
      );
    }
    this.ctx.waitUntil(
      runEditorialAgent(this, {
        kvKey,
        referenceUrl: input.referenceUrl,
        // Re-enabled 2026-05-26 with the in-place rewrite behavior
        // (editorial-agent.ts replaces `kvKey` directly instead of
        // writing a `${kvKey}-b` variant that nothing consumed). Caller
        // can still opt out by passing `applyFix: false` explicitly.
        applyFix: input.applyFix !== false
      }).then(
        () => undefined,
        (err: unknown) => {
          this.log(
            "error",
            `Editorial Agent: orchestrator threw: ${errMsg(err)}`,
            "editorialAgent"
          );
        }
      )
    );
    return { success: true, accepted: true, kvKey };
  }

  @callable()
  async removeRecentGoogleSheet(input: { url: string }) {
    const url = (input?.url || "").trim();
    if (!url) return { error: "URL is required" };

    this.sql`DELETE FROM google_sheets WHERE url=${url}`;
    const recent = this.sql<{ url: string; updated_at: number }>`
      SELECT url, updated_at FROM google_sheets ORDER BY updated_at DESC LIMIT 10`;
    const nextActive = recent[0]?.url || null;

    this.setState({
      ...this.state,
      googleSheetUrl:
        this.state.googleSheetUrl === url
          ? nextActive
          : this.state.googleSheetUrl,
      sheetMirrorNextRow:
        this.state.googleSheetUrl === url
          ? null
          : this.state.sheetMirrorNextRow,
      scoutKeywordRoiSheetLayoutVersion:
        this.state.googleSheetUrl === url
          ? 0
          : this.state.scoutKeywordRoiSheetLayoutVersion,
      recentGoogleSheets: recent.map((s) => ({
        url: s.url,
        updatedAt: s.updated_at
      }))
    });
    this.log("info", `Google Sheet removed: ${url}`);
    return { success: true };
  }

  @callable()
  async generateOne(keyword: string, category: string) {
    const slug = keywordToSlug(keyword);
    this.clearSheetStepColumnECache();
    this.setState({
      ...this.state,
      status: "generating",
      currentKeyword: keyword,
      currentCategory: category,
      currentArticleSlug: slug,
      currentStep: "Starting..."
    });
    const { generateArticle } = await import("./pipeline/writer");
    const result = await generateArticle(this, keyword, slug, category);
    if (result.success) {
      if (result.seoScorecard) {
        const nextLastSeoScorecard = {
          keyword,
          url: result.url ?? "",
          score: result.seoScore ?? 0,
          pillars: result.seoScorecard.pillars,
          checks: result.seoScorecard.checks
        };
        const nextLastSeoScorecardQcPromptCells =
          Array.isArray(result.seoScorecardQcPromptCells) &&
          result.seoScorecardQcPromptCells.length ===
            ACTIVITY_LOG_SEO_CHECK_COUNT
            ? [...result.seoScorecardQcPromptCells]
            : null;
        this._pendingQcPromptCells = nextLastSeoScorecardQcPromptCells;
        this.setState({
          ...this.state,
          lastSeoScorecard: nextLastSeoScorecard,
          lastSeoScorecardQcPromptCells: null
        });
      }
      // Full success bookkeeping — identical to the autonomous loop's
      // path. Without this, generateOne-published articles never reached
      // the dashboard: articlesGenerated stayed frozen, the DO articles
      // table (dashboard data + analytics tick source) never got a row,
      // the keyword stayed pending, and the Scout DB outcome was never
      // written.
      const skipped =
        (result.seoScore ?? 0) === 0 && (result.wordCount ?? 0) === 0;
      const kwId = `${category}:${slug}`;
      this
        .sql`UPDATE keywords SET status='completed', seo_score=${result.seoScore ?? 0} WHERE id=${kwId}`;
      if (!skipped) {
        this
          .sql`INSERT OR IGNORE INTO articles (slug, category_slug, keyword, kv_key, url, seo_score, word_count)
          VALUES (${slug}, ${category}, ${keyword}, ${result.kvKey ?? ""}, ${result.url ?? ""}, ${result.seoScore ?? 0}, ${result.wordCount ?? 0})`;
        this
          .sql`UPDATE categories SET article_count = article_count + 1 WHERE slug=${category}`;
        this.setState({
          ...this.state,
          articlesGenerated: this.state.articlesGenerated + 1
        });
      }
      await this.updateScoutKeywordOutcome(
        slug,
        "published",
        result.kvKey ?? "",
        ""
      );
      const mirrorCompetitorUrl = this.state.currentCompetitorUrl?.trim() ?? "";
      this.log(
        "info",
        `generateOne complete: ${result.url ?? keyword} (SEO ${result.seoScore ?? 0})`,
        "orchestrator",
        {
          keyword,
          categorySlug: category,
          kanbanStage: "done",
          ...(mirrorCompetitorUrl !== ""
            ? { competitorUrl: mirrorCompetitorUrl }
            : {}),
          ...(typeof result.plagiarismPercentage === "number"
            ? {
                plagiarismPercentage: result.plagiarismPercentage
              }
            : {}),
          ...(typeof result.liveSeoContentOptimizerNotes === "string" &&
          result.liveSeoContentOptimizerNotes.trim() !== ""
            ? {
                liveSeoContentOptimizerNotes:
                  result.liveSeoContentOptimizerNotes
              }
            : {}),
          ...(typeof result.sissScore === "number"
            ? { sissScore: result.sissScore }
            : {}),
          ...(typeof result.sissDelta === "number"
            ? { sissDelta: result.sissDelta }
            : {}),
          ...(typeof result.quoraSeederSummary === "string" &&
          result.quoraSeederSummary.trim() !== ""
            ? { quoraSeederSummary: result.quoraSeederSummary }
            : {}),
          ...(typeof result.reverseLinksInjected === "number"
            ? { reverseLinksInjected: result.reverseLinksInjected }
            : {}),
          ...(result.rssFeedUrl != null
            ? { rssFeedUrl: result.rssFeedUrl }
            : {})
        }
      );
    } else {
      this.setState({
        ...this.state,
        articlesFailed: this.state.articlesFailed + 1
      });
      void this.updateScoutKeywordOutcome(
        slug,
        "failed",
        "",
        result.error ?? "unknown"
      );
      this.log(
        "error",
        `generateOne failed: ${result.error ?? "unknown"}`,
        "orchestrator",
        { keyword, categorySlug: category, kanbanStage: "debug" }
      );
    }
    this.setState({
      ...this.state,
      status: "idle",
      currentCategory: null,
      currentKeyword: null,
      currentArticleSlug: null,
      currentStep: null,
      currentCompetitorUrl: null
    });
    this.clearSheetStepColumnECache();
    return result;
  }

  @callable()
  async useAgentTools(prompt: string) {
    await this.ensureCloudflareMcpServer();
    await this.mcp.waitForConnections({ timeout: 20_000 });

    const cloudflareTools = this.getCloudflareMcpAiTools();
    const merged: ToolSet = {
      ...cloudflareTools,
      ...this.designAuditTools
    };

    if (Object.keys(merged).length === 0) {
      return {
        error: "No tools available: set CLOUDFLARE_API_TOKEN_SECRET"
      };
    }

    const cloudflareAddon =
      Object.keys(cloudflareTools).length > 0
        ? `\n\nOptional Cloudflare account API tools (MCP Code Mode: search + execute) are available. Use them only when the user needs Cloudflare API operations (DNS, Workers, R2, KV, etc.). Prefer read-only calls when unsure; do not exfiltrate secrets.`
        : "";

    const toolSystem = cloudflareAddon
      ? `You are a tool-using assistant.${cloudflareAddon}`
      : undefined;
    const result = await generateText({
      model: getKimiModel(this.env),
      providerOptions: getKimiProviderOptions(this.env),
      tools: merged,
      ...(toolSystem ? { system: toolSystem } : {}),
      prompt,
      stopWhen: stepCountIs(5)
    });
    const mcpNames = collectToolNamesFromGenerateTextResult(result);
    this.log(
      "info",
      `Agent tool task: ${prompt.slice(0, 60)}...`,
      "promptEngineer",
      {
        kanbanStage: "inProgress",
        modelPrompt: formatActivityLogModelPromptCell(toolSystem, prompt),
        ...(mcpNames !== "" ? { mcpTool: mcpNames } : {})
      }
    );
    return { text: result.text, steps: result.steps?.length ?? 0 };
  }

  /**
   * Runs an agent loop with only Cloudflare's Code Mode MCP tools (fixed small
   * tool surface — ~1k tokens for definitions). Requires `CLOUDFLARE_API_TOKEN_SECRET`.
   */
  @callable()
  async useCloudflareApiTool(prompt: string) {
    const ok = await this.ensureCloudflareMcpServer();
    await this.mcp.waitForConnections({ timeout: 20_000 });
    const tools = this.getCloudflareMcpAiTools();
    if (!ok || Object.keys(tools).length === 0) {
      return {
        error:
          "Cloudflare MCP unavailable: set CLOUDFLARE_API_TOKEN_SECRET with API token permissions you need"
      };
    }
    const cfMcpSystem = `You can call Cloudflare API operations via MCP Code Mode tools only (search: explore OpenAPI; execute: call cloudflare.request). Use the smallest number of calls. Prefer read-only operations unless the user clearly requests changes.`;
    const result = await generateText({
      model: getKimiModel(this.env),
      providerOptions: getKimiProviderOptions(this.env),
      tools,
      system: cfMcpSystem,
      prompt,
      stopWhen: stepCountIs(8)
    });
    const mcpNames = collectToolNamesFromGenerateTextResult(result);
    this.log(
      "info",
      `Cloudflare MCP task: ${prompt.slice(0, 60)}...`,
      "promptEngineer",
      {
        kanbanStage: "inProgress",
        modelPrompt: formatActivityLogModelPromptCell(cfMcpSystem, prompt),
        ...(mcpNames !== "" ? { mcpTool: mcpNames } : {})
      }
    );
    return { text: result.text, steps: result.steps?.length ?? 0 };
  }

  /**
   * Reads columns AY-BP from the Google Sheet for unprocessed action rows.
   * Rows with BC (Action) non-empty but BN (Status) empty are executed.
   */
  @callable()
  async processSheetActionQueue() {
    const sheetUrl = this.state.googleSheetUrl;
    if (!sheetUrl) {
      return { error: "No Google Sheet URL configured" };
    }
    const spreadsheetId = this.extractSpreadsheetId(sheetUrl);
    if (!spreadsheetId) {
      return { error: "Cannot parse spreadsheet ID" };
    }
    const sheets = await this.getSheetsExecutor();
    if (!sheets) {
      return { error: "No Sheets backend available" };
    }

    // Read columns AY-BP (Action through Files JSON) from rows 2-50
    const range = `${activityLogSheetTabQuoted()}!AY2:BP50`;
    const result = await this.withTimeout(
      sheets.execute("GOOGLESHEETS_BATCH_GET", {
        spreadsheet_id: spreadsheetId,
        ranges: range
      }),
      20_000,
      "Sheet action queue read timed out"
    );

    const rawRows = parseComposioSheetValuesGrid(result);
    const normalizeSheetRows = (rows: unknown): string[][] => {
      if (!Array.isArray(rows)) {
        return [];
      }

      return rows.map((row) => {
        if (!Array.isArray(row)) {
          return [];
        }
        return row.map((cell) => (typeof cell === "string" ? cell : ""));
      });
    };
    const rows = normalizeSheetRows(rawRows);

    let processed = 0;
    for (const [rowIndex, row] of rows.entries()) {
      // BC=index 4 (Action), BN=index 15 (Status) within AY-BP sub-range
      const action = row[4]?.trim();
      const status = row[15]?.trim();
      if (action && !status) {
        const sheetRowNumber = rowIndex + 2;
        this.log(
          "info",
          `Sheet queue: processing action "${action}" at row ${sheetRowNumber}`,
          "operations",
          {
            kanbanStage: "inProgress",
            actionType: action
          }
        );
        processed++;
      }
    }

    this.log(
      "info",
      `Sheet queue: ${processed} actions found, ${rows.length} rows scanned`,
      "orchestrator",
      { kanbanStage: processed > 0 ? "inProgress" : "done" }
    );

    return {
      scanned: rows.length,
      processed,
      status: "ok"
    };
  }

  // ── Analytics tick — DO RPC entry point for the every-minute scheduled() ───
  //
  // Worker scheduled() handler calls this via the DO stub. Pulls DataForSEO
  // Labs ranked-keywords for a small batch of stale published articles and
  // writes results into the DO-local `article_rankings` table. Powers the
  // Rankings dashboard panel + /api/admin/analytics/<kvKey> endpoint.
  async runAnalyticsTick(): Promise<AnalyticsTickResult> {
    const { runAnalyticsTick } = await import("./pipeline/analytics-tick");
    try {
      const result = await runAnalyticsTick(this);
      if (!result.ran && result.error) {
        this.log(
          "warning",
          `Analytics tick: stale-article query failed: ${result.error}`,
          "rankTracker"
        );
      }
      if (result.ran && result.pulled > 0) {
        this.log(
          "info",
          `Analytics tick complete: ${result.pulled} kvKeys, ${result.rowsInserted} ranking rows, ${result.errors} errors, ${result.zeroRankings} zero-ranking`,
          "rankTracker",
          { kanbanStage: "done" }
        );
      }
      return result;
    } catch (err: unknown) {
      this.log(
        "warning",
        `Analytics tick failed: ${errMsg(err)}`,
        "rankTracker"
      );
      return {
        ran: false,
        pulled: 0,
        rowsInserted: 0,
        errors: 0,
        zeroRankings: 0
      };
    }
  }

  // ── AI Observer tick (called by scheduleEvery every 15 min) ──────────────
  // Delegates to runObserverTick which builds a worker-state snapshot,
  // sends it to Kimi for a plain-English narrative, and writes the
  // verdict back into the activity log under role observerAgent. Method
  // exists on the agent so scheduleEvery's callback name resolves.
  async observerTick() {
    await this.keepAliveWhile(async () => {
      await runObserverTick(this);
    });
  }

  // ── Semantic codebase search (claude-context runtime) ────────────────────
  // Workers-compatible: direct HTTPS to Zilliz REST + OpenAI embeddings.
  // The npm package @zilliz/claude-context-core uses tree-sitter and
  // gRPC and won't bundle for CF Workers, so it lives in devDeps and
  // runs only in the CI indexer (scripts/index-codebase.mjs). Both
  // sides share the same Milvus collection.
  //
  // Callers: editorial-agent (find similar past defects), observer
  // (find runbook for a defect class), defect-escalate (attach code
  // surface hints to claude-fix issues). Gracefully no-ops when env
  // vars are missing.
  async searchCodebase(query: string, topK = 8) {
    const result = await searchCodebase(
      this.envBindings as unknown as CodebaseSearchEnv,
      query,
      topK
    );
    // Emit structured activity-log entries so the Infrastructure
    // Activity Monitor panel can render per-call rows for OpenAI
    // and Milvus. Format is parsable by the admin endpoints in
    // this file (search for "[OpenAI embed]" / "[Milvus search]").
    // Embed ts=<ISO> so the dashboard parsers can compute staleness
    // in a timezone-safe way regardless of the viewer's locale
    // (Copilot review feedback on #5480).
    const nowIso = new Date().toISOString();
    if (result.stats?.openai) {
      const s = result.stats.openai;
      const level = s.status === "error" ? "warning" : "info";
      const msg =
        `[OpenAI embed] ts=${nowIso} model=${s.model} tokens=${s.promptTokens} ` +
        `latency=${s.latencyMs}ms status=${s.status}` +
        (s.errorReason ? ` error="${s.errorReason.replace(/"/g, "'")}"` : "");
      this.log(level, msg, "apiCall");
    }
    if (result.stats?.milvus) {
      const s = result.stats.milvus;
      const level = s.status === "error" ? "warning" : "info";
      const msg =
        `[Milvus search] ts=${nowIso} collection=${s.collection} hits=${s.hits} ` +
        `latency=${s.latencyMs}ms status=${s.status}` +
        (s.errorReason ? ` error="${s.errorReason.replace(/"/g, "'")}"` : "");
      this.log(level, msg, "apiCall");
    }
    return result;
  }

  // ── Live quality probe (called by scheduleEvery every 30 min) ────────────
  // Samples newest articles from KV; records defect-findings for
  // patterns the pre-publish gates miss. Fire-and-forget; errors are
  // logged inside runLiveQualityProbe.
  async qualityProbeTick() {
    await this.keepAliveWhile(async () => {
      try {
        await runLiveQualityProbe(this);
      } catch (err: unknown) {
        this.log(
          "warning",
          `qualityProbeTick failed: ${err instanceof Error ? err.message : String(err)}`,
          "qualityProbe"
        );
      }
    });
  }

  // ── Top Seller Scout (called by scheduleEvery every 24h) ────────────────
  // Daily sweep of the 18 fixed Amazon browse-node categories for real
  // bestsellers — see runTopSellerScoutSweep for the actual work. Wrapped
  // in the same TOP_SELLER_SCOUT_TIMEOUT_MS wall-clock budget pattern
  // fixed in autonomousLoop (#14126): a single unbounded await anywhere
  // in a scheduled tick silently wedges that tick's schedule forever,
  // since Durable Object alarms are single-flight. That class of bug
  // already happened once this week; this tick doesn't get to repeat it.
  async topSellerScoutTick() {
    await this.keepAliveWhile(async () => {
      const timeoutSentinel = new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), TOP_SELLER_SCOUT_TIMEOUT_MS);
      });
      const raced = await Promise.race([
        runTopSellerScoutSweep(this).then(() => "done" as const),
        timeoutSentinel
      ]).catch((err: unknown) => {
        this.log(
          "warning",
          `topSellerScoutTick failed: ${errMsg(err)}`,
          "topSellerScout"
        );
        return "error" as const;
      });
      if (raced === "timeout") {
        this.log(
          "warning",
          `topSellerScoutTick exceeded ${TOP_SELLER_SCOUT_TIMEOUT_MS / 60_000}min wall-clock budget — abandoning wait so the next scheduled tick can still fire; the underlying sweep may still resolve in the background and its result is ignored`,
          "topSellerScout"
        );
      }
    });
  }

  // ── Autonomous loop (called by scheduleEvery) ──────────────────────────────

  /**
   * Shared bookkeeping for a keyword that failed this generation attempt:
   * bumps retry_count, moves it to 'abandoned' once MAX_KEYWORD_RETRIES is
   * hit (instead of resurrecting to 'pending' forever), logs, and clears
   * the in-flight display state. Does NOT escalate to the Coding Agent —
   * ordinary pipeline failures already escalate from inside writer.ts at
   * the specific failure site; callers that bypass that (e.g. a wall-clock
   * timeout) must escalate themselves with the right errorCategory.
   */
  private recordKeywordFailure(
    kw: {
      id: string;
      keyword: string;
      retry_count: number;
      category_slug: string;
    },
    errorMessage: string
  ) {
    // Best-effort Scout-DB write-back (fire-and-forget; matches by slug).
    void this.updateScoutKeywordOutcome(
      keywordToSlug(kw.keyword),
      "failed",
      "",
      errorMessage
    );
    const nextRetryCount = kw.retry_count + 1;
    if (nextRetryCount >= MAX_KEYWORD_RETRIES) {
      this
        .sql`UPDATE keywords SET status='abandoned', retry_count=${nextRetryCount} WHERE id=${kw.id}`;
      this.log(
        "error",
        `Abandoned after ${nextRetryCount} failed attempts: ${kw.keyword} — ${errorMessage}`,
        "orchestrator",
        { kanbanStage: "debug", categorySlug: kw.category_slug }
      );
    } else {
      this
        .sql`UPDATE keywords SET status='failed', retry_count=${nextRetryCount} WHERE id=${kw.id}`;
      this.log(
        "error",
        `Failed: ${kw.keyword} — ${errorMessage}`,
        "orchestrator",
        { kanbanStage: "debug", categorySlug: kw.category_slug }
      );
    }
    this.setState({
      ...this.state,
      articlesFailed: this.state.articlesFailed + 1,
      currentStep: null,
      currentKeyword: null,
      currentArticleSlug: null,
      currentCategory: null,
      currentCompetitorUrl: null,
      lastSeoScorecardQcPromptCells: null
    });
    this.clearSheetStepColumnECache();
  }

  /**
   * Atomically claim the highest-priority pending keyword from the Scout
   * Database (KEYWORDS_DB D1). Returns null when the queue is empty — the
   * scout NEVER invents keywords; rows arrive only via
   * POST /api/admin/keywords/import (or a future refill-producer).
   */
  private async claimNextScoutKeyword(): Promise<{
    keyword: string;
    slug: string;
    category_slug: string;
    category_title: string;
  } | null> {
    const db = this.env.KEYWORDS_DB;
    if (!db) {
      this.log(
        "warning",
        "Scout DB unavailable (KEYWORDS_DB binding missing) — cannot claim keywords",
        "analyst"
      );
      return null;
    }
    try {
      const res = await db
        .prepare(
          `UPDATE scout_keywords
              SET status = 'generating', claimed_at = datetime('now')
            WHERE id = (SELECT id FROM scout_keywords
                         WHERE status = 'pending'
                         ORDER BY priority DESC, volume DESC, id ASC
                         LIMIT 1)
            RETURNING keyword, slug, category_slug, category_title`
        )
        .all<{
          keyword: string;
          slug: string;
          category_slug: string;
          category_title: string;
        }>();
      return res.results?.[0] ?? null;
    } catch (err: unknown) {
      this.log("warning", `Scout DB claim failed: ${errMsg(err)}`, "analyst");
      return null;
    }
  }

  /**
   * Best-effort outcome write-back to the Scout Database. Matches by
   * slug; a row that was never claimed from the DB (e.g. a manual
   * generateOne with a novel keyword) is simply not present and the
   * UPDATE is a no-op. Never throws.
   */
  private async updateScoutKeywordOutcome(
    slug: string,
    status: "published" | "failed",
    kvKey: string,
    error: string
  ): Promise<void> {
    const db = this.env.KEYWORDS_DB;
    if (!db) return;
    try {
      await db
        .prepare(
          `UPDATE scout_keywords
              SET status = ?1, kv_key = ?2, error = ?3,
                  finished_at = datetime('now')
            WHERE slug = ?4 AND status = 'generating'`
        )
        .bind(status, kvKey, error.slice(0, 500), slug)
        .run();
    } catch (err: unknown) {
      this.log(
        "warning",
        `Scout DB outcome write-back failed for ${slug}: ${errMsg(err)}`,
        "analyst"
      );
    }
  }

  /**
   * Copy a claimed Scout-DB row into the DO's runtime tables so the
   * existing 24-step pipeline runs unchanged.
   */
  private enqueueClaimedScoutKeyword(claimed: {
    keyword: string;
    slug: string;
    category_slug: string;
    category_title: string;
  }): void {
    const categoryName =
      claimed.category_title.trim() || claimed.category_slug.replace(/-/g, " ");
    this.sql`INSERT OR IGNORE INTO categories (slug, name, status)
      VALUES (${claimed.category_slug}, ${categoryName}, 'in_progress')`;
    const runtimeSlug = keywordToSlug(claimed.keyword);
    const id = `${claimed.category_slug}:${runtimeSlug}`;
    this
      .sql`INSERT OR IGNORE INTO keywords (id, category_slug, keyword, slug, status)
      VALUES (${id}, ${claimed.category_slug}, ${claimed.keyword}, ${runtimeSlug}, 'pending')`;
  }

  async autonomousLoop() {
    await this.keepAliveWhile(async () => {
      try {
        // #region agent log
        emitAgentDebugLog(this, {
          hypothesisId: "H6",
          location: "server.ts:autonomousLoop:entry",
          message: "loop_tick",
          data: { status: this.state.status },
          runId: "pre-fix"
        });
        // #endregion

        // 1. Find next pending keyword
        const pending = this.sql<{
          id: string;
          keyword: string;
          slug: string;
          category_slug: string;
          retry_count: number;
        }>`SELECT id, keyword, slug, category_slug, retry_count FROM keywords WHERE status='pending' ORDER BY ROWID LIMIT 1`;

        // #region agent log
        emitAgentDebugLog(this, {
          hypothesisId: "H1",
          location: "server.ts:autonomousLoop:pending",
          message: "pending_query",
          data: {
            pendingCount: pending.length,
            status: this.state.status,
            firstSlug: pending[0]?.slug ?? null,
            firstCategory: pending[0]?.category_slug ?? null
          },
          runId: "pre-fix"
        });
        // #endregion

        if (pending.length === 0) {
          // No pending runtime keywords — claim the next one from the
          // Scout Database. The scout never invents keywords: an empty
          // queue means the loop idles until keywords are imported.
          this.setState({
            ...this.state,
            status: "scouting",
            currentCategory: null
          });
          const claimed = await this.claimNextScoutKeyword();
          // #region agent log
          emitAgentDebugLog(this, {
            hypothesisId: "H1",
            location: "server.ts:autonomousLoop:scout",
            message: "scout_db_claim",
            data: {
              claimed: Boolean(claimed),
              slug: claimed?.slug ?? null,
              categorySlug: claimed?.category_slug ?? null
            },
            runId: "pre-fix"
          });
          // #endregion
          if (!claimed) {
            this.log(
              "info",
              "Scout database empty — import keywords via POST /api/admin/keywords/import — idling",
              "orchestrator",
              { kanbanStage: "done" }
            );
            this.setState({ ...this.state, status: "idle" });
            return;
          }
          this.enqueueClaimedScoutKeyword(claimed);
          this.log(
            "info",
            `Scout DB: claimed "${claimed.keyword}" (${claimed.category_slug}) — queued`,
            "analyst",
            {
              kanbanStage: "queue",
              categorySlug: claimed.category_slug
            }
          );
          // Next loop iteration will pick up the keyword
          return;
        }

        // 2. Generate article for next keyword
        const pendingKeyword = pending[0];
        const nextSlug = keywordToSlug(pendingKeyword.keyword);
        const kw =
          pendingKeyword.slug === nextSlug
            ? pendingKeyword
            : {
                ...pendingKeyword,
                id: `${pendingKeyword.category_slug}:${nextSlug}`,
                slug: nextSlug
              };
        if (pendingKeyword.slug !== nextSlug) {
          this.sql`UPDATE keywords
            SET id=${kw.id},
                slug=${kw.slug}
            WHERE id=${pendingKeyword.id}`;
        }
        const firstStep = "0/18: KV Check";
        this.setState({
          ...this.state,
          status: "generating",
          currentKeyword: kw.keyword,
          currentCategory: kw.category_slug,
          currentArticleSlug: kw.slug,
          currentStep: firstStep,
          lastSheetStepLabel: extractPipelineStepNumberForSheet(firstStep)
        });
        this.bumpSheetStepColumnECacheFromPipelineLabel(firstStep);
        this.sql`UPDATE keywords SET status='generating' WHERE id=${kw.id}`;

        const { generateArticle } = await import("./pipeline/writer");
        const timeoutSentinel = new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), ARTICLE_PIPELINE_TIMEOUT_MS);
        });
        const raced = await Promise.race([
          generateArticle(this, kw.keyword, kw.slug, kw.category_slug),
          timeoutSentinel
        ]);
        if (raced === "timeout") {
          const errorMessage = `Pipeline wall-clock budget exceeded (${ARTICLE_PIPELINE_TIMEOUT_MS / 60_000}min) for "${kw.keyword}" — abandoning the wait so the autonomous loop can continue; the underlying call may still resolve in the background and its result is ignored.`;
          this.recordKeywordFailure(kw, errorMessage);
          await escalateToCodingAgent(this, {
            kvKey: `${kw.category_slug}:${kw.slug}`,
            keyword: kw.keyword,
            categorySlug: kw.category_slug,
            errorCategory: "pipeline-hang-timeout",
            errorMessage
          });
          // Check if category is complete now that this keyword is done
          // (mirrors the check at the end of the normal success/failure
          // path below — a timed-out keyword still needs this so the
          // category doesn't stay "in progress" forever).
          const remainingAfterTimeout = this.sql<{ cnt: number }>`
            SELECT COUNT(*) as cnt FROM keywords WHERE category_slug=${kw.category_slug} AND status='pending'`;
          if ((remainingAfterTimeout[0]?.cnt ?? 0) === 0) {
            this
              .sql`UPDATE categories SET status='completed' WHERE slug=${kw.category_slug}`;
            this.setState({
              ...this.state,
              categoriesCompleted: this.state.categoriesCompleted + 1
            });
          }
          return;
        }
        const result = raced;

        // #region agent log
        emitAgentDebugLog(this, {
          hypothesisId: "H2-H3-H4",
          location: "server.ts:autonomousLoop:after_generateArticle",
          message: "generateArticle_result",
          data: {
            success: result.success,
            seoScore: result.seoScore ?? null,
            wordCount: result.wordCount ?? null,
            error: result.error ?? null,
            skippedWillBe:
              result.success &&
              (result.seoScore ?? 0) === 0 &&
              (result.wordCount ?? 0) === 0,
            slug: kw.slug,
            category_slug: kw.category_slug
          },
          runId: "pre-fix"
        });
        // #endregion

        if (result.success) {
          const skipped =
            (result.seoScore ?? 0) === 0 && (result.wordCount ?? 0) === 0;
          this
            .sql`UPDATE keywords SET status='completed', seo_score=${result.seoScore ?? 0} WHERE id=${kw.id}`;
          await this.updateScoutKeywordOutcome(
            kw.slug,
            "published",
            result.kvKey ?? "",
            ""
          );
          if (!skipped) {
            this
              .sql`INSERT OR IGNORE INTO articles (slug, category_slug, keyword, kv_key, url, seo_score, word_count)
              VALUES (${kw.slug}, ${kw.category_slug}, ${kw.keyword}, ${result.kvKey ?? ""}, ${result.url ?? ""}, ${result.seoScore ?? 0}, ${result.wordCount ?? 0})`;
            this
              .sql`UPDATE categories SET article_count = article_count + 1 WHERE slug=${kw.category_slug}`;
            const mirrorCompetitorUrl =
              this.state.currentCompetitorUrl?.trim() ?? "";
            const nextLastSeoScorecard = result.seoScorecard
              ? {
                  keyword: kw.keyword,
                  url: result.url ?? "",
                  score: result.seoScore ?? 0,
                  pillars: result.seoScorecard.pillars,
                  checks: result.seoScorecard.checks
                }
              : this.state.lastSeoScorecard;
            const nextLastSeoScorecardQcPromptCells =
              Array.isArray(result.seoScorecardQcPromptCells) &&
              result.seoScorecardQcPromptCells.length ===
                ACTIVITY_LOG_SEO_CHECK_COUNT
                ? [...result.seoScorecardQcPromptCells]
                : null;

            // `log()` reads `lastSeoScorecard*` from state for CB–JS mirror cells.
            // Apply scorecard before the Published row so failed check pass/fail
            // bits land on the same sheet row.  QC prompt cells are large
            // (up to 27 KB × 100 checks) and must NOT be stored in persisted
            // DO state — they are parked in `_pendingQcPromptCells` and consumed
            // by the very next `log()` call without touching SQLite state.
            this._pendingQcPromptCells = nextLastSeoScorecardQcPromptCells;
            this.setState({
              ...this.state,
              lastSeoScorecard: nextLastSeoScorecard,
              lastSeoScorecardQcPromptCells: null
            });

            let articleGithubBackupDetail = "skipped: no html or kv key";
            if (result.html && result.kvKey) {
              const gh = await this.publishArticleToGitHub(
                result.kvKey,
                result.html,
                kw.keyword,
                kw.slug,
                kw.category_slug,
                result.seoScore ?? 0,
                result.wordCount ?? 0,
                { silent: true }
              );
              articleGithubBackupDetail = gh.detail;
            }

            this.log(
              "info",
              `Published: ${result.url ?? "(no URL returned)"} (SEO ${result.seoScore ?? 0})`,
              "operations",
              {
                categorySlug: kw.category_slug,
                kanbanStage: "done",
                keyword: kw.keyword,
                ...(mirrorCompetitorUrl !== ""
                  ? { competitorUrl: mirrorCompetitorUrl }
                  : {}),
                actionType: "deploy-kv",
                actionSubStatuses: [
                  `KV: ${result.kvKey ?? "?"}`,
                  `SEO: ${result.seoScore ?? 0}/100`,
                  `Words: ${result.wordCount ?? 0}`
                ],
                kvKey: result.kvKey,
                articleText: result.html
                  ? result.html.replace(/<[^>]*>/g, "")
                  : undefined,
                articleWordCount: result.wordCount,
                articleSectionCount: result.sectionCount,
                articleFaqCount: result.faqCount,
                articleJson: result.articleData
                  ? JSON.stringify({
                      title: result.articleData.title,
                      metaDescription: result.articleData.metaDescription,
                      wordCount: result.wordCount,
                      seoScore: result.seoScore,
                      sections: result.sectionCount,
                      faqs: result.faqCount
                    })
                  : undefined,
                seoScore: result.seoScore,
                seoVerdict: (result.seoScore ?? 0) >= 70 ? "pass" : "fail",
                seoPillarSummary: result.seoScorecard
                  ? Object.entries(result.seoScorecard.pillars)
                      .map(([p, v]) => `${p} ${v.passed}/${v.total}`)
                      .join(" | ")
                  : undefined,
                seoFixList: result.seoScorecard?.checks
                  .filter((c) => !c.passed)
                  .map((c) => `${c.name}: ${c.detail}`),
                ...(typeof result.plagiarismPercentage === "number"
                  ? {
                      plagiarismPercentage: result.plagiarismPercentage
                    }
                  : {}),
                ...(typeof result.liveSeoContentOptimizerNotes === "string" &&
                result.liveSeoContentOptimizerNotes.trim() !== ""
                  ? {
                      liveSeoContentOptimizerNotes:
                        result.liveSeoContentOptimizerNotes
                    }
                  : {}),
                ...(typeof result.sissScore === "number"
                  ? { sissScore: result.sissScore }
                  : {}),
                ...(typeof result.sissDelta === "number"
                  ? { sissDelta: result.sissDelta }
                  : {}),
                ...(typeof result.quoraSeederSummary === "string" &&
                result.quoraSeederSummary.trim() !== ""
                  ? {
                      quoraSeederSummary: result.quoraSeederSummary
                    }
                  : {}),
                ...(typeof result.reverseLinksInjected === "number"
                  ? {
                      reverseLinksInjected: result.reverseLinksInjected
                    }
                  : {}),
                ...(result.rssFeedUrl != null
                  ? { rssFeedUrl: result.rssFeedUrl }
                  : {}),
                articleBackedUpToGithub: articleGithubBackupDetail
              }
            );
            const publishedRow = {
              slug: this.state.currentArticleSlug ?? "",
              keyword: kw.keyword,
              categorySlug: kw.category_slug,
              url: result.url ?? "",
              kvKey: result.kvKey ?? "",
              seoScore: result.seoScore ?? 0,
              wordCount: result.wordCount ?? 0,
              publishedAt: Date.now()
            };
            const nextRecentPublished = [
              publishedRow,
              ...(this.state.recentPublishedArticles ?? [])
            ].slice(0, 50);
            this.setState({
              ...this.state,
              articlesGenerated: this.state.articlesGenerated + 1,
              currentStep: null,
              currentKeyword: null,
              currentArticleSlug: null,
              currentCategory: null,
              currentCompetitorUrl: null,
              lastSeoScorecard: nextLastSeoScorecard,
              lastSeoScorecardQcPromptCells: null,
              recentPublishedArticles: nextRecentPublished
            });
            this.clearSheetStepColumnECache();
            this.refreshAvgSeoScore();

            // Fire the Published Article Editorial Agent on every publish.
            // Runs async (ctx.waitUntil) so it doesn't block the pipeline
            // loop — browser-screenshot + rewrite takes ~2-3 min per article.
            // Reference URL is selected per category; defaults to the NYT
            // Wirecutter benchmark when no category-specific match exists.
            if (result.kvKey) {
              const referenceUrl = pickEditorialReferenceUrl(kw.category_slug);
              this.ctx.waitUntil(
                runEditorialAgent(this, {
                  kvKey: result.kvKey,
                  referenceUrl,
                  // Re-enabled 2026-05-26: editorial rewrite is now
                  // applied in place (overwrites kvKey) instead of
                  // writing a variant-B that never went live. Every
                  // successful publish now gets one auto-improvement
                  // pass before the autonomous loop moves on.
                  applyFix: true
                }).then(
                  () => undefined,
                  (err: unknown) => {
                    this.log(
                      "error",
                      `Editorial Agent: post-publish orchestrator threw for ${result.kvKey}: ${errMsg(err)}`,
                      "editorialAgent"
                    );
                  }
                )
              );
            }
          } else {
            this.setState({
              ...this.state,
              currentStep: null,
              currentKeyword: null,
              currentArticleSlug: null,
              currentCategory: null,
              currentCompetitorUrl: null,
              lastSeoScorecardQcPromptCells: null
            });
            this.clearSheetStepColumnECache();
          }
        } else {
          this.recordKeywordFailure(kw, result.error ?? "unknown error");
        }

        // Check if category is complete
        const remaining = this.sql<{ cnt: number }>`
          SELECT COUNT(*) as cnt FROM keywords WHERE category_slug=${kw.category_slug} AND status='pending'`;
        if ((remaining[0]?.cnt ?? 0) === 0) {
          this
            .sql`UPDATE categories SET status='completed' WHERE slug=${kw.category_slug}`;
          this.setState({
            ...this.state,
            categoriesCompleted: this.state.categoriesCompleted + 1
          });
          this.log(
            "info",
            `Category complete: ${kw.category_slug}`,
            "orchestrator",
            {
              kanbanStage: "done",
              categorySlug: kw.category_slug
            }
          );
        }
      } catch (err: unknown) {
        // #region agent log
        emitAgentDebugLog(this, {
          hypothesisId: "H5",
          location: "server.ts:autonomousLoop:catch",
          message: "loop_throw",
          data: {
            err: errMsg(err)
          },
          runId: "pre-fix"
        });
        // #endregion
        const isDoReset = isDurableObjectResetError(err);
        // For DO reset errors: skip the log() + setState() calls because the DO
        // storage is unavailable. The keyword remains in 'generating' because no
        // state updates occur at all — onStart() resets 'generating' → 'pending'
        // on the next startup so the article is automatically retried.
        if (!isDoReset) {
          this.log("error", `Loop error: ${errMsg(err)}`, "orchestrator", {
            kanbanStage: "debug"
          });
          try {
            this.setState({
              ...this.state,
              status: "idle",
              currentStep: null,
              currentKeyword: null,
              currentArticleSlug: null,
              currentCategory: null,
              currentCompetitorUrl: null
            });
          } catch (setStateErr: unknown) {
            // Log unexpected setState failures so they aren't silently lost.
            // (DO reset errors never reach here since we already checked above.)
            this.log(
              "error",
              `Loop: setState failed after error — ${errMsg(setStateErr)}`,
              "orchestrator",
              { kanbanStage: "debug" }
            );
          }
          this.clearSheetStepColumnECache();
        }
      }
    });
  }

  // ── HTTP handler (for /api/logs and /api/status) ────────────────────────────

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parseBearerToken = (authHeader: string): string => {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      return match?.[1]?.trim() ?? "";
    };
    const readJsonObject = async (): Promise<Record<string, unknown>> => {
      try {
        const parsed = await request.json();
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    };

    // ── /api/n8n/* — bearer-token protected log-ingest surface for n8n ──
    // Authenticated with the same N8N_WEBHOOK_SECRET used to sign outbound
    // publish-success webhooks. Distinct trust boundary from ADMIN_API_TOKEN
    // — n8n cannot reach /api/admin/* with this token, only /api/n8n/*.
    if (url.pathname.startsWith("/api/n8n/")) {
      const expected = getEnvBinding(this.env, "N8N_WEBHOOK_SECRET");
      const provided = parseBearerToken(
        request.headers.get("authorization") ?? ""
      );
      if (!expected || !provided || !safeEqual(provided, expected)) {
        return Response.json(
          { ok: false, error: "unauthorized" },
          { status: 401 }
        );
      }

      // POST /api/n8n/log — n8n posts back status entries which appear in
      // the dashboard's n8n panel under role "n8n".
      // Body: { level: "info"|"warning"|"warn"|"error"|"err", msg|message, workflowId?, executionId? }
      if (url.pathname === "/api/n8n/log" && request.method === "POST") {
        const body = await readJsonObject();
        const parsedPayload = parseExternalLogPayload(body);
        if ("error" in parsedPayload) {
          return Response.json(
            { ok: false, error: parsedPayload.error },
            { status: 400 }
          );
        }
        const wfId = normalizeExternalLogTagField(body.workflowId);
        const execId = normalizeExternalLogTagField(body.executionId);
        const tag =
          wfId || execId
            ? `[${wfId ? `wf:${wfId}` : ""}${wfId && execId ? " " : ""}${execId ? `exec:${execId}` : ""}] `
            : "";
        this.log(parsedPayload.level, `${tag}${parsedPayload.msg}`, "n8n", {
          kanbanStage: "debug"
        });
        return Response.json({ ok: true });
      }

      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }

    // ── /api/dashboard/* — read-only data feeds for the dashboard ──────────
    // Used by the React Infrastructure Activity Monitor panel. NOT bearer-
    // gated — the dashboard cookie wall (DASHBOARD_PASSWORD, line ~6795)
    // protects same-origin browser access, and these endpoints return
    // observability data only (no admin actions, no secrets). Browser
    // cookies are sent automatically; the panel does NOT carry
    // ADMIN_API_TOKEN — fixes the 401-on-load issue from #5480 review.
    // Clear the errors-only ring buffer. Cookie-authed like the other
    // dashboard routes — the panel's "Clear" button calls this and the
    // state broadcast refreshes every connected client automatically.
    if (
      url.pathname === "/api/dashboard/clear-errors" &&
      request.method === "POST"
    ) {
      const prevCount = Array.isArray(this.state.activityLogErrors)
        ? this.state.activityLogErrors.length
        : 0;
      this.setState({ ...this.state, activityLogErrors: [] });
      this.log(
        "info",
        `Errors panel cleared from dashboard (${prevCount} entries dropped)`
      );
      return Response.json({ ok: true, cleared: prevCount });
    }

    // Clear warning-level entries. Warnings have no dedicated ring — they
    // live in the rolling main activity log (and sometimes the observer
    // ring), so clearing filters those buffers in place. Info/error rows
    // are untouched.
    if (
      url.pathname === "/api/dashboard/clear-warnings" &&
      request.method === "POST"
    ) {
      const isWarning = (e: unknown): boolean =>
        !!e &&
        typeof e === "object" &&
        isActivityLogWarningLevel((e as { level?: string }).level ?? "");
      const prevLog = Array.isArray(this.state.activityLog)
        ? this.state.activityLog
        : [];
      const prevObserver = Array.isArray(this.state.observerLog)
        ? this.state.observerLog
        : [];
      const nextLog = prevLog.filter((e) => !isWarning(e));
      const nextObserver = prevObserver.filter((e) => !isWarning(e));
      const cleared =
        prevLog.length -
        nextLog.length +
        (prevObserver.length - nextObserver.length);
      this.setState({
        ...this.state,
        activityLog: nextLog,
        observerLog: nextObserver
      });
      this.log(
        "info",
        `Warnings panel cleared from dashboard (${cleared} entries dropped)`
      );
      return Response.json({ ok: true, cleared });
    }

    if (
      url.pathname === "/api/dashboard/openai-activity" &&
      request.method === "GET"
    ) {
      const limit = parseAdminLimit(url.searchParams.get("limit"), 50, 200);
      const entries = filterObjectArrayEntries<ActivityLogEntry>(
        this.state.activityLog
      );
      const openaiRows = entries
        .filter(
          (e) =>
            e.activeRole === "apiCall" &&
            typeof e.msg === "string" &&
            e.msg.startsWith("[OpenAI ")
        )
        .slice(-limit)
        .reverse()
        .map((e) => parseOpenAiActivityMsg(e));
      const stats = aggregateOpenAiCalls(
        openaiRows.map((r) => ({
          model: r.model,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          isError: r.status === "error"
        }))
      );
      return Response.json({
        ok: true,
        window: { count: openaiRows.length, limit },
        rows: openaiRows,
        stats: {
          ...stats,
          estimatedUsdTotalFormatted: formatUsdCompact(stats.estimatedUsdTotal)
        }
      });
    }

    if (
      url.pathname === "/api/dashboard/milvus-activity" &&
      request.method === "GET"
    ) {
      const limit = parseAdminLimit(url.searchParams.get("limit"), 50, 200);
      const entries = filterObjectArrayEntries<ActivityLogEntry>(
        this.state.activityLog
      );
      const milvusRows = entries
        .filter(
          (e) =>
            e.activeRole === "apiCall" &&
            typeof e.msg === "string" &&
            e.msg.startsWith("[Milvus ")
        )
        .slice(-limit)
        .reverse()
        .map((e) => parseMilvusActivityMsg(e));
      const env = this.envBindings as {
        MILVUS_ADDRESS?: string;
        MILVUS_TOKEN?: string;
        MILVUS_COLLECTION?: string;
      };
      let collection: {
        name: string;
        vectorCount: number | null;
        ok: boolean;
        reason?: string;
      } | null = null;
      if (env.MILVUS_ADDRESS?.trim() && env.MILVUS_TOKEN?.trim()) {
        const name = env.MILVUS_COLLECTION?.trim() || "code_chunks";
        collection = await fetchMilvusCollectionStats(
          env.MILVUS_ADDRESS,
          env.MILVUS_TOKEN,
          name
        );
      }
      return Response.json({
        ok: true,
        window: { count: milvusRows.length, limit },
        rows: milvusRows,
        collection
      });
    }

    if (
      url.pathname === "/api/dashboard/github-events" &&
      request.method === "GET"
    ) {
      const limit = parseAdminLimit(url.searchParams.get("limit"), 25, 100);
      const ghToken = this.envBindings.GITHUB_TOKEN_SECRET?.trim();
      if (!ghToken) {
        return Response.json({
          ok: true,
          available: false,
          reason: "GITHUB_TOKEN_SECRET not set",
          workflowRuns: [],
          pullRequests: []
        });
      }
      const repo = `${this.envBindings.REPO_OWNER?.trim() || "techfundoffice"}/${this.envBindings.REPO_NAME?.trim() || "cats-seo-aiagent-cloudflare"}`;
      const events = await fetchGitHubEvents(repo, ghToken, limit);
      return Response.json({
        ok: true,
        available: true,
        repo,
        ...events
      });
    }

    // GET /api/observer-history?limit=N — durable observer-tick history
    // backed by KV (`observer-tick:<ISO>`, 7-day TTL). The in-memory
    // `state.observerLog` ring caps at 40 entries which can evict during
    // a long pipeline burst, leaving the dashboard panel blank between
    // 15-min ticks. This endpoint reads from KV so the panel always has
    // at least the last 7 days of ticks regardless of DO state churn.
    if (url.pathname === "/api/observer-history" && request.method === "GET") {
      const limit = parseAdminLimit(url.searchParams.get("limit"), 20, 200);
      try {
        const list = await this.envBindings.ARTICLES_KV.list({
          prefix: "observer-tick:",
          limit: Math.min(1000, limit * 4)
        });
        // Keys are `observer-tick:<ISO>` — lexicographic sort over ISO
        // timestamps equals chronological sort. Take newest `limit`.
        const newestKeys = list.keys
          .map((k) => k.name)
          .sort()
          .slice(-limit)
          .reverse();
        const ticks = await Promise.all(
          newestKeys.map(async (key) => {
            try {
              const raw = await this.envBindings.ARTICLES_KV.get(key);
              if (!raw) return null;
              return JSON.parse(raw) as {
                ts: string;
                narrative: string;
                context?: unknown;
              };
            } catch {
              return null;
            }
          })
        );
        return Response.json({
          ok: true,
          count: ticks.filter((t) => t !== null).length,
          ticks: ticks.filter((t) => t !== null)
        });
      } catch (err: unknown) {
        return Response.json(
          { ok: false, error: errMsg(err), ticks: [] },
          { status: 200 }
        );
      }
    }

    // ── /api/admin/* — bearer-token protected debug/control surface ─────
    // Used by the autonomous GitHub workflows (Coding Agent + Repo Agent) to
    // read worker state (logs, KV, keyword DB) and trigger retries without
    // shipping Cloudflare API credentials out of this Worker. Token is a Worker secret
    // `ADMIN_API_TOKEN`; callers send `Authorization: Bearer <token>`.
    if (url.pathname.startsWith("/api/admin/")) {
      const expected = getEnvBinding(this.env, "ADMIN_API_TOKEN");
      const provided = parseBearerToken(
        request.headers.get("authorization") ?? ""
      );
      if (!expected || !provided || !safeEqual(provided, expected)) {
        return Response.json(
          { ok: false, error: "unauthorized" },
          { status: 401 }
        );
      }

      const decodeAdminKey = (
        rawPathKey: string
      ): { kvKey: string | null; invalidEncoding: boolean } => {
        if (rawPathKey === "") {
          return { kvKey: null, invalidEncoding: false };
        }
        try {
          return {
            kvKey: decodeURIComponent(rawPathKey),
            invalidEncoding: false
          };
        } catch {
          return { kvKey: null, invalidEncoding: true };
        }
      };

      const getRequiredAdminKvKey = (
        rawPathKey: string
      ): { kvKey: string } | Response => {
        const { kvKey, invalidEncoding } = decodeAdminKey(rawPathKey);
        if (invalidEncoding) {
          return Response.json(
            { ok: false, error: "invalid kvKey encoding" },
            { status: 400 }
          );
        }
        if (!kvKey) {
          return Response.json(
            { ok: false, error: "kvKey required" },
            { status: 400 }
          );
        }
        return { kvKey };
      };

      // GET /api/admin/logs?limit=N — last N activity-log entries as JSON
      if (url.pathname === "/api/admin/logs" && request.method === "GET") {
        const limit = parseAdminLimit(url.searchParams.get("limit"), 100, 1000);
        const activityLog = activityLogEntriesFromState(this.state);
        const entries = activityLog.slice(-limit);
        return Response.json({
          ok: true,
          count: entries.length,
          entries,
          logs: entries
        });
      }

      // POST /api/admin/keywords/import — batch-import scout keywords into
      // the KEYWORDS_DB D1 queue. Body: { keywords: [{ keyword,
      // categorySlug, categoryTitle?, volume?, cpc?, difficulty?,
      // priority?, source? }] }. Slug-deduped (INSERT OR IGNORE); the
      // scout consumes rows in priority/volume order.
      if (
        url.pathname === "/api/admin/keywords/import" &&
        request.method === "POST"
      ) {
        const db = this.env.KEYWORDS_DB;
        if (!db) {
          return Response.json(
            { ok: false, error: "KEYWORDS_DB binding missing" },
            { status: 500 }
          );
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json(
            { ok: false, error: "invalid JSON body" },
            { status: 400 }
          );
        }
        const rows = Array.isArray((body as { keywords?: unknown }).keywords)
          ? ((body as { keywords: unknown[] }).keywords as Array<
              Record<string, unknown>
            >)
          : null;
        if (!rows || rows.length === 0 || rows.length > 500) {
          return Response.json(
            { ok: false, error: "keywords must be an array of 1-500 rows" },
            { status: 400 }
          );
        }
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO scout_keywords
             (keyword, slug, category_slug, category_title, volume, cpc,
              difficulty, source, priority)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        );
        const batch: D1PreparedStatement[] = [];
        let skippedInvalid = 0;
        for (const r of rows) {
          const kw = typeof r.keyword === "string" ? r.keyword.trim() : "";
          const cat =
            typeof r.categorySlug === "string" ? r.categorySlug.trim() : "";
          if (!kw || !cat) {
            skippedInvalid++;
            continue;
          }
          batch.push(
            stmt.bind(
              kw,
              keywordToSlug(kw),
              cat,
              typeof r.categoryTitle === "string" ? r.categoryTitle : "",
              typeof r.volume === "number" ? r.volume : null,
              typeof r.cpc === "number" ? r.cpc : null,
              typeof r.difficulty === "number" ? r.difficulty : null,
              typeof r.source === "string" && r.source ? r.source : "import",
              typeof r.priority === "number" ? r.priority : 0
            )
          );
        }
        if (batch.length === 0) {
          return Response.json(
            { ok: false, error: "no valid rows", skippedInvalid },
            { status: 400 }
          );
        }
        const results = await db.batch(batch);
        const inserted = results.reduce(
          (n, res) => n + (res.meta?.changes ?? 0),
          0
        );
        const duplicates = batch.length - inserted;
        this.log(
          "info",
          `Scout DB import: ${inserted} keyword(s) added, ${duplicates} duplicate(s), ${skippedInvalid} invalid`,
          "dataSpecialist"
        );
        return Response.json({
          ok: true,
          inserted,
          duplicates,
          skippedInvalid
        });
      }

      // GET /api/admin/keywords — queue visibility: counts by status +
      // recent rows (optionally filtered by ?status=).
      if (url.pathname === "/api/admin/keywords" && request.method === "GET") {
        const db = this.env.KEYWORDS_DB;
        if (!db) {
          return Response.json(
            { ok: false, error: "KEYWORDS_DB binding missing" },
            { status: 500 }
          );
        }
        const limit = parseAdminLimit(url.searchParams.get("limit"), 50, 500);
        const status = (url.searchParams.get("status") ?? "").trim();
        const counts = await db
          .prepare(
            `SELECT status, COUNT(*) AS n FROM scout_keywords GROUP BY status`
          )
          .all();
        const rowsRes = status
          ? await db
              .prepare(
                `SELECT * FROM scout_keywords WHERE status = ?1
                 ORDER BY priority DESC, volume DESC LIMIT ?2`
              )
              .bind(status, limit)
              .all()
          : await db
              .prepare(
                `SELECT * FROM scout_keywords
                 ORDER BY created_at DESC LIMIT ?1`
              )
              .bind(limit)
              .all();
        return Response.json({
          ok: true,
          counts: counts.results,
          rows: rowsRes.results
        });
      }

      // POST /api/admin/qc-gate — run the post-publish QC gate against
      // an arbitrary URL. Body: { url: string }. Returns the full
      // structured report (durationMs, jsonLd.{valid, blockCount,
      // blocks[]}) so the dashboard, a CI script, or a `claude-fix`
      // issue runbook can render it directly. Operator/Copilot tool —
      // not yet wired into the writer pipeline (Step 14.5 lands in a
      // follow-up PR after thresholds tune against the existing
      // corpus).
      if (url.pathname === "/api/admin/qc-gate" && request.method === "POST") {
        const { runQcGate } = await import("./pipeline/qc-gate");
        let body: { url?: unknown } = {};
        try {
          body = (await request.json()) as { url?: unknown };
        } catch {
          return Response.json(
            { ok: false, error: "body must be JSON" },
            { status: 400 }
          );
        }
        const target = typeof body.url === "string" ? body.url.trim() : "";
        if (!target || !/^https?:\/\//i.test(target)) {
          return Response.json(
            { ok: false, error: "body.url must be a http(s) URL" },
            { status: 400 }
          );
        }
        const report = await runQcGate(target);
        return Response.json(report);
      }

      // POST /api/admin/sanitize-templates — deterministic byte-replace
      // for the hard-coded false-claim lines in already-published
      // articles. Targets the two strings emitted by html-builder.ts
      // before the 2026-06 FTC fix:
      //
      //   1. Author bio: "Amelia ... tested hundreds of products in
      //      real boarding facility conditions."
      //   2. "How We Picked" methodology: "...the Cats Luv Us team's
      //      hands-on experience with this product category in our
      //      Laguna Niguel facility."
      //
      // Replacement is a literal String.replace — NO regex, NO LLM, NO
      // dynamic prose touched. If an article does not contain the exact
      // old bytes (e.g. published before 2026-05-18, or mutated by a
      // post-publish Editorial Agent rewrite), the article is silently
      // skipped — no damage. Idempotent on second run (old bytes are
      // gone).
      //
      // Backup behavior: before any write, the original HTML is saved to
      // `template-backup:<kvKey>` with a 30-day TTL so the whole batch
      // can be reverted by writing the backups back. Disable with
      // `backup: false` only if you've already verified an earlier dry
      // run.
      //
      // Body: { batchSize?, batchOffset?, dryRun?, backup? }
      //   - batchSize: rows scanned per call (default 100, max 500)
      //   - batchOffset: SQL ROWID < batchOffset (cursor for pagination)
      //   - dryRun: default TRUE — must opt-in to write by passing false
      //   - backup: default TRUE
      //
      // Returns { ok, scanned, biosFixed, methodologiesFixed,
      // unchanged, sampleDiffs[], nextOffset, dryRun, backup }.
      if (
        url.pathname === "/api/admin/sanitize-templates" &&
        request.method === "POST"
      ) {
        // Exact pre-2026-06 template bytes. Source: git show
        // 7b96e391:src/pipeline/html-builder.ts. Any drift here (HTML
        // entity encoding, whitespace) will cause String.replace to
        // miss — leaving the article unchanged but not corrupted.
        const OLD_BIO =
          '<p class="bio">With over 15 years of hands-on experience at Cats Luv Us Boarding Hotel &amp; Grooming in Laguna Niguel, CA, Amelia has cared for thousands of cats and tested hundreds of products in real boarding facility conditions.</p>';
        const NEW_BIO =
          '<p class="bio">With over 15 years caring for cats at Cats Luv Us Boarding Hotel &amp; Grooming in Laguna Niguel, CA, Amelia draws on daily boarding-floor experience with thousands of cats. Product picks in these guides are synthesized from public manufacturer specs and customer review aggregates — no physical product trials are conducted by Cats Luv Us.</p>';
        const OLD_METHODOLOGY =
          "Picks are synthesized from public product data and review aggregates, cross-referenced with the Cats Luv Us team's hands-on experience with this product category in our Laguna Niguel facility. We do not receive free samples, and our rankings are unaffected by our Amazon affiliate relationship.";
        const NEW_METHODOLOGY =
          "Picks are synthesized from public product data and review aggregates, cross-referenced with the Cats Luv Us team's experience caring for boarding cats at our Laguna Niguel facility. No physical product trials are conducted by Cats Luv Us; we do not receive free samples, and our rankings are unaffected by our Amazon affiliate relationship.";
        const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

        let body: {
          batchSize?: unknown;
          batchOffset?: unknown;
          dryRun?: unknown;
          backup?: unknown;
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          body = {};
        }
        const batchSize = Math.min(
          500,
          Math.max(1, Number(body.batchSize) || 100)
        );
        const batchOffset = Math.max(0, Number(body.batchOffset) || 0);
        // Default dryRun = TRUE so an accidental empty body or curl
        // typo cannot corrupt KV. Caller must explicitly opt in to
        // writes.
        const dryRun = body.dryRun !== false;
        const backup = body.backup !== false;
        type Row = { rowid: number; kv_key: string; slug: string };
        let rows: Row[] = [];
        try {
          rows =
            batchOffset > 0
              ? [
                  ...this.sql<Row>`
                  SELECT ROWID as rowid, kv_key, slug
                  FROM articles
                  WHERE kv_key != '' AND ROWID < ${batchOffset}
                  ORDER BY ROWID DESC
                  LIMIT ${batchSize}
                `
                ]
              : [
                  ...this.sql<Row>`
                  SELECT ROWID as rowid, kv_key, slug
                  FROM articles
                  WHERE kv_key != ''
                  ORDER BY ROWID DESC
                  LIMIT ${batchSize}
                `
                ];
        } catch (sqlErr: unknown) {
          return Response.json(
            {
              ok: false,
              error: `articles index unavailable: ${errMsg(sqlErr)}`
            },
            { status: 503 }
          );
        }
        let scanned = 0;
        let biosFixed = 0;
        let methodologiesFixed = 0;
        let unchanged = 0;
        const sampleDiffs: Array<{
          kvKey: string;
          slug: string;
          changedBio: boolean;
          changedMethodology: boolean;
        }> = [];
        let smallestRowid = batchOffset;
        for (const row of rows) {
          smallestRowid =
            smallestRowid === 0 || row.rowid < smallestRowid
              ? row.rowid
              : smallestRowid;
          let html: string | null;
          try {
            html = await this.envBindings.ARTICLES_KV.get(row.kv_key);
          } catch {
            continue;
          }
          if (!html) continue;
          scanned++;
          const hasBio = html.includes(OLD_BIO);
          const hasMethodology = html.includes(OLD_METHODOLOGY);
          if (!hasBio && !hasMethodology) {
            unchanged++;
            continue;
          }
          if (hasBio) biosFixed++;
          if (hasMethodology) methodologiesFixed++;
          if (sampleDiffs.length < 5) {
            sampleDiffs.push({
              kvKey: row.kv_key,
              slug: row.slug,
              changedBio: hasBio,
              changedMethodology: hasMethodology
            });
          }
          if (dryRun) continue;
          // Replacement order doesn't matter — the two old strings have
          // no overlap and don't appear inside each other.
          let cleaned = html;
          if (hasBio) cleaned = cleaned.replace(OLD_BIO, NEW_BIO);
          if (hasMethodology)
            cleaned = cleaned.replace(OLD_METHODOLOGY, NEW_METHODOLOGY);
          // Best-effort backup. A failed backup must not abort the
          // write — the original HTML is still recoverable from the
          // upstream Editorial Agent snapshot (`editorial-snapshot:`)
          // if one exists. Logged so a missing-backup is visible.
          if (backup) {
            try {
              await this.envBindings.ARTICLES_KV.put(
                `template-backup:${row.kv_key}`,
                html,
                { expirationTtl: BACKUP_TTL_SECONDS }
              );
            } catch (backupErr: unknown) {
              this.log(
                "warning",
                `sanitize-templates: backup failed for ${row.kv_key}: ${errMsg(backupErr)} (proceeding with overwrite)`,
                "qaReviewer",
                { kanbanStage: "debug" }
              );
            }
          }
          try {
            await this.envBindings.ARTICLES_KV.put(row.kv_key, cleaned);
          } catch (writeErr: unknown) {
            this.log(
              "warning",
              `sanitize-templates: KV write failed for ${row.kv_key}: ${errMsg(writeErr)}`,
              "qaReviewer",
              { kanbanStage: "debug" }
            );
            // Roll back the fix counters so the response numbers
            // reflect what actually landed.
            if (hasBio) biosFixed--;
            if (hasMethodology) methodologiesFixed--;
          }
        }
        const nextOffset = smallestRowid > 0 ? smallestRowid : null;
        this.log(
          "info",
          `sanitize-templates: scanned=${scanned} bios=${biosFixed} methodologies=${methodologiesFixed} unchanged=${unchanged} dryRun=${dryRun} backup=${backup} nextOffset=${nextOffset ?? "done"}`,
          "qaReviewer",
          { kanbanStage: "debug" }
        );
        return Response.json({
          ok: true,
          scanned,
          biosFixed,
          methodologiesFixed,
          unchanged,
          sampleDiffs,
          nextOffset,
          dryRun,
          backup
        });
      }

      // POST /api/admin/replace-testing-vocabulary — word-boundary
      // substitution of test/testing/tested → compare/comparison/
      // compared across already-published article HTML in KV. Companion
      // to sanitize-templates: that endpoint targets two specific
      // template strings; this one is a general vocabulary refactor
      // for the body prose Kimi emitted with first-person "we tested"
      // / "Based on our testing" / "top-tested picks" phrasing.
      //
      // Replacement rules:
      //   - Whole-word, case-insensitive match (\bTest\b etc.)
      //   - Case-preserving substitution (TEST→COMPARE, Test→Compare,
      //     test→compare). Tested→Compared. Testing→Comparison.
      //   - SKIPS content inside href / src attributes (URL slugs with
      //     "test" stay intact).
      //   - SKIPS content inside <script> blocks (JSON-LD has its own
      //     pass).
      //   - SKIPS safelist phrases via pre-replacement placeholder:
      //     "ISO tested", "FDA tested", "Pet Tested" (brand), "DNA
      //     test", "DNA Test", "DNA Testing", "fit test", "safety
      //     tested" — these are legitimate third-party / generic
      //     references that the substitution must not mangle.
      //
      // Mirrors sanitize-templates contract:
      //   Body: { batchSize?, batchOffset?, dryRun?, backup? }
      //   dryRun defaults TRUE; backup defaults TRUE
      //   30-day TTL backup at `vocab-backup:<kvKey>` (separate
      //   namespace from `template-backup:` so the two endpoints
      //   don't overwrite each other's snapshots)
      if (
        url.pathname === "/api/admin/replace-testing-vocabulary" &&
        request.method === "POST"
      ) {
        const BACKUP_TTL_SECONDS_VOCAB = 30 * 24 * 60 * 60; // 30 days
        const { applyTestingVocabSwap } =
          await import("./pipeline/testing-vocab-swap");

        let body: {
          batchSize?: unknown;
          batchOffset?: unknown;
          dryRun?: unknown;
          backup?: unknown;
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          body = {};
        }
        const batchSize = Math.min(
          500,
          Math.max(1, Number(body.batchSize) || 100)
        );
        const batchOffset = Math.max(0, Number(body.batchOffset) || 0);
        const dryRun = body.dryRun !== false;
        const backup = body.backup !== false;
        type Row = { rowid: number; kv_key: string; slug: string };
        let rows: Row[] = [];
        try {
          rows =
            batchOffset > 0
              ? [
                  ...this.sql<Row>`
                    SELECT ROWID as rowid, kv_key, slug
                    FROM articles
                    WHERE kv_key != '' AND ROWID < ${batchOffset}
                    ORDER BY ROWID DESC
                    LIMIT ${batchSize}
                  `
                ]
              : [
                  ...this.sql<Row>`
                    SELECT ROWID as rowid, kv_key, slug
                    FROM articles
                    WHERE kv_key != ''
                    ORDER BY ROWID DESC
                    LIMIT ${batchSize}
                  `
                ];
        } catch (sqlErr: unknown) {
          return Response.json(
            {
              ok: false,
              error: `articles index unavailable: ${errMsg(sqlErr)}`
            },
            { status: 503 }
          );
        }
        let scanned = 0;
        let changed = 0;
        let unchanged = 0;
        const sampleDiffs: Array<{
          kvKey: string;
          slug: string;
          substitutions: number;
          sampleBefore: string;
          sampleAfter: string;
        }> = [];
        let smallestRowid = batchOffset;
        for (const row of rows) {
          smallestRowid =
            smallestRowid === 0 || row.rowid < smallestRowid
              ? row.rowid
              : smallestRowid;
          let html: string | null;
          try {
            html = await this.envBindings.ARTICLES_KV.get(row.kv_key);
          } catch {
            continue;
          }
          if (!html) continue;
          scanned++;
          const cleaned = applyTestingVocabSwap(html);
          if (cleaned === html) {
            unchanged++;
            continue;
          }
          changed++;
          if (sampleDiffs.length < 5) {
            // Find the first chunk that changed for a useful preview.
            const minLen = Math.min(html.length, cleaned.length);
            let firstDiff = 0;
            while (firstDiff < minLen && html[firstDiff] === cleaned[firstDiff])
              firstDiff++;
            const ctxStart = Math.max(0, firstDiff - 40);
            const ctxEnd = Math.min(minLen, firstDiff + 80);
            sampleDiffs.push({
              kvKey: row.kv_key,
              slug: row.slug,
              substitutions:
                (html.match(/\b(test|testing|tested)\b/gi) || []).length -
                (cleaned.match(/\b(test|testing|tested)\b/gi) || []).length,
              sampleBefore: html.slice(ctxStart, ctxEnd),
              sampleAfter: cleaned.slice(ctxStart, ctxEnd)
            });
          }
          if (dryRun) continue;
          if (backup) {
            try {
              await this.envBindings.ARTICLES_KV.put(
                `vocab-backup:${row.kv_key}`,
                html,
                { expirationTtl: BACKUP_TTL_SECONDS_VOCAB }
              );
            } catch (backupErr: unknown) {
              this.log(
                "warning",
                `replace-testing-vocabulary: backup failed for ${row.kv_key}: ${errMsg(backupErr)} (proceeding with overwrite)`,
                "qaReviewer",
                { kanbanStage: "debug" }
              );
            }
          }
          try {
            await this.envBindings.ARTICLES_KV.put(row.kv_key, cleaned);
          } catch (writeErr: unknown) {
            this.log(
              "warning",
              `replace-testing-vocabulary: KV write failed for ${row.kv_key}: ${errMsg(writeErr)}`,
              "qaReviewer",
              { kanbanStage: "debug" }
            );
            changed--;
          }
        }
        const nextOffset = smallestRowid > 0 ? smallestRowid : null;
        this.log(
          "info",
          `replace-testing-vocabulary: scanned=${scanned} changed=${changed} unchanged=${unchanged} dryRun=${dryRun} backup=${backup} nextOffset=${nextOffset ?? "done"}`,
          "qaReviewer",
          { kanbanStage: "debug" }
        );
        return Response.json({
          ok: true,
          scanned,
          changed,
          unchanged,
          sampleDiffs,
          nextOffset,
          dryRun,
          backup
        });
      }

      // POST /api/admin/backfill-testing-claims — one-shot detector
      // for the ~4,213 already-published articles that may contain
      // fabricated product-testing language. Mirrors the live quality
      // probe but covers the full SQL index, paginated. Records a
      // `live-false-testing-claim` defect-finding per hit so the
      // existing 5-in-24h autonomous escalation loop opens Copilot
      // rewrite issues in throttled batches. **NEVER edits HTML
      // directly** — fixes go through the same QC + eval gates as
      // any other defect.
      //
      // Body: { batchSize?: number, batchOffset?: number, dryRun?: bool }
      //   - batchSize: rows scanned per call (default 100, max 500)
      //   - batchOffset: SQL ROWID < batchOffset (cursor for pagination)
      //   - dryRun: if true, counts hits but does not call
      //     `recordFinding` — useful for sizing the queue before
      //     committing to the autonomous fix wave.
      //
      // Returns { ok, scanned, hits, sampleHits[], nextOffset, dryRun }.
      // Caller (admin script or curl) paginates by passing the
      // returned `nextOffset` until `scanned < batchSize`.
      if (
        url.pathname === "/api/admin/backfill-testing-claims" &&
        request.method === "POST"
      ) {
        const {
          detectFabricatedTestingClaims,
          summarizeFabricatedTestingClaims
        } = await import("./pipeline/fabricated-testing-claims");
        const { stripHtmlToPlainText } =
          await import("./pipeline/plagiarism-overlap");
        const { recordFinding } = await import("./pipeline/defect-findings");
        let body: {
          batchSize?: unknown;
          batchOffset?: unknown;
          dryRun?: unknown;
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          body = {};
        }
        const batchSize = Math.min(
          500,
          Math.max(1, Number(body.batchSize) || 100)
        );
        const batchOffset = Math.max(0, Number(body.batchOffset) || 0);
        const dryRun = body.dryRun === true;
        type BackfillRow = {
          rowid: number;
          kv_key: string;
          slug: string;
          keyword: string;
        };
        let rows: BackfillRow[] = [];
        try {
          // The articles table's ROWID is monotonic; paginate newest-first
          // (DESC) and use the smallest seen ROWID as the next cursor.
          // When batchOffset === 0 the WHERE filter omits the cursor.
          rows =
            batchOffset > 0
              ? [
                  ...this.sql<BackfillRow>`
                  SELECT ROWID as rowid, kv_key, slug, keyword
                  FROM articles
                  WHERE kv_key != '' AND ROWID < ${batchOffset}
                  ORDER BY ROWID DESC
                  LIMIT ${batchSize}
                `
                ]
              : [
                  ...this.sql<BackfillRow>`
                  SELECT ROWID as rowid, kv_key, slug, keyword
                  FROM articles
                  WHERE kv_key != ''
                  ORDER BY ROWID DESC
                  LIMIT ${batchSize}
                `
                ];
        } catch (sqlErr: unknown) {
          return Response.json(
            {
              ok: false,
              error: `articles index unavailable: ${errMsg(sqlErr)}`
            },
            { status: 503 }
          );
        }
        let scanned = 0;
        let hits = 0;
        const sampleHits: Array<{
          kvKey: string;
          slug: string;
          summary: string;
          sample: string;
        }> = [];
        const timestamp = new Date().toISOString();
        let smallestRowid = batchOffset;
        for (const row of rows) {
          smallestRowid =
            smallestRowid === 0 || row.rowid < smallestRowid
              ? row.rowid
              : smallestRowid;
          let html: string | null;
          try {
            html = await this.envBindings.ARTICLES_KV.get(row.kv_key);
          } catch {
            continue;
          }
          if (!html) continue;
          scanned++;
          const findings = detectFabricatedTestingClaims(
            stripHtmlToPlainText(html)
          );
          if (findings.length === 0) continue;
          hits++;
          if (sampleHits.length < 5) {
            sampleHits.push({
              kvKey: row.kv_key,
              slug: row.slug,
              summary: summarizeFabricatedTestingClaims(findings),
              sample: findings[0].sentence.slice(0, 200)
            });
          }
          if (!dryRun) {
            await recordFinding(this, {
              defectClass: "live-false-testing-claim",
              kvKey: row.kv_key,
              timestamp,
              evidence: {
                source: "backfill",
                summary: summarizeFabricatedTestingClaims(findings),
                occurrenceCount: findings.length,
                matchedPhrases: findings
                  .slice(0, 5)
                  .map((c) => c.trigger)
                  .join(", "),
                sampleSentence: findings[0].sentence.slice(0, 240),
                slug: row.slug,
                keyword: row.keyword
              },
              suspectedCodePath:
                "src/pipeline/html-builder.ts hard-coded templates (pre-fix authored bio/methodology) — fix is to republish under the post-fix templates and the inverted SEO check #10 / Polish Agent will clean any remaining body prose"
            });
          }
        }
        const nextOffset = smallestRowid > 0 ? smallestRowid : null;
        this.log(
          "info",
          `backfill-testing-claims: scanned=${scanned} hits=${hits} dryRun=${dryRun} nextOffset=${nextOffset ?? "done"}`,
          "qaReviewer",
          { kanbanStage: "debug" }
        );
        return Response.json({
          ok: true,
          scanned,
          hits,
          sampleHits,
          nextOffset,
          dryRun
        });
      }

      // GET /api/admin/editorial-stats?days=N — per-day success/fail
      // counters for the post-publish Editorial Agent rewrite loop.
      // Default 7 days, max 60. The activity log only holds the last
      // 200 entries; this endpoint is the persistent record so the
      // operator can answer "what fraction of rewrites succeeded
      // yesterday?" without scrolling logs. Powers the "EDITORIAL
      // REWRITE LOOP" dashboard panel.
      if (
        url.pathname === "/api/admin/editorial-stats" &&
        request.method === "GET"
      ) {
        const { getEditorialStats, topFailureReasons, topSkipReasons } =
          await import("./pipeline/editorial-stats");
        const daysParam = url.searchParams.get("days");
        const days = parseAdminLimit(daysParam, 7, 60);
        const records = await getEditorialStats(this, days);
        const totals = records.reduce(
          (acc, r) => ({
            success: acc.success + r.success,
            fail: acc.fail + r.fail,
            skipped: acc.skipped + r.skipped
          }),
          { success: 0, fail: 0, skipped: 0 }
        );
        const attempted = totals.success + totals.fail;
        const successRate =
          attempted > 0 ? Math.round((totals.success / attempted) * 100) : null;
        return Response.json({
          ok: true,
          days,
          totals: { ...totals, attempted, successRatePercent: successRate },
          topFailureReasons: topFailureReasons(records, 5),
          topSkipReasons: topSkipReasons(records, 5),
          daily: records
        });
      }

      // GET /api/admin/recent-failures?limit=N — keyword rows with
      // status IN ('failed', 'abandoned') plus their raw Kimi output (if
      // stored). 'abandoned' rows (retry_count >= MAX_KEYWORD_RETRIES) are
      // included so a permanently-broken keyword stays visible here even
      // after it stops appearing as plain 'failed'.
      if (
        url.pathname === "/api/admin/recent-failures" &&
        request.method === "GET"
      ) {
        const limit = parseAdminLimit(url.searchParams.get("limit"), 5, 50);
        const rows = this.sql<{
          keyword: string;
          slug: string;
          category_slug: string;
          status: string;
          seo_score: number;
        }>`SELECT keyword, slug, category_slug, status, seo_score FROM keywords WHERE status IN ('failed', 'abandoned') ORDER BY ROWID DESC LIMIT ${limit}`;
        const failures = await Promise.all(
          rows.map(async (r) => {
            const kvKey = `${r.category_slug}:${r.slug}`;
            const [rawKimi, publishedHtml] = await Promise.all([
              this.envBindings.ARTICLES_KV.get(`kimi-raw:${kvKey}`),
              this.envBindings.ARTICLES_KV.get(kvKey).then(
                (value) => value ?? null
              )
            ]);
            return {
              keyword: r.keyword,
              slug: r.slug,
              categorySlug: r.category_slug,
              status: r.status,
              seoScore: r.seo_score,
              kvKey,
              rawKimiOutputSnippet: rawKimi?.slice(0, 4000) ?? null,
              publishedHtmlSnippet: publishedHtml?.slice(0, 2000) ?? null,
              publishedHtmlLen: publishedHtml?.length ?? 0
            };
          })
        );
        return Response.json({
          ok: true,
          count: failures.length,
          failures
        });
      }

      // (Infrastructure Activity Monitor endpoints moved out of the
      // bearer-gated block; they live at /api/dashboard/* — see above
      // the `/api/admin/*` bearer check.)

      // GET /api/admin/failure-breakdown?limit=N — categorize the
      // most-recent N error/warning activity log entries into
      // credential (provider-side) vs content (real) buckets.
      // Reports the non-credential rate the autonomous defect loop
      // should actually be targeting (chasing credential failures
      // wastes Copilot cycles — that's a billing/rotation operator
      // action).
      if (
        url.pathname === "/api/admin/failure-breakdown" &&
        request.method === "GET"
      ) {
        const limit = parseAdminLimit(url.searchParams.get("limit"), 200, 1000);
        // Activity log is a ring buffer ordered oldest→newest. Filter
        // by NORMALIZED level (catches "warn"/"err"/"fatal"/wrapper
        // variants the raw === compare would miss), then take the
        // newest N via slice(-limit) — reverse so callers see
        // newest-first.
        const entries = filterObjectArrayEntries<ActivityLogEntry>(
          this.state.activityLog
        );
        const errorOrWarning = entries.filter((e) => {
          const lvl = normalizeActivityLogLevel(e.level);
          return lvl === "error" || lvl === "warning";
        });
        const newestN = errorOrWarning.slice(-limit).reverse();
        const messages = newestN
          .map((e) => `${e.msg ?? ""} ${e.errorMessage ?? ""}`.trim())
          .filter((m) => m.length > 0);
        const breakdown = summarizeFailureBreakdown(messages);
        return Response.json({
          ok: true,
          window: { entriesScanned: messages.length, limit },
          breakdown,
          oneLine: formatBreakdownOneLine(breakdown)
        });
      }

      // GET /api/admin/kv/:kvKey — raw published HTML for a kvKey
      if (
        url.pathname.startsWith("/api/admin/kv/") &&
        request.method === "GET"
      ) {
        const kvKeyResult = getRequiredAdminKvKey(
          url.pathname.slice("/api/admin/kv/".length)
        );
        if (kvKeyResult instanceof Response) return kvKeyResult;
        const { kvKey } = kvKeyResult;
        const html = await this.envBindings.ARTICLES_KV.get(kvKey);
        if (html === null) {
          return Response.json(
            { ok: false, error: "not found", kvKey },
            { status: 404 }
          );
        }
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      // GET /api/admin/kimi-raw/:kvKey — raw Kimi JSON output stored on
      // failure by writer.ts (see kimi-raw:<kvKey> KV writes there)
      if (
        url.pathname.startsWith("/api/admin/kimi-raw/") &&
        request.method === "GET"
      ) {
        const kvKeyResult = getRequiredAdminKvKey(
          url.pathname.slice("/api/admin/kimi-raw/".length)
        );
        if (kvKeyResult instanceof Response) return kvKeyResult;
        const { kvKey } = kvKeyResult;
        const raw = await this.envBindings.ARTICLES_KV.get(`kimi-raw:${kvKey}`);
        if (raw === null) {
          return Response.json(
            { ok: false, error: "not found", kvKey },
            { status: 404 }
          );
        }
        return new Response(raw, {
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }

      // GET /api/admin/kimi-raw-prompt/:kvKey — the prompt that produced the
      // kimi-raw output above (see kimi-raw-prompt:<kvKey> KV writes in
      // writer.ts, alongside the existing kimi-raw:<kvKey> output capture).
      if (
        url.pathname.startsWith("/api/admin/kimi-raw-prompt/") &&
        request.method === "GET"
      ) {
        const kvKeyResult = getRequiredAdminKvKey(
          url.pathname.slice("/api/admin/kimi-raw-prompt/".length)
        );
        if (kvKeyResult instanceof Response) return kvKeyResult;
        const { kvKey } = kvKeyResult;
        const raw = await this.envBindings.ARTICLES_KV.get(
          `kimi-raw-prompt:${kvKey}`
        );
        if (raw === null) {
          return Response.json(
            { ok: false, error: "not found", kvKey },
            { status: 404 }
          );
        }
        return new Response(raw, {
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }

      // GET /api/admin/analytics/:kvKey — DataForSEO Labs ranked-keywords
      // history for a published article. Powers the Rankings dashboard panel
      // and is the read-side of the SEO feedback loop. Returns the latest
      // snapshot per (keyword, country) plus a 28-day position trend.
      // Population: runAnalyticsTick() in src/pipeline/analytics-tick.ts via
      // the every-minute scheduled() handler.
      if (
        url.pathname.startsWith("/api/admin/analytics/") &&
        request.method === "GET"
      ) {
        const kvKeyResult = getRequiredAdminKvKey(
          url.pathname.slice("/api/admin/analytics/".length)
        );
        if (kvKeyResult instanceof Response) return kvKeyResult;
        const { kvKey } = kvKeyResult;
        // Latest snapshot per keyword+country, ordered by est_traffic desc.
        // The `__none__` sentinel keyword (written when an article ranks for
        // 0 keywords so the staleness gate stops re-picking it every minute)
        // is excluded — consumers should never see "no rankings" as a real
        // rank with position=0.
        const latest = this.sql<{
          keyword: string;
          country: string;
          date: string;
          position: number;
          search_volume: number;
          est_traffic: number;
          cpc: number;
          serp_features: string;
        }>`
          SELECT keyword, country, date, position, search_volume,
                 est_traffic, cpc, serp_features
          FROM article_rankings
          WHERE kv_key = ${kvKey}
            AND keyword <> '__none__'
            AND (keyword, country, date) IN (
              SELECT keyword, country, MAX(date)
              FROM article_rankings
              WHERE kv_key = ${kvKey}
                AND keyword <> '__none__'
              GROUP BY keyword, country
            )
          ORDER BY est_traffic DESC, position ASC
          LIMIT 200
        `;
        // 28-day trend per keyword (US only, the dashboard's primary view).
        // For each tracked keyword pull every snapshot in the last 28 days so
        // the panel can sparkline the position over time without another call.
        const trend = this.sql<{
          keyword: string;
          date: string;
          position: number;
        }>`
          SELECT keyword, date, position
          FROM article_rankings
          WHERE kv_key = ${kvKey}
            AND country = 'US'
            AND keyword <> '__none__'
            AND date >= date('now', '-28 days')
          ORDER BY keyword, date ASC
        `;
        return Response.json({
          ok: true,
          kvKey,
          latest,
          trend
        });
      }

      // GET /api/admin/analytics-summary?limit=N — dashboard top-N table.
      // Returns one row per article with ITS TARGET KEYWORD's ranking (the
      // keyword the article was written to rank for, from `articles.keyword`).
      // Drives the Rankings panel's main table without N round-trips.
      if (
        url.pathname === "/api/admin/analytics-summary" &&
        request.method === "GET"
      ) {
        const limit = parseAdminLimit(url.searchParams.get("limit"), 100, 500);
        // For each article, look up the TARGET-keyword ranking from
        // article_rankings (case-insensitive match against articles.keyword).
        // LEFT JOIN means articles whose target keyword isn't in DataForSEO's
        // top-100 still appear with `position: null` — that's the most useful
        // signal of all (an article not ranking for what it was written to
        // target). Sort: ranking articles first by best position, then
        // non-ranking articles (NULLS LAST) for visibility within the limit.
        const rows = this.sql<{
          kv_key: string;
          keyword: string;
          date: string | null;
          position: number | null;
          search_volume: number | null;
          est_traffic: number | null;
          serp_features: string | null;
          prior_position: number | null;
        }>`
          WITH latest_per_kv AS (
            SELECT kv_key, MAX(date) AS max_date
            FROM article_rankings
            WHERE country = 'US' AND keyword <> '__none__'
            GROUP BY kv_key
          ),
          target_rank AS (
            SELECT
              a.kv_key,
              a.keyword AS target_keyword,
              r.position,
              r.search_volume,
              r.est_traffic,
              r.serp_features,
              r.date
            FROM articles a
            LEFT JOIN latest_per_kv l ON l.kv_key = a.kv_key
            LEFT JOIN article_rankings r
              ON r.kv_key = a.kv_key
              AND r.country = 'US'
              AND r.date = l.max_date
              AND lower(r.keyword) = lower(a.keyword)
            WHERE a.url <> ''
          ),
          prior_target AS (
            SELECT
              a.kv_key,
              r.position AS prior_position,
              ROW_NUMBER() OVER (
                PARTITION BY a.kv_key
                ORDER BY r.date DESC
              ) AS pn
            FROM articles a
            JOIN article_rankings r
              ON r.kv_key = a.kv_key
              AND r.country = 'US'
              AND lower(r.keyword) = lower(a.keyword)
              AND r.date <= date('now', '-28 days')
          )
          SELECT
            t.kv_key,
            t.target_keyword AS keyword,
            t.date,
            t.position,
            t.search_volume,
            t.est_traffic,
            t.serp_features,
            p.prior_position
          FROM target_rank t
          LEFT JOIN prior_target p
            ON p.kv_key = t.kv_key AND p.pn = 1
          ORDER BY
            CASE WHEN t.position IS NOT NULL THEN 0 ELSE 1 END,
            t.position ASC,
            t.kv_key ASC
          LIMIT ${limit}
        `;
        const summary = rows.map((r) => {
          const priorPos = r.prior_position ?? null;
          const pos = r.position ?? null;
          const delta =
            pos !== null && priorPos !== null ? priorPos - pos : null;
          return {
            kvKey: r.kv_key,
            keyword: r.keyword,
            date: r.date,
            position: pos,
            priorPosition: priorPos,
            positionDelta: delta,
            searchVolume: r.search_volume ?? 0,
            estTraffic: r.est_traffic ?? 0,
            serpFeatures: r.serp_features ?? ""
          };
        });
        return Response.json({
          ok: true,
          count: summary.length,
          rows: summary
        });
      }

      // GET /api/admin/render?url=<url> — live post-JS HTML for any
      // catsluvus.com page via Cloudflare Browser Rendering /content. Used
      // by the autonomous Coding Agent to verify a fix actually landed on
      // the live site (distinct from /api/admin/kv/<kvKey>, which returns
      // whatever was written to KV at publish time, not the current live
      // page). Host + scheme locked to prevent open-proxy abuse.
      if (url.pathname === "/api/admin/render" && request.method === "GET") {
        const rawTarget = url.searchParams.get("url")?.trim() ?? "";
        const target = rawTarget.replace(/^(['"`])(.*)\1$/, "$2").trim();
        if (!target) {
          return Response.json(
            { ok: false, error: "missing url query parameter" },
            { status: 400 }
          );
        }
        let parsed: URL;
        try {
          parsed = new URL(target);
        } catch {
          return Response.json(
            { ok: false, error: "invalid url" },
            { status: 400 }
          );
        }
        if (parsed.protocol !== "https:") {
          return Response.json(
            { ok: false, error: "url protocol must be https" },
            { status: 400 }
          );
        }
        if (
          parsed.hostname !== "catsluvus.com" &&
          parsed.hostname !== "www.catsluvus.com"
        ) {
          return Response.json(
            { ok: false, error: "host must be catsluvus.com" },
            { status: 400 }
          );
        }
        const accountId = this.envBindings.CLOUDFLARE_ACCOUNT_ID?.trim();
        const apiToken = this.envBindings.CLOUDFLARE_API_TOKEN_SECRET?.trim();
        if (!accountId || !apiToken) {
          const missingBindings = getMissingBrowserRenderingBindings(
            accountId,
            apiToken
          );
          return Response.json(
            {
              ok: false,
              error: `missing ${missingBindings.join(", ")}; set both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN_SECRET to enable /api/admin/render`
            },
            { status: 500 }
          );
        }
        const { html, error } = await renderPage(
          accountId,
          apiToken,
          parsed.toString()
        );
        if (!html) {
          return Response.json({ ok: false, error }, { status: 502 });
        }
        return new Response(html.slice(0, 1_000_000), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      // POST /api/admin/log-repo-agent — ingest a log line from the GitHub
      // Repo Agent workflow (.github/workflows/repo-agent.yml). Body:
      //   { level: "info"|"warning"|"warn"|"error"|"err", msg?: string, message?: string }
      // The workflow POSTs here with Bearer $ADMIN_API_TOKEN after every
      // action it takes (deploy verification, dedup close, regression
      // detection, stale-PR sweep, secret-rotation alert). The message is
      // mirrored into the activity log under role `repoAgent` so the
      // dashboard panel surfaces it.
      if (
        url.pathname === "/api/admin/log-repo-agent" &&
        request.method === "POST"
      ) {
        const body = await readJsonObject();
        const parsedPayload = parseExternalLogPayload(body);
        if ("error" in parsedPayload) {
          return Response.json(
            { ok: false, error: parsedPayload.error },
            { status: 400 }
          );
        }
        this.log(parsedPayload.level, parsedPayload.msg, "repoAgent", {
          kanbanStage: "debug"
        });
        return Response.json({ ok: true });
      }

      // POST /api/admin/editorial-review — run the Published Article
      // Editorial Agent on a KV key. Body: { kvKey, referenceUrl?, applyFix? }
      if (
        url.pathname === "/api/admin/editorial-review" &&
        request.method === "POST"
      ) {
        const body = await readJsonObject();
        const kvKey = typeof body.kvKey === "string" ? body.kvKey.trim() : "";
        if (!kvKey) {
          return Response.json(
            { ok: false, error: "kvKey required" },
            { status: 400 }
          );
        }
        if (typeof body.applyFix === "boolean") {
          this.log(
            "warning",
            `Editorial Agent: ignored /api/admin/editorial-review applyFix=${body.applyFix}; rewrite mode is disabled and runs are report-only`,
            "editorialAgent"
          );
        }
        // Fire-and-forget — the agent pipelines 4 steps incl. polling the
        // browser screenshot task (~1-3 min). The caller gets an immediate
        // accepted response; progress streams to the dashboard under
        // role=editorialAgent.
        this.ctx.waitUntil(
          runEditorialAgent(this, {
            kvKey,
            referenceUrl:
              typeof body.referenceUrl === "string"
                ? body.referenceUrl
                : undefined,
            // Re-enabled 2026-05-26 with in-place rewrite. Admin caller
            // can still opt out via `body.applyFix: false`.
            applyFix: body.applyFix !== false
          }).then(
            () => undefined,
            (err: unknown) => {
              this.log(
                "error",
                `Editorial Agent: orchestrator threw: ${errMsg(err)}`,
                "editorialAgent"
              );
            }
          )
        );
        return Response.json({ ok: true, accepted: true, kvKey });
      }

      // GET /api/admin/editorial-report/<kvKey> — fetch the latest report.
      if (
        url.pathname.startsWith("/api/admin/editorial-report/") &&
        request.method === "GET"
      ) {
        const kvKey = url.pathname.replace("/api/admin/editorial-report/", "");
        const raw = await this.envBindings.ARTICLES_KV.get(
          `editorial-report:${kvKey}`
        );
        if (!raw) {
          return Response.json(
            { ok: false, error: "no report yet" },
            { status: 404 }
          );
        }
        return new Response(raw, {
          headers: { "Content-Type": "application/json" }
        });
      }

      // POST /api/admin/run-defect-eval — Stage 5 of the per-defect-class
      // self-improving loop. Given a runId (built by Stage 3) and a
      // candidateBranch (Copilot's fix branch), fetches the candidate's
      // editorial-agent.ts + editorial-lessons.ts source from GitHub,
      // evaluates each EvalCheck against the candidate source text, and
      // returns a pass/fail report. Persists the result under
      // `eval-result:<runId>:<branch>:<ts>` for the Stage 6 measurement.
      // Body: { runId: string, candidateBranch: string }
      if (
        url.pathname === "/api/admin/run-defect-eval" &&
        request.method === "POST"
      ) {
        const body = await readJsonObject();
        const runId = typeof body.runId === "string" ? body.runId.trim() : "";
        const candidateBranch =
          typeof body.candidateBranch === "string"
            ? body.candidateBranch.trim()
            : "";
        if (!runId) {
          return Response.json(
            { ok: false, error: "runId required" },
            { status: 400 }
          );
        }
        if (!candidateBranch) {
          return Response.json(
            { ok: false, error: "candidateBranch required" },
            { status: 400 }
          );
        }
        const outcome = await runDefectEval(this, runId, candidateBranch);
        if (!outcome.ok) {
          return Response.json(
            { ok: false, error: outcome.error },
            { status: outcome.status }
          );
        }
        return Response.json(outcome.result);
      }

      // POST /api/admin/retry — reset a keyword to pending + (optionally)
      // purge its cached KV so the next generate-one regenerates it.
      // Body: { keyword: string, purgeKv?: boolean, force?: boolean }
      // A keyword already 'abandoned' (retry_count >= MAX_KEYWORD_RETRIES,
      // e.g. escalate-to-claude's automated runbook re-hitting this endpoint
      // on a deterministically-broken keyword) is refused unless
      // force=true, so an unattended auto-heal loop can't keep resurrecting
      // a keyword that can never succeed.
      if (url.pathname === "/api/admin/retry" && request.method === "POST") {
        const body = await readJsonObject();
        const keyword =
          typeof body.keyword === "string" ? body.keyword.trim() : "";
        if (!keyword) {
          return Response.json(
            { ok: false, error: "keyword required" },
            { status: 400 }
          );
        }
        const rows = this.sql<{
          slug: string;
          category_slug: string;
          status: string;
          retry_count: number;
        }>`SELECT slug, category_slug, status, retry_count FROM keywords WHERE keyword=${keyword} LIMIT 1`;
        if (rows.length === 0) {
          return Response.json(
            { ok: false, error: "keyword not found" },
            { status: 404 }
          );
        }
        const { slug, category_slug, status, retry_count } = rows[0];
        if (status === "abandoned" && body.force !== true) {
          return Response.json(
            {
              ok: false,
              error: `keyword abandoned after ${retry_count} failed attempts — pass {"force":true} to override`,
              retryCount: retry_count
            },
            { status: 409 }
          );
        }
        const previousKvKey = `${category_slug}:${slug}`;
        const nextSlug = keywordToSlug(keyword);
        const kvKey = `${category_slug}:${nextSlug}`;
        const slugChanged = nextSlug !== slug;
        const resetRetryCount = body.force === true ? 0 : retry_count;
        this.sql`UPDATE keywords
          SET id=${`${category_slug}:${nextSlug}`},
              slug=${nextSlug},
              status='pending',
              retry_count=${resetRetryCount}
          WHERE keyword=${keyword} AND category_slug=${category_slug}`;
        if (body.purgeKv === true) {
          await this.envBindings.ARTICLES_KV.delete(previousKvKey);
          await this.envBindings.ARTICLES_KV.delete(
            `kimi-raw:${previousKvKey}`
          );
        }
        return Response.json({
          ok: true,
          keyword,
          kvKey,
          previousKvKey,
          slugChanged,
          purgedKv: body.purgeKv === true
        });
      }

      // POST /api/admin/purge-pending-keywords — delete the runtime
      // keyword backlog (status='pending' rows in the DO-local `keywords`
      // table). These are legacy LLM-invented long-tail variations; the
      // operator's directive is that keywords come from the Scout DB
      // (real demand data) and are never invented. With the runtime
      // queue empty, generate-one and the autonomous loop claim from
      // scout_keywords instead. Body: { dryRun?: boolean }.
      if (
        url.pathname === "/api/admin/purge-pending-keywords" &&
        request.method === "POST"
      ) {
        const body = await readJsonObject();
        const pending = this.sql<{ keyword: string }>`
          SELECT keyword FROM keywords WHERE status='pending' ORDER BY keyword`;
        const sample = pending.slice(0, 25).map((r) => r.keyword);
        if (body.dryRun === true) {
          return Response.json({
            ok: true,
            dryRun: true,
            wouldDelete: pending.length,
            sample
          });
        }
        this.sql`DELETE FROM keywords WHERE status='pending'`;
        this.log(
          "info",
          `Purged ${pending.length} pending runtime keyword(s) — Scout DB is now the only keyword source`,
          "repoAgent"
        );
        return Response.json({ ok: true, deleted: pending.length, sample });
      }

      // POST /api/admin/reset-zero-score-completed — bulk-recover keywords
      // that were marked status='completed' with seo_score=0 by a buggy
      // skip path (notably the search-volume gate removed in #240). Resets
      // each row to status='pending' so the autonomous loop will re-pick
      // it under the fixed code, and purges its KV slot so the step-1 KV
      // existence check doesn't short-circuit.
      // Body: { dryRun?: boolean } — dryRun=true returns the count + a
      // sample of affected keywords without mutating anything.
      if (
        url.pathname === "/api/admin/reset-zero-score-completed" &&
        request.method === "POST"
      ) {
        const body = await readJsonObject();
        const targets = this.sql<{
          keyword: string;
          slug: string;
          category_slug: string;
        }>`SELECT keyword, slug, category_slug FROM keywords WHERE status='completed' AND seo_score=0`;

        if (body.dryRun === true) {
          return Response.json({
            ok: true,
            dryRun: true,
            count: targets.length,
            sample: targets.slice(0, 10).map((r) => r.keyword)
          });
        }

        for (const row of targets) {
          const kvKey = `${row.category_slug}:${row.slug}`;
          this
            .sql`UPDATE keywords SET status='pending' WHERE keyword=${row.keyword}`;
          await this.envBindings.ARTICLES_KV.delete(kvKey);
          await this.envBindings.ARTICLES_KV.delete(`kimi-raw:${kvKey}`);
        }
        this.log(
          "info",
          `Bulk reset: ${targets.length} zero-score completed keywords → pending (KV purged)`,
          "operations"
        );
        return Response.json({
          ok: true,
          dryRun: false,
          count: targets.length,
          sample: targets.slice(0, 10).map((r) => r.keyword)
        });
      }

      return Response.json(
        { ok: false, error: "admin endpoint not found" },
        { status: 404 }
      );
    }

    // GET /api/preview/:kvKey — unauth'd read of KV article HTML for
    // dashboard iframe A/B comparison. KV contents are destined to be
    // GET /api/preview?key=<kvKey> — unauth'd read of KV article HTML
    // for dashboard iframe A/B comparison. KV contents are destined for
    // public catsluvus.com anyway; this endpoint exposes them directly
    // for the ABVariantPreviewPanel to load in an iframe without needing
    // a bearer token (iframes can't set Authorization headers).
    //
    // Uses a query param instead of path-embedded kvKey because kvKeys
    // contain a colon (`category:slug`) and the Cloudflare Workers
    // assets binding 307-redirects `:` → `%3A` BEFORE our worker runs,
    // after which the SPA fallback returns index.html. Query string
    // bypasses that normalization entirely.
    if (
      (url.pathname === "/api/preview" ||
        url.pathname.startsWith("/api/preview/")) &&
      request.method === "GET"
    ) {
      // Accept either `?key=` or the legacy path-embedded form for
      // back-compat with anything that might still link to it.
      const kvKey =
        url.searchParams.get("key")?.trim() ||
        decodeURIComponent(url.pathname.slice("/api/preview/".length));
      if (!kvKey) return new Response("kvKey required", { status: 400 });
      const html = await this.envBindings.ARTICLES_KV.get(kvKey);
      if (html === null) {
        const safeKey = kvKey
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return new Response(
          `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;color:#6b7280;background:#fafafa;">Variant not available yet for <code>${safeKey}</code>. The Editorial Agent hasn't finished writing this variant (or it was rejected by the plagiarism/price check).</body></html>`,
          {
            status: 404,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        );
      }
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    // GET /api/screenshot?key=<slug>/<file> — unauth'd read of editorial
    // Agent screenshots stored in IMAGES_R2 under editorial-screenshots/.
    // Same query-param approach as /api/preview to avoid the colon-in-
    // path normalization issue (though screenshot slugs don't have
    // colons today, the `key=` form is consistent and future-proof).
    if (
      (url.pathname === "/api/screenshot" ||
        url.pathname.startsWith("/api/screenshot/")) &&
      request.method === "GET"
    ) {
      const rest =
        url.searchParams.get("key")?.trim() ||
        decodeURIComponent(url.pathname.slice("/api/screenshot/".length));
      // Normalize + refuse path traversal.
      if (!rest || rest.includes("..")) {
        return new Response("bad path", { status: 400 });
      }
      const r2Key = `editorial-screenshots/${rest}`;
      const obj = await this.envBindings.IMAGES_R2.get(r2Key);
      if (!obj) {
        return Response.json(
          { ok: false, error: "screenshot not found", key: r2Key },
          { status: 404 }
        );
      }
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType ?? "image/jpeg",
          "cache-control": "public, max-age=300"
        }
      });
    }

    if (url.pathname === "/api/logs") {
      const activityLog = activityLogEntriesFromState(this.state);
      const lines = activityLog.map((e) => {
        const kw = e.keyword?.trim() ? e.keyword : "—";
        const cat = e.categorySlug?.trim() ? e.categorySlug : "—";
        const articleUrl = e.articleUrl?.trim() ? e.articleUrl : "—";
        const comp = e.competitorUrl?.trim() ? e.competitorUrl : "—";
        const seo = e.seoScore === "" ? "—" : String(e.seoScore);
        const plag =
          e.plagiarismPercentage === undefined || e.plagiarismPercentage === ""
            ? "—"
            : `${e.plagiarismPercentage}%`;
        const step = normalizeActivityLogEntryStepNumber(e.stepNumber);
        return `[#${e.logRef}] step ${step} ${e.timeDate} ${e.timeTime} Article URL: ${articleUrl} Keyword: ${kw} Category: ${cat} Competitor URL: ${comp} SEO score: ${seo} Plagiarism %: ${plag} [${formatActivityLogLevelLabel(e.level)}] ${e.msg}`;
      });

      // Also pull recent keyword statuses from SQLite
      const recentKw = this.sql<{
        keyword: string;
        status: string;
        seo_score: number;
      }>`
        SELECT keyword, status, seo_score FROM keywords ORDER BY ROWID DESC LIMIT 20`;
      const kwLines = recentKw.map(
        (r) => `  KW: ${r.keyword} → ${r.status} (seo: ${r.seo_score})`
      );

      const recentArt = this.sql<{
        url: string;
        seo_score: number;
        word_count: number;
        competitor_url: string;
        qc_status: string;
      }>`
        SELECT url, seo_score, word_count, competitor_url, qc_status FROM articles ORDER BY ROWID DESC LIMIT 10`;
      const artLines = recentArt.map(
        (r) =>
          `  ART: ${r.url} (seo: ${r.seo_score}, words: ${r.word_count}, comp: ${r.competitor_url || "none"}, qc: ${r.qc_status || "pending"})`
      );

      const catStats = this.sql<{
        slug: string;
        status: string;
        article_count: number;
        expected_count: number;
      }>`
        SELECT slug, status, article_count, expected_count FROM categories ORDER BY ROWID DESC LIMIT 10`;
      const catLines = catStats.map(
        (r) =>
          `  CAT: ${r.slug} [${r.status}] ${r.article_count}/${r.expected_count} articles`
      );

      const output = [
        `=== SEO AGENT LOG (${new Date().toISOString()}) ===`,
        `Status: ${this.state.status}`,
        `Step # (sheet E): ${this.resolveSheetStepColumnE()}`,
        `Current: ${this.state.currentKeyword || "idle"} ${this.state.currentStep || ""}`,
        `Generated: ${this.state.articlesGenerated} | Failed: ${this.state.articlesFailed} | Categories: ${this.state.categoriesCompleted}`,
        ``,
        `--- GOOGLE SHEET COLUMN MAP (read-only; same as row 1 headers) ---`,
        ...getActivityLogSheetColumnLegendLines(),
        ``,
        `--- ACTIVITY LOG (last ${lines.length}) ---`,
        ...lines,
        ``,
        `--- RECENT KEYWORDS (last 20) ---`,
        ...kwLines,
        ``,
        `--- RECENT ARTICLES (last 10) ---`,
        ...(artLines.length > 0 ? artLines : ["  (none yet)"]),
        ``,
        `--- CATEGORIES ---`,
        ...catLines
      ].join("\n");

      return new Response(output, {
        headers: {
          "content-type": "text/plain",
          // Polled in real time by the dashboard — never cache, never serve
          // stale state to the operator.
          "cache-control": "no-store, no-cache, must-revalidate"
        }
      });
    }

    if (url.pathname === "/api/status") {
      const cats = this.sql<{
        cnt: number;
      }>`SELECT COUNT(*) as cnt FROM categories WHERE status='completed'`;
      const arts = this.sql<{
        cnt: number;
      }>`SELECT COUNT(*) as cnt FROM articles`;
      const pending = this.sql<{
        cnt: number;
      }>`SELECT COUNT(*) as cnt FROM keywords WHERE status='pending'`;
      const schedules = this.getSchedules();
      const autonomousLoopScheduled = schedules.some(
        (s) => s.callback === "autonomousLoop"
      );
      return Response.json(
        {
          ...this.state,
          activityStepNumber: this.resolveSheetStepColumnE(),
          dbCategories: cats[0]?.cnt ?? 0,
          dbArticles: arts[0]?.cnt ?? 0,
          dbPendingKeywords: pending[0]?.cnt ?? 0,
          autonomousLoopScheduled,
          scheduleCount: schedules.length
        },
        {
          // Polled in real time by the dashboard — never cache; status is
          // the most operationally-critical endpoint and a stale read is
          // worse than a missed tick.
          headers: { "cache-control": "no-store, no-cache, must-revalidate" }
        }
      );
    }

    // ── Internal analytics tick — invoked by the every-minute scheduled()
    //    handler via stub.fetch(). Not in proxyPaths, so it's unreachable
    //    from public traffic; only the Worker's own scheduled callback can
    //    POST to it. Returns the tick summary as JSON for log inspection.
    if (url.pathname === "/api/analytics-tick" && request.method === "POST") {
      const result = await this.runAnalyticsTick();
      return Response.json({ ok: true, ...result });
    }

    // ── Browser analytics endpoints — same DO SQL queries as the Bearer-
    //    protected /api/admin/analytics/* surface, but exposed to the
    //    cookie-walled dashboard so the Rankings panel can fetch directly
    //    without an admin token. Read-only.
    if (url.pathname === "/api/analytics-summary" && request.method === "GET") {
      const limit = parseAdminLimit(url.searchParams.get("limit"), 100, 500);
      // For each article, look up the TARGET-keyword ranking from
      // article_rankings (case-insensitive match against articles.keyword).
      // LEFT JOIN means articles whose target keyword isn't in DataForSEO's
      // top-100 still appear with `position: null` — that's the most useful
      // signal of all (an article not ranking for what it was written to
      // target). Sort: ranking articles first by best position, then
      // non-ranking articles (NULLS LAST) for visibility within the limit.
      const rows = this.sql<{
        kv_key: string;
        keyword: string;
        date: string | null;
        position: number | null;
        search_volume: number | null;
        est_traffic: number | null;
        serp_features: string | null;
        prior_position: number | null;
      }>`
        WITH latest_per_kv AS (
          SELECT kv_key, MAX(date) AS max_date
          FROM article_rankings
          WHERE country = 'US' AND keyword <> '__none__'
          GROUP BY kv_key
        ),
        target_rank AS (
          SELECT
            a.kv_key,
            a.keyword AS target_keyword,
            r.position,
            r.search_volume,
            r.est_traffic,
            r.serp_features,
            r.date
          FROM articles a
          LEFT JOIN latest_per_kv l ON l.kv_key = a.kv_key
          LEFT JOIN article_rankings r
            ON r.kv_key = a.kv_key
            AND r.country = 'US'
            AND r.date = l.max_date
            AND lower(r.keyword) = lower(a.keyword)
          WHERE a.url <> ''
        ),
        prior_target AS (
          SELECT
            a.kv_key,
            r.position AS prior_position,
            ROW_NUMBER() OVER (
              PARTITION BY a.kv_key
              ORDER BY r.date DESC
            ) AS pn
          FROM articles a
          JOIN article_rankings r
            ON r.kv_key = a.kv_key
            AND r.country = 'US'
            AND lower(r.keyword) = lower(a.keyword)
            AND r.date <= date('now', '-28 days')
        )
        SELECT
          t.kv_key,
          t.target_keyword AS keyword,
          t.date,
          t.position,
          t.search_volume,
          t.est_traffic,
          t.serp_features,
          p.prior_position
        FROM target_rank t
        LEFT JOIN prior_target p
          ON p.kv_key = t.kv_key AND p.pn = 1
        ORDER BY
          CASE WHEN t.position IS NOT NULL THEN 0 ELSE 1 END,
          t.position ASC,
          t.kv_key ASC
        LIMIT ${limit}
      `;
      const summary = rows.map((r) => {
        const priorPos = r.prior_position ?? null;
        const pos = r.position ?? null;
        const delta = pos !== null && priorPos !== null ? priorPos - pos : null;
        return {
          kvKey: r.kv_key,
          keyword: r.keyword,
          date: r.date,
          position: pos,
          priorPosition: priorPos,
          positionDelta: delta,
          searchVolume: r.search_volume ?? 0,
          estTraffic: r.est_traffic ?? 0,
          serpFeatures: r.serp_features ?? ""
        };
      });
      // Companion stat: how many articles have any ranking data at all
      // (so the empty state can distinguish "no pulls yet" from "no rankings").
      const tracked = this.sql<{ cnt: number }>`
        SELECT COUNT(DISTINCT kv_key) as cnt FROM article_rankings`;
      const articlesTotal = this.sql<{ cnt: number }>`
        SELECT COUNT(*) as cnt FROM articles`;
      return Response.json({
        ok: true,
        count: summary.length,
        rows: summary,
        articlesTracked: tracked[0]?.cnt ?? 0,
        articlesTotal: articlesTotal[0]?.cnt ?? 0
      });
    }

    if (url.pathname === "/api/debug-ndjson" && request.method === "GET") {
      const session = normalizeDebugSessionId(url.searchParams.get("session"));
      const rows = this.sql<{ line: string }>`
        SELECT line FROM agent_debug_ndjson
        WHERE session_id = ${session}
        ORDER BY id ASC`;
      const body = rows.map((r) => r.line).join("\n");
      return new Response(body, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8"
        }
      });
    }

    // REST control endpoints — mirrors @callable start/stop for non-WebSocket access
    if (url.pathname === "/api/start" && request.method === "POST") {
      if (
        this.state.status === "generating" ||
        this.state.status === "scouting"
      ) {
        return Response.json({ error: "Already running" });
      }
      this.setState({
        ...this.state,
        status: "scouting",
        currentCategory: null,
        currentKeyword: null,
        currentArticleSlug: null,
        currentStep: null,
        lastSheetStepLabel: ""
      });
      this.clearSheetStepColumnECache();
      this.log("info", "Autonomous mode started (via REST)");
      this.autonomousLoop();
      // Idempotent: onStart() and startAutonomousMode() both register the
      // 300s tick with this same check. Without it, hitting /api/start
      // multiple times stacks duplicate ticks (every press of "Start" on
      // the dashboard, every cold-restart-and-resume race) and the
      // autonomousLoop fires N× per cycle.
      const existing = this.getSchedules();
      if (!existing.some((s) => s.callback === "autonomousLoop")) {
        this.scheduleEvery(300, "autonomousLoop");
      }
      return Response.json({ success: true, status: "scouting" });
    }

    if (url.pathname === "/api/stop" && request.method === "POST") {
      const schedules = this.getSchedules();
      for (const s of schedules) {
        this.cancelSchedule(s.id);
      }
      this.setState({
        ...this.state,
        status: "paused",
        currentCategory: null,
        currentKeyword: null,
        currentArticleSlug: null,
        currentStep: null,
        lastSheetStepLabel: ""
      });
      this.clearSheetStepColumnECache();
      this.log("info", "Autonomous mode stopped (via REST)");
      return Response.json({ success: true, status: "paused" });
    }

    // Verify the Step 11.5 design-audit chain with real bindings.
    // Usage: GET/POST /api/verify-design-audit?url=https://example.com
    // Always returns 200 so clients receive the JSON body — inspect the
    // `ok` field, not the HTTP status, to decide pass/fail.
    if (
      url.pathname === "/api/verify-design-audit" &&
      (request.method === "POST" || request.method === "GET")
    ) {
      const defaultDomain = this.envBindings.DOMAIN?.trim() || "catsluvus.com";
      const testUrl = url.searchParams.get("url") || `https://${defaultDomain}`;
      const result = await this.verifyDesignAudit(testUrl);
      return Response.json(result);
    }

    // ── GET /api/qa/ — master Q&A index (public, no auth) ───────────────────
    // Returns a JSON array of all published Q&A endpoints so AI crawlers
    // (Perplexity, ChatGPT Browse, Gemini) can discover every article.
    if (url.pathname === "/api/qa/" || url.pathname === "/api/qa") {
      const domain = this.envBindings.DOMAIN || "catsluvus.com";
      try {
        const { QA_INDEX_KV_KEY } = await import("./pipeline/qa-syndication");
        const raw = await this.envBindings.ARTICLES_KV.get(QA_INDEX_KV_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (raw && !Array.isArray(parsed)) {
          this.log(
            "warning",
            "Q&A index endpoint: qa-index:all is not an array — serving empty index"
          );
        }
        const index: unknown[] = Array.isArray(parsed) ? parsed : [];
        return new Response(
          JSON.stringify({
            description:
              "catsluvus.com — machine-readable Q&A index for AI assistants",
            totalArticles: index.length,
            qaEndpointPattern: `https://${domain}/api/qa/{categorySlug}/{slug}`,
            articles: index
          }),
          {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "access-control-allow-origin": "*",
              "cache-control": "public, max-age=300"
            }
          }
        );
      } catch (err: unknown) {
        this.log("warning", `Q&A index endpoint parse failed — ${errMsg(err)}`);
        return new Response(
          JSON.stringify({
            description:
              "catsluvus.com — machine-readable Q&A index for AI assistants",
            totalArticles: 0,
            qaEndpointPattern: `https://${domain}/api/qa/{categorySlug}/{slug}`,
            articles: []
          }),
          {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "access-control-allow-origin": "*",
              "cache-control": "public, max-age=300"
            }
          }
        );
      }
    }

    // ── GET /api/qa/:categorySlug/:slug — per-article Q&A payload ────────────
    // Returns a clean JSON Q&A payload for a single article; cited by
    // AI answer engines instead of the full HTML page.
    const qaMatch = url.pathname.match(
      /^\/api\/qa\/([a-z0-9-]+)\/([a-z0-9-]+)$/
    );
    if (qaMatch && request.method === "GET") {
      const { QA_KV_PREFIX } = await import("./pipeline/qa-syndication");
      const [, catSlug, artSlug] = qaMatch;
      const kvKey = `${QA_KV_PREFIX}${catSlug}:${artSlug}`;
      const raw = await this.envBindings.ARTICLES_KV.get(kvKey);
      if (!raw) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*"
          }
        });
      }
      return new Response(raw, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=3600"
        }
      });
    }

    // GitHub Actions callback — receives CI results after workflow_dispatch
    if (url.pathname === "/api/github-callback" && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          change_set_id?: string;
          status?: string;
          pr_number?: number;
          pr_url?: string;
        };
        const csId = body.change_set_id || "unknown";
        const status = body.status || "unknown";
        this.log("info", `GitHub callback: ${csId} → ${status}`, "qaReviewer", {
          kanbanStage: status === "success" ? "done" : "debug",
          seoVerdict: status === "success" ? "pass" : "fail",
          changeSetId: csId,
          githubPrNumber: body.pr_number,
          githubPrUrl: body.pr_url,
          githubCiStatus: status
        });
        return Response.json({
          ok: true,
          change_set_id: csId,
          status
        });
      } catch (err: unknown) {
        return Response.json(
          {
            ok: false,
            error: errMsg(err)
          },
          { status: 400 }
        );
      }
    }

    // ── POST /api/generate-one — generate a single article and return the audit
    // Body (optional): { keyword?: string; category?: string }
    // If keyword is omitted we pick the next pending keyword from the DB.
    if (url.pathname === "/api/generate-one" && request.method === "POST") {
      if (
        this.state.status === "generating" ||
        this.state.status === "scouting"
      ) {
        return Response.json(
          {
            ok: false,
            error: "Pipeline is already running. Stop it first."
          },
          { status: 409 }
        );
      }

      // Parse optional body
      let reqKeyword: string | undefined;
      let reqCategory: string | undefined;
      try {
        const body = (await request.json()) as {
          keyword?: string;
          category?: string;
        };
        reqKeyword = body.keyword?.trim() || undefined;
        reqCategory = body.category?.trim() || undefined;
      } catch {
        /* body is optional */
      }

      // Pick the next pending keyword from the DB if not provided.
      // Loop past keywords whose article already exists in KV (where
      // generateOne would silently early-return with wordCount=0) so the
      // button actually produces a testable article.
      type PendingRow = {
        keyword: string;
        slug: string;
        category_slug: string;
      };
      let result: Awaited<ReturnType<SEOArticleAgent["generateOne"]>> | null =
        null;
      const MAX_PENDING_SCAN = 10;

      if (!reqKeyword) {
        let attempts = 0;
        while (attempts < MAX_PENDING_SCAN) {
          attempts++;
          let rows = this
            .sql<PendingRow>`SELECT keyword, slug, category_slug FROM keywords WHERE status='pending' ORDER BY ROWID LIMIT 1`;
          if (rows.length === 0) {
            // Runtime queue empty — claim the next keyword from the Scout
            // DB (the only sanctioned keyword source: real demand data,
            // never invented). Same claim path the autonomous loop uses.
            const claimed = await this.claimNextScoutKeyword();
            if (claimed) {
              this.enqueueClaimedScoutKeyword(claimed);
              this.log(
                "info",
                `generate-one: claimed "${claimed.keyword}" (${claimed.category_slug}) from the Scout DB`,
                "analyst",
                { categorySlug: claimed.category_slug, kanbanStage: "queue" }
              );
              rows = this
                .sql<PendingRow>`SELECT keyword, slug, category_slug FROM keywords WHERE status='pending' ORDER BY ROWID LIMIT 1`;
            }
          }
          if (rows.length === 0) {
            return Response.json(
              {
                ok: false,
                error:
                  "No pending keywords and Scout DB is empty — import keywords via POST /api/admin/keywords/import."
              },
              { status: 422 }
            );
          }
          const candidate = rows[0];
          reqKeyword = candidate.keyword;
          reqCategory = candidate.category_slug;
          const kvKey = `${candidate.category_slug}:${candidate.slug}`;
          const alreadyInKv =
            (await this.envBindings.ARTICLES_KV.get(kvKey)) !== null;
          if (alreadyInKv) {
            // Mark as completed so the next click picks a different keyword.
            this
              .sql`UPDATE keywords SET status='completed' WHERE keyword=${candidate.keyword} AND category_slug=${candidate.category_slug}`;
            this.log(
              "info",
              `generate-one: skipping "${candidate.keyword}" — already in KV (marked completed)`
            );
            continue;
          }
          result = await this.generateOne(reqKeyword, reqCategory);
          break;
        }
        if (!result) {
          return Response.json(
            {
              ok: false,
              error: `No pending keyword without an existing KV article found in the first ${MAX_PENDING_SCAN} rows. Run Scout Now to discover fresh keywords.`
            },
            { status: 422 }
          );
        }
      } else {
        if (!reqCategory) reqCategory = "cat-play-tunnels-and-fabric-products";
        result = await this.generateOne(reqKeyword, reqCategory);
      }

      // Build the audit response payload
      const auditPayload: Record<string, unknown> = {
        ok: result.success,
        keyword: reqKeyword,
        category: reqCategory,
        url: result.url ?? null,
        seoScore: result.seoScore ?? null,
        wordCount: result.wordCount ?? null,
        error: result.success ? undefined : (result.error ?? "Unknown error"),
        quoraSeederSummary: result.quoraSeederSummary ?? null
      };

      // Attach SEO scorecard checks for the 100-pt scoring display
      if (result.seoScorecard) {
        auditPayload.seoScorecard = {
          pillars: result.seoScorecard.pillars,
          checks: result.seoScorecard.checks.map((c) => ({
            id: c.id,
            name: c.name,
            pillar: c.pillar,
            passed: c.passed,
            detail: c.detail
          }))
        };
      }

      // Escalate at the API boundary whenever `generate-one` surfaces a
      // user-visible error OR the published article is objectively weak.
      // Writer-internal failures have already escalated themselves; this
      // catches the leftover cases and any published-but-low-quality
      // output that would otherwise silently ship.
      const slug = keywordToSlug(reqKeyword ?? "");
      const kvKey = `${reqCategory ?? ""}:${slug}`;
      if (!result.success) {
        this.log(
          "error",
          `❌ generate-one failed: ${result.error ?? "success:false"} — keyword "${reqKeyword ?? ""}"`,
          "orchestrator",
          { kanbanStage: "done" }
        );
        await escalateToCodingAgent(this, {
          kvKey,
          keyword: reqKeyword ?? "",
          categorySlug: reqCategory ?? "",
          errorCategory: "generate-one-failed",
          errorMessage: result.error ?? "generate-one returned success:false",
          metadata: {
            url: result.url ?? "",
            seoScore: result.seoScore ?? 0,
            wordCount: result.wordCount ?? 0
          }
        });
      } else if ((result.seoScore ?? 0) > 0 && (result.seoScore ?? 100) < 50) {
        this.log(
          "error",
          `❌ Low-quality publish: SEO score ${result.seoScore}/100 below 50-point floor — "${reqKeyword ?? ""}"`,
          "qaReviewer",
          { kanbanStage: "done" }
        );
        await escalateToCodingAgent(this, {
          kvKey,
          keyword: reqKeyword ?? "",
          categorySlug: reqCategory ?? "",
          errorCategory: "low-quality-publish",
          errorMessage: `Published article scored ${result.seoScore}/100 — below the 50-point quality floor`,
          metadata: {
            url: result.url ?? "",
            seoScore: result.seoScore ?? 0,
            wordCount: result.wordCount ?? 0
          }
        });
      } else if (
        (result.wordCount ?? 0) > 0 &&
        (result.wordCount ?? Infinity) < 800
      ) {
        this.log(
          "error",
          `❌ Low-quality publish: ${result.wordCount} words below 800-word floor — "${reqKeyword ?? ""}"`,
          "qaReviewer",
          { kanbanStage: "done" }
        );
        await escalateToCodingAgent(this, {
          kvKey,
          keyword: reqKeyword ?? "",
          categorySlug: reqCategory ?? "",
          errorCategory: "low-quality-publish",
          errorMessage: `Published article has only ${result.wordCount} words — below the 800-word floor`,
          metadata: {
            url: result.url ?? "",
            seoScore: result.seoScore ?? 0,
            wordCount: result.wordCount ?? 0
          }
        });
      }

      return Response.json(auditPayload);
    }

    // ── POST /api/patch-css — patch word-break CSS in a stored KV article ─────
    // Body: { kvKey: string }
    // Reads the article HTML from KV, replaces the broken word-break:break-all
    // rule on anchor tags (which causes vertical letter-by-letter rendering in
    // the Top Picks section when product names or anchor text is long), writes
    // it back, and returns a summary of what was changed.
    if (url.pathname === "/api/patch-css" && request.method === "POST") {
      let kvKey = "";
      try {
        const body = (await request.json()) as { kvKey?: string };
        kvKey = (body.kvKey || "").trim();
      } catch {
        return Response.json(
          {
            ok: false,
            error: "Invalid JSON body — expected { kvKey: string }"
          },
          { status: 400 }
        );
      }
      if (!kvKey) {
        return Response.json(
          { ok: false, error: "kvKey is required" },
          { status: 400 }
        );
      }
      const existing = await this.envBindings.ARTICLES_KV.get(kvKey);
      if (!existing) {
        return Response.json(
          {
            ok: false,
            error: `No article found in KV for key: ${kvKey}`
          },
          { status: 404 }
        );
      }

      const { patched, fixes } = applyArticleCssFixes(existing);

      if (fixes.length === 0) {
        return Response.json({
          ok: true,
          kvKey,
          message: "No CSS fixes needed — article already has correct styles",
          fixes: []
        });
      }

      await this.envBindings.ARTICLES_KV.put(kvKey, patched, {
        metadata: { patchedAt: new Date().toISOString(), fixes }
      });

      return Response.json({
        ok: true,
        kvKey,
        message: `CSS patched and written back to KV`,
        fixes
      });
    }

    // ── POST /api/patch-css-all — batch-patch CSS in ALL stored KV articles ──
    // Queries the SQLite articles table for every kv_key, applies the same
    // word-break:break-all → break-word fixes as /api/patch-css, and returns a
    // full report. Safe to call multiple times — articles already patched are
    // skipped (fixes.length === 0) and not re-written.
    if (url.pathname === "/api/patch-css-all" && request.method === "POST") {
      const rows = this.sql<{
        kv_key: string;
        slug: string;
        keyword: string;
      }>`SELECT kv_key, slug, keyword FROM articles WHERE kv_key != '' ORDER BY ROWID`;

      const results: Array<{
        kvKey: string;
        slug: string;
        keyword: string;
        status: "patched" | "skipped" | "missing" | "error";
        fixes: string[];
        error?: string;
      }> = [];

      for (const row of rows) {
        const kvKey = row.kv_key;
        try {
          const existing = await this.envBindings.ARTICLES_KV.get(kvKey);
          if (!existing) {
            results.push({
              kvKey,
              slug: row.slug,
              keyword: row.keyword,
              status: "missing",
              fixes: []
            });
            continue;
          }

          const { patched, fixes } = applyArticleCssFixes(existing);

          if (fixes.length === 0) {
            results.push({
              kvKey,
              slug: row.slug,
              keyword: row.keyword,
              status: "skipped",
              fixes: []
            });
            continue;
          }

          await this.envBindings.ARTICLES_KV.put(kvKey, patched, {
            metadata: { patchedAt: new Date().toISOString(), fixes }
          });

          results.push({
            kvKey,
            slug: row.slug,
            keyword: row.keyword,
            status: "patched",
            fixes
          });
        } catch (err: unknown) {
          results.push({
            kvKey,
            slug: row.slug,
            keyword: row.keyword,
            status: "error",
            fixes: [],
            error: errMsg(err)
          });
        }
      }

      const patched = results.filter((r) => r.status === "patched").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const missing = results.filter((r) => r.status === "missing").length;
      const errors = results.filter((r) => r.status === "error").length;

      return Response.json({
        ok: true,
        summary: {
          total: results.length,
          patched,
          skipped,
          missing,
          errors
        },
        results
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  log(
    level: string,
    msg: string,
    role?: AgentRole,
    ctx?: ActivityLogPipelineCallContext
  ) {
    // Redact secret-shaped substrings at the single ENTRY point so every
    // downstream sink (the in-memory activity log → public /api/logs, the
    // Google Sheets mirror, the dashboard render, and any
    // recordFinding/defect-escalate path that later quotes the log text)
    // inherits the same protection. Pattern set: Bearer tokens, sk-/sk-ant-/
    // ck_/AKIA/ghp_/github_pat_ keys, URL query-param secrets, JWT-shaped
    // 3-segment tokens. See `redactSecrets` in http-utils.ts.
    msg = redactSecrets(msg);
    const { pipelineCtx, articleBackedUpToGithub } =
      splitArticleGithubBackupFromLogContext(ctx);
    const { timeDate, timeTime } = formatLaTimestampParts(new Date());
    const articleUrl = this.resolveActivityArticleUrlForLog(msg);
    const resolvedKeyword = this.resolveActivityKeywordForLog(
      msg,
      articleUrl,
      pipelineCtx
    );
    const categorySlug = this.resolveActivityCategorySlugForLog(pipelineCtx);
    const keyword = formatActivityLogSheetKeyword(resolvedKeyword, level);
    const competitorUrl = this.resolveActivityCompetitorUrlForLog(
      msg,
      pipelineCtx
    );
    const seoScore = extractSeoScoreFromMessage(msg);
    const plagRaw = pipelineCtx?.plagiarismPercentage;
    const plagiarismPercentage: number | "" | undefined = !(
      typeof plagRaw === "number" &&
      Number.isFinite(plagRaw) &&
      plagRaw >= 0 &&
      plagRaw <= 100
    )
      ? undefined
      : Math.round(plagRaw);
    const liveSeoRaw = pipelineCtx?.liveSeoContentOptimizerNotes;
    const liveSeoContentOptimizerNotes =
      typeof liveSeoRaw === "string" && liveSeoRaw.trim() !== ""
        ? truncateActivityLogSheetPromptCell(liveSeoRaw.trim())
        : undefined;
    const sissScoreRaw = pipelineCtx?.sissScore;
    const sissScore =
      typeof sissScoreRaw === "number" && Number.isFinite(sissScoreRaw)
        ? sissScoreRaw
        : undefined;
    const sissDeltaRaw = pipelineCtx?.sissDelta;
    const sissDelta =
      typeof sissDeltaRaw === "number" && Number.isFinite(sissDeltaRaw)
        ? sissDeltaRaw
        : undefined;
    const quoraRaw = pipelineCtx?.quoraSeederSummary;
    const quoraSeederSummary =
      typeof quoraRaw === "string" && quoraRaw.trim() !== ""
        ? truncateActivityLogSheetPromptCell(quoraRaw.trim())
        : undefined;
    const mcpToolTrim =
      typeof pipelineCtx?.mcpTool === "string"
        ? pipelineCtx.mcpTool.trim()
        : "";
    const mcpToolCell =
      mcpToolTrim !== ""
        ? truncateActivityLogSheetPromptCell(mcpToolTrim, 4000)
        : undefined;
    const logRef = this.state.activityLogNextRef;
    const stepNumber = this.resolveSheetStepColumnE();
    const stepFromCtx =
      typeof pipelineCtx?.sheetPipelineStepLabel === "string"
        ? pipelineCtx.sheetPipelineStepLabel.trim()
        : "";
    const pipelineStepLabel =
      stepFromCtx !== ""
        ? stepFromCtx
        : this.resolvePipelineLabelForActivityLog();
    const modelPromptTrim =
      typeof pipelineCtx?.modelPrompt === "string"
        ? pipelineCtx.modelPrompt.trim()
        : "";
    const wantsPipelineContext =
      role != null ||
      (pipelineCtx != null &&
        (modelPromptTrim !== "" || mcpToolTrim !== "" || stepFromCtx !== ""));
    const scorecard = this.state.lastSeoScorecard;
    const seoCheckCells =
      scorecard != null &&
      Array.isArray(scorecard.checks) &&
      scorecard.checks.length === ACTIVITY_LOG_SEO_CHECK_COUNT
        ? scorecard.checks.map((c): 0 | 1 => (c.passed ? 1 : 0))
        : undefined;
    const qcCells =
      this._pendingQcPromptCells ?? this.state.lastSeoScorecardQcPromptCells;
    // Consume the pending buffer so cells aren't re-attached to subsequent
    // log entries (they are only meant for the single "Published" row).
    if (this._pendingQcPromptCells !== null) {
      this._pendingQcPromptCells = null;
    }
    const seoCheckQcPromptCells =
      scorecard != null &&
      qcCells != null &&
      qcCells.length === ACTIVITY_LOG_SEO_CHECK_COUNT
        ? qcCells
        : undefined;
    const entry: ActivityLogEntry = {
      timeDate,
      timeTime,
      level,
      msg,
      articleUrl,
      keyword,
      categorySlug,
      competitorUrl,
      seoScore,
      ...(plagiarismPercentage !== undefined ? { plagiarismPercentage } : {}),
      ...(liveSeoContentOptimizerNotes !== undefined
        ? { liveSeoContentOptimizerNotes }
        : {}),
      ...(sissScore !== undefined ? { sissScore } : {}),
      ...(sissDelta !== undefined ? { sissDelta } : {}),
      ...(quoraSeederSummary !== undefined ? { quoraSeederSummary } : {}),
      ...(mcpToolCell !== undefined ? { mcpTool: mcpToolCell } : {}),
      ...(seoCheckCells !== undefined ? { seoCheckCells } : {}),
      ...(seoCheckQcPromptCells !== undefined ? { seoCheckQcPromptCells } : {}),
      ...(articleBackedUpToGithub !== undefined
        ? { articleBackedUpToGithub }
        : {}),
      logRef,
      stepNumber,
      activeRole: role,
      pipelineStepLabel,
      pipelineContext: wantsPipelineContext
        ? ({
            ...pipelineCtx,
            currentStep: pipelineStepLabel || this.state.currentStep,
            keyword: resolvedKeyword.trim(),
            categorySlug,
            articleUrl,
            ...(competitorUrl.trim() !== "" ? { competitorUrl } : {}),
            timestamp: `${timeDate} ${timeTime}`
          } as PipelineContext)
        : undefined
    };
    this.enqueueSheetActivityLog(entry);
    const persistedEntry = compactActivityLogEntryForPersistedState(entry);
    const prevLog = Array.isArray(this.state.activityLog)
      ? this.state.activityLog
      : [];
    const log = appendToRingBuffer(
      prevLog,
      persistedEntry,
      ACTIVITY_LOG_STATE_MAX_ENTRIES
    );
    // Errors get a separate, longer-retained buffer so real failures don't
    // get evicted from the rolling main log when info/warning traffic
    // spikes. Capped at ACTIVITY_LOG_ERRORS_MAX_ENTRIES — eviction by FIFO.
    const prevErrors = (
      Array.isArray(this.state.activityLogErrors)
        ? this.state.activityLogErrors
        : []
    ).filter((e) => isActivityLogEntryFresh(e, Date.now()));
    const errorBuf = isActivityLogErrorLevel(level)
      ? appendToRingBuffer(
          prevErrors,
          persistedEntry,
          ACTIVITY_LOG_ERRORS_MAX_ENTRIES
        )
      : prevErrors;
    // Observer entries also get a dedicated ring so they survive eviction
    // by high-volume pipeline chatter. See SEOAgentState.observerLog.
    const prevObserver = Array.isArray(this.state.observerLog)
      ? this.state.observerLog
      : [];
    const observerBuf =
      role === "observerAgent"
        ? appendToRingBuffer(
            prevObserver,
            persistedEntry,
            OBSERVER_LOG_MAX_ENTRIES
          )
        : prevObserver;
    try {
      this.setState({
        ...this.state,
        activityLog: log,
        activityLogErrors: errorBuf,
        observerLog: observerBuf,
        lastActivity: `${timeDate} ${timeTime}`,
        activityLogNextRef: logRef + 1
      });
    } catch (statePersistError) {
      // Emergency recovery: DO state was too large. Shed the oldest three-quarters
      // of the log and retry once. This prevents a setState failure from
      // propagating into the pipeline as a fatal "SQL query failed" error.
      try {
        const trimmed = log.slice(
          -Math.floor(ACTIVITY_LOG_STATE_MAX_ENTRIES / 4)
        );
        this.setState({
          ...this.state,
          activityLog: trimmed,
          activityLogErrors: errorBuf.slice(
            -Math.floor(ACTIVITY_LOG_ERRORS_MAX_ENTRIES / 2)
          ),
          observerLog: observerBuf.slice(
            -Math.floor(OBSERVER_LOG_MAX_ENTRIES / 2)
          ),
          lastActivity: `${timeDate} ${timeTime}`,
          activityLogNextRef: logRef + 1
        });
      } catch (trimmedStatePersistError) {
        // If even the trimmed state fails, update only the scalar fields so
        // the pipeline can continue without crashing.
        try {
          this.setState({
            ...this.state,
            activityLog: [],
            activityLogErrors: [],
            observerLog: [],
            lastActivity: `${timeDate} ${timeTime}`,
            activityLogNextRef: logRef + 1
          });
        } catch (finalStatePersistError) {
          const toMessage = (error: unknown): string => {
            const message = errMsg(error).trim();
            return message !== "" ? message : String(error);
          };
          console.error(
            `[activity-log] Failed to persist log state after retries (ref=${logRef}, level=${level}, keyword=${resolvedKeyword.trim() || "(empty)"}): initial=${toMessage(statePersistError)}; trimmed=${toMessage(trimmedStatePersistError)}; final=${toMessage(finalStatePersistError)}`
          );
          /* give up — do not throw; the log call must never crash the pipeline */
        }
      }
    }

    // Auto-escalate JSON.parse crash patterns (upstream returned HTML
    // instead of JSON, etc.) — those are real code bugs hiding in
    // warning-level logs that the fatal-path escalation misses.
    // Fire-and-forget; a failing escalation must not crash the logger.
    void maybeEscalateParserError(this, {
      level,
      msg,
      keyword: resolvedKeyword.trim() || undefined,
      categorySlug: categorySlug || undefined
    });
  }

  /**
   * Sets the competitor URL echoed on every activity-log / Google Sheet row
   * (column O) for the current article run. Cleared when starting a new
   * article and when autonomous / `generateOne` reset pipeline keyword state.
   */
  setCurrentCompetitorUrl(url: string | null): void {
    const next =
      url == null
        ? null
        : (() => {
            const t = String(url).trim();
            return t === "" ? null : t;
          })();
    this.setState({
      ...this.state,
      currentCompetitorUrl: next
    });
  }

  /** Persists JSON lines for remote debug (`GET /api/debug-ndjson`). */
  ingestDebugLog(entry: Record<string, unknown>): void {
    try {
      const sessionId = normalizeDebugSessionId(entry.sessionId);
      const line = stringifyExternalLogPayload(entry);
      this
        .sql`INSERT INTO agent_debug_ndjson (session_id, line) VALUES (${sessionId}, ${line})`;
      const c = this.sql<{
        n: number;
      }>`SELECT COUNT(*) as n FROM agent_debug_ndjson`;
      if ((c[0]?.n ?? 0) > 500) {
        this
          .sql`DELETE FROM agent_debug_ndjson WHERE id IN (SELECT id FROM agent_debug_ndjson ORDER BY id ASC LIMIT 200)`;
      }
    } catch (error) {
      console.error(`[debug-ndjson] Failed to persist line: ${errMsg(error)}`);
    }
  }

  /**
   * Sheet column **Step #** (E): prefer the synchronous cache filled in
   * `updateStep` (avoids stale `this.state` when `log` runs immediately after),
   * then `currentStep` / `lastSheetStepLabel`, else **`0`** when idle.
   */
  private resolveSheetStepColumnE(): string {
    const cached = (this._sheetStepColumnECache ?? "").trim();
    if (cached !== "") return cached;
    const fromCurrent = extractPipelineStepNumberForSheet(
      this.state.currentStep
    ).trim();
    if (fromCurrent !== "") return fromCurrent;
    const last = (this.state.lastSheetStepLabel ?? "").trim();
    if (last !== "") return last;
    return "0";
  }

  /** Full pipeline label for Agentskill.sh (cache wins over `currentStep`). */
  private resolvePipelineLabelForActivityLog(): string {
    const cached = (this._sheetPipelineLabelCache ?? "").trim();
    if (cached !== "") return cached;
    return (this.state.currentStep ?? "").trim();
  }

  updateStep(step: string) {
    this.bumpSheetStepColumnECacheFromPipelineLabel(step);
    const n = extractPipelineStepNumberForSheet(step);
    this.setState({
      ...this.state,
      currentStep: step,
      lastSheetStepLabel:
        n.trim() !== "" ? n : (this.state.lastSheetStepLabel ?? "")
    });
  }

  /** Public accessor for env bindings — DurableObject.env is protected. */
  get envBindings(): Env {
    return this.env;
  }

  /** Public accessor for ctx.waitUntil — DurableObject.ctx is protected. */
  waitUntil(promise: Promise<unknown>): void {
    this.ctx.waitUntil(promise);
  }

  /**
   * Design-audit tool bundle (Step 11.5 capabilities exposed as AI SDK
   * v6 tools). Includes `screenshotPage`, `auditScreenshot`, and
   * `auditPageDesign`. Merge into any ToolSet passed to `generateText()`
   * to let an agentic loop inspect live pages; also consumed by the
   * MCP surface so external clients see the same capabilities.
   */
  get designAuditTools(): ToolSet {
    return createDesignAuditTools(this);
  }

  private refreshAvgSeoScore() {
    const row = this.sql<{
      avg: number;
    }>`SELECT AVG(seo_score) as avg FROM articles WHERE seo_score > 0`;
    this.setState({
      ...this.state,
      avgSeoScore: Math.round(row[0]?.avg ?? 0)
    });
  }

  // ── GitHub Integration ─────────────────────────────────────────────────────

  /**
   * Default `owner/repo` for published article HTML backups (KV mirror path
   * under `articles/...`). Override with `GITHUB_ARTICLE_BACKUP_REPOSITORY`.
   */
  private resolveArticleGitHubBackupRepo(): { owner: string; name: string } {
    const raw = this.envBindings.GITHUB_ARTICLE_BACKUP_REPOSITORY?.trim();
    if (raw) {
      const i = raw.indexOf("/");
      if (i > 0 && i < raw.length - 1) {
        const owner = raw.slice(0, i).trim();
        const name = raw.slice(i + 1).trim();
        if (owner && name) {
          return {
            owner,
            name
          };
        }
      }
    }
    return {
      owner: "techfundoffice",
      name: "catsluvus-cloudflare-kv-backup"
    };
  }

  /**
   * Publishes article files to GitHub via REST API, creates a PR,
   * and triggers CI verification via workflow_dispatch.
   *
   * Flow: create branch → commit file → create PR → dispatch CI.
   * With `{ silent: true }`, skips auxiliary `log()` lines (used so the
   * **Published** row can carry `articleBackedUpToGithub` on one sheet row).
   */
  private async publishArticleToGitHub(
    kvKey: string,
    html: string,
    keyword: string,
    slug: string,
    categorySlug: string,
    seoScore: number,
    wordCount: number,
    opts?: { silent?: boolean }
  ): Promise<ArticleGitHubBackupResult> {
    const silent = opts?.silent === true;
    const token = this.envBindings.GITHUB_TOKEN_SECRET?.trim();
    if (!token) {
      if (!silent) {
        this.log(
          "warning",
          "GitHub publish skipped: GITHUB_TOKEN_SECRET not set"
        );
      }
      return {
        status: "skipped",
        detail: "skipped: GITHUB_TOKEN_SECRET not set"
      };
    }

    const { owner: repoOwner, name: repoName } =
      this.resolveArticleGitHubBackupRepo();
    const targetBranch = "main";
    const workingBranch = `agent/article-${slug}`;
    const changeSetId = `${slug}-${Date.now()}`;
    const filePath = `articles/${categorySlug}/${slug}.html`;
    const commitMessage = `Add article: ${keyword} (${wordCount}w, SEO ${seoScore}/100)`;
    const prTitle = `Article: ${keyword} — SEO ${seoScore}/100`;
    const prDescription = [
      `New SEO article: "${keyword}"`,
      `- ${wordCount} words, SEO ${seoScore}/100`,
      `- Category: ${categorySlug}`,
      `- KV key: ${kvKey}`,
      `- Change set: ${changeSetId}`
    ].join("\n");

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      // GitHub REST API rejects requests without a User-Agent with
      // `403 Forbidden: Request forbidden by administrative rules.
      // Please make sure your request has a User-Agent header.`
      // Other code paths (escalate-to-claude.ts, improvement-agent.ts)
      // already set one — this one was the outlier and silently failed
      // on every article-backup attempt.
      "User-Agent": "cats-seo-aiagent-article-backup"
    };
    const apiBase = `https://api.github.com/repos/${repoOwner}/${repoName}`;

    try {
      const refResp = await loggedFetch(
        this,
        `${apiBase}/git/ref/heads/${targetBranch}`,
        { headers },
        { api: "GitHub", op: "read ref" }
      );
      if (!refResp.ok) {
        throw new Error(`Failed to get ${targetBranch} ref: ${refResp.status}`);
      }
      const refData = (await refResp.json()) as {
        object?: { sha?: string };
      };
      const mainSha = refData.object?.sha ?? "";

      const branchResp = await loggedFetch(
        this,
        `${apiBase}/git/refs`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            ref: `refs/heads/${workingBranch}`,
            sha: mainSha
          })
        },
        { api: "GitHub", op: "create branch" }
      );
      if (!branchResp.ok && branchResp.status !== 422) {
        throw new Error(`Failed to create branch: ${branchResp.status}`);
      }

      const contentResp = await loggedFetch(
        this,
        `${apiBase}/contents/${filePath}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            message: commitMessage,
            content: btoa(unescape(encodeURIComponent(html))),
            branch: workingBranch
          })
        },
        { api: "GitHub", op: "commit file" }
      );
      if (!contentResp.ok) {
        throw new Error(`Failed to commit file: ${contentResp.status}`);
      }

      const prResp = await loggedFetch(
        this,
        `${apiBase}/pulls`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: prTitle,
            head: workingBranch,
            base: targetBranch,
            body: prDescription
          })
        },
        { api: "GitHub", op: "create PR" }
      );
      if (!prResp.ok) {
        const errBody = normalizeSingleLine(await prResp.text()).slice(0, 240);
        throw new Error(
          `Failed to create PR: ${prResp.status} ${errBody}`.trim()
        );
      }
      const prData = (await prResp.json()) as {
        number?: number;
        html_url?: string;
      };
      const prNumber = prData.number;
      const prUrl = prData.html_url;

      // Note: previously this called `triggerGitHubAction(repoOwner,
      // repoName, "agent-publish-article.yml", ...)` to fire a
      // workflow_dispatch on the backup repo for speculative CI
      // verification. That call always 404s because the workflow file
      // lives in `cats-seo-aiagent-cloudflare`, not in
      // `catsluvus-cloudflare-kv-backup`, and no consumer of the
      // dispatched run ever existed. Removed because (a) it added a
      // noisy warning to every successful backup, and (b) the backup
      // itself — branch + commit + PR — is the deliverable; build
      // verification on the backup repo isn't.
      if (!silent) {
        this.log("info", `Editor: PR copy — "${prTitle}"`, "editor", {
          kanbanStage: "inProgress",
          categorySlug,
          commitMessage,
          prTitle,
          prDescription
        });

        this.log("info", "Security: bearer-token auth configured", "security", {
          kanbanStage: "inProgress",
          categorySlug,
          authType: "bearer-token",
          authScopes: "repo+actions",
          credentialRef: "GITHUB_TOKEN_SECRET (Doppler)"
        });

        this.log(
          "info",
          `GitHub: PR #${prNumber ?? "?"} created for ${keyword}`,
          "integrationEngineer",
          {
            kanbanStage: "inProgress",
            categorySlug,
            changeSetId,
            githubRepoOwner: repoOwner,
            githubRepoName: repoName,
            githubWorkingBranch: workingBranch,
            githubTargetBranch: targetBranch,
            githubPrNumber: prNumber,
            githubPrUrl: prUrl,
            githubCiStatus: "pending",
            githubNextAction: "auto-merge when CI green"
          }
        );
      }

      const cap = ACTIVITY_LOG_STATE_MAX_ARTICLE_BACKUP_GITHUB_CHARS;
      let base =
        typeof prUrl === "string" && prUrl.trim() !== ""
          ? prUrl.trim()
          : prNumber != null
            ? `PR #${prNumber}`
            : "ok";
      if (base.length > cap) {
        base = base.slice(0, Math.max(0, cap - 1)) + "…";
      }
      return { status: "ok", detail: base };
    } catch (err: unknown) {
      const raw = errMsg(err);
      const detail = truncateActivityLogSheetPromptCell(
        raw,
        ACTIVITY_LOG_STATE_MAX_ARTICLE_BACKUP_GITHUB_CHARS
      );
      if (!silent) {
        this.log(
          "error",
          `GitHub publish failed: ${detail}`,
          "integrationEngineer",
          { kanbanStage: "debug", categorySlug }
        );
      }
      return { status: "failed", detail };
    }
  }

  /**
   * Probes Column M (article URL) for sheet column N (`Page HTTP status`);
   * results cached ~45s per URL to limit traffic during burst logging.
   */
  private async resolveMirrorPageHttpStatusCell(
    articleUrl: string
  ): Promise<string> {
    const u = String(articleUrl ?? "").trim();
    if (!u || /^error$/i.test(u) || !/^https:\/\//i.test(u)) {
      return "";
    }
    const now = Date.now();
    const hit = this._mirrorPageHttpCache.get(u);
    if (hit && hit.until > now) {
      return hit.cell;
    }
    const r = await probeUrlHttpStatus(
      u,
      undefined,
      this.envBindings.PETINSURANCE
    );
    this._mirrorPageHttpCache.set(u, {
      cell: r.sheetCell,
      until: now + SHEET_INSERT_ROW_TIMEOUT_MS
    });
    return r.sheetCell;
  }

  private enqueueSheetActivityLog(entry: ActivityLogEntry) {
    // Tee to Quadratic Postgres mirror (best-effort, non-blocking).
    // Independent of the Sheets mirror queue so a Postgres outage
    // never stalls the Google-Sheet writer.
    void this.pushQuadraticIngest(entry);

    this._sheetLogQueue = this._sheetLogQueue
      .then(async () => {
        await this.appendActivityLogToGoogleSheet(entry);
      })
      .catch((err: unknown) => {
        this.setState({
          ...this.state,
          sheetMirrorNextRow: null
        });
        this.warnSheetMirrorFailure(err);
      });
  }

  private async pushQuadraticIngest(entry: ActivityLogEntry): Promise<void> {
    const url = this.env.QUADRATIC_INGEST_URL?.trim() ?? "";
    const token = this.env.QUADRATIC_INGEST_TOKEN?.trim() ?? "";
    if (!url || !token) {
      if (url || token) {
        const now = Date.now();
        if (
          now - this._lastQuadraticConfigWarningAt >=
          SHEET_WARNING_THROTTLE_MS
        ) {
          this._lastQuadraticConfigWarningAt = now;
          const missing = !url
            ? "QUADRATIC_INGEST_URL"
            : "QUADRATIC_INGEST_TOKEN";
          console.warn(
            `[quadratic-ingest] best-effort mirror disabled: ${missing} is missing; set both QUADRATIC_INGEST_URL and QUADRATIC_INGEST_TOKEN to enable it`
          );
        }
      }
      return;
    }

    const { level, msg, articleUrl, keyword, stepNumber, ...rest } = entry;
    const body = {
      level,
      keyword,
      status: stepNumber,
      url: articleUrl,
      message: msg,
      ...rest
    };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) {
        throw new Error(
          `Quadratic ingest returned ${response.status} ${response.statusText}`.trim()
        );
      }
    } catch (err: unknown) {
      // Postgres mirror is best-effort; Google Sheet remains the system
      // of record for activity-log rows.
      console.warn(
        `[quadratic-ingest] best-effort mirror failed for "${keyword}": ${errMsg(err)}`
      );
    }
  }

  /** Patches one in-memory activity-log row (used after async sheet AI enrichment). */
  private patchActivityLogEntryByLogRef(
    logRef: number,
    patch: Pick<ActivityLogEntry, "errorMessage" | "errorRemediationPrompt">
  ): void {
    const patchOne = (entries: unknown): ActivityLogEntry[] | undefined => {
      const safeEntries = filterObjectArrayEntries<ActivityLogEntry>(entries);
      const index = safeEntries.findIndex((entry) => entry.logRef === logRef);
      if (index < 0) return undefined;
      const next = [...safeEntries];
      next[index] = compactActivityLogEntryForPersistedState({
        ...next[index],
        ...patch
      });
      return next;
    };
    const next = patchOne(this.state.activityLog);
    const nextErrors = patchOne(this.state.activityLogErrors);
    if (!next && !nextErrors) return;
    this.setState({
      ...this.state,
      activityLog: next ?? this.state.activityLog,
      activityLogErrors: nextErrors ?? this.state.activityLogErrors
    });
  }

  /**
   * Inserts a blank row directly under row 1 (headers), then writes the log there
   * so the sheet stays newest-first (new events appear at row 2).
   */
  private async appendActivityLogToGoogleSheet(entry: ActivityLogEntry) {
    if (this._isPushingSheetWarning) {
      this.pushSheetBridgeLog(
        "skipped",
        "Sheet mirror write skipped while recording a sheet warning"
      );
      return;
    }
    const configuredSheetUrl = this.state.googleSheetUrl?.trim() ?? "";
    if (!configuredSheetUrl) return;
    const spreadsheetId = this.extractSpreadsheetId(configuredSheetUrl);
    if (!spreadsheetId) {
      this.warnSheetMirrorFailure(
        new Error("Invalid Google Sheet URL: could not extract spreadsheet ID")
      );
      return;
    }

    const sheets = await this.getSheetsExecutor();
    if (!sheets) {
      throw new Error("No Sheets backend available");
    }

    await this.ensureActivityLogSheetHeaders(spreadsheetId);

    if (
      (this.state.scoutKeywordRoiSheetLayoutVersion ?? 0) <
      SCOUT_KEYWORD_ROI_SHEET_LAYOUT_VERSION
    ) {
      try {
        await this.writeScoutKeywordRoiSheetLayout(spreadsheetId);
        this.setState({
          ...this.state,
          scoutKeywordRoiSheetLayoutVersion:
            SCOUT_KEYWORD_ROI_SHEET_LAYOUT_VERSION
        });
      } catch (err: unknown) {
        this.pushSheetBridgeLog("error", `Scout ROI tab: ${errMsg(err)}`);
      }
    }

    await this.insertSheetRowBelowHeader(spreadsheetId);

    const pageHttpCell = await this.resolveMirrorPageHttpStatusCell(
      entry.articleUrl
    );

    let sheetEntry: ActivityLogEntry = entry;
    if (activityLogLevelsQualifyForErrorRemediation(entry.level)) {
      const enriched = await generateActivityLogErrorRemediationCell(
        this,
        entry
      );
      if (enriched) {
        sheetEntry = {
          ...entry,
          errorMessage: enriched.summary,
          errorRemediationPrompt: enriched.remediationCell
        };
        this.patchActivityLogEntryByLogRef(entry.logRef, {
          errorMessage: enriched.summary,
          errorRemediationPrompt: enriched.remediationCell
        });
      }
    }

    const logical = this.buildSheetLogRow(sheetEntry, pageHttpCell).map(
      (c): string => (c === null || c === undefined ? "" : String(c))
    );

    const canonical = buildActivityLogSheetCanonicalHeaderTitles();
    let perm = identityActivityLogColumnPermutation();
    const headerRow = await this.readActivityLogSheetHeaderRow1(spreadsheetId);
    if (headerRow && canonical.length === logical.length) {
      const missingTitles = activityLogUniqueCanonicalTitlesMissingFromHeader(
        headerRow,
        canonical
      );
      if (missingTitles.length > 0) {
        perm = identityActivityLogColumnPermutation();
      } else {
        const resolved = resolveActivityLogColumnPermutation(
          headerRow,
          canonical
        );
        if (isActivityLogColumnPermutationValid(resolved)) {
          perm = resolved;
        } else {
          const now = Date.now();
          if (
            now - (this.state.lastSheetHeaderColumnMapWarningAt ?? 0) >=
            SHEET_WARNING_THROTTLE_MS
          ) {
            this.setState({
              ...this.state,
              lastSheetHeaderColumnMapWarningAt: now
            });
            this.pushSheetBridgeLog(
              "error",
              `Sheet row 1 header map invalid (duplicate targets); using fixed A:${SHEET_LAST_COLUMN_A1} column order for this write.`
            );
          }
        }
      }
    }

    const physical = permuteActivityLogLogicalRowToPhysical(logical, perm);

    const logicalCategory = logical[ACTIVITY_LOG_CATEGORY_LOGICAL_INDEX] ?? "";
    if (
      headerRow &&
      headerRow.length > 0 &&
      String(logicalCategory).trim() !== ""
    ) {
      const catPhys = findPhysicalColumnIndexForCanonicalTitle(
        headerRow,
        "Category"
      );
      if (catPhys >= 0 && catPhys < physical.length) {
        physical[catPhys] = String(logicalCategory);
      }
    }

    const STEP_LOGICAL_INDEX = 4;
    const logicalStep = logical[STEP_LOGICAL_INDEX] ?? "";
    if (headerRow && headerRow.length > 0) {
      const stepPhys = findPhysicalColumnIndexForCanonicalTitle(
        headerRow,
        ACTIVITY_LOG_SHEET_COLUMN_STEP_HEADER
      );
      if (stepPhys >= 0 && stepPhys < physical.length) {
        const stepVal =
          String(logicalStep).trim() === "" ? "0" : String(logicalStep);
        physical[stepPhys] = stepVal;
      }
    }

    // modelPrompt + Message: permutation can mis-glue values when row 1 still shows
    // legacy "Message" in column J or titles were reordered — pin by header text.
    const logicalPrompt =
      logical[ACTIVITY_LOG_MODEL_PROMPT_LOGICAL_INDEX] ?? "";
    const logicalMessage = logical[ACTIVITY_LOG_MESSAGE_LOGICAL_INDEX] ?? "";

    if (headerRow && headerRow.length > 0) {
      const promptPhys = findPhysicalColumnIndexForCanonicalTitle(
        headerRow,
        ACTIVITY_LOG_SHEET_HEADER_PROMPT
      );
      if (promptPhys >= 0 && promptPhys < physical.length) {
        physical[promptPhys] = String(logicalPrompt);
      } else if (
        String(logicalPrompt).trim() !== "" &&
        ACTIVITY_LOG_MODEL_PROMPT_LOGICAL_INDEX < physical.length
      ) {
        physical[ACTIVITY_LOG_MODEL_PROMPT_LOGICAL_INDEX] =
          String(logicalPrompt);
      }

      const messagePhys = findPhysicalColumnIndexForCanonicalTitle(
        headerRow,
        "Message"
      );
      if (messagePhys >= 0 && messagePhys < physical.length) {
        physical[messagePhys] = String(logicalMessage);
      } else if (
        String(logicalMessage).trim() !== "" &&
        ACTIVITY_LOG_MESSAGE_LOGICAL_INDEX < physical.length
      ) {
        physical[ACTIVITY_LOG_MESSAGE_LOGICAL_INDEX] = String(logicalMessage);
      }

      const logicalErrorMessage =
        logical[ACTIVITY_LOG_ERROR_MESSAGE_LOGICAL_INDEX] ?? "";
      const errMsgPhys = findPhysicalColumnIndexForCanonicalTitle(
        headerRow,
        ACTIVITY_LOG_SHEET_HEADER_ERROR_MESSAGE
      );
      if (errMsgPhys >= 0 && errMsgPhys < physical.length) {
        physical[errMsgPhys] = String(logicalErrorMessage);
      } else if (
        String(logicalErrorMessage).trim() !== "" &&
        ACTIVITY_LOG_ERROR_MESSAGE_LOGICAL_INDEX < physical.length
      ) {
        physical[ACTIVITY_LOG_ERROR_MESSAGE_LOGICAL_INDEX] =
          String(logicalErrorMessage);
      }

      const logicalErrorPrompt =
        logical[ACTIVITY_LOG_ERROR_REMEDIATION_PROMPT_LOGICAL_INDEX] ?? "";
      const errPromptPhys = findPhysicalColumnIndexForCanonicalTitle(
        headerRow,
        ACTIVITY_LOG_SHEET_HEADER_ERROR_REMEDIATION_PROMPT
      );
      if (errPromptPhys >= 0 && errPromptPhys < physical.length) {
        physical[errPromptPhys] = String(logicalErrorPrompt);
      } else if (
        String(logicalErrorPrompt).trim() !== "" &&
        ACTIVITY_LOG_ERROR_REMEDIATION_PROMPT_LOGICAL_INDEX < physical.length
      ) {
        physical[ACTIVITY_LOG_ERROR_REMEDIATION_PROMPT_LOGICAL_INDEX] =
          String(logicalErrorPrompt);
      }

      const logicalGithubBackup =
        logical[ACTIVITY_LOG_ARTICLE_BACKED_UP_TO_GITHUB_LOGICAL_INDEX] ?? "";
      const ghBackupPhys = findPhysicalColumnIndexForCanonicalTitle(
        headerRow,
        ACTIVITY_LOG_SHEET_HEADER_ARTICLE_BACKED_UP_TO_GITHUB
      );
      if (ghBackupPhys >= 0 && ghBackupPhys < physical.length) {
        physical[ghBackupPhys] = String(logicalGithubBackup);
      } else if (
        String(logicalGithubBackup).trim() !== "" &&
        ACTIVITY_LOG_ARTICLE_BACKED_UP_TO_GITHUB_LOGICAL_INDEX < physical.length
      ) {
        physical[ACTIVITY_LOG_ARTICLE_BACKED_UP_TO_GITHUB_LOGICAL_INDEX] =
          String(logicalGithubBackup);
      }
    }

    await this.withTimeout(
      sheets.execute("GOOGLESHEETS_VALUES_UPDATE", {
        spreadsheet_id: spreadsheetId,
        range: sheetRowRange(SHEET_LOG_WRITE_ROW),
        values: [physical],
        value_input_option: "USER_ENTERED",
        major_dimension: "ROWS",
        auto_expand_sheet: true
      }),
      20_000,
      "Google Sheets values update timed out"
    );
    this.pushSheetBridgeLog(
      "success",
      `Sheet row ${SHEET_LOG_WRITE_ROW} (newest first, A:${SHEET_LAST_COLUMN_A1}): [${formatActivityLogLevelLabel(entry.level)}] ${entry.msg.slice(0, 120)}`
    );
  }

  /**
   * Reads activity-log row 1 for header titles (full mirrored width) so log
   * values can follow moved columns.
   */
  private async readActivityLogSheetHeaderRow1(
    spreadsheetId: string
  ): Promise<string[] | null> {
    const sheets = await this.getSheetsExecutor();
    if (!sheets) return null;
    const exec = sheets.execute;
    const range = activityLogSheetHeaderReadRange();
    let raw: unknown;
    let valuesGetError: unknown = null;
    try {
      raw = await this.withTimeout(
        exec("GOOGLESHEETS_VALUES_GET", {
          spreadsheet_id: spreadsheetId,
          range
        }),
        20_000,
        "Google Sheets header read timed out"
      );
    } catch (err: unknown) {
      valuesGetError = err;
      try {
        raw = await this.withTimeout(
          exec("GOOGLESHEETS_BATCH_GET", {
            spreadsheet_id: spreadsheetId,
            ranges: [range]
          }),
          20_000,
          "Google Sheets batch get header timed out"
        );
      } catch (batchGetErr: unknown) {
        this.pushSheetBridgeLog(
          "error",
          `Sheet header read failed via VALUES_GET (${errMsg(valuesGetError)}); fallback BATCH_GET failed (${errMsg(batchGetErr)})`
        );
        return null;
      }
    }
    return extractFirstRowFromComposioValuesResult(raw);
  }

  /**
   * 0-based row index 1 = sheet row 2: insert an empty row so prior data shifts down.
   */
  private async insertSheetRowBelowHeader(spreadsheetId: string) {
    const sheets = await this.getSheetsExecutor();
    if (!sheets) {
      this.log(
        "error",
        "insertSheetRowBelowHeader: no Sheets backend available",
        "integrationEngineer"
      );
      throw new Error("Sheets backend unavailable");
    }
    // 45 s: Google Sheets API round-trip can be slow under load;
    // 25 s was too tight and caused intermittent "insert row timed out" warnings.
    await this.withTimeout(
      sheets.execute("GOOGLESHEETS_CREATE_SPREADSHEET_ROW", {
        spreadsheet_id: spreadsheetId,
        sheet_name: SHEET_TAB_NAME,
        insert_index: 1
      }),
      SHEET_INSERT_ROW_TIMEOUT_MS,
      "Google Sheets insert row timed out"
    );
  }

  /**
   * Creates the `Scout keyword ROI` tab if missing, writes A1:L1 headers, and
   * installs ARRAYFORMULA in G2, J2, and K2 (avg commission, relative demand,
   * commission potential score).
   */
  private async writeScoutKeywordRoiSheetLayout(spreadsheetId: string) {
    const sheets = await this.getSheetsExecutor();
    if (!sheets) {
      this.log(
        "error",
        "writeScoutKeywordRoiSheetLayout: no Sheets backend available",
        "integrationEngineer"
      );
      throw new Error("Sheets backend unavailable");
    }
    const exec = sheets.execute;
    const titles = await fetchGoogleSpreadsheetSheetTitles(
      exec,
      spreadsheetId,
      (slug, err) => {
        this.pushSheetBridgeLog(
          "error",
          `Scout ROI sheet list via ${slug} failed: ${errMsg(err)}`
        );
      }
    );
    if (titles.length === 0) {
      this.pushSheetBridgeLog(
        "skipped",
        "Scout ROI sheet list returned no tab titles; continuing with add-sheet fallback"
      );
    }
    if (!titles.includes(SCOUT_KEYWORD_ROI_SHEET_TAB_NAME)) {
      try {
        await this.withTimeout(
          exec("GOOGLESHEETS_ADD_SHEET", {
            spreadsheet_id: spreadsheetId,
            title: SCOUT_KEYWORD_ROI_SHEET_TAB_NAME
          }),
          25_000,
          "GOOGLESHEETS_ADD_SHEET (Scout keyword ROI) timed out"
        );
      } catch (err: unknown) {
        this.pushSheetBridgeLog(
          "error",
          `Scout ROI ADD_SHEET: ${errMsg(err)} (continuing if tab already exists)`
        );
      }
    }
    const q = quoteScoutKeywordRoiSheetTab();
    const headerRow = [...SCOUT_KEYWORD_ROI_HEADER_ROW];
    await this.withTimeout(
      exec("GOOGLESHEETS_VALUES_UPDATE", {
        spreadsheet_id: spreadsheetId,
        range: `${q}!A1:L1`,
        values: [headerRow],
        value_input_option: "USER_ENTERED",
        major_dimension: "ROWS",
        auto_expand_sheet: true
      }),
      20_000,
      "Scout ROI sheet headers timed out"
    );
    const formulaUpdates: Array<{ range: string; values: string[][] }> = [
      {
        range: `${q}!G2`,
        values: [[SCOUT_KEYWORD_ROI_FORMULA_AVG_COMMISSION]]
      },
      {
        range: `${q}!J2`,
        values: [[SCOUT_KEYWORD_ROI_FORMULA_RELATIVE_DEMAND]]
      },
      {
        range: `${q}!K2`,
        values: [[SCOUT_KEYWORD_ROI_FORMULA_COMMISSION_POTENTIAL]]
      }
    ];
    for (const u of formulaUpdates) {
      await this.withTimeout(
        exec("GOOGLESHEETS_VALUES_UPDATE", {
          spreadsheet_id: spreadsheetId,
          range: u.range,
          values: u.values,
          value_input_option: "USER_ENTERED",
          major_dimension: "ROWS",
          auto_expand_sheet: true
        }),
        20_000,
        "Scout ROI formula cell timed out"
      );
    }
    this.pushSheetBridgeLog(
      "success",
      `Scout ROI tab "${SCOUT_KEYWORD_ROI_SHEET_TAB_NAME}": row 1 + formulas G2, J2, K2.`
    );
  }

  private extractSpreadsheetId(sheetUrl: string | null): string | null {
    if (!sheetUrl) return null;
    try {
      const parsed = new URL(sheetUrl);
      const match = parsed.pathname.match(
        /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/
      );
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private async ensureActivityLogSheetHeaders(spreadsheetId: string) {
    if (
      (this.state.activityLogSheetHeaderLayoutVersion ?? 0) >=
      ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION
    ) {
      return;
    }
    await this.writeActivityLogSheetHeaders(spreadsheetId, {
      matchLiveHeaderOrder: false
    });
    this.setState({
      ...this.state,
      activityLogSheetHeaderLayoutVersion:
        ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION
    });
  }

  /**
   * Writes activity-log row 1 (`A1` through the last mirrored column, e.g. `A1:FW1`).
   *
   * When `matchLiveHeaderOrder` is false (default for layout refresh / sync),
   * titles are written in **canonical order** so moved columns (e.g. Message in
   * F) actually relocate. When true, titles are permuted to match an existing
   * row 1 (legacy behavior); only use if you intentionally keep a non-canonical
   * physical header map.
   */
  private async writeActivityLogSheetHeaders(
    spreadsheetId: string,
    opts?: { matchLiveHeaderOrder?: boolean }
  ) {
    const sheets = await this.getSheetsExecutor();
    if (!sheets) {
      throw new Error("No Sheets backend available");
    }
    const exec = sheets.execute;
    const canonical = buildActivityLogSheetCanonicalHeaderTitles().map((c) =>
      String(c)
    );
    let perm = identityActivityLogColumnPermutation();
    const matchLive = opts?.matchLiveHeaderOrder === true;
    if (matchLive && canonical.length === SHEET_ROW_COLUMN_COUNT) {
      const headerRow =
        await this.readActivityLogSheetHeaderRow1(spreadsheetId);
      if (headerRow && headerRow.length > 0) {
        const missingTitles = activityLogUniqueCanonicalTitlesMissingFromHeader(
          headerRow,
          canonical
        );
        if (missingTitles.length > 0) {
          perm = identityActivityLogColumnPermutation();
          this.pushSheetBridgeLog(
            "success",
            `Sheet row 1: default header order (missing unique titles: ${missingTitles.join(", ")}).`
          );
        } else {
          const resolved = resolveActivityLogColumnPermutation(
            headerRow,
            canonical
          );
          if (isActivityLogColumnPermutationValid(resolved)) {
            perm = resolved;
          }
        }
      }
    }
    const physical = permuteActivityLogLogicalRowToPhysical(canonical, perm);
    await this.withTimeout(
      exec("GOOGLESHEETS_VALUES_UPDATE", {
        spreadsheet_id: spreadsheetId,
        range: activityLogSheetHeaderFullRowRange(),
        values: [physical],
        value_input_option: "USER_ENTERED",
        major_dimension: "ROWS",
        auto_expand_sheet: true
      }),
      20_000,
      `Google Sheets header row (A1:${SHEET_LAST_COLUMN_A1}1) update timed out`
    );
  }

  private buildSheetLogRow(
    entry: ActivityLogEntry,
    pageHttpForMirror: string
  ): Array<string | number | null> {
    const row: Array<string | number | null> = Array.from(
      { length: SHEET_ROW_COLUMN_COUNT },
      () => ""
    );

    // Prefix block (ROW HAS DATA … DO class)
    row[1] = entry.logRef;
    row[2] = entry.timeDate;
    row[3] = entry.timeTime;
    row[4] = normalizeActivityLogEntryStepNumber(entry.stepNumber);
    row[ACTIVITY_LOG_MESSAGE_LOGICAL_INDEX] = entry.msg;
    row[ACTIVITY_LOG_ERROR_MESSAGE_LOGICAL_INDEX] =
      typeof entry.errorMessage === "string" && entry.errorMessage.trim() !== ""
        ? truncateActivityLogSheetPromptCell(entry.errorMessage.trim(), 2000)
        : "";
    row[ACTIVITY_LOG_ERROR_REMEDIATION_PROMPT_LOGICAL_INDEX] =
      typeof entry.errorRemediationPrompt === "string" &&
      entry.errorRemediationPrompt.trim() !== ""
        ? truncateActivityLogSheetPromptCell(entry.errorRemediationPrompt)
        : "";
    row[ACTIVITY_LOG_LEVEL_LOGICAL_INDEX] = formatActivityLogLevelLabel(
      entry.level
    );
    row[ACTIVITY_LOG_KEYWORD_LOGICAL_INDEX] = entry.keyword;
    row[ACTIVITY_LOG_CATEGORY_LOGICAL_INDEX] = entry.categorySlug || "";
    row[ACTIVITY_LOG_AGENTS_SKILL_LOGICAL_INDEX] =
      formatActivityLogAgentskillCell(
        entry.activeRole,
        entry.pipelineStepLabel ?? entry.pipelineContext?.currentStep ?? null
      );
    const mp = entry.pipelineContext?.modelPrompt;
    row[ACTIVITY_LOG_MODEL_PROMPT_LOGICAL_INDEX] =
      typeof mp === "string" && mp.trim() !== ""
        ? truncateActivityLogSheetPromptCell(mp)
        : "";
    row[ACTIVITY_LOG_MESSAGE_PASS_OR_FAIL_LOGICAL_INDEX] =
      formatActivityLogMessagePassOrFail(entry.msg);
    row[ACTIVITY_LOG_ARTICLE_URL_LOGICAL_INDEX] =
      typeof entry.articleUrl === "string" && entry.articleUrl.trim() !== ""
        ? entry.articleUrl.trim()
        : "";
    row[ACTIVITY_LOG_PAGE_HTTP_LOGICAL_INDEX] = pageHttpForMirror;
    row[ACTIVITY_LOG_PUBLISHED_PENDING_LOGICAL_INDEX] =
      formatActivityLogPublishedPendingCell(entry);
    row[ACTIVITY_LOG_COMPETITOR_URL_LOGICAL_INDEX] = entry.competitorUrl;
    row[ACTIVITY_LOG_SEO_SCORE_LOGICAL_INDEX] = entry.seoScore;
    row[ACTIVITY_LOG_DO_CLASS_LOGICAL_INDEX] = "SEOArticleAgent";
    row[ACTIVITY_LOG_ARTICLE_BACKED_UP_TO_GITHUB_LOGICAL_INDEX] =
      typeof entry.articleBackedUpToGithub === "string" &&
      entry.articleBackedUpToGithub.trim() !== ""
        ? truncateActivityLogSheetPromptCell(
            entry.articleBackedUpToGithub.trim(),
            ACTIVITY_LOG_STATE_MAX_ARTICLE_BACKUP_GITHUB_CHARS
          )
        : "";
    row[ACTIVITY_LOG_PLAGIARISM_PERCENT_LOGICAL_INDEX] =
      entry.plagiarismPercentage === undefined ||
      entry.plagiarismPercentage === ""
        ? ""
        : entry.plagiarismPercentage;
    row[ACTIVITY_LOG_SEO_CONTENT_OPTIMIZER_LOGICAL_INDEX] =
      entry.liveSeoContentOptimizerNotes &&
      String(entry.liveSeoContentOptimizerNotes).trim() !== ""
        ? entry.liveSeoContentOptimizerNotes
        : "";
    row[ACTIVITY_LOG_SISS_SCORE_LOGICAL_INDEX] =
      typeof entry.sissScore === "number" ? entry.sissScore : "";
    row[ACTIVITY_LOG_SISS_DELTA_LOGICAL_INDEX] =
      typeof entry.sissDelta === "number" ? entry.sissDelta : "";
    row[ACTIVITY_LOG_QUORA_SEEDER_LOGICAL_INDEX] =
      entry.quoraSeederSummary && String(entry.quoraSeederSummary).trim() !== ""
        ? entry.quoraSeederSummary
        : "";
    row[ACTIVITY_LOG_REVERSE_LINKS_INJECTED_LOGICAL_INDEX] =
      typeof entry.reverseLinksInjected === "number"
        ? entry.reverseLinksInjected
        : "";
    row[ACTIVITY_LOG_RSS_FEED_URL_LOGICAL_INDEX] = entry.rssFeedUrl ?? "";

    // R–BN: agent column fillers (Kanban, article outputs, GitHub, …)
    if (entry.activeRole && entry.pipelineContext) {
      applyAgentFillers(row, entry.activeRole, entry.pipelineContext);
    }

    // AGENT_CONTEXT.MD column — GitHub link on every row so any agent
    // reading the sheet can immediately locate the master context doc.
    row[ACTIVITY_LOG_AGENT_CONTEXT_MD_LOGICAL_INDEX] =
      ACTIVITY_LOG_AGENT_CONTEXT_MD_URL;

    // Trailing status block: Agent status, Dashboard URL, MCP Tool
    row[ACTIVITY_LOG_AGENT_STATUS_LOGICAL_INDEX] = this.state.status;
    row[ACTIVITY_LOG_DASHBOARD_URL_LOGICAL_INDEX] = ACTIVITY_LOG_DASHBOARD_URL;
    row[ACTIVITY_LOG_MCP_TOOL_LOGICAL_INDEX] =
      typeof entry.mcpTool === "string" ? entry.mcpTool : "";

    for (let i = 0; i < ACTIVITY_LOG_SEO_CHECK_COUNT; i++) {
      const scoreIx = ACTIVITY_LOG_SEO_CHECK_BASE_LOGICAL_INDEX + 2 * i;
      const promptIx = scoreIx + 1;
      const v = entry.seoCheckCells?.[i];
      row[scoreIx] = v === 0 || v === 1 ? v : "";
      const p = entry.seoCheckQcPromptCells?.[i];
      if (v === 0 && p != null && String(p).trim() !== "") {
        row[promptIx] = truncateActivityLogSheetPromptCell(String(p));
      } else {
        row[promptIx] = "";
      }
    }

    // A (index 0): "ROW HAS DATA" — YES if any other column is non-empty, else NO
    row[0] = computeRowHasDataFlag(row);

    return row;
  }

  private resolveActivityArticleUrlForLog(message: string): string {
    const fromMsg = extractArticleUrlFromMessage(message);
    if (fromMsg) return fromMsg;
    const domain = this.resolveActivityLogDomainHost();
    const cat = this.state.currentCategory;
    const slug = this.state.currentArticleSlug;
    if (cat && slug) {
      return `https://${domain}/${cat}/${slug}`;
    }
    return "";
  }

  private resolveActivityLogDomainHost(): string {
    const rawDomain = String(this.env.DOMAIN ?? "").trim();
    if (!rawDomain) return "catsluvus.com";
    const candidate = rawDomain.includes("://")
      ? rawDomain
      : `https://${rawDomain}`;
    try {
      const parsed = new URL(candidate);
      return parsed.hostname.toLowerCase() || "catsluvus.com";
    } catch {
      const fallback = rawDomain
        .replace(/^https?:\/\//i, "")
        .split("/")[0]
        ?.split(":")[0]
        ?.trim()
        ?.toLowerCase();
      return fallback || "catsluvus.com";
    }
  }

  /**
   * Category slug for sheet column I and pipeline fillers: prefers explicit
   * `ctx.categorySlug`, else live `state.currentCategory`.
   */
  private resolveActivityCategorySlugForLog(
    ctx?: Partial<PipelineContext>
  ): string {
    const fromCtx =
      typeof ctx?.categorySlug === "string" ? ctx.categorySlug.trim() : "";
    if (fromCtx) return fromCtx;
    return this.state.currentCategory?.trim() ?? "";
  }

  /**
   * Sheet column **Competitor URL** (P): prefers a URL in the message when it
   * looks competitor-related, then explicit `ctx.competitorUrl`, then
   * `state.currentCompetitorUrl` for the active article pipeline.
   */
  private resolveActivityCompetitorUrlForLog(
    message: string,
    ctx?: Partial<PipelineContext>
  ): string {
    const fromMsg = extractCompetitorUrlFromMessage(message);
    if (fromMsg) return fromMsg;
    const fromCtx =
      typeof ctx?.competitorUrl === "string" ? ctx.competitorUrl.trim() : "";
    if (fromCtx) return fromCtx;
    return this.state.currentCompetitorUrl?.trim() ?? "";
  }

  /**
   * Resolves the real SEO keyword for sheet column H (before ERROR / scout
   * sentinels in `log()`): ctx.keyword, currentKeyword, Failed-message parse,
   * articles.url, lastSeoScorecard, keywords (category_slug+slug), then generating row.
   */
  private resolveActivityKeywordForLog(
    message: string,
    articleUrl: string,
    ctx?: Partial<PipelineContext>
  ): string {
    const explicit = typeof ctx?.keyword === "string" ? ctx.keyword.trim() : "";
    if (explicit) return explicit;

    const fromState = this.state.currentKeyword?.trim() ?? "";
    if (fromState) return fromState;

    const fromFailed = extractKeywordFromFailedMessage(message);
    if (fromFailed) return fromFailed;

    if (articleUrl) {
      const rows = this.sql<{ keyword: string }>`
        SELECT keyword FROM articles WHERE url=${articleUrl} LIMIT 1`;
      const fromDb = rows[0]?.keyword?.trim() ?? "";
      if (fromDb) return fromDb;
    }

    const card = this.state.lastSeoScorecard;
    if (card?.keyword && card.url && card.url === articleUrl) {
      return card.keyword.trim();
    }

    const cat = this.state.currentCategory?.trim() ?? "";
    const slug = this.state.currentArticleSlug?.trim() ?? "";
    if (cat && slug) {
      const kwRows = this.sql<{ keyword: string }>`
        SELECT keyword FROM keywords WHERE category_slug=${cat} AND slug=${slug} LIMIT 1`;
      const fromKeywordsRow = kwRows[0]?.keyword?.trim() ?? "";
      if (fromKeywordsRow) return fromKeywordsRow;
    }

    const genRows = this.sql<{ keyword: string }>`
        SELECT keyword FROM keywords WHERE status='generating' ORDER BY ROWID LIMIT 1`;
    const fromGenerating = genRows[0]?.keyword?.trim() ?? "";
    if (fromGenerating) return fromGenerating;

    return "";
  }

  private warnSheetMirrorFailure(err: unknown) {
    const errDescriptionRaw = errMsg(err);
    const errDescription = errDescriptionRaw.trim() || "unknown error";
    // Persistent permission/quota failures share one signature so the
    // alternating 403/429 responses can't take turns resetting the
    // dedup slot, and they get the long throttle window.
    const isPersistentFailure =
      SHEET_PERSISTENT_FAILURE_RE.test(errDescription);
    const warningSignature = isPersistentFailure
      ? "sheets-permission-or-quota"
      : normalizeSheetWarningSignature(errDescription);
    const throttleMs = isPersistentFailure
      ? SHEET_PERSISTENT_WARNING_THROTTLE_MS
      : SHEET_WARNING_THROTTLE_MS;
    const now = Date.now();
    const isDuplicateWarning =
      warningSignature === (this.state.lastSheetWarningSignature ?? "");
    if (
      isDuplicateWarning &&
      now - (this.state.lastSheetWarningAt ?? 0) < throttleMs
    )
      return;
    this.setState({
      ...this.state,
      lastSheetWarningAt: now,
      lastSheetWarningSignature: warningSignature
    });
    this._isPushingSheetWarning = true;
    try {
      const { timeDate, timeTime } = formatLaTimestampParts(new Date());
      const warnMsg = `Sheet mirror skipped: ${errDescription}`;
      const isRoutineTimeout =
        /\b(?:timeout|time out|timedout|timed out|deadline exceeded|etimedout|abort(?:ed|error)?)\b/i.test(
          errDescription
        );
      const warnLevel = isRoutineTimeout ? "info" : "warning";
      const logRef = isValidActivityLogRef(this.state.activityLogNextRef)
        ? this.state.activityLogNextRef
        : 1;
      const stepNumber = this.resolveSheetStepColumnE();
      const warnArticleUrl = this.resolveActivityArticleUrlForLog(warnMsg);
      const resolvedKw = this.resolveActivityKeywordForLog(
        warnMsg,
        warnArticleUrl,
        undefined
      );
      const categorySlug = this.resolveActivityCategorySlugForLog(undefined);
      const warningContext = `keyword=${JSON.stringify(
        resolvedKw
      )}; category=${JSON.stringify(categorySlug)}; articleUrl=${JSON.stringify(
        warnArticleUrl
      )}`;
      // Google Sheets timeouts are routine and the mirror is gracefully
      // skipped — log those at info so transient sheet flakiness doesn't
      // drown the warnings panel in noise. Non-timeout failures stay warning.
      const warning: ActivityLogEntry = {
        timeDate,
        timeTime,
        level: warnLevel,
        msg: warnMsg,
        articleUrl: warnArticleUrl,
        keyword: formatActivityLogSheetKeyword(resolvedKw, warnLevel),
        categorySlug,
        competitorUrl: this.resolveActivityCompetitorUrlForLog(
          warnMsg,
          undefined
        ),
        seoScore: extractSeoScoreFromMessage(warnMsg),
        logRef,
        stepNumber,
        pipelineStepLabel: this.resolvePipelineLabelForActivityLog()
      };
      try {
        const persistedWarning =
          compactActivityLogEntryForPersistedState(warning);
        const activityLog = Array.isArray(this.state.activityLog)
          ? this.state.activityLog
          : [];
        const log = [...activityLog, persistedWarning].slice(
          -ACTIVITY_LOG_STATE_MAX_ENTRIES
        );
        this.setState({
          ...this.state,
          activityLog: log,
          lastActivity: `${warning.timeDate} ${warning.timeTime}`,
          activityLogNextRef: logRef + 1
        });
      } catch (setStateErr: unknown) {
        console.warn(
          `Sheet mirror warning state update failed while handling "${errDescription}" (${warningContext}) (${errMsg(setStateErr)})`,
          setStateErr
        );
      }
      try {
        this.pushSheetBridgeLog("skipped", errDescription);
      } catch (sheetLogErr: unknown) {
        console.warn(
          `Sheet bridge log update failed while handling "${errDescription}" (${warningContext}) (${errMsg(sheetLogErr)})`,
          sheetLogErr
        );
      }
    } finally {
      this._isPushingSheetWarning = false;
    }
  }

  private pushSheetBridgeLog(
    status: "success" | "error" | "skipped",
    msg: string
  ) {
    const { timeDate, timeTime } = formatLaTimestampParts(new Date());
    const entry: SheetBridgeLogEntry = {
      time: `${timeDate} ${timeTime}`,
      status,
      msg
    };
    const sheetBridgeLog = [
      ...(Array.isArray(this.state.sheetBridgeLog)
        ? this.state.sheetBridgeLog
        : []),
      entry
    ].slice(-SHEET_BRIDGE_LOG_MAX);
    this.setState({
      ...this.state,
      sheetBridgeLog
    });
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(timeoutMessage)),
        timeoutMs
      );
      promise
        .then((value) => {
          clearTimeout(timeout);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  }
}

// ── Cookie-based auth helpers ─────────────────────────────────────────────────
// Uses a simple signed cookie so WebSocket upgrades (agents/) work correctly.
// Browsers always send cookies on WebSocket handshakes — Basic Auth headers
// are NOT forwarded by browsers on WS upgrades, which would break useAgent().

const AUTH_COOKIE = "dash_auth";

/** Constant-time string equality to prevent timing attacks. */
function safeEqual(a: string, b: string): boolean {
  let mismatch = a.length !== b.length ? 1 : 0;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if ((a.charCodeAt(i) || 0) !== (b.charCodeAt(i) || 0)) mismatch = 1;
  }
  return mismatch === 0;
}

/** Returns true if the request carries a valid auth cookie. */
function hasValidAuthCookie(request: Request, password: string): boolean {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name.trim() === AUTH_COOKIE) {
      const value = rest.join("=").trim();
      // Cookie value is base64(password) — simple, no JWT needed
      try {
        return safeEqual(atob(value), password);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** Renders the login form HTML. */
function loginPage(error = false): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SEO Dashboard — Login</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:ui-sans-serif,system-ui,sans-serif;background:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:0.75rem;padding:2rem;width:100%;max-width:360px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    h1{font-size:1.25rem;font-weight:700;color:#111827;margin-bottom:0.25rem}
    p{font-size:0.875rem;color:#6b7280;margin-bottom:1.5rem}
    label{display:block;font-size:0.875rem;font-weight:500;color:#374151;margin-bottom:0.375rem}
    input{width:100%;padding:0.5rem 0.75rem;border:1px solid #d1d5db;border-radius:0.5rem;font-size:0.875rem;outline:none;transition:border-color .15s}
    input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
    button{margin-top:1rem;width:100%;padding:0.625rem;background:#2563eb;color:#fff;border:none;border-radius:0.5rem;font-size:0.875rem;font-weight:600;cursor:pointer}
    button:hover{background:#1d4ed8}
    .err{margin-top:0.75rem;padding:0.5rem 0.75rem;background:#fef2f2;border:1px solid #fecaca;border-radius:0.5rem;color:#dc2626;font-size:0.8rem}
  </style>
</head>
<body>
  <div class="card">
    <h1>🐱 SEO Dashboard</h1>
    <p>catsluvus.com pipeline control</p>
    <form method="POST" action="/api/login">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autofocus autocomplete="current-password" placeholder="Enter password"/>
      <button type="submit">Sign in</button>
      ${error ? '<p class="err">Incorrect password — try again.</p>' : ""}
    </form>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { "Content-Type": "text/html;charset=UTF-8" }
  });
}

/**
 * Returns true when `pathname` is a two-segment article path
 * (`/:categorySlug/:slug`) that should be served from ARTICLES_KV.
 * Paths starting with "api" or "agents" are excluded so internal routes
 * are never mistakenly matched.
 */
function isArticleSlugPath(pathname: string): boolean {
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  return m !== null && m[1] !== "api" && m[1] !== "agents";
}

/**
 * Serve-time promotion-funnel tracking: count Googlebot crawls and human
 * views per article into KEYWORDS_DB `article_ledger`, powering
 * GET /api/admin/promotion-candidates. Other bots are ignored. Fire-and-
 * forget via waitUntil so the article response is never delayed.
 */
function trackArticleServe(
  env: Env,
  ctx: ExecutionContext,
  kvKey: string,
  request: Request
): void {
  const db = (env as { KEYWORDS_DB?: D1Database }).KEYWORDS_DB;
  if (!db) return;
  const kind = classifyUserAgent(request.headers.get("user-agent") ?? "");
  if (kind === "other-bot") return;
  const stmt =
    kind === "googlebot"
      ? db.prepare(
          `UPDATE article_ledger
              SET googlebot_hits = googlebot_hits + 1,
                  last_crawled_at = datetime('now')
            WHERE kv_key = ?1`
        )
      : db.prepare(
          `UPDATE article_ledger
              SET human_views = human_views + 1
            WHERE kv_key = ?1`
        );
  ctx.waitUntil(
    stmt
      .bind(kvKey)
      .run()
      .then(
        () => undefined,
        () => undefined
      )
  );
}

// ── Worker fetch handler ─────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Real robots.txt (the SPA shell used to swallow this path). The
    // staging domain is DELIBERATELY indexable — the incubation strategy
    // lets Google crawl staging articles and vote with impressions before
    // winners are promoted to production via /api/admin/promote.
    if (url.pathname === "/robots.txt") {
      return new Response(
        `User-agent: *\nAllow: /\n\nSitemap: https://${env.DOMAIN}/sitemap.xml\n`,
        {
          headers: {
            "Content-Type": "text/plain; charset=UTF-8",
            "Cache-Control": "public, max-age=3600"
          }
        }
      );
    }

    if (isSkillsRoute(url.pathname)) {
      return await handleSkillsRoute(request, env);
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      return await handleMcpRequest(request, env);
    }

    // ── Dashboard password protection (cookie-based) ─────────────────────────
    // Exempts the IndexNow key file and the login POST endpoint.
    // Cookies ARE sent on WebSocket upgrades (unlike Basic Auth headers),
    // so this approach works with the useAgent() WebSocket connection.
    const password = env.DASHBOARD_PASSWORD?.trim();
    if (password) {
      const isIndexNowKey = /^\/[a-f0-9]{32}\.txt$/.test(url.pathname);
      const isLoginPost =
        url.pathname === "/api/login" && request.method === "POST";
      const isLogout = url.pathname === "/api/logout";

      // Handle logout — clear the auth cookie and redirect to login
      if (isLogout) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
          }
        });
      }

      // Handle login form submission
      if (isLoginPost) {
        const body = await request.text();
        const params = new URLSearchParams(body);
        const supplied = params.get("password") || "";
        if (safeEqual(supplied, password)) {
          // Set auth cookie and redirect to dashboard
          return new Response(null, {
            status: 302,
            headers: {
              Location: "/",
              "Set-Cookie": `${AUTH_COOKIE}=${btoa(password)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
            }
          });
        }
        return loginPage(true); // wrong password
      }

      // Machine-to-machine API paths — exempt from cookie auth so CI
      // callbacks and programmatic generation triggers work without a browser
      // session. These endpoints do their own validation (e.g. generate-one
      // checks agent state; github-callback only accepts known shapes).
      const isMachineApi =
        url.pathname === "/api/github-callback" ||
        url.pathname === "/api/generate-one" ||
        url.pathname === "/api/start" ||
        url.pathname === "/api/stop" ||
        url.pathname === "/api/status" ||
        url.pathname === "/api/logs" ||
        // /api/admin/* has its own Bearer-token auth; don't gate on the
        // dashboard password cookie.
        url.pathname.startsWith("/api/admin/") ||
        // /api/n8n/* is bearer-protected with N8N_WEBHOOK_SECRET inside
        // the DO; the dashboard cookie wall would otherwise serve the
        // login HTML and block n8n's status callbacks.
        url.pathname.startsWith("/api/n8n/") ||
        // /api/preview[?key=<kvKey>] and /api/screenshot[?key=...] serve
        // KV article HTML + Editorial Agent screenshots of already-public
        // catsluvus.com pages. Iframes in the dashboard cannot send a
        // cookie header cross-origin/cross-site, and the content they
        // serve is destined to be publicly visible anyway — so the
        // password gate would only break the A/B preview panel without
        // protecting anything sensitive. Match both exact path (query
        // param form) and trailing-slash prefix (legacy path form).
        url.pathname === "/api/preview" ||
        url.pathname.startsWith("/api/preview/") ||
        url.pathname === "/api/screenshot" ||
        url.pathname.startsWith("/api/screenshot/");

      // All other routes: check cookie
      // /api/qa/* is intentionally public so AI crawlers can access it
      // without authentication.
      const isQaEndpoint = url.pathname.startsWith("/api/qa");
      // /feed.rss is a public syndication endpoint — exempt from auth
      const isFeedRss = url.pathname === "/feed.rss";
      // Static public assets (favicon, PWA icons, manifest, robots, llms,
      // IndexNow keys) must be reachable without a session so SEO crawlers
      // and browser icon loaders can fetch them. `catsluvus.com/*.txt` is
      // already routed to this Worker for IndexNow, so .txt is included
      // here to prevent other public text files (robots.txt, llms.txt)
      // from being served the login HTML when DASHBOARD_PASSWORD is set.
      // These paths are served from ./public via ASSETS and carry no
      // private data.
      const isPublicAsset =
        /\.(png|ico|webmanifest|txt|jpg|jpeg|gif|svg|webp|woff2?|ttf|eot)$/.test(
          url.pathname
        );
      // Article pages (/:categorySlug/:slug) are public when this Worker
      // handles them — HTML comes from ARTICLES_KV. On catsluvus.com, article
      // traffic is normally served by the petinsurance Worker (same KV); this
      // pipeline Worker does not rely on a zone wildcard route for article
      // URLs. Two-segment paths that start with "api" or "agents" are
      // excluded; they have their own auth.
      const isArticlePath = isArticleSlugPath(url.pathname);
      if (
        !isIndexNowKey &&
        !isMachineApi &&
        !isQaEndpoint &&
        !isFeedRss &&
        !isPublicAsset &&
        !isArticlePath &&
        !hasValidAuthCookie(request, password)
      ) {
        return loginPage();
      }
    }

    // ── IndexNow key file — serve from worker for catsluvus.com zone route ──
    // The key file must be reachable at https://catsluvus.com/{key}.txt.
    // A Cloudflare zone route `catsluvus.com/*.txt` points here so the worker
    // serves the file directly instead of relying on the Next.js origin.
    if (/^\/[a-f0-9]{32}\.txt$/.test(url.pathname)) {
      const key = url.pathname.slice(1, -4); // strip leading / and .txt
      const configuredKey = getEnvBinding(env, "INDEXNOW_KEY") ?? "";
      if (key === configuredKey) {
        return new Response(key + "\n", {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=86400"
          }
        });
      }
    }

    // Proxy API routes to the Durable Object
    const proxyPaths = [
      "/api/logs",
      "/api/status",
      "/api/debug-ndjson",
      "/api/start",
      "/api/stop",
      "/api/github-callback",
      "/api/verify-design-audit",
      "/api/generate-one",
      "/api/patch-css",
      "/api/patch-css-all",
      "/api/analytics-summary",
      "/api/observer-history"
    ];
    // /api/qa/* routes are dynamic — match by prefix, not exact path
    const isQaRoute = url.pathname.startsWith("/api/qa");
    // /api/admin/* — bearer-token protected surface used by the autonomous
    // Claude loop. Auth is enforced inside the DO (see SEOArticleAgent.onRequest).
    const isAdminRoute = url.pathname.startsWith("/api/admin/");
    // /api/dashboard/* — read-only diagnostic feeds for the dashboard
    // panels (Infrastructure Activity Monitor + Observer history). Cookie
    // wall still gates them; the DO handler does no admin actions.
    const isDashboardRoute = url.pathname.startsWith("/api/dashboard/");
    // /api/preview and /api/screenshot — unauth'd read of KV HTML / R2
    // screenshots, used by the dashboard A/B panel iframes. Must be
    // proxied to the DO (where the handlers live) or else the asset
    // binding's SPA fallback returns index.html.
    const isPreviewRoute =
      url.pathname === "/api/preview" ||
      url.pathname.startsWith("/api/preview/") ||
      url.pathname === "/api/screenshot" ||
      url.pathname.startsWith("/api/screenshot/");
    // /api/n8n/* — bearer-protected (N8N_WEBHOOK_SECRET) surface for the
    // connected n8n workflow to post status entries back into the activity
    // feed. Auth is enforced inside the DO with its own secret, distinct
    // from ADMIN_API_TOKEN.
    const isN8nRoute = url.pathname.startsWith("/api/n8n/");
    if (
      proxyPaths.includes(url.pathname) ||
      isQaRoute ||
      isAdminRoute ||
      isDashboardRoute ||
      isPreviewRoute ||
      isN8nRoute
    ) {
      const id = env.SEOArticleAgent.idFromName("default");
      const stub = env.SEOArticleAgent.get(id);
      return stub.fetch(
        new Request(`https://internal${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: request.body
        })
      );
    }

    // ── /feed.rss — serve rolling RSS 2.0 feed from KV ──────────────────────
    if (url.pathname === "/feed.rss") {
      const { buildEmptyFeedResponse, FEED_CACHE_MAX_AGE } =
        await import("./pipeline/feed-syndication");
      const domain = env.DOMAIN || "catsluvus.com";
      let feedXml =
        (await env.ARTICLES_KV.get("feed:rss")) ??
        buildEmptyFeedResponse(domain);

      // Rewrite <atom:link href> so it always matches the URL the feed is
      // actually served from (workers.dev OR custom domain). This is what
      // FeedSpot, W3C Feed Validator, and strict RSS parsers verify: the
      // self-link must resolve to the feed document itself.
      const servedFeedUrl = `${url.protocol}//${url.host}/feed.rss`;
      feedXml = feedXml.replace(
        /<atom:link[^>]*rel="self"[^>]*\/>/,
        `<atom:link href="${servedFeedUrl}" rel="self" type="application/rss+xml"/>`
      );

      return new Response(feedXml, {
        headers: {
          "Content-Type": "application/rss+xml; charset=UTF-8",
          "Cache-Control": `public, max-age=${FEED_CACHE_MAX_AGE}`,
          "X-Content-Type-Options": "nosniff",
          // Required so FeedSpot, Feedly, and browser-based readers can
          // fetch the feed cross-origin without CORS errors.
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // ── Article pages — serve KV-stored HTML when this Worker receives GET ───
    // Live catsluvus.com article URLs are normally handled by petinsurance
    // (reads ARTICLES_KV). If a request reaches here, look up `categorySlug:slug`
    // in ARTICLES_KV and return the HTML directly.
    // On a KV miss we fall through to env.ASSETS (SPA handler / WordPress
    // origin) so non-article two-segment paths are not broken.
    // Only handle GET/HEAD — other methods fall through.
    if (
      isArticleSlugPath(url.pathname) &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      const parts = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/)!;
      const [, categorySlug, slug] = parts;
      const kvKey = `${categorySlug}:${slug}`;
      const articleHtml = await env.ARTICLES_KV.get(kvKey);
      if (articleHtml !== null) {
        // Promotion-funnel signals: Googlebot crawls + human views.
        trackArticleServe(env, ctx, kvKey, request);
        // Staging/clone: inject Cats Luv Us Universal Chrome (header/nav/menus).
        // No-op on production DOMAIN (catsluvus.com) — live consumer owns chrome.
        const body = wrapWithSiteChrome(articleHtml, env.DOMAIN);
        return new Response(request.method === "HEAD" ? null : body, {
          status: 200,
          headers: createArticleResponseHeaders()
        });
      }
      // Promoted articles leave a `redirect:<kvKey>` tombstone pointing at
      // the production URL — 301 so Google transfers the staging page's
      // accumulated signals to catsluvus.com.
      const redirectTarget = await env.ARTICLES_KV.get(`redirect:${kvKey}`);
      if (redirectTarget) {
        return Response.redirect(redirectTarget, 301);
      }
      // KV miss — not a generated article.  Fall through so the Assets
      // binding (SPA handler / WordPress origin) can handle the path.
    }

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;
    const assetResponse = await env.ASSETS.fetch(request);
    // Always-revalidate `Cache-Control` on the dashboard entrypoint
    // HTML so browser/CDN never serve a stale bundle reference. Vite
    // outputs content-hashed JS/CSS so those assets can keep their
    // long-TTL cache — the override only applies to URL paths that
    // resolve to `index.html` and have an HTML content-type. `url` is
    // already declared at the top of this fetch handler.
    const isEntrypointPath =
      url.pathname === "/" ||
      url.pathname === "/index.html" ||
      !url.pathname.includes(".");
    const isHtml = (assetResponse.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("text/html");
    if (!isEntrypointPath || !isHtml) return assetResponse;
    const headers = new Headers(assetResponse.headers);
    headers.set("cache-control", "no-cache, must-revalidate");
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers
    });
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ) {
    ctx.waitUntil(runCrawlTick(env).then(() => undefined));
    // Analytics tick — pulls DataForSEO Labs ranked-keywords for a small
    // batch of stale published articles and persists results into the DO's
    // `article_rankings` table. Self-paced: each cron tick picks up the
    // next 5 stalest articles, so a typical site refreshes fully within a
    // few hours of cron uptime. Silent no-op when DataForSEO creds unset.
    ctx.waitUntil(
      (async () => {
        const id = env.SEOArticleAgent.idFromName("default");
        const stub = env.SEOArticleAgent.get(id);
        try {
          // Use stub.fetch() — same pattern as the /api/admin/* forwarder
          // at line 5611. The internal /api/analytics-tick route on the DO
          // does the work; consistent with the rest of the codebase rather
          // than introducing a new direct-RPC pattern only this caller uses.
          const response = await stub.fetch(
            new Request("https://internal/api/analytics-tick", {
              method: "POST"
            })
          );
          if (!response.ok) {
            const rawDetail = (await response.text()).trim();
            const detail =
              rawDetail.length > 300
                ? `${rawDetail.slice(0, 300)}…`
                : rawDetail;
            const suffix = detail ? `: ${detail}` : "";
            console.warn(
              `Analytics tick dispatch returned ${response.status} ${response.statusText}${suffix}`
            );
          }
        } catch (err: unknown) {
          // stub.fetch() threw — the DO was unreachable so runAnalyticsTick
          // never ran and its internal logging never fired.  Surface the
          // dispatch failure here so it appears in Cloudflare Workers
          // real-time logs.  Use console.warn (not agent.log) because the
          // scheduled handler has no DO/agent context.
          console.warn(
            `Analytics tick dispatch to /api/analytics-tick failed before DO execution: ${errMsg(err)}`
          );
        }
      })()
    );
  },
  async queue(batch: MessageBatch<SkillFetchJob>, env: Env) {
    await handleSkillFetchBatch(batch, env);
  }
} satisfies ExportedHandler<Env, SkillFetchJob>;
