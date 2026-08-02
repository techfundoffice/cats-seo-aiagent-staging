import { describe, expect, it } from "vitest";
import { pruneRedirectedFromSitemap, SITEMAP_KV_KEY } from "../indexing";

/**
 * Backlog cleanup for the sitemap.
 *
 * `removeUrlFromSitemap()` keeps the sitemap clean going forward, but articles
 * promoted before it existed left their staging URLs listed. Those URLs only
 * 301 to production now, so the sitemap advertises redirects. This prunes them
 * using the `redirect:<kvKey>` tombstone as the authority.
 */

const DOMAIN = "staging.example.dev";

function makeKv(sitemap: string, redirectKeys: string[] = []) {
  const store = new Map<string, string>();
  const listCalls: string[] = [];
  const getCalls: string[] = [];
  store.set(SITEMAP_KV_KEY, sitemap);
  for (const k of redirectKeys) {
    store.set(
      `redirect:${k}`,
      `https://prod.example.com/${k.replace(":", "/")}`
    );
  }
  return {
    store,
    listCalls,
    getCalls,
    get: async (key: string) => {
      getCalls.push(key);
      return store.get(key) ?? null;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    list: async ({ prefix }: { prefix?: string } = {}) => {
      listCalls.push(prefix ?? "");
      const keys = [...store.keys()]
        .filter((k) => (prefix ? k.startsWith(prefix) : true))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    }
  } as unknown as KVNamespace & {
    store: Map<string, string>;
    listCalls: string[];
    getCalls: string[];
  };
}

function sitemapWith(...paths: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths
  .map(
    (p) =>
      `  <url><loc>https://${DOMAIN}${p}</loc><lastmod>2026-08-02</lastmod></url>`
  )
  .join("\n")}
</urlset>`;
}

describe("pruneRedirectedFromSitemap", () => {
  it("removes entries whose article has a redirect tombstone", async () => {
    const kv = makeKv(sitemapWith("/cat-toys/a", "/cat-food/b"), [
      "cat-toys:a"
    ]);
    const result = await pruneRedirectedFromSitemap(kv, DOMAIN);
    expect(result.removed).toBe(1);
    expect(result.before).toBe(2);
    expect(result.after).toBe(1);
    expect(result.changed).toBe(true);
    const after = kv.store.get(SITEMAP_KV_KEY)!;
    expect(after).not.toContain("/cat-toys/a<");
    expect(after).toContain("/cat-food/b");
  });

  it("keeps entries that have no tombstone", async () => {
    const kv = makeKv(sitemapWith("/cat-toys/a", "/cat-food/b"));
    const result = await pruneRedirectedFromSitemap(kv, DOMAIN);
    expect(result.removed).toBe(0);
    expect(result.changed).toBe(false);
    expect(kv.store.get(SITEMAP_KV_KEY)).toContain("/cat-toys/a");
  });

  it("is idempotent — a second run removes nothing more", async () => {
    const kv = makeKv(sitemapWith("/cat-toys/a", "/cat-food/b"), [
      "cat-toys:a"
    ]);
    await pruneRedirectedFromSitemap(kv, DOMAIN);
    const second = await pruneRedirectedFromSitemap(kv, DOMAIN);
    expect(second.removed).toBe(0);
    expect(second.changed).toBe(false);
  });

  it("leaves URLs on other hosts alone", async () => {
    const foreign = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://other.example.com/cat-toys/a</loc><lastmod>2026-08-02</lastmod></url>
</urlset>`;
    const kv = makeKv(foreign, ["cat-toys:a"]);
    const result = await pruneRedirectedFromSitemap(kv, DOMAIN);
    expect(result.removed).toBe(0);
    expect(kv.store.get(SITEMAP_KV_KEY)).toContain("other.example.com");
  });

  it("ignores paths that are not exactly category/slug", async () => {
    // A one-segment or three-segment path is not an article kvKey.
    const kv = makeKv(sitemapWith("/about", "/a/b/c"), ["cat-toys:a"]);
    const result = await pruneRedirectedFromSitemap(kv, DOMAIN);
    expect(result.removed).toBe(0);
    expect(kv.store.get(SITEMAP_KV_KEY)).toContain("/about");
  });

  it("returns a zeroed result when the sitemap key is absent", async () => {
    const kv = {
      get: async () => null,
      put: async () => {},
      list: async () => ({ keys: [], list_complete: true })
    } as unknown as KVNamespace;
    const result = await pruneRedirectedFromSitemap(kv, DOMAIN);
    expect(result).toMatchObject({
      before: 0,
      after: 0,
      removed: 0,
      changed: false
    });
  });

  it("keeps the document well-formed and reports a sample", async () => {
    const kv = makeKv(sitemapWith("/c/a", "/c/b", "/c/keep"), ["c:a", "c:b"]);
    const result = await pruneRedirectedFromSitemap(kv, DOMAIN);
    expect(result.removed).toBe(2);
    expect(result.removedSample.length).toBe(2);
    const after = kv.store.get(SITEMAP_KV_KEY)!;
    expect(after.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(
      true
    );
    expect(after).toContain("</urlset>");
    expect(after).toContain("/c/keep");
    expect(after.match(/<url>/g) ?? []).toHaveLength(1);
  });

  it("does not take a longer sibling down with a pruned URL", async () => {
    // "/c/a" is a prefix of "/c/a-2"; only the tombstoned one may go.
    const kv = makeKv(sitemapWith("/c/a", "/c/a-2"), ["c:a"]);
    await pruneRedirectedFromSitemap(kv, DOMAIN);
    const after = kv.store.get(SITEMAP_KV_KEY)!;
    expect(after).toContain("/c/a-2<");
    expect(after).not.toContain("/c/a<");
  });
});

describe("pruneRedirectedFromSitemap — dry run", () => {
  it("reports what would go without writing to KV", async () => {
    // Writing then restoring would briefly serve a pruned sitemap to real
    // crawlers, and an error before the restore would make it permanent.
    const kv = makeKv(sitemapWith("/c/a", "/c/b"), ["c:a"]);
    const original = kv.store.get(SITEMAP_KV_KEY)!;
    const result = await pruneRedirectedFromSitemap(kv, DOMAIN, {
      dryRun: true
    });
    expect(result.removed).toBe(1);
    expect(result.before).toBe(2);
    expect(result.after).toBe(1);
    expect(result.changed).toBe(true);
    expect(kv.store.get(SITEMAP_KV_KEY)).toBe(original);
  });

  it("leaves the sitemap byte-identical even when everything would go", async () => {
    const kv = makeKv(sitemapWith("/c/a", "/c/b"), ["c:a", "c:b"]);
    const original = kv.store.get(SITEMAP_KV_KEY)!;
    await pruneRedirectedFromSitemap(kv, DOMAIN, { dryRun: true });
    expect(kv.store.get(SITEMAP_KV_KEY)).toBe(original);
  });

  it("a real run after a dry run still removes the entries", async () => {
    const kv = makeKv(sitemapWith("/c/a", "/c/b"), ["c:a"]);
    await pruneRedirectedFromSitemap(kv, DOMAIN, { dryRun: true });
    const real = await pruneRedirectedFromSitemap(kv, DOMAIN);
    expect(real.removed).toBe(1);
    expect(kv.store.get(SITEMAP_KV_KEY)).not.toContain("/c/a<");
  });
});

describe("pruneRedirectedFromSitemap — tombstone lookup cost", () => {
  it("reads tombstones via one prefixed list, not a get per entry", async () => {
    // ~3.5k sequential gets would blow the admin request's time budget.
    const kv = makeKv(sitemapWith("/c/a", "/c/b", "/c/c", "/c/d"), ["c:a"]);
    await pruneRedirectedFromSitemap(kv, DOMAIN);
    expect(kv.listCalls).toEqual(["redirect:"]);
    // The only get is the sitemap itself — no per-entry tombstone reads.
    expect(kv.getCalls).toEqual([SITEMAP_KV_KEY]);
  });

  it("short-circuits when no tombstones exist at all", async () => {
    const kv = makeKv(sitemapWith("/c/a", "/c/b"));
    const result = await pruneRedirectedFromSitemap(kv, DOMAIN);
    expect(result.removed).toBe(0);
    expect(result.before).toBe(2);
    expect(result.changed).toBe(false);
  });
});

describe("pruneRedirectedFromSitemap — domain normalization", () => {
  const cases: Array<[string, string]> = [
    ["surrounding whitespace", `  ${DOMAIN} `],
    ["a scheme", `https://${DOMAIN}`],
    ["a scheme and trailing path", `https://${DOMAIN}/`],
    ["mixed case", DOMAIN.toUpperCase()]
  ];

  for (const [label, value] of cases) {
    it(`matches when DOMAIN carries ${label}`, async () => {
      // An un-normalized compare against URL.hostname matches nothing, and
      // the prune reports a misleading zero rather than an error.
      const kv = makeKv(sitemapWith("/c/a", "/c/b"), ["c:a"]);
      const result = await pruneRedirectedFromSitemap(kv, value);
      expect(result.removed).toBe(1);
    });
  }

  it("removes nothing when DOMAIN is empty", async () => {
    const kv = makeKv(sitemapWith("/c/a"), ["c:a"]);
    const result = await pruneRedirectedFromSitemap(kv, "   ");
    expect(result.removed).toBe(0);
    expect(result.changed).toBe(false);
  });
});
