/**
 * testing-vocab-swap.ts — word-boundary substitution of
 * test/testing/tested → compare/comparison/compared inside article
 * HTML, with structural skip rules.
 *
 * Used by `POST /api/admin/replace-testing-vocabulary` to refactor
 * the FTC-noncompliant vocabulary across already-published KV
 * articles in one pass. Pre-publish gates and inverted SEO check
 * #10 prevent NEW articles from emitting this language; this helper
 * cleans the corpus that pre-dates those gates.
 *
 * Skip rules (the safelist):
 *   - `<script>` blocks UNLESS they're JSON-LD
 *     (`type="application/ld+json"`). JSON-LD carries FAQ answer
 *     text and is one of the primary surfaces Google reads for
 *     rich snippets, so it MUST be swapped. Real JavaScript blocks
 *     would be syntactically corrupted by a text substitution and
 *     are left alone.
 *   - `href` / `src` attribute values. URL slugs that contain
 *     "test" (e.g. `/cat-dna-test-kits-ancestry/`) must not be
 *     mangled — broken links are a worse outcome than the
 *     vocabulary leak.
 *   - Explicit phrase safelist: `ISO tested`, `FDA tested`,
 *     `Pet Tested` (brand), `DNA test/testing/tested`, `fit test`,
 *     `safety tested`, `stress test`, `smoke test`, `litmus test`.
 *     These are legitimate third-party / generic references whose
 *     meaning would be destroyed by substitution.
 *
 * Case-preservation:
 *   - All-uppercase match → all-uppercase replacement (`TESTED` →
 *     `COMPARED`).
 *   - Title-case match → title-case replacement (`Tested` →
 *     `Compared`).
 *   - All-lowercase match → all-lowercase replacement (`tested` →
 *     `compared`). NOTE: the parameter `toWord` may be passed in
 *     any case; the helper internally lowercases it before
 *     applying the case rules so callers don't have to think
 *     about it.
 */

/** Phrases that are restored verbatim — substitution must not touch them. */
export const TESTING_VOCAB_SAFELIST_PHRASES: readonly string[] = [
  "ISO tested",
  "ISO Tested",
  "FDA tested",
  "FDA Tested",
  "Pet Tested",
  "DNA test",
  "DNA Test",
  "DNA testing",
  "DNA Testing",
  "DNA tested",
  "DNA Tested",
  "fit test",
  "Fit Test",
  "safety tested",
  "Safety Tested",
  "safety-tested",
  "stress test",
  "Stress Test",
  "smoke test",
  "Smoke Test",
  "litmus test",
  "Litmus Test"
];

/** Match href / src attributes (single, double, or unquoted values). */
const ATTR_URL_RE = /\b(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;

/**
 * Match every `<script>` block first; callers then use
 * `JSON_LD_SCRIPT_TYPE_RE` to decide whether a block should be
 * preserved for text swapping or stashed untouched.
 */
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;

/** Detect JSON-LD `<script>` tags with quoted or unquoted type values. */
const JSON_LD_SCRIPT_TYPE_RE =
  /<script\b[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json\b)/i;

/** Escape regex metacharacters in a literal phrase. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace whole-word occurrences of `fromWord` with `toWord`,
 * preserving the case of each match. The output for a lowercase
 * match is the lowercased form of `toWord`, regardless of the
 * casing passed in by the caller.
 */
export function replaceCasePreserving(
  input: string,
  fromWord: string,
  toWord: string
): string {
  const re = new RegExp(`\\b${escapeRe(fromWord)}\\b`, "gi");
  const lower = toWord.toLowerCase();
  return input.replace(re, (match) => {
    if (match === match.toUpperCase()) return lower.toUpperCase();
    if (match[0] === match[0].toUpperCase())
      return lower[0].toUpperCase() + lower.slice(1);
    return lower;
  });
}

/**
 * Apply the test/testing/tested → compare/comparison/compared
 * substitution to a full HTML document, respecting the skip rules
 * (non-JSON-LD scripts, href/src attributes, safelist phrases).
 *
 * Algorithm:
 *   1. Stash non-JSON-LD `<script>` blocks behind sentinels.
 *   2. Stash href / src attribute values.
 *   3. Stash safelist phrases.
 *   4. Run the three substitutions in longest-morphology-first
 *      order (Testing → Comparison, then Tested → Compared, then
 *      Test → Compare) so the shorter word can't partially eat a
 *      longer one mid-swap.
 *   5. Restore safelist, URLs, scripts in reverse-stash order.
 *
 * The output may have a slightly different byte length than the
 * input — `Compare` is the same length as `Test` + 3 ("comparison"
 * vs "testing" is +2, "compared" vs "tested" is +2). Document
 * structure is unchanged.
 */
export function applyTestingVocabSwap(html: string): string {
  if (!html || typeof html !== "string") return html;
  const sentinelPrefix = createUnusedSentinelPrefix(html);
  const scriptToken = (index: number) => `${sentinelPrefix}SCRIPT_${index}__`;
  const urlToken = (index: number) => `${sentinelPrefix}URL_${index}__`;
  const safeToken = (index: number) => `${sentinelPrefix}SAFE_${index}__`;
  const scripts: string[] = [];
  let masked = html.replace(SCRIPT_BLOCK_RE, (m) => {
    if (JSON_LD_SCRIPT_TYPE_RE.test(m)) return m;
    scripts.push(m);
    return scriptToken(scripts.length - 1);
  });
  const urls: string[] = [];
  masked = masked.replace(ATTR_URL_RE, (_, attr, val) => {
    urls.push(val);
    return `${attr}=${urlToken(urls.length - 1)}`;
  });
  const safelist: string[] = [];
  for (const phrase of TESTING_VOCAB_SAFELIST_PHRASES) {
    const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, "g");
    masked = masked.replace(re, (m) => {
      safelist.push(m);
      return safeToken(safelist.length - 1);
    });
  }
  masked = replaceCasePreserving(masked, "Testing", "Comparison");
  masked = replaceCasePreserving(masked, "Tested", "Compared");
  masked = replaceCasePreserving(masked, "Test", "Compare");
  masked = masked.replace(
    new RegExp(`${escapeRe(sentinelPrefix)}SAFE_(\\d+)__`, "g"),
    (_, i) => safelist[Number(i)]
  );
  masked = masked.replace(
    new RegExp(`${escapeRe(sentinelPrefix)}URL_(\\d+)__`, "g"),
    (_, i) => urls[Number(i)]
  );
  masked = masked.replace(
    new RegExp(`${escapeRe(sentinelPrefix)}SCRIPT_(\\d+)__`, "g"),
    (_, i) => scripts[Number(i)]
  );
  return masked;
}

function createUnusedSentinelPrefix(html: string): string {
  const base = "\uE000CATSLVUS_SWAP\uE001";
  const hashedBase = `${base}${fnv1aHash32Hex(html)}_`;
  if (!html.includes(hashedBase)) {
    return hashedBase;
  }
  for (let suffix = 0; suffix < 16; suffix++) {
    const candidate = `${hashedBase}${suffix}_`;
    if (!html.includes(candidate)) {
      return candidate;
    }
  }
  return `${hashedBase}fallback_`;
}

function fnv1aHash32Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Heading elements h1–h6 with their inner HTML captured. */
const HEADING_RE = /(<h([1-6])\b[^>]*>)([\s\S]*?)(<\/h\2\s*>)/gi;

/** In-page TOC anchors (`<a href="#…">text</a>`) with plain-text bodies. */
const TOC_ANCHOR_RE =
  /(<a\s+[^>]*href\s*=\s*["']#[^"']*["'][^>]*>)([^<]*)(<\/a\s*>)/gi;

/**
 * Neutralize fabricated-testing vocabulary in headings and in-page
 * TOC anchors only, leaving body prose untouched.
 *
 * Why this exists: the Polish Agent's LLM rewrite (inverted SEO check
 * #10) operates on sentence-level find/replace against a truncated
 * plain-text excerpt, so it structurally cannot fix an `<h2>Our
 * Testing Methodology…</h2>` deep in the article or its
 * `<a href="#section-10">` TOC twin — both shipped verbatim in the
 * 2026-06-11 "elevated cat bowl reviews" publish despite the Step
 * 14.7 detector flagging them. Headings/TOC are deterministic
 * surfaces, so they get the same trusted `applyTestingVocabSwap`
 * treatment the corpus-cleanup endpoint uses, scoped per element.
 */
export function neutralizeTestingHeadings(html: string): {
  html: string;
  changed: number;
} {
  if (!html || typeof html !== "string") return { html, changed: 0 };
  let changed = 0;
  const swapIfTesting = (inner: string): string => {
    if (!/\btest(?:ing|ed|s)?\b/i.test(inner)) return inner;
    const swapped = applyTestingVocabSwap(inner);
    if (swapped !== inner) changed++;
    return swapped;
  };
  let out = html.replace(
    HEADING_RE,
    (_, open, _lvl, inner, close) => `${open}${swapIfTesting(inner)}${close}`
  );
  out = out.replace(
    TOC_ANCHOR_RE,
    (_, open, inner, close) => `${open}${swapIfTesting(inner)}${close}`
  );
  return { html: out, changed };
}
