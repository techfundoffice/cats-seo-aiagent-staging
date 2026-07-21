/**
 * unsourced-claims.ts — YMYL ("Your Money or Your Life") fabricated-claim
 * detector for catsluvus articles.
 *
 * Motivation: the writer (Kimi) periodically emits authoritative-sounding
 * but unsourced claims that are genuinely dangerous on a money-making
 * affiliate page — e.g. "reimbursable through Veteran-Directed Care (VDC)",
 * "TRICARE durable medical equipment pre-authorization pathway",
 * "compliance with ADA guidelines, 50,000+ wheel-cycle durability testing",
 * "veterinary motion-capture studies demonstrate 60% reduction", or
 * "ROODO maintains active partnerships with the VFW". None of these can be
 * substantiated; presenting them as fact can mislead a reader into wasting a
 * limited benefit budget and is exactly the failure mode Google's YMYL /
 * E-E-A-T systems penalise hardest.
 *
 * This module is a deterministic, dependency-free PRE-FILTER. It is NOT a
 * truth oracle — it flags sentences that (a) assert a benefit-eligibility,
 * regulatory/certification, quantified-research, or named-endorsement claim
 * AND (b) carry no nearby citation/attribution marker. The flagged sentences
 * are then fed to the Polish Agent (writer.ts Step 18) which rewrites them to
 * either attribute a real source, soften to an honest hedge, or drop the
 * specific claim — never invent a citation.
 *
 * Design notes / known limits:
 *   - Operates on plain body text (HTML stripped by the caller). A claim
 *     whose only citation is an `<a href>` link is therefore seen as
 *     uncited — a possible false positive. This is acceptable because the
 *     detector is non-blocking and the downstream action (qualify the
 *     sentence) is low-harm, while the dangerous real cases carry no
 *     citation at all.
 *   - Tuned for low false-positive rate on ordinary cat-product prose:
 *     the benefit/cert triggers (TRICARE, VDC, VR&E, ADA-compliance,
 *     N-cycle durability testing) essentially never appear in a legitimate
 *     uncited form on this site.
 */

export type UnsourcedClaimCategory =
  /** VA / TRICARE / Medicare / VDC / VR&E reimbursement or coverage eligibility. */
  | "benefit-eligibility"
  /** ADA / FDA / ISO / UL compliance, certification, or durability-cycle testing. */
  | "regulatory-cert"
  /** "studies show", "X% reduction", clinical / veterinary research assertions. */
  | "research-stat"
  /** Named partnerships or expert endorsements asserted as fact. */
  | "endorsement-partnership";

export interface UnsourcedClaimFinding {
  /** Which YMYL risk bucket the trigger fell into. */
  category: UnsourcedClaimCategory;
  /** The matched trigger substring (lowercased) — the smoking gun. */
  trigger: string;
  /** The full sentence containing the claim, whitespace-collapsed and trimmed. */
  sentence: string;
}

/** Maximum findings returned. Keeps the Polish prompt + defect evidence compact. */
const MAX_FINDINGS = 20;

/** Shortest sentence length (chars) we bother inspecting — skips headings/labels. */
const MIN_SENTENCE_LEN = 25;

/**
 * Per-category trigger patterns. A sentence matching ANY pattern in a
 * category is a candidate; the first category with a match wins (a sentence
 * is reported once). Patterns are intentionally narrow and anchored on
 * tokens that are almost always fabricated in a pet-product context.
 */
const TRIGGERS: Array<{ category: UnsourcedClaimCategory; pattern: RegExp }> = [
  // ── benefit-eligibility ─────────────────────────────────────────────
  { category: "benefit-eligibility", pattern: /\btricare\b/i },
  { category: "benefit-eligibility", pattern: /\bmedicar?e\b/i },
  { category: "benefit-eligibility", pattern: /\bmedicaid\b/i },
  {
    category: "benefit-eligibility",
    pattern: /\bveteran[-\s]directed care\b/i
  },
  { category: "benefit-eligibility", pattern: /\bVDC\b/ },
  { category: "benefit-eligibility", pattern: /\bVR&E\b/i },
  {
    category: "benefit-eligibility",
    pattern: /\bvocational rehabilitation\b/i
  },
  { category: "benefit-eligibility", pattern: /\bchapter 31\b/i },
  {
    category: "benefit-eligibility",
    pattern: /\bdurable medical equipment\b|\bDME\b/
  },
  {
    category: "benefit-eligibility",
    pattern: /\breimburs(?:able|e|ed|ement)\b/i
  },
  { category: "benefit-eligibility", pattern: /\bpre-?authoriz\w*\b/i },
  { category: "benefit-eligibility", pattern: /\b(?:FSA|HSA)[-\s]eligible\b/i },
  {
    category: "benefit-eligibility",
    pattern: /\btax[-\s](?:exempt|deductible)\b/i
  },
  // ── regulatory-cert ─────────────────────────────────────────────────
  {
    category: "regulatory-cert",
    pattern:
      /\b(?:ADA|FDA|ISO|FCC|UL|OSHA)\b[^.]{0,40}\b(?:compl\w+|approv\w+|certif\w+|listed|cleared|guidelines?)\b/i
  },
  {
    category: "regulatory-cert",
    pattern: /\b\d{1,3}(?:,\d{3})+\+?\s*(?:wheel\s+)?cycles?\b/i
  },
  {
    category: "regulatory-cert",
    pattern: /\bclinically (?:proven|tested|validated)\b/i
  },
  { category: "regulatory-cert", pattern: /\bveterinary[-\s]?grade\b/i },
  // ── research-stat ───────────────────────────────────────────────────
  {
    category: "research-stat",
    pattern:
      /\b(?:studies?|research|trials?|data)\s+(?:show|shows|showed|demonstrate\w*|indicate\w*|suggest\w*|confirm\w*|reveal\w*|prove\w*|find|found)\b/i
  },
  {
    category: "research-stat",
    pattern:
      /\bveterinary (?:studies|study|research|literature|motion-capture)\b/i
  },
  {
    category: "research-stat",
    pattern:
      /\b\d{1,3}(?:\.\d+)?\s*%\s*(?:reduction|increase|improvement|decrease|fewer|more|less|higher|lower|of)\b/i
  },
  {
    category: "research-stat",
    pattern:
      /\b(?:reduc\w+|increas\w+|cut\w*|lower\w*)\b[^.]{0,40}\bby\s+(?:approximately\s+)?\d{1,3}(?:\.\d+)?\s*%/i
  },
  // ── endorsement-partnership ─────────────────────────────────────────
  {
    category: "endorsement-partnership",
    pattern: /\bpartnership?s?\s+with\b/i
  },
  { category: "endorsement-partnership", pattern: /\bpartnered with\b/i },
  { category: "endorsement-partnership", pattern: /\bendorsed by\b/i }
];

/**
 * Citation / attribution markers. A candidate sentence that ALSO contains one
 * of these is treated as sourced and is NOT flagged. Deliberately generous —
 * a present-but-weak citation is the writer's job to strengthen, not this
 * gate's job to reject.
 */
const CITATION_MARKERS: RegExp[] = [
  /\baccording to\b/i,
  /\bas reported by\b/i,
  /\bcit(?:ed|es|ation)\b/i,
  /\bsource[:\s]/i,
  /\(source\b/i,
  /https?:\/\//i,
  /\bpublished in\b/i,
  /\bjournal of\b/i,
  /\bet al\.?\b/i,
  /\[\d+\]/, // footnote marker
  /\bper\s+(?:the\s+)?(?:[A-Z]{2,}|[A-Z][a-z]+)\b/, // "per the AVMA", "per FDA", "per Purina"
  /\bstated by\b/i,
  /\bdocumented (?:in|by)\b/i
];

/** True when the sentence carries any recognised citation/attribution marker. */
function hasCitation(sentence: string): boolean {
  return CITATION_MARKERS.some((re) => re.test(sentence));
}

/**
 * Split plain text into sentences. Splits on sentence-final punctuation
 * followed by whitespace. Abbreviation-naive on purpose — over-splitting only
 * shrinks the citation-proximity window slightly, never produces a false
 * positive on its own.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN);
}

/**
 * Scan plain body text for unsourced YMYL claims.
 *
 * Returns at most {@link MAX_FINDINGS} findings, deduped by sentence. A
 * sentence is flagged when it matches a trigger pattern AND contains no
 * citation marker. Empty array means the text is clean (or too short).
 */
export function detectUnsourcedClaims(text: string): UnsourcedClaimFinding[] {
  if (!text || typeof text !== "string") return [];
  const findings: UnsourcedClaimFinding[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(text)) {
    if (hasCitation(sentence)) continue;
    for (const { category, pattern } of TRIGGERS) {
      const m = sentence.match(pattern);
      if (!m) continue;
      // One finding per sentence — first matching category wins.
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
 * Build a compact one-line summary of findings for the activity-log + defect
 * evidence (e.g. `3 unsourced YMYL claim(s): benefit-eligibility×2,
 * research-stat×1`).
 */
export function summarizeUnsourcedClaims(
  findings: readonly UnsourcedClaimFinding[]
): string {
  if (findings.length === 0) return "0 unsourced YMYL claims";
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.category] = (counts[f.category] || 0) + 1;
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${cat}×${n}`)
    .join(", ");
  return `${findings.length} unsourced YMYL claim(s): ${breakdown}`;
}
