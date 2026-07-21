import { describe, expect, it } from "vitest";

// Pins the hard H1-count guard added to editorial-agent.ts's rewrite
// pipeline: "Exactly one H1" is a structural invariant, not a
// scorable-and-offsettable quality signal, so it's enforced unconditionally
// (independent of the `articleKeyword`-gated SEO-regression comparison)
// rather than folded into the net-score delta, where a duplicated article
// body could otherwise offset the one lost point by inflating volume-based
// checks (word count, keyword density, internal link count). Mirrors the
// inline regex at editorial-agent.ts (the hard H1-count guard block).

function countH1(html: string): number {
  return (html.match(/<h1\b/gi) || []).length;
}

const wrap = (body: string) =>
  `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;

describe("editorial H1-count guard", () => {
  it("passes a rewrite with exactly one H1", () => {
    expect(countH1(wrap("<h1>Best Cat Fountains</h1><p>hi</p>"))).toBe(1);
  });

  it("rejects a rewrite with zero H1 tags", () => {
    expect(countH1(wrap("<h2>Sub</h2><p>hi</p>"))).not.toBe(1);
  });

  it("rejects a rewrite with two concatenated article bodies (duplicate H1)", () => {
    const duplicated =
      "<h1>Best Cat Fountains</h1><p>body one</p>" +
      "<h1>Best Cat Fountains</h1><p>body two (duplicated)</p>";
    expect(countH1(wrap(duplicated))).toBe(2);
  });

  it("counts H1 tags with attributes, not just bare <h1>", () => {
    const html = wrap(
      '<h1 class="title" id="main">Best Cat Fountains</h1><p>hi</p>'
    );
    expect(countH1(html)).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(countH1(wrap("<H1>Best Cat Fountains</H1>"))).toBe(1);
  });
});
