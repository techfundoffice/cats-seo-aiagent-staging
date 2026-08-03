import { describe, expect, it } from "vitest";
import {
  ANALYTICS_MARKER,
  buildAnalyticsBodyHtml,
  buildAnalyticsHeadHtml,
  ensureArticleAnalytics,
  normalizeAffiliateClick,
  pathToKvKey
} from "../article-analytics";

describe("article-analytics", () => {
  it("injects head + body markers once", () => {
    const html =
      "<!DOCTYPE html><html><head><title>t</title></head><body><a href='https://www.amazon.com/dp/B0TESTASIN0?tag=catsluvus03-20'>Buy</a></body></html>";
    const once = ensureArticleAnalytics(html);
    expect(once).toContain(ANALYTICS_MARKER);
    expect(once).toContain("G-QBGF94YE7C");
    expect(once).toContain("GTM-KPSXGQWC");
    expect(once).toContain("amazon_click");
    expect(once).toContain("/api/affiliate-click");
    const twice = ensureArticleAnalytics(once);
    expect(twice).toBe(once);
  });

  it("build snippets include required IDs", () => {
    expect(buildAnalyticsHeadHtml()).toMatch(/G-QBGF94YE7C/);
    expect(buildAnalyticsBodyHtml()).toMatch(/sendBeacon/);
  });

  it("pathToKvKey maps article paths", () => {
    expect(pathToKvKey("/cat-toys/foo-review")).toBe("cat-toys:foo-review");
    expect(pathToKvKey("/cat-toys/foo-review/")).toBe("cat-toys:foo-review");
    expect(pathToKvKey("/")).toBeNull();
  });

  it("normalizeAffiliateClick extracts ASIN", () => {
    const n = normalizeAffiliateClick({
      href: "https://www.amazon.com/dp/B0ABCDEF12?tag=catsluvus03-20",
      path: "/cat-apparel/bee-costume-review",
      text: "Check price"
    });
    expect(n?.asin).toBe("B0ABCDEF12");
    expect(n?.path).toBe("/cat-apparel/bee-costume-review");
    expect(normalizeAffiliateClick({})).toBeNull();
  });
});
