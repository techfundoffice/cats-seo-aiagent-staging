/**
 * Internal link fetching — two-tier approach:
 *
 * Tier 0 (primary): Cloudflare AI Search — semantic + keyword hybrid search
 *   against the live catsluvus.com index (web-crawler instance, 6-hour sync).
 *   Returns the most TOPICALLY RELEVANT articles for the current keyword, not
 *   just the most recently published.  This directly improves link equity and
 *   topical authority signals that Google uses in ranking.
 *
 * Tier 1 (fallback): SQLite recency query
 *   Same-category + cross-category articles ordered by ROWID DESC.
 *   Used when AI_SEARCH binding is absent (local dev, staging without binding).
 *
 * Both tiers return the same shape: Array<{ url: string; text: string }>
 * so the caller in writer.ts requires no changes other than awaiting.
 */

import { errMsg } from "./http-utils";
import type { SEOArticleAgent } from "../server";

/** Maximum links to return to the article writer. */
const MAX_INTERNAL_LINKS = 8;

function canonicalizePageUrl(pageUrl: string): string {
  const trimmed = pageUrl.trim();
  if (trimmed === "") return "";
  try {
    const parsed = new URL(trimmed);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    const normalizedPath = trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
    return normalizedPath === "" && trimmed.startsWith("/")
      ? "/"
      : normalizedPath;
  }
}

function normalizeDomainHost(domain: string): string {
  const trimmed = domain.trim();
  if (!trimmed) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "");
  }
}

function stripLeadingWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function isInternalDomainUrl(pageUrl: string, domain: string): boolean {
  const expectedHost = normalizeDomainHost(domain);
  if (!expectedHost) {
    return false;
  }
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return stripLeadingWww(parsed.hostname) === stripLeadingWww(expectedHost);
  } catch {
    return false;
  }
}

/**
 * Fetch semantically relevant internal links using AI Search.
 * Falls back to the SQLite recency query when the binding is unavailable.
 */
export async function fetchSemanticInternalLinks(
  agent: SEOArticleAgent,
  keyword: string,
  categorySlug: string,
  currentSlug: string,
  domain: string
): Promise<Array<{ url: string; text: string }>> {
  const normalizedCurrentSlug = currentSlug.trim().toLowerCase();

  // ── Tier 0: AI Search hybrid retrieval ───────────────────────────────────
  const aiSearch = agent.envBindings.AI_SEARCH;
  if (aiSearch) {
    try {
      const response = await aiSearch.search({
        messages: [{ role: "user", content: keyword }],
        ai_search_options: {
          max_num_results: MAX_INTERNAL_LINKS + 4 // fetch extras to absorb current-slug + duplicate-URL filtering
        }
      } as Parameters<typeof aiSearch.search>[0]);

      const links: Array<{ url: string; text: string }> = [];
      // AI Search returns one chunk per page section; the same page can
      // appear multiple times across chunks.  Deduplicate by URL so the
      // article never receives the same internal link twice.
      const seenUrls = new Set<string>();

      for (const chunk of response.chunks ?? []) {
        // item.key is the page URL for web-crawler instances
        const pageUrl = canonicalizePageUrl(chunk.item?.key ?? "");
        if (!isInternalDomainUrl(pageUrl, domain)) continue;

        // Skip the article we're currently writing by exact slug match on
        // the final path segment, so short slugs don't accidentally exclude
        // different articles that merely contain them as substrings.
        const pageSlug = getLastPathSegment(pageUrl);
        if (pageSlug && pageSlug === normalizedCurrentSlug) continue;

        // Skip URLs already queued (dedup across same-page chunks)
        if (seenUrls.has(pageUrl)) continue;
        seenUrls.add(pageUrl);

        // Derive anchor text: prefer metadata title, fall back to URL path
        const meta = chunk.item?.metadata as
          | Record<string, unknown>
          | undefined;
        const title =
          typeof meta?.title === "string" && meta.title.trim()
            ? meta.title.trim()
            : pageUrl
                .replace(/^https?:\/\/[^/]+/, "") // strip domain
                .replace(/\/$/, "")
                .replace(/[-_]/g, " ")
                .replace(/^.*\//, "") // keep only last path segment
                .trim() || keyword;

        links.push({ url: pageUrl, text: title });
        if (links.length >= MAX_INTERNAL_LINKS) break;
      }

      if (links.length > 0) {
        agent.log(
          "info",
          `Internal links (AI Search): ${links.length} semantic matches for "${keyword}"`
        );
        return links;
      }

      agent.log(
        "info",
        `Internal links (AI Search): 0 results for "${keyword}" — falling back to SQLite`
      );
    } catch (err: unknown) {
      agent.log(
        "warning",
        `Internal links (AI Search) failed for "${keyword}": ${errMsg(err)} — falling back to SQLite`
      );
    }
  } else {
    agent.log(
      "info",
      "Internal links (AI Search): AI_SEARCH binding not configured — using SQLite fallback"
    );
  }

  // ── Tier 1: SQLite recency fallback ──────────────────────────────────────
  return fetchSqliteInternalLinks(agent, categorySlug, currentSlug, domain);
}

function getLastPathSegment(pageUrl: string): string {
  try {
    const pathname = new URL(pageUrl).pathname;
    const segments = pathname
      .split("/")
      .filter((segment) => segment.length > 0);
    return segments.at(-1)?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

/**
 * Original recency-based fallback: same-category (up to 4) +
 * cross-category (up to 4) articles ordered by insertion time.
 */
function fetchSqliteInternalLinks(
  agent: SEOArticleAgent,
  categorySlug: string,
  currentSlug: string,
  domain: string
): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  const domainHost = normalizeDomainHost(domain);
  const baseDomain = domainHost || domain.trim() || "catsluvus.com";

  try {
    const sameCategory = agent.sql<{
      slug: string;
      keyword: string;
      category_slug: string;
    }>`
      SELECT slug, keyword, category_slug FROM articles
      WHERE category_slug = ${categorySlug} AND slug != ${currentSlug}
      ORDER BY ROWID DESC LIMIT 4`;

    for (const row of sameCategory) {
      links.push({
        url: `https://${baseDomain}/${row.category_slug}/${row.slug}`,
        text: row.keyword
      });
    }

    const crossCategory = agent.sql<{
      slug: string;
      keyword: string;
      category_slug: string;
    }>`
      SELECT slug, keyword, category_slug FROM articles
      WHERE category_slug != ${categorySlug}
      ORDER BY ROWID DESC LIMIT 4`;

    for (const row of crossCategory) {
      links.push({
        url: `https://${baseDomain}/${row.category_slug}/${row.slug}`,
        text: row.keyword
      });
    }
  } catch (err: unknown) {
    // SQLite articles table may not be populated yet in early pipeline runs.
    // Log the failure as non-fatal so operators can spot schema/state issues.
    agent.log(
      "warning",
      `Internal links (SQLite fallback) query failed for category "${categorySlug}": ${errMsg(err)}`
    );
  }

  agent.log("info", `Internal links (SQLite fallback): ${links.length} found`);
  return links;
}
