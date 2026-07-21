import type { SEOArticleAgent } from "../server";
import { fetchViaBrightData } from "./brightdata";
import { fetchGoogleAutocompletePAA } from "./autocomplete";
import { fetchSerpLive, resolveDataForSeoCreds } from "./dataforseo";
import {
  errMsg,
  TRANSIENT_HTTP_STATUSES,
  keywordToSlug,
  normalizeSingleLine,
  unescapeHtml
} from "./http-utils";

export interface SerpData {
  /** Target word count for the AI = competitor words * 1.10, min 1200 */
  targetWordCount: number;
  /** Actual word count of the #1 competitor article (0 if not captured) */
  competitorWordCount: number;
  /** Page titles of the top organic results from the winning SERP tier. */
  topTitles: string[];
  /** URLs of the top organic results from the winning SERP tier. */
  topUrls: string[];
  /** "People also ask" questions from the winning SERP tier (may be empty). */
  paaQuestions: string[];
  /**
   * Name of the SERP tier that produced this data (e.g. "serper", "brave",
   * "wikipedia"). Empty string when all tiers returned empty results.
   * Surfaced to the activity-log sheet so silent degradation becomes visible.
   */
  serpProvenance?: string;
}

/**
 * Raw result a tier returns on success.  Empty/missing fields are OK;
 * the orchestrator fills them and patches `serpProvenance`.
 */
interface TierResult {
  topTitles: string[];
  topUrls: string[];
  paaQuestions?: string[];
}

/**
 * Subset of Cloudflare Worker env bindings consumed by the SERP tier chain.
 * Each field enables one or more tiers; all fields are optional so the chain
 * degrades gracefully to keyless/archival tiers when credentials are absent.
 *
 * Tier → key(s):
 *   dataforseo  — DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD
 *   serper      — SERPER_API_KEY
 *   brave       — BRAVE_API_KEY
 *   google-cse  — GOOGLE_API_KEY + GOOGLE_CSE_ID
 *   exa         — EXA_API_KEY
 *   searxng     — SEARXNG_BASE_URLS (comma-separated SearXNG instance URLs)
 *   brightdata  — BRIGHTDATA_API_KEY (+ optional BRIGHTDATA_WEB_UNLOCKER_ZONE)
 *   All remaining tiers (qwant, mojeek, ecosia, marginalia, duckduckgo,
 *   common-crawl, wikipedia) are keyless and always available.
 */
export interface SerpEnv {
  GOOGLE_API_KEY?: string;
  GOOGLE_CSE_ID?: string;
  SERPER_API_KEY?: string;
  BRAVE_API_KEY?: string;
  EXA_API_KEY?: string;
  SEARXNG_BASE_URLS?: string;
  BRIGHTDATA_API_KEY?: string;
  BRIGHTDATA_WEB_UNLOCKER_ZONE?: string;
  DATAFORSEO_LOGIN?: string;
  DATAFORSEO_PASSWORD?: string;
}

// Many CF-egress-friendly sites 403 the default Workers UA; share one
// Chrome UA across all HTML-scrape tiers.
const SCRAPE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Per-request timeout for every outbound SERP tier fetch (direct and
 * BrightData proxy). Keeps the 14-tier fallback chain from hanging
 * indefinitely on a slow or stalled upstream — mirrors the pattern used by
 * competitor.ts, dataforseo.ts, and autocomplete.ts.
 */
const SERP_TIER_TIMEOUT_MS = 10_000;

/**
 * Max results returned per SERP tier. Every tier currently slices its
 * raw API response down to this count before returning. Kept as a
 * named constant so any tuning (e.g. bumping to 20 for a broader
 * comparison) is a single-line change.
 */
const MAX_SERP_RESULTS = 10;

/**
 * Compute the AI writing target based on the competitor's real word count.
 * Target = competitor * 1.10, floored at 1200, capped at 5000.
 *
 * Previously capped at 3500, which caused us to always produce shorter
 * articles than major-publication competitors (Catster, Hepper, etc.) that
 * regularly publish 4000–6000 word guides.  The section-by-section expansion
 * system in writer.ts can reach ~4500–5000 words when the per-section targets
 * are set accordingly.  5000 is the new realistic ceiling.
 */
export function computeTargetWordCount(competitorWordCount: number): number {
  if (competitorWordCount > 0) {
    return Math.min(
      5000,
      Math.max(1200, Math.round(competitorWordCount * 1.1))
    );
  }
  return 2000; // safe default when competitor data unavailable
}

/** Run a tier; on success, return {name, data}. On failure, log + null. */
async function tryTier(
  agent: SEOArticleAgent,
  keyword: string,
  name: string,
  fn: () => Promise<TierResult | null>
): Promise<{ name: string; data: TierResult } | null> {
  try {
    const data = await fn();
    if (!data) return null;
    if (!data.topTitles.length && !data.topUrls.length) return null;
    return { name, data };
  } catch (err: unknown) {
    agent.log(
      "warning",
      `SERP (${name}) failed for "${keyword}": ${errMsg(err)}`
    );
    return null;
  }
}

// ── Tier: DataForSEO Google Live Advanced ──────────────────────────────────
async function tierDataForSEO(
  agent: SEOArticleAgent,
  keyword: string,
  env: SerpEnv
): Promise<TierResult | null> {
  const { creds, missing } = resolveDataForSeoCreds(
    env.DATAFORSEO_LOGIN,
    env.DATAFORSEO_PASSWORD
  );
  if (!creds) {
    if (missing.length === 1) {
      agent.log(
        "warning",
        `SERP (dataforseo) skipped: missing ${missing[0]}; set both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to enable DataForSEO SERP tier`
      );
    }
    return null;
  }
  const result = await fetchSerpLive(creds, keyword);
  if ("error" in result) {
    const errorMessage = result.error.trim();
    if (/^(?:HTTP 401\b|status_code=401\d{2}\b)/i.test(errorMessage)) {
      agent.log(
        "warning",
        "SERP (dataforseo): unauthorized response — verify DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD and rotate credentials if needed"
      );
    } else if (/^(?:HTTP 429\b|status_code=402\d{2}\b)/i.test(errorMessage)) {
      agent.log(
        "warning",
        `SERP (dataforseo): rate-limited or quota-exceeded (429/402xx) for "${keyword}" — DataForSEO SERP tier skipped; next article will retry`
      );
    } else {
      agent.log("info", `SERP (dataforseo): ${errorMessage}`);
    }
    return null;
  }
  return {
    topTitles: result.data.topTitles.slice(0, MAX_SERP_RESULTS),
    topUrls: result.data.topUrls.slice(0, MAX_SERP_RESULTS),
    paaQuestions: result.data.paaQuestions.slice(0, MAX_SERP_RESULTS)
  };
}

// ── Tier: Serper.dev ────────────────────────────────────────────────────────
async function tierSerper(
  agent: SEOArticleAgent,
  keyword: string,
  env: SerpEnv
): Promise<TierResult | null> {
  const apiKey = env.SERPER_API_KEY?.trim();
  if (!apiKey) return null;
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q: keyword, num: 10, gl: "us", hl: "en" }),
    signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
  });
  if (!resp.ok) {
    if (resp.status === 401) {
      agent.log(
        "warning",
        "SERP (serper): HTTP 401 unauthorized — verify SERPER_API_KEY and rotate the key if needed"
      );
    } else if (resp.status === 429) {
      agent.log(
        "warning",
        `SERP (serper): rate-limited (429) for "${keyword}" — Serper SERP tier skipped; next article will retry`
      );
    } else {
      agent.log("info", `SERP (serper): HTTP ${resp.status}`);
    }
    return null;
  }
  let data: {
    organic?: Array<{ title?: string; link?: string }>;
    peopleAlsoAsk?: Array<{ question?: string }>;
    error?: string;
  };
  try {
    data = (await resp.json()) as typeof data;
  } catch {
    agent.log(
      "info",
      `SERP (serper): response body is not valid JSON — skipping`
    );
    return null;
  }
  if (data.error) {
    agent.log("info", `SERP (serper): API error — ${data.error}`);
    return null;
  }
  const items = data.organic ?? [];
  return {
    topTitles: items
      .map((i) => i.title ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS),
    topUrls: items
      .map((i) => i.link ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS),
    paaQuestions: (data.peopleAlsoAsk ?? [])
      .map((q) => q.question ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS)
  };
}

// ── Tier: Brave Search API (has FAQ → PAA) ──────────────────────────────────
async function tierBrave(
  agent: SEOArticleAgent,
  keyword: string,
  env: SerpEnv
): Promise<TierResult | null> {
  const apiKey = env.BRAVE_API_KEY?.trim();
  if (!apiKey) return null;
  const q = encodeURIComponent(keyword);
  const resp = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${q}&count=10&country=us`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey
      },
      signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
    }
  );
  if (!resp.ok) {
    if (resp.status === 401) {
      agent.log(
        "warning",
        "SERP (brave): HTTP 401 unauthorized — verify BRAVE_API_KEY and rotate the key if needed"
      );
    } else if (resp.status === 429) {
      agent.log(
        "warning",
        `SERP (brave): rate-limited (429) for "${keyword}" — Brave SERP tier skipped; next article will retry`
      );
    } else {
      agent.log("info", `SERP (brave): HTTP ${resp.status}`);
    }
    return null;
  }
  let data: {
    web?: { results?: Array<{ title?: string; url?: string }> };
    faq?: { results?: Array<{ question?: string }> };
  };
  try {
    data = (await resp.json()) as typeof data;
  } catch {
    agent.log(
      "info",
      `SERP (brave): response body is not valid JSON — skipping`
    );
    return null;
  }
  const webResults = data.web?.results ?? [];
  return {
    topTitles: webResults
      .map((r) => r.title ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS),
    topUrls: webResults
      .map((r) => r.url ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS),
    paaQuestions: (data.faq?.results ?? [])
      .map((f) => f.question ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS)
  };
}

// ── Tier: Google Custom Search JSON ─────────────────────────────────────────
async function tierGoogleCSE(
  agent: SEOArticleAgent,
  keyword: string,
  env: SerpEnv
): Promise<TierResult | null> {
  const apiKey = env.GOOGLE_API_KEY?.trim();
  const cseId = env.GOOGLE_CSE_ID?.trim();
  if (!apiKey || !cseId) {
    if (!apiKey && !cseId) return null;
    const missingBindings = [
      !apiKey ? "GOOGLE_API_KEY" : null,
      !cseId ? "GOOGLE_CSE_ID" : null
    ]
      .filter((v): v is string => Boolean(v))
      .join(", ");
    agent.log(
      "warning",
      `SERP (google-cse) skipped: missing ${missingBindings}; set both GOOGLE_API_KEY and GOOGLE_CSE_ID to enable Google CSE fallback`
    );
    return null;
  }
  const params = new URLSearchParams({
    key: apiKey,
    cx: cseId,
    q: keyword,
    num: "10"
  });
  const resp = await fetch(
    `https://www.googleapis.com/customsearch/v1?${params}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
    }
  );
  if (!resp.ok) {
    if (resp.status === 401) {
      agent.log(
        "warning",
        "SERP (google-cse): HTTP 401 unauthorized — verify GOOGLE_API_KEY / GOOGLE_CSE_ID and rotate the key if needed"
      );
    } else if (resp.status === 429) {
      agent.log(
        "warning",
        `SERP (google-cse): rate-limited (429) for "${keyword}" — Google CSE SERP tier skipped; next article will retry`
      );
    } else {
      agent.log("info", `SERP (google-cse): HTTP ${resp.status}`);
    }
    return null;
  }
  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    agent.log(
      "info",
      `SERP (google-cse): unexpected content-type "${contentType}" — skipping`
    );
    return null;
  }
  let data: {
    items?: Array<{ title?: string; link?: string }>;
    error?: { message?: string; code?: number };
  };
  try {
    data = (await resp.json()) as typeof data;
  } catch {
    agent.log(
      "info",
      `SERP (google-cse): response body is not valid JSON — skipping`
    );
    return null;
  }
  if (data.error) {
    agent.log(
      "info",
      `SERP (google-cse): API error ${data.error.code} — ${data.error.message}`
    );
    return null;
  }
  const items = data.items ?? [];
  return {
    topTitles: items
      .map((i) => i.title ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS),
    topUrls: items
      .map((i) => i.link ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS)
  };
}

// ── Tier: Qwant JSON (keyless) ──────────────────────────────────────────────
async function tierQwant(
  agent: SEOArticleAgent,
  keyword: string
): Promise<TierResult | null> {
  const q = encodeURIComponent(keyword);
  const resp = await fetch(
    `https://api.qwant.com/v3/search/web?q=${q}&count=10&locale=en_US&safesearch=1`,
    {
      headers: {
        "User-Agent": SCRAPE_UA,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
    }
  );
  if (!resp.ok) {
    agent.log("info", `SERP (qwant): HTTP ${resp.status}`);
    return null;
  }
  const ctQ = resp.headers.get("content-type") ?? "";
  if (!ctQ.includes("json")) {
    agent.log(
      "info",
      `SERP (qwant): unexpected content-type "${ctQ}" — skipping`
    );
    return null;
  }
  let data: {
    data?: {
      result?: {
        items?: {
          mainline?: Array<{
            type?: string;
            items?: Array<{ title?: string; url?: string }>;
          }>;
        };
      };
    };
  };
  try {
    data = (await resp.json()) as typeof data;
  } catch {
    agent.log(
      "info",
      `SERP (qwant): response body is not valid JSON — skipping`
    );
    return null;
  }
  const mainline = data.data?.result?.items?.mainline ?? [];
  const webBlock = mainline.find((b) => b.type === "web");
  const items = webBlock?.items ?? [];
  return {
    topTitles: items
      .map((i) => stripHtml(i.title ?? ""))
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS),
    topUrls: items
      .map((i) => i.url ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS)
  };
}

// ── Tier: Mojeek HTML (BrightData retry on transient) ──────────────────────
async function tierMojeek(
  agent: SEOArticleAgent,
  keyword: string,
  env: SerpEnv
): Promise<TierResult | null> {
  const url = `https://www.mojeek.com/search?q=${encodeURIComponent(keyword)}`;
  const html = await fetchHtmlWithBrightDataRetry(agent, "mojeek", url, env);
  if (!html) return null;
  return parseMojeekHtml(html);
}

function parseMojeekHtml(html: string): TierResult {
  const titleMatches =
    html.match(/<a[^>]*class="ob"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g) ||
    [];
  const topTitles: string[] = [];
  const topUrls: string[] = [];
  for (const m of titleMatches.slice(0, MAX_SERP_RESULTS)) {
    const hrefMatch = m.match(/href="([^"]+)"/);
    const titleMatch = m.match(/>([\s\S]*?)<\/a>/);
    if (hrefMatch && titleMatch) {
      topUrls.push(hrefMatch[1]);
      topTitles.push(stripHtml(titleMatch[1]));
    }
  }
  return { topTitles, topUrls };
}

// ── Tier: Ecosia HTML (BrightData retry on transient) ──────────────────────
async function tierEcosia(
  agent: SEOArticleAgent,
  keyword: string,
  env: SerpEnv
): Promise<TierResult | null> {
  const url = `https://www.ecosia.org/search?q=${encodeURIComponent(keyword)}`;
  const html = await fetchHtmlWithBrightDataRetry(agent, "ecosia", url, env);
  if (!html) return null;
  // Ecosia result cards: <a class="result-title" href="..."><h2>TITLE</h2></a>
  const topTitles: string[] = [];
  const topUrls: string[] = [];
  const re =
    /<a[^>]+class="[^"]*result-title[^"]*"[^>]+href="([^"]+)"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && topUrls.length < 10) {
    topUrls.push(match[1]);
    topTitles.push(stripHtml(match[2]));
  }
  return { topTitles, topUrls };
}

// ── Tier: Marginalia JSON (keyless) ─────────────────────────────────────────
async function tierMarginalia(
  agent: SEOArticleAgent,
  keyword: string
): Promise<TierResult | null> {
  const q = encodeURIComponent(keyword);
  const resp = await fetch(
    `https://search.marginalia.nu/search?query=${q}&profile=no-js&format=json`,
    {
      headers: { "User-Agent": SCRAPE_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
    }
  );
  if (!resp.ok) {
    agent.log("info", `SERP (marginalia): HTTP ${resp.status}`);
    return null;
  }
  const ct = resp.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    agent.log(
      "info",
      `SERP (marginalia): unexpected content-type "${ct}" — skipping`
    );
    return null;
  }
  let data: { results?: Array<{ title?: string; url?: string }> };
  try {
    data = (await resp.json()) as {
      results?: Array<{ title?: string; url?: string }>;
    };
  } catch {
    agent.log(
      "info",
      `SERP (marginalia): response body is not valid JSON — skipping`
    );
    return null;
  }
  const items = data.results ?? [];
  return {
    topTitles: items
      .map((i) => i.title ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS),
    topUrls: items
      .map((i) => i.url ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS)
  };
}

// ── Tier: SearXNG (round-robin across SEARXNG_BASE_URLS) ───────────────────
async function tierSearXNG(
  agent: SEOArticleAgent,
  keyword: string,
  env: SerpEnv
): Promise<TierResult | null> {
  const bases = (env.SEARXNG_BASE_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (bases.length === 0) return null;
  for (const base of bases) {
    try {
      const q = encodeURIComponent(keyword);
      const resp = await fetch(`${base}/search?q=${q}&format=json`, {
        headers: { "User-Agent": SCRAPE_UA, Accept: "application/json" },
        signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
      });
      if (!resp.ok) {
        agent.log(
          "info",
          `SERP (searxng ${base}): HTTP ${resp.status} — trying next instance`
        );
        continue;
      }
      let data: { results?: Array<{ title?: string; url?: string }> };
      try {
        data = (await resp.json()) as {
          results?: Array<{ title?: string; url?: string }>;
        };
      } catch {
        agent.log(
          "info",
          `SERP (searxng ${base}): response body is not valid JSON — trying next instance`
        );
        continue;
      }
      const items = data.results ?? [];
      if (items.length === 0) continue;
      return {
        topTitles: items
          .map((i) => i.title ?? "")
          .filter(Boolean)
          .slice(0, MAX_SERP_RESULTS),
        topUrls: items
          .map((i) => i.url ?? "")
          .filter(Boolean)
          .slice(0, MAX_SERP_RESULTS)
      };
    } catch (err: unknown) {
      agent.log(
        "info",
        `SERP (searxng ${base}): ${errMsg(err)} — trying next instance`
      );
    }
  }
  return null;
}

// ── Tier: Exa (Metaphor) Neural ────────────────────────────────────────────
async function tierExa(
  agent: SEOArticleAgent,
  keyword: string,
  env: SerpEnv
): Promise<TierResult | null> {
  const apiKey = env.EXA_API_KEY?.trim();
  if (!apiKey) return null;
  const resp = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({ query: keyword, numResults: 10, type: "neural" }),
    signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
  });
  if (!resp.ok) {
    if (resp.status === 401) {
      agent.log(
        "warning",
        "SERP (exa): HTTP 401 unauthorized — verify EXA_API_KEY and rotate the key if needed"
      );
    } else if (resp.status === 429) {
      agent.log(
        "warning",
        `SERP (exa): rate-limited (429) for "${keyword}" — Exa SERP tier skipped; next article will retry`
      );
    } else {
      agent.log("info", `SERP (exa): HTTP ${resp.status}`);
    }
    return null;
  }
  const ctExa = resp.headers.get("content-type") ?? "";
  if (!ctExa.includes("json")) {
    agent.log(
      "info",
      `SERP (exa): unexpected content-type "${ctExa}" — skipping`
    );
    return null;
  }
  let data: { results?: Array<{ title?: string; url?: string }> };
  try {
    data = (await resp.json()) as {
      results?: Array<{ title?: string; url?: string }>;
    };
  } catch {
    agent.log("info", `SERP (exa): response body is not valid JSON — skipping`);
    return null;
  }
  const items = data.results ?? [];
  return {
    topTitles: items
      .map((i) => i.title ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS),
    topUrls: items
      .map((i) => i.url ?? "")
      .filter(Boolean)
      .slice(0, MAX_SERP_RESULTS)
  };
}

// ── Tier: DuckDuckGo HTML (keyless) ─────────────────────────────────────────
async function tierDuckDuckGo(
  agent: SEOArticleAgent,
  keyword: string
): Promise<TierResult | null> {
  const encoded = encodeURIComponent(keyword);
  const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
    headers: {
      "User-Agent": SCRAPE_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    },
    signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
  });
  if (!resp.ok) {
    agent.log("info", `SERP (duckduckgo): HTTP ${resp.status}`);
    return null;
  }
  const html = await resp.text();
  return parseDuckDuckGoHtml(html);
}

function parseDuckDuckGoHtml(html: string): TierResult {
  // Pair extraction in a SINGLE regex so titles and URLs are
  // guaranteed to come from the same <a class="result__a"> element.
  // Previous implementation extracted titles and URLs in two
  // independent passes then paired by index — any anchor missing one
  // of the two attributes would misalign every subsequent pair,
  // feeding the writer prompt wrong title↔URL pairings (silent SEO
  // signal corruption — Mojeek and Ecosia tiers already use this
  // safer single-pass shape).
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const topTitles: string[] = [];
  const topUrls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && topUrls.length < MAX_SERP_RESULTS) {
    const hrefRaw = m[1];
    const titleRaw = m[2];
    // Resolve uddg= redirect / scheme-relative / scheme-less URLs.
    // decodeURIComponent can throw URIError on malformed
    // percent-encoding; guard so one bad redirect doesn't kill the
    // whole tier.
    let url = "";
    if (hrefRaw.includes("uddg=")) {
      const uddg = hrefRaw.match(/uddg=([^&]+)/);
      if (uddg) {
        try {
          url = decodeURIComponent(uddg[1]);
        } catch {
          url = "";
        }
      }
    } else if (hrefRaw.startsWith("http")) {
      url = hrefRaw;
    } else if (hrefRaw.startsWith("//")) {
      url = `https:${hrefRaw}`;
    } else {
      url = `https://${hrefRaw}`;
    }
    if (!url) continue;
    const title = titleRaw.replace(/<[^>]*>/g, "").trim();
    if (!title) continue;
    topUrls.push(url);
    topTitles.push(title);
  }
  return { topTitles, topUrls };
}

// ── Tier: Bing via BrightData (BrightData REQUIRED) ────────────────────────
async function tierBingViaBrightData(
  agent: SEOArticleAgent,
  keyword: string,
  env: SerpEnv
): Promise<TierResult | null> {
  const brightDataApiKey = env.BRIGHTDATA_API_KEY?.trim();
  if (!brightDataApiKey) return null;
  const url = `https://www.bing.com/search?q=${encodeURIComponent(keyword)}&count=10`;
  const resp = await fetchViaBrightData(url, {
    apiKey: brightDataApiKey,
    zone: env.BRIGHTDATA_WEB_UNLOCKER_ZONE,
    timeoutMs: SERP_TIER_TIMEOUT_MS
  });
  if (!resp.ok) {
    if (resp.status === 401) {
      agent.log(
        "warning",
        "SERP (bing-brightdata): HTTP 401 unauthorized — verify BRIGHTDATA_API_KEY and rotate the key if needed"
      );
    } else if (resp.status === 429) {
      agent.log(
        "warning",
        `SERP (bing-brightdata): rate-limited (429) for "${keyword}" — BrightData tier skipped; next article will retry`
      );
    } else {
      agent.log("info", `SERP (bing-brightdata): HTTP ${resp.status}`);
    }
    return null;
  }
  const html = await resp.text();
  const topTitles: string[] = [];
  const topUrls: string[] = [];
  const re =
    /<li class="b_algo">[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && topUrls.length < 10) {
    topUrls.push(match[1]);
    topTitles.push(stripHtml(match[2]));
  }
  return { topTitles, topUrls };
}

// ── Tier: Common Crawl index (keyless, archival floor) ─────────────────────
async function tierCommonCrawl(
  agent: SEOArticleAgent,
  keyword: string
): Promise<TierResult | null> {
  // Find the latest available crawl index
  const indexListResp = await fetch(
    "https://index.commoncrawl.org/collinfo.json",
    {
      headers: { Accept: "application/json", "User-Agent": SCRAPE_UA },
      signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
    }
  );
  if (!indexListResp.ok) {
    agent.log(
      "info",
      `SERP (common-crawl): collinfo HTTP ${indexListResp.status}`
    );
    return null;
  }
  const indexes = (await indexListResp.json()) as Array<{ id?: string }>;
  const latest = indexes.find((i) => i.id)?.id;
  if (!latest) return null;
  const kwSlug = keywordToSlug(keyword);
  const url = `https://index.commoncrawl.org/${latest}-index?url=*${encodeURIComponent(kwSlug)}*&output=json&limit=10`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": SCRAPE_UA },
    signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
  });
  if (!resp.ok) {
    agent.log("info", `SERP (common-crawl): HTTP ${resp.status}`);
    return null;
  }
  const text = await resp.text();
  // Each line is a JSON record
  const topUrls: string[] = [];
  for (const line of text.split("\n").slice(0, MAX_SERP_RESULTS)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { url?: string };
      if (rec.url) topUrls.push(rec.url);
    } catch {
      /* line-level parse errors are non-fatal */
    }
  }
  return { topTitles: topUrls.map(urlToTitle), topUrls };
}

// ── Tier: Wikipedia OpenSearch (keyless, never-empty floor) ────────────────
async function tierWikipedia(
  agent: SEOArticleAgent,
  keyword: string
): Promise<TierResult | null> {
  const q = encodeURIComponent(keyword);
  const resp = await fetch(
    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${q}&limit=10&format=json&origin=*`,
    {
      headers: { "User-Agent": SCRAPE_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
    }
  );
  if (!resp.ok) {
    agent.log("info", `SERP (wikipedia): HTTP ${resp.status}`);
    return null;
  }
  const data = (await resp.json()) as [string, string[], string[], string[]];
  const titles = data[1] ?? [];
  const urls = data[3] ?? [];
  return {
    topTitles: titles.slice(0, MAX_SERP_RESULTS),
    topUrls: urls.slice(0, MAX_SERP_RESULTS)
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────
/**
 * Collect SERP titles/URLs/PAA from the first tier that returns non-empty
 * results, in configured priority order. Computes target word count once
 * from the competitor baseline and carries it through regardless of tier.
 *
 * Returns empty lists with `serpProvenance: ""` only when every tier fails.
 */
export async function analyzeSERP(
  agent: SEOArticleAgent,
  keyword: string,
  env?: SerpEnv,
  competitorWordCount = 0
): Promise<SerpData> {
  const targetWordCount = computeTargetWordCount(competitorWordCount);
  const e: SerpEnv = env ?? {};

  // Priority order: paid-key > free-key > keyless > proxied > archival floor.
  // Brave is promoted above Google CSE because Brave returns FAQ results (PAA)
  // that Google CSE never had, and the gap matters for article quality.
  const chain: Array<[string, () => Promise<TierResult | null>]> = [
    ["dataforseo", () => tierDataForSEO(agent, keyword, e)],
    ["serper", () => tierSerper(agent, keyword, e)],
    ["brave", () => tierBrave(agent, keyword, e)],
    ["google-cse", () => tierGoogleCSE(agent, keyword, e)],
    ["qwant", () => tierQwant(agent, keyword)],
    ["mojeek", () => tierMojeek(agent, keyword, e)],
    ["ecosia", () => tierEcosia(agent, keyword, e)],
    ["marginalia", () => tierMarginalia(agent, keyword)],
    ["searxng", () => tierSearXNG(agent, keyword, e)],
    ["exa", () => tierExa(agent, keyword, e)],
    ["duckduckgo", () => tierDuckDuckGo(agent, keyword)],
    ["bing-brightdata", () => tierBingViaBrightData(agent, keyword, e)],
    ["common-crawl", () => tierCommonCrawl(agent, keyword)],
    ["wikipedia", () => tierWikipedia(agent, keyword)]
  ];

  for (const [name, fn] of chain) {
    const hit = await tryTier(agent, keyword, name, fn);
    if (!hit) continue;
    let paaQuestions = hit.data.paaQuestions ?? [];
    // Supplement PAA from Google Autocomplete whenever the winning tier
    // returned none (every tier below Serper/Brave falls into this branch).
    // Autocomplete is keyless and CF-friendly — individual prefix failures
    // are swallowed inside fetchGoogleAutocompletePAA; total failures are
    // surfaced via the onWarn callback so they appear in the activity feed.
    if (paaQuestions.length === 0) {
      const supplement = await fetchGoogleAutocompletePAA(keyword, (msg) =>
        agent.log(
          "warning",
          `SERP PAA supplement (google-autocomplete): ${msg}`
        )
      );
      if (supplement.length > 0) paaQuestions = supplement;
    }
    agent.log(
      "info",
      `SERP (${name}): ${hit.data.topTitles.length} titles, ${hit.data.topUrls.length} URLs, ${paaQuestions.length} PAA — target ${targetWordCount} words (competitor: ${competitorWordCount})`
    );
    return {
      targetWordCount,
      competitorWordCount,
      topTitles: hit.data.topTitles,
      topUrls: hit.data.topUrls,
      paaQuestions,
      serpProvenance: name
    };
  }

  // Build a hint listing which API-key-gated tiers were configured so the
  // operator can distinguish "no keys set" (pure config gap) from "keys set
  // but all APIs unreachable" (network/outage issue). Keyless tiers are
  // always attempted so they are not included in the hint.
  const configuredKeyedTiers: string[] = [];
  const partiallyConfiguredKeyedTiers: string[] = [];
  const { creds: dataForSeoCreds, missing: dataForSeoMissing } =
    resolveDataForSeoCreds(e.DATAFORSEO_LOGIN, e.DATAFORSEO_PASSWORD);
  if (dataForSeoCreds) {
    configuredKeyedTiers.push("dataforseo");
  } else if (dataForSeoMissing.length === 1) {
    partiallyConfiguredKeyedTiers.push("dataforseo");
  }
  if (e.SERPER_API_KEY?.trim()) configuredKeyedTiers.push("serper");
  if (e.BRAVE_API_KEY?.trim()) configuredKeyedTiers.push("brave");
  const hasGoogleApiKey = !!e.GOOGLE_API_KEY?.trim();
  const hasGoogleCseId = !!e.GOOGLE_CSE_ID?.trim();
  if (hasGoogleApiKey && hasGoogleCseId) {
    configuredKeyedTiers.push("google-cse");
  } else if (hasGoogleApiKey || hasGoogleCseId) {
    partiallyConfiguredKeyedTiers.push("google-cse");
  }
  if (e.EXA_API_KEY?.trim()) configuredKeyedTiers.push("exa");
  if (e.SEARXNG_BASE_URLS?.trim()) configuredKeyedTiers.push("searxng");
  if (e.BRIGHTDATA_API_KEY?.trim()) configuredKeyedTiers.push("brightdata");
  const hintParts =
    configuredKeyedTiers.length > 0
      ? [`keyed tiers: ${configuredKeyedTiers.join(", ")}`]
      : ["no keyed tiers configured"];
  if (partiallyConfiguredKeyedTiers.length > 0) {
    hintParts.push(
      `partial keyed tiers: ${partiallyConfiguredKeyedTiers.join(", ")}`
    );
  }
  const configuredHint = ` [${hintParts.join("; ")}]`;
  agent.log(
    "warning",
    `SERP: all sources failed for "${keyword}" — target ${targetWordCount} words (competitor: ${competitorWordCount})${configuredHint}`
  );
  return {
    targetWordCount,
    competitorWordCount,
    topTitles: [],
    topUrls: [],
    paaQuestions: [],
    serpProvenance: ""
  };
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * HTML-scrape tier helper: direct fetch first.  On status in
 * TRANSIENT_HTTP_STATUSES (typically 403/429/503 — CF IP soft-block),
 * retry once through BrightData when configured.  Returns HTML or null.
 */
async function fetchHtmlWithBrightDataRetry(
  agent: SEOArticleAgent,
  source: string,
  url: string,
  env: SerpEnv
): Promise<string | null> {
  const brightDataApiKey = env.BRIGHTDATA_API_KEY?.trim();
  const urlForLog = normalizeSingleLine(url).trim() || "(empty url)";
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        "User-Agent": SCRAPE_UA,
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(SERP_TIER_TIMEOUT_MS)
    });
  } catch (err: unknown) {
    agent.log(
      "warning",
      `SERP (${source}) direct fetch failed for ${urlForLog}: ${errMsg(err)}`
    );
    return null;
  }
  if (resp.ok) return resp.text();
  const transient = TRANSIENT_HTTP_STATUSES.has(resp.status);
  if (!transient || !brightDataApiKey) {
    const hint =
      transient && !brightDataApiKey
        ? " — likely bot-block; set BRIGHTDATA_API_KEY to enable proxy retry"
        : "";
    agent.log(
      "info",
      `SERP (${source}): HTTP ${resp.status} for ${urlForLog}${hint}`
    );
    return null;
  }
  agent.log(
    "info",
    `SERP (${source}): HTTP ${resp.status} for ${urlForLog} — retrying via BrightData`
  );
  try {
    const retry = await fetchViaBrightData(url, {
      apiKey: brightDataApiKey,
      zone: env.BRIGHTDATA_WEB_UNLOCKER_ZONE,
      timeoutMs: SERP_TIER_TIMEOUT_MS
    });
    if (!retry.ok) {
      agent.log(
        "info",
        `SERP (${source}) BrightData: HTTP ${retry.status} for ${urlForLog}`
      );
      return null;
    }
    return retry.text();
  } catch (err: unknown) {
    agent.log(
      "warning",
      `SERP (${source}) BrightData fetch failed for ${urlForLog}: ${errMsg(err)}`
    );
    return null;
  }
}

function stripHtml(s: string): string {
  return unescapeHtml(s.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function urlToTitle(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const pathSlug = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const readable = pathSlug.replace(/[-_]+/g, " ").replace(/\.\w+$/, "");
    return readable ? `${host} — ${readable}` : host;
  } catch {
    return url;
  }
}
