/**
 * Verdicts for CTR snippet experiments.
 *
 * The idle tick rewrites the title and meta description of live, ranking
 * production pages. `classifyCtrExperiment` is the part that decides,
 * once a full Search Console window has turned over, whether that rewrite
 * actually helped — and, just as importantly, when the data cannot say.
 *
 * Two honest-answer rules shape this:
 *
 *  - **Thin data is not a result.** A page that drew 12 impressions in the
 *    after-window cannot distinguish a real CTR move from noise, so it
 *    returns `inconclusive` rather than a verdict someone might act on.
 *  - **A CTR change is only about the snippet if the ranking held.** CTR
 *    rises naturally as a page moves up the results and falls as it slips.
 *    When average position has moved materially, the outcome is
 *    `confounded`: the number changed, but the rewrite is not what we can
 *    credit or blame.
 */

export interface CtrWindow {
  impressions: number;
  clicks: number;
  /** Click-through rate as a 0–1 fraction; derived when absent. */
  ctr?: number | null;
  /** Average Google result position (1 = top). */
  position?: number | null;
}

export type CtrOutcome =
  | "improved"
  | "regressed"
  | "inconclusive"
  | "confounded";

export interface CtrVerdict {
  outcome: CtrOutcome;
  /** After-window CTR minus before-window CTR, as a 0–1 fraction. */
  ctrDelta: number;
  beforeCtr: number;
  afterCtr: number;
  /** Positive = the page moved *down* the results (worse). */
  positionDelta: number;
  detail: string;
}

export interface CtrClassifyOptions {
  /** Impressions needed in BOTH windows before a verdict is given. */
  minImpressions?: number;
  /** CTR move, in absolute fraction, that counts as a real change. */
  minCtrDelta?: number;
  /** Average-position move past which the result is confounded. */
  maxPositionDrift?: number;
}

/** CTR from an explicit value when present, else clicks ÷ impressions. */
export function windowCtr(window: CtrWindow): number {
  if (typeof window.ctr === "number" && Number.isFinite(window.ctr)) {
    // Search Console reports CTR as a fraction; tolerate a percentage.
    return window.ctr > 1 ? window.ctr / 100 : window.ctr;
  }
  if (window.impressions <= 0) return 0;
  return window.clicks / window.impressions;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

export type RollbackDecision =
  | { rollback: true }
  | { rollback: false; reason: string };

/**
 * Decide whether a losing snippet may be restored.
 *
 * Twenty-eight days pass between applying a rewrite and judging it, and the
 * Editorial, QC and Polish agents all edit pages in that window. If the live
 * title is no longer the one we wrote, restoring the original would revert
 * whatever came after ours rather than undoing our own change — so the guard
 * refuses, and the experiment is left recorded but unreverted.
 *
 * Split out from the rollback's fetch/write plumbing so the rule itself is
 * testable; the surrounding I/O is not.
 */
export function shouldRollbackSnippet(input: {
  /** Title currently live on the page. */
  liveTitle: string;
  /** Title this experiment wrote. */
  appliedTitle: string;
  /** Title that was live before this experiment. */
  originalTitle: string;
}): RollbackDecision {
  const live = input.liveTitle.trim();
  const applied = input.appliedTitle.trim();
  const original = input.originalTitle.trim();

  if (!original) {
    return { rollback: false, reason: "no recorded original title" };
  }
  if (!live) {
    return { rollback: false, reason: "live page has no title to compare" };
  }
  if (live === original) {
    return { rollback: false, reason: "snippet already matches the original" };
  }
  if (applied && live !== applied) {
    return {
      rollback: false,
      reason: `live title has since changed to "${live.slice(0, 60)}"`
    };
  }
  return { rollback: true };
}

export function classifyCtrExperiment(
  before: CtrWindow,
  after: CtrWindow,
  opts: CtrClassifyOptions = {}
): CtrVerdict {
  const minImpressions = opts.minImpressions ?? 50;
  const minCtrDelta = opts.minCtrDelta ?? 0.005;
  const maxPositionDrift = opts.maxPositionDrift ?? 2;

  const beforeCtr = windowCtr(before);
  const afterCtr = windowCtr(after);
  const ctrDelta = afterCtr - beforeCtr;

  const beforePos =
    typeof before.position === "number" && Number.isFinite(before.position)
      ? before.position
      : null;
  const afterPos =
    typeof after.position === "number" && Number.isFinite(after.position)
      ? after.position
      : null;
  const positionDelta =
    beforePos !== null && afterPos !== null ? afterPos - beforePos : 0;

  const base = { ctrDelta, beforeCtr, afterCtr, positionDelta };

  if (
    before.impressions < minImpressions ||
    after.impressions < minImpressions
  ) {
    return {
      ...base,
      outcome: "inconclusive",
      detail: `too few impressions to judge (before ${before.impressions}, after ${after.impressions}, need ${minImpressions} in each)`
    };
  }

  if (Math.abs(positionDelta) > maxPositionDrift) {
    const direction = positionDelta > 0 ? "fell" : "rose";
    return {
      ...base,
      outcome: "confounded",
      detail: `average position ${direction} ${Math.abs(positionDelta).toFixed(1)} places (${beforePos?.toFixed(1)} → ${afterPos?.toFixed(1)}); CTR moved ${pct(ctrDelta)} but the ranking change, not the snippet, is the likely cause`
    };
  }

  if (Math.abs(ctrDelta) < minCtrDelta) {
    return {
      ...base,
      outcome: "inconclusive",
      detail: `CTR moved ${pct(ctrDelta)} (${pct(beforeCtr)} → ${pct(afterCtr)}), under the ${pct(minCtrDelta)} threshold for a real change`
    };
  }

  return {
    ...base,
    outcome: ctrDelta > 0 ? "improved" : "regressed",
    detail: `CTR ${ctrDelta > 0 ? "rose" : "fell"} ${pct(Math.abs(ctrDelta))} (${pct(beforeCtr)} → ${pct(afterCtr)}) at a steady position${beforePos !== null ? ` (~${beforePos.toFixed(1)})` : ""}`
  };
}
