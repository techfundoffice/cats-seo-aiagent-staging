import { describe, expect, it } from "vitest";
import { buildProductPromptText, stripAsinParentheticals } from "../amazon";
import type { AmazonProduct } from "../amazon";
import { enforceTitleSerpWindow } from "../title-meta-normalizer";

// Regression tests for two defects found on the live article
// "cat carrier backpack for hiking" (QA loop iteration 2, 2026-07-23):
//   1. The model parroted "(B07KHPLFMS)" into visible prose 15 times —
//      the ASIN was exposed in the product-grounding prompt block.
//   2. The Editorial Agent's SERP-window pad appended " | Best Picks
//      2026" to a title already leading with "Best", recreating the
//      double-"Best" spam segment dedupeTitleSegments strips.

describe("stripAsinParentheticals", () => {
  it("removes bare parenthetical ASINs from prose", () => {
    const r = stripAsinParentheticals(
      "The Texsens Bubble Backpack (B07KHPLFMS) features a spacious interior."
    );
    expect(r.text).toBe(
      "The Texsens Bubble Backpack features a spacious interior."
    );
    expect(r.removed).toBe(1);
  });

  it("removes labeled '(ASIN: …)' variants and counts each removal", () => {
    const r = stripAsinParentheticals(
      "Pick one (ASIN: B07KHPLFMS). Pick two (ASIN B01ABCDE23) works too."
    );
    expect(r.text).toBe("Pick one. Pick two works too.");
    expect(r.removed).toBe(2);
  });

  it("leaves ordinary parentheticals untouched", () => {
    const input =
      "This carrier (rated 4.7 stars) fits cats up to 18 pounds (per maker).";
    const r = stripAsinParentheticals(input);
    expect(r.text).toBe(input);
    expect(r.removed).toBe(0);
  });
});

describe("buildProductPromptText — no ASIN exposure", () => {
  it("never includes the ASIN in the grounding block", () => {
    const products: AmazonProduct[] = [
      {
        name: "Texsens Innovative Traveler Bubble Backpack",
        displayName: "Texsens Innovative Traveler Bubble Backpack",
        asin: "B07KHPLFMS",
        url: "https://www.amazon.com/dp/B07KHPLFMS?tag=catsluvus03-20"
      } as AmazonProduct
    ];
    const prompt = buildProductPromptText(products);
    expect(prompt).not.toContain("B07KHPLFMS");
    expect(prompt).toContain("[PRODUCT_1]");
  });
});

describe("enforceTitleSerpWindow — Best-aware short-title pad", () => {
  it("does not append '| Best Picks' to a title already leading with Best", () => {
    const r = enforceTitleSerpWindow(
      "Best Cat Carrier Backpack for Hiking", // 36 chars — below MIN
      "cat carrier backpack for hiking",
      new Date("2026-07-23T00:00:00Z")
    );
    expect(r.title).not.toMatch(/best.*\|\s*best/i);
    expect(r.title.length).toBeGreaterThanOrEqual(45);
    expect(r.title.length).toBeLessThanOrEqual(60);
    expect(r.title).toContain("Best Cat Carrier Backpack for Hiking");
  });

  it("still uses the '| Best Picks' pad for titles not leading with Best", () => {
    const r = enforceTitleSerpWindow(
      "Quiet Carriers for Skittish Cats", // 32 chars — below MIN
      "quiet cat carrier",
      new Date("2026-07-23T00:00:00Z")
    );
    expect(r.title.length).toBeGreaterThanOrEqual(45);
    expect(r.title.length).toBeLessThanOrEqual(60);
  });
});

describe("toTitleCase — fallback title template casing", () => {
  it("title-cases a lowercase keyword with small words kept lowercase", async () => {
    const { toTitleCase } = await import("../keyword-utils");
    expect(toTitleCase("ventilated cat carrier for summer travel")).toBe(
      "Ventilated Cat Carrier for Summer Travel"
    );
  });

  it("capitalizes small words at phrase edges", async () => {
    const { toTitleCase } = await import("../keyword-utils");
    expect(toTitleCase("the best cat tree")).toBe("The Best Cat Tree");
  });
});
