/**
 * Title + meta-description length normalizer. Closes the 44% in-window
 * miss rate surfaced by the Priority 1 audit. The writer prompt
 * (writer.ts:3338-3339) now constrains 45-60 / 140-160; this helper is
 * the *enforcement* belt: when Kimi ignores the prompt and returns
 * out-of-window text, we repair in-place rather than ship to KV with
 * a known SERP truncation defect.
 *
 * Same defense pattern as ensureWhyWeLikeMarker (#4792): render-time
 * fallback that prevents the defect class from ever reaching Google,
 * even under Kimi-degraded conditions where the prompt is ignored.
 *
 * Pure string functions. No Kimi calls, no I/O. Unit-tested in
 * src/pipeline/__tests__/title-meta-normalizer.test.ts.
 */

import { unescapeHtml } from "./http-utils";

export const TITLE_MIN_CHARS = 45;
export const TITLE_MAX_CHARS = 60;
export const META_MIN_CHARS = 140;
export const META_MAX_CHARS = 160;

/**
 * Trailing words / symbols that indicate a title was cut mid-phrase
 * by SERP-window truncation or a Kimi generation glitch. Any title
 * whose last token (after HTML-entity decoding and punctuation strip)
 * is in this set should be repaired before publication.
 *
 * Single source-of-truth: used by `trimTrailingTitleOrphanModifiers`
 * (below), `live-quality-probe.ts` (`endsWithOrphanModifier`), and
 * `writer.ts` so all enforcement layers stay in sync as the list evolves.
 */
export const TITLE_TRAILING_ORPHAN_MODIFIERS = new Set([
  "a",
  "an",
  "and",
  "best",
  "buying",
  "expert-tested",
  "for",
  "in",
  "of",
  "on",
  "or",
  "our",
  "the",
  "to",
  "top",
  "ultimate",
  "vs",
  "versus",
  "with",
  "&",
  "+"
]);

export const TITLE_TRAILING_ORPHAN_PUNCTUATION_RE = /[,:;.!?'`"""'')\]}—…]+$/;

/**
 * Iteratively strip trailing orphan modifier tokens (and surrounding
 * punctuation) from a title. Decodes HTML entities first so tokens
 * like `&amp;` (→ `&`) are recognised as bare `&` orphans.
 *
 * Called before **and** after `enforceTitleSerpWindow` in both
 * `writer.ts` and `editorial-agent.ts` so that:
 *   1. Existing orphan tails are removed before the SERP window pass.
 *   2. Orphans accidentally introduced by word-boundary truncation
 *      (e.g. "Best Cat Stairs for Senior Cats for" trimmed to
 *      "Best Cat Stairs for Senior Cats for") are caught on the
 *      second pass.
 */
export function trimTrailingTitleOrphanModifiers(title: string): string {
  let out = unescapeHtml(title).replace(/\s+/g, " ").trim();
  while (out) {
    const stripped = out
      .replace(TITLE_TRAILING_ORPHAN_PUNCTUATION_RE, "")
      .trim();
    const last = stripped.split(/\s+/).pop()?.toLowerCase() ?? "";
    if (!TITLE_TRAILING_ORPHAN_MODIFIERS.has(last)) {
      return stripped;
    }
    const parts = stripped.split(/\s+/);
    if (parts.length <= 1) return "";
    parts.pop();
    out = parts.join(" ").trim();
  }
  return out;
}

function lastWordBoundaryBefore(text: string, idx: number): number {
  // Find the last space at or before idx — produces a clean truncate.
  // If none exists (single super-long word), fall back to idx.
  for (let i = Math.min(idx, text.length - 1); i > Math.max(0, idx - 30); i--) {
    if (/\s/.test(text[i])) return i;
  }
  return idx;
}

/**
 * Repair an unbalanced trailing "(" group left by truncation. The
 * word-boundary cut can land inside a parenthetical — "…Large Cats
 * (2026): Editor's Comparison" truncated at 60 chars shipped to
 * production as "…Large Cats (2026" (no closing paren) in title, H1,
 * og:title, AND the schema headline on 2026-06-11. The dangling-
 * punctuation strip can't see it because the string ends in a digit.
 *
 * If closing the paren still fits the SERP window, append ")"; else
 * drop the dangling "(…" fragment entirely.
 */
function balanceTrailingParen(title: string, maxChars: number): string {
  const opens = (title.match(/\(/g) ?? []).length;
  const closes = (title.match(/\)/g) ?? []).length;
  if (opens <= closes) return title;
  const lastOpen = title.lastIndexOf("(");
  // Content after "(" and room to close → close it.
  if (lastOpen < title.length - 1 && title.length + 1 <= maxChars) {
    return `${title})`;
  }
  // Otherwise drop the dangling fragment.
  return title
    .slice(0, lastOpen)
    .replace(/[\s,:;\-—]+$/, "")
    .trim();
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/(\s+)/)
    .map((tok) =>
      /^\s+$/.test(tok) ? tok : tok.charAt(0).toUpperCase() + tok.slice(1)
    )
    .join("");
}

/**
 * Return a title guaranteed to fit the 45-60 char SERP window. If the
 * input is already in-window, passthrough. Otherwise:
 *   - Too long → trim at last word boundary ≤60 chars; never end with
 *     a half-word or trailing punctuation.
 *   - Too short → append " | Best Picks <year>" pad derived from the
 *     keyword's product noun (or the keyword itself) to reach ≥45.
 *   - Empty → synthesize from keyword: "Best ${Title-Cased Keyword}".
 *
 * Returns an object with the normalized title + a `changed` flag so
 * the caller can log when repair happened.
 */
export function enforceTitleSerpWindow(
  rawTitle: string,
  keyword: string,
  now: Date = new Date()
): { title: string; changed: boolean; reason?: string } {
  const original = (rawTitle ?? "").trim();
  // Always strip dangling punctuation first — even an in-window title
  // that ends with ":" or "—" reads like a truncated string in SERP.
  const stripped = balanceTrailingParen(
    original.replace(/[,:;\-—(]+$/, "").trim(),
    TITLE_MAX_CHARS
  );
  if (
    stripped.length >= TITLE_MIN_CHARS &&
    stripped.length <= TITLE_MAX_CHARS
  ) {
    return {
      title: stripped,
      changed: stripped !== original,
      reason:
        stripped !== original ? `stripped dangling punctuation` : undefined
    };
  }
  if (stripped.length > TITLE_MAX_CHARS) {
    // Trim at last word boundary ≤ TITLE_MAX_CHARS.
    const cut = lastWordBoundaryBefore(stripped, TITLE_MAX_CHARS);
    let next = stripped.slice(0, cut).trim();
    next = balanceTrailingParen(
      next.replace(/[,:;\-—(]+$/, "").trim(),
      TITLE_MAX_CHARS
    );
    if (next.length < TITLE_MIN_CHARS) {
      return padTitleToMin(next, keyword, now);
    }
    return {
      title: next,
      changed: true,
      reason: `truncated from ${original.length} to ${next.length} chars`
    };
  }
  // Too short.
  return padTitleToMin(stripped, keyword, now);
}

function padTitleToMin(
  baseRaw: string,
  keyword: string,
  now: Date
): { title: string; changed: boolean; reason: string } {
  const base = baseRaw.trim();
  const kwTitleCase = titleCase((keyword ?? "").trim());
  const year = String(now.getUTCFullYear());
  // Decide on a seed: short base inputs (< 25 chars) are usually
  // gibberish ("x", "Cat") — synthesize from keyword instead so the
  // padded result reads naturally. Longer bases are preserved.
  const useBase = base.length >= 25;
  let candidate = useBase
    ? base
    : kwTitleCase
      ? `Best ${kwTitleCase}`
      : "Best Picks";
  // Iteratively append pads of decreasing specificity until ≥ MIN.
  // Each pad is in title-case + ends without trailing punct so the
  // composed string is naturally readable.
  const pads = [
    ` | Best Picks ${year}`,
    ` — Complete Buyer's Guide`,
    ` for Every Cat Owner`,
    ` — Curated Recommendations`,
    ` ${year}`
  ];
  for (const p of pads) {
    if (candidate.length >= TITLE_MIN_CHARS) break;
    candidate = `${candidate}${p}`;
  }
  if (candidate.length > TITLE_MAX_CHARS) {
    const cut = lastWordBoundaryBefore(candidate, TITLE_MAX_CHARS);
    candidate = candidate
      .slice(0, cut)
      .replace(/[,:;\-—(]+$/, "")
      .trim();
  }
  // Final guarantee — if STILL below MIN (impossibly short keyword
  // edge case), force-pad with spaces of "—" then trim.
  while (candidate.length < TITLE_MIN_CHARS) {
    const remaining = TITLE_MIN_CHARS - candidate.length;
    const filler = " — Top Cat Picks Reviewed".slice(0, remaining + 1);
    candidate = `${candidate}${filler}`;
    if (candidate.length > TITLE_MAX_CHARS) {
      candidate = candidate.slice(0, TITLE_MAX_CHARS).replace(/\s+\S*$/, "");
      break;
    }
  }
  return {
    title: candidate,
    changed: true,
    reason: `padded from ${base.length} to ${candidate.length} chars`
  };
}

/**
 * Return a meta description guaranteed to fit the 140-160 char SERP
 * window. Passthrough when in-window; otherwise repair:
 *   - Too long → trim at last sentence boundary ≤160 chars; preserve
 *     end-of-sentence punctuation; if no sentence boundary exists,
 *     trim at last word ≤159 and append "."
 *   - Too short → append a generic CTA pad ("Compare our top picks for
 *     ${keyword}. Find the right fit today.") to reach ≥140.
 *   - Empty → synthesize entirely from keyword.
 */
export function enforceMetaSerpWindow(
  rawMeta: string,
  keyword: string
): { meta: string; changed: boolean; reason?: string } {
  const trimmed = (rawMeta ?? "").trim();
  if (trimmed.length >= META_MIN_CHARS && trimmed.length <= META_MAX_CHARS) {
    return { meta: trimmed, changed: false };
  }
  if (trimmed.length > META_MAX_CHARS) {
    // Try to trim at a sentence boundary (last . ! ? ≤ 160).
    let bestCut = -1;
    const sentenceTerminators = /[.!?]/g;
    let m: RegExpExecArray | null;
    while ((m = sentenceTerminators.exec(trimmed)) !== null) {
      if (m.index <= META_MAX_CHARS - 1) bestCut = m.index + 1;
      else break;
    }
    if (bestCut >= META_MIN_CHARS) {
      const next = trimmed.slice(0, bestCut).trim();
      return {
        meta: next,
        changed: true,
        reason: `sentence-boundary trim from ${trimmed.length} to ${next.length} chars`
      };
    }
    // Fallback: word-boundary trim + add a period.
    const cut = lastWordBoundaryBefore(trimmed, META_MAX_CHARS - 1);
    let next = trimmed.slice(0, cut).trim();
    next = next.replace(/[,:;\-—(]+$/, "");
    if (!/[.!?]$/.test(next)) next = `${next}.`;
    // If trim dropped us below the floor, fall through to padding.
    if (next.length < META_MIN_CHARS) {
      return padMetaToMin(next, keyword);
    }
    return {
      meta: next,
      changed: true,
      reason: `word-boundary trim from ${trimmed.length} to ${next.length} chars`
    };
  }
  return padMetaToMin(trimmed, keyword);
}

function padMetaToMin(
  baseRaw: string,
  keyword: string
): { meta: string; changed: boolean; reason: string } {
  const base = baseRaw.trim();
  const kw = (keyword ?? "").trim();
  // Generic, brand-safe CTA pads sized to reliably land in-window
  // regardless of base length. Each pad is a complete sentence.
  const pads = [
    kw ? ` Compare our top picks for ${kw} and find the right fit today.` : "",
    " Read on for curated recommendations, real-world tradeoffs, and our top picks.",
    " Curated reviews, fair comparisons, honest tradeoffs — find what fits.",
    " Find the right option for your cat with our hands-on guide."
  ].filter(Boolean);
  let candidate = base;
  for (const p of pads) {
    if (candidate.length >= META_MIN_CHARS) break;
    candidate = `${candidate}${p}`;
  }
  if (candidate.length > META_MAX_CHARS) {
    // Trim at last sentence terminator ≤ MAX, fall back to word.
    let bestCut = -1;
    const re = /[.!?]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(candidate)) !== null) {
      if (m.index <= META_MAX_CHARS - 1) bestCut = m.index + 1;
      else break;
    }
    if (bestCut >= META_MIN_CHARS) {
      candidate = candidate.slice(0, bestCut).trim();
    } else {
      const cut = lastWordBoundaryBefore(candidate, META_MAX_CHARS - 1);
      candidate = candidate
        .slice(0, cut)
        .trim()
        .replace(/[,:;\-—(]+$/, "");
      if (!/[.!?]$/.test(candidate)) candidate = `${candidate}.`;
    }
  }
  return {
    meta: candidate,
    changed: true,
    reason: `padded from ${base.length} to ${candidate.length} chars`
  };
}
