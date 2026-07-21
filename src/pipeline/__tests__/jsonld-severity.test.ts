import { describe, expect, it } from "vitest";
import { classifyJsonLdSeverity, validateJsonLd } from "../qc-gate";

// Severity classifier on top of validateJsonLd. Splits validation
// failures into "severe" (zero blocks / parse failure / missing @type /
// missing required field on Article/FAQPage/BreadcrumbList/ItemList/
// Product/VideoObject — the six types Google consumes for rich-result
// eligibility on this site) vs "minor" (everything else). Writer.ts
// Step 14.5 fires a defect-finding only on severe; minor stays in the
// soft-warning lane.

const wrap = (jsonLdBlocks: string[]) =>
  `<html><head>` +
  jsonLdBlocks
    .map((j) => `<script type="application/ld+json">${j}</script>`)
    .join("") +
  `</head><body></body></html>`;

const classifyHtml = (...blocks: string[]) =>
  classifyJsonLdSeverity(validateJsonLd(wrap(blocks)));

describe("classifyJsonLdSeverity — happy path", () => {
  // Note: zero-blocks → severe is verified in the coverage-extension
  // suite below. Prior to that extension, zero-blocks was classified
  // as `ok`; this was an under-coverage bug since every article
  // SHOULD emit at least Article + BreadcrumbList.

  it("valid Article schema → ok", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        headline: "Best Cat Fountains",
        author: { "@type": "Person", name: "Amelia" },
        datePublished: "2026-05-30",
        image: "https://example.com/x.jpg"
      })
    );
    expect(r.severity).toBe("ok");
  });
});

describe("classifyJsonLdSeverity — severe failures", () => {
  it("block-level JSON parse failure → severe", () => {
    const r = classifyHtml("{ not json");
    expect(r.severity).toBe("severe");
    expect(r.severeReasons[0]).toMatch(/parse failure/);
  });

  it("missing @type → severe", () => {
    const r = classifyHtml(
      JSON.stringify({ "@context": "https://schema.org", name: "X" })
    );
    expect(r.severity).toBe("severe");
    expect(r.severeReasons[0]).toMatch(/missing @type/);
  });

  it("Article missing required field → severe", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        // missing: headline, author, datePublished, image
        name: "Best Cat Fountains"
      })
    );
    expect(r.severity).toBe("severe");
    expect(r.severeReasons.some((s) => /Article\./.test(s))).toBe(true);
  });

  it("FAQPage with empty mainEntity → severe", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: []
      })
    );
    // FAQPage with empty mainEntity = no rich-result eligibility →
    // either missing required field or empty array errors → severe.
    expect(r.severity).toBe("severe");
  });

  it("BreadcrumbList missing required field → severe", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList"
        // missing itemListElement
      })
    );
    expect(r.severity).toBe("severe");
  });

  it("ItemList missing required field → severe", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "ItemList"
        // missing itemListElement
      })
    );
    expect(r.severity).toBe("severe");
  });

  it("multiple severe issues across blocks → dedup'd reasons", () => {
    const r = classifyHtml(
      "{ broken",
      JSON.stringify({ "@context": "https://schema.org" }) // no @type
    );
    expect(r.severity).toBe("severe");
    // Both errors surface as severe.
    expect(r.severeReasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("classifyJsonLdSeverity — minor failures", () => {
  it("unknown @type → not severe (Google ignores unknown types)", () => {
    // The validator doesn't have a rule for "WeirdCustomType" so it
    // returns the type but no errors — that's a valid path. Severity
    // should be "ok" in this case.
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WeirdCustomType",
        name: "x"
      })
    );
    // Validator returns no errors for unknown @type, so severity = ok.
    expect(r.severity).toBe("ok");
  });
});

describe("severity invariant — pre-publish JSON-LD safety", () => {
  it("ANY block-level parse failure produces severity=severe regardless of position", () => {
    // First block valid, second broken — severity must still be severe.
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        headline: "X",
        author: { "@type": "Person", name: "A" },
        datePublished: "2026-05-30",
        image: "x"
      }),
      "{ broken"
    );
    expect(r.severity).toBe("severe");
  });
});

describe("classifyJsonLdSeverity — coverage extension (zero blocks + Product/VideoObject)", () => {
  it("zero JSON-LD blocks anywhere → severe (no rich-result eligibility)", () => {
    const r = classifyJsonLdSeverity(
      validateJsonLd("<html><head></head><body><p>cats</p></body></html>")
    );
    expect(r.severity).toBe("severe");
    expect(r.severeReasons[0]).toMatch(/no JSON-LD blocks present/);
  });

  it("Product missing `name` (required field) → severe", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product"
      })
    );
    expect(r.severity).toBe("severe");
    expect(r.severeReasons.some((s) => /Product\.name missing/.test(s))).toBe(
      true
    );
  });

  it("VideoObject missing `name` → severe", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "VideoObject",
        thumbnailUrl: "x",
        uploadDate: "2026-05-30"
      })
    );
    expect(r.severity).toBe("severe");
    expect(
      r.severeReasons.some((s) => /VideoObject\.name missing/.test(s))
    ).toBe(true);
  });

  it("VideoObject missing `thumbnailUrl` → severe", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "VideoObject",
        name: "Cat fountain hands-on",
        uploadDate: "2026-05-30"
      })
    );
    expect(r.severity).toBe("severe");
  });

  it("VideoObject missing `uploadDate` → severe", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "VideoObject",
        name: "X",
        thumbnailUrl: "x"
      })
    );
    expect(r.severity).toBe("severe");
  });

  it("complete Product → ok (regression guard)", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "PetLibro Cat Fountain"
      })
    );
    expect(r.severity).toBe("ok");
  });

  it("complete VideoObject → ok (regression guard)", () => {
    const r = classifyHtml(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "VideoObject",
        name: "Cat fountain hands-on",
        thumbnailUrl: "https://i.ytimg.com/foo.jpg",
        uploadDate: "2026-05-30"
      })
    );
    expect(r.severity).toBe("ok");
  });
});
