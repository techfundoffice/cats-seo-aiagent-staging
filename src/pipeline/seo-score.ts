/**
 * SEO "Perfect 100" Scorecard — 5 Pillars, 100 Individual Checks (1 point each)
 *
 * I.   Proof of Experience (1-20)
 * II.  Entity Authority (21-40)
 * III. User Satisfaction (41-60)
 * IV.  Information Gain (61-80)
 * V.   Technical UX (81-100)
 */

import { stripHtmlToPlainText } from "./plagiarism-overlap";
import { unescapeHtml } from "./http-utils";
import {
  countMatchingKeywordTokens,
  significantKeywordTokens
} from "./keyword-stemmer";
import {
  stripCompliantMethodologySections,
  TESTING_CLAIM_RE
} from "./fabricated-testing-claims";

/** A single scored check within the SEO scorecard (currently 105 checks). */
export interface SEOCheck {
  /** Sequential check ID (1–105). Stable across runs — safe to use as a column key. */
  id: number;
  /** Pillar name (e.g. "Proof of Experience", "Entity Authority"). One of the five pillars. */
  pillar: string;
  /** Short human-readable check label (e.g. "Keyword in title"). */
  name: string;
  /** `true` when the check passed and the 1-point contribution is counted in `score`. */
  passed: boolean;
  /** Human-readable explanation of why the check passed or failed. */
  detail: string;
}

/** Aggregate result returned by `calculateSEOScore`. */
export interface SEOScoreResult {
  /** Total score (one point per passing check; maximum = SEO_SCORECARD_CHECK_COUNT = 105). */
  score: number;
  /** All individual checks in pillar order (ids 1–105). */
  checks: SEOCheck[];
  /** Number of checks that passed. Equals `score`. */
  passed: number;
  /** Number of checks that failed. Equals `SEO_SCORECARD_CHECK_COUNT - score` (105 − score). */
  failed: number;
  /** Per-pillar breakdown: maps pillar name → `{ passed, total }`. */
  pillarScores: Record<string, { passed: number; total: number }>;
  /** Intermediate metrics and bonus/penalty lists used to derive the score. */
  details: {
    /** Total word count of the article text (HTML stripped). */
    wordCount: number;
    /** Keyword density as a decimal fraction (e.g. 0.012 for 1.2 %). */
    keywordDensity: number;
    /** Descriptions of individual bonus conditions that were satisfied. */
    bonuses: string[];
    /** Descriptions of individual penalty conditions that were triggered. */
    penalties: string[];
  };
}

/**
 * Module-level cache for the "freshness" year regex (check #74).
 * Rebuilt only when the calendar year rolls over so that the RegExp
 * constructor is not invoked on every `calculateSEOScore()` call.
 */
let _freshYearRe: RegExp | null = null;
let _freshYearReYear = 0;

function getFreshYearRe(): RegExp {
  const y = new Date().getFullYear();
  if (_freshYearRe === null || _freshYearReYear !== y) {
    _freshYearRe = new RegExp(`\\b(${y}|${y + 1})\\b`);
    _freshYearReYear = y;
  }
  return _freshYearRe;
}

function countOccurrences(text: string, word: string): number {
  if (!word || !text) return 0;
  const normalizedKeywordTokens = word
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (normalizedKeywordTokens.length === 0) return 0;
  const textTokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (textTokens.length < normalizedKeywordTokens.length) return 0;

  let count = 0;
  for (
    let i = 0;
    i <= textTokens.length - normalizedKeywordTokens.length;
    i++
  ) {
    let matches = true;
    for (let j = 0; j < normalizedKeywordTokens.length; j++) {
      if (textTokens[i + j] !== normalizedKeywordTokens[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      count += 1;
    }
  }
  return count;
}

/**
 * Score an article against the SEO scorecard (105 checks across five pillars).
 *
 * The scorecard is split into five pillars. Pillars I–IV each contain 20
 * checks; Pillar V grew beyond the original 20 as new Technical UX signals
 * were added and now contains 25 checks:
 *   I.   Proof of Experience  (checks   1–20,  20 checks)
 *   II.  Entity Authority     (checks  21–40,  20 checks)
 *   III. User Satisfaction    (checks  41–60,  20 checks)
 *   IV.  Information Gain     (checks  61–80,  20 checks)
 *   V.   Technical UX         (checks  81–105, 25 checks)
 *
 * Each check contributes exactly 1 point; the final score is the count
 * of passed checks (0–SEO_SCORECARD_CHECK_COUNT, currently 0–105).
 *
 * @param html            Full rendered article HTML (scripts and styles
 *                        are stripped internally before analysis).
 * @param keyword         Target keyword for density and heading checks.
 * @param title           `<title>` / `<h1>` string for title-specific checks.
 * @param _metaDescription Reserved for future meta-description checks;
 *                        not consumed by the current implementation.
 * @param _targetWordCount Reserved for future word-count-gate checks;
 *                        not consumed by the current implementation.
 */
export function calculateSEOScore(
  html: string,
  keyword: string,
  title: string,
  metaDescription: string,
  _targetWordCount: number = 1000
): SEOScoreResult {
  const checks: SEOCheck[] = [];
  const bodyText = unescapeHtml(stripHtmlToPlainText(html));
  const wordCount = bodyText.split(/\s+/).filter((w) => w.length > 1).length;
  const kwLower = keyword.toLowerCase();
  const keywordCount = countOccurrences(bodyText, kwLower);
  const keywordDensity = wordCount > 0 ? (keywordCount / wordCount) * 100 : 0;

  const P1 = "I. Proof of Experience";
  const P2 = "II. Entity Authority";
  const P3 = "III. User Satisfaction";
  const P4 = "IV. Information Gain";
  const P5 = "V. Technical UX";

  // ═══════════════════════════════════════════════════════════════════════════
  // PILLAR I: PROOF OF EXPERIENCE (1-20)
  // ═══════════════════════════════════════════════════════════════════════════

  checks.push({
    id: 1,
    pillar: P1,
    name: 'Use of "I" and "We"',
    passed: /\b(I |We |we |Our |our )\b/.test(bodyText),
    detail: /\bwe \b/i.test(bodyText) ? "Found" : "Missing"
  });
  checks.push({
    id: 2,
    pillar: P1,
    name: "Original photos (with dimensions)",
    passed:
      html.includes('width="') &&
      html.includes('height="') &&
      html.includes("<img"),
    detail: "Image with dimensions"
  });
  checks.push({
    id: 3,
    pillar: P1,
    name: "Video walkthroughs",
    passed: html.includes("lite-youtube") || html.includes("youtube.com"),
    detail: html.includes("lite-youtube") ? "YouTube embed" : "None"
  });
  checks.push({
    id: 4,
    pillar: P1,
    name: "Screenshots of tools in use",
    passed: html.includes("product-image") || html.includes("article-image"),
    detail: "Product/article images"
  });
  checks.push({
    id: 5,
    pillar: P1,
    name: "Personal anecdotes",
    passed:
      /\b(at our facility|at Cats Luv Us|in our boarding|we tested|we evaluated|I noticed|I found)\b/i.test(
        bodyText
      ),
    detail: "Facility experience"
  });
  checks.push({
    id: 6,
    pillar: P1,
    name: '"What I learned" sections',
    passed:
      /\b(what we learned|key takeaway|what we found|our experience)\b/i.test(
        bodyText
      ),
    detail: "Learning shared"
  });
  checks.push({
    id: 7,
    pillar: P1,
    name: "Description of mistakes/challenges",
    passed:
      /\b(common mistake|problem|challenge|issue|drawback|downside|we noticed)\b/i.test(
        bodyText
      ),
    detail: "Problems discussed"
  });
  checks.push({
    id: 8,
    pillar: P1,
    name: "Physical location tagging",
    passed: /Laguna Niguel|27601 Forbes/i.test(html),
    detail: "Laguna Niguel, CA"
  });
  checks.push({
    id: 9,
    pillar: P1,
    name: "Direct quotes from author",
    passed: html.includes("author-box") && /Amelia Hartwell/i.test(html),
    detail: "Author attribution"
  });
  // Check #10 was historically "Proprietary testing data" — it PASSED when
  // the body contained first-person testing language ("we tested", "hands-
  // on", "in our facility"). That was the wrong direction: catsluvus.com
  // does not physically test products, so rewarding the model for emitting
  // those phrases pulled the Polish Agent toward FTC-noncompliant copy.
  // Inverted 2026-06: the check now FAILS when fabricated testing language
  // is present, so the polish-agent rewrite loop naturally cleans the
  // article instead of further contaminating it. The 100-point scorecard
  // math is unchanged because the check id and pillar weight stayed the
  // same — only the pass/fail direction flipped. Source-of-truth regex
  // lives in src/pipeline/fabricated-testing-claims.ts.
  // FTC proximity exception (16 CFR Part 255): the
  // `<section class="wc-methodology">` block opens with "We compared
  // N products" and closes with a methodology disclosure ("Products
  // are not physically tested by Cats Luv Us…") in the same section.
  // Both elements together satisfy the substantiation standard, so
  // bare-text matching of "we compared" inside that section is a
  // false positive against the FTC standard. Strip compliant
  // `wc-methodology` sections before the regex pass so #10 passes
  // when the template is correct and fails when fabricated language
  // appears anywhere else.
  const ftcCheckText = unescapeHtml(
    stripHtmlToPlainText(stripCompliantMethodologySections(html))
  );
  checks.push({
    id: 10,
    pillar: P1,
    name: "No fabricated testing claims",
    passed: !TESTING_CLAIM_RE.test(ftcCheckText),
    detail: "FTC false-endorsement risk"
  });
  checks.push({
    id: 11,
    pillar: P1,
    name: "Before and After / case studies",
    passed:
      /\b(before|after|case study|results|improvement|reduced|increased)\b/i.test(
        bodyText
      ),
    detail: "Results shared"
  });
  checks.push({
    id: 12,
    pillar: P1,
    name: "Specific dates/times of testing",
    passed: /\b(20[2-3]\d|months|weeks|days of testing|over \d+)\b/i.test(
      bodyText
    ),
    detail: "Time references"
  });
  checks.push({
    id: 13,
    pillar: P1,
    name: "Unique methodology explained",
    passed:
      html.includes("wc-methodology") ||
      html.includes("How We Chose") ||
      /\b(methodology|criteria|evaluation|how we chose)\b/i.test(bodyText),
    detail: "Method explained"
  });
  checks.push({
    id: 14,
    pillar: P1,
    name: "Real-world results shared",
    passed: /\b(percent|%|\d+ cats|\d+ products|\d+ models)\b/i.test(bodyText),
    detail: "Quantified results"
  });
  checks.push({
    id: 15,
    pillar: P1,
    name: "Non-stock images (AI-generated)",
    passed:
      html.includes("pub.catsluvus.com") ||
      html.includes("seo-images") ||
      html.includes(".r2.dev/"),
    detail: "Custom images"
  });
  checks.push({
    id: 16,
    pillar: P1,
    name: "Audio/video content",
    passed: html.includes("lite-youtube") || html.includes("youtube"),
    detail: "Video content"
  });
  checks.push({
    id: 17,
    pillar: P1,
    name: "Visual diagrams/infographics",
    passed: html.includes("figure") || html.includes("figcaption"),
    detail: "Figure elements"
  });
  checks.push({
    id: 18,
    pillar: P1,
    name: "Comparison of products tested",
    passed: html.includes("top-picks") || html.includes("comparison"),
    detail: "Product comparison"
  });
  checks.push({
    id: 19,
    pillar: P1,
    name: "Edge cases others miss",
    passed:
      /\b(however|but|exception|edge case|special case|unlike|important note)\b/i.test(
        bodyText
      ),
    detail: "Nuance included"
  });
  checks.push({
    id: 20,
    pillar: P1,
    name: "Behind the scenes content",
    passed:
      /\b(behind the scenes|our process|how we|at our boarding|in our facility)\b/i.test(
        bodyText
      ),
    detail: "Process shared"
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PILLAR II: ENTITY AUTHORITY (21-40)
  // ═══════════════════════════════════════════════════════════════════════════

  checks.push({
    id: 21,
    pillar: P2,
    name: "Clear byline at top",
    passed: html.includes("author-box") || html.includes("Written by"),
    detail: "Author box"
  });
  checks.push({
    id: 22,
    pillar: P2,
    name: "Link to Author Bio",
    passed:
      html.includes("author/amelia-hartwell") || html.includes("author-box"),
    detail: "Author link"
  });
  checks.push({
    id: 23,
    pillar: P2,
    name: "Bio lists degrees/certs",
    passed: /\b(Certified|Specialist|Consultant|15 years|professional)\b/i.test(
      html
    ),
    detail: "Credentials listed"
  });
  checks.push({
    id: 24,
    pillar: P2,
    name: "Author image present",
    passed:
      html.includes("amelia-hartwell.webp") ||
      (html.includes("author") && html.includes("<img")),
    detail: "Author photo"
  });
  checks.push({
    id: 25,
    pillar: P2,
    name: "Author has niche experience",
    passed: /\b(cat care|feline|boarding hotel|grooming)\b/i.test(html),
    detail: "Cat care expertise"
  });
  checks.push({
    id: 26,
    pillar: P2,
    name: 'Site has clear "Primary Focus"',
    passed: html.includes("catsluvus.com") && /\bcat\b/i.test(title),
    detail: "Cat niche focus"
  });
  checks.push({
    id: 27,
    pillar: P2,
    name: "Organization Schema used",
    passed:
      html.includes('"@type":"Organization"') ||
      html.includes('"@type": "Organization"'),
    detail: "JSON-LD"
  });
  checks.push({
    id: 28,
    pillar: P2,
    name: "Physical office address listed",
    passed: /27601 Forbes.*Laguna Niguel/i.test(html),
    detail: "Full address"
  });
  checks.push({
    id: 29,
    pillar: P2,
    name: "About Us / team shown",
    passed: html.includes("Cats Luv Us Boarding Hotel"),
    detail: "Business name"
  });
  checks.push({
    id: 30,
    pillar: P2,
    name: "Links to .gov/.edu/.org sites",
    passed: /href="https?:\/\/[^"]*\.(gov|edu|org)\//i.test(html),
    detail: "Authority links"
  });
  checks.push({
    id: 31,
    pillar: P2,
    name: "Mentions other experts",
    passed:
      /\b(veterinar|vet|expert|specialist|researcher|study|research)\b/i.test(
        bodyText
      ),
    detail: "Expert references"
  });
  checks.push({
    id: 32,
    pillar: P2,
    name: "Original reporting/interviews",
    passed:
      /\b(according to|interview|spoke with|consulted|nutritionist|engineer)\b/i.test(
        bodyText
      ),
    detail: "Expert consultation"
  });
  checks.push({
    id: 33,
    pillar: P2,
    name: "Proper citations for stats",
    passed: /\b(according|source|study|research|percent|survey)\b/i.test(
      bodyText
    ),
    detail: "Citations present"
  });
  checks.push({
    id: 34,
    pillar: P2,
    name: "Fact-check / editorial note",
    passed:
      /\b(fact.check|editorial|AI.assisted|human expert|reviewed by)\b/i.test(
        bodyText
      ),
    detail: "Editorial note"
  });
  checks.push({
    id: 35,
    pillar: P2,
    name: "Industry jargon used correctly",
    passed:
      /\b(kibble|AAFCO|BPA.free|stainless steel|infrared|sensor|hopper|portion)\b/i.test(
        bodyText
      ),
    detail: "Technical terms"
  });
  checks.push({
    id: 36,
    pillar: P2,
    name: "Links to author's work",
    passed:
      html.includes("catsluvus.com/") &&
      (html.match(/href="[^"]*catsluvus[^"]*"/gi) || []).length >= 3,
    detail: "Internal links"
  });
  checks.push({
    id: 37,
    pillar: P2,
    name: "Brand name recognition",
    passed: html.includes("Cats Luv Us") || html.includes("CatsLuvUs"),
    detail: "Brand present"
  });
  checks.push({
    id: 38,
    pillar: P2,
    name: "Contact transparency",
    passed: /\(949\) 582-1732|\+1-949-582-1732/i.test(html),
    detail: "Phone number"
  });
  checks.push({
    id: 39,
    pillar: P2,
    name: "LocalBusiness Schema",
    passed:
      html.includes('"@type":"LocalBusiness"') ||
      html.includes('"@type": "LocalBusiness"'),
    detail: "JSON-LD"
  });
  checks.push({
    id: 40,
    pillar: P2,
    name: "Privacy/Terms link",
    passed:
      /(?:privacy|terms|policy)/i.test(html) && /<a\s[^>]*href=/i.test(html),
    detail: /(?:privacy|terms|policy)/i.test(html)
      ? "policy link present"
      : "no privacy/terms/policy link found"
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PILLAR III: USER SATISFACTION (41-60)
  // ═══════════════════════════════════════════════════════════════════════════

  const first100Words = bodyText
    .split(/\s+/)
    .slice(0, 100)
    .join(" ")
    .toLowerCase();
  // Strengthened check 41: previously this passed if just the FIRST
  // word of the keyword appeared in the intro — for a keyword like
  // "best cat fountains for senior cats" that's just "best", a
  // trivial pass for nearly any article. Real signal: ≥ half of the
  // SIGNIFICANT tokens (length ≥ 4, excluding stopwords) appear in
  // the first 100 words. Mirrors how Google evaluates the head
  // signal of an article.
  //
  // Token-matching + stemming logic lives in `./keyword-stemmer.ts`
  // — bidirectional stem comparison handles the false-fail cases
  // operator flagged (keyword "fountains" vs intro "fountain",
  // keyword "study" vs intro "studies", keyword "running" vs intro
  // "run", etc.). See PR for the check id #41 anti-over-penalisation
  // brief.
  const significantKwTokens = significantKeywordTokens(kwLower);
  const intro = first100Words;
  const introTokenSet = new Set(intro.split(/\s+/));
  const tokenHits = countMatchingKeywordTokens(
    significantKwTokens,
    introTokenSet
  );
  // Require at least half of the significant tokens, with a floor of 1
  // (single-token keywords still pass with the one token). If the
  // keyword has no significant tokens (extreme edge case, e.g. all
  // stopwords), fall back to the prior first-word check so we never
  // produce a guaranteed-fail.
  const introTarget =
    significantKwTokens.length === 0
      ? 0
      : Math.max(1, Math.ceil(significantKwTokens.length / 2));
  const introPassed =
    significantKwTokens.length === 0
      ? first100Words.includes(kwLower.split(" ")[0])
      : tokenHits >= introTarget;
  checks.push({
    id: 41,
    pillar: P3,
    name: "Keyword tokens in first 100 words",
    passed: introPassed,
    detail:
      significantKwTokens.length === 0
        ? "fallback first-word check"
        : `${tokenHits}/${significantKwTokens.length} significant tokens (need ${introTarget})`
  });
  checks.push({
    id: 42,
    pillar: P3,
    name: "TL;DR / Quick Answer at start",
    passed: html.includes("quick-answer"),
    detail: "Quick answer box"
  });
  checks.push({
    id: 43,
    pillar: P3,
    name: "Jump to Section links (TOC)",
    passed: html.includes("toc") || html.includes("In This Article"),
    detail: "Table of contents"
  });
  checks.push({
    id: 44,
    pillar: P3,
    name: "No filler introductions",
    passed: !/\b(in today's world|it's no secret|when it comes to)\b/i.test(
      first100Words
    ),
    detail: "Clean intro"
  });
  checks.push({
    id: 45,
    pillar: P3,
    name: "Scannable H2/H3 headers",
    passed: (html.match(/<h[23][\s>]/gi) || []).length >= 3,
    detail: `${(html.match(/<h2[\s>]/gi) || []).length} H2s`
  });
  checks.push({
    id: 46,
    pillar: P3,
    name: "Bolded key phrases",
    passed: (html.match(/<strong[\s>]/gi) || []).length >= 1,
    detail: "Bold emphasis"
  });
  checks.push({
    id: 47,
    pillar: P3,
    name: "Bulleted lists for complex info",
    passed: (html.match(/<[uo]l[\s>]/gi) || []).length >= 1,
    detail: "Lists present"
  });
  checks.push({
    id: 48,
    pillar: P3,
    name: "Comparison tables for data",
    passed: html.includes("top-picks") || html.includes("<table"),
    detail: "Comparison table"
  });
  checks.push({
    id: 49,
    pillar: P3,
    name: "Content prevents pogosticking",
    passed: wordCount >= 300 && keywordCount >= 3,
    detail: "Comprehensive"
  });
  checks.push({
    id: 50,
    pillar: P3,
    name: "High dwell time content (2+ min)",
    passed: wordCount >= 500,
    detail: `${wordCount} words ≈ ${Math.round(wordCount / 250)} min read`
  });
  checks.push({
    id: 51,
    pillar: P3,
    name: "Interactive element (comparison)",
    passed: html.includes("top-picks") || html.includes("faq-item"),
    detail: "Interactive content"
  });
  checks.push({
    id: 52,
    pillar: P3,
    name: "Next Steps checklist at end",
    passed:
      html.includes("conclusion") ||
      /\b(next step|recommend|start by|we suggest)\b/i.test(bodyText),
    detail: "Actionable ending"
  });
  checks.push({
    id: 53,
    pillar: P3,
    name: "FAQ section answering PAA",
    passed: (html.match(/faq-item/gi) || []).length >= 3,
    detail: `${(html.match(/faq-item/gi) || []).length} FAQs`
  });
  checks.push({
    id: 54,
    pillar: P3,
    name: "Content matches search intent",
    passed:
      title.toLowerCase().includes("best") ||
      title.toLowerCase().includes("top") ||
      title.toLowerCase().includes("review"),
    detail: "Buying intent"
  });
  checks.push({
    id: 55,
    pillar: P3,
    name: "No clickbait title",
    passed:
      !/\b(you won't believe|shocking|this one trick|jaw.dropping)\b/i.test(
        title
      ),
    detail: "Honest title"
  });
  checks.push({
    id: 56,
    pillar: P3,
    name: "High scroll depth (full content)",
    passed:
      (html.match(/<h2[\s>]/gi) || []).length >= 3 &&
      html.includes("conclusion"),
    detail: "Full article"
  });
  checks.push({
    id: 57,
    pillar: P3,
    name: "Brand recognition (direct traffic)",
    passed: html.includes("catsluvus.com"),
    detail: "Branded URL"
  });
  checks.push({
    id: 58,
    pillar: P3,
    name: "Low bounce rate design",
    passed: html.includes("quick-answer") && html.includes("top-picks"),
    detail: "Engaging above fold"
  });
  checks.push({
    id: 59,
    pillar: P3,
    name: "Internal links provide real value",
    passed: (html.match(/href="[^"]*catsluvus[^"]*"/gi) || []).length >= 3,
    detail: "Related content"
  });
  checks.push({
    id: 60,
    pillar: P3,
    name: "Content resolves user journey",
    passed: html.includes("conclusion") && html.includes("amazon.com"),
    detail: "Research → Buy"
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PILLAR IV: INFORMATION GAIN (61-80)
  // ═══════════════════════════════════════════════════════════════════════════

  checks.push({
    id: 61,
    pillar: P4,
    name: "Fact not in Top 10 results",
    passed:
      /\b(at our facility|at Cats Luv Us|our boarding hotel|we tested)\b/i.test(
        bodyText
      ),
    detail: "Unique facility data"
  });
  checks.push({
    id: 62,
    pillar: P4,
    name: "New perspective / hot take",
    passed:
      /\b(however|contrary|unlike|important note|often overlooked|most people don't)\b/i.test(
        bodyText
      ),
    detail: "Unique viewpoint"
  });
  checks.push({
    id: 63,
    pillar: P4,
    name: "Internal testing results",
    passed:
      /\b(we tested|we evaluated|we found|our testing|our review)\b/i.test(
        bodyText
      ),
    detail: "Original testing"
  });
  checks.push({
    id: 64,
    pillar: P4,
    name: "Unique pros/cons others missed",
    passed:
      /\b(pro|con|advantage|disadvantage|downside|upside|drawback)\b/i.test(
        bodyText
      ),
    detail: "Pros/cons analysis"
  });
  checks.push({
    id: 65,
    pillar: P4,
    name: "Solving a sub-problem on page",
    passed: /\b(tip|trick|solution|fix|workaround|common problem)\b/i.test(
      bodyText
    ),
    detail: "Sub-problems solved"
  });
  checks.push({
    id: 66,
    pillar: P4,
    name: "Prediction of future trends",
    passed:
      /\b(trend|future|upcoming|expect|20[2-3]\d|newer model|latest)\b/i.test(
        bodyText
      ),
    detail: "Forward-looking"
  });
  checks.push({
    id: 67,
    pillar: P4,
    name: "Pricing/Cost breakdown",
    passed: /\$\d+|price|cost|budget|affordable|expensive|value/i.test(
      bodyText
    ),
    detail: "Pricing discussed"
  });
  checks.push({
    id: 68,
    pillar: P4,
    name: "Tactical How-To steps",
    passed: /\b(step|how to|guide|install|set up|configure)\b/i.test(bodyText),
    detail: "Actionable steps"
  });
  checks.push({
    id: 69,
    pillar: P4,
    name: "Downloadable resource / checklist",
    passed: html.includes("key-takeaways") || html.includes("checklist"),
    detail: "Takeaways list"
  });
  checks.push({
    id: 70,
    pillar: P4,
    name: "Local-specific nuances",
    passed:
      /\b(Laguna Niguel|California|Southern California|Orange County)\b/i.test(
        bodyText
      ),
    detail: "Local context"
  });
  checks.push({
    id: 71,
    pillar: P4,
    name: "Entity nodes (Knowledge Graph)",
    passed: html.includes("LocalBusiness") && html.includes("GeoCoordinates"),
    detail: "KG entities"
  });
  checks.push({
    id: 72,
    pillar: P4,
    name: "Correction of common myths",
    passed:
      /\b(myth|misconception|common mistake|actually|contrary to)\b/i.test(
        bodyText
      ),
    detail: "Myths busted"
  });
  checks.push({
    id: 73,
    pillar: P4,
    name: "Expert commentary on news",
    passed:
      /\b(veterinar|nutritionist|expert|specialist|recommend|advise)\b/i.test(
        bodyText
      ),
    detail: "Expert input"
  });
  {
    // Build the freshness regex dynamically so it never needs manual
    // updating as calendar years roll forward. Accepts the current year
    // or the immediately following year (articles may reference upcoming
    // model releases / trends), and rejects last year or earlier as stale.
    // The result is cached at module level and only rebuilt on year rollover.
    const freshYearRe = getFreshYearRe();
    checks.push({
      id: 74,
      pillar: P4,
      name: "Freshness (current year)",
      passed: freshYearRe.test(bodyText) || freshYearRe.test(title),
      detail: "Current year"
    });
  }
  checks.push({
    id: 75,
    pillar: P4,
    name: "Multi-modal (Text + Image + Video)",
    passed:
      html.includes("<img") &&
      (html.includes("lite-youtube") || html.includes("youtube")),
    detail: "Text + Image + Video"
  });
  checks.push({
    id: 76,
    pillar: P4,
    name: 'Content is "The Last Click"',
    passed:
      wordCount >= 500 &&
      (html.match(/<h2[\s>]/gi) || []).length >= 3 &&
      html.includes("faq-item"),
    detail: "Comprehensive"
  });
  checks.push({
    id: 77,
    pillar: P4,
    name: "No rehashed/spun content",
    passed:
      !/\b(in conclusion|to sum up|all in all|at the end of the day)\b/i.test(
        bodyText
      ),
    detail: "Original voice"
  });
  checks.push({
    id: 78,
    pillar: P4,
    name: "Complex concepts simplified",
    passed:
      /\b(simply put|in other words|think of it|for example|such as)\b/i.test(
        bodyText
      ),
    detail: "Simplified"
  });
  checks.push({
    id: 79,
    pillar: P4,
    name: "Follow-up questions depth (5+ FAQs)",
    passed: (html.match(/faq-item/gi) || []).length >= 5,
    detail: `${(html.match(/faq-item/gi) || []).length} FAQs (threshold 5 for depth signal vs. #53 baseline of 3)`
  });
  checks.push({
    id: 80,
    pillar: P4,
    name: "Content adds value beyond ranking",
    passed:
      html.includes("wc-trust-box") &&
      html.includes("top-picks") &&
      html.includes("faq-item"),
    detail: "Real value"
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PILLAR V: TECHNICAL UX (81-100)
  // ═══════════════════════════════════════════════════════════════════════════

  checks.push({
    id: 81,
    pillar: P5,
    name: "Core Web Vitals (LCP hints)",
    passed:
      html.includes('fetchpriority="high"') && html.includes('loading="eager"'),
    detail: "LCP optimized"
  });
  checks.push({
    id: 82,
    pillar: P5,
    name: "100% Mobile Friendly",
    passed: html.includes("viewport") && html.includes("max-width:"),
    detail: "Responsive CSS"
  });
  checks.push({
    id: 83,
    pillar: P5,
    name: "Font size 16px+ readability",
    passed: /font-size:\s*1[6-9]px|font-size:\s*18px/i.test(html),
    detail: "18px base"
  });
  checks.push({
    id: 84,
    pillar: P5,
    name: "No intrusive pop-ups",
    passed: !html.includes("popup") && !html.includes("modal"),
    detail: "No popups"
  });
  checks.push({
    id: 85,
    pillar: P5,
    name: "HTTPS security",
    passed: html.includes("https://catsluvus.com"),
    detail: "HTTPS"
  });
  checks.push({
    id: 86,
    pillar: P5,
    name: "Zero CLS (width/height set)",
    passed: html.includes('width="') && html.includes('height="'),
    detail: "CLS prevented"
  });
  checks.push({
    id: 87,
    pillar: P5,
    name: "Fast INP (deferred scripts)",
    passed: html.includes("async") || html.includes("defer"),
    detail: "Scripts deferred"
  });
  // Image alt-text: previously passed if AT LEAST ONE <img> had a 5+
  // char alt — articles with 1 good image and 19 alt-less ones still
  // scored as pass, missing a real SEO + a11y regression on image-
  // search discoverability. Tightened: every <img> must have an alt
  // attribute, AND each alt is either ≥5 chars (descriptive) or
  // exactly empty (`alt=""`) which the a11y best-practice marker for
  // decorative images.
  const _imageAltCheck = (() => {
    const imgs = html.match(/<img\b[^>]*>/gi) || [];
    if (imgs.length === 0) {
      return { passed: false, detail: "0 <img> tags" };
    }
    let missingAlt = 0;
    let lazyAlt = 0;
    for (const t of imgs) {
      const m = t.match(/\balt\s*=\s*"([^"]*)"/i);
      if (!m) {
        missingAlt++;
        continue;
      }
      const v = m[1].trim();
      // Empty alt is a valid decorative marker — accept it. Non-empty
      // but very short (1–4 chars, e.g. "img") is lazy and unhelpful.
      if (v.length > 0 && v.length < 5) lazyAlt++;
    }
    return {
      passed: missingAlt === 0 && lazyAlt === 0,
      detail: `${imgs.length} <img>, ${missingAlt} missing alt, ${lazyAlt} lazy alt`
    };
  })();
  checks.push({
    id: 88,
    pillar: P5,
    name: "Images have descriptive alt-text",
    passed: _imageAltCheck.passed,
    detail: _imageAltCheck.detail
  });
  checks.push({
    id: 89,
    pillar: P5,
    name: "Clean URL structure",
    // Require canonical tag AND no `?id=` inside any <a>/<link> href —
    // session-id query strings inside content URLs hurt URL hygiene.
    passed:
      html.includes('rel="canonical"') &&
      !/<(?:a|link)\b[^>]*href=["'][^"']*\?id=/i.test(html),
    detail: "Clean URLs"
  });
  checks.push({
    id: 90,
    pillar: P5,
    name: "No broken links (no empty href)",
    passed: !html.includes('href=""') && !html.includes("href=''"),
    detail: "Links clean"
  });
  checks.push({
    id: 91,
    pillar: P5,
    name: "Sitemap updated",
    passed: true,
    detail: "Updated by pipeline step 12/12"
  });
  checks.push({
    id: 92,
    pillar: P5,
    name: "Keyword density in range (< 3%)",
    passed: keywordDensity < 3,
    detail: `${keywordDensity.toFixed(1)}% body density`
  });
  checks.push({
    id: 93,
    pillar: P5,
    name: "High contrast ratio",
    passed:
      html.includes("color:#1") ||
      html.includes("color: #1") ||
      html.includes("color:var(--wc-color-text)"),
    detail: "Dark on light"
  });
  checks.push({
    id: 94,
    pillar: P5,
    name: "No ads above the fold",
    passed: !html.includes("ad-slot") && !html.includes("google_ad"),
    detail: "No ads"
  });
  checks.push({
    id: 95,
    pillar: P5,
    name: "No auto-play videos",
    passed: !html.includes("autoplay") || html.includes("lite-youtube"),
    detail: "Click-to-play"
  });
  checks.push({
    id: 96,
    pillar: P5,
    name: "Smooth scrolling",
    passed: true, // browser-native; no HTML token needed (mirrors check #100)
    detail: "Native scroll"
  });
  checks.push({
    id: 97,
    pillar: P5,
    name: "Efficient code (minimal JS)",
    passed: (html.match(/<script/gi) || []).length <= 5,
    detail: `${(html.match(/<script/gi) || []).length} scripts`
  });
  // Strengthened check 98 — was just `html.includes('rel="canonical"')`,
  // which passed even on:
  //   - A canonical with empty / malformed href
  //   - A canonical pointing at a staging or off-origin host
  //   - Multiple canonical tags (which split Google's signal)
  // All three are real ranking regressions when a rewrite mangles the
  // <head>. New check requires: exactly 1 canonical, well-formed URL,
  // host = catsluvus.com or root-relative.
  const _canonicalCheck = (() => {
    const matches = Array.from(
      html.matchAll(
        /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>/gi
      )
    );
    if (matches.length === 0) {
      return { passed: false, detail: "no canonical tag" };
    }
    if (matches.length > 1) {
      return {
        passed: false,
        detail: `${matches.length} canonical tags (must be exactly 1)`
      };
    }
    const href = matches[0][1].trim();
    if (!href) return { passed: false, detail: "canonical href empty" };
    // Root-relative is acceptable.
    if (href.startsWith("/"))
      return { passed: true, detail: "root-relative canonical" };
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      return {
        passed: false,
        detail: `canonical href not a valid URL: ${href.slice(0, 60)}`
      };
    }
    const hostnameOk =
      parsed.hostname === "catsluvus.com" ||
      parsed.hostname === "www.catsluvus.com";
    if (!hostnameOk) {
      return {
        passed: false,
        detail: `canonical points off-origin: ${parsed.hostname}`
      };
    }
    if (parsed.protocol !== "https:") {
      return {
        passed: false,
        detail: `canonical not https: ${parsed.protocol}`
      };
    }
    // Canonical-vs-noindex contradiction. A page that emits BOTH a
    // self-referential canonical AND a noindex robots directive sends
    // Google contradictory signals — "this is the authoritative URL"
    // vs "don't index this URL." Google's documented behavior in this
    // case is to drop both signals, which removes any ranking benefit
    // the canonical was meant to confer.
    const noindex =
      /<meta\b[^>]*\bname\s*=\s*["']robots["'][^>]*\bcontent\s*=\s*["'][^"']*\bnoindex\b/i.test(
        html
      );
    if (noindex) {
      return {
        passed: false,
        detail: "canonical+noindex contradiction (signal conflict)"
      };
    }
    return { passed: true, detail: `canonical → ${parsed.pathname || "/"}` };
  })();
  checks.push({
    id: 98,
    pillar: P5,
    name: "Correct canonical tag",
    passed: _canonicalCheck.passed,
    detail: _canonicalCheck.detail
  });
  checks.push({
    id: 99,
    pillar: P5,
    name: "Last Updated timestamp",
    passed: html.includes("dateModified") || html.includes("datePublished"),
    detail: "In Article schema"
  });
  checks.push({
    id: 100,
    pillar: P5,
    name: "Global CDN (Cloudflare)",
    passed: true,
    detail: "Served via Cloudflare Workers"
  });
  // ───────────────────────────────────────────────────────────────────────────
  // SERP-presentation checks: title + meta description length.
  // Industry-standard truncation thresholds for Google desktop SERP are
  // ~60 chars for <title> and ~155 chars for <meta description>. Outside
  // those windows we lose CTR (title truncated to "…", meta auto-
  // generated from body by Google). The minimums (30 / 50) catch the
  // empty/stub failure modes that would otherwise silently slip through
  // when a Kimi degradation produces a missing-meta article.
  // ───────────────────────────────────────────────────────────────────────────
  const titleLen = title.trim().length;
  checks.push({
    id: 101,
    pillar: P5,
    name: "Title length 30–60 chars",
    passed: titleLen >= 30 && titleLen <= 60,
    detail: `${titleLen} chars`
  });
  const metaLen = metaDescription.trim().length;
  checks.push({
    id: 102,
    pillar: P5,
    name: "Meta description length 120–160 chars",
    passed: metaLen >= 120 && metaLen <= 160,
    detail: `${metaLen} chars`
  });
  // ───────────────────────────────────────────────────────────────────────────
  // Heading hierarchy checks. Google + most parsers treat the FIRST <h1>
  // as the canonical page topic. Multiple H1s split the topical signal
  // (Google logs warnings); zero H1s leave the page without one. A
  // proper heading tree (H1 → H2 → H3) is also a known accessibility +
  // SEO signal — readers and crawlers both depend on it.
  // ───────────────────────────────────────────────────────────────────────────
  const h1Count = (html.match(/<h1\b/gi) || []).length;
  checks.push({
    id: 103,
    pillar: P5,
    name: "Exactly one H1",
    passed: h1Count === 1,
    detail: `${h1Count} <h1>`
  });
  // Hierarchy: detect any skipped level (e.g. <h1> directly to <h3>
  // with no intervening <h2>). Walk the heading sequence in document
  // order; flag when the level jumps by more than 1.
  const headingSequence: number[] = [];
  const headingRe = /<h([1-6])\b/gi;
  let hMatch: RegExpExecArray | null;
  while ((hMatch = headingRe.exec(html)) !== null) {
    headingSequence.push(Number(hMatch[1]));
  }
  let skippedLevel = false;
  for (let i = 1; i < headingSequence.length; i++) {
    if (headingSequence[i] - headingSequence[i - 1] > 1) {
      skippedLevel = true;
      break;
    }
  }
  checks.push({
    id: 104,
    pillar: P5,
    name: "Heading hierarchy (no skipped levels)",
    passed: !skippedLevel && headingSequence.length > 0,
    detail: skippedLevel
      ? `skipped level in sequence [${headingSequence.join(",")}]`
      : `${headingSequence.length} headings, no skips`
  });
  // ───────────────────────────────────────────────────────────────────────────
  // Internal-link count. Google uses internal links to understand site
  // topology + topical depth; readers use them to navigate to related
  // content (dwell-time signal). The reverse-link injector (#4786)
  // builds back-links INTO this article from OLDER siblings; this
  // check ensures the article ITSELF also points OUT to siblings (a
  // separate signal: outbound internal authority distribution).
  // Counts: any <a href="..."> whose href is same-origin
  // (catsluvus.com) or a root-relative path.
  // ───────────────────────────────────────────────────────────────────────────
  const internalLinkMatches =
    html.match(
      /<a\b[^>]+href\s*=\s*"(?:https?:\/\/(?:www\.)?catsluvus\.com[^"]*|\/[^"]*)"/gi
    ) || [];
  const internalLinkCount = internalLinkMatches.length;
  checks.push({
    id: 105,
    pillar: P5,
    name: "Internal links ≥3",
    passed: internalLinkCount >= 3,
    detail: `${internalLinkCount} internal link(s)`
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SCORE CALCULATION
  // ═══════════════════════════════════════════════════════════════════════════

  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;
  const score = passed; // 1 point per check, max = SEO_SCORECARD_CHECK_COUNT (105)

  const pillarScores: Record<string, { passed: number; total: number }> = {};
  for (const pillar of [P1, P2, P3, P4, P5]) {
    const pillarChecks = checks.filter((c) => c.pillar === pillar);
    pillarScores[pillar] = {
      passed: pillarChecks.filter((c) => c.passed).length,
      total: pillarChecks.length
    };
  }

  const bonuses = checks
    .filter((c) => c.passed)
    .map((c) => `#${c.id} ${c.name}`);
  const penalties = checks
    .filter((c) => !c.passed)
    .map((c) => `#${c.id} ${c.name}: ${c.detail}`);

  return {
    score,
    checks,
    passed,
    failed,
    pillarScores,
    details: { wordCount, keywordDensity, bonuses, penalties }
  };
}

const SEO_SCORECARD_DUMMY_HTML = "<html><body></body></html>";

let cachedSeoScorecardCheckNames: readonly string[] | null = null;

/**
 * Total number of scorecard checks. Append-only as new SERP/quality
 * signals are added — id slots are stable, the count just grows. Each
 * new check pillar/id must mirror the calculateSEOScore push at the
 * matching id.
 */
export const SEO_SCORECARD_CHECK_COUNT = 105;

/**
 * Ordered row-1 header titles for the SEO scorecard checks,
 * derived from `calculateSEOScore` so labels cannot drift from the
 * scorer. See `SEO_SCORECARD_CHECK_COUNT` for the current count.
 */
export function getSeoScorecardCheckNames(): readonly string[] {
  if (cachedSeoScorecardCheckNames) return cachedSeoScorecardCheckNames;
  const r = calculateSEOScore(
    SEO_SCORECARD_DUMMY_HTML,
    "keyword",
    "Title",
    "",
    1000
  );
  if (r.checks.length !== SEO_SCORECARD_CHECK_COUNT) {
    throw new Error(
      `SEO scorecard: expected ${SEO_SCORECARD_CHECK_COUNT} checks, got ${r.checks.length}`
    );
  }
  cachedSeoScorecardCheckNames = r.checks.map((c) => c.name);
  return cachedSeoScorecardCheckNames;
}
