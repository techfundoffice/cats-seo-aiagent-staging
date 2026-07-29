/**
 * fabricated-testing-claims.ts — deterministic detector for false
 * product-testing self-endorsements in catsluvus articles.
 *
 * Motivation: catsluvus.com does not physically test products. The
 * codebase has stated this explicitly since 2026-05 (see
 * `writer.ts:stripEditorialNoteFabrication` and html-builder's
 * "How We Picked" methodology block). Despite that, articles have
 * shipped with claims like "we tested 200 litter boxes", "hands-on
 * testing in our boarding facility", "after 6 weeks of trialling
 * the wheel", and "our team evaluated each product". These are
 * **false endorsement claims** under FTC 16 CFR Part 255 — distinct
 * from the YMYL/regulatory fabrications caught by
 * `unsourced-claims.ts` (which targets benefit eligibility, FDA
 * certification, "studies show", etc.).
 *
 * This module is a deterministic, model-free **pre-filter** (its only
 * import is one other leaf helper — no network, no LLM).
 * It scans plain body text for ≥14 phrasing variants that assert
 * first-person product-testing experience, returns matched
 * sentences with a category tag, and is consumed by:
 *
 *   - `writer.ts` Step 14.7 — records a defect-finding and, if any
 *     hit, feeds the matches to the Polish Agent for rewriting
 *     before publish.
 *   - SEO scorecard check #10 (`seo-score.ts`) — a clean body is
 *     required to pass; fabricated testing language flips the check
 *     to FAIL and routes the article through the polish rewrite loop.
 *   - `live-quality-probe.ts` — scans already-published KV HTML on
 *     each tick, records a `live-false-testing-claim` finding so the
 *     autonomous Copilot loop opens a rewrite issue at the 5-in-24h
 *     threshold.
 *
 * Design choices mirror `unsourced-claims.ts` for consistency:
 *
 *   - Operates on plain body text (HTML stripped by the caller).
 *   - One finding per sentence — first matching category wins.
 *   - Capped at MAX_FINDINGS to keep Polish prompt + defect evidence
 *     compact.
 *   - Sentence-level, not phrase-level: surrounding context can
 *     legitimately use any single word ("we", "tested", "hands-on")
 *     — what's banned is the *combination* that asserts a
 *     first-person product trial.
 *
 * What is NOT flagged (intentional negatives, exercised in tests):
 *
 *   - "Amelia cared for thousands of cats" — cat-care credential.
 *   - "We recommend models with at least X" — editorial guidance,
 *     not a testing claim.
 *   - "Customers who tested the product reported…" — third-party
 *     review aggregate, not first-person.
 *   - "Hands-on cat-care experience" — boarding-facility credential,
 *     no product-testing implication.
 */

import { neutralizeTestingHeadings } from "./testing-vocab-swap";

export type FabricatedTestingClaimCategory =
  /** First-person verb claiming product testing/trial. */
  | "first-person-test"
  /** "Hands-on"/"field-tested"/"real-world" framing applied to a product. */
  | "hands-on-framing"
  /** Implicit time-on-product: "after N hours/weeks with the X". */
  | "time-on-product"
  /** Numeric quantifier framing: "tested N times/products/units". */
  | "quantified-trial"
  /** Facility / resident-cat trial framing. */
  | "facility-trial"
  /**
   * Personal-endorsement / "stands behind" claims. Added 2026-06 after a
   * live-corpus audit found Editorial-Agent-rewritten article bios
   * containing strings like "Amelia personally reviews and stands
   * behind every product recommendation" and "Every review combines
   * hands-on facility testing with AI-assisted research". These are
   * FTC 16 CFR Part 255 false-endorsement claims even when they don't
   * use the "we tested" verb form.
   */
  | "self-endorsement-claim"
  /**
   * Claimed OBSERVATION of product performance. Added 2026-07-27 after
   * this shipped live in a "Why You Should Trust Us" block:
   *
   *   "Our team observes daily how different tools perform across
   *    diverse cat breeds and coat types in real boarding environments."
   *
   * No testing verb appears, so every existing pattern missed it — yet
   * it asserts exactly the hands-on product experience Cats Luv Us does
   * not have. Observing CATS is legitimate and must keep passing; only
   * claims about watching PRODUCTS perform are fabricated, so these
   * patterns all require a product noun or a performance verb.
   */
  | "observed-performance"
  /**
   * Fabricated or misattributed EXPERT CONSULTATION. Added 2026-07-28
   * after a corpus scan found this in 98 of 458 published articles:
   *
   *   "We consulted with Dr. Sarah Chen, DVM, a veterinary behaviorist
   *    who has reviewed our facility protocols, and with Marcus Webb,
   *    our Head Animal Care Technician…"
   *
   * Cats Luv Us has no DVM on staff and commissions no expert reviews.
   * The names are hallucinated — "Sarah Chen, DVM" appeared 23 times
   * with a DIFFERENT invented specialty each time (parasitologist,
   * dental medicine, behaviorist). Worse, some are REAL, identifiable
   * professionals (Jennifer Coates DVM, Marci Koski PhD, Elizabeth
   * Bales DVM) falsely presented as having reviewed this site's work —
   * a false-endorsement exposure well beyond 16 CFR Part 255.
   *
   * Amelia Hartwell is the site's one real byline and is exempt.
   * Third-party CITATION framing ("research by", "a study by",
   * "according to") stays legal and is deliberately not matched — only
   * first-person consultation/review/staff framing is.
   */
  | "fabricated-expert";

export interface FabricatedTestingClaimFinding {
  /** Which framing category the trigger fell into. */
  category: FabricatedTestingClaimCategory;
  /** The matched trigger substring (lowercased) — the smoking gun. */
  trigger: string;
  /** The full sentence containing the claim, whitespace-collapsed and trimmed. */
  sentence: string;
}

/** Maximum findings returned. Mirrors `unsourced-claims.ts`. */
const MAX_FINDINGS = 20;

/** Shortest sentence length (chars) we bother inspecting. */
const MIN_SENTENCE_LEN = 20;

/**
 * Fewest words an excision match may consist of. Short matches risk
 * deleting unrelated prose that happens to share a common phrase.
 */
const MIN_EXCISION_WORDS = 6;

/** Detect-and-excise rounds before giving up. */
const MAX_EXCISION_PASSES = 4;

/**
 * Per-category trigger patterns. A sentence matching ANY pattern in
 * a category is a candidate; the first category with a match wins
 * (one finding per sentence). Patterns anchor on tokens that are
 * almost always fabricated in a non-testing pet-product context.
 *
 * The full union of these patterns is also exported as
 * `TESTING_CLAIM_RE` for callers (SEO check #10) that just need a
 * yes/no on the entire body.
 */
const TRIGGERS: Array<{
  category: FabricatedTestingClaimCategory;
  pattern: RegExp;
}> = [
  // ── first-person-test ───────────────────────────────────────────────
  {
    category: "first-person-test",
    pattern:
      /\bwe\s+(?:tested|tried|trialled|trialed|evaluated|reviewed|compared|assessed|measured|benchmarked)\b/i
  },
  {
    category: "first-person-test",
    pattern:
      /\bour\s+team\s+(?:tested|tried|evaluated|trialled|trialed|reviewed|assessed)\b/i
  },
  {
    category: "first-person-test",
    pattern: /\bproducts?\s+we['’]?ve?\s+tested\b/i
  },
  // "Based on our testing…" / "Our testing showed…" / "After our
  // testing…" — first-person gerund form, frequently emitted by Kimi
  // inside JSON-LD FAQ answers where the wc-methodology proximity
  // exception does not apply. Added 2026-06-05 after a live audit
  // found the phrase 3× in the FAQ schema of
  // `best-cat-play-tunnels-for-senior-cats-comparison` despite
  // every other gate marking the article clean.
  {
    category: "first-person-test",
    pattern: /\bour\s+testing\b/i
  },
  // ── hands-on-framing ────────────────────────────────────────────────
  // Note: the `(?:\w+\s+){0,3}` adjective slot lets the pattern catch
  // "hands-on facility testing", "hands-on cat-care testing", "hands-on
  // product evaluation" etc. — variants found live on catsluvus.com
  // after the 2026-06 audit, which the original strict
  // `hands-on testing` regex missed.
  {
    category: "hands-on-framing",
    pattern:
      /\bhands[-\s]?on\s+(?:\w+\s+){0,3}(?:testing|evaluation|review|trial|tested|reviewed|evaluated)\b/i
  },
  { category: "hands-on-framing", pattern: /\bfield[-\s]?tested\b/i },
  // Adjective-tested compounds that imply first-party endorsement
  // ("top-tested picks", "expert-tested guide", "lab-tested"). NOT
  // included: customer-tested / user-tested / consumer-tested /
  // reader-tested — those plausibly reference third-party testimonial
  // signal and would false-positive on legitimate "customer-tested
  // feedback" cat-review prose. Added 2026-06-05 after a live audit
  // found "5 top-tested picks" in the meta description of
  // `best-cat-play-tunnels-for-senior-cats-comparison`.
  {
    category: "hands-on-framing",
    pattern: /\b(?:top|expert|pro|professionally|lab|editor)[-\s]?tested\b/i
  },
  {
    category: "hands-on-framing",
    pattern: /\breal[-\s]?world\s+(?:test|testing|trial)\b/i
  },
  {
    category: "hands-on-framing",
    pattern:
      /\bputting\s+(?:it|them|this|these|each\s+\w+|every\s+\w+|the\s+product)\s+through\s+(?:its|their)\s+paces\b/i
  },
  {
    category: "hands-on-framing",
    pattern: /\bevery\s+review\s+combines\b/i
  },
  // ── time-on-product ─────────────────────────────────────────────────
  {
    category: "time-on-product",
    pattern:
      /\bafter\s+\d+\s+(?:hours?|days?|weeks?|months?)\s+(?:of\s+)?(?:testing|use|trial|trialling|trialing)\b/i
  },
  {
    category: "time-on-product",
    pattern:
      /\bspent\s+\d+\s+(?:hours?|days?|weeks?|months?)\s+(?:with|testing|trialling|trialing|evaluating)\b/i
  },
  // ── quantified-trial ────────────────────────────────────────────────
  {
    category: "quantified-trial",
    pattern: /\btested\s+(?:over\s+)?\d+\s+(?:times|products|units|models)\b/i
  },
  {
    category: "quantified-trial",
    pattern: /\btested\s+hundreds\s+of\s+products\b/i
  },
  // ── facility-trial ──────────────────────────────────────────────────
  // Note: bare "in our facility" is a strong fabrication signal because
  // we have no product-testing facility — only a boarding facility for
  // cats. Any "in our facility" reference applied to a product is
  // fabricated.
  {
    category: "facility-trial",
    pattern:
      /\bin\s+our\s+(?:lab|testing\s+lab|product\s+testing\s+facility)\b/i
  },
  {
    category: "facility-trial",
    pattern:
      /\b(?:in|at)\s+our\s+(?:boarding\s+)?facility(?:[,.]|\s+(?:we|the)\s+(?:tested|tried|trialled|trialed|evaluated|put))/i
  },
  {
    category: "facility-trial",
    pattern:
      /\b(?:resident|boarding|facility)\s+cats\s+(?:tested|tried|trialled|trialed|trialed\s+out)\b/i
  },
  {
    category: "facility-trial",
    pattern:
      /\bcontrolled\s+(?:boarding(?:\s+facility)?|facility)\s+conditions\b/i
  },
  // ── self-endorsement-claim ──────────────────────────────────────────
  // "Amelia personally reviews and stands behind every product …"
  // and equivalents. These are the dominant live-corpus FTC violation
  // form found during the 2026-06 audit — the original "we tested" /
  // "hands-on testing" regexes did not catch them because the claim
  // uses third-person verbs and editorial-endorsement phrasing.
  {
    category: "self-endorsement-claim",
    pattern:
      /\b(?:she|he|they|amelia|our\s+team)\s+personally\s+(?:tested|tried|reviews?|reviewed|vets?|vetted|evaluates?|evaluated|verif(?:y|ies|ied)|inspects?|inspected)\b/i
  },
  {
    category: "self-endorsement-claim",
    pattern:
      /\bpersonally\s+(?:tested|tried|reviews?|reviewed|vets?|vetted|evaluates?|evaluated|verif(?:y|ies|ied)|inspects?|inspected)\s+(?:every|each|all|hundreds?|every\s+single)\b/i
  },
  {
    category: "self-endorsement-claim",
    pattern:
      /\bstands?\s+behind\s+(?:every|each|all|hundreds?\s+of|every\s+single)\s+(?:product|recommendation|pick|review|item|brand)\b/i
  },
  {
    category: "self-endorsement-claim",
    pattern:
      /\b(?:hands[-\s]?on|first[-\s]?hand)\s+(?:product\s+|cat[-\s]?care\s+)?(?:facility|boarding)\s+(?:testing|knowledge|experience)\s+(?:with|of)\b/i
  },
  // ── observed-performance ────────────────────────────────────────────
  // "Our team observes daily how different tools perform across diverse
  // cat breeds and coat types in real boarding environments." No testing
  // verb, so every pattern above missed it — but it claims sustained
  // hands-on product experience all the same.
  //
  // Both patterns require a PRODUCT noun or a performance verb, because
  // observing cats is legitimate and must keep passing: "our team
  // observes how cats behave in boarding" is true and stays.
  {
    category: "observed-performance",
    pattern:
      /\b(?:we|our\s+team|our\s+staff|our\s+groomers?)\s+(?:observe|observes|observed|watch|watches|watched|see|sees|saw|notice|notices|noticed)\s+(?:\w+\s+){0,3}how\s+(?:\w+\s+){0,3}(?:tools?|products?|brushes?|combs?|litters?|fountains?|carriers?|toys?|models?|brands?|formulas?|units?)\b/i
  },
  {
    category: "observed-performance",
    pattern:
      /\bhow\s+(?:different\s+|various\s+|these\s+|competing\s+)?(?:tools?|products?|brands?|models?|formulas?|units?)\s+(?:perform|performs|performed|hold\s+up|holds\s+up|held\s+up|fare|fares|fared|last|lasts|lasted)\b/i
  },
  // ── fabricated-expert ───────────────────────────────────────────────
  // First-person consultation / review / staff framing around a named
  // person. Citation framing ("research by Dr. X", "a study by X, DVM")
  // is intentionally NOT matched — quoting published work is honest and
  // good for E-E-A-T; claiming that person vetted us is not.
  {
    category: "fabricated-expert",
    pattern:
      // "Dr." also matches ALONE: this module splits sentences on
      // ". ", so "we consulted with Dr. Elena Voss" arrives already
      // cut into "…consulted with Dr." + "Elena Voss, …". Requiring a
      // following name would miss every honorific-prefixed case.
      /\bwe\s+(?:consulted|spoke|worked|partnered)\s+with\s+(?:Dr\.|[A-Z][a-z]+\s+[A-Z][a-z]+)/
  },
  {
    category: "fabricated-expert",
    pattern:
      /\b[A-Z][a-z]+\s+[A-Z][a-z]+,\s*(?:DVM|VMD|PhD|CVT|RVT|CCBC)\b[\s\S]{0,120}?\bwho\s+(?:reviewed|vetted|verified|evaluated|advised|consulted)\b/
  },
  {
    category: "fabricated-expert",
    pattern:
      /\b[A-Z][a-z]+\s+[A-Z][a-z]+,\s*our\s+(?:Head|Lead|Senior|Chief|Staff)\s+[A-Z]/
  },
  {
    // "informed by a 2024 consultation with Dr. Elena Vasquez, DVM" —
    // a NOUN-form consultation with no first-person verb. Shipped live
    // 2026-07-29 past every verb-anchored pattern above.
    category: "fabricated-expert",
    pattern:
      /\b(?:a|an|our|the)\s+(?:\d{4}\s+)?(?:\w+\s+)?consultation\s+with\s+(?:Dr\.?|[A-Z][a-z]+\s+[A-Z][a-z]+)/i
  },
  {
    // "Dr. Vasquez reviewed our methodology" / "…whose practice sees…"
    category: "fabricated-expert",
    pattern:
      /\bDr\.\s*[A-Z][a-z]+\s+(?:reviewed|vetted|verified|advised|evaluated|confirmed)\b/
  },
  {
    // Orphaned tail of a split "Dr. <Name>, DVM, a <specialty>…"
    category: "fabricated-expert",
    pattern: /^[A-Z][a-z]+\s+[A-Z][a-z]+,\s*(?:DVM|VMD|PhD|CVT|RVT|CCBC)\b/
  },
  {
    category: "fabricated-expert",
    pattern:
      /\b(?:reviewed|vetted|verified|approved)\s+(?:our|these|this)\s+(?:facility\s+)?(?:protocols?|assessments?|methodology|recommendations?|guides?)\b/i
  },
  {
    // "This review incorporates insights from Dr. Elena Voss, DVM…"
    // Also catches the orphaned head of that sentence after the
    // splitter cuts on the "Dr. " honorific, so excising the claim
    // does not leave "…incorporates insights from Dr." behind.
    category: "fabricated-expert",
    pattern:
      /\b(?:incorporates?|incorporated|reflects?|draws\s+on|drew\s+on|informed\s+by|based\s+on)\s+(?:the\s+)?(?:insights?|input|guidance|perspectives?|feedback|expertise)\s+(?:from|of)\s+(?:Dr\.?|[A-Z][a-z]+\s+[A-Z][a-z]+)/i
  },
  {
    // "Veterinary input was supplemented by interviews with three
    // professional pet cemetery groundskeepers…" — an unnamed-expert
    // sourcing claim. Cats Luv Us conducts no interviews.
    category: "fabricated-expert",
    pattern:
      /\b(?:veterinary|expert|professional|clinical|specialist)\s+(?:input|guidance|consultation|review)\s+(?:was|were)\s+(?:supplemented|provided|obtained|sought|incorporated)/i
  },
  {
    category: "fabricated-expert",
    pattern:
      /\b(?:we|our\s+team|our\s+editors?)\s+(?:interviewed|surveyed|polled)\s+/i
  },
  {
    // "Her perspective on how physical memorials facilitate healthy
    // grief processing informed our evaluation criteria." — an
    // anaphoric reference back to the fabricated expert. Excising only
    // the naming sentence leaves this dangling and still asserting
    // that an outside professional shaped our recommendations. Tight
    // by construction: requires the possessive lead-in AND a verb
    // binding it to our own work.
    category: "fabricated-expert",
    pattern:
      /\b(?:His|Her|Their)\s+(?:perspective|input|insights?|guidance|feedback|expertise|review|assessment)\b[\s\S]{0,200}?\b(?:informed|shaped|guided|refined|validated|underpins?|underpinned)\s+(?:our|these|this|the)\b/i
  },
  {
    // "we spoke with certified animal behaviorist Pamela Reid, PhD" —
    // the original first-person pattern required the name to follow
    // "with" immediately, so any intervening role description defeated
    // it. Allow up to four lowercase qualifier words in between; a
    // trailing capitalized name (or honorific) is still required, so
    // "we worked with the manufacturer" does not match.
    category: "fabricated-expert",
    pattern:
      /\bwe\s+(?:consulted|spoke|worked|partnered|collaborated)\s+with\s+(?:[a-z][a-z-]*\s+){0,4}(?:Dr\.|[A-Z][a-z]+\s+[A-Z][a-z]+)/
  },
  {
    // "Susan Little, a feline-exclusive veterinarian with over 25 years
    // of experience, who provided insight on…" — a REAL, identifiable
    // professional with no honorific and no credential suffix, so every
    // name-anchored pattern missed her. The specialty apposition plus an
    // attribution verb is what makes it an endorsement rather than a
    // citation.
    category: "fabricated-expert",
    pattern:
      /\b[A-Z][a-z]+\s+[A-Z][a-z]+,\s*(?:a|an)\s+(?:[a-z][a-z-]*\s+){0,4}(?:veterinarian|vet|behaviou?rist|nutritionist|technician|groomer|specialist|researcher|scientist|professor|practitioner)\b[\s\S]{0,200}?\b(?:who\s+)?(?:provided|offered|shared|contributed|explained|advised|confirmed|emphasi[sz]ed|cautioned|stressed|noted|told\s+us)\b/
  },
  {
    // Credentialed name + ANY attribution verb. The original pattern
    // listed only review verbs (reviewed/vetted/verified/evaluated/
    // advised/consulted), so "Pamela Reid, PhD, who explained that…"
    // walked straight through.
    category: "fabricated-expert",
    pattern:
      /\b[A-Z][a-z]+\s+[A-Z][a-z]+,\s*(?:DVM|VMD|PhD|CVT|RVT|CCBC|DACVB|MS|MSc)\b[\s\S]{0,160}?\bwho\s+(?:reviewed|vetted|verified|evaluated|advised|consulted|explained|noted|told|shared|confirmed|recommended|emphasi[sz]ed|cautioned|stressed|provided|offered|suggested|warned|described)\b/
  },
  {
    // Bare attribution tail: "…who provided insight on how auditory
    // tracking aids compare…". Catches the fragment even when the
    // sentence splitter has already severed the name from the clause.
    category: "fabricated-expert",
    pattern:
      /\bwho\s+(?:provided|offered|contributed|shared)\s+(?:her|his|their|the|us\s+with\s+)?\s*(?:insight|input|guidance|commentary|expertise|perspective)\b/i
  }
];

/**
 * Section labels that exist only to introduce an expert-attribution
 * block. Once the claims under them are excised the label is an
 * orphan, so it is removed alongside them.
 */
const ORPHANED_ATTRIBUTION_LABEL_RE =
  /(?:Editorial\s+Process\s+Note|Expert\s+(?:Input|Consultation|Review)|Veterinary\s+(?:Input|Review)|Professional\s+Input)\s*:\s*/gi;

/**
 * Single-regex union of every trigger pattern. Used by SEO scorecard
 * check #10 which only needs a body-wide yes/no, and by the live
 * quality probe's fast pre-scan before paying for the
 * sentence-splitting pass.
 *
 * Source strings are joined with `|`; the `i` flag is global.
 */
export const TESTING_CLAIM_RE = new RegExp(
  TRIGGERS.map((t) => t.pattern.source).join("|"),
  "i"
);

/**
 * Split plain text into sentences. Splits on sentence-final
 * punctuation followed by whitespace. Abbreviation-naive on purpose
 * — over-splitting only shrinks the citation-proximity window, never
 * produces a false positive.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN);
}

/**
 * Scan plain body text for fabricated testing-claim sentences.
 *
 * Returns at most {@link MAX_FINDINGS} findings, deduped by
 * sentence. A sentence is flagged when it matches any trigger
 * pattern. Empty array means the text is clean (or too short).
 */
export function detectFabricatedTestingClaims(
  text: string
): FabricatedTestingClaimFinding[] {
  if (!text || typeof text !== "string") return [];
  const findings: FabricatedTestingClaimFinding[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(text)) {
    // A sentence that DENIES testing is the disclosure, not the claim.
    if (NEGATED_TESTING_RE.test(sentence)) continue;
    for (const { category, pattern } of TRIGGERS) {
      const m = sentence.match(pattern);
      if (!m) continue;
      const key = sentence.toLowerCase();
      if (seen.has(key)) break;
      seen.add(key);
      findings.push({
        category,
        trigger: m[0].toLowerCase().trim(),
        sentence
      });
      break;
    }
    if (findings.length >= MAX_FINDINGS) break;
  }

  return findings;
}

/**
 * Build a compact one-line summary of findings for activity-log +
 * defect evidence (e.g. `3 fabricated testing claim(s):
 * first-person-test×2, hands-on-framing×1`).
 */
export function summarizeFabricatedTestingClaims(
  findings: readonly FabricatedTestingClaimFinding[]
): string {
  if (findings.length === 0) return "0 fabricated testing claims";
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.category] = (counts[f.category] || 0) + 1;
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${cat}×${n}`)
    .join(", ");
  return `${findings.length} fabricated testing claim(s): ${breakdown}`;
}

/**
 * FTC "proximate disclosure" exception (16 CFR Part 255).
 *
 * The `<section class="wc-methodology">` block emitted by
 * `html-builder.ts:howWeTestedHtml` opens with "We compared N
 * <keyword> products sold on Amazon" and closes with a methodology
 * disclosure paragraph ("Picks are synthesized from public product
 * data and review aggregates… Products are not physically tested by
 * Cats Luv Us…"). Per FTC guidance, a comparative claim is
 * substantiated when accompanied by a clear and conspicuous
 * disclosure in close proximity. Both elements sit in the SAME
 * `<section>` ~500 bytes apart, so the bare-text detector flagging
 * "We compared" inside this template is a false positive against the
 * standard.
 *
 * To realign the detector with the FTC standard without widening
 * the exception, `stripCompliantMethodologySections` removes
 * `<section class="wc-methodology">` blocks that ALSO contain at
 * least one of the recognized disclosure markers
 * ({@link METHODOLOGY_DISCLOSURE_MARKERS}). Other content — including
 * non-compliant `wc-methodology` blocks AND any text outside any
 * `wc-methodology` section — is untouched and flows through the
 * strict text detector unchanged.
 *
 * The exception is intentionally tight:
 *   - ONLY the literal class `wc-methodology` is recognized (not a
 *     "page contains disclosure somewhere" check).
 *   - The disclosure marker must be inside the same `<section>` tag
 *     pair as the comparison claim. A disclosure elsewhere on the
 *     page does NOT cover a claim in a different section.
 *   - Both the claim and disclosure must coexist in the section. A
 *     `wc-methodology` block with no disclosure still flags.
 */
const METHODOLOGY_DISCLOSURE_MARKERS: RegExp[] = [
  /not\s+physically\s+tested/i,
  /synthesized\s+from\s+public/i,
  /review\s+aggregates/i
];

const WC_METHODOLOGY_SECTION_RE_G =
  /<section\b[^>]*\bclass="[^"]*\bwc-methodology\b[^"]*"[^>]*>[\s\S]*?<\/section\s*>/gi;

const WC_METHODOLOGY_SECTION_RE =
  /<section\b[^>]*\bclass="[^"]*\bwc-methodology\b[^"]*"[^>]*>[\s\S]*?<\/section\s*>/gi;

/**
 * Strip `<section class="wc-methodology">` blocks that carry a
 * recognised methodology disclosure. Returns the HTML with those
 * sections excised so a downstream HTML-to-text pass will not feed
 * their content to the strict text detector. HTML outside any
 * `wc-methodology` section, AND any `wc-methodology` section that
 * lacks a disclosure, is preserved verbatim.
 */
export function stripCompliantMethodologySections(html: string): string {
  if (!html || typeof html !== "string") return html;
  return html.replace(WC_METHODOLOGY_SECTION_RE, (sectionHtml) => {
    // Crude tag-strip is sufficient — we only need to scan the
    // section's visible text for disclosure markers.
    const sectionText = sectionHtml.replace(/<[^>]+>/g, " ");
    const hasDisclosure = METHODOLOGY_DISCLOSURE_MARKERS.some((re) =>
      re.test(sectionText)
    );
    return hasDisclosure ? "" : sectionHtml;
  });
}

/** Cap excisions per article — a runaway match list must not gut the page. */
const MAX_EXCISED_SENTENCES = 10;

/**
 * Deterministic backstop: remove flagged fabricated-testing sentences
 * from the HTML directly, without any model call.
 *
 * Why this exists: the LLM-based removal chain (Polish Agent T-block,
 * editorial FTC gate) is the primary fix path, but it dies whenever the
 * model layer is down — and on 2026-06-11 a live article shipped with
 * "She personally reviews and stands behind every product
 * recommendation" + "hands-on facility testing" in whyTrustUs because
 * Step 14.7 flagged them and nothing downstream could act. An FTC
 * 16 CFR Part 255 violation must never depend on model availability.
 *
 * Each finding's sentence (whitespace-collapsed plain text) is located
 * in the HTML with whitespace + inline-tag tolerance and deleted. A
 * match longer than 3x the sentence is rejected rather than risk eating
 * structure. Returns the cleaned HTML and the number removed.
 */

/**
 * Delete the TEXT of an HTML span while keeping every tag inside it.
 *
 * A flagged sentence routinely crosses element boundaries (it starts in
 * a `<strong>` and ends after `</p>`), so slicing the raw range out
 * destroys the tags in between and leaves markup like
 * `<p><strong> /p></a>` — which renders the literal text "/p>" on the
 * page. Keeping the tags means the excision can never unbalance the
 * document; the emptied wrappers are then swept by the residue pass.
 */
function removeTextKeepingTags(segment: string): string {
  let out = "";
  let i = 0;
  while (i < segment.length) {
    const lt = segment.indexOf("<", i);
    if (lt < 0) break;
    const gt = segment.indexOf(">", lt);
    if (gt < 0) break;
    out += segment.slice(lt, gt + 1);
    i = gt + 1;
  }
  return out;
}

export function removeFabricatedTestingSentences(
  html: string,
  findings: readonly FabricatedTestingClaimFinding[]
): { html: string; removed: number } {
  if (!html || findings.length === 0) return { html, removed: 0 };
  let out = html;
  let removed = 0;
  for (const finding of findings.slice(0, MAX_EXCISED_SENTENCES)) {
    const sentence = finding.sentence.replace(/\s+/g, " ").trim();
    if (sentence.split(" ").length < MIN_EXCISION_WORDS) continue;
    // Re-project after each removal: excising one span shifts every
    // later offset, so the map must be rebuilt rather than reused.
    const { text, map, syn } = collapseWithMap(
      alignedBodyText(out, { stripMethodology: false })
    );
    const idx = text.indexOf(sentence);
    if (idx < 0) continue;
    let startIdx = idx;
    let endIdx = idx + sentence.length - 1;
    // Never let the range start or end on a synthetic character — its
    // map entry points at the tag the character stands in for.
    while (endIdx > startIdx && syn[endIdx]) endIdx--;
    while (startIdx < endIdx && syn[startIdx]) startIdx++;
    if (endIdx <= startIdx) continue;
    const from = map[startIdx];
    const to = map[endIdx] + 1;
    out = `${out.slice(0, from)} ${removeTextKeepingTags(
      out.slice(from, to)
    )} ${out.slice(to)}`;
    removed++;
  }
  return { html: out, removed };
}

// ── Length-preserving HTML projection ────────────────────────────────
//
// Both detection and excision need to agree, exactly, on what the body
// text is and where each character came from. The previous approach
// rebuilt a word-by-word regex with an inline-tag group between every
// word and scanned the whole document once per candidate offset; on an
// 80 KB article that degenerated into minutes of backtracking and still
// missed matches whose text was not contiguous in the source.
//
// Instead, every transformation below replaces content with an EQUAL
// NUMBER of characters, so an index into the projected string is an
// index into the original HTML. Finding a sentence becomes an indexOf,
// and excising it becomes a slice — both linear and exact.

const spaces = (n: number): string => " ".repeat(n);

/** Replace every match with spaces, preserving length and offsets. */
function blank(html: string, re: RegExp): string {
  return html.replace(re, (m) => spaces(m.length));
}

const SCRIPT_STYLE_RE =
  /<script[^>]*>[\s\S]*?<\/script\s*>|<style[^>]*>[\s\S]*?<\/style\s*>/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const ANY_TAG_RE = /<[^>]+>/g;

/**
 * Project HTML to body text without moving any character. Block tags
 * become ". " (padded) so a heading never fuses to the paragraph below
 * it; everything else that is not text becomes spaces.
 */
function alignedBodyText(
  html: string,
  options: { stripMethodology: boolean }
): { aligned: string; synthetic: Uint8Array } {
  let out = blank(html, HTML_COMMENT_RE);
  out = blank(out, SCRIPT_STYLE_RE);
  out = blank(out, CITATION_SECTION_RE);
  if (options.stripMethodology) {
    out = blank(out, WC_METHODOLOGY_SECTION_RE_G);
  }
  // The "." a block boundary contributes is SYNTHETIC: it terminates
  // the sentence for the splitter but corresponds to no character in
  // the source. Excising a range that ends on it would cut into the
  // tag it replaced (turning `</p>` into `/p>`, which then renders as
  // literal text), so its positions are recorded and trimmed off the
  // range later.
  const synthetic = new Uint8Array(out.length);
  out = out.replace(BLOCK_BOUNDARY_RE, (m, offset: number) => {
    for (let i = 0; i < m.length; i++) synthetic[offset + i] = 1;
    return m.length >= 2 ? `. ${spaces(m.length - 2)}` : spaces(m.length);
  });
  return { aligned: blank(out, ANY_TAG_RE), synthetic };
}

/**
 * Collapse whitespace in an aligned projection, keeping a map from each
 * output character back to its index in the aligned string (and thus in
 * the original HTML).
 */
function collapseWithMap(projection: {
  aligned: string;
  synthetic: Uint8Array;
}): { text: string; map: number[]; syn: Uint8Array } {
  const { aligned, synthetic } = projection;
  const chars: string[] = [];
  const map: number[] = [];
  const syn: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < aligned.length; i++) {
    const c = aligned[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      if (chars.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      chars.push(" ");
      map.push(i);
      syn.push(synthetic[i]);
      pendingSpace = false;
    }
    chars.push(c);
    map.push(i);
    syn.push(synthetic[i]);
  }
  return { text: chars.join(""), map, syn: Uint8Array.from(syn) };
}

/**
 * Detect fabricated testing/expert claims directly from HTML, applying
 * the FTC proximity exception the same way Step 14.7 does:
 *
 *   - General categories are scanned against the body with compliant
 *     `wc-methodology` sections stripped (their comparative claims are
 *     substantiated in-section, so flagging them is a false positive).
 *   - `fabricated-expert` is ALSO scanned against the FULL body. A
 *     methodology disclosure substantiates "we compared N products";
 *     it cures nothing about inventing a veterinarian, so that category
 *     gets no proximity exception.
 */

/**
 * Block-level elements whose boundaries are sentence boundaries.
 *
 * `stripHtmlToPlainText` concatenates adjacent blocks with only
 * whitespace between them, so a heading runs straight into the
 * paragraph below it and a table-of-contents entry runs into the next.
 * The splitter then produces "sentences" that exist nowhere in the
 * document — which both invents false positives (an `<h2>` fused to an
 * unrelated `<p>`) and breaks excision, because the fused string has no
 * contiguous match in the HTML. Terminating each block with a period
 * before the text pass removes that whole class of error.
 */
const BLOCK_TAGS =
  "p|div|section|article|nav|li|ul|ol|h[1-6]|td|th|tr|table|aside|header|footer|blockquote|figcaption|dd|dt|main";

// Both OPEN and CLOSE tags are boundaries. A close tag alone is not
// enough: model-mangled markup nests a `<p>` directly inside an `<a>`
// (observed in a rewritten table of contents), so the heading text runs
// into the paragraph across an OPENING tag with no close in between.
const BLOCK_BOUNDARY_RE = new RegExp(
  `<\\/?(?:${BLOCK_TAGS})\\b[^>]*>|<br\\s*\\/?>`,
  "gi"
);

/**
 * Third-party citation surfaces. The module's stated design is that
 * quoting published work is honest and good for E-E-A-T — only claiming
 * that work vetted US is a violation. The "Trusted Sources &
 * References" block is nothing but outbound citations, so an article
 * TITLE living there ("11 Best Interactive Cat Toys — Expert Tested
 * Reviews") is someone else's testing claim, not ours. Strip the block
 * before detection rather than teach every pattern to recognise it.
 */
const CITATION_SECTION_RE =
  /<(section|div|nav|aside)\b[^>]*\bclass="[^"]*\b(?:trusted-sources|citations?|references?|source-list)\b[^"]*"[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Sentences that DENY testing are the compliance language, not a
 * violation — "Cats Luv Us does not conduct hands-on product testing",
 * "Rankings reflect our editorial judgment…, not hands-on evaluation",
 * "Without hands-on testing, we cannot verify manufacturer claims".
 * Excising those would delete the very disclosures that keep the page
 * FTC-compliant, so a negated trigger suppresses the finding.
 *
 * Scoped deliberately: the negator must attach to a testing noun, so
 * "Our team's hands-on testing revealed…" (no negator) still fires, and
 * an unrelated "not" elsewhere in the sentence does not grant amnesty.
 */
const NEGATED_TESTING_RE =
  /\b(?:not|never|no|without|cannot|can['’]?t|do(?:es)?n['’]?t|do(?:es)? not|rather\s+than|instead\s+of|nor)\b[^.]{0,90}?\b(?:hands[- ]on|physically\s+tested|product\s+test\w*|controlled\s+(?:product\s+)?trials?|in[- ]house\s+test\w*|lab\s+test\w*|test(?:ing|ed|s)?|trials?|evaluation)\b/i;

export function detectFabricatedTestingClaimsInHtml(
  html: string
): FabricatedTestingClaimFinding[] {
  if (!html || typeof html !== "string") return [];
  // General categories run against the body with compliant
  // `wc-methodology` sections removed — their comparative claims are
  // substantiated in-section, so flagging them is a false positive.
  const findings = detectFabricatedTestingClaims(
    collapseWithMap(alignedBodyText(html, { stripMethodology: true })).text
  );
  // `fabricated-expert` gets no proximity exception: a disclosure that
  // products are not physically tested substantiates a comparative
  // claim, but cures nothing about inventing — or misattributing — a
  // veterinarian. Scan the full body for that category and merge.
  const fullBody = detectFabricatedTestingClaims(
    collapseWithMap(alignedBodyText(html, { stripMethodology: false })).text
  ).filter((f) => f.category === "fabricated-expert");
  for (const f of fullBody) {
    if (!findings.some((x) => x.sentence === f.sentence)) findings.push(f);
  }
  return findings;
}

/**
 * Deterministic FTC backstop for HTML that a model has rewritten.
 *
 * Step 14.7 gates the article the HTML builder produced, but four
 * later steps (17 QC, 18 Polish, 19 live-SEO, 20 SISS) hand the whole
 * document to Kimi and write the result straight back to KV. Nothing
 * re-checked those rewrites, so the gate was structurally upstream of
 * the last four chances to introduce a violation.
 *
 * Observed live 2026-07-29: `cat-memorials-funerary:custom-cat-name-
 * memorial-grave-stake-marker-review` published 44 minutes AFTER the
 * fabricated-expert detector shipped, carrying an "Editorial Process
 * Note: This review incorporates insights from Dr. Elena Voss, DVM…"
 * injected into the template's own `<p class="date-info">` element —
 * the rewrite ate the `<time>` open tag, proving a model wrote it long
 * after Step 14.7 had run and passed.
 *
 * This helper is the FTC analogue of `stripPricesFromHtml`, which
 * already runs at those same write sites: detect, neutralize testing
 * vocabulary in headings, excise the offending sentences, return the
 * cleaned HTML. Safe to call on clean HTML — it is a no-op.
 */
export function enforceNoFabricatedTestingClaims(html: string): {
  html: string;
  removed: number;
  headingsChanged: number;
  findings: FabricatedTestingClaimFinding[];
} {
  if (!html || typeof html !== "string") {
    return { html, removed: 0, headingsChanged: 0, findings: [] };
  }
  const findings = detectFabricatedTestingClaimsInHtml(html);
  if (findings.length === 0) {
    return { html, removed: 0, headingsChanged: 0, findings: [] };
  }
  let out = html;
  const headingFix = neutralizeTestingHeadings(out);
  out = headingFix.html;
  // Excising one sentence can rejoin its neighbours into a NEW sentence
  // that itself trips a trigger — two claims sharing a paragraph leave
  // the second behind on a single pass. Re-detect and repeat until the
  // document is clean or the pass budget runs out.
  const excision = removeFabricatedTestingSentences(out, findings);
  out = excision.html;
  let removed = excision.removed;
  for (let pass = 1; pass < MAX_EXCISION_PASSES && removed > 0; pass++) {
    const again = detectFabricatedTestingClaimsInHtml(out);
    if (again.length === 0) break;
    const next = removeFabricatedTestingSentences(out, again);
    if (next.removed === 0) break;
    out = next.html;
    removed += next.removed;
    for (const f of again) {
      if (!findings.some((x) => x.sentence === f.sentence)) findings.push(f);
    }
  }
  if (removed > 0) {
    // Tidy what the sentence-level excision leaves behind: the label
    // that introduced the removed block, empty inline wrappers, empty
    // paragraphs, and doubled whitespace.
    out = out
      .replace(ORPHANED_ATTRIBUTION_LABEL_RE, "")
      .replace(/<(strong|em|b|i|small)>\s*<\/\1>/gi, "")
      // A paragraph left holding nothing but whitespace and inline
      // wrappers — including wrappers the source never closed, which is
      // what a model-mangled block looks like after its text is gone.
      .replace(
        /<p\b[^>]*>(?:\s|<\/?(?:strong|em|b|i|small|span)\b[^>]*>)*<\/p\s*>/gi,
        ""
      )
      .replace(/[ \t]{2,}/g, " ");
  }
  return {
    html: out,
    removed,
    headingsChanged: headingFix.changed,
    findings
  };
}
