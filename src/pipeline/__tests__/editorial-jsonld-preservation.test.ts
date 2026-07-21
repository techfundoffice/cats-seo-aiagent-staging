import { describe, expect, it } from "vitest";

// Pins the post-rewrite JSON-LD preservation behavior in
// editorial-agent.ts. The editorial loop unconditionally splices the
// original article's `<script type="application/ld+json">` blocks
// back into the rewrite, replacing whatever blocks the rewrite
// produced. Schemas are deterministic given keyword/title/products,
// so they should never differ between original and rewrite — if Kimi
// mangled them, the splice restores them. These tests pin the regex
// and replacement logic that does the splice, mirroring the inline
// implementation at editorial-agent.ts (around the SERP-window
// repair block).

const LD_RE =
  /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi;

function spliceOriginalJsonLd(
  originalHtml: string,
  rewriteHtml: string
): string {
  if (!/<head\b[^>]*>/i.test(rewriteHtml)) return rewriteHtml;
  const originalBlocks = originalHtml.match(LD_RE) ?? [];
  if (originalBlocks.length === 0) return rewriteHtml;
  const stripped = rewriteHtml.replace(LD_RE, "");
  return stripped.replace(
    /<\/head\s*>/i,
    `${originalBlocks.join("\n")}\n</head>`
  );
}

const wrap = (head: string, body = "<p>hi</p>") =>
  `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;

const articleBlock = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "Best Cat Fountains for Senior Cats 2026 Buying Guide",
  author: { "@type": "Person", name: "Amelia" },
  datePublished: "2026-05-30",
  image: "https://example.com/x.jpg"
});

const breadcrumbBlock = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      name: "Home",
      item: "https://catsluvus.com/"
    }
  ]
});

describe("editorial JSON-LD preservation", () => {
  it("restores a block the rewrite dropped entirely", () => {
    const original = wrap(
      `<script type="application/ld+json">${articleBlock}</script>` +
        `<script type="application/ld+json">${breadcrumbBlock}</script>`
    );
    const rewrite = wrap(""); // rewrite lost ALL schema
    const spliced = spliceOriginalJsonLd(original, rewrite);
    const blocks = spliced.match(LD_RE) ?? [];
    expect(blocks).toHaveLength(2);
    expect(spliced).toContain(articleBlock);
    expect(spliced).toContain(breadcrumbBlock);
  });

  it("replaces a mangled rewrite block with the verbatim original", () => {
    const original = wrap(
      `<script type="application/ld+json">${articleBlock}</script>`
    );
    // Rewrite kept the block but truncated the headline.
    const mangled = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Best", // truncated
      author: { "@type": "Person", name: "Amelia" }
      // missing datePublished + image
    });
    const rewrite = wrap(
      `<script type="application/ld+json">${mangled}</script>`
    );
    const spliced = spliceOriginalJsonLd(original, rewrite);
    expect(spliced).toContain(articleBlock);
    expect(spliced).not.toContain(mangled);
  });

  it("removes extra blocks the rewrite added that weren't in the original", () => {
    const original = wrap(
      `<script type="application/ld+json">${articleBlock}</script>`
    );
    const hallucinated = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Recipe",
      name: "fountain water"
    });
    const rewrite = wrap(
      `<script type="application/ld+json">${articleBlock}</script>` +
        `<script type="application/ld+json">${hallucinated}</script>`
    );
    const spliced = spliceOriginalJsonLd(original, rewrite);
    const blocks = spliced.match(LD_RE) ?? [];
    expect(blocks).toHaveLength(1);
    expect(spliced).not.toContain(hallucinated);
  });

  it("preserves the rewrite when both sides have identical schema", () => {
    const original = wrap(
      `<script type="application/ld+json">${articleBlock}</script>`
    );
    const rewrite = wrap(
      `<script type="application/ld+json">${articleBlock}</script>`
    );
    const spliced = spliceOriginalJsonLd(original, rewrite);
    const blocks = spliced.match(LD_RE) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(articleBlock);
  });

  it("no-ops when the rewrite has no <head> (document-shape regression handled elsewhere)", () => {
    const original = wrap(
      `<script type="application/ld+json">${articleBlock}</script>`
    );
    const rewrite = "<article><p>fragment only</p></article>";
    const spliced = spliceOriginalJsonLd(original, rewrite);
    expect(spliced).toBe(rewrite);
  });

  it("no-ops when the original had no JSON-LD (nothing to splice)", () => {
    const original = wrap("");
    const rewrite = wrap("");
    const spliced = spliceOriginalJsonLd(original, rewrite);
    expect(spliced).toBe(rewrite);
  });

  it("preserves multi-block order from the original", () => {
    const original = wrap(
      `<script type="application/ld+json">${articleBlock}</script>` +
        `<script type="application/ld+json">${breadcrumbBlock}</script>`
    );
    const rewrite = wrap(
      // Rewrite reordered the blocks.
      `<script type="application/ld+json">${breadcrumbBlock}</script>` +
        `<script type="application/ld+json">${articleBlock}</script>`
    );
    const spliced = spliceOriginalJsonLd(original, rewrite);
    const articleIdx = spliced.indexOf(articleBlock);
    const breadcrumbIdx = spliced.indexOf(breadcrumbBlock);
    expect(articleIdx).toBeGreaterThan(-1);
    expect(breadcrumbIdx).toBeGreaterThan(-1);
    expect(articleIdx).toBeLessThan(breadcrumbIdx); // original order restored
  });
});
