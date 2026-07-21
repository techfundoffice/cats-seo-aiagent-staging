import { describe, expect, it } from "vitest";
import { calculateSEOScore } from "../seo-score";

// Stemming fallback for scorecard check id 41. Closes the false-fail
// gap from #4954: strict token matching false-failed natural-language
// intros that used singular forms when the keyword was plural, or
// vice versa. Per Chief Engineer direction (2026-05-30):
//   "Keyword 'best water fountain for senior cats' should pass an
//    intro that opens with 'Senior cats need...'"
// The stemmer strips common English inflections (s, es, ies, ing, ed)
// so morphologically-varied intros pass while strict-literal matches
// continue to pass unchanged.

const make = (intro: string) =>
  `<html><body>` +
  `<h1>X</h1><h2>A</h2><h2>B</h2><h2>C</h2>` +
  `<p>${intro} ${"Body content. ".repeat(200)} conclusion</p>` +
  `</body></html>`;

const findCheck = (html: string, keyword: string) => {
  const r = calculateSEOScore(html, keyword, "Title", "", 1000);
  return r.checks.find((c) => c.id === 41)!;
};

describe("scorecard 41 — stemming fallback", () => {
  it("keyword 'fountains' (plural) matches intro 'fountain' (singular)", () => {
    // Significant tokens: ["fountains", "senior", "cats"] — need ≥2.
    // Intro has "fountain" (via stem of "fountains") + "senior" + "cats" → 3/3.
    const c = findCheck(
      make("Senior cats and the right cat fountain — what we tested."),
      "best cat fountains for senior cats"
    );
    expect(c.passed).toBe(true);
    expect(c.detail).toMatch(/3\/3/);
  });

  it("keyword 'feeders' matches intro 'feeder'", () => {
    // Significant tokens: ["feeders", "automatic", "cats"] — need ≥2.
    // Intro has "feeder" (stem of "feeders") + "automatic" + "cats" → 3/3.
    const c = findCheck(
      make(
        "An automatic feeder gives cats consistent meals when you're away from home."
      ),
      "best automatic feeders for cats"
    );
    expect(c.passed).toBe(true);
    expect(c.detail).toMatch(/3\/3/);
  });

  it("keyword 'fountain' (singular) still matches intro 'fountains' (plural) via stem-substring", () => {
    // Significant tokens: ["fountain", "senior", "cats"] — need ≥2.
    // Intro has "fountains" (contains stem "fountain") + "senior" + "cats" → 3/3.
    const c = findCheck(
      make("Senior cats prefer quieter fountains — here is what we found."),
      "best cat fountain for senior cats"
    );
    expect(c.passed).toBe(true);
  });

  it("keyword 'scratching' matches intro 'scratcher' via -ing stem", () => {
    const c = findCheck(
      make("Tall scratcher posts dampen aggressive clawing for most cats."),
      "best cat scratching posts"
    );
    expect(c.passed).toBe(true);
  });

  it("the canonical 'senior cats need...' brief example passes", () => {
    const c = findCheck(
      make(
        "Senior cats need a quiet, gentle fountain that suits their slower drinking pace."
      ),
      "best water fountain for senior cats"
    );
    expect(c.passed).toBe(true);
  });

  it("strict literal match still passes (no regression)", () => {
    const c = findCheck(
      make(
        "Best cat fountains for senior cats with arthritis — our picks ranked."
      ),
      "best cat fountains for senior cats"
    );
    expect(c.passed).toBe(true);
  });

  it("genuine miss (no stem/literal match) still fails", () => {
    const c = findCheck(
      make("Today we look at toys for kittens that prefer puzzle play."),
      "best cat fountains for senior cats"
    );
    expect(c.passed).toBe(false);
  });

  it("very short token (< 5 chars) is NOT stemmed (avoids 'cats'→'cat'→'ca' over-match)", () => {
    // "cats" is 4 chars; stemmer requires ≥ 5 chars to attempt
    // suffix-stripping, so it stays "cats" and only matches "cats"
    // or substrings including "cats".
    const c = findCheck(
      make("Today we look at a single carry-cage for transport."), // "cage" doesn't contain "cats"
      "best cat fountains for senior cats"
    );
    // Significant tokens: "fountains" (stems → "fountain"), "senior",
    // "cats". Intro has none of them as substrings.
    expect(c.passed).toBe(false);
  });

  it("4-char keyword token requires LITERAL match (no stem applied)", () => {
    // Keyword "best cat tree" — significant tokens by the existing
    // filter are length ≥ 4 + non-stopword. "tree" is 4 chars; the
    // stemmer's ≥5 char floor keeps it literal. Intro must include
    // "tree" or a word containing "tree".
    const c = findCheck(
      make("Cat trees of every height for climbing."),
      "best cat tree"
    );
    // "trees" includes "tree" as substring → no relaxation needed; the
    // existing literal `intro.includes("tree")` already passes because
    // "trees" contains "tree".
    expect(c.passed).toBe(true);
  });
});

describe("scorecard 41 — invariant: strict matches continue to pass", () => {
  it("every keyword token literally in the intro → pass", () => {
    const c = findCheck(
      make("Quiet, efficient fountain selection guide for senior cats today."),
      "fountain senior cats"
    );
    expect(c.passed).toBe(true);
  });
});
