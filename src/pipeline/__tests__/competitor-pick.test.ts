import { describe, expect, it } from "vitest";
import {
  rankSerpUrlsForEditorialCompetitor,
  shouldSkipCompetitorUrl
} from "../competitorPick";

describe("shouldSkipCompetitorUrl", () => {
  it("skips Amazon domains but not unrelated lookalikes", () => {
    expect(shouldSkipCompetitorUrl("https://smile.amazon.co.uk/dp/B0123")).toBe(
      true
    );
    expect(
      shouldSkipCompetitorUrl("https://notamazon.com/best-cat-wheelchairs")
    ).toBe(false);
  });
});

describe("rankSerpUrlsForEditorialCompetitor", () => {
  it("dedupes equivalent URLs that differ only by query ordering and trailing slash", () => {
    const urls = [
      "https://cats.com/reviews/wheelchairs/?b=2&a=1",
      "https://cats.com/reviews/wheelchairs?a=1&b=2",
      "https://www.wirecutter.com/reviews/best-cat-wheelchair/"
    ];
    const titles = [
      "Cats.com review",
      "Cats.com review duplicate",
      "Wirecutter best cat wheelchair"
    ];

    const ranked = rankSerpUrlsForEditorialCompetitor(urls, titles);
    const catsComUrls = ranked.filter((url) =>
      url.includes("cats.com/reviews")
    );
    expect(catsComUrls).toHaveLength(1);
  });

  it("prefers Chewy knowledge-hub roots even without a trailing slash", () => {
    const ranked = rankSerpUrlsForEditorialCompetitor(
      [
        "https://www.chewy.com/blog/best-heavy-duty-cat-stairs",
        "https://www.chewy.com/learn"
      ],
      ["Chewy blog post", "Chewy learn"]
    );

    expect(ranked[0]).toBe("https://www.chewy.com/learn");
  });
});
