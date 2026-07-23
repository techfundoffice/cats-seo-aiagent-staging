import { describe, expect, it } from "vitest";
import { pageUrlToKvKey } from "../gsc-sync";

describe("pageUrlToKvKey", () => {
  it("maps a production article URL to categorySlug:slug", () => {
    expect(pageUrlToKvKey("https://catsluvus.com/cat-food/best-cat-food")).toBe(
      "cat-food:best-cat-food"
    );
    expect(
      pageUrlToKvKey("https://catsluvus.com/cat-food/best-cat-food/")
    ).toBe("cat-food:best-cat-food");
  });

  it("returns null for non-article paths", () => {
    expect(pageUrlToKvKey("https://catsluvus.com/")).toBeNull();
    expect(pageUrlToKvKey("https://catsluvus.com/about")).toBeNull();
    expect(pageUrlToKvKey("https://catsluvus.com/a/b/c")).toBeNull();
    expect(pageUrlToKvKey("not a url")).toBeNull();
  });
});
