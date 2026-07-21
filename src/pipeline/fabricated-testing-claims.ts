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
 * This module is a deterministic, dependency-free **pre-filter**.
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
  | "self-endorsement-claim";

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
  }
];

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

/** Inline phrasing tags a flagged sentence may legally span in HTML. */
const EXCISION_INLINE_TAGS =
  "a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr";

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
export function removeFabricatedTestingSentences(
  html: string,
  findings: readonly FabricatedTestingClaimFinding[]
): { html: string; removed: number } {
  if (!html || findings.length === 0) return { html, removed: 0 };
  let out = html;
  let removed = 0;
  const inlineTagPat = `(?:<\\/?(?:${EXCISION_INLINE_TAGS})\\b[^>]{0,200}>\\s*)*`;
  for (const finding of findings.slice(0, MAX_EXCISED_SENTENCES)) {
    const words = finding.sentence
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (words.length < 4) continue; // too short to match safely
    let re: RegExp;
    try {
      re = new RegExp(words.join(`\\s*${inlineTagPat}\\s*`), "i");
    } catch {
      continue;
    }
    const m = out.match(re);
    if (!m || !m[0]) continue;
    if (m[0].length > finding.sentence.length * 3) continue;
    out = out.replace(m[0], " ");
    removed++;
  }
  return { html: out, removed };
}
