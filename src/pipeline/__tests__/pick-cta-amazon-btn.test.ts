import { describe, expect, it } from "vitest";
import type { AmazonProduct } from "../amazon";
import { buildArticleHtml, type ArticleData } from "../html-builder";

// Pick cards sit in a ~140px column (~100px on mobile). A single-line
// "Check price on Amazon" with white-space:nowrap clips to "Check price
// on Am". The pick-card control is two lines; the sticky bar stays one.

const article: ArticleData = {
  title: "Best Cat Water Fountain",
  metaDescription: "A meta description for the test article.",
  quickAnswer: "The Fountain 3000 is the best cat water fountain.",
  keyTakeaways: ["Quiet pumps matter"],
  introduction: "Intro paragraph.",
  sections: [{ heading: "How we chose", content: "Section content." }],
  whyTrustUs: "We run a cat boarding facility.",
  faqs: [{ question: "Is it quiet?", answer: "Yes." }],
  conclusion: "Wrap-up."
};

function render(products: AmazonProduct[]): string {
  return buildArticleHtml({
    article,
    slug: "best-cat-water-fountain",
    keyword: "best cat water fountain",
    categorySlug: "cat-feeding-watering-supplies",
    categoryName: "Cat Feeding Supplies",
    domain: "cats-seo-aiagent-staging.webmaster-bc8.workers.dev",
    tag: "catsluvus03-20",
    products
  });
}

function slicePickCtas(html: string): string[] {
  return html.match(/<div class="pick-cta">[\s\S]*?<\/div>/g) ?? [];
}

function sliceStickyBar(html: string): string {
  const match = html.match(/<div class="amazon-cta-bar"[\s\S]*?<\/div>/);
  return match?.[0] ?? "";
}

const withImage: AmazonProduct = {
  name: 'Fountain 3000 "Pro" & Steel',
  displayName: 'Fountain 3000 "Pro" & Steel',
  asin: "B000TEST01",
  imageUrl: "https://m.media-amazon.com/images/I/test.jpg",
  source: "apify"
};

const secondPick: AmazonProduct = {
  name: "Quiet Pump Mini",
  displayName: "Quiet Pump Mini",
  asin: "B000TEST02",
  imageUrl: "https://m.media-amazon.com/images/I/test2.jpg",
  source: "apify"
};

describe("pick-card Amazon CTA", () => {
  it("stacks Check price / on Amazon inside .pick-cta and not as one line", () => {
    const html = render([withImage]);
    const ctas = slicePickCtas(html);
    expect(ctas).toHaveLength(1);
    const cta = ctas[0] ?? "";

    expect(cta).toContain('<span class="amazon-btn-line">Check price</span>');
    expect(cta).toContain('<span class="amazon-btn-line">on Amazon</span>');
    expect(cta).not.toMatch(/>\s*Check price on Amazon\s*</);
    expect(cta).toContain(
      'aria-label="Check price on Amazon for Fountain 3000 &quot;Pro&quot; &amp; Steel"'
    );
    expect(cta.match(/class="amazon-btn-line"/g)).toHaveLength(2);
  });

  it("leaves the sticky bar a single-line Check price on Amazon", () => {
    const html = render([withImage, secondPick]);
    const bar = sliceStickyBar(html);
    expect(bar).toContain('class="amazon-btn">Check price on Amazon</a>');
    expect(bar).not.toContain("amazon-btn-line");
    expect(bar).not.toMatch(/<a [^>]*class="amazon-btn"[^>]*aria-label/);
  });

  it("leaves compare-table buttons as the short Check price label", () => {
    const html = render([withImage, secondPick]);
    const rows = html.match(/<td class="cmp-cta">[\s\S]*?<\/td>/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row).toContain('class="amazon-btn amazon-btn-sm">Check price</a>');
      expect(row).not.toContain("amazon-btn-line");
      expect(row).not.toContain("on Amazon");
    }
  });

  it("keeps the no-image fallback as a single-line button outside .pick-cta", () => {
    const html = render([
      {
        ...withImage,
        imageUrl: ""
      }
    ]);
    const body = html.slice(html.indexOf("<body"));
    expect(slicePickCtas(html)).toHaveLength(0);
    expect(body).not.toContain("amazon-btn-line");
    expect(body).toContain('class="amazon-btn">Check price on Amazon</a>');
    expect(sliceStickyBar(html)).toContain(
      'class="amazon-btn">Check price on Amazon</a>'
    );
  });

  it("styles only .pick-cta .amazon-btn as a centered two-line column", () => {
    const html = render([withImage]);
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(style).toMatch(
      /\.pick-cta \.amazon-btn\{[^}]*flex-direction:column !important/
    );
    expect(style).toMatch(
      /\.pick-cta \.amazon-btn\{[^}]*align-items:center !important/
    );
    expect(style).toMatch(/\.pick-cta \.amazon-btn\{[^}]*text-align:center/);
    expect(style).toMatch(
      /\.pick-cta \.amazon-btn\{[^}]*white-space:normal !important/
    );
    expect(style).toMatch(/\.pick-cta \.amazon-btn\{[^}]*line-height:1\.15/);
    expect(style).toMatch(
      /\.pick-cta \.amazon-btn \.amazon-btn-line\{[^}]*display:block/
    );
    // Sticky / default button stays one line. The pick-card override is
    // the more specific rule and must not delete this.
    expect(style).toMatch(/\.amazon-btn\{[^}]*white-space:nowrap/);
    expect(style).toMatch(
      /@media \(max-width:640px\)\{[\s\S]*\.pick-cta \.amazon-btn\{[^}]*font-size:11px !important/
    );
  });
});
