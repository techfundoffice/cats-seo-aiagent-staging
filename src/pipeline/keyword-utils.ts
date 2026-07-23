/**
 * Pure keyword/title/HTML normalization helpers used across the pipeline.
 *
 * Every function here is deterministic, side-effect free, and safe to call
 * at any pipeline stage. They exist to make article output mechanically
 * clean (no doubled "best", no rogue extra h1, no doubled whitespace,
 * no raw keyword splices producing "the right it") regardless of what
 * the model returned, while preserving SEO surfaces (heading content,
 * JSON-LD structured data, target-keyword presence in titles).
 */

import { unescapeHtml } from "./http-utils";

/**
 * Truncate `keyword` to at most `maxWords` whitespace-separated tokens.
 * Trims and normalizes internal whitespace so callers are not required to
 * pre-trim the input.
 * Returns an empty string when `keyword` is blank after trimming or when
 * `maxWords` is non-positive.
 *
 * Used by `fetchSubIntentsFromAutocomplete` (siss-optimizer.ts) and
 * `fetchGoogleAutocompletePAA` (autocomplete.ts) to keep assembled
 * Autocomplete queries within the ≤6-word threshold where datacenter IPs
 * reliably receive suggestions from Google's suggestqueries endpoint.
 */
export function truncateKeywordToWords(
  keyword: string,
  maxWords: number
): string {
  const trimmed = keyword.trim();
  if (!trimmed || maxWords <= 0) return "";
  const words = trimmed.split(/\s+/);
  return words.slice(0, maxWords).join(" ");
}

const SUPERLATIVE_PREFIX_RE =
  /^(?:the\s+)?(?:top|best|greatest|finest|ultimate)(?:\s+(?:top|best|greatest|finest|ultimate))*\s+/i;

/**
 * Trailing modifiers that turn a keyword into a long phrase but aren't
 * part of the core noun. Order matters — longer patterns first so they
 * win over shorter ones (e.g. "for indoor cats" before "for cats").
 */
const TRAILING_MODIFIER_RES: RegExp[] = [
  /\s+for\s+(?:indoor|outdoor|senior|elderly|small|large|big|young|adult|multiple|multi|long[-\s]haired|short[-\s]haired)\s+cats?\b.*$/i,
  /\s+for\s+(?:kittens?|cats?|cat\s+owners?|pet\s+owners?)\b.*$/i,
  /\s+for\s+(?:airline|air|international|domestic|long[-\s]haul|short[-\s]haul)\s+(?:travel|trips?|flights?)\b.*$/i,
  /\s+(?:v\.?|vs\.?|versus|compared\s+to)\s+.+$/i,
  /\s+(?:in|of)\s+\d{4}\b.*$/i,
  /\s+\d{4}\b.*$/i,
  /\s+\(?\d{4}\)?\s*$/,
  /\s+(?:review|reviews|reviewed|guide|buying\s+guide|comparison|comparisons)\b.*$/i,
  /\s+under\s+\$?\d+(?:\s*dollars?)?\b.*$/i,
  /\s+below\s+\$?\d+(?:\s*dollars?)?\b.*$/i,
  /\s+from\s+\$?\d+(?:\s*-\s*\$?\d+)?\b.*$/i
];

/**
 * Strip a leading superlative ("Best", "Top", "The Best", "Top Best", ...)
 * from a keyword so it can be safely re-prefixed with "Best " by templates
 * without producing "Best best interactive cat toy".
 */
function stripLeadingSuperlative(s: string): string {
  if (!s) return s;
  return s.replace(SUPERLATIVE_PREFIX_RE, "").trim();
}

/**
 * Strip trailing year/audience/price/travel modifiers to leave just the
 * core noun phrase.
 *   "interactive cat toys for indoor cats"      → "interactive cat toys"
 *   "automatic litter box 2026"                 → "automatic litter box"
 *   "cat tree under $200"                       → "cat tree"
 *   "cat harness for airline travel"            → "cat harness"
 *   "cat carrier for international flights"     → "cat carrier"
 */
function stripTrailingModifiers(s: string): string {
  let out = s.trim();
  let changed = true;
  // Loop until stable so chained modifiers ("review 2026 for indoor cats")
  // all peel off.
  while (changed) {
    changed = false;
    for (const re of TRAILING_MODIFIER_RES) {
      const next = out.replace(re, "");
      if (next !== out) {
        out = next.trim();
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Common nouns that look plural but aren't (e.g. "litter", "grass",
 * "stainless"). Defined at module level so the Set is allocated once
 * rather than on every `singularizeLastWord` call.
 */
const NEVER_SINGULARIZE = new Set([
  "this",
  "his",
  "its",
  "us",
  "grass",
  "stainless",
  "less",
  "miss",
  "boss",
  "moss",
  "loss"
]);

/**
 * Singularize the final word of a noun phrase using domain-friendly
 * heuristics. Only the LAST word is touched; preceding modifiers are
 * left as the model emitted them.
 *
 *   "cat trees"            → "cat tree"
 *   "automatic litter boxes" → "automatic litter box"
 *   "interactive brushes"  → "interactive brush"
 *   "cat tree"             → "cat tree"   (unchanged)
 */
function singularizeLastWord(phrase: string): string {
  const m = phrase.match(/^(.*?)(\S+)$/);
  if (!m) return phrase;
  const lead = m[1];
  const last = m[2];
  const lower = last.toLowerCase();
  if (NEVER_SINGULARIZE.has(lower)) return phrase;
  let sing = last;
  if (/ies$/i.test(last) && last.length > 3) {
    sing = last.slice(0, -3) + "y";
  } else if (/(ses|xes|zes|shes|ches)$/i.test(last)) {
    sing = last.slice(0, -2);
  } else if (/[^aeiou]oes$/i.test(last)) {
    sing = last.slice(0, -2);
  } else if (/s$/i.test(last) && !/(ss|us|is)$/i.test(last)) {
    sing = last.slice(0, -1);
  }
  return lead + sing;
}

/**
 * Pluralize the final word of a noun phrase using the same heuristics in
 * reverse. Used when an FAQ template reads more naturally with a plural
 * ("Are <plural> worth the money?").
 *
 *   "cat tree"               → "cat trees"
 *   "automatic litter box"   → "automatic litter boxes"
 *   "interactive brush"      → "interactive brushes"
 *   "cat trees"              → "cat trees"   (already plural — heuristic)
 */
function pluralizeLastWord(phrase: string): string {
  const m = phrase.match(/^(.*?)(\S+)$/);
  if (!m) return phrase;
  const lead = m[1];
  const last = m[2];
  // Already plural-looking — don't double it.
  if (/s$/i.test(last) && !/(ss|us|is)$/i.test(last)) return phrase;
  let plur = last;
  if (/[^aeiou]y$/i.test(last)) {
    plur = last.slice(0, -1) + "ies";
  } else if (/(s|x|z|sh|ch)$/i.test(last)) {
    plur = last + "es";
  } else {
    plur = last + "s";
  }
  return lead + plur;
}

/**
 * Derive an "entity phrase" from a keyword that reads naturally inside the
 * fragment "the best ${entity}". Strips leading superlatives only — keeps
 * audience/year/price modifiers since they often carry user intent.
 *
 *   "best interactive cat toy for indoor cats" → "interactive cat toy for indoor cats"
 *   "cat tree"                                  → "cat tree"
 *   "Top best automatic litter box"             → "automatic litter box"
 */
export function deriveEntityPhrase(keyword: string): string {
  return stripLeadingSuperlative(keyword || "");
}

/**
 * Headline-style title case for template-synthesized titles. Keywords
 * arrive lowercase ("ventilated cat carrier for summer travel"), and
 * dropping them raw into a title template publishes a visibly
 * sentence-cased headline next to Title-Cased ones sitewide. Small
 * connective words stay lowercase unless they open or close the phrase.
 */
const TITLE_CASE_SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "nor",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "via",
  "vs",
  "with"
]);

export function toTitleCase(phrase: string): string {
  const words = (phrase || "").trim().split(/\s+/).filter(Boolean);
  return words
    .map((word, i) => {
      const isEdge = i === 0 || i === words.length - 1;
      if (!isEdge && TITLE_CASE_SMALL_WORDS.has(word.toLowerCase())) {
        return word.toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * Derive a clean SINGULAR noun phrase from a keyword for use in question
 * templates that need a grammatical singular form ("What is the best
 * ${noun}?"). Strips leading superlatives AND trailing audience/year/
 * price modifiers, then singularizes the final word.
 *
 *   "best interactive cat toy for indoor cats" → "interactive cat toy"
 *   "automatic litter boxes 2026"              → "automatic litter box"
 *   "cat trees under $200"                     → "cat tree"
 *   "cat stroller vs dog stroller size"        → "cat stroller"
 *   "best cat tree"                            → "cat tree"
 */
export function deriveEntityNoun(keyword: string): string {
  const stripped = stripLeadingSuperlative(keyword || "");
  const trimmed = stripTrailingModifiers(stripped);
  const core = trimmed || stripped;
  if (!core) return keyword;
  return singularizeLastWord(core);
}

/**
 * Derive the PLURAL form of `deriveEntityNoun(keyword)` — useful for FAQ
 * templates that read more naturally with plurals ("Are <plural> worth
 * the money?").
 */
export function deriveEntityNounPlural(keyword: string): string {
  return pluralizeLastWord(deriveEntityNoun(keyword));
}

/**
 * Normalize a title produced by the model + template stack:
 *   - Collapse runs of repeated tokens ("Best best", "the the").
 *   - Trim leading/trailing whitespace and punctuation noise.
 * Case is preserved on the first occurrence of each token.
 *
 * IMPORTANT: This will NOT collapse a repeated word if doing so would
 * remove the only occurrence of the target keyword. Used together with
 * `enforceTitleLength` for full title sanitization.
 */
export function normalizeTitle(t: string, targetKeyword?: string): string {
  if (!t) return t;
  let out = t.trim();
  const collapsed = out
    .replace(/\b(\w[\w'-]*)(\s+\1)+\b/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,:;-]+$/g, "");
  if (targetKeyword) {
    const kw = targetKeyword.trim().toLowerCase();
    // If collapsing would erase the target keyword from the title, bail
    // and keep the original whitespace-normalized form. Do not strip
    // trailing punctuation here because a keyword like "best-" would be
    // erased again by the cleanup.
    if (
      kw.length > 0 &&
      out.toLowerCase().includes(kw) &&
      !collapsed.toLowerCase().includes(kw)
    ) {
      return dedupeTitleSegments(out.replace(/\s{2,}/g, " "));
    }
  }
  return dedupeTitleSegments(collapsed);
}

/**
 * Drop pipe-separated title segments that add no new signal. Kimi
 * sometimes emits "Best X 2026 | Best Picks 2026" — the second segment
 * re-states the year and the "Best" framing, reading as keyword spam.
 * A later segment is dropped when it repeats a year already present
 * earlier, or when both it and the first segment start with Best/Top.
 * Segments carrying new information ("| Buying Guide") are kept.
 */
function dedupeTitleSegments(title: string): string {
  const parts = title.split(/\s*\|\s*/);
  if (parts.length < 2) return title;
  const kept: string[] = [parts[0]];
  for (const seg of parts.slice(1)) {
    if (!seg.trim()) continue;
    const prior = kept.join(" | ");
    const priorYears = new Set(prior.match(/\b20\d{2}\b/g) ?? []);
    const repeatsYear = (seg.match(/\b20\d{2}\b/g) ?? []).some((y) =>
      priorYears.has(y)
    );
    const bothLeadWithBest =
      /^(?:best|top)\b/i.test(seg.trim()) &&
      /^(?:\d{4}'s\s+)?(?:best|top)\b/i.test(parts[0].trim());
    if (repeatsYear || bothLeadWithBest) continue;
    kept.push(seg);
  }
  return kept.join(" | ");
}

/**
 * Enforce Google's SERP title pixel cap (~580px ≈ 60 characters) by
 * truncating to a word boundary. Tries to preserve the target keyword if
 * present — the keyword is required to rank, so we'd rather drop a
 * trailing "Top Picks 2026" suffix than slice through the keyword.
 *
 * Output never exceeds `maxChars`. Trailing dangling punctuation is
 * trimmed. Returns the title unchanged if it already fits.
 */
export function enforceTitleLength(
  title: string,
  targetKeyword?: string,
  maxChars = 60
): string {
  if (!title) return title;
  const limit = Number.isFinite(maxChars)
    ? Math.max(0, Math.floor(maxChars))
    : 60;
  let t = title.trim();
  if (t.length <= limit) return t;
  const kw = (targetKeyword || "").trim();
  // If the keyword fits within maxChars, try to retain a prefix that
  // includes it.
  if (kw && kw.length > 0 && kw.length <= limit) {
    const lowerT = t.toLowerCase();
    const idx = lowerT.indexOf(kw.toLowerCase());
    if (idx >= 0) {
      const keep = Math.min(t.length, idx + kw.length);
      // Try to extend to a clean word boundary or punctuation past the kw.
      let cut = Math.min(limit, t.length);
      // If the cut would land inside the keyword span, push it past.
      if (cut < keep) cut = keep;
      // Walk back to the last space if the cut is mid-word.
      while (cut > 0 && cut < t.length && /\S/.test(t[cut])) cut--;
      if (cut <= 0) cut = Math.min(limit, t.length);
      t = t.slice(0, cut).trim();
    }
  }
  if (t.length > limit) {
    let cut = limit;
    while (cut > 0 && /\S/.test(t[cut])) cut--;
    if (cut <= 0) cut = limit;
    t = t.slice(0, cut).trim();
  }
  // Strip dangling punctuation from the cut edge.
  t = t.replace(/[\s,:;\-—]+$/g, "");
  // If truncation sheared a suffix clause mid-phrase (e.g. ": One Clear
  // Winner" cut down to ": One"), drop the whole clause rather than ship
  // a dangling fragment. Only fires when we actually truncated; `t` is
  // always a prefix of the trimmed original, so indexes align.
  const original = title.trim();
  if (t.length < original.length) {
    const colonIdx = t.lastIndexOf(":");
    if (colonIdx > 0) {
      const origAfter = original.slice(colonIdx + 1).trim();
      const keptAfter = t.slice(colonIdx + 1).trim();
      if (
        keptAfter &&
        keptAfter.length < origAfter.length &&
        origAfter.toLowerCase().startsWith(keptAfter.toLowerCase())
      ) {
        t = t.slice(0, colonIdx).replace(/[\s,:;\-—]+$/g, "");
      }
    }
  }
  return t;
}

/**
 * Collapse mechanical whitespace + punctuation noise:
 *   - 3+ consecutive ASCII dots → single ellipsis character.
 *   - Runs of 2+ spaces collapsed to 1.
 *   - Spaces immediately before , . ; : ! ? removed.
 *   - 3+ blank lines collapsed to 2.
 *
 * Content inside <pre>, <code>, <textarea>, and <script> (incl. JSON-LD)
 * is preserved verbatim — JSON string values legitimately contain "..."
 * and arbitrary whitespace.
 */
export function normalizeHtmlWhitespace(html: string): string {
  if (!html) return html;
  const preserveRe =
    /<(pre|code|textarea|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
  const segments: Array<{ text: string; preserve: boolean }> = [];
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = preserveRe.exec(html)) !== null) {
    if (m.index > lastEnd) {
      segments.push({ text: html.slice(lastEnd, m.index), preserve: false });
    }
    segments.push({ text: m[0], preserve: true });
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < html.length) {
    segments.push({ text: html.slice(lastEnd), preserve: false });
  }
  const chunks: string[] = [];
  for (const seg of segments) {
    if (seg.preserve) {
      chunks.push(seg.text);
      continue;
    }
    let s = seg.text;
    s = s.replace(/\.{3,}/g, "…");
    s = s.replace(/\t+/g, " ");
    s = s.replace(/ {2,}/g, " ");
    s = s.replace(/ +([,.;:!?])/g, "$1");
    s = s.replace(/\n{3,}/g, "\n\n");
    chunks.push(s);
  }
  return chunks.join("");
}

/**
 * Demote every `<h1>...</h1>` element in a body-content fragment to
 * `<h2>...</h2>`. The page-level h1 is owned by the renderer; if Kimi
 * includes an extra h1 inside `introduction` / `section.content` /
 * `faq.answer`, two h1s ship to the live page.
 *
 * Preferred over deletion because the inner content is usually useful
 * keyword-rich heading text — demoting preserves both the content and
 * its heading-level SEO value.
 */
export function demoteBodyH1sToH2(htmlFragment: string): string {
  if (!htmlFragment) return htmlFragment;
  return htmlFragment
    .replace(/<h1\b([^>]*)>/gi, "<h2$1>")
    .replace(/<\/h1\s*>/gi, "</h2>");
}

/**
 * Extract the first sentence of a prose/HTML field, sentence-bounded,
 * for use as a meta-description fallback. Returns a clean plain-text
 * string between 50 and `maxChars` characters (default 155 — Google's
 * desktop SERP truncation point).
 *
 * Returns empty string if no usable sentence is found. Caller should
 * fall back to a stock template only in that case.
 */
export function deriveMetaDescriptionFromIntro(
  introHtmlOrText: string,
  maxChars = 155
): string {
  const MIN_META_DESCRIPTION_LENGTH = 50;
  if (!introHtmlOrText) return "";
  // Strip tags, decode all common entities (delegates to unescapeHtml so
  // &lt;, &gt;, &apos;, &#160;, &#xA0; etc. are all covered), collapse whitespace.
  const text = unescapeHtml(introHtmlOrText.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < MIN_META_DESCRIPTION_LENGTH) return "";
  // Take whole sentences up to maxChars.
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (!sentences || sentences.length === 0) {
    return text.slice(0, maxChars).trim();
  }
  let out = "";
  for (const s of sentences) {
    const trimmed = s.trim();
    const next = out ? `${out} ${trimmed}` : trimmed;
    if (next.length > maxChars) {
      if (out.length === 0) {
        // First sentence already too long — hard-truncate to a word.
        const slice = trimmed.slice(0, maxChars);
        const lastSpace = slice.lastIndexOf(" ");
        return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
      }
      break;
    }
    out = next;
  }
  if (out.length >= MIN_META_DESCRIPTION_LENGTH) {
    return out;
  }
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const fallback = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
  return fallback.length >= MIN_META_DESCRIPTION_LENGTH
    ? fallback
    : slice.trim();
}
