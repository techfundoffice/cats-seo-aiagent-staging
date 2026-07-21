import { describe, expect, it } from "vitest";
import { calculateSEOScore } from "../seo-score";

// The editorial agent at writer.ts:536 rejects rewrites whose SEO
// score regressed by more than SEO_REGRESSION_CUSHION. As of
// 2026-05-30 the editorial loop is rejecting 97/133 (73%) of rewrite
// attempts on seo-regression. Operators couldn't tell WHICH scorecard
// checks were dropping — only the aggregate delta. This test pins the
// per-check diff logic so the editorial-agent log line stays
// actionable.

describe("seo-regression per-check diff — set arithmetic on check IDs", () => {
  it("produces an empty regressed-list when nothing newly fails", () => {
    const html = `<html><body><h1>X</h1><h2>A</h2><h2>B</h2><h2>C</h2><p>${"x".repeat(2000)} conclusion</p></body></html>`;
    const a = calculateSEOScore(html, "cats", "Title", "", 1000);
    const b = calculateSEOScore(html, "cats", "Title", "", 1000);
    const aFailed = new Set(a.checks.filter((c) => !c.passed).map((c) => c.id));
    const newRegressed = b.checks.filter(
      (c) => !c.passed && !aFailed.has(c.id)
    );
    expect(newRegressed).toHaveLength(0);
  });

  it("identifies the exact checks that flipped pass → fail", () => {
    // OLD: 3 H2s, 1 H1, has alt → most checks pass.
    const oldHtml =
      `<html><body>` +
      `<h1>Best Cat Fountains for Senior Cats 2026 Buying Guide</h1>` +
      `<h2>A</h2><h2>B</h2><h2>C</h2>` +
      `<p>${"x".repeat(2000)} conclusion senior cats fountains</p>` +
      `<img src="x.jpg" alt="a senior cat drinking from a fountain">` +
      `</body></html>`;
    // NEW: lost the H1 entirely → check 103 ("Exactly one H1") flips.
    const newHtml =
      `<html><body>` +
      `<h2>A</h2><h2>B</h2><h2>C</h2>` +
      `<p>${"x".repeat(2000)} conclusion senior cats fountains</p>` +
      `<img src="x.jpg" alt="a senior cat drinking from a fountain">` +
      `</body></html>`;
    const a = calculateSEOScore(
      oldHtml,
      "best cat fountains for senior cats",
      "Title",
      "",
      1000
    );
    const b = calculateSEOScore(
      newHtml,
      "best cat fountains for senior cats",
      "Title",
      "",
      1000
    );
    const aFailed = new Set(a.checks.filter((c) => !c.passed).map((c) => c.id));
    const newRegressed = b.checks
      .filter((c) => !c.passed && !aFailed.has(c.id))
      .map((c) => c.id);
    // Check 103 = "Exactly one H1" — must regress.
    expect(newRegressed).toContain(103);
  });

  it("does NOT report checks that were already failing in the OLD article", () => {
    // Both articles fail check 88 (no <img>). The new article ADDITIONALLY
    // loses check 103 (no <h1>). Only 103 should appear in regressed.
    const oldHtml =
      `<html><body>` +
      `<h1>X</h1><h2>A</h2><h2>B</h2><h2>C</h2>` +
      `<p>${"x".repeat(2000)} conclusion</p>` +
      `</body></html>`;
    const newHtml =
      `<html><body>` +
      `<h2>A</h2><h2>B</h2><h2>C</h2>` +
      `<p>${"x".repeat(2000)} conclusion</p>` +
      `</body></html>`;
    const a = calculateSEOScore(oldHtml, "cats", "Title", "", 1000);
    const b = calculateSEOScore(newHtml, "cats", "Title", "", 1000);
    const aFailed = new Set(a.checks.filter((c) => !c.passed).map((c) => c.id));
    const newRegressed = b.checks
      .filter((c) => !c.passed && !aFailed.has(c.id))
      .map((c) => c.id);
    expect(newRegressed).toContain(103);
    expect(newRegressed).not.toContain(88); // was already failing
  });
});
