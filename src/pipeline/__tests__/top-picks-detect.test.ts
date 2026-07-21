import { describe, expect, it } from "vitest";
import {
  articleHasRealTopPicks,
  extractProductAsins
} from "../top-picks-detect";

describe("articleHasRealTopPicks", () => {
  it("returns true for production-shaped Top Picks with ASIN links", () => {
    const html = `
      <div class="top-picks">
        <h2 class="top-picks-title">Our Top Picks</h2>
        <a href="https://www.amazon.com/dp/B0D1CNK5RS?tag=catsluvus03-20">View on Amazon</a>
      </div>`;
    expect(articleHasRealTopPicks(html)).toBe(true);
    expect(extractProductAsins(html)).toEqual(["B0D1CNK5RS"]);
  });

  it("returns false for honesty empty strip that mentions Our Top Picks", () => {
    const html = `
      <p>When we have enough vetted product data to rank specific picks we add a
      "Top Picks" section. This one doesn't have that section on purpose —
      we don't rank products we haven't verified.</p>
      <h2>Our Top Picks</h2>`;
    expect(articleHasRealTopPicks(html)).toBe(false);
  });

  it("returns false when heading exists but no amazon dp links", () => {
    const html = `<div class="top-picks"><h2>Our Top Picks</h2><p>No links yet</p></div>`;
    expect(articleHasRealTopPicks(html)).toBe(false);
  });

  it("returns false for empty/null html", () => {
    expect(articleHasRealTopPicks("")).toBe(false);
    expect(articleHasRealTopPicks(null)).toBe(false);
  });
});
