import { errMsg, getEnvBinding } from "./http-utils";

/**
 * prod-publish.ts — direct-to-production article publishing.
 *
 * catsluvus.com is the money site; the staging workers.dev domain is a
 * workshop. Every article that clears the quality bar
 * (PROD_PUBLISH_MIN_SCORE, default 90) ships to production as the final
 * pipeline step: its HTML is rewritten for the production domain,
 * written into the production ARTICLES_KV namespace (which catsluvus.com
 * serves), registered in the production category + global indexes, and
 * the staging URL becomes a 301 so the two domains never compete.
 * Articles below the bar stay staging-only for revision — catsluvus.com
 * never receives an article that failed the bar.
 *
 * article_ledger columns googlebot_hits / human_views / last_crawled_at
 * (incremented by the Worker fetch handler on staging serves) remain as
 * observability; promotion_status records 'published-prod' on ship.
 */

/** Default production target when PROMOTION_TARGET_DOMAIN is unset. */
export const DEFAULT_PROMOTION_TARGET_DOMAIN = "catsluvus.com";

/**
 * Production ARTICLES_KV namespace (the one catsluvus.com reads).
 * Discoverable via the CF API from the `cats-seo-aiagent` worker's
 * bindings; overridable via PROD_ARTICLES_KV_NAMESPACE_ID.
 */
export const DEFAULT_PROD_ARTICLES_KV_NAMESPACE_ID =
  "bd3b856b2ae147ada9a8d236dd4baf30";

/**
 * REST access to the production ARTICLES_KV namespace. Cross-namespace
 * reads/writes are impossible through bindings (staging only binds its
 * own KV), so post-publish consumers (Editorial Agent, idle-tick CTR
 * rewrites) go through the Cloudflare API. Returns null when the worker
 * is missing CF credentials.
 */
export function prodKvRestApi(env: unknown): {
  base: string;
  headers: Record<string, string>;
} | null {
  const accountId = getEnvBinding(env, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = getEnvBinding(env, "CLOUDFLARE_API_TOKEN");
  const ns =
    getEnvBinding(env, "PROD_ARTICLES_KV_NAMESPACE_ID") ??
    DEFAULT_PROD_ARTICLES_KV_NAMESPACE_ID;
  if (!accountId || !apiToken) return null;
  return {
    base: `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${ns}/values`,
    headers: { Authorization: `Bearer ${apiToken}` }
  };
}

/**
 * Rewrite every reference to the staging host into the production host:
 * canonical link, og:url, JSON-LD @id/url fields, internal links,
 * breadcrumbs — anything carrying the old origin. Scheme-qualified and
 * protocol-relative forms both covered.
 */
export function rewriteHtmlForDomain(
  html: string,
  fromHost: string,
  toHost: string
): { html: string; replacements: number } {
  if (!fromHost || fromHost === toHost) return { html, replacements: 0 };
  const escaped = fromHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let replacements = 0;
  const rewritten = html.replace(
    new RegExp(`(https?:)?//${escaped}`, "gi"),
    () => {
      replacements++;
      return `https://${toHost}`;
    }
  );
  return { html: rewritten, replacements };
}

/** UA classification for the serve-time tracking hook. */
export function classifyUserAgent(
  ua: string
): "googlebot" | "other-bot" | "human" {
  if (/googlebot|google-inspectiontool/i.test(ua)) return "googlebot";
  if (
    /bot\b|crawler|spider|slurp|bingpreview|python-requests|python-httpx|curl\/|wget\/|headless|lighthouse|pagespeed|dataforseo|ahrefs|semrush|petalbot|bytespider|facebookexternalhit/i.test(
      ua
    )
  ) {
    return "other-bot";
  }
  return "human";
}

export interface ProdPublishResult {
  ok: boolean;
  kvKey: string;
  prodUrl?: string;
  replacements?: number;
  bytes?: number;
  dryRun?: boolean;
  indexes?: { category: boolean; global: boolean };
  error?: string;
}

/**
 * Extract the article's display title for the production index: the H1
 * text when present, else the <title> minus its " | …" / " — …" suffix.
 */
export function extractArticleTitleForIndex(
  html: string,
  fallbackSlug: string
): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const raw = h1
    ? h1[1]
    : (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const text = raw
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = h1 ? text : text.replace(/\s*[|—–]\s+[^|—–]*$/, "").trim();
  return (
    cleaned ||
    fallbackSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** Append a slug to a per-category index array, deduped; null input = new. */
export function mergeCategoryIndex(
  existingJson: string | null,
  slug: string
): { json: string; changed: boolean } {
  let arr: string[] = [];
  try {
    const parsed = existingJson ? JSON.parse(existingJson) : [];
    if (Array.isArray(parsed))
      arr = parsed.filter((s) => typeof s === "string");
  } catch {
    arr = [];
  }
  if (arr.includes(slug)) return { json: JSON.stringify(arr), changed: false };
  arr.push(slug);
  return { json: JSON.stringify(arr), changed: true };
}

export interface GlobalIndexEntry {
  slug: string;
  url: string;
  title: string;
  category: string;
  image: string | null;
}

/** Append an entry to the global v2_articles_index, deduped by slug+category. */
export function mergeGlobalIndex(
  existingJson: string | null,
  entry: GlobalIndexEntry
): { json: string; changed: boolean } {
  let arr: GlobalIndexEntry[] = [];
  try {
    const parsed = existingJson ? JSON.parse(existingJson) : [];
    if (Array.isArray(parsed)) arr = parsed as GlobalIndexEntry[];
  } catch {
    arr = [];
  }
  const exists = arr.some(
    (e) => e && e.slug === entry.slug && e.category === entry.category
  );
  if (exists) return { json: JSON.stringify(arr), changed: false };
  arr.push(entry);
  return { json: JSON.stringify(arr), changed: true };
}

/**
 * Publish one staging article to production:
 *  1. read staging HTML from ARTICLES_KV
 *  2. rewrite staging host → production host
 *  3. PUT into the production ARTICLES_KV namespace via the CF REST API
 *  4. replace the staging copy with a `redirect:<kvKey>` tombstone
 *     (served as a 301) and delete the staging HTML
 *  5. mark the ledger row promoted
 *
 * `dryRun` performs steps 1-2 only and reports what would happen.
 */
export async function publishArticleToProduction(
  env: unknown,
  articlesKv: KVNamespace,
  keywordsDb: D1Database | undefined,
  kvKey: string,
  dryRun: boolean
): Promise<ProdPublishResult> {
  const m = kvKey.match(/^([^:]+):([^:]+)$/);
  if (!m) {
    return { ok: false, kvKey, error: "kvKey must be categorySlug:slug" };
  }
  const [, categorySlug, slug] = m;

  const stagingHost = getEnvBinding(env, "DOMAIN") ?? "";
  const targetHost =
    getEnvBinding(env, "PROMOTION_TARGET_DOMAIN") ??
    DEFAULT_PROMOTION_TARGET_DOMAIN;
  const accountId = getEnvBinding(env, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = getEnvBinding(env, "CLOUDFLARE_API_TOKEN");
  const prodNamespaceId =
    getEnvBinding(env, "PROD_ARTICLES_KV_NAMESPACE_ID") ??
    DEFAULT_PROD_ARTICLES_KV_NAMESPACE_ID;

  const html = await articlesKv.get(kvKey);
  if (html === null) {
    return { ok: false, kvKey, error: "staging article not found in KV" };
  }

  const { html: rewritten, replacements } = rewriteHtmlForDomain(
    html,
    stagingHost,
    targetHost
  );
  const prodUrl = `https://${targetHost}/${categorySlug}/${slug}`;

  if (dryRun) {
    return {
      ok: true,
      kvKey,
      prodUrl,
      replacements,
      bytes: rewritten.length,
      dryRun: true
    };
  }

  if (!accountId || !apiToken) {
    return {
      ok: false,
      kvKey,
      error:
        "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not configured on this worker"
    };
  }

  // 3. Write to the production namespace via REST (cross-namespace writes
  // are not possible through bindings — staging only binds its own KV).
  const putRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${prodNamespaceId}/values/${encodeURIComponent(kvKey)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "text/plain; charset=UTF-8"
      },
      body: rewritten
    }
  );
  if (!putRes.ok) {
    const detail = await putRes.text().catch(() => "");
    return {
      ok: false,
      kvKey,
      error: `prod KV write failed: HTTP ${putRes.status} ${detail.slice(0, 200)}`
    };
  }

  // 3b. Register the article in the production indexes so catsluvus.com
  // links to it from category pages and includes it in the category
  // sitemap (petinsurance builds both from `articles-index:<category>`,
  // and site-wide listings from `v2_articles_index`). Without this a
  // promoted article is an orphan page. Best-effort read-modify-write:
  // a concurrent index write from the production generator could race,
  // but prod-publishes are low-frequency and the loser self-heals on the
  // next prod publish.
  const kvApiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${prodNamespaceId}/values`;
  const authHeaders = { Authorization: `Bearer ${apiToken}` };
  const indexes = { category: false, global: false };
  try {
    const catKey = `${kvApiBase}/${encodeURIComponent(`articles-index:${categorySlug}`)}`;
    const catRes = await fetch(catKey, { headers: authHeaders });
    const catJson = catRes.ok ? await catRes.text() : null;
    const catMerge = mergeCategoryIndex(catJson, slug);
    if (catMerge.changed) {
      const putCat = await fetch(catKey, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: catMerge.json
      });
      indexes.category = putCat.ok;
    }

    const globalKey = `${kvApiBase}/${encodeURIComponent("v2_articles_index")}`;
    const globalRes = await fetch(globalKey, { headers: authHeaders });
    const globalJson = globalRes.ok ? await globalRes.text() : null;
    const globalMerge = mergeGlobalIndex(globalJson, {
      slug,
      url: `/${categorySlug}/${slug}`,
      title: extractArticleTitleForIndex(rewritten, slug),
      category: categorySlug,
      image: null
    });
    if (globalMerge.changed) {
      const putGlobal = await fetch(globalKey, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: globalMerge.json
      });
      indexes.global = putGlobal.ok;
    }
  } catch {
    // Index registration is best-effort — the article itself is already
    // live; a failed index write only delays internal-link discovery.
  }

  // 4. Tombstone: staging URL now 301s to production. Order matters —
  // write the redirect BEFORE deleting the HTML so there is no window
  // where the staging URL 404s.
  await articlesKv.put(`redirect:${kvKey}`, prodUrl);
  await articlesKv.delete(kvKey);

  // 5. Ledger bookkeeping (best-effort — the publish already happened).
  if (keywordsDb) {
    try {
      await keywordsDb
        .prepare(
          `UPDATE article_ledger
              SET promotion_status = 'published-prod',
                  promoted_at = datetime('now'),
                  prod_url = ?1
            WHERE kv_key = ?2`
        )
        .bind(prodUrl, kvKey)
        .run();
    } catch (err: unknown) {
      return {
        ok: true,
        kvKey,
        prodUrl,
        replacements,
        bytes: rewritten.length,
        indexes,
        error: `promoted, but ledger update failed: ${errMsg(err)}`
      };
    }
  }

  return {
    ok: true,
    kvKey,
    prodUrl,
    replacements,
    bytes: rewritten.length,
    indexes
  };
}
