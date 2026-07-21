/**
 * Observer score distribution — last-N SEO-score statistics for the
 * AI Observer narrative + the admin dashboard.
 *
 * The pipeline records `seo_score` (0-100, sum of the 100-check
 * scorecard) on every successfully published article. The Observer
 * 15-min tick currently emits a free-form Kimi narrative without a
 * concrete quality-distribution signal; operators have asked for "are
 * the last 50 articles all in the 80s, or are we shipping a long tail
 * of 50s?".
 *
 * This module provides the pure statistics over a list of scores so
 * the same numbers power:
 *   1. GET /api/admin/observer-score-distribution (dashboard)
 *   2. The one-line summary embedded in each Observer tick log entry
 *
 * No I/O. No state. Unit-tested.
 */

/**
 * Histogram bucket boundaries used by the dashboard. Each bucket is
 * **inclusive on both ends** (`min ≤ score ≤ max`) — a score of 50
 * lands in `50-59 (at floor)`, 100 lands in `90-100 (near-perfect)`,
 * etc. Buckets do not overlap because each bucket's `max` is exactly
 * one less than the next bucket's `min`. The 50-point boundary
 * mirrors the SEO-score gate publish floor; the rest match the
 * dashboard's tier labels (`fair` / `strong` / `excellent` /
 * `near-perfect`).
 */
export const SCORE_HISTOGRAM_BUCKETS: ReadonlyArray<{
  label: string;
  min: number;
  max: number;
}> = [
  { label: "0-49 (below publish floor)", min: 0, max: 49 },
  { label: "50-59 (at floor)", min: 50, max: 59 },
  { label: "60-69 (fair)", min: 60, max: 69 },
  { label: "70-79 (strong)", min: 70, max: 79 },
  { label: "80-89 (excellent)", min: 80, max: 89 },
  { label: "90-100 (near-perfect)", min: 90, max: 100 }
];

export interface ScoreDistribution {
  /** Number of scores in the window. */
  count: number;
  /** Lowest score in the window. `null` when count = 0. */
  min: number | null;
  /** Highest score in the window. `null` when count = 0. */
  max: number | null;
  /** Arithmetic mean. `null` when count = 0. */
  mean: number | null;
  /** Median (linear-interp p50). `null` when count = 0. */
  median: number | null;
  /** 25th percentile. `null` when count = 0. */
  p25: number | null;
  /** 75th percentile. `null` when count = 0. */
  p75: number | null;
  /** Population standard deviation. `null` when count < 2. */
  stddev: number | null;
  /** How many articles scored below the 50-point publish floor. */
  belowFloorCount: number;
  /** Per-bucket counts (parallel to SCORE_HISTOGRAM_BUCKETS). */
  histogram: ReadonlyArray<{ label: string; count: number }>;
}

/**
 * Linear-interpolation percentile (NIST type 7 / numpy default).
 * Returns `null` for empty input. `p` in [0, 100].
 */
function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = ((sortedAsc.length - 1) * p) / 100;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute the score distribution from a list of integer scores
 * (typically the last 50 articles by ROWID DESC). Input is
 * unsorted; the helper sorts internally.
 *
 * Negative / non-finite scores are filtered out defensively. The
 * `articles.seo_score` column currently defaults to 0 (not -1), but
 * callers may concat from other sources (in-flight retries, joined
 * historical tables), so we don't trust the input shape and filter
 * out anything that would skew the mean.
 */
export function summarizeScoreDistribution(
  rawScores: readonly number[]
): ScoreDistribution {
  const scores = rawScores
    .filter((n) => Number.isFinite(n) && n >= 0)
    .map((n) => Math.min(100, Math.max(0, n)));
  const histogram = SCORE_HISTOGRAM_BUCKETS.map((b) => ({
    label: b.label,
    count: scores.filter((s) => s >= b.min && s <= b.max).length
  }));
  const belowFloorCount = scores.filter((s) => s < 50).length;
  if (scores.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      p25: null,
      p75: null,
      stddev: null,
      belowFloorCount: 0,
      histogram
    };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = sorted.reduce((acc, s) => acc + s, 0) / sorted.length;
  const variance =
    sorted.length < 2
      ? null
      : sorted.reduce((acc, s) => acc + (s - mean) * (s - mean), 0) /
        sorted.length;
  const stddev = variance === null ? null : Math.sqrt(variance);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: round2(mean),
    median: round2(percentile(sorted, 50) as number),
    p25: round2(percentile(sorted, 25) as number),
    p75: round2(percentile(sorted, 75) as number),
    stddev: stddev === null ? null : round2(stddev),
    belowFloorCount,
    histogram
  };
}

/**
 * Compare two distributions and report direction + magnitude. Used
 * for "trend over the last 50 articles" — by splitting the window
 * into older-half + newer-half and reporting the median delta. A
 * positive `medianDelta` means quality is climbing.
 */
export function compareDistributions(
  older: ScoreDistribution,
  newer: ScoreDistribution
): {
  trend: "improving" | "declining" | "flat" | "unknown";
  medianDelta: number | null;
} {
  if (older.median === null || newer.median === null) {
    return { trend: "unknown", medianDelta: null };
  }
  const delta = round2(newer.median - older.median);
  let trend: "improving" | "declining" | "flat";
  if (delta > 0.5) trend = "improving";
  else if (delta < -0.5) trend = "declining";
  else trend = "flat";
  return { trend, medianDelta: delta };
}

/**
 * Render the distribution as a one-line summary suitable for the
 * Observer-tick log entry the dashboard surfaces under the
 * `observerAgent` role.
 */
export function formatDistributionOneLine(d: ScoreDistribution): string {
  if (d.count === 0) {
    return "Score distribution: no completed articles in window.";
  }
  return (
    `Score distribution (n=${d.count}): ` +
    `median=${d.median} p25=${d.p25} p75=${d.p75} ` +
    `min=${d.min} max=${d.max} stddev=${d.stddev ?? "n/a"}` +
    (d.belowFloorCount > 0
      ? ` | ${d.belowFloorCount} below 50-point floor`
      : "")
  );
}
