import { beforeEach, describe, expect, it } from "vitest";
import { removeUrlFromSitemap, SITEMAP_KV_KEY } from "../indexing";

/**
 * Regression guards for sitemap cleanup on promotion.
 *
 * When a staging article is promoted, its staging URL becomes a 301 to the
 * production copy. A sitemap must advertise canonical, indexable URLs — a
 * listed redirect shows up in Search Console as "Page with redirect" and
 * wastes crawl budget. Before this fix, promotion wrote the redirect
 * tombstone but left the URL in the sitemap forever.
 */

/** Minimal in-memory KVNamespace stub — only get/put are exercised. */
function makeKv(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(SITEMAP_KV_KEY, initial);
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    }
  } as unknown as KVNamespace & { store: Map<string, string> };
}

const HOST = "https://cats-seo-aiagent-staging.webmaster-bc8.workers.dev";
const A = `${HOST}/cat-toys/retro-shaw-cat-toys-balls-review`;
const B = `${HOST}/cat-food/purina-friskies-natural-review`;

function sitemapWith(...urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((u) => `  <url><loc>${u}</loc><lastmod>2026-08-02</lastmod></url>`)
  .join("\n")}
</urlset>`;
}

describe("removeUrlFromSitemap", () => {
  let kv: KVNamespace & { store: Map<string, string> };

  beforeEach(() => {
    kv = makeKv(sitemapWith(A, B));
  });

  it("removes the promoted URL and reports the change", async () => {
    const changed = await removeUrlFromSitemap(kv, A);
    expect(changed).toBe(true);
    const after = kv.store.get(SITEMAP_KV_KEY)!;
    expect(after).not.toContain(A);
  });

  it("leaves every other URL intact", async () => {
    await removeUrlFromSitemap(kv, A);
    const after = kv.store.get(SITEMAP_KV_KEY)!;
    expect(after).toContain(`<loc>${B}</loc>`);
    expect(after.match(/<url>/g) ?? []).toHaveLength(1);
  });

  it("keeps the document well-formed after removal", async () => {
    await removeUrlFromSitemap(kv, A);
    const after = kv.store.get(SITEMAP_KV_KEY)!;
    expect(after.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(
      true
    );
    expect(after).toContain("<urlset");
    expect(after).toContain("</urlset>");
  });

  it("removing the only URL leaves a valid empty sitemap", async () => {
    const single = makeKv(sitemapWith(A));
    expect(await removeUrlFromSitemap(single, A)).toBe(true);
    const after = single.store.get(SITEMAP_KV_KEY)!;
    expect(after).toContain("<urlset");
    expect(after).toContain("</urlset>");
    expect(after).not.toContain("<url>");
  });

  it("is a no-op for a URL that is not listed", async () => {
    const before = kv.store.get(SITEMAP_KV_KEY);
    const changed = await removeUrlFromSitemap(kv, `${HOST}/cat-beds/nope`);
    expect(changed).toBe(false);
    expect(kv.store.get(SITEMAP_KV_KEY)).toBe(before);
  });

  it("is a no-op when the sitemap key does not exist yet", async () => {
    const empty = makeKv();
    expect(await removeUrlFromSitemap(empty, A)).toBe(false);
  });

  it("does not remove a URL that merely prefixes the target", async () => {
    // "…-review" must not take "…-review-2" with it.
    const long = `${A}-2`;
    const withBoth = makeKv(sitemapWith(A, long));
    await removeUrlFromSitemap(withBoth, A);
    const after = withBoth.store.get(SITEMAP_KV_KEY)!;
    expect(after).toContain(`<loc>${long}</loc>`);
    expect(after).not.toContain(`<loc>${A}</loc>`);
  });

  it("handles a URL containing regex-significant characters", async () => {
    const tricky = `${HOST}/cat-toys/a+b(c)review?x=1`;
    const withTricky = makeKv(sitemapWith(tricky, B));
    // `&` would be XML-escaped by the writer; `?`/`+`/`()` are stored raw and
    // would break a naive regex built by interpolating the URL.
    expect(await removeUrlFromSitemap(withTricky, tricky)).toBe(true);
    const after = withTricky.store.get(SITEMAP_KV_KEY)!;
    expect(after).not.toContain(tricky);
    expect(after).toContain(`<loc>${B}</loc>`);
  });

  it("removes an XML-escaped entry when the URL contains an ampersand", async () => {
    // The writer stores `&` escaped as `&amp;`, so the lookup has to escape
    // the raw URL the caller passes in before matching.
    const raw = `${HOST}/cat-toys/a&b-review`;
    const withAmp = makeKv(sitemapWith(raw.replace("&", "&amp;"), B));
    expect(await removeUrlFromSitemap(withAmp, raw)).toBe(true);
    const after = withAmp.store.get(SITEMAP_KV_KEY)!;
    expect(after).not.toContain("a&amp;b-review");
    expect(after).toContain(`<loc>${B}</loc>`);
  });

  it("swallows KV failures rather than failing the promotion", async () => {
    const broken = {
      get: async () => {
        throw new Error("KV unavailable");
      },
      put: async () => {}
    } as unknown as KVNamespace;
    await expect(removeUrlFromSitemap(broken, A)).resolves.toBe(false);
  });
});
