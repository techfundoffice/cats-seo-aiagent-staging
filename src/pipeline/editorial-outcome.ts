/**
 * Pure classifier for the editorial-agent's step-4 decision: given the
 * audit state, what outcome do we record and what do we log?
 *
 * Extracted from `runEditorialAgent` in `editorial-agent.ts` so the
 * 2×2×2 truth table for `{ applyFix, textKimiFailed, visualKimiFailed }`
 * × `{ fixesCount === 0, fixesCount > 0 }` can be tested in isolation.
 *
 * The historical bug class this protects against: a Kimi infrastructure
 * failure (OpenRouter token-budget exhaustion, Workers AI quota) being
 * silently converted into a "no findings, article is fine" business
 * outcome — masking the actual editorial QC outage that left 75 articles
 * unreviewed in a single day before this was caught.
 */

export type EditorialDecisionKind = "rewrite" | "fail" | "skipped";

export type EditorialDecisionLogLevel = "info" | "warning" | "error";

export interface EditorialDecision {
  kind: EditorialDecisionKind;
  /**
   * Stored in the per-day stat record. For `fail` outcomes this drives
   * the existing failure-reason histogram + the editorial-lessons feedback
   * loop. For `skipped` outcomes this populates the new skip-reason
   * histogram (`skipReasons`) so the dashboard can distinguish
   * "skipped: clean article" from "skipped: kimi-audit-partial-fail".
   */
  reason: string;
  /** Log level the editorial-agent should use when emitting the decision. */
  logLevel: EditorialDecisionLogLevel;
  /** Human-readable phrase the log line uses to describe the decision. */
  logMessage: string;
}

export interface ClassifyEditorialInput {
  applyFix: boolean;
  fixesCount: number;
  textKimiFailed: boolean;
  visualKimiFailed: boolean;
}

export function classifyEditorialOutcome(
  input: ClassifyEditorialInput
): EditorialDecision {
  // applyFix=false short-circuits before we look at the audits — this is
  // the report-only mode used by ad-hoc bearer-gated triggers, not the
  // autonomous publish flow.
  if (!input.applyFix) {
    return {
      kind: "skipped",
      reason: "applyFix=false",
      logLevel: "info",
      logMessage: "applyFix=false — report-only mode, skipping rewrite"
    };
  }

  // Non-empty findings always proceed to the rewrite path regardless of
  // whether one audit lane was Kimi-blocked — the other lane produced
  // something actionable, so the article gets the benefit of it.
  if (input.fixesCount > 0) {
    return {
      kind: "rewrite",
      reason: "actionable-fixes-found",
      logLevel: "info",
      logMessage: `rewriting article to address ${input.fixesCount} fixes`
    };
  }

  // Empty findings — fan out on Kimi state.
  if (input.textKimiFailed && input.visualKimiFailed) {
    return {
      kind: "fail",
      reason: "kimi-audit-unavailable",
      logLevel: "error",
      logMessage:
        "both text + visual audits failed at Kimi layer — recording as fail, not skip. Check OpenRouter credits / Workers AI quota."
    };
  }
  if (input.textKimiFailed || input.visualKimiFailed) {
    return {
      kind: "skipped",
      reason: "kimi-audit-partial-fail",
      logLevel: "warning",
      logMessage: `one audit pass failed at Kimi layer (text:${input.textKimiFailed} visual:${input.visualKimiFailed}) — partial findings empty, skipping rewrite.`
    };
  }
  return {
    kind: "skipped",
    reason: "no-actionable-fixes",
    logLevel: "info",
    logMessage: "no actionable fixes — article already meets bar"
  };
}
