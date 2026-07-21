import { describe, expect, it } from "vitest";
import { __testHelpers } from "../live-quality-probe";

const { endsWithOrphanModifier, isOverSerpWindow, countH2s, hasFaqPageSchema } =
  __testHelpers;

describe("endsWithOrphanModifier — HTML-encoded ampersand cases (2026-05-31 audit)", () => {
  // Live samples from 2026-05-31 that the original probe missed:
  // titles ending in `&amp;` (encoded `&`) because of an over-window
  // truncation that landed mid-conjunction. The probe split on
  // whitespace and saw the last token as literally `&amp;`, which
  // wasn't in the orphan set.
  it("flags '...Top 5 Tested &amp;' (encoded dangling ampersand)", () => {
    expect(
      endsWithOrphanModifier(
        "Memory Foam Pet Steps Senior Review: 2026's Top 5 Tested &amp;"
      )
    ).toBe(true);
  });

  it("flags '...Top Picks &amp;' (encoded dangling ampersand)", () => {
    expect(
      endsWithOrphanModifier(
        "2026's Best Automatic Motorized Pet Stairs: Top Picks &amp;"
      )
    ).toBe(true);
  });

  it("flags numeric-encoded dangling ampersands", () => {
    expect(endsWithOrphanModifier("Best Cat Wheelchair Picks &#38;")).toBe(
      true
    );
    expect(endsWithOrphanModifier("Best Cat Wheelchair Picks &#x26;")).toBe(
      true
    );
  });

  it("treats trailing &nbsp; as whitespace before orphan checks", () => {
    expect(endsWithOrphanModifier("Best Cat Wheelchair Picks Top&nbsp;")).toBe(
      true
    );
  });

  it("treats middle &nbsp; as whitespace before orphan checks", () => {
    expect(endsWithOrphanModifier("Best Cat Wheelchair Picks&nbsp;Top")).toBe(
      true
    );
  });

  it("flags bare trailing `&`", () => {
    expect(endsWithOrphanModifier("Best Cat Trees &")).toBe(true);
  });

  it("flags bare trailing `+`", () => {
    expect(endsWithOrphanModifier("Best Cat Fountains +")).toBe(true);
  });

  it("does NOT flag a title whose last word contains an ampersand but doesn't end in one", () => {
    expect(endsWithOrphanModifier("Cats & Kittens Buying Guide")).toBe(false);
  });
});

describe("isOverSerpWindow", () => {
  it("flags a 70-char title (clearly over window)", () => {
    const r = isOverSerpWindow("a".repeat(70));
    expect(r.over).toBe(true);
    expect(r.decodedLength).toBe(70);
  });

  it("decodes entities before measuring — 62-char encoded title with `&amp;` is 58 decoded → not over", () => {
    // Live sample 2026-05-31: the raw HTML was 67 chars but contained
    // `&apos;` (6→1) and `&amp;` (5→1). Decoded length lands at 58 —
    // in-window. The over-window check correctly does NOT flag this;
    // the orphan-shape check is what catches it (trailing `&`).
    const raw = "X".repeat(53) + " Top &amp;"; // 63 raw, 59 decoded
    const r = isOverSerpWindow(raw);
    expect(r.decodedLength).toBe(59);
    expect(r.over).toBe(false);
  });

  it("flags a title that IS over-window after decode (decoded > 60)", () => {
    const raw = "X".repeat(62) + " Top Picks &amp;"; // decoded ~74
    const r = isOverSerpWindow(raw);
    expect(r.over).toBe(true);
    expect(r.decodedLength).toBeGreaterThan(60);
  });

  it("passes a 60-char title (exact boundary)", () => {
    expect(isOverSerpWindow("a".repeat(60)).over).toBe(false);
  });

  it("passes a 45-char title", () => {
    expect(
      isOverSerpWindow("Best Cat UV Sunshade for Window Perches (2026)").over
    ).toBe(false);
  });

  it("decodes &amp; before measuring (decoded length ≤ encoded length)", () => {
    const encoded = "X".repeat(58) + " &amp;"; // 64 chars encoded, 60 decoded
    const r = isOverSerpWindow(encoded);
    expect(r.decodedLength).toBe(60);
    expect(r.over).toBe(false);
  });

  it("decodes &nbsp; before measuring decoded length", () => {
    const encoded = "X".repeat(58) + "&nbsp;Y"; // 65 encoded, 60 decoded
    const r = isOverSerpWindow(encoded);
    expect(r.decodedLength).toBe(60);
    expect(r.over).toBe(false);
  });
});

describe("endsWithOrphanModifier — live audit cases", () => {
  it("flags '...2026: Top' (Top Picks orphan)", () => {
    expect(
      endsWithOrphanModifier(
        "Best Pheromone Diffuser vs Calming Collar for Cats 2026: Top"
      )
    ).toBe(true);
  });

  it("flags '...Door Corners Buying' (Buying Guide orphan)", () => {
    expect(
      endsWithOrphanModifier(
        "Best Cat Wall-Mounted Scratchers for Door Corners Buying"
      )
    ).toBe(true);
  });

  it("flags '...Expert-Tested Top'", () => {
    expect(
      endsWithOrphanModifier(
        "Calming Cat Pheromone Spray Review (2026): Expert-Tested Top"
      )
    ).toBe(true);
  });

  it("flags a trailing comparison token ('vs')", () => {
    expect(
      endsWithOrphanModifier("Cat Stairs vs Cat Ramp for Senior Cats: vs")
    ).toBe(true);
  });

  it("flags orphan modifiers before trailing punctuation the title normalizer already strips", () => {
    expect(endsWithOrphanModifier("Best Cat Trees For:")).toBe(true);
    expect(endsWithOrphanModifier("Best Cat Trees And,")).toBe(true);
    expect(endsWithOrphanModifier("Best Cat Trees For;")).toBe(true);
    expect(endsWithOrphanModifier("Best Cat Trees Top—")).toBe(true);
    expect(endsWithOrphanModifier("Best Cat Trees With…")).toBe(true);
  });

  it("passes clean titles", () => {
    expect(
      endsWithOrphanModifier("Best Cat UV Sunshade for Window Perches (2026)")
    ).toBe(false);
    expect(
      endsWithOrphanModifier("Best Cat Fountains for Senior Cats 2026 Reviews")
    ).toBe(false);
  });
});

describe("countH2s", () => {
  it("counts total and question-style H2s", () => {
    const html =
      "<h2>Intro</h2><h2>How do cats stay hydrated?</h2><h2>Conclusion</h2>";
    expect(countH2s(html)).toEqual({ total: 3, questionStyle: 1 });
  });

  it("returns zeros for HTML with no H2s", () => {
    expect(countH2s("<h1>x</h1><p>y</p>")).toEqual({
      total: 0,
      questionStyle: 0
    });
  });
});

describe("hasFaqPageSchema", () => {
  const wrap = (json: object) =>
    `<script type="application/ld+json">${JSON.stringify(json)}</script>`;

  it("detects a top-level FAQPage block with non-empty mainEntity", () => {
    const html = wrap({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [{ "@type": "Question", name: "Q?" }]
    });
    expect(hasFaqPageSchema(html)).toBe(true);
  });

  it("detects FAQPage nested inside Article.mainEntity", () => {
    const html = wrap({
      "@context": "https://schema.org",
      "@type": "Article",
      mainEntity: {
        "@type": "FAQPage",
        mainEntity: [{ "@type": "Question", name: "Q?" }]
      }
    });
    expect(hasFaqPageSchema(html)).toBe(true);
  });

  it("detects FAQPage nested inside an Article.mainEntity array", () => {
    const html = wrap({
      "@context": "https://schema.org",
      "@type": "Article",
      mainEntity: [
        { "@type": "Thing", name: "Not FAQ" },
        {
          "@type": "FAQPage",
          mainEntity: [{ "@type": "Question", name: "Q?" }]
        }
      ]
    });
    expect(hasFaqPageSchema(html)).toBe(true);
  });

  it("detects FAQPage inside an @graph array", () => {
    const html = wrap({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Article", headline: "X" },
        {
          "@type": "FAQPage",
          mainEntity: [{ "@type": "Question", name: "Q?" }]
        }
      ]
    });
    expect(hasFaqPageSchema(html)).toBe(true);
  });

  it("detects FAQPage in a top-level JSON-LD array", () => {
    const html =
      '<script type="application/ld+json">' +
      JSON.stringify([
        { "@type": "Article", headline: "X" },
        {
          "@type": "FAQPage",
          mainEntity: [{ "@type": "Question", name: "Q?" }]
        }
      ]) +
      "</script>";
    expect(hasFaqPageSchema(html)).toBe(true);
  });

  it("detects FAQPage when @type is an array", () => {
    const html = wrap({
      "@context": "https://schema.org",
      "@type": ["WebPage", "FAQPage"],
      mainEntity: [{ "@type": "Question", name: "Q?" }]
    });
    expect(hasFaqPageSchema(html)).toBe(true);
  });

  it("returns false for FAQPage with empty mainEntity", () => {
    const html = wrap({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: []
    });
    expect(hasFaqPageSchema(html)).toBe(false);
  });

  it("returns false when no JSON-LD blocks are present", () => {
    expect(hasFaqPageSchema("<html><body><p>nope</p></body></html>")).toBe(
      false
    );
  });

  it("survives a malformed JSON-LD block (skips and continues)", () => {
    const html =
      `<script type="application/ld+json">{ not json</script>` +
      wrap({
        "@type": "FAQPage",
        mainEntity: [{ "@type": "Question", name: "Q?" }]
      });
    expect(hasFaqPageSchema(html)).toBe(true);
  });
});
