import { describe, expect, it } from "vitest";
import {
  reviewSignalScore,
  selectFeaturedProducts,
  type AmazonProduct
} from "../amazon";

function product(overrides: Partial<AmazonProduct> = {}): AmazonProduct {
  return {
    name: "Generic Cat Product",
    displayName: "Generic Cat Product",
    source: "apify",
    ...overrides
  };
}

describe("selectFeaturedProducts", () => {
  it("features exactly one product when several candidates survive dedupe", () => {
    const products = [
      product({ name: "A", ratingValue: 4.1, reviewCount: 900 }),
      product({ name: "B", ratingValue: 4.7, reviewCount: 5200 }),
      product({ name: "C", ratingValue: 4.4, reviewCount: 2100 })
    ];

    const { featured, dropped } = selectFeaturedProducts(products);

    // This is the whole point of the file: staging publishes single-product
    // reviews, not multi-SKU roundups. A change that restores multi-pick
    // has to delete this assertion on purpose.
    expect(featured).toHaveLength(1);
    expect(featured[0].name).toBe("B");
    expect(dropped).toBe(2);
  });

  it("keeps a five-product list from shipping as a roundup", () => {
    const products = Array.from({ length: 5 }, (_, i) =>
      product({ name: `Pick ${i + 1}`, ratingValue: 4.5, reviewCount: 1000 })
    );

    expect(selectFeaturedProducts(products).featured).toHaveLength(1);
    expect(selectFeaturedProducts(products).dropped).toBe(4);
  });

  it("passes through a single product and an empty list untouched", () => {
    const one = [product({ name: "Only" })];
    expect(selectFeaturedProducts(one)).toEqual({
      featured: one,
      dropped: 0
    });
    expect(selectFeaturedProducts([])).toEqual({ featured: [], dropped: 0 });
  });

  it("ranks by review signal, not by the order the product tiers answered", () => {
    // The weakest listing arrives first (Creators API answers before Apify);
    // selection must not simply take products[0].
    const products = [
      product({ name: "First in", ratingValue: 3.2, reviewCount: 12 }),
      product({ name: "Best reviewed", ratingValue: 4.6, reviewCount: 8000 })
    ];

    expect(selectFeaturedProducts(products).featured[0].name).toBe(
      "Best reviewed"
    );
  });

  it("is deterministic for tied scores — stable order, no coin flip", () => {
    const products = [
      product({ name: "Tie A", ratingValue: 4.5, reviewCount: 1000 }),
      product({ name: "Tie B", ratingValue: 4.5, reviewCount: 1000 })
    ];

    for (let run = 0; run < 5; run++) {
      expect(selectFeaturedProducts(products).featured[0].name).toBe("Tie A");
    }
  });
});

describe("reviewSignalScore", () => {
  it("gives review count diminishing returns — one decade, one unit", () => {
    const at100 = reviewSignalScore(
      product({ ratingValue: 1, reviewCount: 99 })
    );
    const at1k = reviewSignalScore(
      product({ ratingValue: 1, reviewCount: 999 })
    );
    const at10k = reviewSignalScore(
      product({ ratingValue: 1, reviewCount: 9999 })
    );

    expect(at1k - at100).toBeCloseTo(1, 5);
    expect(at10k - at1k).toBeCloseTo(1, 5);
  });

  it("prefers the better rating when review counts match", () => {
    const better = product({ ratingValue: 4.8, reviewCount: 3000 });
    const worse = product({ ratingValue: 4.2, reviewCount: 3000 });

    expect(reviewSignalScore(better)).toBeGreaterThan(reviewSignalScore(worse));
  });

  it("lets a large enough review gap outrank a better rating", () => {
    // Deliberate, not a bug: at a 13x review spread the popular listing is
    // the safer single pick, so 4.2 stars x 40,000 beats 4.8 stars x 3,000.
    const highVolume = product({ ratingValue: 4.2, reviewCount: 40_000 });
    const betterRated = product({ ratingValue: 4.8, reviewCount: 3000 });

    expect(reviewSignalScore(highVolume)).toBeGreaterThan(
      reviewSignalScore(betterRated)
    );
  });

  it("prefers ratingValue over the scraped rating string", () => {
    const scoreFromNumeric = reviewSignalScore(
      product({ ratingValue: 4.8, rating: "1.0", reviewCount: 100 })
    );
    const scoreFromString = reviewSignalScore(
      product({ rating: "4.8", reviewCount: 100 })
    );

    expect(scoreFromNumeric).toBeCloseTo(scoreFromString, 5);
  });

  it("clamps a malformed rating string instead of trusting it", () => {
    expect(
      reviewSignalScore(product({ rating: "9.9", reviewCount: 100 }))
    ).toBeCloseTo(
      reviewSignalScore(product({ rating: "5", reviewCount: 100 }))
    );
    expect(
      reviewSignalScore(product({ rating: "n/a", reviewCount: 100 }))
    ).toBe(0);
  });

  it("breaks ties toward a product with a real ASIN to deep-link", () => {
    const withAsin = product({
      ratingValue: 4.5,
      reviewCount: 1000,
      asin: "B0ABCDEFGH"
    });
    const withoutAsin = product({ ratingValue: 4.5, reviewCount: 1000 });

    expect(reviewSignalScore(withAsin)).toBeGreaterThan(
      reviewSignalScore(withoutAsin)
    );
  });

  it("scores a product with no rating signal at zero", () => {
    expect(reviewSignalScore(product())).toBe(0);
  });
});
