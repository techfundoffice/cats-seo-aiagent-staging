import { describe, expect, it, vi } from "vitest";
import type { SEOArticleAgent } from "../../server";
import { updateRssFeed } from "../feed-syndication";

describe("updateRssFeed", () => {
  it("falls back to the current time when pubDateIso is invalid", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const agent = {
      envBindings: {
        DOMAIN: "catsluvus.com",
        ARTICLES_KV: {
          get: vi.fn().mockResolvedValue(null),
          put
        }
      },
      log: vi.fn()
    };

    const result = await updateRssFeed(agent as unknown as SEOArticleAgent, {
      title: "Versatile cat climbing ramps for multi-cat apartments",
      metaDescription: "A practical guide to shared-space climbing ramps.",
      canonicalUrl:
        "https://catsluvus.com/cat-climbing-ramps-for-multi-cat-households/versatile-cat-climbing-ramps-for-multi-cat-apartments",
      categorySlug: "cat-climbing-ramps-for-multi-cat-households",
      pubDateIso: "not-a-date"
    });

    const writtenXml = put.mock.calls[0]?.[1];
    expect(result).toEqual({
      itemCount: 1,
      feedUrl: "https://catsluvus.com/feed.rss",
      created: true
    });
    expect(typeof writtenXml).toBe("string");
    expect(writtenXml).toContain("<pubDate>");
    expect(writtenXml).not.toContain("NaN");
    expect(writtenXml).not.toContain("undefined");
    expect(agent.log).toHaveBeenCalledTimes(1);
    expect(agent.log.mock.calls[0]?.[0]).toBe("warning");
    expect(agent.log.mock.calls[0]?.[1]).toContain(
      "RSS feed: invalid pubDateIso"
    );
  });
});
