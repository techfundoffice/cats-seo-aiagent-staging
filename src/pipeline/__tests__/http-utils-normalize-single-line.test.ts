import { describe, expect, it } from "vitest";
import { normalizeSingleLine } from "../http-utils";

describe("normalizeSingleLine", () => {
  it("collapses internal whitespace and trims strings", () => {
    expect(normalizeSingleLine("  hello\t\nworld   ")).toBe("hello world");
  });

  it("returns an empty string for nullish input", () => {
    expect(normalizeSingleLine(null)).toBe("");
    expect(normalizeSingleLine(undefined)).toBe("");
  });

  it("coerces non-string input via String before normalizing", () => {
    expect(normalizeSingleLine(42)).toBe("42");
    expect(
      normalizeSingleLine({
        toString() {
          return "  cat\t dispenser  ";
        }
      })
    ).toBe("cat dispenser");
  });

  it("returns an empty string when string coercion throws", () => {
    expect(
      normalizeSingleLine({
        [Symbol.toPrimitive]() {
          throw new Error("boom");
        }
      })
    ).toBe("");
  });
});
