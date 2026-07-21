import { describe, expect, it } from "vitest";
import { enforceTitleSerpWindow } from "../title-meta-normalizer";
import { ensureWhyWeLikeMarker } from "../html-builder";
import { removeFabricatedTestingSentences } from "../fabricated-testing-claims";

// Regression tests for the 2026-06-11 live audit of
// refillable-cat-anxiety-diffuser-for-large-cats. Each case is the
// exact production failure.

describe("FAIL 1: title truncation must not leave an unbalanced paren", () => {
  it("closes the paren when it fits the window", () => {
    const r = enforceTitleSerpWindow(
      "Best Refillable Cat Anxiety Diffuser for Large Cats (2026): Editor's Comparison & Top Picks",
      "refillable cat anxiety diffuser for large cats"
    );
    const opens = (r.title.match(/\(/g) ?? []).length;
    const closes = (r.title.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(r.title.length).toBeLessThanOrEqual(60);
    expect(r.title.length).toBeGreaterThanOrEqual(45);
  });
  it("never emits a title ending in an open parenthetical", () => {
    const r = enforceTitleSerpWindow(
      "Best Cat Water Fountain Filters for Hard Water Areas (2026 Buying Guide)",
      "cat water fountain filters"
    );
    expect(/\([^)]*$/.test(r.title)).toBe(false);
  });
});

describe("FAIL 4: fallback pick blurbs are differentiated per product", () => {
  it("leads with the product name so five fallbacks are not identical", () => {
    const a = ensureWhyWeLikeMarker("", {
      keyword: "refillable cat anxiety diffuser for large cats",
      productName: "FELIWAY Optimum Cat Calming Pheromone Diffuser"
    });
    const b = ensureWhyWeLikeMarker("", {
      keyword: "refillable cat anxiety diffuser for large cats",
      productName: "Comfort Zone Multi-Cat Diffuser Kit"
    });
    expect(a).not.toBe(b);
    expect(a).toContain("FELIWAY");
    expect(b).toContain("Comfort Zone");
    expect(a).toContain("Why we like this pick:");
  });
});

describe("FAIL 9: deterministic FTC sentence excision", () => {
  it("removes the exact whyTrustUs violations that shipped live", () => {
    const html =
      `<section><p>She personally reviews and stands behind every product ` +
      `recommendation on this site, partnering with <strong>CatGPT</strong> — a ` +
      `professional research assistant.</p><p>Honest prose stays.</p></section>`;
    const findings = [
      {
        category: "self-endorsement-claim" as const,
        trigger: "she personally reviews",
        sentence:
          "She personally reviews and stands behind every product recommendation on this site, partnering with CatGPT — a professional research assistant."
      }
    ];
    const r = removeFabricatedTestingSentences(html, findings);
    expect(r.removed).toBe(1);
    expect(r.html).not.toContain("stands behind every product");
    expect(r.html).toContain("Honest prose stays.");
  });
  it("rejects over-greedy matches instead of eating structure", () => {
    const html = `<p>short</p>`;
    const r = removeFabricatedTestingSentences(html, [
      {
        category: "first-person-test" as const,
        trigger: "we tested",
        sentence:
          "totally unrelated sentence that we tested does not appear here"
      }
    ]);
    expect(r.removed).toBe(0);
    expect(r.html).toBe(html);
  });
});
