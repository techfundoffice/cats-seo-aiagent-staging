/**
 * Lightweight English stemmer + keyword-token matcher for the SEO
 * scorecard's intro-keyword checks (id #41 today; others may consume
 * this later).
 *
 * Background — why this exists as its own module:
 *
 * Scorecard check #41 ("Keyword tokens in first 100 words") used to
 * fail on natural-language intros that used a morphologically-varied
 * form of the keyword. E.g. keyword `"best cat fountains for senior
 * cats"`, intro `"Senior cats need a steady drinking fountain…"` —
 * strict literal token comparison fired even though the intro is
 * obviously on-topic. The over-penalty cascaded: check #41 sat in a
 * pillar that gated the publish floor.
 *
 * This stemmer is a one-way *relaxation* layer: a strict literal
 * match still passes; only morphologically-varied intros that
 * previously false-failed now pass. The comparison is bidirectional —
 * both sides go through the same stem function, then the keyword
 * stem is checked as a substring of any intro stem (and vice versa).
 * This catches both directions of variation:
 *
 *   - keyword `"fountains"` (plural) ↔ intro `"fountain"` (singular)
 *   - keyword `"running"`            ↔ intro `"run"`
 *   - keyword `"studies"`            ↔ intro `"study"`
 *   - keyword `"automation"`         ↔ intro `"automate"`
 *
 * No external dependencies. Pure functions. Unit-tested.
 */

/**
 * Common English stopwords excluded from the "significant tokens"
 * count so a multi-word keyword like `"the best cat fountain for
 * senior cats"` reduces to `["best","cat","fountain","senior","cats"]`
 * rather than dragging in zero-signal words.
 */
/**
 * Union of the prior in-file set (length ≥ 4 only, since the
 * `significant-tokens` filter excludes anything shorter) and the
 * SEO-affiliate terms that carry no topical signal. Every
 * commercial keyword on this site starts with one of the affiliate
 * terms, so matching them in the intro is meaningless. Words
 * shorter than 4 chars (`you`, `are`, `any`, `all`, `top`) are
 * intentionally absent — they're already filtered out upstream by
 * the length floor in `significantKeywordTokens`.
 */
export const KEYWORD_STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "for",
  "and",
  "with",
  "from",
  "your",
  "this",
  "that",
  "what",
  "which",
  "best",
  "buying",
  "guide",
  "review",
  "reviews"
]);

/**
 * Suffix → optional restoration rules. Order matters: longer
 * suffixes are tried first so `"fountains"` resolves to `"fountain"`
 * instead of `"fountain"` → empty by stripping `"s"` twice.
 *
 * Each entry produces a stem candidate; the caller picks whichever
 * candidate yields a successful match. The `restore` suffix is
 * appended after stripping when an inflection collapses two letters
 * (e.g. `"studies"` → strip `"ies"` + restore `"y"` → `"study"`).
 */
const SUFFIX_RULES: ReadonlyArray<{ strip: string; restore?: string }> = [
  // Plurals that need a vowel restoration ("studies" → "study").
  // Only the restore variant — the bare `ies` rule produced
  // over-aggressive stems like "studies" → "stud" that matched
  // unrelated words like "student" (Copilot review feedback on
  // #5483).
  { strip: "ies", restore: "y" },
  // Tense + agent suffixes.
  { strip: "ing" },
  { strip: "ed" },
  { strip: "es" },
  { strip: "s" },
  // Adverbs and comparatives.
  { strip: "ly" },
  { strip: "er" },
  // Nominalizations (verb → noun shape).
  { strip: "ation" },
  { strip: "tion" },
  { strip: "sion" },
  { strip: "ness" },
  { strip: "ment" },
  { strip: "ity" },
  { strip: "able" },
  { strip: "ible" }
];

/** Floor on the resulting stem length so we never collapse short
 *  semantic anchors into noise. Set to 3 so that legitimate
 *  3-letter base verbs surface from the double-consonant collapse
 *  ("running" → "run", "stopped" → "stop"). The
 *  `MIN_INPUT_LEN_TO_STEM` gate above prevents 3-/4-letter inputs
 *  from being stemmed in the first place, so this floor only
 *  governs the *result* length. */
const MIN_STEM_LEN = 3;

/** Floor on the input length below which we don't even try to stem
 *  — small words ("run", "cat") are already in their base form. */
const MIN_INPUT_LEN_TO_STEM = 5;

/**
 * "ing"/"ed" stripping can leave a double consonant that the original
 * verb didn't have ("running" → "runn", "stopped" → "stopp"). When
 * the stem ends in a doubled consonant we collapse it: "runn" → "run",
 * "stopp" → "stop". Only triggered for the tense suffixes to avoid
 * over-collapsing legitimate doubled-consonant nouns ("class").
 */
function collapseDoubleConsonantSuffix(stem: string): string {
  const m = stem.match(/^(.+?)([bcdfghjklmnpqrstvwxyz])\2$/i);
  // m[1] is the prefix; m[2] is the doubled consonant. Result is
  // m[1]+m[2]. Allow when prefix is ≥2 chars so a 3-letter base
  // verb ("run", "stop", "bag") still surfaces.
  if (m && m[1].length >= 2) return m[1] + m[2];
  return stem;
}

/**
 * Produce every plausible stem candidate for `t` (lowercased). Always
 * includes `t` itself so a strict literal match is preserved. Order
 * is: original first, then longest-suffix-first stems.
 */
export function stemCandidates(t: string): string[] {
  const lower = t.toLowerCase();
  const out: string[] = [lower];
  if (lower.length < MIN_INPUT_LEN_TO_STEM) return out;
  for (const rule of SUFFIX_RULES) {
    if (!lower.endsWith(rule.strip)) continue;
    const remaining = lower.length - rule.strip.length;
    if (remaining < MIN_STEM_LEN - (rule.restore ? 1 : 0)) continue;
    let stem = lower.slice(0, lower.length - rule.strip.length);
    if (rule.restore) stem = `${stem}${rule.restore}`;
    // Collapse double consonant only for tense suffixes where it's
    // an artifact of the original word's spelling rule.
    if (rule.strip === "ing" || rule.strip === "ed") {
      stem = collapseDoubleConsonantSuffix(stem);
    }
    if (stem.length >= MIN_STEM_LEN && !out.includes(stem)) {
      out.push(stem);
    }
  }
  return out;
}

/**
 * Canonical-form stem for `t`. Returns the FIRST non-identity
 * candidate so this is a stable single-value answer; for fuzzier
 * matches use `stemCandidates(t)` and check any.
 */
export function stem(t: string): string {
  const cands = stemCandidates(t);
  return cands[1] ?? cands[0];
}

/**
 * Normalize a single token for comparison: lowercase + strip
 * leading/trailing punctuation. Internal-only — callers pass raw
 * tokens and the matcher handles the normalization so the helper
 * stays robust when reused outside `seo-score.ts` (e.g. directly
 * over a `body.split(/\s+/)` result that still has commas/periods).
 */
function normalizeToken(t: string): string {
  return t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Does `keywordToken` match any token in `introTokens`? Order of
 * preference:
 *
 *   1. Exact substring of any intro word (strict literal match).
 *   2. Any keyword-stem candidate appears as a substring of any
 *      intro word.
 *   3. Any intro-word-stem candidate appears as a substring of the
 *      keyword token.
 *
 * Bidirectional comparison is what catches variants like
 * `keyword="study"` vs `intro="studies"` AND `keyword="studies"` vs
 * `intro="study"`.
 *
 * Intro tokens are normalized inside the helper (lowercase + strip
 * surrounding punctuation) so callers can pass raw `text.split(...)`
 * output. Defends against Copilot review feedback on #5483:
 * capitalized / punctuated intro tokens like `"Studies,"` would
 * previously miss the stem path.
 *
 * `introTokens` is passed in as a Set for caller-side caching when
 * matching many keyword tokens against the same intro.
 */
export function matchesIntroBidirectional(
  keywordToken: string,
  introTokens: ReadonlySet<string>
): boolean {
  const kw = normalizeToken(keywordToken);
  if (!kw) return false;
  // Build a normalized view of the intro tokens once. Empty strings
  // (pure-punctuation tokens) are dropped.
  const normalizedIntroTokens: string[] = [];
  for (const raw of introTokens) {
    const w = normalizeToken(raw);
    if (w) normalizedIntroTokens.push(w);
  }
  // Tier 1: strict literal.
  for (const w of normalizedIntroTokens) {
    if (w.includes(kw)) return true;
  }
  // Tier 2: stem of keyword in any intro word.
  for (const kwStem of stemCandidates(kw)) {
    if (kwStem === kw) continue; // already checked above
    for (const w of normalizedIntroTokens) {
      if (w.includes(kwStem)) return true;
    }
  }
  // Tier 3: stem of intro word in keyword token (catches the reverse
  // direction — intro uses singular, keyword uses plural).
  for (const w of normalizedIntroTokens) {
    for (const wStem of stemCandidates(w)) {
      if (wStem === w) continue;
      if (kw.includes(wStem)) return true;
    }
  }
  return false;
}

/**
 * Count how many tokens from `keywordTokens` match `introTokens` via
 * `matchesIntroBidirectional`. Used by check #41 to decide
 * `tokenHits / significantKwTokens.length >= ceil(N/2)`.
 */
export function countMatchingKeywordTokens(
  keywordTokens: readonly string[],
  introTokens: ReadonlySet<string>
): number {
  let hits = 0;
  for (const t of keywordTokens) {
    if (matchesIntroBidirectional(t, introTokens)) hits++;
  }
  return hits;
}

/**
 * Extract the significant-token subset of a keyword: lowercased,
 * split on whitespace, filtered by length ≥ 4 and not in
 * `KEYWORD_STOPWORDS`. Mirrors the existing seo-score.ts shape so the
 * caller can drop in this helper without changing semantics.
 */
export function significantKeywordTokens(keyword: string): string[] {
  return keyword
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !KEYWORD_STOPWORDS.has(t));
}
