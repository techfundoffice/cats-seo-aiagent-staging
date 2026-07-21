import { describe, expect, it } from "vitest";
import { getSeededWireframe } from "../wireframe-seeds";

describe("getSeededWireframe", () => {
  it("matches the NYT seed when URL ends with index.html plus trailing slash", () => {
    const canonical = getSeededWireframe(
      "https://www.nytimes.com/wirecutter/reviews/best-automatic-cat-litter-box/"
    );
    const withIndexAndSlash = getSeededWireframe(
      "https://www.nytimes.com/wirecutter/reviews/best-automatic-cat-litter-box/index.html/"
    );

    expect(canonical).not.toBeNull();
    expect(withIndexAndSlash).not.toBeNull();
    expect(withIndexAndSlash?.sourceUrl).toBe(canonical?.sourceUrl);
  });
});
