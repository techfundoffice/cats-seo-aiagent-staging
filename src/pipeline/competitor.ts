import type { SEOArticleAgent } from "../server";
import { shouldSkipCompetitorUrl } from "./competitorPick";
import { fetchViaBrightData } from "./brightdata";
import { errMsg, TRANSIENT_HTTP_STATUSES, unescapeHtml } from "./http-utils";

/** Timeout for the initial direct competitor HTML fetch (ms). */
const COMPETITOR_FETCH_TIMEOUT_MS = 10_000;

/** Timeout for the BrightData proxy retry (ms). BrightData adds its own
 * residential-IP hop, so a slightly longer budget prevents false timeouts
 * on legitimate slow responses. */
const COMPETITOR_BRIGHTDATA_TIMEOUT_MS = 20_000;
const COMPETITOR_LOG_URL_MAX_LEN = 140;

/**
 * Structured data extracted from a competitor article for downstream use
 * in `buildArticlePrompt` and SEO scoring.
 */
export interface CompetitorData {
  url: string;
  title: string;
  text: string;
  /** Actual word count of the competitor's article body (0 if unknown) */
  wordCount: number;
  /**
   * H2 and H3 heading text extracted from the competitor article before
   * HTML stripping.  Used downstream in buildArticlePrompt to tell the AI
   * exactly which topics the competitor covers so our article addresses them.
   */
  headings: string[];
}

/**
 * Capture the #1 ranked competitor article for a keyword.
 *
 * Uses fetch() + HTML strip to extract the competitor's title, body text,
 * and real word count. The word count is used downstream to set the AI
 * writing target to competitor_words × 1.10, ensuring we always aim to
 * outrank by depth rather than a hardcoded number.
 */
export async function captureCompetitor(
  agent: SEOArticleAgent,
  competitorUrl: string,
  keyword: string
): Promise<CompetitorData | null> {
  const normalizedCompetitorUrl = competitorUrl.trim();
  if (!normalizedCompetitorUrl) return null;
  if (isCatsluvusCompetitorUrl(normalizedCompetitorUrl)) return null;
  if (shouldSkipCompetitorUrl(normalizedCompetitorUrl)) return null;

  const html = await fetchCompetitorHtml(
    agent,
    normalizedCompetitorUrl,
    keyword
  );
  if (!html) return null;
  return parseCompetitorHtml(agent, normalizedCompetitorUrl, html);
}

/**
 * Direct fetch first; on status in TRANSIENT_HTTP_STATUSES (403 / 429 /
 * 503 — typical CF-IP soft-block by WAF), retry once through the
 * BrightData Web Unlocker proxy when configured.  Returns the HTML or
 * null.  Thrown errors are caught + logged + swallowed.
 */
async function fetchCompetitorHtml(
  agent: SEOArticleAgent,
  url: string,
  keyword: string
): Promise<string | null> {
  const urlForLog =
    url.length <= COMPETITOR_LOG_URL_MAX_LEN
      ? url
      : `${url.slice(0, COMPETITOR_LOG_URL_MAX_LEN)}…`;
  const trimmedKeyword = keyword.trim();
  const keywordForLog = trimmedKeyword
    ? trimmedKeyword.slice(0, 80)
    : "unknown";
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(COMPETITOR_FETCH_TIMEOUT_MS)
    });
    if (resp.ok) return await resp.text();

    const env = agent.envBindings;
    const transient = TRANSIENT_HTTP_STATUSES.has(resp.status);
    const brightDataApiKey = env.BRIGHTDATA_API_KEY?.trim();
    if (transient && brightDataApiKey) {
      agent.log(
        "info",
        `Competitor fetch: HTTP ${resp.status} for ${urlForLog} (keyword=${JSON.stringify(
          keywordForLog
        )}) — retrying via BrightData`
      );
      const retry = await fetchViaBrightData(url, {
        apiKey: brightDataApiKey,
        zone: env.BRIGHTDATA_WEB_UNLOCKER_ZONE,
        timeoutMs: COMPETITOR_BRIGHTDATA_TIMEOUT_MS
      });
      if (retry.ok) return await retry.text();
      agent.log(
        "warning",
        `Competitor BrightData retry: HTTP ${retry.status} for ${urlForLog} (keyword=${JSON.stringify(
          keywordForLog
        )})`
      );
      return null;
    }
    if (transient) {
      agent.log(
        "info",
        `Competitor fetch: HTTP ${resp.status} for ${urlForLog} (keyword=${JSON.stringify(
          keywordForLog
        )}) — likely bot-block; set BRIGHTDATA_API_KEY to enable proxy retry`
      );
    } else {
      agent.log(
        "warning",
        `Competitor fetch: HTTP ${resp.status} for ${urlForLog} (keyword=${JSON.stringify(
          keywordForLog
        )})`
      );
    }
    return null;
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Competitor fetch failed for ${urlForLog} (keyword=${JSON.stringify(
        keywordForLog
      )}): ${errMsg(err)}`
    );
    return null;
  }
}

function isCatsluvusCompetitorUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return hostname === "catsluvus.com" || hostname.endsWith(".catsluvus.com");
  } catch {
    return false;
  }
}

function parseCompetitorHtml(
  agent: SEOArticleAgent,
  competitorUrl: string,
  html: string
): CompetitorData | null {
  // Extract title — decode HTML entities so the AI prompt sees natural text.
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? unescapeHtml(titleMatch[1].replace(/\s+/g, " ").trim()).slice(0, 200)
    : "";

  // Strip to body text — remove scripts, styles, nav, footer, then tags
  let bodyHtml = html;
  bodyHtml = bodyHtml.replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  bodyHtml = bodyHtml.replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  bodyHtml = bodyHtml.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  bodyHtml = bodyHtml.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  bodyHtml = bodyHtml.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
  bodyHtml = bodyHtml.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "");

  // Extract article/main body if available
  const articleMatch =
    bodyHtml.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    bodyHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const contentHtml = articleMatch ? articleMatch[1] : bodyHtml;

  // Extract H2 and H3 heading text before stripping tags.
  // These heading strings are passed downstream to buildArticlePrompt so
  // the AI writer can see the exact structural topics the competitor covers.
  const headings: string[] = [];
  const headingRegex = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  let hMatch: RegExpExecArray | null;
  while ((hMatch = headingRegex.exec(contentHtml)) !== null) {
    const text = unescapeHtml(
      hMatch[1]
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (text.length > 2 && text.length < 200) headings.push(text);
  }

  // Strip remaining tags to get clean plain text, then decode HTML entities
  // (&amp; → &, &#39; → ', &nbsp; → space, etc.) so the AI prompt sees
  // natural prose rather than raw entity sequences.
  const fullText = unescapeHtml(
    contentHtml
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

  if (fullText.length < 100) return null;

  // Count actual words in the full competitor article
  const wordCount = fullText.split(/\s+/).filter((w) => w.length > 1).length;

  // Pass up to 12000 chars to the AI prompt so it can see the full scope
  // of content it needs to beat (raised from 8000 to match the prompt window).
  const text = fullText.slice(0, 12000);

  agent.log(
    "info",
    `Competitor (fetch): "${title.slice(0, 50)}..." — ${wordCount} words, ${headings.length} headings (${text.length} chars passed to prompt)`
  );

  return { url: competitorUrl, title, text, wordCount, headings };
}
