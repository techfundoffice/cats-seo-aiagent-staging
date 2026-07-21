import { describe, expect, it } from "vitest";
import { classifyEditorialOutcome } from "../editorial-outcome";

// Truth-table coverage for the editorial step-4 decision. This locks in
// the attribution fix from PR #4776: a Kimi infrastructure failure must
// surface as a `fail` outcome (so editorial-stats and the dashboard show
// the truth) rather than getting silently bucketed as `skipped:
// no-actionable-fixes` like the 75 articles caught in this session.
//
// Eight relevant rows (applyFix × kimi-state × fixesCount):
//
//   applyFix | textKimiFailed | visualKimiFailed | fixesCount | kind     | reason
//   ---------|----------------|------------------|------------|----------|---------------------------
//   false    | *              | *                | *          | skipped  | applyFix=false
//   true     | true           | true             | 0          | fail     | kimi-audit-unavailable
//   true     | true           | false            | 0          | skipped  | kimi-audit-partial-fail
//   true     | false          | true             | 0          | skipped  | kimi-audit-partial-fail
//   true     | false          | false            | 0          | skipped  | no-actionable-fixes
//   true     | *              | *                | >0         | rewrite  | actionable-fixes-found

describe("classifyEditorialOutcome — applyFix=false short-circuit", () => {
  it.each([
    [false, false, 0],
    [false, false, 7],
    [true, true, 0],
    [true, true, 7],
    [false, true, 0],
    [true, false, 3]
  ])(
    "applyFix=false, textFailed=%s, visualFailed=%s, fixes=%s → skipped/applyFix=false",
    (textKimiFailed, visualKimiFailed, fixesCount) => {
      const out = classifyEditorialOutcome({
        applyFix: false,
        textKimiFailed,
        visualKimiFailed,
        fixesCount
      });
      expect(out.kind).toBe("skipped");
      expect(out.reason).toBe("applyFix=false");
      expect(out.logLevel).toBe("info");
    }
  );
});

describe("classifyEditorialOutcome — empty findings × Kimi state", () => {
  it("both audits failed → fail / kimi-audit-unavailable / error log", () => {
    const out = classifyEditorialOutcome({
      applyFix: true,
      textKimiFailed: true,
      visualKimiFailed: true,
      fixesCount: 0
    });
    expect(out.kind).toBe("fail");
    expect(out.reason).toBe("kimi-audit-unavailable");
    expect(out.logLevel).toBe("error");
    expect(out.logMessage).toMatch(/both text \+ visual audits failed/i);
  });

  it("only text audit failed → skipped / kimi-audit-partial-fail / warning", () => {
    const out = classifyEditorialOutcome({
      applyFix: true,
      textKimiFailed: true,
      visualKimiFailed: false,
      fixesCount: 0
    });
    expect(out.kind).toBe("skipped");
    expect(out.reason).toBe("kimi-audit-partial-fail");
    expect(out.logLevel).toBe("warning");
    expect(out.logMessage).toMatch(/text:true visual:false/);
  });

  it("only visual audit failed → skipped / kimi-audit-partial-fail / warning", () => {
    const out = classifyEditorialOutcome({
      applyFix: true,
      textKimiFailed: false,
      visualKimiFailed: true,
      fixesCount: 0
    });
    expect(out.kind).toBe("skipped");
    expect(out.reason).toBe("kimi-audit-partial-fail");
    expect(out.logLevel).toBe("warning");
    expect(out.logMessage).toMatch(/text:false visual:true/);
  });

  it("both audits succeeded with 0 findings → skipped / no-actionable-fixes / info", () => {
    const out = classifyEditorialOutcome({
      applyFix: true,
      textKimiFailed: false,
      visualKimiFailed: false,
      fixesCount: 0
    });
    expect(out.kind).toBe("skipped");
    expect(out.reason).toBe("no-actionable-fixes");
    expect(out.logLevel).toBe("info");
    expect(out.logMessage).toMatch(/already meets bar/i);
  });
});

describe("classifyEditorialOutcome — non-empty findings → rewrite", () => {
  it.each([
    [false, false, 1],
    [false, false, 7],
    [true, false, 3],
    [false, true, 4],
    [true, true, 5]
  ])(
    "applyFix=true, textFailed=%s, visualFailed=%s, fixes=%s → rewrite",
    (textKimiFailed, visualKimiFailed, fixesCount) => {
      const out = classifyEditorialOutcome({
        applyFix: true,
        textKimiFailed,
        visualKimiFailed,
        fixesCount
      });
      expect(out.kind).toBe("rewrite");
      expect(out.reason).toBe("actionable-fixes-found");
      expect(out.logLevel).toBe("info");
      expect(out.logMessage).toMatch(new RegExp(`${fixesCount} fixes`));
    }
  );
});

describe("classifyEditorialOutcome — historical regression guard", () => {
  it("never returns 'no-actionable-fixes' when any Kimi failure occurred", () => {
    // The exact silent-failure attribution bug this fixed. If a future
    // edit accidentally re-introduces the old behavior, this test fires.
    const cases = [
      { textKimiFailed: true, visualKimiFailed: true },
      { textKimiFailed: true, visualKimiFailed: false },
      { textKimiFailed: false, visualKimiFailed: true }
    ] as const;
    for (const c of cases) {
      const out = classifyEditorialOutcome({
        applyFix: true,
        fixesCount: 0,
        ...c
      });
      expect(out.reason).not.toBe("no-actionable-fixes");
    }
  });

  it("never returns 'fail' for a genuinely clean run (no Kimi failures, 0 findings)", () => {
    const out = classifyEditorialOutcome({
      applyFix: true,
      textKimiFailed: false,
      visualKimiFailed: false,
      fixesCount: 0
    });
    expect(out.kind).not.toBe("fail");
  });
});
