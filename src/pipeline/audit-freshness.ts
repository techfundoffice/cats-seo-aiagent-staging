/**
 * Rendered-vs-stored freshness check for the Published Article Editorial
 * Agent.
 *
 * The agent audits two different things and silently assumes they agree:
 * it reads the article HTML from `ARTICLES_KV`, then screenshots the live
 * URL, which a *different* Worker serves from that same KV. When the live
 * page is edge-cached, or the consumer Worker is behind, the screenshot
 * (and the vision critique built on it) describes a version that is not
 * the one in KV — and nothing said so.
 *
 * This is the check that makes "we audited the page that actually ships"
 * a measured claim rather than an assumption.
 *
 * The comparison has to survive one wrinkle: the rendered text collected
 * by Browser Rendering is truncated (8 KB) while the KV body text is not,
 * so raw length or word-count ratios flag every long article as drifted.
 * Instead we take the *head* of the stored article — the first N distinct
 * content words, which the Polish and SISS rewrites do touch — and ask how
 * much of it survives in the rendered text. Same version ⇒ near-total
 * overlap. Stale render ⇒ the rewritten intro is missing.
 */

/** Words too common to carry a version signal. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "as",
  "at",
  "by",
  "from",
  "you",
  "your",
  "we",
  "our",
  "they",
  "their"
]);

export interface RenderedFreshness {
  /** False when there was not enough text on either side to judge. */
  checked: boolean;
  storedWords: number;
  renderedWords: number;
  /** Fraction (0–1) of the stored head words present in the rendered text. */
  headOverlap: number;
  /** True only when `checked` and `headOverlap` fell below the threshold. */
  drifted: boolean;
  /** Human-readable summary for the activity log. */
  summary: string;
}

/** Lowercase content words, punctuation stripped, stopwords removed. */
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Compare the stored (KV) article body text against the text rendered from
 * the live URL.
 *
 * `headWords` distinct content words from the start of the stored article
 * are looked up in the rendered text; `minOverlap` is the fraction that
 * must be found before the render is considered to match. Both sides need
 * `minWords` of content words or the check reports `checked: false` rather
 * than guessing — a screenshot failure must not masquerade as drift.
 */
export function assessRenderedFreshness(
  storedBodyText: string,
  renderedText: string,
  opts: {
    headWords?: number;
    minOverlap?: number;
    minWords?: number;
  } = {}
): RenderedFreshness {
  const headWords = opts.headWords ?? 120;
  const minOverlap = opts.minOverlap ?? 0.6;
  const minWords = opts.minWords ?? 40;

  const stored = contentWords(storedBodyText);
  const rendered = contentWords(renderedText);

  if (stored.length < minWords || rendered.length < minWords) {
    return {
      checked: false,
      storedWords: stored.length,
      renderedWords: rendered.length,
      headOverlap: 0,
      drifted: false,
      summary:
        rendered.length < minWords
          ? `not checked — only ${rendered.length} rendered content words (need ${minWords})`
          : `not checked — only ${stored.length} stored content words (need ${minWords})`
    };
  }

  // Distinct head words preserve order of first appearance, so the sample
  // is the opening of the article rather than a bag of its whole body.
  const head: string[] = [];
  const seen = new Set<string>();
  for (const word of stored) {
    if (seen.has(word)) continue;
    seen.add(word);
    head.push(word);
    if (head.length >= headWords) break;
  }

  const renderedSet = new Set(rendered);
  const found = head.filter((w) => renderedSet.has(w)).length;
  const headOverlap = head.length > 0 ? found / head.length : 0;
  const drifted = headOverlap < minOverlap;
  const pct = Math.round(headOverlap * 100);

  return {
    checked: true,
    storedWords: stored.length,
    renderedWords: rendered.length,
    headOverlap,
    drifted,
    summary: drifted
      ? `rendered page matches only ${pct}% of the stored article's opening (threshold ${Math.round(minOverlap * 100)}%) — the screenshot is probably of a stale version`
      : `rendered page matches ${pct}% of the stored article's opening`
  };
}
