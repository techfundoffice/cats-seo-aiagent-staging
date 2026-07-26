import { describe, expect, it } from "vitest";
import {
  detectIntent,
  entityIdForBrand,
  entityIdForCategory,
  entityIdForProduct,
  entitySimilarity,
  resolveKeywordEntity
} from "../entity-resolver";

// Acceptance cases are REAL collisions measured on 2026-07-26 across the
// 153 articles published from the product catalog. Each pair below is
// live on catsluvus.com today, competing with itself.

describe("resolveKeywordEntity — collapses real live collisions", () => {
  it("collapses word-order permutations of the soft cat carrier trio", () => {
    const a = resolveKeywordEntity("cat carrier soft for pets up review");
    const b = resolveKeywordEntity("soft cat carrier for pets up review");
    const c = resolveKeywordEntity("cat carrier soft review");
    expect(a.entityId).toBe(b.entityId);
    expect(a.entityId).toBe(c.entityId);
    expect(a.intent).toBe("review");
  });

  it("collapses the purina friskies wet food pair", () => {
    const a = resolveKeywordEntity(
      "purina friskies gravy wet cat food variety pack review"
    );
    const b = resolveKeywordEntity(
      "purina friskies wet cat food variety pack review"
    );
    // "gravy" is a real flavour distinction, so these stay separate —
    // precision over recall. But the variety/pack noise must be gone.
    expect(a.tokens).not.toContain("variety");
    expect(a.tokens).not.toContain("pack");
    expect(b.tokens).not.toContain("pack");
    expect(entitySimilarity(a, b)).toBeGreaterThan(0.7);
  });

  it("collapses stainless steel fountain phrasing variants", () => {
    const a = resolveKeywordEntity(
      "cat water fountain stainless steel: / cat fountain review"
    );
    const b = resolveKeywordEntity(
      "cat water fountain stainless steel: pet fountains review"
    );
    expect(a.entityId).toBe(b.entityId);
  });
});

describe("resolveKeywordEntity — precision guard (must NOT merge)", () => {
  it("keeps the three Hartz UltraGuard SKUs distinct", () => {
    const plain = resolveKeywordEntity(
      "hartz ultraguard flea & tick collar for cats review"
    );
    const pro = resolveKeywordEntity(
      "hartz ultraguard pro flea & tick collar review"
    );
    const promax = resolveKeywordEntity(
      "hartz ultraguard promax flea & tick collar review"
    );
    expect(plain.entityId).not.toBe(pro.entityId);
    expect(pro.entityId).not.toBe(promax.entityId);
    expect(plain.entityId).not.toBe(promax.entityId);
  });

  it("keeps ring indoor and outdoor cams distinct", () => {
    const indoor = resolveKeywordEntity("ring indoor cam review");
    const outdoor = resolveKeywordEntity("ring outdoor cam review");
    expect(indoor.entityId).not.toBe(outdoor.entityId);
  });

  it("keeps different temptations lines distinct", () => {
    const classic = resolveKeywordEntity(
      "temptations classic crunchy and soft cat treats review"
    );
    const mixups = resolveKeywordEntity(
      "temptations mixups crunchy and soft cat treats review"
    );
    expect(classic.entityId).not.toBe(mixups.entityId);
  });
});

describe("resolveKeywordEntity — variant/noise stripping", () => {
  it("strips size, colour and count qualifiers", () => {
    const base = resolveKeywordEntity("petlibro water fountain review");
    for (const variant of [
      "petlibro water fountain large review",
      "petlibro water fountain black review",
      "petlibro water fountain 2 pack review",
      "petlibro water fountains review"
    ]) {
      expect(resolveKeywordEntity(variant).entityId).toBe(base.entityId);
    }
  });

  it("is order-insensitive", () => {
    expect(resolveKeywordEntity("automatic litter box review").entityId).toBe(
      resolveKeywordEntity("litter box automatic review").entityId
    );
  });

  it("never emits an empty entity id for an all-noise keyword", () => {
    const r = resolveKeywordEntity("best the for review", {
      categorySlug: "cat-toys"
    });
    expect(r.entityId).toBe("topic:cat-toys");
  });

  it("prefers a known ASIN as the identity", () => {
    const r = resolveKeywordEntity("anything at all review", {
      asin: "B07KHPLFMS"
    });
    expect(r.entityId).toBe("product:B07KHPLFMS");
  });
});

describe("detectIntent", () => {
  it("classifies the four intents", () => {
    expect(detectIntent("petlibro fountain review")).toBe("review");
    expect(detectIntent("petlibro vs catit fountain")).toBe("comparison");
    expect(detectIntent("how to clean a cat fountain")).toBe("howto");
    expect(detectIntent("best cat water fountain")).toBe("buying-guide");
  });

  it("separates ownership for the same entity at different intents", () => {
    const review = resolveKeywordEntity("automatic litter box review");
    const guide = resolveKeywordEntity("best automatic litter box");
    expect(review.entityId).toBe(guide.entityId);
    expect(review.intent).not.toBe(guide.intent);
  });
});

describe("stable id helpers", () => {
  it("normalizes product, brand and category ids", () => {
    expect(entityIdForProduct("b07khplfms")).toBe("product:B07KHPLFMS");
    expect(entityIdForBrand("Tuft & Paw")).toBe("brand:tuft-paw");
    expect(entityIdForCategory("Cat-Toys")).toBe("category:cat-toys");
  });
});
