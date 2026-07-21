import { describe, expect, it } from "vitest";
import {
  SCORE_HISTOGRAM_BUCKETS,
  compareDistributions,
  formatDistributionOneLine,
  summarizeScoreDistribution
} from "../observer-score-distribution";

describe("summarizeScoreDistribution — empty / edge cases", () => {
  it("returns nulls for an empty input", () => {
    const d = summarizeScoreDistribution([]);
    expect(d.count).toBe(0);
    expect(d.min).toBeNull();
    expect(d.max).toBeNull();
    expect(d.mean).toBeNull();
    expect(d.median).toBeNull();
    expect(d.p25).toBeNull();
    expect(d.p75).toBeNull();
    expect(d.stddev).toBeNull();
    expect(d.belowFloorCount).toBe(0);
    // Histogram always has every bucket with count=0.
    expect(d.histogram).toHaveLength(SCORE_HISTOGRAM_BUCKETS.length);
    for (const b of d.histogram) expect(b.count).toBe(0);
  });

  it("filters out negative and non-finite inputs (defensive)", () => {
    const d = summarizeScoreDistribution([85, -1, NaN, Infinity, 80, 75]);
    expect(d.count).toBe(3);
    expect(d.min).toBe(75);
    expect(d.max).toBe(85);
  });

  it("clamps scores to [0, 100]", () => {
    const d = summarizeScoreDistribution([120, 95, -5, 50]);
    expect(d.min).toBe(50); // -5 filtered out
    expect(d.max).toBe(100); // 120 clamped
  });

  it("single-score input: median/p25/p75 all equal that score; stddev null", () => {
    const d = summarizeScoreDistribution([87]);
    expect(d.median).toBe(87);
    expect(d.p25).toBe(87);
    expect(d.p75).toBe(87);
    expect(d.stddev).toBeNull();
  });
});

describe("summarizeScoreDistribution — known statistics", () => {
  it("computes min/max/mean/median for a simple 5-score input", () => {
    const d = summarizeScoreDistribution([60, 70, 80, 90, 100]);
    expect(d.count).toBe(5);
    expect(d.min).toBe(60);
    expect(d.max).toBe(100);
    expect(d.mean).toBe(80);
    expect(d.median).toBe(80);
  });

  it("computes percentiles using linear interpolation (numpy default)", () => {
    // Sorted: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    // n=10 → p25 lands between index 2.25 → 30 + 0.25*(40-30) = 32.5
    // p75 lands between 6.75 → 70 + 0.75*(80-70) = 77.5
    const d = summarizeScoreDistribution([
      10, 20, 30, 40, 50, 60, 70, 80, 90, 100
    ]);
    expect(d.p25).toBeCloseTo(32.5, 2);
    expect(d.p75).toBeCloseTo(77.5, 2);
  });

  it("counts how many scores fell below the 50-point floor", () => {
    const d = summarizeScoreDistribution([10, 30, 49, 50, 80, 90]);
    expect(d.belowFloorCount).toBe(3);
  });

  it("computes population stddev for [60,70,80,90,100] → 14.142...", () => {
    // mean=80; variance = (400+100+0+100+400)/5 = 200; stddev = √200 ≈ 14.14
    const d = summarizeScoreDistribution([60, 70, 80, 90, 100]);
    expect(d.stddev).toBeCloseTo(14.14, 1);
  });

  it("builds histogram counts that sum to count", () => {
    const scores = [
      30,
      45, // 0-49
      50,
      55, // 50-59
      60,
      65,
      68, // 60-69
      75, // 70-79
      80,
      85,
      88, // 80-89
      92,
      100 // 90-100
    ];
    const d = summarizeScoreDistribution(scores);
    expect(d.histogram[0].count).toBe(2); // 0-49
    expect(d.histogram[1].count).toBe(2); // 50-59
    expect(d.histogram[2].count).toBe(3); // 60-69
    expect(d.histogram[3].count).toBe(1); // 70-79
    expect(d.histogram[4].count).toBe(3); // 80-89
    expect(d.histogram[5].count).toBe(2); // 90-100
    expect(d.histogram.reduce((acc, b) => acc + b.count, 0)).toBe(d.count);
  });
});

describe("compareDistributions", () => {
  it("returns 'improving' when newer median > older by >0.5", () => {
    const older = summarizeScoreDistribution([70, 75, 80, 85]);
    const newer = summarizeScoreDistribution([80, 85, 90, 95]);
    const r = compareDistributions(older, newer);
    expect(r.trend).toBe("improving");
    expect(r.medianDelta).not.toBeNull();
    expect(r.medianDelta!).toBeGreaterThan(0);
  });

  it("returns 'declining' when newer median < older by >0.5", () => {
    const older = summarizeScoreDistribution([80, 85, 90, 95]);
    const newer = summarizeScoreDistribution([70, 75, 80, 85]);
    expect(compareDistributions(older, newer).trend).toBe("declining");
  });

  it("returns 'flat' for a ≤0.5 median delta", () => {
    const a = summarizeScoreDistribution([80, 82, 85, 88]);
    const b = summarizeScoreDistribution([80, 83, 85, 87]);
    expect(compareDistributions(a, b).trend).toBe("flat");
  });

  it("returns 'unknown' when either side has zero data", () => {
    const empty = summarizeScoreDistribution([]);
    const full = summarizeScoreDistribution([80, 85, 90]);
    expect(compareDistributions(empty, full).trend).toBe("unknown");
    expect(compareDistributions(full, empty).trend).toBe("unknown");
  });
});

describe("formatDistributionOneLine", () => {
  it("formats the empty-window case", () => {
    expect(formatDistributionOneLine(summarizeScoreDistribution([]))).toBe(
      "Score distribution: no completed articles in window."
    );
  });

  it("formats a populated window with all key stats", () => {
    const line = formatDistributionOneLine(
      summarizeScoreDistribution([60, 70, 80, 90, 100])
    );
    expect(line).toContain("n=5");
    expect(line).toContain("median=80");
    expect(line).toContain("min=60");
    expect(line).toContain("max=100");
  });

  it("calls out below-floor count when nonzero", () => {
    const line = formatDistributionOneLine(
      summarizeScoreDistribution([30, 45, 80, 90])
    );
    expect(line).toContain("2 below 50-point floor");
  });

  it("hides the below-floor callout when zero", () => {
    const line = formatDistributionOneLine(
      summarizeScoreDistribution([60, 70, 80, 90])
    );
    expect(line).not.toContain("below 50-point floor");
  });
});

describe("operator scenario: 50 articles, median 85, 3 below floor", () => {
  // Fixture: 3 × 40 (below floor) + 10 × 70 + 20 × 85 + 17 × 95 = 50.
  // Sorted indices 24 and 25 both fall inside the 20×85 run, so the
  // linear-interp median is exactly 85.
  it("matches the format expected by the Observer-tick consumer", () => {
    const scores: number[] = [];
    for (let i = 0; i < 3; i++) scores.push(40); // below floor
    for (let i = 0; i < 10; i++) scores.push(70);
    for (let i = 0; i < 20; i++) scores.push(85);
    for (let i = 0; i < 17; i++) scores.push(95);
    const d = summarizeScoreDistribution(scores);
    expect(d.count).toBe(50);
    expect(d.belowFloorCount).toBe(3);
    expect(d.median).toBe(85);
    const line = formatDistributionOneLine(d);
    expect(line).toContain("n=50");
    expect(line).toContain("median=85");
    expect(line).toContain("3 below 50-point floor");
  });
});
