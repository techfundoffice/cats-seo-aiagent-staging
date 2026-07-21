import type { SEOArticleAgent } from "../server";
import { errMsg, escXml, normalizeSingleLine } from "./http-utils";
import { loggedFetch } from "./api-logger";

// ── Constants ──────────────────────────────────────────────────────────────────

/** KV key for the rolling RSS 2.0 feed document. */
const FEED_KV_KEY = "feed:rss";

/**
 * Maximum number of <item> entries kept in the feed.
 * Older entries are dropped once this cap is reached.
 * 50 is large enough to cover ~2 weeks of publishing cadence
 * while keeping the feed document well under 64 KB.
 */
const MAX_FEED_ITEMS = 50;

/**
 * Cache lifetime for the /feed.rss response (seconds).
 * Matches the autonomousLoop cadence (300 s) so feed readers
 * never receive a stale entry for more than one loop cycle.
 */
export const FEED_CACHE_MAX_AGE = 300;

/** WebSub hubs to ping on every feed update (both confirmed active 2026). */
const WEBSUB_HUBS = [
  "https://pubsubhubbub.appspot.com/publish",
  "https://pubsubhubbub.superfeedr.com/"
];
const WEBSUB_ERROR_SNIPPET_MAX_CHARS = 240;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FeedArticleInput {
  title: string;
  metaDescription: string;
  canonicalUrl: string;
  categorySlug: string;
  /** ISO-8601 publish timestamp — converted to RFC 822 internally. */
  pubDateIso: string;
}

export interface UpdateFeedResult {
  itemCount: number;
  feedUrl: string;
  created: boolean;
}

// ── Date helpers ───────────────────────────────────────────────────────────────

const RFC822_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const RFC822_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
] as const;

/** Format a `Date` object as an RFC 822 timestamp string (always UTC). */
function dateToRfc822(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${RFC822_DAYS[d.getUTCDay()]}, ` +
    `${pad(d.getUTCDate())} ${RFC822_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  );
}

/**
 * Convert an ISO-8601 date string to RFC 822 format required by RSS 2.0.
 * RSS uses RFC 822 (e.g. "Mon, 21 Apr 2026 00:00:00 +0000").
 * Using ISO 8601 in <pubDate> causes strict-parser failures in Inoreader
 * and Folo — do NOT use toISOString() here.
 *
 * If `isoDate` is not a valid date string, falls back to the current time
 * so the feed XML never contains "undefined, NaN NaN NaN …" which would
 * break every RSS parser that validates <pubDate>.
 */
function toRfc822(isoDate: string): string {
  const d = new Date(isoDate);
  return dateToRfc822(Number.isNaN(d.getTime()) ? new Date() : d);
}

function parseIsoDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ── Feed builder ───────────────────────────────────────────────────────────────

/**
 * Build a minimal-but-valid RSS 2.0 channel skeleton.
 * Includes the mandatory <atom:link rel="self"> element required
 * by the RSS Advisory Board spec and expected by strict parsers.
 */
function buildEmptyFeed(feedUrl: string, domain: string): string {
  const now = toRfc822(new Date().toISOString());
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `<channel>\n` +
    `<title>CatsLuvUs — Cat Care &amp; Product Guides</title>\n` +
    `<link>https://${escXml(domain)}</link>\n` +
    `<description>Expert cat care advice, product reviews, and buying guides for cat owners</description>\n` +
    `<language>en-us</language>\n` +
    `<lastBuildDate>${now}</lastBuildDate>\n` +
    `<atom:link href="${escXml(feedUrl)}" rel="self" type="application/rss+xml"/>\n` +
    `</channel>\n` +
    `</rss>`
  );
}

/**
 * Render a single <item> block for one article.
 */
function buildFeedItem(
  article: FeedArticleInput,
  pubDateRfc822: string
): string {
  const desc = article.metaDescription.slice(0, 300);
  return (
    `  <item>\n` +
    `    <title>${escXml(article.title)}</title>\n` +
    `    <link>${escXml(article.canonicalUrl)}</link>\n` +
    `    <description>${escXml(desc)}</description>\n` +
    `    <pubDate>${pubDateRfc822}</pubDate>\n` +
    `    <guid isPermaLink="true">${escXml(article.canonicalUrl)}</guid>\n` +
    `    <category>${escXml(article.categorySlug)}</category>\n` +
    `  </item>`
  );
}

/**
 * Count the number of <item> blocks in an existing feed XML string.
 * Simple regex-based count — does not need a full XML parser.
 */
function countItems(xml: string): number {
  return (xml.match(/<item>/g) || []).length;
}

/**
 * Drop the oldest <item> entries beyond MAX_FEED_ITEMS.
 * Items are stored newest-first (prepended), so oldest are at the end.
 *
 * Uses exec() to track the byte offset of the MAX_FEED_ITEMS-th item's
 * closing tag, then splices out all excess items in a single slice rather
 * than calling String.replace() in a loop.  String.replace(str) only
 * removes the *first* occurrence of the search string; an index-based
 * splice is both O(1) and safe even if two items ever share identical
 * content (e.g. a keyword published twice in quick succession).
 */
function capItems(xml: string): string {
  const itemRegex = /<item>[\s\S]*?<\/item>/g;
  let count = 0;
  let cutAt = -1;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    count++;
    if (count === MAX_FEED_ITEMS) {
      cutAt = m.index + m[0].length;
      break;
    }
  }
  if (cutAt === -1) return xml; // fewer than MAX_FEED_ITEMS items — nothing to cap
  const channelCloseIdx = xml.indexOf("</channel>", cutAt);
  if (channelCloseIdx === -1) return xml; // malformed XML — leave untouched
  // Splice: everything up to and including item 50, then </channel>…</rss>
  return xml.slice(0, cutAt) + "\n" + xml.slice(channelCloseIdx);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Step 24/24a — Update the rolling RSS 2.0 feed in KV.
 *
 * Reads the existing feed from KV (key: "feed:rss"), prepends a new
 * <item> for the just-published article, enforces the 50-item cap,
 * and writes the updated document back to KV.
 *
 * Pattern mirrors updateSitemap() in indexing.ts exactly.
 */
export async function updateRssFeed(
  agent: SEOArticleAgent,
  article: FeedArticleInput
): Promise<UpdateFeedResult> {
  const domain = agent.envBindings.DOMAIN || "catsluvus.com";
  const feedUrl = `https://${domain}/feed.rss`;

  // Skip duplicate entries (same canonical URL already in feed).
  // Append "<" so we match a complete URL at a tag boundary and avoid a
  // false positive when one article slug is a prefix of another
  // (e.g. "cat-water-fountain" inside "cat-water-fountain-with-filter").
  const existing = await agent.envBindings.ARTICLES_KV.get(FEED_KV_KEY);

  if (existing && existing.includes(`${escXml(article.canonicalUrl)}<`)) {
    const itemCount = countItems(existing);
    return { itemCount, feedUrl, created: false };
  }

  const publishDate = parseIsoDate(article.pubDateIso);
  if (!publishDate) {
    const rawPubDate = normalizeSingleLine(article.pubDateIso);
    agent.log(
      "warning",
      `RSS feed: invalid pubDateIso for ${article.canonicalUrl}; falling back to current time — ${rawPubDate === "" ? "(blank)" : rawPubDate}`
    );
  }
  const newItem = buildFeedItem(
    article,
    dateToRfc822(publishDate ?? new Date())
  );
  const now = toRfc822(new Date().toISOString());

  let updated: string;
  let created = false;

  if (!existing || !existing.includes("<rss")) {
    // First article — build the feed from scratch
    const skeleton = buildEmptyFeed(feedUrl, domain);
    updated = skeleton.replace("</channel>", `${newItem}\n</channel>`);
    created = true;
  } else {
    // Prepend new item immediately after <channel> opening block
    // (before the first existing <item> or before </channel>)
    const insertBefore = existing.includes("<item>")
      ? existing.indexOf("<item>")
      : existing.indexOf("</channel>");

    if (insertBefore === -1) {
      // Feed XML has <rss> but is missing both </channel> and any <item> —
      // it is corrupted (e.g. a partial KV write). Rebuild from scratch rather
      // than passing -1 to slice(), which would silently remove the last
      // character and insert the new item at the wrong position.
      agent.log(
        "warning",
        `RSS feed: rebuilt corrupted KV (has <rss> but no </channel> or <item>) — rebuilding for ${feedUrl}`
      );
      const skeleton = buildEmptyFeed(feedUrl, domain);
      updated = skeleton.replace("</channel>", `${newItem}\n</channel>`);
      created = true;
    } else {
      updated =
        existing.slice(0, insertBefore) +
        newItem +
        "\n" +
        existing.slice(insertBefore);

      // Refresh <lastBuildDate>
      updated = updated.replace(
        /<lastBuildDate>[^<]*<\/lastBuildDate>/,
        `<lastBuildDate>${now}</lastBuildDate>`
      );
    }
  }

  // Enforce rolling cap
  updated = capItems(updated);

  await agent.envBindings.ARTICLES_KV.put(FEED_KV_KEY, updated);

  const itemCount = countItems(updated);
  return { itemCount, feedUrl, created };
}

/**
 * Step 24/24b — Notify WebSub hubs that the feed has been updated.
 *
 * Pings both the Google-operated hub and Superfeedr.
 * Both are confirmed active as of 2026.
 *
 * WHY TWO HUBS:
 *  - pubsubhubbub.appspot.com: Google's own hub. Google Search Central
 *    documentation explicitly states: "If you use Atom or RSS, you can
 *    use WebSub to broadcast your changes to search engines, including
 *    Google." This is a documented crawl accelerator on top of IndexNow.
 *  - pubsubhubbub.superfeedr.com: Inoreader confirmed integration
 *    (Inoreader blog). Reaches Superfeedr's subscriber distribution
 *    network independently of Google.
 *
 * Both calls are fire-and-forget. Failures are non-fatal warnings.
 */
export async function notifyWebSubHubs(
  agent: SEOArticleAgent,
  feedUrl: string
): Promise<void> {
  const body = `hub.mode=publish&hub.url=${encodeURIComponent(feedUrl)}`;
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };

  for (const hub of WEBSUB_HUBS) {
    try {
      const resp = await loggedFetch(
        agent,
        hub,
        {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(5_000)
        },
        { api: "WebSub", op: "publish" }
      );
      if (!resp.ok) {
        let responseSummary = "";
        let responseBodyReadFailed = false;
        try {
          responseSummary = (await resp.text())
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, WEBSUB_ERROR_SNIPPET_MAX_CHARS);
        } catch {
          responseBodyReadFailed = true;
        }
        const responseDetail =
          responseSummary ||
          (responseBodyReadFailed ? "response body unavailable" : "");
        agent.log(
          "warning",
          `WebSub ping returned HTTP ${resp.status} for ${hub}${responseDetail ? ` — ${responseDetail}` : ""} (non-fatal)`,
          "marketing"
        );
      }
    } catch (err: unknown) {
      agent.log(
        "warning",
        `WebSub ping failed (non-fatal) → ${hub}: ${errMsg(err)}`,
        "marketing"
      );
    }
  }
}

/**
 * Build a minimal valid empty RSS feed for the /feed.rss 404-prevention
 * response — returned when KV has no feed yet so readers don't blacklist
 * the URL before the first article is published.
 */
export function buildEmptyFeedResponse(domain: string): string {
  const feedUrl = `https://${domain}/feed.rss`;
  return buildEmptyFeed(feedUrl, domain);
}
