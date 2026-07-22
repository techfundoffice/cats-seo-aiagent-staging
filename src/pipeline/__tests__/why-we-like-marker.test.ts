import { describe, expect, it } from "vitest";
import { buildArticleHtml, ensureWhyWeLikeMarker } from "../html-builder";

// Closes the `missing-why-we-like-blurb` defect class at render time.
// Real Kimi-generated reasoning (when present) must pass through
// untouched; reasoning missing the marker must get a single-sentence
// templated fallback that uses available context (label, keyword) so
// the live article shows an editorial endorsement on every pick even
// when Kimi-degraded omitted sentence 3.

describe("ensureWhyWeLikeMarker — passthrough when marker present", () => {
  it("returns text unchanged when canonical marker is present", () => {
    const text =
      "Solid for multi-cat homes thanks to the large basin. " +
      "Tradeoff: heavier than the budget pick. " +
      "Why we like this pick: handles peak weekend traffic without overflow → ideal for households with 3+ cats.";
    const out = ensureWhyWeLikeMarker(text, { keyword: "best litter box" });
    expect(out).toBe(text);
  });

  it("case-insensitive marker detection", () => {
    const variants = [
      "WHY WE LIKE THIS PICK: works.",
      "why we like this pick: works.",
      "Why  we  like  this  pick : works." // whitespace variations
    ];
    for (const v of variants) {
      expect(ensureWhyWeLikeMarker(v, { keyword: "x" })).toBe(v);
    }
  });
});

describe("ensureWhyWeLikeMarker — fallback appended when marker missing", () => {
  it("appends a label-driven sentence when label is set", () => {
    const text =
      "Quiet motor, plastic basin. Tradeoff: smaller capacity than premium picks.";
    const out = ensureWhyWeLikeMarker(text, {
      label: "Budget pick",
      keyword: "best cat water fountain"
    });
    expect(out.startsWith(text)).toBe(true);
    expect(out).toMatch(/Why we like this pick:/);
    expect(out).toMatch(/budget pick/);
    expect(out).toMatch(/best cat water fountain/);
  });

  it("falls back to keyword-only phrasing when label missing", () => {
    const text = "Quiet motor.";
    const out = ensureWhyWeLikeMarker(text, {
      keyword: "best cat water fountain"
    });
    // 2026-06-11: fallback copy now leads with the product name (or
    // "this pick") so five simultaneous fallbacks aren't identical —
    // the old "fits the brief for <keyword>." line shipped 5x verbatim.
    expect(out).toContain("Why we like this pick:");
    expect(out).toContain("best cat water fountain");
  });

  it("survives empty reasoning by returning just the closing line", () => {
    const out = ensureWhyWeLikeMarker("", { keyword: "best cat fountain" });
    expect(out).toMatch(/^Why we like this pick:/);
  });

  it("survives empty everything by using a category fallback phrase", () => {
    const out = ensureWhyWeLikeMarker("", { keyword: "" });
    expect(out).toMatch(/this category/);
    expect(out).toMatch(/Why we like this pick:/);
  });
});

describe("ensureWhyWeLikeMarker — idempotent", () => {
  it("applying twice produces the same result", () => {
    const text = "Quiet motor.";
    const ctx = { keyword: "best fountain" };
    const once = ensureWhyWeLikeMarker(text, ctx);
    const twice = ensureWhyWeLikeMarker(once, ctx);
    expect(twice).toBe(once);
  });
});

describe("ensureWhyWeLikeMarker — defect-class regression guard", () => {
  it("output ALWAYS contains the marker substring (the property the Step 14.5 detector checks)", () => {
    const cases = [
      ["", { keyword: "x" }],
      ["Some prose without the closing marker.", { keyword: "y" }],
      ["Includes Why we like this pick: here.", { keyword: "z" }],
      ["Two sentences. No marker.", { label: "Best for kittens", keyword: "w" }]
    ] as const;
    for (const [t, ctx] of cases) {
      const out = ensureWhyWeLikeMarker(t, ctx);
      expect(out).toMatch(/Why\s+we\s+like\s+this\s+pick\s*:/i);
    }
  });
});

// ── buildArticleHtml render-path regression: pickReasons absent ────────────────
// Guard the fix in html-builder.ts that ensures every rendered pick card
// contains the "Why we like this pick:" marker even when Kimi returned no
// pickReasons (or returned entries with non-matching ASINs).

const minimalArticle = {
  title: "Best Cat Window Perches for Large Cats",
  metaDescription:
    "Find the best cat window perches for large breed cats. Expert picks with weight limits up to 50 lbs. Updated 2026.",
  quickAnswer:
    "The best cat window perch for large cats supports at least 50 lbs.",
  keyTakeaways: ["Supports large cats", "Easy to install"],
  introduction: "Large breed cats need sturdy window perches.",
  sections: [
    { heading: "What to Look For", content: "Look for weight capacity." },
    { heading: "How It Works", content: "Mounts on the window sill." },
    {
      heading: "Common Problems",
      content: "Some perches wobble under weight."
    },
    { heading: "Buying Guide", content: "Consider your cat weight." },
    { heading: "Expert Tips", content: "Measure the window frame first." },
    {
      heading: "Safety Considerations",
      content: "Check the mounting hardware."
    },
    {
      heading: "Alternatives",
      content: "Floor-standing cat trees are an option."
    },
    { heading: "Our Verdict", content: "Go for a steel bracket model." }
  ],
  whyTrustUs: "Cats Luv Us Boarding Hotel, Laguna Niguel CA.",
  faqs: [
    {
      question: "What weight limit?",
      answer: "At least 50 lbs for large cats."
    }
  ],
  conclusion: "Choose a perch rated for your cat weight.",
  pickReasons: undefined
};

const minimalProduct = {
  asin: "B08TEST001",
  name: "HeavyDuty Cat Window Perch",
  displayName: "HeavyDuty Cat Window Perch",
  rating: "4.5",
  reviewCount: 1200,
  imageUrl: "",
  price: "",
  source: "pa-api-v5" as const
};

describe("buildArticleHtml — missing-why-we-like-blurb regression guard", () => {
  it("every pick card contains 'Why we like this pick:' even when pickReasons is absent", () => {
    const html = buildArticleHtml({
      article: { ...minimalArticle, pickReasons: undefined },
      slug: "cat-window-perch-weight-limit-50-lbs",
      keyword: "cat window perch weight limit 50 lbs",
      categorySlug: "cat-window-perches-for-large-breed-cats",
      categoryName: "Cat Window Perches",
      domain: "catsluvus.com",
      tag: "catsluvus-20",
      products: [minimalProduct]
    });
    expect(html).toMatch(/class="top-picks"/);
    expect(html).toMatch(/Why we like this pick:/i);
  });

  it("every pick card contains 'Why we like this pick:' when pickReasons ASIN does not match any product", () => {
    const html = buildArticleHtml({
      article: {
        ...minimalArticle,
        pickReasons: [
          {
            asin: "B000NOMATCH",
            reasoning:
              "Great perch. Tradeoff: pricey. Two sentences, no marker."
          }
        ]
      },
      slug: "cat-window-perch-weight-limit-50-lbs",
      keyword: "cat window perch weight limit 50 lbs",
      categorySlug: "cat-window-perches-for-large-breed-cats",
      categoryName: "Cat Window Perches",
      domain: "catsluvus.com",
      tag: "catsluvus-20",
      products: [minimalProduct]
    });
    expect(html).toMatch(/class="top-picks"/);
    expect(html).toMatch(/Why we like this pick:/i);
  });
});

describe("ensureWhyWeLikeMarker — data-driven fallback enrichment", () => {
  it("weaves rating, reviews and a feature into the fallback, marker last", () => {
    const out = ensureWhyWeLikeMarker("", {
      productName: "Groxkox Cat Carrier for 2 Cats",
      keyword: "best cat carrier for two cats",
      ratingValue: 4.5,
      reviewCount: 1234,
      features:
        "Foldable double-compartment design with removable divider | mesh windows"
    });
    const sentences = out.split(/(?<=\.)\s+/);
    expect(out).toContain("Rated 4.5/5 across 1,234 buyer reviews");
    expect(out).toContain(
      "Standout detail: Foldable double-compartment design"
    );
    expect(
      sentences[sentences.length - 1].startsWith("Why we like this pick:")
    ).toBe(true);
  });

  it("omits enrichment when product data is absent (legacy behavior)", () => {
    const out = ensureWhyWeLikeMarker("", {
      productName: "Some Carrier",
      keyword: "best cat carrier"
    });
    expect(out).toBe(
      "Why we like this pick: the Some Carrier covers what buyers look for in best cat carrier."
    );
  });
});
