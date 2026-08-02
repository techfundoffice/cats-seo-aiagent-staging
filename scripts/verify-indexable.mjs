#!/usr/bin/env node
/**
 * Sweep every already-published article URL and verify none of them are
 * noindex — the retrospective half of the indexability guarantee. (The
 * forward half lives in the pipeline: `src/pipeline/indexability.ts`, wired
 * into the publish gate and the post-publish live check in `writer.ts`.)
 *
 * Usage:
 *   node scripts/verify-indexable.mjs [--domain <host>] [--limit <n>]
 *                                     [--strategy mobile|desktop]
 *                                     [--concurrency <n>] [--json <path>]
 *
 * Discovers URLs from the site's RSS feed (`/feed.rss`), follows promotion
 * tombstones (staging → production 301s) so the page that actually serves the
 * content is the one audited, then for each final URL checks:
 *
 *   1. HTTP status
 *   2. `X-Robots-Tag` response header
 *   3. `<meta name="robots">` / `<meta name="googlebot">`
 *   4. Google PageSpeed Insights → Lighthouse `is-crawlable` audit
 *
 * Step 4 needs a key: set `PAGESPEED_API_KEY` in the environment. Without one
 * PSI's shared anonymous quota is effectively always exhausted (HTTP 429), so
 * the script reports those URLs as UNVERIFIED by Google rather than passing
 * them — steps 1–3 still run and still fail the sweep on a real noindex.
 *
 * Exit codes: 0 = every URL indexable, 1 = at least one noindex or error.
 */

const PAGESPEED_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CRAWLER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function parseArgs(argv) {
  const args = {
    domain: "cats-seo-aiagent-staging.webmaster-bc8.workers.dev",
    limit: Infinity,
    strategy: "mobile",
    concurrency: 4,
    json: null
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--domain") ((args.domain = value), i++);
    else if (flag === "--limit") ((args.limit = Number(value)), i++);
    else if (flag === "--strategy") ((args.strategy = value), i++);
    else if (flag === "--concurrency")
      ((args.concurrency = Number(value)), i++);
    else if (flag === "--json") ((args.json = value), i++);
    else if (flag === "--help" || flag === "-h") {
      console.log(
        "Usage: node scripts/verify-indexable.mjs [--domain <host>] [--limit <n>] [--strategy mobile|desktop] [--concurrency <n>] [--json <path>]"
      );
      process.exit(0);
    }
  }
  return args;
}

/** Pull article URLs out of the public RSS feed. */
async function discoverUrls(domain) {
  const feedUrl = `https://${domain}/feed.rss`;
  const resp = await fetch(feedUrl, { headers: { "User-Agent": CRAWLER_UA } });
  if (!resp.ok) {
    throw new Error(`Could not read ${feedUrl}: HTTP ${resp.status}`);
  }
  const xml = await resp.text();
  const urls = new Set();
  for (const match of xml.matchAll(/<link>([^<]+)<\/link>/g)) {
    const url = match[1].trim();
    // Skip the channel-level <link>, which is the bare site root.
    if (new URL(url).pathname.replace(/\/$/, "") === "") continue;
    urls.add(url);
  }
  return [...urls].sort();
}

/**
 * Parse robots directives out of HTML + headers. Mirrors `detectNoindex()` in
 * `src/pipeline/indexability.ts`; kept as a standalone copy so this script
 * runs on plain Node with no build step.
 */
function detectNoindex(html, headers) {
  const directives = [];
  const readAttribute = (tag, attribute) => {
    const m = new RegExp(
      `\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
      "i"
    ).exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
  };

  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = readAttribute(tag, "name")?.toLowerCase();
    if (name !== "robots" && name !== "googlebot") continue;
    const content = readAttribute(tag, "content");
    if (!content) continue;
    for (const directive of content
      .split(",")
      .map((p) => p.trim().toLowerCase())) {
      if (!directive) continue;
      directives.push({
        source: name === "robots" ? "meta-robots" : "meta-googlebot",
        directive,
        userAgent: name === "robots" ? "*" : "googlebot"
      });
    }
  }

  const headerValue = headers?.get?.("x-robots-tag") ?? null;
  if (headerValue) {
    for (const rawPart of headerValue.split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const scope = /^([a-z0-9._-]+)\s*:\s*(.+)$/i.exec(part);
      if (scope && scope[1].toLowerCase() !== "unavailable_after") {
        directives.push({
          source: "x-robots-tag",
          directive: scope[2].trim().toLowerCase(),
          userAgent: scope[1].trim().toLowerCase()
        });
      } else {
        directives.push({
          source: "x-robots-tag",
          directive: part.toLowerCase(),
          userAgent: "*"
        });
      }
    }
  }

  const googleAgents = new Set(["*", "googlebot", "googlebot-news"]);
  const blockedBy = directives.filter(
    (d) =>
      googleAgents.has(d.userAgent) &&
      (d.directive === "noindex" || d.directive === "none")
  );
  return { noindex: blockedBy.length > 0, blockedBy, directives };
}

/** Fetch a URL as Googlebot would, following promotion 301s to the end. */
async function fetchFinal(url) {
  const resp = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": CRAWLER_UA }
  });
  const html = await resp.text();
  return {
    finalUrl: resp.url,
    redirected: resp.url !== url,
    status: resp.status,
    headers: resp.headers,
    html
  };
}

/** Ask Google whether the URL passes Lighthouse's `is-crawlable` audit. */
async function pagespeedVerdict(url, apiKey, strategy) {
  if (!apiKey) {
    return { indexable: null, error: "no PAGESPEED_API_KEY set" };
  }
  const endpoint = new URL(PAGESPEED_ENDPOINT);
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("category", "seo");
  endpoint.searchParams.set("strategy", strategy);
  endpoint.searchParams.set("key", apiKey);

  let resp;
  try {
    resp = await fetch(endpoint, { signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    return { indexable: null, error: `request failed: ${err.message}` };
  }
  let body;
  try {
    body = await resp.json();
  } catch {
    return {
      indexable: null,
      error: `non-JSON response (HTTP ${resp.status})`
    };
  }
  if (!resp.ok || body.error) {
    return {
      indexable: null,
      error: body.error?.message ?? `HTTP ${resp.status}`
    };
  }
  const audit = body.lighthouseResult?.audits?.["is-crawlable"];
  if (!audit || audit.score === undefined || audit.score === null) {
    return { indexable: null, error: "no is-crawlable audit in response" };
  }
  return {
    indexable: audit.score === 1,
    explanation: audit.explanation ?? null,
    seoScore: body.lighthouseResult?.categories?.seo?.score ?? null,
    error: null
  };
}

async function checkOne(url, apiKey, strategy) {
  const result = { url, finalUrl: url, verdict: "unknown", notes: [] };
  let page;
  try {
    page = await fetchFinal(url);
  } catch (err) {
    result.verdict = "error";
    result.notes.push(`fetch failed: ${err.message}`);
    return result;
  }

  result.finalUrl = page.finalUrl;
  result.status = page.status;
  if (page.redirected) result.notes.push(`redirected → ${page.finalUrl}`);

  if (page.status !== 200) {
    result.verdict = "error";
    result.notes.push(`HTTP ${page.status}`);
    return result;
  }

  const local = detectNoindex(page.html, page.headers);
  result.robots = local.directives
    .map((d) => `${d.source}:${d.directive}`)
    .join(", ");
  if (local.noindex) {
    result.verdict = "NOINDEX";
    result.notes.push(
      `blocked by ${[...new Set(local.blockedBy.map((d) => d.source))].join(", ")}`
    );
    return result;
  }

  const psi = await pagespeedVerdict(page.finalUrl, apiKey, strategy);
  result.pagespeed = psi;
  if (psi.indexable === false) {
    result.verdict = "NOINDEX";
    result.notes.push(
      `PageSpeed is-crawlable failed: ${psi.explanation ?? ""}`
    );
  } else if (psi.indexable === true) {
    result.verdict = "indexable";
    result.notes.push(`PageSpeed is-crawlable passed`);
  } else {
    // Local checks passed but Google did not weigh in — report honestly.
    result.verdict = "indexable-unverified";
    result.notes.push(`PageSpeed unavailable: ${psi.error}`);
  }
  return result;
}

/** Run `worker` over `items` with a bounded number in flight. */
async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.PAGESPEED_API_KEY?.trim() || null;

  if (!apiKey) {
    console.warn(
      "⚠️  PAGESPEED_API_KEY not set — Google's is-crawlable verdict will be\n" +
        "    skipped (keyless PSI quota is shared and effectively always\n" +
        "    exhausted). Meta + X-Robots-Tag checks still run and still fail\n" +
        "    the sweep on a real noindex.\n"
    );
  }

  console.log(
    `Discovering article URLs from https://${args.domain}/feed.rss …`
  );
  const all = await discoverUrls(args.domain);
  const urls = all.slice(0, args.limit);
  console.log(`Found ${all.length} URLs; checking ${urls.length}.\n`);

  const results = await mapConcurrent(urls, args.concurrency, async (url) => {
    const r = await checkOne(url, apiKey, args.strategy);
    const icon =
      r.verdict === "indexable"
        ? "✅"
        : r.verdict === "indexable-unverified"
          ? "☑️ "
          : r.verdict === "NOINDEX"
            ? "❌"
            : "⚠️ ";
    console.log(`${icon} ${r.verdict.padEnd(21)} ${r.url}`);
    for (const note of r.notes) console.log(`      ${note}`);
    return r;
  });

  const noindex = results.filter((r) => r.verdict === "NOINDEX");
  const errors = results.filter((r) => r.verdict === "error");
  const confirmed = results.filter((r) => r.verdict === "indexable");
  const unverified = results.filter(
    (r) => r.verdict === "indexable-unverified"
  );

  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(
    `  Confirmed indexable by Google PageSpeed : ${confirmed.length}`
  );
  console.log(
    `  Indexable per meta+header, PSI skipped  : ${unverified.length}`
  );
  console.log(`  NOINDEX                                 : ${noindex.length}`);
  console.log(`  Errors                                  : ${errors.length}`);

  if (args.json) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.json, JSON.stringify(results, null, 2));
    console.log(`\n  Full results → ${args.json}`);
  }

  if (noindex.length > 0) {
    console.error("\n❌ Pages blocked from indexing:");
    for (const r of noindex)
      console.error(`   ${r.finalUrl} — ${r.notes.join("; ")}`);
  }
  process.exit(noindex.length > 0 || errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
