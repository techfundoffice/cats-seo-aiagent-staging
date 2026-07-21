import { describe, expect, it } from "vitest";
import { MAX_ABORT_TIMEOUT_MS, clampAbortTimeoutMs } from "../http-utils";

describe("clampAbortTimeoutMs", () => {
  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
    ["fractional zero", 0.9]
  ])("returns undefined for %s input", (_label, input) => {
    expect(clampAbortTimeoutMs(input)).toBeUndefined();
  });

  it.each([
    ["small integer", 1, 1],
    ["positive fraction", 100.9, 100],
    ["max uint32", MAX_ABORT_TIMEOUT_MS, MAX_ABORT_TIMEOUT_MS],
    [
      "values above max uint32",
      MAX_ABORT_TIMEOUT_MS + 1_000,
      MAX_ABORT_TIMEOUT_MS
    ]
  ])("normalizes %s", (_label, input, expected) => {
    expect(clampAbortTimeoutMs(input)).toBe(expected);
  });

  it("ignores non-number runtime input", () => {
    expect(clampAbortTimeoutMs(null as unknown as number)).toBeUndefined();
    expect(clampAbortTimeoutMs("250" as unknown as number)).toBeUndefined();
  });
});
