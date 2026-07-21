/**
 * Agent-owns-columns architecture: each of the 9 active agent roles
 * has a dedicated filler function that writes actionable content
 * (status + NEXT/FIX/IMPROVE) to its owned columns in the activity-log
 * sheet row array (length `ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT`).
 *
 * 7 passive roles (analyst, productManager, strategist, marketing,
 * customerService, legalCompliance, promptEngineer, dataSpecialist)
 * only mark "ACTIVE" in their AB-AS self-reference column.
 */

import {
  type AgentRole,
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX,
  AGENT_ROLE_COLUMN_OFFSET
} from "./activityLogSheetColumns";

// ── Pipeline Context ─────────────────────────────────────────────────────────

/** Data passed to agent fillers — assembled from pipeline state. */
export interface PipelineContext {
  /** Current pipeline step label, e.g. "5/15: AI Writing" */
  currentStep: string | null;
  keyword: string;
  categorySlug: string;
  articleUrl: string;
  /** SERP competitor URL for sheet column P when known for this step. */
  competitorUrl?: string;
  timestamp: string;

  // Content Creator (V)
  articleText?: string;
  articleWordCount?: number;
  articleSectionCount?: number;
  articleFaqCount?: number;
  articleProductCount?: number;
  contentImprovements?: string[];

  // Editor (W, BA-BC)
  articleJson?: string;
  editorialNotes?: string[];
  commitMessage?: string;
  prTitle?: string;
  prDescription?: string;

  // Design Architect (X)
  kvKey?: string;
  htmlSchemas?: string[];
  htmlIssues?: string[];

  // Developer (Y, AY, BK)
  embedUrl?: string;
  filePath?: string;
  filesJson?: string;

  // QA Reviewer (BI)
  seoScore?: number;
  /**
   * Final article vs SERP competitor overlap (0–100), written to sheet column AE
   * when present on the log entry.
   */
  plagiarismPercentage?: number;
  seoVerdict?: "pass" | "fail" | "improved";
  seoOriginalScore?: number;
  seoPillarSummary?: string;
  seoFixList?: string[];

  // Operations (AX, BJ)
  actionType?: string;
  actionSubStatuses?: string[];
  actionErrors?: string[];
  deployTimingMs?: Record<string, number>;

  // Integration Engineer (AT-AW, BF-BH)
  githubRepoOwner?: string;
  githubRepoName?: string;
  githubWorkingBranch?: string;
  githubTargetBranch?: string;
  githubPrNumber?: number;
  githubPrUrl?: string;
  githubCiStatus?: string;
  githubNextAction?: string;

  // Security (BD-BE)
  authType?: string;
  authScopes?: string;
  authExpiry?: string;
  credentialRef?: string;
  credentialRotatedAt?: string;
  credentialNextRotation?: string;

  // Orchestrator (AZ)
  changeSetId?: string;
  nextAgent?: string;
  eta?: string;

  // Kanban stage override (if caller knows exactly which stage)
  kanbanStage?:
    | "debug"
    | "ask"
    | "planning"
    | "queue"
    | "inProgress"
    | "aiReview"
    | "humanReview"
    | "done";

  /** Full Workers AI prompt (system + user) mirrored to the sheet modelPrompt column. */
  modelPrompt?: string;

  /**
   * When set, overrides the pipeline step label stored on this log row for
   * Agentskill.sh (column J) without changing global `currentStep`.
   */
  sheetPipelineStepLabel?: string;

  /**
   * Sheet column CA (`MCP Tool`): comma-separated tool names from MCP / AI SDK
   * tool calls when the log line records them (e.g. `search`, `execute`).
   */
  mcpTool?: string;

  /** Sheet column AI: `@anthropic/seo-content-optimizer` live-URL pass notes. */
  liveSeoContentOptimizerNotes?: string;

  /**
   * Sheet column AJ (`SISS Score`): Google Autocomplete sub-intent coverage
   * score (0–100) from Step 16 SISS Optimizer.
   */
  sissScore?: number;

  /**
   * Sheet column AL (`SISS Delta`): score improvement after Step 16
   * remediation rewrite (0 when no rewrite triggered).
   */
  sissDelta?: number;

  /** Sheet column AL (`quora seeder`): Step 16 Quora Seeder result summary. */
  quoraSeederSummary?: string;
}

// ── Column Index Constants ───────────────────────────────────────────────────

const SHEET_PREFIX_COLS = ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX.length;

/** Kanban columns: start at `SHEET_PREFIX_COLS` (first Kanban col shifts when the prefix widens). */
const KANBAN = {
  debug: SHEET_PREFIX_COLS + 0,
  ask: SHEET_PREFIX_COLS + 1,
  planning: SHEET_PREFIX_COLS + 2,
  queue: SHEET_PREFIX_COLS + 3,
  inProgress: SHEET_PREFIX_COLS + 4,
  aiReview: SHEET_PREFIX_COLS + 5,
  humanReview: SHEET_PREFIX_COLS + 6,
  done: SHEET_PREFIX_COLS + 7
} as const;

/** Article output columns (after Kanban). */
const ARTICLE = {
  txt: SHEET_PREFIX_COLS + 8 + 0,
  json: SHEET_PREFIX_COLS + 8 + 1,
  html: SHEET_PREFIX_COLS + 8 + 2,
  js: SHEET_PREFIX_COLS + 8 + 3
} as const;

const GH_BASE = SHEET_PREFIX_COLS + 8 + 4 + 3 + 18;

/** GitHub Actions columns (after agent-role block). */
const GH = {
  repoOwner: GH_BASE + 0,
  repoName: GH_BASE + 1,
  workingBranch: GH_BASE + 2,
  actionType: GH_BASE + 3,
  action: GH_BASE + 4,
  filePath: GH_BASE + 5,
  changeSetId: GH_BASE + 6,
  commitMessage: GH_BASE + 7,
  prTitle: GH_BASE + 8,
  prDescription: GH_BASE + 9,
  authType: GH_BASE + 10,
  credentialRef: GH_BASE + 11,
  targetBranch: GH_BASE + 12,
  prNumber: GH_BASE + 13,
  prUrl: GH_BASE + 14,
  status: GH_BASE + 15,
  timestamp: GH_BASE + 16,
  filesJson: GH_BASE + 17
} as const;

const AGENT_SELF_COL_BASE = SHEET_PREFIX_COLS + 8 + 4 + 2;

// ── Filler Functions ─────────────────────────────────────────────────────────

type SheetRowFiller = (
  row: Array<string | number | null>,
  ctx: PipelineContext
) => void;

/**
 * Orchestrator — owns S-Z (Kanban stages) and BE (Change Set ID).
 * Writes: `timestamp | action | next agent | ETA`
 */
function fillOrchestrator(
  row: Array<string | number | null>,
  ctx: PipelineContext
): void {
  const ts = ctx.timestamp;
  const step = ctx.currentStep || "idle";
  const next = ctx.nextAgent ? ` | Next: ${ctx.nextAgent}` : "";
  const eta = ctx.eta ? ` | ETA: ${ctx.eta}` : "";
  const cell = `${ts} | ${step}${next}${eta}`;

  // Resolve which Kanban column to fill
  const stage = ctx.kanbanStage || resolveKanbanStage(ctx.currentStep);
  const idx = KANBAN[stage];
  row[idx] = cell;

  // Change Set ID
  if (ctx.changeSetId) {
    row[GH.changeSetId] = ctx.changeSetId;
  }
}

/**
 * Content Creator — owns Article TXT column.
 * Writes: `[stats] + text + IMPROVE suggestions`
 */
function fillContentCreator(
  row: Array<string | number | null>,
  ctx: PipelineContext
): void {
  if (!ctx.articleText) return;

  const words = ctx.articleWordCount ?? 0;
  const sections = ctx.articleSectionCount ?? 0;
  const faqs = ctx.articleFaqCount ?? 0;
  const products = ctx.articleProductCount ?? 0;
  const stats = `[${words}w | ${sections} sections | ${faqs} FAQs | ${products} products]`;

  const improvements =
    Array.isArray(ctx.contentImprovements) && ctx.contentImprovements.length
      ? `\n---\nIMPROVE: ${ctx.contentImprovements.join(". ")}`
      : "";

  // Truncate text to 48K, reserve 1K for stats + improvements
  const maxTextLen = 48_000;
  const text =
    ctx.articleText.length > maxTextLen
      ? ctx.articleText.slice(0, maxTextLen) + "..."
      : ctx.articleText;

  row[ARTICLE.txt] = `${stats}\n${text}${improvements}`;
}

/**
 * Design Architect — owns Article HTML column.
 * Writes: `KV key | structure | JSON-LD schemas | ISSUE+FIX`
 */
function fillDesignArchitect(
  row: Array<string | number | null>,
  ctx: PipelineContext
): void {
  if (!ctx.kvKey) return;

  const sections = ctx.articleSectionCount
    ? ` | ${ctx.articleSectionCount} sections`
    : "";
  const schemas =
    Array.isArray(ctx.htmlSchemas) && ctx.htmlSchemas.length
      ? ` | JSON-LD: ${ctx.htmlSchemas.join("+")}`
      : "";
  const issues =
    Array.isArray(ctx.htmlIssues) && ctx.htmlIssues.length
      ? ` | ISSUE: ${ctx.htmlIssues.join(", ")}`
      : "";

  row[ARTICLE.html] = `${ctx.kvKey}${sections}${schemas}${issues}`;
}

/**
 * Developer — owns Article JS + file path + files JSON (ARTICLE.js / GH.*).
 * Writes: `path | size | strategy`
 */
function fillDeveloper(
  row: Array<string | number | null>,
  ctx: PipelineContext
): void {
  if (ctx.embedUrl) {
    row[ARTICLE.js] = ctx.embedUrl;
  }
  if (ctx.filePath) {
    row[GH.filePath] = ctx.filePath;
  }
  if (ctx.filesJson) {
    row[GH.filesJson] = ctx.filesJson;
  }
}

/**
 * Editor — owns Article JSON + commit/PR metadata (see GH indices).
 * Writes: `{metadata JSON} NEXT: editorial fix`
 */
function fillEditor(
  row: Array<string | number | null>,
  ctx: PipelineContext
): void {
  if (ctx.articleJson) {
    const notes =
      Array.isArray(ctx.editorialNotes) && ctx.editorialNotes.length
        ? `\nNEXT: ${ctx.editorialNotes.join(". ")}`
        : "";
    row[ARTICLE.json] = `${ctx.articleJson}${notes}`;
  }
  if (ctx.commitMessage) {
    row[GH.commitMessage] = ctx.commitMessage;
  }
  if (ctx.prTitle) {
    row[GH.prTitle] = ctx.prTitle;
  }
  if (ctx.prDescription) {
    row[GH.prDescription] = ctx.prDescription;
  }
}

/**
 * Operations — owns Action + Timestamp (see GH.action / GH.timestamp).
 * Writes: `action | sub-statuses | FIX if error`
 */
function fillOperations(
  row: Array<string | number | null>,
  ctx: PipelineContext
): void {
  if (!ctx.actionType) return;

  const actionSubStatuses = Array.isArray(ctx.actionSubStatuses)
    ? ctx.actionSubStatuses
        .map((status) => String(status).trim())
        .filter((status) => status !== "")
    : [];
  const actionErrors = Array.isArray(ctx.actionErrors)
    ? ctx.actionErrors
        .map((error) => String(error).trim())
        .filter((error) => error !== "")
    : [];

  const subs = actionSubStatuses.length
    ? ` | ${actionSubStatuses.join(" | ")}`
    : "";
  const errors = actionErrors.length
    ? ` | FIX: ${actionErrors.join("; ")}`
    : "";
  row[GH.action] = `${ctx.actionType}${subs}${errors}`;

  // Timing breakdown
  if (ctx.deployTimingMs) {
    const parts = Object.entries(ctx.deployTimingMs)
      .map(([k, v]) => `${k}: ${v}ms`)
      .join(" | ");
    row[GH.timestamp] = `${ctx.timestamp} | ${parts}`;
  } else {
    row[GH.timestamp] = ctx.timestamp;
  }
}

/**
 * QA Reviewer — owns Status (GH.status).
 * Writes: `PASS/FAIL score | pillar breakdown | FIX: numbered list`
 */
function fillQaReviewer(
  row: Array<string | number | null>,
  ctx: PipelineContext
): void {
  if (ctx.seoVerdict === undefined) return;

  const verdict = ctx.seoVerdict.toUpperCase();
  const score = ctx.seoScore ?? "?";
  const original =
    ctx.seoOriginalScore !== undefined ? ` (was ${ctx.seoOriginalScore})` : "";
  const pillars = ctx.seoPillarSummary ? ` | ${ctx.seoPillarSummary}` : "";
  const seoFixList = Array.isArray(ctx.seoFixList) ? ctx.seoFixList : [];
  const fixesRaw = seoFixList.length
    ? " | FIX: " +
      seoFixList.map((f, i) => (i + 1).toString() + ") " + f).join(" ")
    : "";
  const MAX_STATUS_FIX_CHARS = 5200;
  let fixes = fixesRaw;
  if (fixes.length > MAX_STATUS_FIX_CHARS) {
    const n = seoFixList.length;
    fixes =
      fixes.slice(0, MAX_STATUS_FIX_CHARS - 48) +
      ` … (truncated; ${n} fixes — see sheet QC AI prompt columns)`;
  }

  row[GH.status] = `${verdict} ${score}/100${original}${pillars}${fixes}`;
}

/**
 * Integration Engineer — owns repo/branch/PR columns (GH.*).
 * Writes: `repo/branch/PR + CI status + NEXT`
 */
function fillIntegrationEngineer(
  row: Array<string | number | null>,
  ctx: PipelineContext
): void {
  if (ctx.githubRepoOwner) {
    row[GH.repoOwner] = ctx.githubRepoOwner;
  }
  if (ctx.githubRepoName) {
    row[GH.repoName] = ctx.githubRepoName;
  }
  if (ctx.githubWorkingBranch) {
    row[GH.workingBranch] = ctx.githubWorkingBranch;
  }
  if (ctx.githubTargetBranch) {
    row[GH.targetBranch] = ctx.githubTargetBranch;
  }
  if (ctx.githubPrNumber !== undefined) {
    row[GH.prNumber] = ctx.githubPrNumber;
  }
  if (ctx.githubPrUrl) {
    const ci = ctx.githubCiStatus ? ` | CI: ${ctx.githubCiStatus}` : "";
    const next = ctx.githubNextAction ? ` | NEXT: ${ctx.githubNextAction}` : "";
    row[GH.prUrl] = `${ctx.githubPrUrl}${ci}${next}`;
  }
}

/**
 * Security — owns Auth Type + Credential Ref (GH.authType / GH.credentialRef).
 * Writes: `auth method | scopes | expiry` and `secret ref | rotation`
 */
function fillSecurity(
  row: Array<string | number | null>,
  ctx: PipelineContext
): void {
  if (ctx.authType) {
    const scopes = ctx.authScopes ? ` | Scopes: ${ctx.authScopes}` : "";
    const expiry = ctx.authExpiry ? ` | Expires: ${ctx.authExpiry}` : "";
    row[GH.authType] = `${ctx.authType}${scopes}${expiry}`;
  }
  if (ctx.credentialRef) {
    const rotated = ctx.credentialRotatedAt
      ? ` | Rotated: ${ctx.credentialRotatedAt}`
      : "";
    const next = ctx.credentialNextRotation
      ? ` | NEXT: Rotate by ${ctx.credentialNextRotation}`
      : "";
    row[GH.credentialRef] = `${ctx.credentialRef}${rotated}${next}`;
  }
}

// ── Filler Registry ──────────────────────────────────────────────────────────

const AGENT_COLUMN_FILLERS: Partial<Record<AgentRole, SheetRowFiller>> = {
  orchestrator: fillOrchestrator,
  contentCreator: fillContentCreator,
  designArchitect: fillDesignArchitect,
  developer: fillDeveloper,
  editor: fillEditor,
  operations: fillOperations,
  qaReviewer: fillQaReviewer,
  integrationEngineer: fillIntegrationEngineer,
  security: fillSecurity
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Applies agent column fillers to the activity-log logical sheet row.
 *
 * - Orchestrator ALWAYS runs (Kanban stage tracking)
 * - Active agent also runs (fills its owned columns)
 * - All roles mark "ACTIVE" in their AB-AS self-reference column
 */
export function applyAgentFillers(
  row: Array<string | number | null>,
  activeRole: AgentRole,
  ctx: PipelineContext
): void {
  // Orchestrator always fills Kanban stages
  AGENT_COLUMN_FILLERS.orchestrator?.(row, ctx);

  // Mark active role in agent-role block (base + AGENT_ROLE_COLUMN_OFFSET)
  const roleOffset = AGENT_ROLE_COLUMN_OFFSET[activeRole];
  if (roleOffset !== undefined) {
    row[AGENT_SELF_COL_BASE + roleOffset] = "ACTIVE";
  }

  // Active agent fills its owned columns (skip if orchestrator — already ran)
  if (activeRole !== "orchestrator") {
    AGENT_COLUMN_FILLERS[activeRole]?.(row, ctx);
  }
}

// ── Kanban Stage Resolver ────────────────────────────────────────────────────

/**
 * Infers the Kanban stage from the pipeline step string.
 * The step format is typically "N/M: Description" (e.g. "5/14: AI Writing").
 */
function resolveKanbanStage(
  step: string | null | undefined
): keyof typeof KANBAN {
  if (!step) return "planning";

  const lower = step.toLowerCase();

  // Error/debug states
  if (
    lower.includes("error") ||
    lower.includes("fail") ||
    lower.includes("retry")
  ) {
    return "debug";
  }

  // Done states
  if (
    lower.includes("published") ||
    lower.includes("complete") ||
    lower.includes("done")
  ) {
    return "done";
  }

  // Review states
  if (
    lower.includes("qc") ||
    lower.includes("polish") ||
    lower.includes("seo score")
  ) {
    return "aiReview";
  }

  // In progress (generation, writing, building)
  if (
    lower.includes("writing") ||
    lower.includes("ai model") ||
    lower.includes("html") ||
    lower.includes("deploy") ||
    lower.includes("indexnow") ||
    lower.includes("url verif")
  ) {
    return "inProgress";
  }

  // Queue (keywords pending, scouting queued)
  if (
    lower.includes("queue") ||
    lower.includes("keyword") ||
    lower.includes("amazon")
  ) {
    return "queue";
  }

  // Planning (scouting, SERP, competitor)
  if (
    lower.includes("scout") ||
    lower.includes("serp") ||
    lower.includes("competitor") ||
    lower.includes("planning")
  ) {
    return "planning";
  }

  return "inProgress";
}
