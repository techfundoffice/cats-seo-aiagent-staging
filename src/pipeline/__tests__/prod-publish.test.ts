import { describe, expect, it } from "vitest";
import { classifyUserAgent, rewriteHtmlForDomain } from "../prod-publish";

const STAGING = "cats-seo-aiagent-staging.webmaster-bc8.workers.dev";
const PROD = "catsluvus.com";

describe("rewriteHtmlForDomain", () => {
  it("rewrites canonical, og:url, and internal links to the target host", () => {
    const html = [
      `<link rel="canonical" href="https://${STAGING}/cat-toys/best-cat-toy">`,
      `<meta property="og:url" content="https://${STAGING}/cat-toys/best-cat-toy">`,
      `<a href="https://${STAGING}/cat-beds/heated-cat-bed">related</a>`,
      `"@id": "https://${STAGING}/cat-toys/best-cat-toy"`
    ].join("\n");
    const { html: out, replacements } = rewriteHtmlForDomain(
      html,
      STAGING,
      PROD
    );
    expect(out).not.toContain(STAGING);
    expect(out).toContain(`https://${PROD}/reviews/cat-toys/best-cat-toy`);
    expect(out).toContain(`https://${PROD}/reviews/cat-beds/heated-cat-bed`);
    expect(out).not.toContain(`https://${PROD}/cat-toys/best-cat-toy`);
    expect(replacements).toBe(4);
  });

  it("covers http:// and protocol-relative references", () => {
    const html = `<a href="http://${STAGING}/a/b">x</a><img src="//${STAGING}/i.png">`;
    const { html: out } = rewriteHtmlForDomain(html, STAGING, PROD);
    expect(out).toContain(`https://${PROD}/reviews/a/b`);
    expect(out).toContain(`https://${PROD}/i.png`);
    expect(out).not.toContain(STAGING);
  });

  it("prefixes article paths and leaves one-segment assets and hashes", () => {
    const html = [
      `<link rel="canonical" href="https://${STAGING}/cat-toys/best-toy#section-1">`,
      `<a href="https://${STAGING}/cat-toys">category</a>`,
      `<link rel="icon" href="https://${STAGING}/logo.png">`,
      `<a href="https://${STAGING}/feed.rss">rss</a>`,
      `<a href="https://catsluvus.com/author/amelia-hartwell">author</a>`
    ].join("\n");
    const { html: out } = rewriteHtmlForDomain(html, STAGING, PROD);
    expect(out).toContain(
      `https://${PROD}/reviews/cat-toys/best-toy#section-1`
    );
    expect(out).toContain(`https://${PROD}/cat-toys`);
    expect(out).not.toContain(`https://${PROD}/reviews/cat-toys"`);
    expect(out).toContain(`https://${PROD}/logo.png`);
    expect(out).toContain(`https://${PROD}/feed.rss`);
    expect(out).toContain("https://catsluvus.com/author/amelia-hartwell");
  });

  it("does not double-prefix a path that already starts with /reviews", () => {
    const html = `<link rel="canonical" href="https://${STAGING}/reviews/cat-toys/best-toy">`;
    const { html: out } = rewriteHtmlForDomain(html, STAGING, PROD);
    expect(out).toContain(`https://${PROD}/reviews/cat-toys/best-toy`);
    expect(out).not.toContain("/reviews/reviews/");
  });

  it("leaves third-party URLs untouched", () => {
    const html = `<a href="https://www.amazon.com/dp/B01ABCDE23?tag=catsluvus03-20">amazon</a>`;
    const { html: out, replacements } = rewriteHtmlForDomain(
      html,
      STAGING,
      PROD
    );
    expect(out).toBe(html);
    expect(replacements).toBe(0);
  });

  it("no-ops when from and to hosts are equal", () => {
    const html = `<a href="https://${PROD}/x/y">x</a>`;
    expect(rewriteHtmlForDomain(html, PROD, PROD).replacements).toBe(0);
  });
});

describe("classifyUserAgent", () => {
  it("recognizes Googlebot and the URL inspection tool", () => {
    expect(
      classifyUserAgent(
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
      )
    ).toBe("googlebot");
    expect(
      classifyUserAgent("Mozilla/5.0 (compatible; Google-InspectionTool/1.0)")
    ).toBe("googlebot");
  });

  it("filters non-Google bots and headless browsers", () => {
    expect(classifyUserAgent("Mozilla/5.0 (compatible; AhrefsBot/7.0)")).toBe(
      "other-bot"
    );
    expect(
      classifyUserAgent("Mozilla/5.0 HeadlessChrome/125.0.0.0 Safari/537.36")
    ).toBe("other-bot");
    expect(classifyUserAgent("curl/8.5.0")).toBe("other-bot");
  });

  it("counts ordinary browsers as human", () => {
    expect(
      classifyUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      )
    ).toBe("human");
  });
});

describe("index merge helpers", () => {
  it("appends a new slug to a category index and dedupes repeats", async () => {
    const { mergeCategoryIndex } = await import("../prod-publish");
    const first = mergeCategoryIndex(`["a-slug"]`, "b-slug");
    expect(JSON.parse(first.json)).toEqual(["a-slug", "b-slug"]);
    expect(first.changed).toBe(true);
    const again = mergeCategoryIndex(first.json, "b-slug");
    expect(again.changed).toBe(false);
  });

  it("starts a fresh category index when the key is missing or corrupt", async () => {
    const { mergeCategoryIndex } = await import("../prod-publish");
    expect(JSON.parse(mergeCategoryIndex(null, "x").json)).toEqual(["x"]);
    expect(JSON.parse(mergeCategoryIndex("not json", "x").json)).toEqual(["x"]);
  });

  it("appends to the global index deduped by slug+category", async () => {
    const { mergeGlobalIndex } = await import("../prod-publish");
    const entry = {
      slug: "s",
      url: "/c/s",
      title: "T",
      category: "c",
      image: null
    };
    const first = mergeGlobalIndex("[]", entry);
    expect(first.changed).toBe(true);
    expect(mergeGlobalIndex(first.json, entry).changed).toBe(false);
  });
});

describe("extractArticleTitleForIndex", () => {
  it("prefers the H1 text", async () => {
    const { extractArticleTitleForIndex } = await import("../prod-publish");
    const html = `<title>Meta Title | Best Picks 2026</title><h1 class="x">Luxury Cat Carrier with <em>Plush</em> Bedding</h1>`;
    expect(extractArticleTitleForIndex(html, "slug")).toBe(
      "Luxury Cat Carrier with Plush Bedding"
    );
  });

  it("falls back to the title tag minus its pipe suffix, then the slug", async () => {
    const { extractArticleTitleForIndex } = await import("../prod-publish");
    expect(
      extractArticleTitleForIndex(
        `<title>Great Cat Beds | Best Picks 2026</title>`,
        "slug"
      )
    ).toBe("Great Cat Beds");
    expect(extractArticleTitleForIndex("", "great-cat-beds")).toBe(
      "Great Cat Beds"
    );
  });
});

describe("prodKvRestApi", () => {
  it("builds the REST base + auth header from env bindings", async () => {
    const { prodKvRestApi } = await import("../prod-publish");
    const api = prodKvRestApi({
      CLOUDFLARE_ACCOUNT_ID: "acct123",
      CLOUDFLARE_API_TOKEN: "tok456",
      PROD_ARTICLES_KV_NAMESPACE_ID: "ns789"
    });
    expect(api).not.toBeNull();
    expect(api?.base).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/storage/kv/namespaces/ns789/values"
    );
    expect(api?.headers.Authorization).toBe("Bearer tok456");
  });

  it("falls back to the default prod namespace id", async () => {
    const { prodKvRestApi, DEFAULT_PROD_ARTICLES_KV_NAMESPACE_ID } =
      await import("../prod-publish");
    const api = prodKvRestApi({
      CLOUDFLARE_ACCOUNT_ID: "acct123",
      CLOUDFLARE_API_TOKEN: "tok456"
    });
    expect(api?.base).toContain(DEFAULT_PROD_ARTICLES_KV_NAMESPACE_ID);
  });

  it("returns null when credentials are missing", async () => {
    const { prodKvRestApi } = await import("../prod-publish");
    expect(prodKvRestApi({})).toBeNull();
    expect(prodKvRestApi({ CLOUDFLARE_ACCOUNT_ID: "acct123" })).toBeNull();
  });
});

describe("prod publish score bar", () => {
  it("defaults a blank or non-positive binding to 90", async () => {
    const { resolveProdPublishMinScore, DEFAULT_PROD_PUBLISH_MIN_SCORE } =
      await import("../prod-publish");
    expect(resolveProdPublishMinScore(undefined)).toBe(
      DEFAULT_PROD_PUBLISH_MIN_SCORE
    );
    expect(resolveProdPublishMinScore("")).toBe(90);
    expect(resolveProdPublishMinScore("0")).toBe(90);
    expect(resolveProdPublishMinScore("nope")).toBe(90);
    expect(resolveProdPublishMinScore("95")).toBe(95);
  });

  it("refuses to lower the configured bar", async () => {
    const { clampProdPublishMinScore } = await import("../prod-publish");
    expect(clampProdPublishMinScore(90, 50)).toBe(90);
    expect(clampProdPublishMinScore(90, undefined)).toBe(90);
    expect(clampProdPublishMinScore(90, 97)).toBe(97);
  });
});

describe("decideProdPromotion", () => {
  const base = {
    kvKey: "cat-toys:best-toy",
    minScore: 90,
    ledgerScore: null as number | null,
    hasStagingHtml: true,
    hasRedirectTombstone: false,
    rescored: null as number | null,
    allowUnscoredCompleted: false
  };

  it("promotes a ledger score on the bar and ignores a lower rescore", async () => {
    const { decideProdPromotion } = await import("../prod-publish");
    const decision = decideProdPromotion({
      ...base,
      ledgerScore: 90,
      rescored: 10
    });
    expect(decision).toMatchObject({
      promote: true,
      score: 90,
      scoreSource: "ledger"
    });
  });

  it("keeps a below-bar ledger score in staging even if unscored shipping is allowed", async () => {
    const { decideProdPromotion } = await import("../prod-publish");
    const decision = decideProdPromotion({
      ...base,
      ledgerScore: 89,
      rescored: 100,
      allowUnscoredCompleted: true
    });
    expect(decision).toMatchObject({
      promote: false,
      reason: "below-bar",
      score: 89,
      scoreSource: "ledger"
    });
  });

  it("treats ledger score 0 as unscored and uses the rescore", async () => {
    const { decideProdPromotion } = await import("../prod-publish");
    expect(
      decideProdPromotion({ ...base, ledgerScore: 0, rescored: 94 })
    ).toMatchObject({ promote: true, score: 94, scoreSource: "rescore" });
    expect(
      decideProdPromotion({ ...base, ledgerScore: 0, rescored: 70 })
    ).toMatchObject({ promote: false, reason: "below-bar", score: 70 });
  });

  it("ships completed HTML with no computable score only when explicitly allowed", async () => {
    const { decideProdPromotion } = await import("../prod-publish");
    expect(decideProdPromotion(base)).toMatchObject({
      promote: false,
      reason: "unscored"
    });
    expect(
      decideProdPromotion({ ...base, allowUnscoredCompleted: true })
    ).toMatchObject({
      promote: true,
      scoreSource: "unscored-completed"
    });
  });

  it("skips tombstones and missing HTML", async () => {
    const { decideProdPromotion } = await import("../prod-publish");
    expect(
      decideProdPromotion({
        ...base,
        ledgerScore: 99,
        hasRedirectTombstone: true
      }).reason
    ).toBe("already-promoted");
    expect(
      decideProdPromotion({
        ...base,
        ledgerScore: 99,
        hasStagingHtml: false
      }).reason
    ).toBe("missing-html");
    expect(decideProdPromotion({ ...base, kvKey: "not-a-key" }).reason).toBe(
      "invalid-key"
    );
  });
});

describe("sitemap promotion summary", () => {
  it("counts ledger-eligible, below-bar, unscored, and tombstoned keys", async () => {
    const { summarizePromotionCandidates, articleKvKeysFromSitemap } =
      await import("../prod-publish");
    const xml = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://staging.example/cat-toys/best-toy</loc></url>
  <url><loc>https://staging.example/reviews/cat-beds/heated</loc></url>
  <url><loc>https://staging.example/about</loc></url>
  <url><loc>https://staging.example/cat-trees/tall-tree</loc></url>
</urlset>`;
    const kvKeys = articleKvKeysFromSitemap(xml);
    expect(kvKeys).toEqual([
      "cat-beds:heated",
      "cat-toys:best-toy",
      "cat-trees:tall-tree"
    ]);
    const summary = summarizePromotionCandidates({
      kvKeys,
      tombstones: new Set(["cat-beds:heated"]),
      ledger: new Map([
        ["cat-toys:best-toy", { seoScore: 96 }],
        ["cat-trees:tall-tree", { seoScore: 40 }]
      ]),
      minScore: 90
    });
    expect(summary).toMatchObject({
      sitemapArticles: 3,
      alreadyPromoted: 1,
      eligibleByLedger: 1,
      belowBar: 1,
      unscored: 0,
      sampleEligible: ["cat-toys:best-toy"]
    });
  });

  it("keeps a stored ledger score when HTML would rescore differently", async () => {
    const { assessStagingArticleForPromotion } =
      await import("../prod-publish");
    const decision = assessStagingArticleForPromotion({
      kvKey: "cat-toys:best-toy",
      html: "<html><title>x</title><h1>x</h1><p>short</p></html>",
      minScore: 90,
      ledgerScore: 93,
      ledgerKeyword: "cat toys",
      hasRedirectTombstone: false,
      allowUnscoredCompleted: true
    });
    expect(decision).toMatchObject({
      promote: true,
      score: 93,
      scoreSource: "ledger"
    });
  });

  it("derives a rescore keyword from the category slug", async () => {
    const { keywordForProdRescore } = await import("../prod-publish");
    expect(keywordForProdRescore("cat-trees", "  best cat trees  ")).toBe(
      "best cat trees"
    );
    expect(keywordForProdRescore("cat-trees", "")).toBe("cat trees");
  });
});
