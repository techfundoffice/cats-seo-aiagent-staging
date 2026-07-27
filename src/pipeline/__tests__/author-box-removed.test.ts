import { describe, expect, it } from "vitest";
import { buildArticleHtml } from "../html-builder";
import type { ArticleData } from "../html-builder";
import type { AmazonProduct } from "../amazon";
import { calculateSEOScore } from "../seo-score";

/**
 * The visible author box was removed on 2026-07-27 by operator request.
 *
 * Two things must hold:
 *   1. None of the byline / credentials / bio prose renders any more. The
 *      old long-form variant of this bio was also an FTC problem — it
 *      claimed "hands-on facility testing" and that the author
 *      "personally reviews and stands behind every product", neither of
 *      which is true (see fabricated-testing-claims.ts).
 *   2. Authorship is STILL declared to search engines via the JSON-LD
 *      Person entity, and the author-dependent scorecard checks still
 *      pass — otherwise every article silently loses points and articles
 *      scoring 90-93 fall below the >=90 production gate.
 */

const article: ArticleData = {
  title: "Best Cat Water Fountain",
  metaDescription: "A meta description for the test article.",
  quickAnswer: "The Fountain 3000 is the best cat water fountain.",
  keyTakeaways: ["Quiet pumps matter"],
  introduction: "<p>Intro paragraph about fountains for cats.</p>",
  sections: [{ heading: "How we chose", content: "<p>Section content.</p>" }],
  whyTrustUs: "We run a cat boarding facility.",
  faqs: [{ question: "Is it quiet?", answer: "Yes." }],
  conclusion: "Wrap-up."
};

const products: AmazonProduct[] = [
  {
    name: "Fountain 3000",
    displayName: "Fountain 3000",
    asin: "B000TEST01",
    imageUrl: "https://m.media-amazon.com/images/I/test.jpg",
    source: "apify"
  }
];

function render(): string {
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

describe("author box removal", () => {
  it("renders none of the byline, credentials or bio prose", () => {
    const body = render().split("<body")[1] ?? render();
    expect(body).not.toContain("Written by Amelia Hartwell");
    expect(body).not.toContain("author-box");
    expect(body).not.toContain("Certified Feline Behavior Consultant");
    expect(body).not.toContain("draws on daily boarding-floor experience");
    // The FTC-offending long-form variant must never come back either.
    expect(body).not.toContain("personally reviews and stands behind");
    expect(body).not.toContain("hands-on facility testing");
  });

  it("keeps the last-updated freshness signal", () => {
    expect(render()).toContain('itemprop="dateModified"');
  });

  it("still declares authorship in JSON-LD for E-E-A-T", () => {
    const html = render();
    expect(html).toMatch(/"@type"\s*:\s*"Person"/);
    expect(html).toContain("Amelia Hartwell");
    expect(html).toContain("author/amelia-hartwell");
    expect(html).toContain("amelia-hartwell.webp");
  });

  it("costs the scorecard no author-related points", () => {
    const html = render();
    const result = calculateSEOScore(
      html,
      "best cat water fountain",
      article.title,
      article.metaDescription
    );
    const byId = new Map(result.checks.map((c) => [c.id, c]));
    // 9 = direct quotes/attribution, 21 = byline, 22 = author bio link,
    // 24 = author image. All four must still pass off structured data.
    for (const id of [9, 21, 22, 24]) {
      expect(byId.get(id)?.passed, `check #${id} regressed`).toBe(true);
    }
  });
});
