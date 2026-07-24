import { describe, expect, it } from "vitest";
import { buildArticleHtml } from "../html-builder";
import type { ArticleData } from "../html-builder";
import type { AmazonProduct } from "../amazon";

// Above-the-fold layout contract (2026-07-24): the Our Top Picks
// comparison table renders directly below the video hero, BEFORE the
// author box / affiliate disclosure / Quick Answer. Searchers who click
// through want the picks immediately; the editorial framing follows.

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

const products: AmazonProduct[] = [
  {
    name: "Fountain 3000",
    displayName: "Fountain 3000",
    asin: "B000TEST01",
    imageUrl: "https://m.media-amazon.com/images/I/test.jpg",
    source: "apify"
  }
];

describe("article section order", () => {
  it("renders Our Top Picks directly after the video hero, before author box and Quick Answer", () => {
    const html = buildArticleHtml({
      article,
      slug: "best-cat-water-fountain",
      keyword: "best cat water fountain",
      categorySlug: "cat-feeding-watering-supplies",
      categoryName: "Cat Feeding Supplies",
      domain: "cats-seo-aiagent-staging.webmaster-bc8.workers.dev",
      tag: "catsluvus03-20",
      products,
      videoId: "dQw4w9WgXcQ",
      videoTitle: "Fountain review"
    });

    // Search the rendered body only — the inline stylesheet in <head>
    // mentions all of these class names.
    const body = html.slice(html.indexOf("<article"));
    const videoIdx = body.indexOf("video-hero");
    const picksIdx = body.indexOf("top-picks-title");
    const authorIdx = body.indexOf("author-box");
    const quickIdx = body.indexOf("quick-answer");

    expect(videoIdx).toBeGreaterThan(-1);
    expect(picksIdx).toBeGreaterThan(-1);
    expect(authorIdx).toBeGreaterThan(-1);
    expect(quickIdx).toBeGreaterThan(-1);

    expect(videoIdx).toBeLessThan(picksIdx);
    expect(picksIdx).toBeLessThan(authorIdx);
    expect(authorIdx).toBeLessThan(quickIdx);
  });

  it("keeps picks-first order when there is no video hero", () => {
    const html = buildArticleHtml({
      article,
      slug: "best-cat-water-fountain",
      keyword: "best cat water fountain",
      categorySlug: "cat-feeding-watering-supplies",
      categoryName: "Cat Feeding Supplies",
      domain: "cats-seo-aiagent-staging.webmaster-bc8.workers.dev",
      tag: "catsluvus03-20",
      products
    });

    const body = html.slice(html.indexOf("<article"));
    const picksIdx = body.indexOf("top-picks-title");
    const authorIdx = body.indexOf("author-box");
    expect(picksIdx).toBeGreaterThan(-1);
    expect(picksIdx).toBeLessThan(authorIdx);
  });
});
