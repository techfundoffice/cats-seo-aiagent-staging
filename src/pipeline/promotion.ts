import { errMsg, getEnvBinding } from "./http-utils";

/**
 * promotion.ts — the staging → production article promotion pipeline.
 *
 * Strategy (site operator's incubation funnel): every article publishes
 * first on the staging workers.dev domain, deliberately indexable. Google
 * crawls it and votes with impressions/clicks. Articles that earn real
 * engagement get PROMOTED: their HTML is rewritten for the production
 * domain, written into the production ARTICLES_KV namespace (which
 * catsluvus.com serves), and the staging URL becomes a 301 redirect so
 * Google transfers the page's accumulated signals to the production URL.
 *
 * Signals tracked per article in KEYWORDS_DB `article_ledger`
 * (incremented by the Worker fetch handler on every article serve):
 *   - googlebot_hits / last_crawled_at — proof Google is crawling it
 *   - human_views                     — non-bot traffic proxy
 * Promotion state machine: incubating → promoted (promotion_status).
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

export interface PromotionResult {
  ok: boolean;
  kvKey: string;
  prodUrl?: string;
  replacements?: number;
  bytes?: number;
  dryRun?: boolean;
  error?: string;
}

/**
 * Promote one staging article to production:
 *  1. read staging HTML from ARTICLES_KV
 *  2. rewrite staging host → production host
 *  3. PUT into the production ARTICLES_KV namespace via the CF REST API
 *  4. replace the staging copy with a `redirect:<kvKey>` tombstone
 *     (served as a 301) and delete the staging HTML
 *  5. mark the ledger row promoted
 *
 * `dryRun` performs steps 1-2 only and reports what would happen.
 */
export async function promoteArticleToProduction(
  env: unknown,
  articlesKv: KVNamespace,
  keywordsDb: D1Database | undefined,
  kvKey: string,
  dryRun: boolean
): Promise<PromotionResult> {
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

  // 4. Tombstone: staging URL now 301s to production. Order matters —
  // write the redirect BEFORE deleting the HTML so there is no window
  // where the staging URL 404s.
  await articlesKv.put(`redirect:${kvKey}`, prodUrl);
  await articlesKv.delete(kvKey);

  // 5. Ledger bookkeeping (best-effort — promotion already happened).
  if (keywordsDb) {
    try {
      await keywordsDb
        .prepare(
          `UPDATE article_ledger
              SET promotion_status = 'promoted',
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
        error: `promoted, but ledger update failed: ${errMsg(err)}`
      };
    }
  }

  return { ok: true, kvKey, prodUrl, replacements, bytes: rewritten.length };
}
