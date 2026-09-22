/**
 * Commercial-intent keyword gate for the article factory.
 *
 * Goal: spend generation quota on buyer-intent queries that can carry
 * an Amazon CTA — not memorial spam, dog-only queries, bare brand
 * strings, or pure informational long-tails.
 *
 * Used at:
 *  - keyword generation filter (`keywords.ts`)
 *  - claim / autonomous pending pick (`server.ts`)
 *  - admin purge + commercial requeue endpoints
 */

export type CommercialGateReason =
  | "ok"
  | "empty"
  | "too-short"
  | "blocked-junk"
  | "blocked-memorial"
  | "blocked-dog-only"
  | "blocked-asin"
  | "blocked-medical"
  | "non-commercial"
  | "blocked-category";

/**
 * Synthetic queue fillers. These are not Amazon catalog titles and must
 * never be imported, claimed, or written.
 */
const JUNK_KEYWORD_RE =
  /(?:\bdashboard[\s-]*refill\b|\be2e\b|\bclaude[\s-]*only\b)/i;

/** Category slug for one letter of the Cat A–Z catalog walk (`cat-a` … `cat-z`). */
export const CAT_AZ_CATEGORY_RE = /^cat-[a-z]$/;

const QUESTION_KEYWORD_RE =
  /^(?:how|why|what|when|where|does|do|is|are|can)\b/i;

export function isJunkProductKeyword(keyword: string): boolean {
  return JUNK_KEYWORD_RE.test(keyword || "");
}

export function isCatAzCategorySlug(
  categorySlug: string | null | undefined
): boolean {
  return Boolean(categorySlug && CAT_AZ_CATEGORY_RE.test(categorySlug.trim()));
}

export interface CommercialGateResult {
  ok: boolean;
  reason: CommercialGateReason;
  /** 0–100 rough commercial score for ranking requeues. */
  score: number;
}

/** Category slugs that should not receive new articles. */
const BLOCKED_CATEGORY_RE =
  /(?:^|-)(?:memorials?|funerary|sympathy|cremation|urns?|pet-loss|rainbow-bridge)(?:-|$)/i;

/** Memorial / pet-loss product language (high volume of low-EPC pages). */
const MEMORIAL_RE =
  /\b(?:memorial|funerar(?:y|ies)|sympathy|cremation|urns?|grave(?:stone)?s?|tombstone|rainbow\s*bridge|pet\s*loss|remembrance\s*(?:gift|card|jewelry)|ashes?\s*pendant|paw\s*print\s*(?:kit|mold|ornament)|keepsake\s*(?:for\s*)?(?:loss|sympathy))\b/i;

/** Dog-only queries with no cat terms. */
const DOG_RE = /\b(?:dogs?|pupp(?:y|ies)|canine|doggy)\b/i;
const CAT_RE = /\b(?:cats?|kitten|kittens|feline|kitty)\b/i;

/** Bare Amazon ASIN as the “keyword”. */
const ASIN_RE = /\bB0[A-Z0-9]{8}\b/i;

/** Medical cure framing we already ban in prompts — hard reject. */
const MEDICAL_RE =
  /\b(?:cure|cures|treat(?:s|ing)?\s+(?:cancer|diabetes|kidney\s*disease)|prescription\s+only)\b/i;

/**
 * Buyer-intent surface. At least one must match (unless score from
 * other strong commercial tokens is enough via the same regex).
 */
const COMMERCIAL_RE =
  /\b(?:best|top\s*\d+|vs\.?|versus|review|reviews|comparison|compare|buy(?:ing)?|shop|for|under|affordable|budget|premium|worth\s+it|kit|set|bundle|feeder|fountain|litter|carrier|tree|scratcher|collar|harness|camera|laser|wand|tower|bed|mat|ramp|steps?|gate|playpen|cone|e-?collar|dental|treats?|food|wet\s+food|dry\s+food|puzzle|feeder|water\s+fountain)\b/i;

/** Strong commercial head — boost score. */
const STRONG_COMMERCIAL_RE =
  /\b(?:best|top\s*\d+|vs\.?|versus|review|reviews|comparison|compare|buy(?:ing)?)\b/i;

export function evaluateCommercialKeyword(
  keyword: string,
  categorySlug?: string | null
): CommercialGateResult {
  const k = (keyword || "").trim();
  if (!k) return { ok: false, reason: "empty", score: 0 };
  if (isJunkProductKeyword(k)) {
    return { ok: false, reason: "blocked-junk", score: 0 };
  }

  const words = k.split(/\s+/).filter(Boolean);
  if (words.length < 2) return { ok: false, reason: "too-short", score: 0 };

  if (categorySlug && BLOCKED_CATEGORY_RE.test(categorySlug)) {
    return { ok: false, reason: "blocked-category", score: 0 };
  }

  if (MEMORIAL_RE.test(k)) {
    return { ok: false, reason: "blocked-memorial", score: 0 };
  }

  if (DOG_RE.test(k) && !CAT_RE.test(k)) {
    return { ok: false, reason: "blocked-dog-only", score: 0 };
  }

  if (ASIN_RE.test(k) && words.length <= 3) {
    return { ok: false, reason: "blocked-asin", score: 0 };
  }

  if (MEDICAL_RE.test(k)) {
    return { ok: false, reason: "blocked-medical", score: 0 };
  }

  // Cat A–Z rows are real catalog titles. They often omit "best" / "review"
  // and still need to be claimable. Hard blocks above still apply.
  if (
    isCatAzCategorySlug(categorySlug) &&
    words.length >= 2 &&
    !QUESTION_KEYWORD_RE.test(k)
  ) {
    return { ok: true, reason: "ok", score: 60 };
  }

  if (!COMMERCIAL_RE.test(k)) {
    return { ok: false, reason: "non-commercial", score: 0 };
  }

  let score = 40;
  if (STRONG_COMMERCIAL_RE.test(k)) score += 30;
  if (/\bfor\b/i.test(k)) score += 10;
  if (
    /\b(?:indoor|senior|multi-?cat|kitten|overweight|anxious|arthrit)/i.test(k)
  )
    score += 10;
  if (words.length >= 3 && words.length <= 6) score += 5;
  if (words.length > 8) score -= 15;
  score = Math.max(0, Math.min(100, score));

  return { ok: true, reason: "ok", score };
}

export function isCommercialKeyword(
  keyword: string,
  categorySlug?: string | null
): boolean {
  return evaluateCommercialKeyword(keyword, categorySlug).ok;
}

/**
 * Human-readable skip reason for activity logs.
 */
export function commercialGateLogReason(result: CommercialGateResult): string {
  switch (result.reason) {
    case "ok":
      return "ok";
    case "blocked-junk":
      return "synthetic test keyword (dashboard refill, e2e, claude only)";
    case "blocked-memorial":
      return "memorial/pet-loss (low EPC policy)";
    case "blocked-dog-only":
      return "dog-only keyword without cat terms";
    case "blocked-asin":
      return "ASIN-shaped brand token";
    case "blocked-medical":
      return "medical cure framing";
    case "blocked-category":
      return "blocked category slug";
    case "non-commercial":
      return "no buyer-intent surface (best/review/vs/for/product noun)";
    case "too-short":
      return "too short";
    case "empty":
      return "empty";
    default: {
      const _exhaustive: never = result.reason;
      return _exhaustive;
    }
  }
}
