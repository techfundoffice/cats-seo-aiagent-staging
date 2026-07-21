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
  for (const entry of head) {
    const ok = await notifyIndexNowDirect(agent, entry.url);
    if (ok) {
      succeeded++;
    } else {
      stillPending.push(entry);
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
  url: string
): Promise<boolean> {
  // Skip silently while the 403 backoff is active — the activation log
  // line was written when the backoff was set, and the URL stays queued.
  try {
    const backedOff = await agent.envBindings.ARTICLES_KV.get(
      INDEXNOW_403_BACKOFF_KEY
    );
    if (backedOff) return false;
  } catch {
    /* best-effort; fall through */
  }
  const domain = normalizeIndexNowHost(
    getEnvBinding(agent.envBindings, "DOMAIN")
  );
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

    const body: Record<string, unknown> = { host: domain, key, urlList: [url] };
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
      agent.log("info", `IndexNow: ${resp.status} for ${url}`);
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
 * Update the flat sitemap in KV.
 * Reads existing sitemap, adds new URL, writes back.
 */
export async function updateSitemap(
  agent: SEOArticleAgent,
  newUrl: string
): Promise<void> {
  const sitemapKey = "sitemap:flat-sitemap";

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
