/**
 * Pick which organic SERP URL to treat as the editorial “beat this” competitor.
 * Prefers lab-style / buying-guide pages (Wirecutter-like) over storefront PLPs.
 */

const RETAIL_HOST_SUFFIXES: readonly string[] = [
  "amazon.",
  "amzn.",
  "walmart.com",
  "target.com",
  "ebay.",
  "etsy.com",
  "aliexpress.",
  "wayfair.com",
  "homedepot.com",
  "lowes.com",
  "kohls.com",
  "macys.com",
  "zappos.com",
  "overstock.com",
  "newegg.com",
  "costco.com",
  "samsclub.com",
  "bestbuy.com",
  "ikea.com",
  "shein.com",
  "temu.com",
  "wish.com"
];

/** Social-media and UGC domains that are never useful editorial competitors. */
const SOCIAL_HOSTS = new Set<string>([
  "reddit.com",
  "youtube.com",
  "facebook.com",
  "pinterest.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "tiktok.com",
  "quora.com"
]);

const TIER_A_EDITORIAL = new Set<string>([
  "rtings.com",
  "consumerreports.org",
  "reviewed.com",
  "goodhousekeeping.com",
  "pcmag.com",
  "tomsguide.com",
  "techradar.com",
  "cnet.com",
  "digitaltrends.com",
  "trustedreviews.com",
  "mashable.com",
  "lifewire.com",
  "howtogeek.com",
  "thespruce.com",
  "thesprucepets.com",
  "catster.com",
  "excitedcats.com",
  "petsradar.com"
]);

const TIER_B_EDITORIAL = new Set<string>([
  "forbes.com",
  "businessinsider.com",
  "insider.com",
  "popularmechanics.com",
  "esquire.com",
  "menshealth.com",
  "rover.com",
  "petmd.com",
  "hepper.com",
  "catgear360.com",
  "cats.com",
  "felineliving.net",
  "animalwised.com",
  "dailypaws.com",
  "treehugger.com"
]);

const EDITORIAL_TITLE_HINTS =
  /\b(best|review|reviews|guide|roundup|picks?|tested|lab|compare|vs\.?|top\s+\d+|buying\s+guide|our\s+pick|editors?\s+choice)\b/i;

const EDITORIAL_PATH_HINTS =
  /\/(wirecutter|reviews?|best[-/]|the-best|roundup|guides?|compar(e|ison)|vs[-/]|top[-/])/i;

const CART_PATH_HINTS =
  /\/(cart|checkout|basket|bag|order|account|signin|login|stores?\/|shop\/(cart|checkout))/i;

const DEAL_TITLE_HINTS =
  /\b(price|deal|coupon|off\s+\d+|free\s+shipping|clearance)\b/i;
const SKIP_COMPETITOR_CANDIDATE_SCORE = -10_000;

function hostPath(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = `${u.pathname}${u.search}`.toLowerCase();
    return { host, path };
  } catch {
    return null;
  }
}

function hostMatchesSet(host: string, hosts: Set<string>): boolean {
  for (const h of hosts) {
    if (host === h || host.endsWith(`.${h}`)) return true;
  }
  return false;
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function compareLex(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function dedupeKeyForCompetitorUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : "";
    const normalizedPath =
      parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "");
    const normalizedSearchEntries = [...parsed.searchParams.entries()].sort(
      ([keyA, valueA], [keyB, valueB]) =>
        compareLex(keyA, keyB) || compareLex(valueA, valueB)
    );
    const normalizedSearchParams = new URLSearchParams();
    for (const [key, value] of normalizedSearchEntries) {
      normalizedSearchParams.append(key, value);
    }
    const normalizedSearch = normalizedSearchParams.toString();
    const normalizedSearchSuffix = normalizedSearch
      ? `?${normalizedSearch}`
      : "";
    return `${protocol}//${hostname}${port}${normalizedPath}${normalizedSearchSuffix}`;
  } catch {
    return url;
  }
}

/**
 * Hard-skip URLs we should never spend capture budget on (marketplaces / checkout).
 */
export function shouldSkipCompetitorUrl(url: string): boolean {
  const hp = hostPath(url);
  if (!hp) return true;
  const { host, path } = hp;

  if (CART_PATH_HINTS.test(path)) return true;

  for (const suf of RETAIL_HOST_SUFFIXES) {
    if (suf.endsWith(".")) {
      // TLD-agnostic suffix (e.g. "amazon."): match base domain under any
      // TLD ("amazon.com", "amazon.co.uk") and any subdomain thereof
      // ("smile.amazon.com") without false-positives on unrelated domains
      // that merely contain the retailer name ("notamazon.com").
      if (host.startsWith(suf) || host.includes(`.${suf}`)) return true;
    } else {
      // Full-domain suffix (e.g. "walmart.com"): exact or subdomain match,
      // consistent with the hostMatchesSet / hostMatchesDomain helpers above.
      if (host === suf || host.endsWith(`.${suf}`)) return true;
    }
  }

  if (hostMatchesSet(host, SOCIAL_HOSTS)) return true;

  return false;
}

function editorialHostScore(host: string, path: string): number {
  if (host.includes("nytimes.com")) {
    return path.includes("wirecutter") ? 92 : 16;
  }
  if (host.includes("wirecutter")) return 90;

  if (hostMatchesSet(host, TIER_A_EDITORIAL)) return 82;
  if (hostMatchesSet(host, TIER_B_EDITORIAL)) return 42;

  if (hostMatchesDomain(host, "chewy.com")) return 36;

  return 0;
}

function wirecutterPathBonus(host: string, path: string): number {
  if (host.includes("nytimes.com") && path.includes("wirecutter")) return 8;
  if (host.includes("wirecutter")) return 6;
  return 0;
}

function chewyPathAdjust(host: string, path: string): number {
  if (!hostMatchesDomain(host, "chewy.com")) return 0;
  if (/\/(learn|petcentral|resources)(?:\/|\?|$)/.test(path)) return 24;
  if (/\/(dp|product|p)\b/i.test(path)) return -44;
  return -12;
}

/**
 * Higher score = prefer for competitor capture (editorial / guide intent).
 *
 * Returns `SKIP_COMPETITOR_CANDIDATE_SCORE` for any URL that
 * `shouldSkipCompetitorUrl` rejects (retail, social, or unparseable).
 * `rankSerpUrlsForEditorialCompetitor` filters those out so callers only
 * receive genuinely-scoreable candidates.
 */
function scoreEditorialCompetitorCandidate(
  url: string,
  serpTitle: string
): number {
  if (shouldSkipCompetitorUrl(url)) return SKIP_COMPETITOR_CANDIDATE_SCORE;

  // `shouldSkipCompetitorUrl` returns true whenever `hostPath` returns null,
  // so `hp` is guaranteed non-null here. The guard keeps TypeScript happy.
  const hp = hostPath(url);
  if (!hp) return SKIP_COMPETITOR_CANDIDATE_SCORE;
  const { host, path } = hp;
  const title = serpTitle.trim();

  let score = 0;
  score += editorialHostScore(host, path);
  score += wirecutterPathBonus(host, path);
  score += chewyPathAdjust(host, path);

  if (EDITORIAL_TITLE_HINTS.test(title)) score += 28;
  if (EDITORIAL_PATH_HINTS.test(path)) score += 22;

  if (DEAL_TITLE_HINTS.test(title)) score -= 18;

  return score;
}

/**
 * Returns URLs in best-first order for `captureCompetitor` attempts.
 */
export function rankSerpUrlsForEditorialCompetitor(
  urls: string[],
  titles: string[]
): string[] {
  // Deduplicate while preserving the original parallel title for each URL.
  // Using a plain-index loop (not `for…of`) keeps the original position so
  // `titles[i]` stays in sync after duplicates are dropped.
  const uniquePairs: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < urls.length; i++) {
    const t = urls[i].trim();
    if (!t) continue;
    const dedupeKey = dedupeKeyForCompetitorUrl(t);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    uniquePairs.push({ url: t, title: titles[i] ?? "" });
  }

  const scored = uniquePairs.map(({ url, title }) => ({
    url,
    score: scoreEditorialCompetitorCandidate(url, title)
  }));

  scored.sort((a, b) => b.score - a.score);
  // `scoreEditorialCompetitorCandidate` already tags skip URLs with the
  // sentinel score, so filter on the scored result instead of re-running the
  // same skip predicate (which reparses every URL). If every URL is a skip URL
  // the result is still an empty array.
  return scored
    .filter((entry) => entry.score > SKIP_COMPETITOR_CANDIDATE_SCORE)
    .map((entry) => entry.url);
}
