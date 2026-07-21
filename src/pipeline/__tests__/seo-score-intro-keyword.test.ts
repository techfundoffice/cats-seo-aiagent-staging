import { describe, expect, it } from "vitest";
import { calculateSEOScore } from "../seo-score";

// Strengthened scorecard check id 41 ("Keyword tokens in first 100
// words"). Previously: passed if just the FIRST keyword word appeared
// in the intro — a trivial pass for keywords starting with stopwords
// like "best" or "top". Now: requires ≥ half of the SIGNIFICANT
// keyword tokens (length ≥ 4, stopword-filtered) to appear in the
// first 100 words. Matches how Google evaluates the head signal.

const make = (
  introText: string,
  rest: string = "Body content here. ".repeat(200)
) =>
  `<html><body><h1>X</h1><h2>A</h2><h2>B</h2><h2>C</h2>` +
  `<p>${introText} ${rest}</p>` +
  `</body></html>`;

const findCheck = (html: string, keyword: string) => {
  const r = calculateSEOScore(html, keyword, "Title", "", 1000);
  return r.checks.find((c) => c.id === 41)!;
};

describe("scorecard check 41 — strengthened intro keyword coverage", () => {
  it("intro mentions ALL significant tokens → pass", () => {
    const c = findCheck(
      make(
        "Our guide to the best cat fountains for senior cats with arthritis."
      ),
      "best cat fountains for senior cats"
    );
    expect(c.passed).toBe(true);
    expect(c.detail).toMatch(/significant tokens/);
  });

  it("intro mentions HALF of significant tokens → pass (floor)", () => {
    // significant tokens (≥4 chars, not stopword): "fountains", "senior", "cats" → 3
    // intro mentions "fountains" + "senior" = 2/3 (need ceil(3/2)=2) → pass
    const c = findCheck(
      make("Our fountains roundup for senior felines."),
      "best cat fountains for senior cats"
    );
    expect(c.passed).toBe(true);
  });

  it("intro mentions only stopwords from the keyword → fail (the prior-bug regression guard)", () => {
    // Keyword "best cat fountains for senior cats" — stopwords stripped:
    // {fountains, senior, cats}. Intro only has "best" + "guide" + "the".
    // Old check (first word "best") would have passed; new check fails.
    const c = findCheck(
      make("Our guide to the best products for the home."),
      "best cat fountains for senior cats"
    );
    expect(c.passed).toBe(false);
  });

  it("intro mentions one significant token of three → fail (below half threshold)", () => {
    // significant tokens: {fountains, senior, cats}. Intro has only "cats".
    // 1/3 < ceil(3/2)=2 → fail
    const c = findCheck(
      make("Our guide for cats."),
      "best cat fountains for senior cats"
    );
    expect(c.passed).toBe(false);
  });

  it("single-token keyword: 1/1 hit → pass", () => {
    const c = findCheck(
      make("Fountains tested across many homes."),
      "fountains"
    );
    expect(c.passed).toBe(true);
  });

  it("single-token keyword: 0/1 hit → fail", () => {
    const c = findCheck(make("Cats tested across many homes."), "fountains");
    expect(c.passed).toBe(false);
  });

  it("all-stopword keyword → falls back to first-word check (no guaranteed-fail)", () => {
    // Edge case: a degenerate keyword that's all stopwords. The
    // fallback prevents a guaranteed-fail by reverting to the prior
    // first-word check.
    const c = findCheck(make("The best guide for cats."), "best top guide");
    expect(c.passed).toBe(true);
    expect(c.detail).toContain("fallback");
  });

  it("case-insensitive matching", () => {
    const c = findCheck(
      make("OUR FOUNTAINS roundup for Senior FELINES."),
      "best cat fountains for senior cats"
    );
    expect(c.passed).toBe(true);
  });

  it("detail line reports the actual count + target", () => {
    const c = findCheck(
      make("Fountains tested for senior cats."),
      "best cat fountains for senior cats"
    );
    // 3 significant tokens, target ceil(3/2)=2, hits = 3
    expect(c.detail).toContain("3/3");
    expect(c.detail).toContain("need 2");
  });
});
