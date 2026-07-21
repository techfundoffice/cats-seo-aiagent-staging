import { describe, expect, it } from "vitest";
import { calculateSEOScore } from "../seo-score";

// Scorecard check id 105 — internal links ≥3.
//
// Pairs with #4786 (cross-category back-link injection, which adds
// links INTO this article from older siblings). This check validates
// the OUTBOUND side: every article should also link OUT to siblings.
// A degraded rewrite that strips the internal-links section ships
// with zero topical-depth signal — this check surfaces that.

const wrap = (body: string) =>
  `<html><head></head><body>` +
  `<h1>X</h1><h2>A</h2><h2>B</h2><h2>C</h2>` +
  `<p>${"x".repeat(2000)} conclusion</p>` +
  body +
  `</body></html>`;

const findCheck = (body: string) => {
  const r = calculateSEOScore(wrap(body), "cats", "Title", "", 1000);
  return r.checks.find((c) => c.id === 105)!;
};

describe("scorecard check 105 — internal links ≥3", () => {
  it("0 internal links → fail", () => {
    const c = findCheck("");
    expect(c.passed).toBe(false);
    expect(c.detail).toContain("0 internal link");
  });

  it("3 catsluvus.com links → pass", () => {
    const c = findCheck(
      `<a href="https://catsluvus.com/cat-fountains/x">x</a>` +
        `<a href="https://catsluvus.com/cat-litter/y">y</a>` +
        `<a href="https://catsluvus.com/cat-beds/z">z</a>`
    );
    expect(c.passed).toBe(true);
    expect(c.detail).toContain("3 internal link");
  });

  it("Root-relative paths (e.g. href='/x/y') also count as internal", () => {
    const c = findCheck(
      `<a href="/cat-fountains/x">x</a>` +
        `<a href="/cat-litter/y">y</a>` +
        `<a href="/cat-beds/z">z</a>`
    );
    expect(c.passed).toBe(true);
  });

  it("External links (other domains) do NOT count toward the threshold", () => {
    const c = findCheck(
      `<a href="https://example.com/x">x</a>` +
        `<a href="https://wikipedia.org/wiki/cat">wiki</a>` +
        `<a href="https://catsluvus.com/y">internal-1</a>`
    );
    expect(c.passed).toBe(false);
    expect(c.detail).toContain("1 internal link");
  });

  it("Mixed www. and bare host both count as catsluvus.com internal", () => {
    const c = findCheck(
      `<a href="https://catsluvus.com/a">a</a>` +
        `<a href="https://www.catsluvus.com/b">b</a>` +
        `<a href="/c">c</a>`
    );
    expect(c.passed).toBe(true);
    expect(c.detail).toContain("3 internal link");
  });

  it("Case-insensitive HREF attribute matched", () => {
    const c = findCheck(
      `<a HREF="https://catsluvus.com/a">a</a>` +
        `<a Href="https://catsluvus.com/b">b</a>` +
        `<a href="https://catsluvus.com/c">c</a>`
    );
    expect(c.passed).toBe(true);
  });

  it("Just at the threshold (3) → pass; just below (2) → fail", () => {
    const two = findCheck(`<a href="/a">a</a><a href="/b">b</a>`);
    expect(two.passed).toBe(false);
    const three = findCheck(
      `<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>`
    );
    expect(three.passed).toBe(true);
  });
});
