import { describe, expect, it } from "vitest";
import { errStack } from "../http-utils";

describe("errStack", () => {
  it("returns empty string when maxLen is non-positive or non-finite", () => {
    const error = new Error("boom");
    error.stack = "stack-trace";

    expect(errStack(error, 0)).toBe("");
    expect(errStack(error, -1)).toBe("");
    expect(errStack(error, Number.POSITIVE_INFINITY)).toBe("");
    expect(errStack(error, Number.NaN)).toBe("");
  });

  it("truncates stack output using a normalized integer maxLen", () => {
    const error = new Error("boom");
    error.stack = "abcdef";

    expect(errStack(error, 3.9)).toBe("abc");
  });
});
