import { describe, expect, it } from "vitest";
import {
  estimateCompetitorOverlapPercent,
  stripHtmlToPlainText
} from "../plagiarism-overlap";

describe("stripHtmlToPlainText", () => {
  it("removes script blocks entirely", () => {
    const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
    expect(stripHtmlToPlainText(html)).toBe("Hello World");
  });

  it("removes style blocks entirely", () => {
    const html = "<p>Hello</p><style>body{color:red}</style><p>World</p>";
    expect(stripHtmlToPlainText(html)).toBe("Hello World");
  });

  it("replaces remaining HTML tags with spaces and collapses whitespace", () => {
    expect(stripHtmlToPlainText("<h1>Title</h1><p>Body text</p>")).toBe(
      "Title Body text"
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripHtmlToPlainText("  <p>  text  </p>  ")).toBe("text");
  });

  it("does NOT decode HTML entities", () => {
    expect(stripHtmlToPlainText("<p>cats &amp; dogs</p>")).toBe(
      "cats &amp; dogs"
    );
  });

  it("returns empty string for empty input", () => {
    expect(stripHtmlToPlainText("")).toBe("");
  });

  it("returns plain text unchanged when there are no HTML tags", () => {
    expect(stripHtmlToPlainText("plain text here")).toBe("plain text here");
  });
});

describe("estimateCompetitorOverlapPercent", () => {
  it("returns 0 for empty article", () => {
    expect(estimateCompetitorOverlapPercent("", "some reference text")).toBe(0);
  });

  it("returns 0 for empty reference", () => {
    expect(estimateCompetitorOverlapPercent("some article text", "")).toBe(0);
  });

  it("returns 0 when article is shorter than the window size", () => {
    // Default window is 6; only 3 words here.
    expect(
      estimateCompetitorOverlapPercent("one two three", "one two three")
    ).toBe(0);
  });

  it("returns 0 when reference is shorter than the window size", () => {
    expect(
      estimateCompetitorOverlapPercent("a b c d e f g h i j", "one two three")
    ).toBe(0);
  });

  it("returns 100 when article equals reference (identical text)", () => {
    const text = "the cat sat on the mat and looked around carefully";
    expect(estimateCompetitorOverlapPercent(text, text)).toBe(100);
  });

  it("returns 0 for completely different texts of adequate length", () => {
    const article = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const ref = "one two three four five six seven eight nine ten eleven";
    expect(estimateCompetitorOverlapPercent(article, ref)).toBe(0);
  });

  it("returns proportional overlap for partial match", () => {
    // First 6 words of article match reference; second 6 do not.
    const sharedPhrase = "the quick brown fox jumped over";
    const uniquePhrase = "alpha beta gamma delta epsilon zeta";
    const article = `${sharedPhrase} ${uniquePhrase}`;
    const ref = `${sharedPhrase} and some other content here`;
    // 2 windows from article: [0..5] matches, [1..6] does not → ~50%
    const pct = estimateCompetitorOverlapPercent(article, ref);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
  });

  it("strips HTML tags from the article before comparison", () => {
    const plain = "the cat sat on the mat and looked around carefully";
    const html = `<p>${plain}</p>`;
    expect(estimateCompetitorOverlapPercent(html, plain)).toBe(100);
  });

  it("respects a custom windowWords parameter", () => {
    // With window=2 every pair of adjacent words can match.
    const text = "cat sat on mat";
    expect(estimateCompetitorOverlapPercent(text, text, 2)).toBe(100);
  });

  it("result is always clamped to 0–100", () => {
    const text = "the cat sat on the mat and looked around carefully";
    const pct = estimateCompetitorOverlapPercent(text, text);
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
  });
});
