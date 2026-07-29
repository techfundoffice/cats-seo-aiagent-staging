/**
 * keyword-normalize.ts — tidy the human-readable keyword text that the
 * product catalog produces, before it reaches a prompt or the page.
 *
 * The Scout catalog derives keywords from Amazon product titles, and
 * punctuation in a title survives into the keyword:
 *
 *   "shake-away coyote/fox urine granules . review"
 *   "angry orange pet odor eliminator . bottle- industrial review"
 *   "vetoquinol laxatone: oral hairball lubricant gel for cats review"
 *
 * The keyword is interpolated into the title, the meta description and
 * the body prose, so the artefact ships to readers — the first of those
 * produced the live meta description "Our shake-away coyote/fox urine
 * granules . review covers the best organic cat repellent for 2024".
 * The same row then failed the thin-content gate at 701 words.
 *
 * This normalizes the PROSE form only. The `slug` column is stored
 * separately and is already clean (the slugifier drops stray
 * punctuation), so nothing here can move a URL or a KV key — every
 * transformation below either collapses a separator to a space or
 * removes a dangling punctuation mark, both of which slugify
 * identically to what they replace.
 */

/** Separators that read as word breaks in prose, not as characters. */
const SEPARATORS = /[/\\|]+/g;

/** A token that is nothing but punctuation, e.g. the " . " above. */
const ORPHAN_PUNCTUATION = /(?:^|\s)[.,;:–—-]+(?=\s|$)/g;

/** Punctuation left dangling at the end of a word ("bottle- ", "laxatone:"). */
const TRAILING_PUNCTUATION = /([A-Za-z0-9])[.,;:–—-]+(?=\s)/g;

/**
 * Return the keyword with catalog punctuation artefacts removed.
 * Idempotent, and a no-op on already-clean keywords. Interior hyphens
 * that join words ("shake-away", "self-cleaning") are preserved — only
 * punctuation that is orphaned or dangling is touched.
 */
export function normalizeKeywordText(keyword: string): string {
  if (!keyword || typeof keyword !== "string") return keyword;
  return keyword
    .replace(SEPARATORS, " ")
    .replace(TRAILING_PUNCTUATION, "$1")
    .replace(ORPHAN_PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}
