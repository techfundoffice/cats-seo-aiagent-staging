/**
 * Single source of truth for Google Sheet row-1 headers (activity log mirror)
 * and the same labels shown in /api/logs and the dashboard read-only legend.
 */

import { resolveAgentskillSlugForPipelineStepLabel } from "./activityLogPipelineAgentskill";
import { isActivityLogErrorLevel } from "./activityLogLevels";
import { getSeoScorecardCheckNames } from "./pipeline/seo-score";

export const ACTIVITY_LOG_SHEET_TAB_NAME = "cats-seo-aiagent-staging";

/**
 * Dashboard URL written to the mirrored activity-log sheet on every row (next to
 * **Agent status** and **MCP Tool**; default letters shift when the prefix widens).
 */
export const ACTIVITY_LOG_DASHBOARD_URL =
  "https://cats-seo-aiagent.webmaster-bc8.workers.dev/";

/** Google Sheet row-1 title for the Workers AI prompt mirror column (after error columns). */
export const ACTIVITY_LOG_SHEET_HEADER_PROMPT = "modelPrompt";

/** Row-1 title: short summary when a log row is warning/error (see `Error remediation prompt`). */
export const ACTIVITY_LOG_SHEET_HEADER_ERROR_MESSAGE = "Error message";

/**
 * Row-1 title: full SYSTEM+USER remediation cell for upstream AI (Workers-generated
 * for warning/error rows).
 */
export const ACTIVITY_LOG_SHEET_HEADER_ERROR_REMEDIATION_PROMPT =
  "Error remediation prompt";

/** Max chars for combined system+user text mirrored to sheet prompt cells. */
export const ACTIVITY_LOG_SHEET_PROMPT_MAX_CHARS = 28_000;
const ACTIVITY_LOG_SHEET_PROMPT_TRUNCATION_SUFFIX = "\n…";

/**
 * Truncates combined system/user prompt text for Google Sheets cells (~50k cap;
 * keep headroom for USER_ENTERED expansion).
 */
export function truncateActivityLogSheetPromptCell(
  text: string,
  maxChars = ACTIVITY_LOG_SHEET_PROMPT_MAX_CHARS
): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  if (maxChars <= ACTIVITY_LOG_SHEET_PROMPT_TRUNCATION_SUFFIX.length) {
    return ACTIVITY_LOG_SHEET_PROMPT_TRUNCATION_SUFFIX.slice(-maxChars);
  }
  return (
    t.slice(0, maxChars - ACTIVITY_LOG_SHEET_PROMPT_TRUNCATION_SUFFIX.length) +
    ACTIVITY_LOG_SHEET_PROMPT_TRUNCATION_SUFFIX
  );
}

/**
 * Formats Workers AI `generateText`-style prompts for the activity-log modelPrompt column.
 */
export function formatActivityLogModelPromptCell(
  system: string | undefined,
  user: string
): string {
  const sys = (system ?? "").trim();
  const u = user.trim();
  const body = sys !== "" ? `SYSTEM:\n${sys}\n\nUSER:\n${u}` : u;
  return truncateActivityLogSheetPromptCell(body);
}

/** Row-1 header for **Message Pass or Fail** (`ACTIVITY_LOG_MESSAGE_PASS_OR_FAIL_LOGICAL_INDEX`). */
export const ACTIVITY_LOG_SHEET_HEADER_MESSAGE_PASS_OR_FAIL =
  "Message Pass or Fail";

/** Row-1 header: KV/article HTML GitHub backup outcome on **Published** rows (`ACTIVITY_LOG_ARTICLE_BACKED_UP_TO_GITHUB_LOGICAL_INDEX`). */
export const ACTIVITY_LOG_SHEET_HEADER_ARTICLE_BACKED_UP_TO_GITHUB =
  "Article Backed Up To Github";

/** Keyword column when no real keyword resolves and log level is not `error`/`err`. */
export const ACTIVITY_LOG_KEYWORD_SENTINEL_SCOUT =
  "AI Agent is Scouting for Keywords";

/** Keyword column when no real keyword resolves and log level is `error`/`err`. */
export const ACTIVITY_LOG_KEYWORD_SENTINEL_ERROR = "ERROR";

/**
 * Value written to the **Keyword** column: real keyword, or ERROR /
 * `ACTIVITY_LOG_KEYWORD_SENTINEL_SCOUT`.
 */
export function formatActivityLogSheetKeyword(
  resolvedKeyword: string,
  logLevel: string
): string {
  const t = resolvedKeyword.trim();
  if (t) return t;
  return isActivityLogErrorLevel(logLevel)
    ? ACTIVITY_LOG_KEYWORD_SENTINEL_ERROR
    : ACTIVITY_LOG_KEYWORD_SENTINEL_SCOUT;
}

// ── Agent Roles ───────────────────────────────────────────────────────────────

export type AgentRole =
  | "orchestrator"
  | "analyst"
  | "productManager"
  | "strategist"
  | "designArchitect"
  | "developer"
  | "contentCreator"
  | "editor"
  | "operations"
  | "marketing"
  | "customerService"
  | "qaReviewer"
  | "legalCompliance"
  | "promptEngineer"
  | "dataSpecialist"
  | "integrationEngineer"
  | "security"
  | "codingAgent"
  | "repoAgent"
  | "editorialAgent"
  | "textEditorAgent"
  | "improvementAgent"
  | "observerAgent"
  | "qualityProbe"
  | "apiCall"
  | "n8n"
  | "rankTracker"
  | "topSellerScout"
  | "legacyScout";

/** Display labels for AB-AS columns, keyed by AgentRole. */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  orchestrator: "Orchestrator",
  analyst: "Analyst",
  productManager: "Product Manager",
  strategist: "Strategist",
  designArchitect: "Design Architect",
  developer: "Developer",
  contentCreator: "Content Creator",
  editor: "Editor",
  operations: "Operations",
  marketing: "Marketing",
  customerService: "Customer Service",
  qaReviewer: "QA Reviewer",
  legalCompliance: "Legal/Compliance",
  promptEngineer: "Prompt Engineer",
  dataSpecialist: "Data/ML Specialist",
  integrationEngineer: "Integration Engineer",
  security: "Security",
  codingAgent: "Coding Agent",
  repoAgent: "GitHub Repo Agent",
  editorialAgent: "Published Article Editorial Agent",
  textEditorAgent: "Published Article Text Editor",
  improvementAgent: "Improvement Activity Log",
  observerAgent: "AI Observer (15-min)",
  qualityProbe: "Live Quality Probe (30-min)",
  apiCall: "API Activity Log",
  n8n: "n8n",
  rankTracker: "Rank Tracker",
  topSellerScout: "Top Seller Scout",
  legacyScout: "Legacy Scout"
};

/**
 * Maps AgentRole to its 0-based offset within the AB-AS range.
 * AB=0 (label row), AC=1 (orchestrator), ..., AS=17 (security).
 * The column index in the sheet row is `AGENT_ROLES_BLOCK_START + offset`
 * (`AGENT_ROLES_BLOCK_START` = prefix + Kanban + article + AE/AF).
 *
 * Type is `Partial<Record<...>>` because some roles (e.g. `rankTracker`)
 * don't claim a sheet column — they exist purely as activity-log dashboard
 * tags. The sole consumer at agentColumnFillers.ts:489 already handles
 * `undefined` (`if (roleOffset !== undefined)`), so omitting an entry is
 * safe. Keep the offset map within the AB-AS 18-column block; new
 * dashboard-only roles should NOT be added here.
 */
export const AGENT_ROLE_COLUMN_OFFSET: Partial<Record<AgentRole, number>> = {
  orchestrator: 1,
  analyst: 2,
  productManager: 3,
  strategist: 4,
  designArchitect: 5,
  developer: 6,
  contentCreator: 7,
  editor: 8,
  operations: 9,
  marketing: 10,
  customerService: 11,
  qaReviewer: 12,
  legalCompliance: 13,
  promptEngineer: 14,
  dataSpecialist: 15,
  integrationEngineer: 16,
  security: 17,
  codingAgent: 18,
  repoAgent: 19,
  editorialAgent: 20,
  textEditorAgent: 21,
  improvementAgent: 22,
  n8n: 23
  // rankTracker intentionally omitted — dashboard-only role, no sheet column.
};

// ── Column Labels: A–T prefix (logical indices 0–19) ───────────────────────────
/** Logical column E (index 4): pipeline step / progress; idle uses **`0`**. */
export const ACTIVITY_LOG_SHEET_COLUMN_STEP_HEADER = "Step #";

/** Default sheet column for role + agentskill.sh slug for the step (logical index 11). */
export const ACTIVITY_LOG_SHEET_HEADER_AGENTS_SKILL = "Agentskill.sh";

/**
 * Row 1 labels for default prefix columns (logical indices 0–20): A–E unchanged,
 * **F** = `Message`, **G** = `Error message`, **H** = `Error remediation prompt`,
 * **I** = `Level`, **J** = `Keyword`, **K** = `Category`, **L** = `Agentskill.sh`,
 * **M** = `modelPrompt`, **N** = `Message Pass or Fail`, **O** = `Article URL`, …
 * **U** = `Article Backed Up To Github` (`ACTIVITY_LOG_ARTICLE_BACKED_UP_TO_GITHUB_LOGICAL_INDEX`).
 * (`Message` body text lives at logical index `ACTIVITY_LOG_MESSAGE_LOGICAL_INDEX`.)
 */
export const ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX = [
  "ROW HAS DATA",
  "Reference Number",
  "DATE",
  "TIME",
  ACTIVITY_LOG_SHEET_COLUMN_STEP_HEADER,
  "Message",
  ACTIVITY_LOG_SHEET_HEADER_ERROR_MESSAGE,
  ACTIVITY_LOG_SHEET_HEADER_ERROR_REMEDIATION_PROMPT,
  "Level",
  "Keyword",
  "Category",
  ACTIVITY_LOG_SHEET_HEADER_AGENTS_SKILL,
  ACTIVITY_LOG_SHEET_HEADER_PROMPT,
  ACTIVITY_LOG_SHEET_HEADER_MESSAGE_PASS_OR_FAIL,
  "Article URL",
  "Page HTTP status",
  "Published or Pending",
  "Competitor URL",
  "SEO Score",
  "Cloudflare Durable Object Class",
  ACTIVITY_LOG_SHEET_HEADER_ARTICLE_BACKED_UP_TO_GITHUB
] as const;

export const ACTIVITY_LOG_SHEET_COLUMN_LETTERS_A_TO_PREFIX = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U"
] as const;

// ── Column Labels: Kanban (logical indices 21–28) — Kanban Stages ───────────

export const ACTIVITY_LOG_SHEET_COLUMN_LABELS_N_TO_U = [
  "Debug",
  "Ask",
  "Planning",
  "Queue",
  "In Progress",
  "AI Review",
  "Human Review",
  "Done"
] as const;

export const ACTIVITY_LOG_SHEET_COLUMN_LETTERS_N_TO_U = [
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "AA",
  "AB",
  "AC"
] as const;

// ── Column Labels: Article outputs (logical indices 29–32) ─────────────────

export const ACTIVITY_LOG_SHEET_COLUMN_LABELS_V_TO_Y = [
  "Article TXT",
  "Article JSON",
  "Article HTML",
  "Article JS"
] as const;

export const ACTIVITY_LOG_SHEET_COLUMN_LETTERS_V_TO_Y = [
  "AD",
  "AE",
  "AF",
  "AG"
] as const;

// ── Column Labels: AH–AN (logical indices 33–39) ─────────────────────────────

export const ACTIVITY_LOG_SHEET_COLUMN_LABELS_Z_AA = [
  "Plagiarism Percentage",
  "@anthropic/seo-content-optimizer — live URL pass (notes)",
  "SISS Score",
  "SISS Delta",
  "quora seeder",
  "Reverse Links Injected",
  "RSS Feed URL"
] as const;

/**
 * Logical index of the **Plagiarism Percentage** column (default sheet **AG**),
 * after prefix A–T, Kanban U–AB, and article outputs AC–AF.
 */
export const ACTIVITY_LOG_PLAGIARISM_PERCENT_LOGICAL_INDEX =
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_N_TO_U.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_V_TO_Y.length +
  0;

/**
 * Logical index of the **`@anthropic/seo-content-optimizer`** live-URL pass
 * column (default sheet **AH**): article-focused post-publish SEO notes from
 * fetched public HTML + Workers AI (install skill via agentskill.sh
 * `/learn @anthropic/seo-content-optimizer`).
 */
export const ACTIVITY_LOG_SEO_CONTENT_OPTIMIZER_LOGICAL_INDEX =
  ACTIVITY_LOG_PLAGIARISM_PERCENT_LOGICAL_INDEX + 1;

/**
 * Logical index of the **`SISS Score`** column: Google Autocomplete
 * sub-intent coverage score (0–100) from the Step 16 SISS Optimizer.
 */
export const ACTIVITY_LOG_SISS_SCORE_LOGICAL_INDEX =
  ACTIVITY_LOG_SEO_CONTENT_OPTIMIZER_LOGICAL_INDEX + 1;

/**
 * Logical index of the **`SISS Delta`** column: improvement in SISS score
 * after the Step 16 remediation rewrite (0 when no rewrite was triggered).
 */
export const ACTIVITY_LOG_SISS_DELTA_LOGICAL_INDEX =
  ACTIVITY_LOG_SISS_SCORE_LOGICAL_INDEX + 1;

/**
 * Logical index of the **`quora seeder`** column (default sheet **AL**):
 * Step 16 Quora Answer Seeder summary — threads found, answers posted
 * or dry-run status (Quora has no public posting API).
 */
export const ACTIVITY_LOG_QUORA_SEEDER_LOGICAL_INDEX =
  ACTIVITY_LOG_SISS_DELTA_LOGICAL_INDEX + 1;

/**
 * Logical index of **`Reverse Links Injected`**: count of already-published
 * sibling articles that received a back-link to the new article (Step 23).
 */
export const ACTIVITY_LOG_REVERSE_LINKS_INJECTED_LOGICAL_INDEX =
  ACTIVITY_LOG_QUORA_SEEDER_LOGICAL_INDEX + 1;

/**
 * Logical index of **`RSS Feed URL`**: canonical RSS feed URL updated during
 * Step 24 feed syndication (e.g. https://catsluvus.com/feed.rss).
 */
export const ACTIVITY_LOG_RSS_FEED_URL_LOGICAL_INDEX =
  ACTIVITY_LOG_REVERSE_LINKS_INJECTED_LOGICAL_INDEX + 1;

export const ACTIVITY_LOG_SHEET_COLUMN_LETTERS_Z_AA = [
  "AH",
  "AI",
  "AJ",
  "AK",
  "AL",
  "AM",
  "AN"
] as const;

// ── Column Labels: Agent roles (18 cols) ─────────────────────────────────────

export const ACTIVITY_LOG_SHEET_COLUMN_LABELS_AB_TO_AS = [
  "Agent Roles",
  "Orchestrator",
  "Analyst",
  "Product Manager",
  "Strategist",
  "Design Architect",
  "Developer",
  "Content Creator",
  "Editor",
  "Operations",
  "Marketing",
  "Customer Service",
  "QA Reviewer",
  "Legal/Compliance",
  "Prompt Engineer",
  "Data/ML Specialist",
  "Integration Engineer",
  "Security"
] as const;

// ── Column Labels: GitHub Actions (logical indices 53–70; shifts when prefix widens) ─

export const ACTIVITY_LOG_SHEET_COLUMN_LABELS_AT_TO_BK = [
  "Repo Owner",
  "Repo Name",
  "Working Branch",
  "Action Type",
  "Action",
  "File Path",
  "Change Set ID",
  "Commit Message",
  "PR Title",
  "PR Description",
  "Auth Type",
  "Credential Ref",
  "Target Branch",
  "PR Number",
  "PR URL",
  "Status",
  "Timestamp",
  "Files JSON"
] as const;

// ── Column Labels: AGENT_CONTEXT.md reference (1 col, first of the 8-blank spacer block) ──────────

/**
 * Row-1 header for the AGENT_CONTEXT.MD column — a direct GitHub link to the
 * consolidated AI agent master reference file. Written on every row so any
 * agent reading the sheet can immediately locate the context doc.
 */
export const ACTIVITY_LOG_SHEET_HEADER_AGENT_CONTEXT_MD = "AGENT_CONTEXT.MD";

/**
 * Permanent GitHub URL for AGENT_CONTEXT.md — the single always-load context
 * file for AI agents working on this repo. Written into every activity log row.
 */
export const ACTIVITY_LOG_AGENT_CONTEXT_MD_URL =
  "https://github.com/techfundoffice/cats-seo-aiagent-staging/blob/main/AGENT_CONTEXT.md";

// ── Column Labels: Status (3 cols) — after middle + spacer; default letters shift with prefix width ─

export const ACTIVITY_LOG_SHEET_HEADER_MCP_TOOL = "MCP Tool";

export const ACTIVITY_LOG_SHEET_COLUMN_LABELS_BU_BV = [
  "Agent status",
  "Dashboard URL",
  ACTIVITY_LOG_SHEET_HEADER_MCP_TOOL
] as const;

/** 0-based logical index of the log **Message** body (prefix column **F**). */
export const ACTIVITY_LOG_MESSAGE_LOGICAL_INDEX = 5;

/** Short error summary (prefix column **G**). */
export const ACTIVITY_LOG_ERROR_MESSAGE_LOGICAL_INDEX = 6;

/** Full remediation prompt cell (prefix column **H**). */
export const ACTIVITY_LOG_ERROR_REMEDIATION_PROMPT_LOGICAL_INDEX = 7;

/** Log level (prefix column **I**). */
export const ACTIVITY_LOG_LEVEL_LOGICAL_INDEX = 8;

/** Keyword (prefix column **J**). */
export const ACTIVITY_LOG_KEYWORD_LOGICAL_INDEX = 9;

/** Category slug (prefix column **K**). */
export const ACTIVITY_LOG_CATEGORY_LOGICAL_INDEX = 10;

/** Agentskill.sh cell (prefix column **L**). */
export const ACTIVITY_LOG_AGENTS_SKILL_LOGICAL_INDEX = 11;

/** modelPrompt mirror (prefix column **M**). */
export const ACTIVITY_LOG_MODEL_PROMPT_LOGICAL_INDEX = 12;

/** Message Pass or Fail (prefix column **N**). */
export const ACTIVITY_LOG_MESSAGE_PASS_OR_FAIL_LOGICAL_INDEX = 13;

/** Article URL (prefix column **O**). */
export const ACTIVITY_LOG_ARTICLE_URL_LOGICAL_INDEX = 14;

/** Page HTTP status (prefix column **P**). */
export const ACTIVITY_LOG_PAGE_HTTP_LOGICAL_INDEX = 15;

/** Published or Pending (prefix column **Q**). */
export const ACTIVITY_LOG_PUBLISHED_PENDING_LOGICAL_INDEX = 16;

/** Competitor URL (prefix column **R**). */
export const ACTIVITY_LOG_COMPETITOR_URL_LOGICAL_INDEX = 17;

/** SEO Score (prefix column **S**). */
export const ACTIVITY_LOG_SEO_SCORE_LOGICAL_INDEX = 18;

/** Durable Object class (prefix column **T**). */
export const ACTIVITY_LOG_DO_CLASS_LOGICAL_INDEX = 19;

/**
 * GitHub HTML/KV backup status on **Published** rows (prefix column **U**;
 * header `Article Backed Up To Github`).
 */
export const ACTIVITY_LOG_ARTICLE_BACKED_UP_TO_GITHUB_LOGICAL_INDEX = 20;

/** First logical index of Kanban block (`Debug` … `Done`). */
export const ACTIVITY_LOG_KANBAN_START_LOGICAL_INDEX =
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX.length;

/** First logical index of the Agent Roles block (`Agent Roles` …). */
export const ACTIVITY_LOG_AGENT_ROLES_BLOCK_START_LOGICAL_INDEX =
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_N_TO_U.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_V_TO_Y.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_Z_AA.length;

/**
 * Display string for the Agentskill.sh column: `AgentRole` label plus the
 * agentskill.sh slug implied by the current pipeline step (`updateStep` label).
 */
export function formatActivityLogAgentskillCell(
  activeRole: AgentRole | undefined,
  pipelineStepLabel?: string | null
): string {
  const rolePart =
    activeRole != null ? (AGENT_ROLE_LABELS[activeRole] ?? "") : "";
  const skillPart = resolveAgentskillSlugForPipelineStepLabel(
    pipelineStepLabel ?? ""
  );
  if (rolePart && skillPart) return `${rolePart} — ${skillPart}`;
  if (rolePart) return rolePart;
  return skillPart;
}

/** Subset of pipeline context used for sheet column O (Published or Pending). */
export type ActivityLogPublishedPendingInput = {
  msg: string;
  pipelineContext?: {
    actionType?: string;
    kanbanStage?: string;
    actionSubStatuses?: string[];
  };
};

/**
 * **Published or Pending** — `Published` after KV deploy + done Kanban, the
 * `Published:` operations line, or URL verify passed; otherwise `Pending`.
 */
export function formatActivityLogPublishedPendingCell(
  entry: ActivityLogPublishedPendingInput
): "Published" | "Pending" {
  if (/^\s*Published:/i.test(entry.msg)) return "Published";
  if (/URL verify:\s*passed/i.test(entry.msg)) return "Published";
  const ctx = entry.pipelineContext;
  const actionSubStatuses = Array.isArray(ctx?.actionSubStatuses)
    ? ctx.actionSubStatuses
    : [];
  if (ctx?.actionType === "deploy-kv" && ctx.kanbanStage === "done") {
    return "Published";
  }
  if (actionSubStatuses.some((s) => /^\s*Published:/i.test(String(s)))) {
    return "Published";
  }
  if (actionSubStatuses.some((s) => /URL verify:\s*passed/i.test(String(s)))) {
    return "Published";
  }
  return "Pending";
}

const EMOJI_PASS = "\u2705";
const EMOJI_FAIL = "\u274c";
const NEUTRAL_FAIL_PHRASES = [
  /\bno fail(?:ed|s|ing|ures?)\b/gi,
  /\b(?:0|zero)\s+fail(?:ed|s|ing|ures?)\b/gi,
  /\baction[_\s-]*required\b["']?\s*[:=]\s*(?:(?:false|0|none|null|no|n\/a|na)\b(?!["'])|(["'])(?:false|0|none|null|no|n\/a|na)\1)/gi,
  /\bno\s+failed\s+(?:jobs?|checks?)\s+(?:were\s+)?found(?:\s+(?:in|for)\s+this\s+workflow\s+run)?\b/gi,
  /\bno\s+(?:failed[_\s-]*)?(?:jobs?|checks?)\s+(?:were\s+)?found\b[^\n\r]*\baction[_\s-]*required\b/gi,
  /\baction[_\s-]*required\b[^\n\r]*\b(?:(?:0|zero)\s*[-\s]*job(?:s)?|no\s+(?:failed?\s+)?jobs?)\b/gi,
  /\baction[_\s-]*required\b[^\n\r]*\b(?:total[_\s-]*(?:jobs?|count)|failed[_\s-]*(?:jobs?|checks?))\b[^\n\r"']{0,24}(?:[:=]\s*)?(?:(?:0|zero|false|no)\b(?!["'])|(["'])(?:0|zero|none|null|false|no|n\/a|na)\1|(?:none|null|false|no|n\/a|na)\b)/gi,
  /\baction[_\s-]*required\b[^\n\r]*\b(?:totalJobs?|totalCount|failedJobs?|failedChecks?)\b[^\n\r"']{0,24}(?:[:=]\s*)?(?:(?:0|zero|false|no)\b(?!["'])|(["'])(?:0|zero|none|null|false|no|n\/a|na)\1|(?:none|null|false|no|n\/a|na)\b)/gi,
  /\baction[_\s-]*required\b[^\n\r]*\b(?:jobs?\.(?:total_count|total_jobs|failed_jobs|failed_checks)|jobs[_\s-]*total[_\s-]*count)\b[^\n\r"']{0,24}(?:[:=]\s*)?(?:(?:0|zero|false|no)\b(?!["'])|(["'])(?:0|zero|none|null|false|no|n\/a|na)\1|(?:none|null|false|no|n\/a|na)\b)/gi,
  /\baction[_\s-]*required\b[^\n\r]*["'](?:total_count|total_jobs|failed_jobs|failed_checks|totalCount|totalJobs|failedJobs|failedChecks)["']\s*:\s*(?:(?:0|zero|false|no)\b|(["'])(?:0|zero|none|null|false|no|n\/a|na)\1|(?:none|null|false|no|n\/a|na)\b)/gi,
  /\baction[_\s-]*required\b[^\n\r]*["']jobs["']\s*:\s*\{[^\n\r}]{0,120}["'](?:total_count|total_jobs|failed_jobs|failed_checks)["']\s*:\s*(?:(?:0|zero|false|no)\b|(["'])(?:0|zero|none|null|false|no|n\/a|na)\1|(?:none|null|false|no|n\/a|na)\b)/gi,
  /\b(?:total[_\s-]*(?:jobs?|count)|failed[_\s-]*(?:jobs?|checks?)|totalJobs?|totalCount|failedJobs?|failedChecks?|jobs?\.(?:total_count|total_jobs|failed_jobs|failed_checks)|jobs[_\s-]*total[_\s-]*count)\b[^\n\r"']{0,24}(?:[:=]\s*)?(?:(?:0|zero|false|no)\b(?!["'])|(["'])(?:0|zero|none|null|false|no|n\/a|na)\1|(?:none|null|false|no|n\/a|na)\b)[^\n\r]*\baction[_\s-]*required\b/gi,
  /\bfailed[_\s-]*(?:jobs?|checks?)\b["']?\s*[:=]\s*(?:(?:0|zero|none|null|false|no|n\/a|na)\b(?!["'])|(["'])(?:0|zero|none|null|false|no|n\/a|na)\1)/gi,
  /\bfailed[_\s-]*(?:jobs?|checks?)\b["']?\s*[:=]\s*\[\s*\]/gi,
  /\bno action[_\s-]+required\b/gi,
  /\bwithout fail(?:ing|ure|ures)?\b/gi,
  /\bunable to reproduce\b/gi
] as const;

export type ActivityLogMessagePassOrFailCell = "Pass" | "Fail" | "Nothing";

function firstPatternIndex(msg: string, patterns: readonly RegExp[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const re of patterns) {
    const index = msg.search(re);
    if (index !== -1 && index < best) best = index;
  }
  return best;
}

function stripNeutralFailPhrases(msg: string): string {
  let sanitized = msg;
  for (const pattern of NEUTRAL_FAIL_PHRASES) {
    // Preserve string length so pass/fail pattern indices stay comparable.
    sanitized = sanitized.replace(pattern, (match) => " ".repeat(match.length));
  }
  return sanitized;
}

function coerceInlineMessageValue(value: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return value.message || "";
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nested =
      coerceInlineMessageValue(record.msg, depth + 1) ||
      coerceInlineMessageValue(record.message, depth + 1) ||
      coerceInlineMessageValue(record.text, depth + 1) ||
      coerceInlineMessageValue(record.error, depth + 1) ||
      coerceInlineMessageValue(record.cause, depth + 1);
    if (nested) return nested;
  }
  return "";
}

function serializeMessageObject(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, (_key, nestedValue: unknown) =>
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
    );
  } catch {
    return "";
  }
}

function coerceMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (value instanceof Error) return value.message || value.name || "";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const inlineError =
      coerceInlineMessageValue(record.error) ||
      coerceInlineMessageValue(record.err);
    if (inlineError) return inlineError;
    const inlineMessage =
      coerceInlineMessageValue(record.msg) ||
      coerceInlineMessageValue(record.message) ||
      coerceInlineMessageValue(record.text);
    if (inlineMessage) return inlineMessage;
    const serialized = serializeMessageObject(record);
    if (serialized) return serialized;
  }
  try {
    return String(value);
  } catch {
    return "";
  }
}

/**
 * **Message Pass or Fail**: **Pass** / **Fail** / **Nothing** from **Message** —
 * leading ✅ / ❌, then URL-verify / QC-style phrases, then common pass/fail
 * words (so lines work without emojis). Neutral phrases like "no failed jobs"
 * or "action_required ... total_jobs: 0" should not be misread as failures.
 */
export function formatActivityLogMessagePassOrFail(
  msg: unknown
): ActivityLogMessagePassOrFailCell {
  const normalizedMsg = coerceMessageText(msg);
  const sanitizedMsg = stripNeutralFailPhrases(normalizedMsg);
  const failPatterns = [
    /^\s*Failed:/i,
    /URL verify:\s*failed/i,
    /\bURL not verified\b/i,
    /\baction[_\s-]*required\b/i,
    /\bfail(?:ed|s|ing|ures?)?\b/i
  ] as const;
  const t = normalizedMsg.trimStart();
  if (t.startsWith(EMOJI_PASS)) return "Pass";
  if (t.startsWith(EMOJI_FAIL)) {
    if (
      sanitizedMsg !== normalizedMsg &&
      firstPatternIndex(sanitizedMsg, failPatterns) === Number.POSITIVE_INFINITY
    ) {
      return "Nothing";
    }
    return "Fail";
  }

  const passIdx = firstPatternIndex(sanitizedMsg, [
    /URL verify:\s*passed/i,
    /^\s*URL verified:/im,
    /\bpage verified ok\b/i,
    /\bno fixes needed\b/i,
    /\bno improvements needed\b/i,
    /\ball checks passed\b/i,
    /\bsuccess(?:ful(?:ly)?)?\b/i,
    /\bsucceed(?:ed|s|ing)?\b/i,
    /\bpass(?:es|ed|ing)?\b/i
  ]);

  const failIdx = firstPatternIndex(sanitizedMsg, failPatterns);

  if (
    passIdx === Number.POSITIVE_INFINITY &&
    failIdx === Number.POSITIVE_INFINITY
  ) {
    return "Nothing";
  }
  if (failIdx <= passIdx) return "Fail";
  return "Pass";
}

// ── Header builders ──────────────────────────────────────────────────────────

/**
 * Row 1 header values between the prefix block and the trailing status columns.
 * Fills Kanban, Article outputs, plagiarism/SEO pass, Agent Role, GitHub Actions
 * labels — plus blank spacers for unmapped ranges.
 */
export function buildActivityLogSheetHeaderMiddleRow(): string[] {
  const labels: string[] = [];

  // N-U (8 cols): Kanban
  labels.push(...ACTIVITY_LOG_SHEET_COLUMN_LABELS_N_TO_U);

  // V-Y (4 cols): Article outputs
  labels.push(...ACTIVITY_LOG_SHEET_COLUMN_LABELS_V_TO_Y);

  // AH-AN (7 cols): plagiarism/SEO/SISS + syndication outputs
  labels.push(...ACTIVITY_LOG_SHEET_COLUMN_LABELS_Z_AA);

  // AB-AS (18 cols): Agent roles
  labels.push(...ACTIVITY_LOG_SHEET_COLUMN_LABELS_AB_TO_AS);

  // AT-BK (18 cols): GitHub Actions
  labels.push(...ACTIVITY_LOG_SHEET_COLUMN_LABELS_AT_TO_BK);

  // Spacer block before the trailing status block.
  // First slot: AGENT_CONTEXT.MD reference column.
  // Remaining seven slots stay blank (reserved for future columns).
  labels.push(ACTIVITY_LOG_SHEET_HEADER_AGENT_CONTEXT_MD);
  for (let i = 0; i < 7; i++) {
    labels.push("");
  }

  return labels;
}

/**
 * 0-based logical index of the **AGENT_CONTEXT.MD** column — first slot of the
 * 8-column spacer block between GitHub Actions and the trailing status block.
 */
export const ACTIVITY_LOG_AGENT_CONTEXT_MD_LOGICAL_INDEX =
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_N_TO_U.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_V_TO_Y.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_Z_AA.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_AB_TO_AS.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_AT_TO_BK.length +
  0; // first of the 8 spacer slots

/**
 * 0-based logical index of **Agent status**: first of the trailing status block
 * (`Agent status`, `Dashboard URL`, `MCP Tool`). Default A1 letter shifts when
 * the prefix or middle block widens.
 */
export const ACTIVITY_LOG_AGENT_STATUS_LOGICAL_INDEX =
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_N_TO_U.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_V_TO_Y.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_Z_AA.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_AB_TO_AS.length +
  ACTIVITY_LOG_SHEET_COLUMN_LABELS_AT_TO_BK.length +
  8;

/** 0-based logical index of `Dashboard URL` (immediately after **Agent status**). */
export const ACTIVITY_LOG_DASHBOARD_URL_LOGICAL_INDEX =
  ACTIVITY_LOG_AGENT_STATUS_LOGICAL_INDEX + 1;

/** 0-based logical index of **MCP Tool** (third column of the status block). */
export const ACTIVITY_LOG_MCP_TOOL_LOGICAL_INDEX =
  ACTIVITY_LOG_AGENT_STATUS_LOGICAL_INDEX + 2;

/** How many SEO scorecard checks (`calculateSEOScore`) map to trailing sheet columns. */
export const ACTIVITY_LOG_SEO_CHECK_COUNT = 100;

/** 0-based logical index of the first SEO scorecard column (immediately after MCP Tool). */
export const ACTIVITY_LOG_SEO_CHECK_BASE_LOGICAL_INDEX =
  ACTIVITY_LOG_MCP_TOOL_LOGICAL_INDEX + 1;

/** Row-1 header for the QC AI prompt column paired to check id `id` (1-based). */
export function formatSeoScorecardQcAiPromptHeader(id: number): string {
  return `#${id} QC AI prompt`;
}

/**
 * Total logical columns for the activity-log mirror (prefix + middle + status +
 * 100 score columns + 100 paired QC AI prompt columns). Last column index is
 * `ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT - 1`.
 */
export const ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT =
  ACTIVITY_LOG_SEO_CHECK_BASE_LOGICAL_INDEX + 2 * ACTIVITY_LOG_SEO_CHECK_COUNT;

/**
 * 1-based Google Sheets column index → A1 letters (A=1, Z=26, AA=27, …).
 */
export function sheetColumnIndex1BasedToA1Letters(index1Based: number): string {
  if (!Number.isInteger(index1Based) || index1Based < 1) {
    throw new Error(`Invalid sheet column index (1-based): ${index1Based}`);
  }
  let n = index1Based;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Row 1 titles in logical column order (prefix, middle, status, then for each
 * SEO check: score header then paired `#id QC AI prompt` header).
 * Used to match the live header row after columns are moved in the sheet.
 */
export function buildActivityLogSheetCanonicalHeaderTitles(): string[] {
  const seoNames = [...getSeoScorecardCheckNames()];
  if (seoNames.length !== ACTIVITY_LOG_SEO_CHECK_COUNT) {
    throw new Error(
      `SEO scorecard headers: expected ${ACTIVITY_LOG_SEO_CHECK_COUNT} names, got ${seoNames.length}`
    );
  }
  const seen = new Set<string>();
  const paired: string[] = [];
  for (let i = 0; i < seoNames.length; i++) {
    const scoreTitle = seoNames[i].trim();
    if (seen.has(scoreTitle)) {
      throw new Error(
        `Duplicate SEO scorecard header title at index ${i}: ${seoNames[i]}`
      );
    }
    seen.add(scoreTitle);
    paired.push(scoreTitle);
    const promptHeader = formatSeoScorecardQcAiPromptHeader(i + 1);
    if (seen.has(promptHeader.trim())) {
      throw new Error(
        `Duplicate SEO scorecard paired header at index ${i}: ${promptHeader}`
      );
    }
    seen.add(promptHeader.trim());
    paired.push(promptHeader);
  }
  return [
    ...ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX,
    ...buildActivityLogSheetHeaderMiddleRow(),
    ...ACTIVITY_LOG_SHEET_COLUMN_LABELS_BU_BV,
    ...paired
  ];
}

/** Plain lines for /api/logs and the dashboard (read-only column map). */
export function getActivityLogSheetColumnLegendLines(): string[] {
  const col = (logicalIndex0: number) =>
    sheetColumnIndex1BasedToA1Letters(logicalIndex0 + 1);

  const lastAll = col(ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT - 1);
  const prefixLast = col(
    ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX.length - 1
  );
  const kanbanFirst = col(ACTIVITY_LOG_KANBAN_START_LOGICAL_INDEX);
  const kanbanLast = col(
    ACTIVITY_LOG_KANBAN_START_LOGICAL_INDEX +
      ACTIVITY_LOG_SHEET_COLUMN_LABELS_N_TO_U.length -
      1
  );
  const roleStart = ACTIVITY_LOG_AGENT_ROLES_BLOCK_START_LOGICAL_INDEX;
  const roleLabels = ACTIVITY_LOG_SHEET_COLUMN_LABELS_AB_TO_AS;
  const roleFirst = col(roleStart);
  const roleLast = col(roleStart + roleLabels.length - 1);
  const ghStart = roleStart + roleLabels.length;
  const ghLabels = ACTIVITY_LOG_SHEET_COLUMN_LABELS_AT_TO_BK;
  const ghFirst = col(ghStart);
  const ghLast = col(ghStart + ghLabels.length - 1);
  const statusFirst = col(ACTIVITY_LOG_AGENT_STATUS_LOGICAL_INDEX);
  const statusLast = col(ACTIVITY_LOG_MCP_TOOL_LOGICAL_INDEX);
  const seoFirst = col(ACTIVITY_LOG_SEO_CHECK_BASE_LOGICAL_INDEX);

  const lines: string[] = [
    `Google Sheet activity mirror — tab "${ACTIVITY_LOG_SHEET_TAB_NAME}" (newest data row = 2). Mirror writes and header refresh follow row 1 titles; letters below are the default contiguous column map (A:${prefixLast} prefix, Kanban ${kanbanFirst}:${kanbanLast}, article outputs, plagiarism + live SEO pass, agent roles ${roleFirst}:${roleLast}, GitHub ${ghFirst}:${ghLast}, spacer band, status ${statusFirst}:${statusLast}, then paired SEO scorecard columns ${seoFirst}:${lastAll}: for each check, 1=pass / 0=fail then \`#id QC AI prompt\` with a full SYSTEM+USER remediation prompt (modelPrompt-style) when score is 0, truncated to the sheet prompt cap; blank when no snapshot or pass):`
  ];

  for (
    let i = 0;
    i < ACTIVITY_LOG_SHEET_COLUMN_LETTERS_A_TO_PREFIX.length;
    i++
  ) {
    lines.push(
      `  ${ACTIVITY_LOG_SHEET_COLUMN_LETTERS_A_TO_PREFIX[i]} — ${ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX[i]}`
    );
  }

  lines.push("  --- Kanban Stages ---");
  for (let i = 0; i < ACTIVITY_LOG_SHEET_COLUMN_LETTERS_N_TO_U.length; i++) {
    lines.push(
      `  ${ACTIVITY_LOG_SHEET_COLUMN_LETTERS_N_TO_U[i]} — ${ACTIVITY_LOG_SHEET_COLUMN_LABELS_N_TO_U[i]}`
    );
  }

  lines.push("  --- Article Outputs ---");
  for (let i = 0; i < ACTIVITY_LOG_SHEET_COLUMN_LETTERS_V_TO_Y.length; i++) {
    lines.push(
      `  ${ACTIVITY_LOG_SHEET_COLUMN_LETTERS_V_TO_Y[i]} — ${ACTIVITY_LOG_SHEET_COLUMN_LABELS_V_TO_Y[i]}`
    );
  }

  lines.push("  --- Plagiarism + live SEO pass ---");
  for (let i = 0; i < ACTIVITY_LOG_SHEET_COLUMN_LETTERS_Z_AA.length; i++) {
    lines.push(
      `  ${ACTIVITY_LOG_SHEET_COLUMN_LETTERS_Z_AA[i]} — ${ACTIVITY_LOG_SHEET_COLUMN_LABELS_Z_AA[i]}`
    );
  }

  lines.push(`  --- Agent Roles (${roleFirst}–${roleLast}) ---`);
  for (let i = 0; i < roleLabels.length; i++) {
    lines.push(`  ${col(roleStart + i)} — ${roleLabels[i]}`);
  }

  lines.push(`  --- GitHub Actions (${ghFirst}–${ghLast}) ---`);
  for (let i = 0; i < ghLabels.length; i++) {
    lines.push(`  ${col(ghStart + i)} — ${ghLabels[i]}`);
  }

  lines.push(`  ${statusFirst} — ${ACTIVITY_LOG_SHEET_COLUMN_LABELS_BU_BV[0]}`);
  lines.push(
    `  ${col(ACTIVITY_LOG_DASHBOARD_URL_LOGICAL_INDEX)} — ${ACTIVITY_LOG_SHEET_COLUMN_LABELS_BU_BV[1]}`
  );
  lines.push(
    `  ${col(ACTIVITY_LOG_MCP_TOOL_LOGICAL_INDEX)} — ${ACTIVITY_LOG_SHEET_COLUMN_LABELS_BU_BV[2]}`
  );

  lines.push(
    `  --- SEO scorecard (${ACTIVITY_LOG_SEO_CHECK_COUNT} checks × 2 cols, default ${seoFirst}–${lastAll}) ---`
  );
  lines.push(
    "  For each check: score cell uses the scorecard check name as header (1 pass, 0 fail); the column to its right is `#id QC AI prompt` with short Workers AI guidance when score is 0, else blank."
  );

  lines.push(
    `Column ${col(ACTIVITY_LOG_MESSAGE_LOGICAL_INDEX)} (Message): full log message body.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_ERROR_MESSAGE_LOGICAL_INDEX)} (${ACTIVITY_LOG_SHEET_HEADER_ERROR_MESSAGE}): short human-readable summary for warning/error rows (Workers AI); blank for info.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_ERROR_REMEDIATION_PROMPT_LOGICAL_INDEX)} (${ACTIVITY_LOG_SHEET_HEADER_ERROR_REMEDIATION_PROMPT}): full SYSTEM+USER remediation cell from Workers AI for warning/error rows; blank for info.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_KEYWORD_LOGICAL_INDEX)} (Keyword): resolved article keyword when known; otherwise ${ACTIVITY_LOG_KEYWORD_SENTINEL_ERROR} for error-level logs or ${ACTIVITY_LOG_KEYWORD_SENTINEL_SCOUT} for other levels when none resolves.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_AGENTS_SKILL_LOGICAL_INDEX)} (Agentskill.sh): active Agent Role label plus the agentskill.sh slug for the current Step # pipeline label when it maps to a repo skill (e.g. Orchestrator — cloudflare-worker-dev).`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_MESSAGE_PASS_OR_FAIL_LOGICAL_INDEX)} (Message Pass or Fail): Pass or Fail from Message text (leading ✅/❌, URL verify passed/failed, page verified OK, Failed:, common pass/fail words, QC-style “no fixes needed”, etc.); Nothing when neither applies.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_PAGE_HTTP_LOGICAL_INDEX)} (Page HTTP status): real HTTP status from a live HEAD/GET probe of column ${col(ACTIVITY_LOG_ARTICLE_URL_LOGICAL_INDEX)} when mirroring to Google Sheets (e.g. 200, 404, 302); blank when the article URL cell is empty; cached ~45s per URL.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_PUBLISHED_PENDING_LOGICAL_INDEX)} (Published or Pending): Published after deploy-kv + done Kanban, a Published: operations line, or URL verify passed in sub-statuses; otherwise Pending.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_ARTICLE_BACKED_UP_TO_GITHUB_LOGICAL_INDEX)} (${ACTIVITY_LOG_SHEET_HEADER_ARTICLE_BACKED_UP_TO_GITHUB}): on **Published** operations rows, outcome of the KV/HTML GitHub backup (PR URL, skipped, or a short error); blank for other log lines.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_PLAGIARISM_PERCENT_LOGICAL_INDEX)} (Plagiarism Percentage): after the full publish pipeline, percent of 6-word windows in the final article HTML (plain text) that also appear verbatim in the captured SERP competitor excerpt (heuristic overlap, not legal plagiarism); blank when no competitor text or not logged with that metric.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_SEO_CONTENT_OPTIMIZER_LOGICAL_INDEX)} (@anthropic/seo-content-optimizer — live URL pass): after KV publish, the Worker GETs the live article URL, strips scripts/styles, and runs a Workers AI pass modeled on the agentskill.sh article SEO skill; cell holds the optimization notes (truncated for Sheets).`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_REVERSE_LINKS_INJECTED_LOGICAL_INDEX)} (Reverse Links Injected): Step 23 count of already-published sibling articles in the same category that received a contextual back-link to the new article; 0 when no suitable paragraph was found or no sibling articles existed.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_RSS_FEED_URL_LOGICAL_INDEX)} (RSS Feed URL): Step 24 canonical RSS feed URL updated during feed syndication (e.g. https://catsluvus.com/feed.rss); blank when feed syndication was skipped or failed.`
  );
  lines.push(
    `Each agent role writes actionable guidance (status + NEXT/FIX/IMPROVE) to its owned columns. The Orchestrator manages Kanban stages (${kanbanFirst}–${kanbanLast}). Active agents mark ACTIVE in their agent-role columns.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_MODEL_PROMPT_LOGICAL_INDEX)} (modelPrompt): Workers AI system+user prompt for that log row when the pipeline attached modelPrompt (any Workers AI / tool-using call we instrument); truncated for Sheets.`
  );
  lines.push(
    `Column ${col(ACTIVITY_LOG_MCP_TOOL_LOGICAL_INDEX)} (${ACTIVITY_LOG_SHEET_HEADER_MCP_TOOL}): comma-separated tool names from AI SDK tool calls when logged (e.g. search, execute); MCP registration lines use a short server label; otherwise blank.`
  );
  return lines;
}
