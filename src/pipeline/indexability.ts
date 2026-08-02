/**
 * Indexability verification — "is this page allowed into Google's index?"
 *
 * Two layers, both needed:
 *
 *  1. `detectNoindex()` — a local parse of the robots directives Google
 *     actually reads: `<meta name="robots">`, `<meta name="googlebot">`, and
 *     the `X-Robots-Tag` response header. This is the same signal set
 *     Lighthouse's `is-crawlable` audit evaluates, so it can run inside the
 *     Worker with no network round-trip and no API quota.
 *
 *  2. `verifyIndexableViaPageSpeed()` — the authoritative second opinion:
 *     Google's own PageSpeed Insights API, which runs Lighthouse against the
 *     live URL from Google's infrastructure. It sees what Googlebot sees
 *     (post-JS DOM + real response headers), so it catches a noindex injected
 *     by a CDN, a WordPress plugin, or client-side JS — none of which appear
 *     in the HTML this pipeline hands to KV.
 *
 * Layer 1 gates every publish (cheap, always on). Layer 2 is used by
 * `scripts/verify-indexable.mjs` to sweep already-published URLs, and runs
 * post-publish when `PAGESPEED_API_KEY` is configured.
 */

/** A single robots directive found on a page, with where it came from. */
export interface RobotsDirective {
  /** Where the directive was read from. */
  source: "meta-robots" | "meta-googlebot" | "x-robots-tag";
  /** Raw directive text, lowercased (e.g. `noindex`, `max-snippet:-1`). */
  directive: string;
  /**
   * User-agent the directive is scoped to. `*` for an unscoped
   * `X-Robots-Tag`/`<meta name="robots">`; otherwise the named bot
   * (`googlebot` from either `<meta name="googlebot">` or the
   * `X-Robots-Tag: googlebot: noindex` form).
   */
  userAgent: string;
}

export interface NoindexResult {
  /**
   * True when a directive Googlebot obeys blocks indexing — `noindex` or
   * `none` on an unscoped or googlebot-scoped rule. Directives scoped to
   * some other crawler (e.g. `X-Robots-Tag: bingbot: noindex`) do NOT set
   * this, because they do not affect Google's index.
   */
  noindex: boolean;
  /** Which sources carried the blocking directive. Empty when indexable. */
  blockedBy: RobotsDirective[];
  /** Every robots directive parsed, blocking or not — for diagnostics. */
  directives: RobotsDirective[];
  /**
   * `unavailable_after` dates found. Not a current noindex, but a scheduled
   * one: Google drops the page from the index after this timestamp.
   */
  unavailableAfter: string[];
  /** Human-readable one-liner for logs and escalation bodies. */
  detail: string;
}

/** Crawlers whose directives affect Google's index. */
const GOOGLE_USER_AGENTS = new Set(["*", "googlebot", "googlebot-news"]);

/**
 * Extract an attribute value from a single `<meta ...>` tag. Handles
 * double-quoted, single-quoted, and unquoted values, and does not care about
 * attribute order — `<meta content="noindex" name="robots">` parses the same
 * as the conventional ordering.
 */
function readAttribute(tag: string, attribute: string): string | null {
  const pattern = new RegExp(
    `\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i"
  );
  const match = pattern.exec(tag);
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/** Split a robots content value into individual lowercased directives. */
function splitDirectives(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

/**
 * Parse one `X-Robots-Tag` header value. The header may be user-agent scoped
 * (`googlebot: noindex, nofollow`) or unscoped (`noindex`). Multiple headers
 * are sent as repeated headers, which `Headers.get()` joins with `, ` — so a
 * joined value is split on commas first, then each part is checked for a
 * `<ua>:` prefix.
 */
function parseXRobotsTag(value: string): RobotsDirective[] {
  const directives: RobotsDirective[] = [];
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    // `unavailable_after: <date>` uses a colon but is a directive, not a
    // user-agent scope — the RFC-1123/ISO date that follows contains its
    // own colons, so scope detection must exclude it explicitly.
    const scopeMatch = /^([a-z0-9._-]+)\s*:\s*(.+)$/i.exec(part);
    if (scopeMatch && scopeMatch[1].toLowerCase() !== "unavailable_after") {
      directives.push({
        source: "x-robots-tag",
        directive: scopeMatch[2].trim().toLowerCase(),
        userAgent: scopeMatch[1].trim().toLowerCase()
      });
      continue;
    }
    directives.push({
      source: "x-robots-tag",
      directive: part.toLowerCase(),
      userAgent: "*"
    });
  }
  return directives;
}

/**
 * Detect whether a page blocks Google from indexing it.
 *
 * @param html      The page HTML. For the most faithful verdict pass the
 *                  post-JS rendered HTML (Browser Rendering `/content`), not
 *                  the pre-publish string — a noindex injected at runtime
 *                  only exists in the rendered DOM.
 * @param headers   Optional response headers, so `X-Robots-Tag` is checked
 *                  too. A header-only noindex is invisible in the HTML and is
 *                  the failure mode most likely to go unnoticed.
 */
export function detectNoindex(
  html: string,
  headers?: Headers | Record<string, string> | null
): NoindexResult {
  const directives: RobotsDirective[] = [];
  const unavailableAfter: string[] = [];

  // ── <meta name="robots"> / <meta name="googlebot"> ──────────────────────
  // Only the <head> matters for robots meta tags, but Google tolerates them
  // anywhere in the document, so scan the whole thing.
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const name = readAttribute(tag, "name")?.toLowerCase();
    if (name !== "robots" && name !== "googlebot") continue;
    const content = readAttribute(tag, "content");
    if (!content) continue;
    for (const directive of splitDirectives(content)) {
      if (directive.startsWith("unavailable_after")) {
        unavailableAfter.push(directive);
      }
      directives.push({
        source: name === "robots" ? "meta-robots" : "meta-googlebot",
        directive,
        userAgent: name === "robots" ? "*" : "googlebot"
      });
    }
  }

  // ── X-Robots-Tag response header ────────────────────────────────────────
  let headerValue: string | null = null;
  if (headers instanceof Headers) {
    headerValue = headers.get("x-robots-tag");
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "x-robots-tag") {
        headerValue = value;
        break;
      }
    }
  }
  if (headerValue) {
    for (const parsed of parseXRobotsTag(headerValue)) {
      if (parsed.directive.startsWith("unavailable_after")) {
        unavailableAfter.push(parsed.directive);
      }
      directives.push(parsed);
    }
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  // `none` is shorthand for `noindex, nofollow`, so it blocks indexing too.
  const blockedBy = directives.filter(
    (d) =>
      GOOGLE_USER_AGENTS.has(d.userAgent) &&
      (d.directive === "noindex" || d.directive === "none")
  );

  let detail: string;
  if (blockedBy.length > 0) {
    const sources = [...new Set(blockedBy.map((d) => d.source))].join(", ");
    detail = `noindex via ${sources}`;
  } else if (unavailableAfter.length > 0) {
    detail = `indexable now, but scheduled to drop: ${unavailableAfter.join(", ")}`;
  } else if (directives.length > 0) {
    detail = `indexable (${directives.map((d) => d.directive).join(", ")})`;
  } else {
    detail = "indexable (no robots directives)";
  }

  return {
    noindex: blockedBy.length > 0,
    blockedBy,
    directives,
    unavailableAfter,
    detail
  };
}

/** Verdict from Google's PageSpeed Insights / Lighthouse `is-crawlable` audit. */
export interface PageSpeedIndexabilityResult {
  url: string;
  /**
   * `true` when Lighthouse's `is-crawlable` audit passed (page is indexable),
   * `false` when it failed, `null` when the audit could not be obtained
   * (network error, quota, non-200 from PSI). `null` is NOT a pass — callers
   * must treat it as "unverified."
   */
  indexable: boolean | null;
  /** Lighthouse SEO category score, 0–1, when available. */
  seoScore: number | null;
  /** Lighthouse's own explanation when the audit failed. */
  explanation: string | null;
  /** HTTP status PSI reported for the audited URL, when available. */
  pageStatusCode: number | null;
  /** Populated when the verdict is `null`. */
  error: string | null;
}

const PAGESPEED_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/**
 * Ask Google's PageSpeed Insights API whether a live URL is indexable.
 *
 * Reads the Lighthouse `is-crawlable` audit ("Page is blocked from indexing"),
 * which evaluates robots meta tags, the `X-Robots-Tag` header, AND robots.txt
 * against the rendered page — the full picture, from Google's own crawler
 * infrastructure rather than from our assumptions about it.
 *
 * @param apiKey Optional. Without one PSI uses a shared anonymous quota that
 *               is usually exhausted (HTTP 429); supply a key from
 *               https://developers.google.com/speed/docs/insights/v5/get-started
 *               for reliable results.
 */
export async function verifyIndexableViaPageSpeed(
  url: string,
  apiKey?: string,
  options: { strategy?: "mobile" | "desktop"; timeoutMs?: number } = {}
): Promise<PageSpeedIndexabilityResult> {
  const { strategy = "mobile", timeoutMs = 120_000 } = options;
  const endpoint = new URL(PAGESPEED_ENDPOINT);
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("category", "seo");
  endpoint.searchParams.set("strategy", strategy);
  if (apiKey?.trim()) endpoint.searchParams.set("key", apiKey.trim());

  const base: PageSpeedIndexabilityResult = {
    url,
    indexable: null,
    seoScore: null,
    explanation: null,
    pageStatusCode: null,
    error: null
  };

  let resp: Response;
  try {
    resp = await fetch(endpoint.toString(), {
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    return {
      ...base,
      error: `PageSpeed request failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  const rawBody = await resp.text();
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return {
      ...base,
      error: `PageSpeed returned non-JSON (HTTP ${resp.status}): ${rawBody.slice(0, 200)}`
    };
  }

  const body = payload as {
    error?: { message?: string; status?: string };
    lighthouseResult?: {
      categories?: { seo?: { score?: number | null } };
      audits?: Record<
        string,
        {
          score?: number | null;
          explanation?: string;
          numericValue?: number;
        }
      >;
    };
  };

  if (!resp.ok || body.error) {
    const message = body.error?.message ?? `HTTP ${resp.status}`;
    return { ...base, error: `PageSpeed error: ${message}` };
  }

  const audits = body.lighthouseResult?.audits;
  const crawlable = audits?.["is-crawlable"];
  if (!crawlable || crawlable.score === undefined || crawlable.score === null) {
    return {
      ...base,
      seoScore: body.lighthouseResult?.categories?.seo?.score ?? null,
      error: "PageSpeed response contained no `is-crawlable` audit"
    };
  }

  const statusAudit = audits?.["http-status-code"];
  return {
    url,
    // Lighthouse scores binary audits as 1 (pass) or 0 (fail).
    indexable: crawlable.score === 1,
    seoScore: body.lighthouseResult?.categories?.seo?.score ?? null,
    explanation: crawlable.explanation ?? null,
    pageStatusCode:
      typeof statusAudit?.numericValue === "number"
        ? statusAudit.numericValue
        : null,
    error: null
  };
}
