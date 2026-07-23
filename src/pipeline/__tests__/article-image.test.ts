import { describe, expect, it } from "vitest";
import {
  buildHeroPrompt,
  buildProductPrompt,
  detectTopic,
  heroImageR2Key,
  productImageR2Key
} from "../article-image";

// Ported from production's src/pipeline/images.ts (recovered from
// history at a5b52955^) — these tests pin the topic detector and the
// no-text slop guard that keeps diffusion gibberish off the money site.

describe("detectTopic", () => {
  it("classifies keywords into production's topic taxonomy", () => {
    expect(detectTopic("best flea treatment for cats")).toBe("medical");
    expect(detectTopic("best automatic litter box")).toBe("litter");
    expect(detectTopic("cat carrier backpack for hiking")).toBe("carrier");
    expect(detectTopic("gps tracker for outdoor cats")).toBe("tech");
    expect(detectTopic("mystery keyword")).toBe("general");
  });
});

describe("buildHeroPrompt", () => {
  it("is deterministic for the same keyword and index", () => {
    expect(buildHeroPrompt("best cat litter", 0)).toBe(
      buildHeroPrompt("best cat litter", 0)
    );
  });

  it("varies composition across keywords and forbids text (slop guard)", () => {
    const a = buildHeroPrompt("best cat litter", 0);
    const b = buildHeroPrompt("cat carrier sling for kittens", 0);
    expect(a).not.toBe(b);
    for (const p of [a, b]) {
      expect(p).toMatch(/no text/i);
      expect(p).toMatch(/no logos/i);
      expect(p).toMatch(/no watermarks/i);
    }
  });

  it("uses a topic-appropriate scene", () => {
    expect(buildHeroPrompt("best automatic litter box", 0)).toMatch(/litter/i);
  });
});

describe("buildProductPrompt", () => {
  it("never names the real product (no fake branded packaging) and forbids text", () => {
    const p = buildProductPrompt(
      "best flea treatment for cats",
      "FrontlinePlus Ultra Guard 3-pack",
      0
    );
    expect(p).not.toContain("FrontlinePlus");
    expect(p).toMatch(/no brand names/i);
    expect(p).toMatch(/no text/i);
  });
});

describe("R2 key scheme", () => {
  it("namespaces hero and product images under articles/", () => {
    expect(heroImageR2Key("cat-food", "best-cat-food")).toBe(
      "articles/cat-food/best-cat-food-hero.jpg"
    );
    expect(productImageR2Key("cat-food", "best-cat-food", 2)).toBe(
      "articles/cat-food/best-cat-food-product-2.jpg"
    );
  });
});
