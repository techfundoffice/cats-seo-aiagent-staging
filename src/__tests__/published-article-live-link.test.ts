import { describe, expect, it } from "vitest";
import { resolvePublishedArticleLink } from "../publishedArticleLiveLink";

const STAGING =
  "https://cats-seo-aiagent-staging.webmaster-bc8.workers.dev/cat-toys/x-review";
const PROD = "https://catsluvus.com/cat-toys/x-review";

describe("resolvePublishedArticleLink", () => {
  it("links a promoted article at production, not the 301 tombstone", () => {
    const r = resolvePublishedArticleLink({
      url: STAGING,
      prodUrl: PROD,
      promotionStatus: "published-prod"
    });
    expect(r).toEqual({
      promoted: true,
      promotionKnown: true,
      href: PROD,
      label: "prod"
    });
  });

  it("labels a below-the-bar article staging-only instead of live", () => {
    // The exact shape of the 13/50 rows observed on the live dashboard:
    // score under PROD_PUBLISH_MIN_SCORE, so prod-publish never ran and the
    // article 404s on catsluvus.com.
    const r = resolvePublishedArticleLink({
      url: STAGING,
      promotionStatus: "staging-only"
    });
    expect(r.promoted).toBe(false);
    expect(r.promotionKnown).toBe(true);
    expect(r.href).toBe(STAGING);
    expect(r.label).toBe("staging only");
  });

  it("treats a legacy row with no promotion fields as unknown", () => {
    const r = resolvePublishedArticleLink({ url: STAGING });
    expect(r.promoted).toBe(false);
    expect(r.promotionKnown).toBe(false);
    expect(r.label).toBe("unknown");
    expect(r.href).toBe(STAGING);
  });

  it("infers promotion from a bare prodUrl on a legacy row", () => {
    const r = resolvePublishedArticleLink({ url: STAGING, prodUrl: PROD });
    expect(r.promoted).toBe(true);
    expect(r.promotionKnown).toBe(true);
    expect(r.href).toBe(PROD);
  });

  it("falls back to staging when a promoted row lost its prodUrl", () => {
    const r = resolvePublishedArticleLink({
      url: STAGING,
      promotionStatus: "published-prod"
    });
    expect(r.promoted).toBe(true);
    expect(r.href).toBe(STAGING);
  });

  it("never returns a whitespace-only href or a phantom promotion", () => {
    const r = resolvePublishedArticleLink({ url: "  ", prodUrl: "  " });
    expect(r.promoted).toBe(false);
    expect(r.promotionKnown).toBe(false);
    expect(r.href).toBe("");
  });
});
