/**
 * Heuristic overlap vs a reference text (e.g. SERP competitor body).
 * Measures what fraction of fixed-length word windows in the article also
 * appear verbatim in the reference after light normalization — useful as a
 * “too close to competitor” signal, not legal plagiarism proof.
 */

const DEFAULT_WINDOW = 6;

/**
 * Strip HTML to a plain-text string suitable for word-count and
 * plagiarism-overlap calculations.
 *
 * Processing order:
 *   1. Remove `<script>` blocks (inline JS that would pollute word counts)
 *   2. Remove `<style>` blocks (inline CSS)
 *   3. Replace all remaining HTML tags with a single space so adjacent
 *      words from sibling elements are always separated
 *   4. Collapse consecutive whitespace and trim
 *
 * **Does NOT decode HTML entities** (`&amp;`, `&lt;`, `&nbsp;`, …).
 * When entity-free plain text is required (e.g. for keyword-density
 * checks or SEO scoring) chain with `unescapeHtml` from `./http-utils`:
 *
 * ```ts
 * const bodyText = unescapeHtml(stripHtmlToPlainText(html));
 * ```
 *
 * Used in `seo-score.ts`, `qc-agent.ts`, `polish-agent.ts`, and
 * `siss-optimizer.ts` for article analysis; also re-exported by
 * `competitor.ts` for processing competitor body HTML.
 */
export function stripHtmlToPlainText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s);
}

function normalizeWordTokens(text: string): string[] {
  const plain = looksLikeHtml(text) ? stripHtmlToPlainText(text) : text;
  const t = plain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!t) return [];
  return t.split(/\s+/).filter((w) => w.length >= 2);
}

/**
 * Returns 0–100: percentage of article word-windows (size `windowWords`) that
 * match a window in `referencePlain`. Empty or too-short inputs yield 0.
 */
export function estimateCompetitorOverlapPercent(
  articleHtmlOrPlain: string,
  referencePlain: string,
  windowWords = DEFAULT_WINDOW
): number {
  const artWords = normalizeWordTokens(articleHtmlOrPlain);
  const refWords = normalizeWordTokens(referencePlain);
  if (
    artWords.length < windowWords ||
    refWords.length < windowWords ||
    artWords.length === 0
  ) {
    return 0;
  }

  const refSet = new Set<string>();
  for (let i = 0; i <= refWords.length - windowWords; i++) {
    refSet.add(refWords.slice(i, i + windowWords).join(" "));
  }

  let matches = 0;
  const totalWindows = artWords.length - windowWords + 1;
  for (let i = 0; i <= artWords.length - windowWords; i++) {
    const shingle = artWords.slice(i, i + windowWords).join(" ");
    if (refSet.has(shingle)) matches++;
  }
  const pct = (100 * matches) / Math.max(1, totalWindows);
  return Math.min(100, Math.round(pct));
}
