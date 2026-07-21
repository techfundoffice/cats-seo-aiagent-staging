import { describe, expect, it } from "vitest";
import { topFailureReasons, topSkipReasons } from "../editorial-stats";
import type { EditorialStatRecord } from "../editorial-stats";

// Helpers to build minimal EditorialStatRecord fixtures without needing
// KV or async code.
function makeRecord(
  reasons: Record<string, number>,
  skipReasons?: Record<string, number>
): EditorialStatRecord {
  return {
    date: "2024-01-01",
    success: 0,
    fail: Object.values(reasons).reduce((a, b) => a + b, 0),
    skipped: skipReasons
      ? Object.values(skipReasons).reduce((a, b) => a + b, 0)
      : 0,
    reasons,
    skipReasons
  };
}

describe("topFailureReasons — empty / no-reasons cases", () => {
  it("returns [] for an empty records array", () => {
    expect(topFailureReasons([])).toEqual([]);
  });

  it("returns [] when all records have no reasons entries", () => {
    const records = [makeRecord({}), makeRecord({})];
    expect(topFailureReasons(records)).toEqual([]);
  });
});

describe("topFailureReasons — sorting and slicing", () => {
  it("returns reasons sorted by count descending", () => {
    const records = [
      makeRecord({ "seo-regression": 5, salvage: 2, "reference-voice": 8 })
    ];
    const result = topFailureReasons(records);
    expect(result[0]).toEqual({ reason: "reference-voice", count: 8 });
    expect(result[1]).toEqual({ reason: "seo-regression", count: 5 });
    expect(result[2]).toEqual({ reason: "salvage", count: 2 });
  });

  it("defaults to at most 3 items (n=3)", () => {
    const records = [makeRecord({ a: 10, b: 9, c: 8, d: 7, e: 6 })];
    expect(topFailureReasons(records)).toHaveLength(3);
  });

  it("respects a custom n parameter", () => {
    const records = [makeRecord({ a: 10, b: 9, c: 8, d: 7 })];
    expect(topFailureReasons(records, 2)).toHaveLength(2);
    expect(topFailureReasons(records, 5)).toHaveLength(4); // only 4 exist
  });

  it("returns fewer than n items when fewer reasons exist", () => {
    const records = [makeRecord({ only: 1 })];
    expect(topFailureReasons(records, 3)).toHaveLength(1);
  });
});

describe("topFailureReasons — merging across multiple records", () => {
  it("sums the same reason key across records", () => {
    const records = [
      makeRecord({ "reference-voice": 3 }),
      makeRecord({ "reference-voice": 7 }),
      makeRecord({ salvage: 2 })
    ];
    const result = topFailureReasons(records, 5);
    const rv = result.find((r) => r.reason === "reference-voice");
    expect(rv?.count).toBe(10);
    const sal = result.find((r) => r.reason === "salvage");
    expect(sal?.count).toBe(2);
  });

  it("places the merged winner at index 0", () => {
    const records = [
      makeRecord({ a: 1, b: 1, c: 1 }),
      makeRecord({ a: 1, b: 1 }),
      makeRecord({ a: 1 })
    ];
    const result = topFailureReasons(records);
    expect(result[0].reason).toBe("a");
    expect(result[0].count).toBe(3);
  });
});

describe("topSkipReasons — backward-compat with missing skipReasons", () => {
  it("returns [] for an empty records array", () => {
    expect(topSkipReasons([])).toEqual([]);
  });

  it("silently ignores records without a skipReasons field", () => {
    // Records written before skipReasons was introduced have no field.
    const legacy = {
      date: "2024-01-01",
      success: 1,
      fail: 0,
      skipped: 1,
      reasons: {}
      // skipReasons intentionally absent
    } as EditorialStatRecord;
    expect(topSkipReasons([legacy])).toEqual([]);
  });

  it("handles a mix of records with and without skipReasons", () => {
    const legacy = {
      date: "2024-01-01",
      success: 0,
      fail: 0,
      skipped: 1,
      reasons: {}
    } as EditorialStatRecord;
    const modern = makeRecord({}, { "no-actionable-fixes": 4 });
    const result = topSkipReasons([legacy, modern]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ reason: "no-actionable-fixes", count: 4 });
  });
});

describe("topSkipReasons — sorting and merging", () => {
  it("returns skip reasons sorted by count descending", () => {
    const records = [
      makeRecord(
        {},
        {
          "no-actionable-fixes": 6,
          "kimi-audit-partial-fail": 2,
          "applyFix=false": 9
        }
      )
    ];
    const result = topSkipReasons(records);
    expect(result[0]).toEqual({ reason: "applyFix=false", count: 9 });
    expect(result[1]).toEqual({ reason: "no-actionable-fixes", count: 6 });
    expect(result[2]).toEqual({ reason: "kimi-audit-partial-fail", count: 2 });
  });

  it("merges the same skip reason across records", () => {
    const records = [
      makeRecord({}, { "no-actionable-fixes": 3 }),
      makeRecord({}, { "no-actionable-fixes": 5, "applyFix=false": 1 })
    ];
    const result = topSkipReasons(records, 5);
    const naf = result.find((r) => r.reason === "no-actionable-fixes");
    expect(naf?.count).toBe(8);
  });

  it("respects a custom n parameter", () => {
    const records = [makeRecord({}, { a: 10, b: 9, c: 8, d: 7, e: 6 })];
    expect(topSkipReasons(records, 2)).toHaveLength(2);
  });
});
