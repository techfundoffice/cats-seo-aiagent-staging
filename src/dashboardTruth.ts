/**
 * Operator-facing truth for the staging dashboard.
 *
 * Chat and vision are Claude-only. These helpers turn Durable Object state
 * and activity-log text into labels that do not call a stopped run "idle",
 * do not treat historical OpenRouter / Kimi rows as current health, and do
 * not present a Kimi OAuth failure as a trusted observer.
 */

import { pipelineRunLooksInterrupted } from "./pipeline/pipeline-run-guard";

export const STAGING_IDENTITY_LABEL = "Claude-only staging";

export const CLAUDE_FAILURE_BANNER_TITLE = "Claude stopped the pipeline";

export const CLAUDE_FAILURE_NO_FALLBACK =
  "Chat and vision stay on Claude. Nothing switches to OpenRouter, Workers AI, Kimi, or Qwen.";

/** A dashboard that has not received a state push in this long looks frozen. */
export const DASHBOARD_STATE_STALE_MS = 20 * 60 * 1000;

export type OperatorRunKind =
  | "idle"
  | "running"
  | "stuck"
  | "paused"
  | "failed";

export interface OperatorRunPresentation {
  kind: OperatorRunKind;
  label: string;
  detail: string;
  background: string;
  color: string;
}

type AgentStatus = "idle" | "scouting" | "generating" | "paused";

const RUN_COLORS: Record<
  OperatorRunKind,
  { background: string; color: string }
> = {
  idle: { background: "#f3f4f6", color: "#374151" },
  running: { background: "#d1fae5", color: "#065f46" },
  stuck: { background: "#fef3c7", color: "#92400e" },
  paused: { background: "#ede9fe", color: "#5b21b6" },
  failed: { background: "#fee2e2", color: "#991b1b" }
};

function presentation(
  kind: OperatorRunKind,
  label: string,
  detail: string
): OperatorRunPresentation {
  return { kind, label, detail, ...RUN_COLORS[kind] };
}

/**
 * Idle is only an empty run. A leftover pipeline step, a pause, or a Claude
 * failure each get their own label. A failure wins over a frozen step so the
 * red banner stays the primary signal.
 */
export function deriveOperatorRunPresentation(input: {
  status: AgentStatus;
  currentStep?: string | null;
  claudeChatFailure?: { message?: string } | null;
}): OperatorRunPresentation {
  const step = (input.currentStep ?? "").trim();
  const midPipeline = pipelineRunLooksInterrupted({
    status: input.status,
    currentCategory: null,
    currentKeyword: null,
    currentArticleSlug: null,
    currentStep: step || null,
    currentCompetitorUrl: null,
    lastSheetStepLabel: "",
    articlesFailed: 0
  });
  const failure = (input.claudeChatFailure?.message ?? "").trim();
  const live = input.status === "generating" || input.status === "scouting";

  if (failure) {
    const frozen = midPipeline ? ` Frozen step still set: ${step}.` : "";
    return presentation(
      "failed",
      "FAILED",
      `Paused after a Claude failure.${frozen} The red banner is how to fix it. No other chat model runs.`
    );
  }

  if (midPipeline && !live) {
    return presentation(
      "stuck",
      "STUCK",
      `Status is ${input.status}, but the pipeline step is still "${step}". This is not idle.`
    );
  }

  if (live) {
    const verb = input.status === "scouting" ? "Scouting" : "Generating";
    return presentation(
      "running",
      "RUNNING",
      step ? `${verb}: ${step}` : `${verb}.`
    );
  }

  if (input.status === "paused") {
    return presentation(
      "paused",
      "PAUSED",
      "The article loop is paused. It is not idle, and it is not running."
    );
  }

  return presentation("idle", "IDLE", "No article run in progress.");
}

export function formatAgeMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h ago` : `${hours}h ${rem}m ago`;
}

export interface DashboardFreshness {
  activityLine: string;
  stateLine: string;
  stale: boolean;
}

export function formatDashboardFreshness(input: {
  lastActivity?: string | null;
  stateAgeMs: number | null;
}): DashboardFreshness {
  const activity = input.lastActivity?.trim()
    ? `Last activity ${input.lastActivity.trim()}`
    : "Last activity unknown";
  if (input.stateAgeMs == null || !Number.isFinite(input.stateAgeMs)) {
    return {
      activityLine: activity,
      stateLine: "Dashboard state age unknown",
      stale: false
    };
  }
  const age = Math.max(0, input.stateAgeMs);
  const stale = age >= DASHBOARD_STATE_STALE_MS;
  return {
    activityLine: activity,
    stateLine: stale
      ? `Dashboard state is stale (${formatAgeMs(age)})`
      : `Dashboard state updated ${formatAgeMs(age)}`,
    stale
  };
}

const HISTORICAL_OPENROUTER_CREDIT_REASONS = new Set([
  "kimi-credits-exhausted",
  "kimi-credits-exhausted-precheck"
]);

/** Human label for a stored editorial reason key. */
export function editorialReasonLabel(reason: string): string {
  if (HISTORICAL_OPENROUTER_CREDIT_REASONS.has(reason)) {
    return "Historical OpenRouter credit skip (obsolete; chat is Claude-only)";
  }
  if (reason === "kimi-audit-partial-fail") {
    return "Claude audit partial fail (stored key: kimi-audit-partial-fail)";
  }
  if (reason === "kimi-audit-unavailable") {
    return "Claude audit unavailable (stored key: kimi-audit-unavailable)";
  }
  return reason;
}

export interface EditorialReasonRow {
  reason: string;
  label: string;
  count: number;
}

/**
 * Drop obsolete OpenRouter credit skips from the visible histogram.
 * The count is returned so the panel can say they were hidden.
 */
export function partitionEditorialReasonCounts(
  counts: Record<string, number> | null | undefined
): { visible: EditorialReasonRow[]; hiddenHistoricalCreditSkips: number } {
  const visible: EditorialReasonRow[] = [];
  let hiddenHistoricalCreditSkips = 0;
  for (const [reason, count] of Object.entries(counts ?? {})) {
    if (!Number.isFinite(count) || count <= 0) continue;
    if (HISTORICAL_OPENROUTER_CREDIT_REASONS.has(reason)) {
      hiddenHistoricalCreditSkips += count;
      continue;
    }
    visible.push({ reason, label: editorialReasonLabel(reason), count });
  }
  visible.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return { visible, hiddenHistoricalCreditSkips };
}

export type ObserverNarrativeStatus = "green" | "yellow" | "red" | "unknown";

export type ObserverTrust = "trusted" | "fallback" | "untrusted" | "none";

export interface ObserverTrustAssessment {
  trust: ObserverTrust;
  /** Color for the trust chip. Independent of the narrative's pipeline STATUS. */
  tier: "green" | "amber" | "red" | "unknown";
  summary: string;
  howToFix: string | null;
}

const KIMI_OBSERVER_HOW_TO_FIX =
  "This tick was written by the old Kimi observer, or it reports an invalid Kimi OAuth token. Kimi is not the chat or vision path. Current ticks use Claude only. If the red banner at the top is up, re-authorize Claude. Do not read a Kimi line as a healthy observer.";

const CLAUDE_FALLBACK_HOW_TO_FIX =
  "Claude did not write this narrative. The tick is deterministic counters only. Read the red banner, re-authorize Claude, or wait out a 429. There is no other chat model.";

/**
 * Trust of the observer's language model, not the pipeline health it describes.
 * A Claude narrative that says the scout is empty is still trusted.
 * A Kimi or invalid-OAuth narrative is not.
 */
export function assessObserverNarrativeTrust(
  raw: string | null | undefined
): ObserverTrustAssessment {
  const text = (raw ?? "").trim();
  if (!text) {
    return {
      trust: "none",
      tier: "unknown",
      summary: "No observer narrative yet",
      howToFix: null
    };
  }
  const kimiSpeaker = /^Observer \(Kimi\)\b/i.test(text);
  const kimiFailure =
    /Kimi call failed/i.test(text) ||
    /Kimi unavailable/i.test(text) ||
    /OAuth access token is invalid/i.test(text);
  if (kimiSpeaker || kimiFailure) {
    return {
      trust: "untrusted",
      tier: "red",
      summary: "Untrusted — Kimi observer or invalid Kimi OAuth",
      howToFix: KIMI_OBSERVER_HOW_TO_FIX
    };
  }
  if (
    /Claude unavailable/i.test(text) ||
    /Observer fallback/i.test(text) ||
    /using fallback narrative/i.test(text)
  ) {
    return {
      trust: "fallback",
      tier: "amber",
      summary: "Claude unavailable — counters only, not another model",
      howToFix: CLAUDE_FALLBACK_HOW_TO_FIX
    };
  }
  return {
    trust: "trusted",
    tier: "green",
    summary: "Claude narrative",
    howToFix: null
  };
}

export interface ParsedObserverNarrative {
  headline: string;
  status: ObserverNarrativeStatus;
  whatsHappening: string;
  whatsNot: string;
  recommendedAction: string;
  trust: ObserverTrustAssessment;
}

function observerStatusWord(value: string): ObserverNarrativeStatus {
  const text = value.toLowerCase();
  if (/\bred\b/.test(text)) return "red";
  if (/\byellow\b/.test(text)) return "yellow";
  if (/\bgreen\b/.test(text)) return "green";
  return "unknown";
}

function lookupObserverSection(sections: string[], label: RegExp): string {
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i] ?? "";
    const match = section.match(label);
    if (!match) continue;
    const inline = section
      .replace(label, "")
      .replace(/^[\s:*]+/, "")
      .trim();
    if (inline) return inline;
    const next = sections[i + 1]?.trim() ?? "";
    if (next && !/^[A-Z][A-Z'’ ]{3,}:/.test(next)) return next;
  }
  return "";
}

/**
 * Parse one observer narrative. Returns null for score-distribution and
 * other `Observer:` meta lines that are not a five-section report.
 * Accepts the activity-log prefix and the bare KV history body.
 */
export function parseObserverNarrative(
  raw: string | null | undefined
): ParsedObserverNarrative | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const prefix = trimmed.match(/^Observer \((Kimi|Claude)\):\s*/i);
  const body = (prefix ? trimmed.slice(prefix[0].length) : trimmed).replace(
    /\*\*/g,
    ""
  );
  if (!/\bHEADLINE\b/i.test(body)) return null;
  const sections = body.split(/\s*\|\s*/).map((section) => section.trim());
  const headline =
    lookupObserverSection(sections, /^HEADLINE\b/i) || "(no headline)";
  const status = observerStatusWord(
    lookupObserverSection(sections, /^STATUS\b/i)
  );
  return {
    headline,
    status,
    whatsHappening: lookupObserverSection(sections, /^WHAT['’]S HAPPENING\b/i),
    whatsNot: lookupObserverSection(
      sections,
      /^WHAT['’]S NOT HAPPENING\b[^:]*/i
    ),
    recommendedAction: lookupObserverSection(
      sections,
      /^RECOMMENDED ACTION\b/i
    ),
    trust: assessObserverNarrativeTrust(trimmed)
  };
}

export interface SeoPillarRow {
  name: string;
  passed: number;
  total: number;
  label: string;
}

export function formatSeoPillarRows(
  pillars: Record<string, { passed: number; total: number }> | null | undefined
): SeoPillarRow[] {
  if (!pillars) return [];
  return Object.entries(pillars).map(([name, counts]) => {
    const passed = Number.isFinite(counts?.passed) ? counts.passed : 0;
    const total = Number.isFinite(counts?.total) ? counts.total : 0;
    return { name, passed, total, label: `${passed}/${total}` };
  });
}

export type DependencyTier = "green" | "amber" | "red" | "unknown";

export interface DependencyChip {
  id: "claude" | "research" | "observer";
  label: string;
  tier: DependencyTier;
  detail: string;
}

export function deriveDependencyChips(input: {
  claudeConfigured: boolean;
  claudeActive: boolean;
  claudeUiStatus?: "active" | "expiring_soon" | "expired" | "none";
  claudeFailureMessage?: string | null;
  providers: ReadonlyArray<{
    id: string;
    tier: "ok" | "degraded" | "exhausted";
    evidence: string;
  }>;
  observerRaw: string | null;
}): DependencyChip[] {
  const failure = (input.claudeFailureMessage ?? "").trim();
  let claude: DependencyChip;
  if (failure) {
    claude = {
      id: "claude",
      label: "Claude",
      tier: "red",
      detail: "Stopped — red banner. No fallback model."
    };
  } else if (!input.claudeConfigured || input.claudeUiStatus === "none") {
    claude = {
      id: "claude",
      label: "Claude",
      tier: "red",
      detail: "Not configured. Authorize Claude before generating."
    };
  } else if (!input.claudeActive || input.claudeUiStatus === "expired") {
    claude = {
      id: "claude",
      label: "Claude",
      tier: "red",
      detail: "Expired — re-authorize. Chat will not switch models."
    };
  } else if (input.claudeUiStatus === "expiring_soon") {
    claude = {
      id: "claude",
      label: "Claude",
      tier: "amber",
      detail: "Expiring soon. Only chat and vision path."
    };
  } else {
    claude = {
      id: "claude",
      label: "Claude",
      tier: "green",
      detail: "Active. Only chat and vision path."
    };
  }

  const research = input.providers.find(
    (provider) => provider.id === "dataforseo"
  );
  const researchChip: DependencyChip = !research
    ? {
        id: "research",
        label: "DataForSEO",
        tier: "unknown",
        detail: "No research-API reading in this log window."
      }
    : research.tier === "exhausted"
      ? {
          id: "research",
          label: "DataForSEO",
          tier: "red",
          detail: research.evidence
        }
      : research.tier === "degraded"
        ? {
            id: "research",
            label: "DataForSEO",
            tier: "amber",
            detail: research.evidence
          }
        : {
            id: "research",
            label: "DataForSEO",
            tier: "green",
            detail: "No HTTP 402 quota failures in the log window."
          };

  const observerTrust = assessObserverNarrativeTrust(input.observerRaw);
  const observer: DependencyChip = {
    id: "observer",
    label: "Observer",
    tier: observerTrust.tier,
    detail: observerTrust.summary
  };

  return [claude, researchChip, observer];
}

/** Newest narrative in an observer ring, ignoring meta lines. */
export function latestObserverNarrativeRaw(
  entries: ReadonlyArray<{ msg?: string }>
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const msg = entries[i]?.msg ?? "";
    if (parseObserverNarrative(msg)) return msg;
  }
  return null;
}
