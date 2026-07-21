import { describe, expect, it } from "vitest";
import {
  asinSetsEqual,
  BESTSELLER_NODES,
  deriveCategorySlug
} from "../top-seller-scout";

describe("BESTSELLER_NODES", () => {
  it("has exactly 18 fixed browse nodes", () => {
    expect(BESTSELLER_NODES).toHaveLength(18);
  });

  it("has unique node IDs", () => {
    const ids = BESTSELLER_NODES.map((n) => n.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique category names", () => {
    const names = BESTSELLER_NODES.map((n) => n.categoryName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("only contains numeric node IDs", () => {
    for (const node of BESTSELLER_NODES) {
      expect(node.nodeId).toMatch(/^\d+$/);
    }
  });
});

describe("deriveCategorySlug", () => {
  it("lowercases and hyphenates the category name with a topseller- prefix", () => {
    expect(deriveCategorySlug("Cat Toys")).toBe("topseller-cat-toys");
  });

  it("collapses punctuation and ampersands into single hyphens", () => {
    expect(deriveCategorySlug("Cat Beds & Furniture")).toBe(
      "topseller-cat-beds-furniture"
    );
    expect(deriveCategorySlug("Cat Doors, Steps, Nets & Pens")).toBe(
      "topseller-cat-doors-steps-nets-pens"
    );
  });

  it("never leaves a leading or trailing hyphen in the base slug", () => {
    expect(deriveCategorySlug("!!!Cat Food!!!")).toBe("topseller-cat-food");
  });

  it("is deterministic across the whole BESTSELLER_NODES list", () => {
    const slugs = BESTSELLER_NODES.map((n) =>
      deriveCategorySlug(n.categoryName)
    );
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug.startsWith("topseller-")).toBe(true);
    }
  });
});

describe("asinSetsEqual", () => {
  it("returns true for identical arrays", () => {
    expect(asinSetsEqual(["B001", "B002"], ["B001", "B002"])).toBe(true);
  });

  it("returns true regardless of order", () => {
    expect(asinSetsEqual(["B002", "B001"], ["B001", "B002"])).toBe(true);
  });

  it("returns false when lengths differ", () => {
    expect(asinSetsEqual(["B001"], ["B001", "B002"])).toBe(false);
  });

  it("returns false when contents differ at the same length", () => {
    expect(asinSetsEqual(["B001", "B003"], ["B001", "B002"])).toBe(false);
  });

  it("returns true for two empty arrays", () => {
    expect(asinSetsEqual([], [])).toBe(true);
  });

  it("returns false comparing empty against non-empty", () => {
    expect(asinSetsEqual([], ["B001"])).toBe(false);
  });
});
