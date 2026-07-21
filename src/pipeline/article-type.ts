/**
 * Article-type classification + hard minimum word counts.
 *
 * Per Chief Engineer brief (2026-05-30 directive):
 *   - Informational articles ("how to", "what is", "why", "when to"):
 *     800 words minimum
 *   - Comparison / best-of / review articles ("best", "top", "vs",
 *     "comparison", "buying guide", "review"): 1200 words minimum
 *   - Any article under the minimum fails pre-publish with reason
 *     "thin-content-word-count" (consumed by the failure-attribution
 *     dashboard panel + the defect-loop categorizer).
 *
 * This module is the single source of truth for the policy. Writer.ts
 * imports the floor for its Content Quality Gate (Step 9/24 in the
 * publish pipeline). Pure functions; no Kimi calls, no I/O.
 */

export type ArticleType = "informational" | "comparison-or-review";

/** Hard minimum word counts. Treat as policy, not a recommendation. */
export const MIN_WORDS: Record<ArticleType, number> = {
  informational: 800,
  "comparison-or-review": 1200
};

/** Wire-level failure reason emitted when the gate trips. */
export const THIN_CONTENT_FAILURE_REASON = "thin-content-word-count";

const COMPARISON_HEAD_RE =
  /\b(best|top|cheapest|quietest|fastest|smallest|biggest|safest|premium|budget|review|reviews|compare|comparison|v\.?|vs\.?|versus|buying guide|alternatives?)\b/i;

const INFORMATIONAL_HEAD_RE =
  /\b(how(?:\s+|-)?to|how do|what is|what are|why do|why does|why is|when to|when should|where to|who is|which is|guide to|do cats|can cats|are cats|should cats)\b/i;

/**
 * Classify a keyword into informational vs comparison/review. The
 * heuristic favors `comparison-or-review` when both signals fire
 * because catsluvus.com is overwhelmingly affiliate-review content;
 * an ambiguous keyword like "best how to feed a cat" gets the
 * stricter 1200-word floor by default.
 *
 * Returns the classification + the minimum word count it implies, so
 * callers can do `const { minWords } = classifyArticleType(kw)`
 * without a second lookup.
 */
export function classifyArticleType(keyword: string): {
  type: ArticleType;
  minWords: number;
} {
  const k = (keyword ?? "").toLowerCase().trim();
  if (!k) {
    // Empty keyword: treat as comparison to be safe (the stricter
    // floor is the more conservative default for an unclassified
    // article on an affiliate site).
    return {
      type: "comparison-or-review",
      minWords: MIN_WORDS["comparison-or-review"]
    };
  }
  const isComparison = COMPARISON_HEAD_RE.test(k);
  const isInformational = INFORMATIONAL_HEAD_RE.test(k);
  // Both signals fire → prefer the stricter classification (comparison).
  // Only informational signal → informational.
  // Neither signal fires → default to comparison-or-review (most catsluvus
  // articles are affiliate-review by default).
  if (isComparison) {
    return {
      type: "comparison-or-review",
      minWords: MIN_WORDS["comparison-or-review"]
    };
  }
  if (isInformational) {
    return { type: "informational", minWords: MIN_WORDS.informational };
  }
  return {
    type: "comparison-or-review",
    minWords: MIN_WORDS["comparison-or-review"]
  };
}
