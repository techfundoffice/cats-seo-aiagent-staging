/**
 * entity-resolver.ts — deterministic keyword → entity resolution.
 *
 * The catalog keywords were derived from real Amazon product titles in
 * `scout_products`, so the mapping back to a product entity is almost
 * mechanical. That is deliberate: resolution is pure, testable, free,
 * and — unlike a model — produces stable entity IDs across runs. No
 * Kimi call, no token cost, no timeout failure mode added to a pipeline
 * that currently publishes at a 100% success rate.
 *
 * Two jobs:
 *   1. `resolveKeywordEntity` — normalize a keyword to a canonical
 *      entity key + intent, collapsing size/colour/count variants so
 *      "cat carrier soft for pets up" and "soft cat carrier for pets up"
 *      land on the SAME entity.
 *   2. `entityIdForProduct` / `entityIdForBrand` — stable IDs for the
 *      backfill seeded from `scout_products`.
 *
 * Precision over recall, always. A wrong merge silently destroys a
 * legitimate page's right to exist; a missed merge only costs us the
 * duplicate we already have today. When in doubt, DON'T merge.
 */

/** Words that carry no entity meaning and must not affect identity. */
const NOISE_WORDS = new Set([
  "review",
  "reviews",
  "best",
  "top",
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "with",
  "to",
  "in",
  "on",
  "by",
  "up",
  "our",
  "your",
  "pet",
  "pets"
]);

/**
 * Size / colour / count qualifiers. Stripping these is what collapses
 * the variant families (the 137 products dropped at catalog import).
 * Brand and model tokens are NEVER in this list — "pro" and "promax"
 * distinguish real Hartz SKUs and must survive.
 */
const VARIANT_WORDS = new Set([
  "small",
  "medium",
  "large",
  "xl",
  "xxl",
  "mini",
  "jumbo",
  "regular",
  "black",
  "white",
  "grey",
  "gray",
  "blue",
  "pink",
  "green",
  "red",
  "purple",
  "beige",
  "brown",
  "pack",
  "count",
  "ct",
  "piece",
  "pieces",
  "pcs",
  "set",
  "bundle",
  "combo",
  "variety",
  "assorted"
]);

/** Search intent, inferred from surface form. */
export type EntityIntent = "review" | "comparison" | "howto" | "buying-guide";

export interface ResolvedEntity {
  /** Stable entity id, e.g. `topic:cat-carrier-soft`. */
  entityId: string;
  /** Canonical slug (entity id minus the type prefix). */
  entitySlug: string;
  intent: EntityIntent;
  /** Tokens that survived normalization, in sorted order. */
  tokens: string[];
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** Singularize conservatively: only the unambiguous trailing "s". */
function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) {
    return word;
  }
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/** Detect intent from the raw keyword before noise words are stripped. */
export function detectIntent(keyword: string): EntityIntent {
  const k = keyword.toLowerCase();
  if (/\bvs\b|\bversus\b|\bcompar/.test(k)) return "comparison";
  if (/\bhow to\b|\bhow do\b|\bguide to\b|\btutorial\b/.test(k)) {
    return "howto";
  }
  if (/\bbest\b|\btop \d|\bbuying guide\b/.test(k)) return "buying-guide";
  return "review";
}

/**
 * Normalize a keyword to its canonical entity identity.
 *
 * Order-insensitive by construction (tokens are sorted), so word-order
 * permutations of the same product collapse together — which is exactly
 * the "cat carrier soft" / "soft cat carrier" collision found live.
 */
export function resolveKeywordEntity(
  keyword: string,
  opts: { asin?: string; categorySlug?: string } = {}
): ResolvedEntity {
  const intent = detectIntent(keyword);

  const tokens = Array.from(
    new Set(
      tokenize(keyword)
        .map(singularize)
        .filter((w) => !NOISE_WORDS.has(w) && !VARIANT_WORDS.has(w))
        // Bare numbers are pack sizes/model years — never identity.
        .filter((w) => !/^\d+$/.test(w))
    )
  ).sort();

  // A known ASIN is the strongest possible identity signal; use it
  // directly rather than inferring from the title.
  if (opts.asin) {
    return {
      entityId: entityIdForProduct(opts.asin),
      entitySlug: opts.asin.toLowerCase(),
      intent,
      tokens
    };
  }

  // Degenerate keyword (all noise) — fall back to the category so we
  // never emit an empty entity id that would collide with everything.
  if (tokens.length === 0) {
    const fallback = opts.categorySlug?.trim() || "unknown";
    return {
      entityId: `topic:${fallback}`,
      entitySlug: fallback,
      intent,
      tokens
    };
  }

  const slug = tokens.join("-");
  return { entityId: `topic:${slug}`, entitySlug: slug, intent, tokens };
}

/** Stable product entity id from an ASIN. */
export function entityIdForProduct(asin: string): string {
  return `product:${asin.trim().toUpperCase()}`;
}

/** Stable brand entity id from a brand name. */
export function entityIdForBrand(brand: string): string {
  return `brand:${brand
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

/** Stable category entity id from a category slug. */
export function entityIdForCategory(categorySlug: string): string {
  return `category:${categorySlug.trim().toLowerCase()}`;
}

/**
 * Similarity between two resolved entities, for the reporting sweep over
 * ALREADY-published articles. Not used by the claim-time guard, which
 * requires exact (entity, intent) equality — near-misses must never
 * block a publish.
 */
export function entitySimilarity(a: ResolvedEntity, b: ResolvedEntity): number {
  const sa = new Set(a.tokens);
  const sb = new Set(b.tokens);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared);
}
