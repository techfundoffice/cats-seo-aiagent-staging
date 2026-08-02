import type { SEOArticleAgent } from "../server";
import {
  errMsg,
  escXml,
  getEnvBinding,
  normalizeSingleLine
} from "./http-utils";

/**
 * KV key holding the IndexNow retry queue. JSON array of
 * `{ url: string; queuedAt: string }` entries — URLs that were
 * published while IndexNow was degraded (site-verification 403, 422
 * key-not-found, transient network error). On the next successful
 * notify the queue is drained best-effort so newly-published articles
 * AND backlogged ones both reach Bing/Yandex without operator
 * intervention. See `enqueueIndexNowPending` + `drainIndexNowPending`.
 */
const INDEXNOW_PENDING_KEY = "indexnow-pending-queue";

/**
 * Hard cap on backlog size. At ~10 articles/hour publish rate this is
 * ~20 days of catch-up. Older entries are dropped FIFO so the queue
 * stays bounded even during a multi-week IndexNow outage.
 */
const INDEXNOW_QUEUE_MAX = 5000;

/**
 * How many backlogged URLs we re-submit per successful notify. Keeps
 * each publish call cheap (~1 extra IndexNow call) and ensures the
 * backlog drains continuously without a separate scheduled tick.
 * Bing's IndexNow rate-limit guidance is 10k URLs/day; 1 per
 * publish keeps us well under at any sensible cadence.
 */
const INDEXNOW_DRAIN_BATCH = 3;

/**
 * Backoff after a 403 UserForbiddedToAccessSite: the site-ownership key
 * file is missing/unverified on catsluvus.com, which only a human can fix.
 * Without this, every publish logs ~4 identical 403 warnings (1 submit +
 * 3 queue-drain attempts). URLs stay queued, so they all get submitted
 * once verification is repaired and the backoff lapses.
 */
const INDEXNOW_403_BACKOFF_KEY = "indexnow-403-backoff";
const INDEXNOW_403_BACKOFF_TTL_SECONDS = 6 * 60 * 60;

/**
 * Backoff after a 429 TooManyRequests. Shorter than the 403 backoff —
 * rate limits clear on their own. Without this every publish keeps
 * hammering the API (1 submit + drain batch), compounding the 429s.
 * URLs stay queued and drain once the backoff lapses.
 */
const INDEXNOW_429_BACKOFF_KEY = "indexnow-429-backoff";
const INDEXNOW_429_BACKOFF_TTL_SECONDS = 60 * 60;

type IndexNowQueueEntry = { url: string; queuedAt: string };

async function readIndexNowQueue(
  agent: SEOArticleAgent
): Promise<IndexNowQueueEntry[]> {
  try {
    const raw = await agent.envBindings.ARTICLES_KV.get(INDEXNOW_PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is IndexNowQueueEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as { url?: unknown }).url === "string" &&
        typeof (e as { queuedAt?: unknown }).queuedAt === "string"
    );
  } catch {
    return [];
  }
}

async function writeIndexNowQueue(
  agent: SEOArticleAgent,
  queue: IndexNowQueueEntry[]
): Promise<void> {
  try {
    await agent.envBindings.ARTICLES_KV.put(
      INDEXNOW_PENDING_KEY,
      JSON.stringify(queue)
    );
  } catch (err: unknown) {
    agent.log(
      "warning",
      `IndexNow: failed to persist pending queue (${queue.length} URLs) — ${errMsg(err)}`
    );
  }
}

/**
 * Add a URL to the IndexNow pending queue. Dedups against existing
 * entries so a publish loop that keeps failing for the same URL
 * doesn't bloat the queue.
 */
export async function enqueueIndexNowPending(
  agent: SEOArticleAgent,
  url: string
): Promise<void> {
  const queue = await readIndexNowQueue(agent);
  if (queue.some((e) => e.url === url)) return;
  queue.push({ url, queuedAt: new Date().toISOString() });
  // FIFO trim. The oldest entries get dropped first so we always retry
  // the most recently failed URLs first when IndexNow recovers.
  const trimmed = queue.slice(-INDEXNOW_QUEUE_MAX);
  await writeIndexNowQueue(agent, trimmed);
}

/**
 * Drain up to `max` URLs from the pending queue, re-submitting each
 * via the standard `notifyIndexNow` path. Successful submissions are
 * removed from the queue; failures stay queued for the next drain.
 *
 * Called automatically after every successful publish-time notify so
 * the backlog clears on its own as soon as IndexNow recovers — no
 * manual reprocessing needed.
 */
export async function drainIndexNowPending(
  agent: SEOArticleAgent,
  max = INDEXNOW_DRAIN_BATCH
): Promise<{ attempted: number; succeeded: number; remaining: number }> {
  const queue = await readIndexNowQueue(agent);
  if (queue.length === 0) return { attempted: 0, succeeded: 0, remaining: 0 };
  const head = queue.slice(0, max);
  const tail = queue.slice(max);
  const stillPending: IndexNowQueueEntry[] = [];
  let succeeded = 0;
  // One batched urlList POST per host — IndexNow accepts up to 10k URLs
  // per submission, so N queued URLs cost 1 request instead of N.
  const byHost = new Map<string, IndexNowQueueEntry[]>();
  for (const entry of head) {
    const host = normalizeIndexNowHost(entry.url);
    const group = byHost.get(host) ?? [];
    group.push(entry);
    byHost.set(host, group);
  }
  for (const group of byHost.values()) {
    const ok = await notifyIndexNowDirect(
      agent,
      group.map((e) => e.url)
    );
    if (ok) {
      succeeded += group.length;
    } else {
      stillPending.push(...group);
    }
  }
  const next = [...stillPending, ...tail];
  await writeIndexNowQueue(agent, next);
  if (succeeded > 0 || stillPending.length > 0) {
    agent.log(
      "info",
      `IndexNow: drained ${succeeded}/${head.length} pending URL(s); ${next.length} remaining in queue`
    );
  }
  return {
    attempted: head.length,
    succeeded,
    remaining: next.length
  };
}

function normalizeIndexNowHost(rawDomain: string | undefined): string {
  const trimmed = (rawDomain ?? "").trim();
  if (!trimmed) return "catsluvus.com";
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

/**
 * Bare HTTP submission of a single URL to IndexNow. Used by both the
 * public `notifyIndexNow` entry point AND by `drainIndexNowPending`,
 * which would loop forever if it called the queue-aware
 * `notifyIndexNow`. Returns true on success, false on any failure.
 * Logs the wire response either way.
 */
async function notifyIndexNowDirect(
  agent: SEOArticleAgent,
  urlOrUrls: string | string[]
): Promise<boolean> {
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
  if (urls.length === 0) return true;
  const url = urls[0];
  // Skip silently while a backoff is active — the activation log line
  // was written when the backoff was set, and the URLs stay queued.
  try {
    const backedOff =
      (await agent.envBindings.ARTICLES_KV.get(INDEXNOW_403_BACKOFF_KEY)) ||
      (await agent.envBindings.ARTICLES_KV.get(INDEXNOW_429_BACKOFF_KEY));
    if (backedOff) return false;
  } catch {
    /* best-effort; fall through */
  }
  // Host comes from the submitted URLs, not the worker's DOMAIN var:
  // articles that cleared the quality gate live on catsluvus.com, and
  // IndexNow rejects a urlList whose URLs don't belong to `host`.
  const domain = normalizeIndexNowHost(url);
  // Default to the IndexNow key that is actually deployed and verifiable:
  // https://catsluvus.com/5d2a70a712524fe39b9dda29ab79e6ee.txt returns 200
  // (served by this worker's ASSETS binding from public/, via the
  // catsluvus.com/*.txt zone route + the 32-hex key route in server.ts).
  // The previous placeholder default ("catsluvus-indexnow-key") had no
  // matching file on catsluvus.com — every submission 404'd at the key-
  // location check and got queued. IndexNow keys are public by design, so
  // hardcoding the live key as the fallback is safe; INDEXNOW_KEY can still
  // override it. Keep this in sync with public/<key>.txt.
  const key =
    getEnvBinding(agent.envBindings, "INDEXNOW_KEY") ??
    "5d2a70a712524fe39b9dda29ab79e6ee";

  try {
    // Note: keyLocation must be on the same host as the submitted URLs (catsluvus.com).
    // We cannot serve it from the worker domain. If INDEXNOW_KEY_LOCATION is set in
    // Doppler (pointing to catsluvus.com/key.txt), use it — otherwise omit it and
    // IndexNow will look for it at https://catsluvus.com/{key}.txt automatically.
    const keyLocation = getEnvBinding(
      agent.envBindings,
      "INDEXNOW_KEY_LOCATION"
    );
    const defaultKeyLocation = `https://${domain}/${key}.txt`;
    const effectiveKeyLocation = keyLocation || defaultKeyLocation;

    const body: Record<string, unknown> = { host: domain, key, urlList: urls };
    if (keyLocation) body.keyLocation = keyLocation;

    const resp = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000)
    });
    if (resp.status === 422) {
      agent.log(
        "warning",
        `IndexNow: 422 for ${url} — key file not found at ${effectiveKeyLocation}. ${
          keyLocation
            ? "Ensure INDEXNOW_KEY_LOCATION points to the live public key file."
            : `Add the file to ${domain} to enable IndexNow.`
        }`
      );
      return false;
    }
    if (resp.ok || resp.status === 202) {
      agent.log(
        "info",
        `IndexNow: ${resp.status} for ${urls.length > 1 ? `${urls.length} URLs (first: ${url})` : url}`
      );
      return true;
    }
    const statusDetail = normalizeSingleLine(resp.statusText ?? "");
    const responseBody = await resp.text().catch(() => "");
    const responseSummary = normalizeSingleLine(responseBody).slice(0, 240);
    const detailParts = [statusDetail, responseSummary].filter(Boolean);
    const detailSuffix =
      detailParts.length > 0 ? `: ${detailParts.join(" — ")}` : "";
    if (resp.status === 403) {
      // Site-verification failure — can't self-heal; back off 6h so the
      // dashboard gets one actionable line instead of 4 per publish. The
      // provider-health banner keeps the degraded state visible.
      try {
        const until = new Date(
          Date.now() + INDEXNOW_403_BACKOFF_TTL_SECONDS * 1000
        ).toISOString();
        await agent.envBindings.ARTICLES_KV.put(
          INDEXNOW_403_BACKOFF_KEY,
          until,
          { expirationTtl: INDEXNOW_403_BACKOFF_TTL_SECONDS }
        );
      } catch {
        /* best-effort */
      }
      agent.log(
        "warning",
        `IndexNow: 403 for ${url}${detailSuffix} — site verification failed; backing off 6h (URLs stay queued). Re-verify the key file on catsluvus.com.`
      );
      return false;
    }
    if (resp.status === 429) {
      // Rate limited — stop submitting for an hour instead of adding a
      // 429 warning line for every publish + drain attempt. URLs stay
      // queued and drain in one batched POST once the backoff lapses.
      try {
        await agent.envBindings.ARTICLES_KV.put(
          INDEXNOW_429_BACKOFF_KEY,
          new Date(
            Date.now() + INDEXNOW_429_BACKOFF_TTL_SECONDS * 1000
          ).toISOString(),
          { expirationTtl: INDEXNOW_429_BACKOFF_TTL_SECONDS }
        );
      } catch {
        /* best-effort */
      }
      agent.log(
        "warning",
        `IndexNow: 429 rate-limited — backing off 1h (URLs stay queued and drain in batches once it lapses)`
      );
      return false;
    }
    agent.log("warning", `IndexNow: ${resp.status} for ${url}${detailSuffix}`);
    return false;
  } catch (err: unknown) {
    agent.log("warning", `IndexNow failed for ${url}: ${errMsg(err)}`);
    return false;
  }
}

/**
 * Notify search engines about new content via IndexNow API.
 * Submits the URL to the IndexNow protocol, which fans out to its
 * participating engines (Bing, Yandex, Seznam, Naver, etc.).
 *
 * NOTE: Google does NOT participate in IndexNow, so this call does
 * nothing for Google indexing — Google discovers new articles only by
 * crawling the sitemap (`updateSitemap`) on its own schedule, or via
 * the separate Google Indexing API (not wired up here). Do not assume a
 * successful IndexNow submission means the URL was sent to Google.
 *
 * Wraps the bare-HTTP submission with the backlog queue:
 *   - On failure (403 site-unverified, 422 key-missing, network)
 *     the URL is added to `indexnow-pending-queue` so it gets re-
 *     submitted automatically the moment IndexNow recovers.
 *   - On success the queue is drained opportunistically (up to
 *     INDEXNOW_DRAIN_BATCH URLs per call), so the backlog clears
 *     itself without any operator action.
 *
 * The drain is fire-and-forget (no `await` blocks the publish path);
 * if the drain itself takes a long time the publish completes anyway
 * and the next notify will resume the drain.
 */
export async function notifyIndexNow(
  agent: SEOArticleAgent,
  url: string
): Promise<boolean> {
  const ok = await notifyIndexNowDirect(agent, url);
  if (ok) {
    // Opportunistic drain: re-submit a small batch of previously-
    // failed URLs now that IndexNow has just proven healthy.
    await drainIndexNowPending(agent);
  } else {
    await enqueueIndexNowPending(agent, url);
  }
  return ok;
}

/**
 * KV key holding the flat XML sitemap served at `/sitemap.xml`.
 *
 * Exported so the serving route in `server.ts` and the traffic-source
 * verifier both read the exact key `updateSitemap()` writes — a drifting
 * string literal here silently produces an empty sitemap.
 */
export const SITEMAP_KV_KEY = "sitemap:flat-sitemap";

/**
 * Cache lifetime for the `/sitemap.xml` response (seconds). One hour
 * mirrors robots.txt: long enough to shed crawler load, short enough that a
 * newly published article shows up in the sitemap promptly.
 */
export const SITEMAP_CACHE_MAX_AGE = 3600;

/**
 * A valid, empty sitemap document.
 *
 * Served when the KV key is missing — before the first article publishes, or
 * if KV is wiped. Returning a well-formed empty `<urlset>` is important:
 * crawlers treat a malformed sitemap as a fetch error and can back off from
 * re-requesting it, whereas an empty one is simply "nothing new yet."
 */
export function buildEmptySitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;
}

/**
 * Remove a URL from the flat sitemap.
 *
 * Called when a staging article is promoted to production: the staging URL
 * becomes a 301 to the production copy, and a sitemap must list canonical,
 * indexable URLs — not redirects. Leaving promoted URLs in place makes every
 * one of them surface in Search Console as "Page with redirect" and burns
 * crawl budget re-fetching URLs that only point elsewhere.
 *
 * Takes the KV namespace rather than the agent because the promotion path
 * (`publishArticleToProduction`) runs from the admin API with no agent in
 * scope.
 *
 * @returns true when an entry was removed and the sitemap rewritten.
 */
export async function removeUrlFromSitemap(
  articlesKv: KVNamespace,
  url: string
): Promise<boolean> {
  try {
    const existing = await articlesKv.get(SITEMAP_KV_KEY);
    if (!existing) return false;

    const loc = `<loc>${escXml(url)}</loc>`;
    if (!existing.includes(loc)) return false;

    // Drop whole `<url>…</url>` entries whose <loc> is this URL, along with
    // their leading indentation and trailing newline, so the document stays
    // tidy. Matching on the extracted entry with `includes` (rather than
    // interpolating the URL into a regex) avoids escaping pitfalls with
    // characters that are regex-significant.
    const updated = existing.replace(
      /[ \t]*<url>[\s\S]*?<\/url>\n?/g,
      (entry) => (entry.includes(loc) ? "" : entry)
    );
    if (updated === existing) return false;

    await articlesKv.put(SITEMAP_KV_KEY, updated);
    return true;
  } catch {
    // Best-effort: the promotion itself has already succeeded, and a stale
    // sitemap entry is a crawl-efficiency problem, not a correctness one.
    return false;
  }
}

/** Outcome of a one-shot sitemap prune. */
export interface SitemapPruneResult {
  /** Entries in the sitemap before pruning. */
  before: number;
  /** Entries remaining after pruning. */
  after: number;
  /** How many redirecting entries were dropped. */
  removed: number;
  /** A sample of removed URLs, for the operator to eyeball. */
  removedSample: string[];
  /** True when the sitemap was rewritten. */
  changed: boolean;
}

/**
 * One-shot backlog cleanup: drop every sitemap entry whose article has since
 * been promoted to production.
 *
 * `removeUrlFromSitemap()` keeps the sitemap clean going forward, but articles
 * promoted before it existed left their staging URLs behind. Those URLs now
 * 301 to production, so the sitemap advertises redirects — Search Console
 * reports them as "Page with redirect" and Googlebot spends crawl budget
 * rediscovering the same redirect.
 *
 * Authority is the `redirect:<kvKey>` tombstone that promotion writes, not an
 * HTTP probe: it is the same signal the serving path uses, needs no network
 * round-trip per URL, and cannot be confused by a transient 5xx.
 *
 * Idempotent — a second run over an already-clean sitemap removes nothing.
 *
 * @param domain Host whose URLs are eligible for pruning. Entries on any other
 *               host are left alone, so a sitemap that ever gains
 *               cross-published URLs is not silently gutted.
 */
export async function pruneRedirectedFromSitemap(
  articlesKv: KVNamespace,
  domain: string
): Promise<SitemapPruneResult> {
  const empty: SitemapPruneResult = {
    before: 0,
    after: 0,
    removed: 0,
    removedSample: [],
    changed: false
  };

  const existing = await articlesKv.get(SITEMAP_KV_KEY);
  if (!existing) return empty;

  const entries = existing.match(/[ \t]*<url>[\s\S]*?<\/url>\n?/g) ?? [];
  if (entries.length === 0) return empty;

  const removed: string[] = [];
  const survivors = new Set<string>();

  for (const entry of entries) {
    const locMatch = /<loc>([\s\S]*?)<\/loc>/.exec(entry);
    const loc = locMatch?.[1]?.trim();
    if (!loc) continue;

    // `&amp;` back to `&` so the parsed URL is the real one.
    const rawUrl = loc.replace(/&amp;/g, "&");
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue; // Unparseable entry — leave it rather than guess.
    }
    if (parsed.hostname !== domain) continue;

    // `/categorySlug/slug` → `categorySlug:slug`, the KV key convention.
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) continue;
    const kvKey = `${parts[0]}:${parts[1]}`;

    const redirect = await articlesKv.get(`redirect:${kvKey}`);
    if (redirect) removed.push(rawUrl);
  }

  if (removed.length === 0) {
    return { ...empty, before: entries.length, after: entries.length };
  }

  for (const url of removed) survivors.add(`<loc>${escXml(url)}</loc>`);
  const updated = existing.replace(
    /[ \t]*<url>[\s\S]*?<\/url>\n?/g,
    (entry) => {
      for (const loc of survivors) {
        if (entry.includes(loc)) return "";
      }
      return entry;
    }
  );

  await articlesKv.put(SITEMAP_KV_KEY, updated);
  return {
    before: entries.length,
    after: entries.length - removed.length,
    removed: removed.length,
    removedSample: removed.slice(0, 10),
    changed: true
  };
}

/**
 * Update the flat sitemap in KV.
 * Reads existing sitemap, adds new URL, writes back.
 */
export async function updateSitemap(
  agent: SEOArticleAgent,
  newUrl: string
): Promise<void> {
  const sitemapKey = SITEMAP_KV_KEY;

  try {
    const existing =
      (await agent.envBindings.ARTICLES_KV.get(sitemapKey)) || "";

    // Check if URL already in sitemap.
    // The stored <loc> value is XML-escaped, so compare against the
    // same escaped form — mirrors updateRssFeed()'s dedup check in
    // feed-syndication.ts which uses escXml(article.canonicalUrl).
    // Append "<" so we match a complete URL at a tag boundary and avoid
    // a false positive when one article slug is a prefix of another
    // (e.g. "cat-water-fountain" inside "cat-water-fountain-with-filter").
    if (existing.includes(`${escXml(newUrl)}<`)) return;

    // If sitemap doesn't exist, create a fresh one
    if (!existing || !existing.includes("<?xml")) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${escXml(newUrl)}</loc><lastmod>${new Date().toISOString().split("T")[0]}</lastmod></url>
</urlset>`;
      await agent.envBindings.ARTICLES_KV.put(sitemapKey, xml);
      return;
    }

    // Insert before closing </urlset>
    const entry = `  <url><loc>${escXml(newUrl)}</loc><lastmod>${new Date().toISOString().split("T")[0]}</lastmod></url>\n`;
    const updated = existing.replace("</urlset>", entry + "</urlset>");
    if (updated === existing) {
      // The sitemap has <?xml but is missing </urlset> — a truncated or
      // corrupted KV value. Rather than silently discarding the URL (which
      // would cause every subsequent publish to also be silently skipped),
      // self-heal: append the new entry directly and close the document.
      // This preserves whatever well-formed content existed before the
      // truncation point and ensures the new URL is never lost.
      const healed = `${existing.trimEnd()}\n${entry}</urlset>\n`;
      await agent.envBindings.ARTICLES_KV.put(sitemapKey, healed);
      agent.log(
        "warning",
        `Sitemap: healed corrupted KV (missing </urlset>) — appended ${newUrl} and closed document`
      );
      return;
    }
    await agent.envBindings.ARTICLES_KV.put(sitemapKey, updated);
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Sitemap update failed (key=${JSON.stringify(sitemapKey)}; url=${JSON.stringify(
        newUrl
      )}): ${errMsg(err)}`
    );
  }
}
