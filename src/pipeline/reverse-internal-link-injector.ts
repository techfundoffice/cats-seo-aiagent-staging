import type { SEOArticleAgent } from "../server";
import { notifyIndexNow } from "./indexing";
import { errMsg, escXml } from "./http-utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReverseInternalLinkResult {
  /** Number of existing articles that received a back-link to the new page. */
  injectedCount: number;
  /** Public URLs of every article that was modified and re-pinged. */
  pagesModified: string[];
  /** How many candidate articles were considered before capping. */
  candidatesScored: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum number of existing articles we will back-link from per publish
 * event.  Keep modest so a single DO invocation doesn't time out while
 * writing many KV entries.
 */
const MAX_BACK_LINKS_PER_PUBLISH = 8;

/**
 * Minimum token overlap score (0–1) a candidate paragraph must reach for
 * us to inject the link into it.  Below this the semantic connection is
 * too weak to be natural.
 */
const MIN_PARAGRAPH_SCORE = 0.18;

/**
 * We never touch the very first <p> of an article (intro paragraph) or
 * paragraphs that are already link-heavy (contain ≥2 existing <a> tags).
 * This avoids link-stuffing signals.
 */
const MAX_EXISTING_LINKS_IN_PARAGRAPH = 1;

// ── Public entry-point ────────────────────────────────────────────────────────

/**
 * Step 23/24 — Reverse Internal-Link Injection.
 *
 * After a new article is published the agent walks back through already-
 * published articles in KV and injects a contextual hyperlink pointing at
 * the new page into the body of every article that is topically adjacent
 * (same category OR keyword-token overlap).  The modified articles are
 * re-written to KV and re-pinged via IndexNow so the IndexNow-participating
 * engines (Bing/Yandex — NOT Google) re-crawl the updated graph quickly.
 * Google itself picks up the change only via the sitemap / its own crawl
 * schedule; IndexNow does not notify Google.
 *
 * WHY this drives traffic:
 *  • Google re-crawls pages that already rank far sooner than brand-new
 *    URLs.  A link from an already-indexed page passes PageRank and lets
 *    Google discover the new article within hours rather than weeks.
 *  • Every published article in the same category already has accumulated
 *    authority.  Back-linking from 5–10 of them on day 0 of publication is
 *    equivalent to an instant burst of internal PageRank.
 *  • The effect is self-compounding: after 100 articles each new page
 *    receives up to 8 contextual links from live, ranked pages on the day
 *    it is published.
 *
 * This is architecturally distinct from Step 4 (internal links collected
 * INTO the new article pointing AT older ones).  Step 23 edits OLDER
 * articles to point AT the NEW one — the inverse direction.
 */
export async function injectReverseInternalLinks(
  agent: SEOArticleAgent,
  newArticleUrl: string,
  newArticleTitle: string,
  keyword: string,
  categorySlug: string,
  slug: string
): Promise<ReverseInternalLinkResult> {
  const pagesModified: string[] = [];
  const safeNewArticleUrl = escXml(newArticleUrl);

  // ── 1. Query candidate articles from SQLite ───────────────────────────────
  // Primary: same category (topical siblings).
  // We fetch up to 3× the cap so we have room to skip un-injectable ones.
  type CandidateRow = {
    slug: string;
    category_slug: string;
    kv_key: string;
    url: string;
    seo_score: number;
  };
  const sameCategoryRows = agent.sql<CandidateRow>`
    SELECT slug, category_slug, kv_key, url, seo_score
      FROM articles
     WHERE category_slug = ${categorySlug}
       AND slug != ${slug}
     ORDER BY seo_score DESC
     LIMIT ${MAX_BACK_LINKS_PER_PUBLISH * 3}`;

  // Secondary: cross-category topical neighbours. Without this, an
  // article like "best automatic feeders for senior cats" never
  // back-links from "best fountains for senior cats" (different
  // category, same topical cluster) — leaving substantial PageRank +
  // crawl-discovery upside on the table. We pull a small pool of
  // candidates whose keyword shares any significant token with the new
  // article's keyword, then let the existing paragraph-overlap scoring
  // gate which ones get a link. Capped tightly so SQL stays cheap.
  const TOP_SIGNAL_TOKENS_FOR_SQL = 5;
  const sqlTokens = Array.from(
    new Set([...tokenize(keyword), ...tokenize(newArticleTitle)])
  )
    .filter((t) => t.length >= 4) // pad against 3-char noise in cross-category lookup
    .slice(0, TOP_SIGNAL_TOKENS_FOR_SQL);
  // SDK `agent.sql` is tagged-template only (no function-call form), so
  // we run one bounded query per significant token and merge in JS.
  // Cap per-token results so the total cross-category pool stays small.
  const PER_TOKEN_CAP = MAX_BACK_LINKS_PER_PUBLISH;
  const crossCategoryRowsMap = new Map<string, CandidateRow>();
  for (const tok of sqlTokens) {
    const pattern = `%${tok}%`;
    const rows = agent.sql<CandidateRow>`
      SELECT slug, category_slug, kv_key, url, seo_score
        FROM articles
       WHERE category_slug != ${categorySlug}
         AND slug != ${slug}
         AND keyword LIKE ${pattern}
       ORDER BY seo_score DESC
       LIMIT ${PER_TOKEN_CAP}`;
    for (const r of rows) {
      if (!crossCategoryRowsMap.has(r.slug))
        crossCategoryRowsMap.set(r.slug, r);
    }
  }
  const crossCategoryRows = [...crossCategoryRowsMap.values()].sort(
    (a, b) => b.seo_score - a.seo_score
  );

  // Merge same-category first (preserves "topical siblings first"
  // priority) then cross-category, deduping on slug since the
  // same-category query may already cover some.
  const seen = new Set<string>();
  const candidateRows: CandidateRow[] = [];
  for (const r of [...sameCategoryRows, ...crossCategoryRows]) {
    if (seen.has(r.slug)) continue;
    seen.add(r.slug);
    candidateRows.push(r);
  }

  agent.log(
    "info",
    `Reverse link injection: ${candidateRows.length} candidate article(s) (${sameCategoryRows.length} same-category, ${crossCategoryRows.length} cross-category) for "${categorySlug}"`,
    "marketing",
    { kanbanStage: "done" }
  );

  if (candidateRows.length === 0) {
    return { injectedCount: 0, pagesModified: [], candidatesScored: 0 };
  }

  const keywordTokens = tokenize(keyword);
  const titleTokens = tokenize(newArticleTitle);
  // Combine keyword + title tokens for a richer matching signal
  const allSignalTokens = Array.from(
    new Set([...keywordTokens, ...titleTokens])
  ).filter((t) => t.length >= 3); // exclude 2-char noise words; keep 3-char product terms like "cat", "mat", "box"

  let injectedCount = 0;

  // ── 2. Walk candidates ────────────────────────────────────────────────────
  for (const row of candidateRows) {
    if (injectedCount >= MAX_BACK_LINKS_PER_PUBLISH) break;

    // Fetch existing HTML from KV
    const existingHtml = await agent.envBindings.ARTICLES_KV.get(row.kv_key);
    if (!existingHtml) continue;

    // Idempotency: skip if this article already links to the new page
    if (existingHtml.includes(safeNewArticleUrl)) {
      agent.log(
        "info",
        `Reverse link: already linked → ${row.url} (skip)`,
        "marketing"
      );
      continue;
    }

    // ── 3. Find the best paragraph injection point ──────────────────────────
    const injection = findBestInjectionPoint(
      existingHtml,
      allSignalTokens,
      safeNewArticleUrl,
      keyword,
      newArticleTitle
    );

    if (!injection) {
      agent.log(
        "info",
        `Reverse link: no suitable paragraph found in ${row.url} (score below threshold)`,
        "marketing"
      );
      continue;
    }

    // ── 4. Apply the injection ──────────────────────────────────────────────
    // Use an arrow function as the replacement so any `$` sequences in
    // `injection.patched` (e.g. from article titles or anchor text) are
    // treated as literal characters rather than interpreted as
    // String.replace special patterns ($&, $', $`, $1, …).
    const { original, patched } = injection;
    const updatedHtml = existingHtml.replace(original, () => patched);

    // Safety check: confirm the replacement actually changed something and the
    // new URL is now present
    if (
      updatedHtml === existingHtml ||
      !updatedHtml.includes(safeNewArticleUrl)
    ) {
      agent.log(
        "warning",
        `Reverse link: injection replace produced no change in ${row.url} (skip)`,
        "marketing"
      );
      continue;
    }

    // ── 5. Write back to KV ─────────────────────────────────────────────────
    try {
      await agent.envBindings.ARTICLES_KV.put(row.kv_key, updatedHtml);
    } catch (kvErr: unknown) {
      agent.log(
        "warning",
        `Reverse link: KV write failed for ${row.kv_key}: ${errMsg(kvErr)}`,
        "marketing"
      );
      continue;
    }

    // ── 6. IndexNow re-ping for the modified page ───────────────────────────
    try {
      await notifyIndexNow(agent, row.url);
    } catch (indexNowErr: unknown) {
      agent.log(
        "warning",
        `Reverse link: IndexNow notify failed for ${row.url}: ${errMsg(indexNowErr)}`,
        "marketing"
      );
    }

    injectedCount++;
    pagesModified.push(row.url);

    agent.log(
      "info",
      `✅ Reverse link injected: "${injection.anchorText}" → ${newArticleUrl} in ${row.url}`,
      "marketing",
      { kanbanStage: "done" }
    );
  }

  return {
    injectedCount,
    pagesModified,
    candidatesScored: candidateRows.length
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Lower-case word tokeniser — strips punctuation, keeps words ≥2 chars. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/**
 * Score a plain-text string against a set of signal tokens.
 * Returns the fraction of signal tokens that appear in the text (0–1).
 */
function overlapScore(text: string, signalTokens: string[]): number {
  if (signalTokens.length === 0) return 0;
  const textTokens = new Set(tokenize(text));
  const hits = signalTokens.filter((t) => textTokens.has(t)).length;
  return hits / signalTokens.length;
}

/**
 * Build the anchor text for the injected link.
 *
 * We prefer a 2–4 word phrase that is the core product noun phrase:
 *   1. Strip a leading "best" / "top" modifier (common in affiliate keywords).
 *   2. When the keyword contains a "for", "with", or "vs" qualifier, use the
 *      product noun phrase that precedes the connector (up to 4 words) rather
 *      than the qualifier phrase itself — e.g.:
 *        "best cat window perch for senior cats" → "cat window perch"
 *        "automatic cat feeder with app control" → "automatic cat feeder"
 *        "lift top cat tree vs traditional" → "lift top cat tree"
 *   3. Otherwise fall back to the last 3 words, which is usually the most
 *      specific phrase (e.g. "cat litter box" from "best large cat litter box").
 *   4. Use the full keyword when it is already 3 words or fewer.
 */
function buildAnchorText(keyword: string): string {
  const words = keyword.trim().split(/\s+/);
  if (words.length <= 3) return keyword;

  // Strip a leading "best" or "top" modifier
  const stripped = /^(?:best|top)\b/i.test(words[0]) ? words.slice(1) : words;

  // When the keyword has a "for", "with", or "vs"/"vs." separator, use the
  // product noun phrase that precedes the connector rather than the qualifier
  // or comparison clause itself.  Including "vs" means comparison keywords
  // like "cat GPS collar vs AirTag" → "cat GPS collar" instead of the
  // degenerate "collar vs AirTag".
  const qualifierIdx = stripped.findIndex((w) =>
    /^(?:for|with|vs\.?)$/i.test(w)
  );
  if (qualifierIdx >= 2) {
    return stripped.slice(0, Math.min(4, qualifierIdx)).join(" ");
  }

  // qualifierIdx === 1: the product is a single word (e.g. "brush" from
  // "best brush for cats that hate grooming"). The default last-3-words
  // approach produces degenerate anchors like "that hate grooming" in such
  // cases. Instead, extend to include the connector and first target word so
  // we get a meaningful 3-word anchor ("brush for cats").
  if (qualifierIdx === 1) {
    return stripped.slice(0, Math.min(3, qualifierIdx + 2)).join(" ");
  }

  // Default: last 3 words of the stripped phrase (usually the most specific
  // product phrase — e.g. "cat litter box" from "best large cat litter box").
  return stripped.slice(-3).join(" ");
}

interface InjectionMatch {
  /** The original paragraph HTML substring to replace. */
  original: string;
  /** The patched paragraph HTML with the link inserted. */
  patched: string;
  /** The anchor text used in the link. */
  anchorText: string;
  /** Overlap score of the chosen paragraph. */
  score: number;
}

/**
 * Scan the article HTML for `<p>` paragraphs and return the best injection
 * point, or null if no paragraph meets the threshold.
 *
 * Injection strategy:
 *  1. Extract all <p>…</p> blocks from the article <body>.
 *  2. Skip: first <p> (intro), paragraphs with > MAX_EXISTING_LINKS_IN_PARAGRAPH
 *     <a> tags (i.e. 2+ links when the constant is 1), paragraphs already
 *     containing the target URL, paragraphs with fewer than 20 words (too
 *     short to embed naturally).
 *  3. Score each remaining paragraph by keyword-token overlap.
 *  4. Choose the highest-scoring paragraph that meets MIN_PARAGRAPH_SCORE.
 *  5. Within that paragraph find the first occurrence of the best matching
 *     token sequence and wrap it with an <a> tag.  If no clean phrase
 *     match exists, append a contextual sentence before </p>.
 */
function findBestInjectionPoint(
  html: string,
  signalTokens: string[],
  safeNewArticleUrl: string,
  keyword: string,
  newArticleTitle: string
): InjectionMatch | null {
  const anchorText = buildAnchorText(keyword);
  // Defensive: empty anchor text would produce `<a href="..."></a>` —
  // visually invisible link, bad SEO (no anchor signal to Google), and
  // a zero-width `paraLower.indexOf("")` scan would iterate one
  // position per character below. Skip injection for this candidate.
  if (!anchorText || !anchorText.trim()) return null;
  const linkTag = `<a href="${safeNewArticleUrl}">${escXml(anchorText)}</a>`;

  // Limit scope to the <body> content to avoid touching <head> meta regions
  const bodyStart = html.indexOf("<body");
  const bodyEnd = html.lastIndexOf("</body>");
  const bodyHtml =
    bodyStart >= 0 && bodyEnd > bodyStart
      ? html.slice(bodyStart, bodyEnd + 7)
      : html;

  // Extract all <p> blocks
  const paragraphRe = /<p(?:\s[^>]*)?>[\s\S]*?<\/p>/gi;
  const paragraphs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = paragraphRe.exec(bodyHtml)) !== null) {
    paragraphs.push(m[0]);
  }

  if (paragraphs.length === 0) return null;

  // Score each paragraph (skip first <p>)
  let bestScore = MIN_PARAGRAPH_SCORE - 0.001; // start just below threshold
  let bestPara: string | null = null;

  for (let i = 1; i < paragraphs.length; i++) {
    const para = paragraphs[i];

    // Skip paragraphs that already have too many links
    const linkCount = (para.match(/<a\s/gi) ?? []).length;
    if (linkCount > MAX_EXISTING_LINKS_IN_PARAGRAPH) continue;

    // Skip if the new URL is already present somehow
    if (para.includes(safeNewArticleUrl)) continue;

    // Get plain text for scoring
    const plain = para
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Skip very short paragraphs (≤ 20 words)
    if (plain.split(/\s+/).length <= 20) continue;

    const score = overlapScore(plain, signalTokens);
    if (score > bestScore) {
      bestScore = score;
      bestPara = para;
    }
  }

  if (bestPara === null) return null;

  // ── Build the patched paragraph ───────────────────────────────────────────
  // Strategy A: scan every occurrence of the anchor phrase until we find one
  // that sits outside an existing <a> element.  The first occurrence is most
  // commonly free, but paragraphs that already contain an affiliate or
  // internal link can have the exact phrase wrapped inside a different <a>
  // tag — in that case we try subsequent occurrences before giving up and
  // falling back to the appended-sentence Strategy B.
  const anchorLower = anchorText.toLowerCase();
  const paraLower = bestPara.toLowerCase();
  let searchStart = 0;
  while (true) {
    const phraseIdx = paraLower.indexOf(anchorLower, searchStart);
    if (phraseIdx < 0) break;

    // Make sure the match is not already inside an <a> tag
    const before = bestPara.slice(0, phraseIdx);
    const openAnchorCount = (before.match(/<a\s/gi) ?? []).length;
    const closeAnchorCount = (before.match(/<\/a>/gi) ?? []).length;
    const insideAnchor = openAnchorCount > closeAnchorCount;

    if (!insideAnchor) {
      // Patch at the exact position identified — do NOT use
      // `bestPara.replace(phrase, linkTag)` because String#replace always
      // targets the *first* occurrence, which may be a different (wrapped)
      // occurrence than the free one we found at `phraseIdx`.
      const patched =
        bestPara.slice(0, phraseIdx) +
        linkTag +
        bestPara.slice(phraseIdx + anchorText.length);
      return {
        original: bestPara,
        patched,
        anchorText,
        score: bestScore
      };
    }

    searchStart = phraseIdx + 1;
  }

  // Strategy B: no clean phrase match — append a compact contextual sentence
  // before </p> so the link is always present and natural.
  const contextSentence = ` For more detail, see our guide to <a href="${safeNewArticleUrl}">${escXml(newArticleTitle)}</a>.`;
  const patched = bestPara.replace(/<\/p>/i, () => `${contextSentence}</p>`);

  return {
    original: bestPara,
    patched,
    anchorText: newArticleTitle,
    score: bestScore
  };
}
