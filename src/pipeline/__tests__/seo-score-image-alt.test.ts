import { describe, expect, it } from "vitest";
import { calculateSEOScore } from "../seo-score";

// Tightened image-alt check (id 88). Previously a SINGLE descriptive
// alt anywhere in the doc passed the check — articles with 1 good
// image and 19 alt-less ones scored "pass". Now every <img> must
// have alt, AND each alt is either empty (decorative best-practice)
// or ≥5 chars. Property: a real image-search a11y regression
// (missing/lazy alt anywhere) MUST surface as a failed check.

const wrap = (body: string) =>
  `<html><head></head><body><h1>X</h1>` +
  // pad with H2s so other checks don't fail spuriously
  `<h2>A</h2><h2>B</h2><h2>C</h2>` +
  `<p>${"x".repeat(2000)} conclusion</p>` +
  body +
  `</body></html>`;

const altCheck = (body: string) => {
  const r = calculateSEOScore(wrap(body), "cats", "Title", "", 1000);
  return r.checks.find((c) => c.id === 88)!;
};

describe("scorecard check 88 — image alt-text tightened", () => {
  it("zero images → fail", () => {
    const c = altCheck("");
    expect(c.passed).toBe(false);
    expect(c.detail).toContain("0 <img>");
  });

  it("every image has good alt → pass", () => {
    const c = altCheck(
      `<img src="a.jpg" alt="orange tabby drinking from a fountain">` +
        `<img src="b.jpg" alt="cat sitting on a windowsill at dusk">`
    );
    expect(c.passed).toBe(true);
    expect(c.detail).toMatch(/2 <img>/);
    expect(c.detail).toMatch(/0 missing alt/);
  });

  it("one image missing alt → fail (the exact bug the prior regex hid)", () => {
    const c = altCheck(
      `<img src="a.jpg" alt="descriptive alt text here">` + `<img src="b.jpg">` // missing alt
    );
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/1 missing alt/);
  });

  it("decorative alt='' is allowed (a11y best-practice)", () => {
    const c = altCheck(
      `<img src="hero.jpg" alt="">` +
        `<img src="diagram.jpg" alt="comparison of feeder capacities">`
    );
    expect(c.passed).toBe(true);
  });

  it("lazy alt (1–4 chars) fails", () => {
    const c = altCheck(
      `<img src="a.jpg" alt="cat">` + // 3 chars
        `<img src="b.jpg" alt="x">` // 1 char
    );
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/2 lazy alt/);
  });

  it("mixed: 1 good, 1 missing, 1 lazy → fail with both counts", () => {
    const c = altCheck(
      `<img src="a.jpg" alt="orange tabby drinking from a fountain">` +
        `<img src="b.jpg">` +
        `<img src="c.jpg" alt="cat">`
    );
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/1 missing alt/);
    expect(c.detail).toMatch(/1 lazy alt/);
  });

  it("self-closing <img/> with alt is matched", () => {
    const c = altCheck(`<img src="a.jpg" alt="descriptive enough" />`);
    expect(c.passed).toBe(true);
  });

  it("case-insensitive ALT attribute is matched", () => {
    const c = altCheck(`<img src="a.jpg" ALT="descriptive enough">`);
    expect(c.passed).toBe(true);
  });
});
