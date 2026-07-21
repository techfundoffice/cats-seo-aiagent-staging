import { describe, expect, it } from "vitest";
import { calculateSEOScore, getSeoScorecardCheckNames } from "../seo-score";

// Coverage for the two SERP-presentation checks added to the scorecard:
//   id 101: Title length 30–60 chars  (Google desktop title truncation ~60)
//   id 102: Meta description length 120–160 chars (Google desktop meta ~155)
// These were both previously missing — title had only a clickbait check,
// meta description was the parameter `_metaDescription` (unused). Live
// production averages SEO 93 but had ZERO signal on these two highest-
// CTR-impact tags. This suite locks the boundary semantics in.

const MIN_BODY_HTML =
  "<html><head></head><body>" +
  "<h1>Title</h1><h2>Section</h2><h2>Section 2</h2><h2>Section 3</h2>" +
  "<p>" +
  "x".repeat(2000) +
  " conclusion " +
  "</p></body></html>";

describe("scorecard check 101 — title length 30–60", () => {
  const findCheck = (title: string) => {
    const r = calculateSEOScore(MIN_BODY_HTML, "cats", title, "", 1000);
    return r.checks.find((c) => c.id === 101)!;
  };

  it("title at exactly 30 chars → pass (boundary)", () => {
    const t = "a".repeat(30);
    expect(findCheck(t).passed).toBe(true);
    expect(findCheck(t).detail).toContain("30 chars");
  });

  it("title at 29 chars → fail (one below floor)", () => {
    expect(findCheck("a".repeat(29)).passed).toBe(false);
  });

  it("title at 60 chars → pass (top of window)", () => {
    expect(findCheck("a".repeat(60)).passed).toBe(true);
  });

  it("title at 61 chars → fail (one over ceiling — would truncate in SERP)", () => {
    expect(findCheck("a".repeat(61)).passed).toBe(false);
  });

  it("title with leading/trailing whitespace doesn't count toward length", () => {
    const padded = "   " + "a".repeat(30) + "   ";
    expect(findCheck(padded).passed).toBe(true);
  });

  it("empty title → fail with sensible detail", () => {
    const c = findCheck("");
    expect(c.passed).toBe(false);
    expect(c.detail).toContain("0 chars");
  });
});

describe("scorecard check 102 — meta description length 120–160", () => {
  const findCheck = (meta: string) => {
    const r = calculateSEOScore(MIN_BODY_HTML, "cats", "Title", meta, 1000);
    return r.checks.find((c) => c.id === 102)!;
  };

  it("meta at 120 chars → pass (boundary)", () => {
    expect(findCheck("m".repeat(120)).passed).toBe(true);
  });

  it("meta at 119 chars → fail (one below floor)", () => {
    expect(findCheck("m".repeat(119)).passed).toBe(false);
  });

  it("meta at 160 chars → pass (top of window)", () => {
    expect(findCheck("m".repeat(160)).passed).toBe(true);
  });

  it("meta at 161 chars → fail (Google truncates beyond ~155-160)", () => {
    expect(findCheck("m".repeat(161)).passed).toBe(false);
  });

  it("missing/empty meta → fail with explicit 0 char detail", () => {
    const c = findCheck("");
    expect(c.passed).toBe(false);
    expect(c.detail).toContain("0 chars");
  });
});

describe("scorecard total — appending checks 101 + 102 keeps labels stable", () => {
  it("title + meta labels live at the expected positions", () => {
    const names = getSeoScorecardCheckNames();
    // count itself is asserted in seo-score-heading-hierarchy.test.ts
    // to keep ONE place that pins the total — this suite only pins the
    // positional labels for 101/102.
    expect(names[100]).toMatch(/Title length/);
    expect(names[101]).toMatch(/Meta description length/);
  });

  it("score still functions as 'passed count' (no cap regression)", () => {
    // With a clean 60-char title + 140-char meta, the two new checks add
    // 2 to whatever the baseline passes, capped by the total.
    const baselineTitle =
      "best cat fountains for senior cats 2026 buyers guide ok";
    const baselineMeta = "x".repeat(140);
    const out = calculateSEOScore(
      MIN_BODY_HTML,
      "cat fountains",
      baselineTitle,
      baselineMeta,
      1000
    );
    expect(out.checks.length).toBeGreaterThanOrEqual(102);
    expect(out.score).toBe(out.checks.filter((c) => c.passed).length);
  });
});
