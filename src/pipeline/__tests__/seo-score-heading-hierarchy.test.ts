import { describe, expect, it } from "vitest";
import { calculateSEOScore, getSeoScorecardCheckNames } from "../seo-score";

// Scorecard checks 103 + 104 — heading hierarchy.
//   id 103: Exactly one <h1> (the canonical page topic)
//   id 104: No skipped heading level (H1 → H3 with no H2 between)
// Both are core SEO + a11y signals that were not covered before.

const wrap = (body: string) =>
  `<html><head></head><body>${body}<p>${"x".repeat(2000)} conclusion</p></body></html>`;

const findCheck = (id: number, body: string) => {
  const r = calculateSEOScore(wrap(body), "cats", "Title", "", 1000);
  return r.checks.find((c) => c.id === id)!;
};

describe("scorecard check 103 — exactly one H1", () => {
  it("0 H1 → fail", () => {
    const c = findCheck(103, `<h2>A</h2><h2>B</h2><h2>C</h2>`);
    expect(c.passed).toBe(false);
    expect(c.detail).toContain("0 <h1>");
  });

  it("1 H1 → pass", () => {
    const c = findCheck(103, `<h1>Topic</h1><h2>A</h2><h2>B</h2><h2>C</h2>`);
    expect(c.passed).toBe(true);
    expect(c.detail).toContain("1 <h1>");
  });

  it("2 H1s → fail (split topical signal)", () => {
    const c = findCheck(
      103,
      `<h1>Topic A</h1><h1>Topic B</h1><h2>x</h2><h2>y</h2><h2>z</h2>`
    );
    expect(c.passed).toBe(false);
    expect(c.detail).toContain("2 <h1>");
  });

  it("case-insensitive: <H1> uppercase counts", () => {
    const c = findCheck(103, `<H1>Topic</H1><h2>A</h2><h2>B</h2><h2>C</h2>`);
    expect(c.passed).toBe(true);
  });

  it("h1 with attributes counts", () => {
    const c = findCheck(
      103,
      `<h1 id="title" class="hero">Topic</h1><h2>A</h2><h2>B</h2><h2>C</h2>`
    );
    expect(c.passed).toBe(true);
  });
});

describe("scorecard check 104 — no skipped heading levels", () => {
  it("clean H1 → H2 → H3 → pass", () => {
    const c = findCheck(
      104,
      `<h1>X</h1><h2>A</h2><h3>A1</h3><h2>B</h2><h3>B1</h3><h2>C</h2>`
    );
    expect(c.passed).toBe(true);
    expect(c.detail).toMatch(/no skips/);
  });

  it("H1 → H3 skipping H2 → fail (the classic skipped-level bug)", () => {
    const c = findCheck(104, `<h1>X</h1><h3>A</h3><h3>B</h3><h2>C</h2>`);
    expect(c.passed).toBe(false);
    expect(c.detail).toContain("skipped level");
    expect(c.detail).toContain("[1,3");
  });

  it("H2 → H4 skipping H3 → fail", () => {
    const c = findCheck(
      104,
      `<h1>X</h1><h2>A</h2><h4>A1</h4><h2>B</h2><h2>C</h2>`
    );
    expect(c.passed).toBe(false);
  });

  it("backwards-walk (H3 → H2) is fine (closing a subsection)", () => {
    const c = findCheck(
      104,
      `<h1>X</h1><h2>A</h2><h3>A1</h3><h2>B</h2><h2>C</h2>`
    );
    expect(c.passed).toBe(true);
  });

  it("zero headings → fail (the empty-document case)", () => {
    const c = findCheck(104, "");
    expect(c.passed).toBe(false);
  });

  it("only H1 → pass (single-heading article is technically valid)", () => {
    // calculateSEOScore other checks may fail, but THIS check passes
    const c = findCheck(104, `<h1>X</h1>`);
    expect(c.passed).toBe(true);
  });
});

describe("scorecard total count — stable label ordering for 103+", () => {
  it("getSeoScorecardCheckNames preserves positional labels 102/103/104", () => {
    const names = getSeoScorecardCheckNames();
    // The total grows as new checks land — assert the per-positional
    // invariants here rather than pinning the count, which would force
    // every PR that adds a check to update this test.
    expect(names.length).toBeGreaterThanOrEqual(104);
    expect(names[102]).toMatch(/Exactly one H1/);
    expect(names[103]).toMatch(/Heading hierarchy/);
  });
});
