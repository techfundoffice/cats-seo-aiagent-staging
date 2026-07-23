import { describe, expect, it } from "vitest";
import { buildHeroImagePrompt, heroImageR2Key } from "../article-image";

describe("buildHeroImagePrompt", () => {
  it("is scene-based and explicitly forbids text/packaging (diffusion slop guard)", () => {
    const p = buildHeroImagePrompt(
      "best flea treatment for cats",
      "Cat Flea Tick"
    );
    expect(p).toContain("best flea treatment for cats");
    expect(p).toMatch(/no text/i);
    expect(p).toMatch(/no product packaging/i);
    expect(p).toMatch(/no watermarks/i);
  });

  it("falls back to the keyword when category name is empty", () => {
    expect(buildHeroImagePrompt("best cat litter", "")).toContain(
      "best cat litter"
    );
  });
});

describe("heroImageR2Key", () => {
  it("namespaces images by category and slug", () => {
    expect(heroImageR2Key("cat-food", "best-cat-food")).toBe(
      "articles/cat-food/best-cat-food.jpg"
    );
  });
});
