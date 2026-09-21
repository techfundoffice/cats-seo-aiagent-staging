import { describe, expect, it } from "vitest";
import {
  classifyCtrExperiment,
  shouldRollbackSnippet,
  windowCtr,
  type CtrWindow
} from "../ctr-experiments";

const steady = { position: 8.4 };

describe("windowCtr", () => {
  it("derives CTR from clicks and impressions when none is supplied", () => {
    expect(windowCtr({ impressions: 1000, clicks: 25 })).toBeCloseTo(0.025, 6);
  });

  it("prefers an explicit fraction", () => {
    expect(windowCtr({ impressions: 1000, clicks: 25, ctr: 0.04 })).toBeCloseTo(
      0.04,
      6
    );
  });

  it("tolerates CTR handed over as a percentage", () => {
    expect(windowCtr({ impressions: 1000, clicks: 25, ctr: 4 })).toBeCloseTo(
      0.04,
      6
    );
  });

  it("returns zero rather than dividing by zero impressions", () => {
    expect(windowCtr({ impressions: 0, clicks: 0 })).toBe(0);
  });
});

describe("classifyCtrExperiment", () => {
  it("credits a real CTR rise at a steady position", () => {
    const before: CtrWindow = { impressions: 900, clicks: 9, ...steady };
    const after: CtrWindow = { impressions: 950, clicks: 38, ...steady };

    const verdict = classifyCtrExperiment(before, after);

    expect(verdict.outcome).toBe("improved");
    expect(verdict.ctrDelta).toBeGreaterThan(0);
    expect(verdict.detail).toMatch(/CTR rose/);
  });

  it("flags a rewrite that lost clicks", () => {
    const before: CtrWindow = { impressions: 900, clicks: 45, ...steady };
    const after: CtrWindow = { impressions: 950, clicks: 9, ...steady };

    const verdict = classifyCtrExperiment(before, after);

    expect(verdict.outcome).toBe("regressed");
    expect(verdict.ctrDelta).toBeLessThan(0);
  });

  it("refuses to judge on thin data", () => {
    const before: CtrWindow = { impressions: 900, clicks: 9, ...steady };
    const after: CtrWindow = { impressions: 12, clicks: 3, ...steady };

    const verdict = classifyCtrExperiment(before, after);

    // 25% vs 1% looks spectacular and means nothing at 12 impressions.
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.detail).toMatch(/too few impressions/);
  });

  it("does not credit the snippet when the page climbed the rankings", () => {
    const before: CtrWindow = { impressions: 900, clicks: 9, position: 11.2 };
    const after: CtrWindow = { impressions: 950, clicks: 60, position: 3.1 };

    const verdict = classifyCtrExperiment(before, after);

    expect(verdict.outcome).toBe("confounded");
    expect(verdict.detail).toMatch(/position rose/);
  });

  it("does not blame the snippet when the page slipped", () => {
    const before: CtrWindow = { impressions: 900, clicks: 60, position: 4.0 };
    const after: CtrWindow = { impressions: 950, clicks: 9, position: 14.5 };

    const verdict = classifyCtrExperiment(before, after);

    expect(verdict.outcome).toBe("confounded");
    expect(verdict.detail).toMatch(/position fell/);
  });

  it("treats a movement under the threshold as noise", () => {
    const before: CtrWindow = { impressions: 5000, clicks: 100, ...steady };
    const after: CtrWindow = { impressions: 5000, clicks: 110, ...steady };

    const verdict = classifyCtrExperiment(before, after);

    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.detail).toMatch(/under the/);
  });

  it("still judges when Search Console reported no position", () => {
    const before: CtrWindow = { impressions: 900, clicks: 9 };
    const after: CtrWindow = { impressions: 950, clicks: 38 };

    const verdict = classifyCtrExperiment(before, after);

    expect(verdict.outcome).toBe("improved");
    expect(verdict.positionDelta).toBe(0);
  });

  it("honours caller-supplied thresholds", () => {
    const before: CtrWindow = { impressions: 900, clicks: 90, ...steady };
    const after: CtrWindow = { impressions: 900, clicks: 99, ...steady };

    // 10.00% -> 11.00% is a 1pp move: a real change at the default 0.5pp
    // threshold, noise if the caller demands 2pp.
    expect(classifyCtrExperiment(before, after).outcome).toBe("improved");
    expect(
      classifyCtrExperiment(before, after, { minCtrDelta: 0.02 }).outcome
    ).toBe("inconclusive");
  });
});

describe("shouldRollbackSnippet", () => {
  const applied = "Best Automatic Litter Boxes: One Clear Winner";
  const original = "Best Automatic Litter Boxes of 2026";

  it("allows the rollback when our title is still the live one", () => {
    const decision = shouldRollbackSnippet({
      liveTitle: applied,
      appliedTitle: applied,
      originalTitle: original
    });

    expect(decision.rollback).toBe(true);
  });

  it("refuses when something edited the title after our rewrite", () => {
    // 28 days pass before a verdict; Editorial, QC and Polish all edit
    // pages in that window. Restoring here reverts their work, not ours.
    const decision = shouldRollbackSnippet({
      liveTitle: "A Human Wrote This Title By Hand",
      appliedTitle: applied,
      originalTitle: original
    });

    expect(decision).toEqual({
      rollback: false,
      reason:
        'live title has since changed to "A Human Wrote This Title By Hand"'
    });
  });

  it("refuses when the page is already back on the original", () => {
    const decision = shouldRollbackSnippet({
      liveTitle: original,
      appliedTitle: applied,
      originalTitle: original
    });

    expect(decision).toEqual({
      rollback: false,
      reason: "snippet already matches the original"
    });
  });

  it("refuses when there is nothing to restore to", () => {
    expect(
      shouldRollbackSnippet({
        liveTitle: applied,
        appliedTitle: applied,
        originalTitle: "   "
      })
    ).toEqual({ rollback: false, reason: "no recorded original title" });
  });

  it("refuses when the live page has no title at all", () => {
    expect(
      shouldRollbackSnippet({
        liveTitle: "",
        appliedTitle: applied,
        originalTitle: original
      })
    ).toEqual({
      rollback: false,
      reason: "live page has no title to compare"
    });
  });

  it("ignores surrounding whitespace when comparing", () => {
    expect(
      shouldRollbackSnippet({
        liveTitle: `  ${applied}  `,
        appliedTitle: applied,
        originalTitle: original
      }).rollback
    ).toBe(true);
  });
});
