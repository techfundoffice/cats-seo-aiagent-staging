import { describe, expect, it } from "vitest";
import { __testHelpers } from "../dataforseo-ranked-keywords";

const { normalizeRankedKeywordTarget } = __testHelpers;

describe("normalizeRankedKeywordTarget", () => {
  it("strips protocol, query string, and hash from a full HTTPS URL", () => {
    expect(
      normalizeRankedKeywordTarget(
        "https://catsluvus.com/cat-window-perches/best-perch?utm_source=test#section"
      )
    ).toBe("catsluvus.com/cat-window-perches/best-perch");
  });

  it("strips trailing slash", () => {
    expect(
      normalizeRankedKeywordTarget("https://catsluvus.com/cat-window-perches/")
    ).toBe("catsluvus.com/cat-window-perches");
  });

  it("passes through a bare hostname+path without a protocol", () => {
    expect(
      normalizeRankedKeywordTarget(
        "catsluvus.com/cat-window-perches/best-perch"
      )
    ).toBe("catsluvus.com/cat-window-perches/best-perch");
  });

  it("strips query string from a bare hostname+path", () => {
    expect(
      normalizeRankedKeywordTarget(
        "catsluvus.com/cat-window-perches/best-perch?q=foo"
      )
    ).toBe("catsluvus.com/cat-window-perches/best-perch");
  });

  it("handles an HTTP URL the same as HTTPS", () => {
    expect(
      normalizeRankedKeywordTarget(
        "http://catsluvus.com/cat-window-perches/best-perch"
      )
    ).toBe("catsluvus.com/cat-window-perches/best-perch");
  });

  it("returns empty string for an empty input", () => {
    expect(normalizeRankedKeywordTarget("")).toBe("");
  });

  it("returns empty string for a whitespace-only input", () => {
    expect(normalizeRankedKeywordTarget("   ")).toBe("");
  });

  it("handles a bare domain with no path", () => {
    expect(normalizeRankedKeywordTarget("catsluvus.com")).toBe("catsluvus.com");
  });

  it("trims leading/trailing whitespace before normalizing", () => {
    expect(
      normalizeRankedKeywordTarget(
        "  https://catsluvus.com/cat-window-perches/best-perch  "
      )
    ).toBe("catsluvus.com/cat-window-perches/best-perch");
  });
});
