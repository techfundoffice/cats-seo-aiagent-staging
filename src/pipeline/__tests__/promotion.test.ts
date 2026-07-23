import { describe, expect, it } from "vitest";
import { classifyUserAgent, rewriteHtmlForDomain } from "../promotion";

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
    expect(out).toContain(`https://${PROD}/cat-toys/best-cat-toy`);
    expect(out).toContain(`https://${PROD}/cat-beds/heated-cat-bed`);
    expect(replacements).toBe(4);
  });

  it("covers http:// and protocol-relative references", () => {
    const html = `<a href="http://${STAGING}/a/b">x</a><img src="//${STAGING}/i.png">`;
    const { html: out } = rewriteHtmlForDomain(html, STAGING, PROD);
    expect(out).toContain(`https://${PROD}/a/b`);
    expect(out).toContain(`https://${PROD}/i.png`);
    expect(out).not.toContain(STAGING);
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
    const { mergeCategoryIndex } = await import("../promotion");
    const first = mergeCategoryIndex(`["a-slug"]`, "b-slug");
    expect(JSON.parse(first.json)).toEqual(["a-slug", "b-slug"]);
    expect(first.changed).toBe(true);
    const again = mergeCategoryIndex(first.json, "b-slug");
    expect(again.changed).toBe(false);
  });

  it("starts a fresh category index when the key is missing or corrupt", async () => {
    const { mergeCategoryIndex } = await import("../promotion");
    expect(JSON.parse(mergeCategoryIndex(null, "x").json)).toEqual(["x"]);
    expect(JSON.parse(mergeCategoryIndex("not json", "x").json)).toEqual(["x"]);
  });

  it("appends to the global index deduped by slug+category", async () => {
    const { mergeGlobalIndex } = await import("../promotion");
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
    const { extractArticleTitleForIndex } = await import("../promotion");
    const html = `<title>Meta Title | Best Picks 2026</title><h1 class="x">Luxury Cat Carrier with <em>Plush</em> Bedding</h1>`;
    expect(extractArticleTitleForIndex(html, "slug")).toBe(
      "Luxury Cat Carrier with Plush Bedding"
    );
  });

  it("falls back to the title tag minus its pipe suffix, then the slug", async () => {
    const { extractArticleTitleForIndex } = await import("../promotion");
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
