import { describe, expect, it } from "vitest";
import {
  articlePathForHost,
  articlePathToKvKey,
  articleUrlsShareKvKey,
  prefixReviewsOnArticlePath,
  prodArticleUrl,
  REVIEWS_PATH_PREFIX,
  workshopArticlePath
} from "../article-public-url";

describe("article public URLs", () => {
  it("keeps workshop paths two-segment and prefixes production", () => {
    expect(workshopArticlePath("cat-toys", "best-toy")).toBe(
      "/cat-toys/best-toy"
    );
    expect(prodArticleUrl("catsluvus.com", "cat-toys", "best-toy")).toBe(
      "https://catsluvus.com/reviews/cat-toys/best-toy"
    );
    expect(REVIEWS_PATH_PREFIX).toBe("/reviews");
    expect(
      articlePathForHost(
        "cats-seo-aiagent-staging.webmaster-bc8.workers.dev",
        "cat-toys",
        "best-toy"
      )
    ).toBe("/cat-toys/best-toy");
    expect(
      articlePathForHost("www.catsluvus.com", "cat-toys", "best-toy")
    ).toBe("/reviews/cat-toys/best-toy");
  });

  it("maps both path shapes to the same kv key and ignores non-articles", () => {
    expect(articlePathToKvKey("/cat-food/best-cat-food")).toBe(
      "cat-food:best-cat-food"
    );
    expect(articlePathToKvKey("/reviews/cat-food/best-cat-food/")).toBe(
      "cat-food:best-cat-food"
    );
    expect(articlePathToKvKey("/")).toBeNull();
    expect(articlePathToKvKey("/reviews")).toBeNull();
    // Legacy two-segment: a category literally named "reviews".
    expect(articlePathToKvKey("/reviews/cat-food")).toBe("reviews:cat-food");
    expect(articlePathToKvKey("/a/b/c")).toBeNull();
    expect(articlePathToKvKey("/reviews/cat-food/best/extra")).toBeNull();
  });

  it("inserts /reviews once, preserving query and hash", () => {
    expect(prefixReviewsOnArticlePath("/cat-toys/best-toy")).toBe(
      "/reviews/cat-toys/best-toy"
    );
    expect(prefixReviewsOnArticlePath("/cat-toys/best-toy/")).toBe(
      "/reviews/cat-toys/best-toy/"
    );
    expect(prefixReviewsOnArticlePath("/cat-toys/best-toy?utm=1#s")).toBe(
      "/reviews/cat-toys/best-toy?utm=1#s"
    );
    expect(prefixReviewsOnArticlePath("/reviews/cat-toys/best-toy")).toBe(
      "/reviews/cat-toys/best-toy"
    );
    expect(prefixReviewsOnArticlePath("/Reviews/cat-toys/best-toy")).toBe(
      "/Reviews/cat-toys/best-toy"
    );
    expect(prefixReviewsOnArticlePath("/logo.png")).toBe("/logo.png");
    expect(prefixReviewsOnArticlePath("/cat-toys")).toBe("/cat-toys");
  });

  it("treats legacy and /reviews URLs as the same article", () => {
    expect(
      articleUrlsShareKvKey(
        "https://catsluvus.com/cat-toys/best-toy",
        "https://catsluvus.com/reviews/cat-toys/best-toy"
      )
    ).toBe(true);
    expect(
      articleUrlsShareKvKey(
        "https://catsluvus.com/cat-toys/best-toy",
        "https://catsluvus.com/reviews/cat-toys/other"
      )
    ).toBe(false);
  });
});
