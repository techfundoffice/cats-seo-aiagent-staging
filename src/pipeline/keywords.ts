import type { SEOArticleAgent } from "../server";
import { formatActivityLogModelPromptCell } from "../activityLogSheetColumns";
import {
  errMsg,
  keywordToSlug,
  normalizeSingleLine,
  repairJson
} from "./http-utils";
import { runKimiWithPoll } from "./kimi-model";
import {
  extractEmbeddedJsonCandidates,
  MAX_JSON_PARSE_CANDIDATES
} from "../objectLike";

const KEYWORD_RESPONSE_PREVIEW_MAX_CHARS = 240;
function extractJsonArrayStrings(text: string): string[] {
  const fencedSources = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)]
    .map((match) => match[1]?.trim())
    .filter((source): source is string => Boolean(source));
  const sources = fencedSources.length > 0 ? [text, ...fencedSources] : [text];
  return [
    ...new Set(
      sources
        .flatMap((src) =>
          extractEmbeddedJsonCandidates(src, MAX_JSON_PARSE_CANDIDATES)
        )
        .filter((s) => s.startsWith("["))
    )
  ].slice(0, MAX_JSON_PARSE_CANDIDATES);
}

function describeJsonType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function formatKeywordResponsePreview(text: string): string {
  const normalized = normalizeSingleLine(text);
  if (normalized === "") return "";
  const preview =
    normalized.length <= KEYWORD_RESPONSE_PREVIEW_MAX_CHARS
      ? normalized
      : `${normalized.slice(0, KEYWORD_RESPONSE_PREVIEW_MAX_CHARS - 1)}…`;
  return ` Response preview: ${preview}`;
}

function buildKeywordPrompt(
  categoryName: string,
  targetCount: number,
  simple: boolean
): string {
  if (simple) {
    return `Return ONLY a JSON array of exactly ${targetCount} strings (no keys, no markdown).
Each string is one Amazon buyer-intent SEO keyword for the category: "${categoryName}" on catsluvus.com.
Include product type in every phrase, e.g. "best automatic feeder for senior cats", "orthopedic litter box vs standard litter box". Never return the literal example text or a placeholder with "..." — every keyword must be a complete, real phrase.
No question/intent prefixes: NO "where to buy", "how to", "what is", "is X worth", "does X work". Start with a product modifier or "best".
No words: affiliate, coupon, deal, discount, promo. No prices ($, dollars, "under $X", "under N dollars"). No medical cure claims.

["keyword 1", "keyword 2"]`;
  }
  return `Generate ${targetCount} SEO keywords for the "${categoryName}" category on catsluvus.com (a cat product Amazon affiliate site).

Optimize for **buyer intent and implied commission opportunity** (higher typical cart value and clear product matches beat vague informational queries). Think in terms of searches a shopper uses right before adding to cart on Amazon — the keyword must contain a product NOUN that can match an Amazon product title.

Patterns to mix (each keyword different intent):
- "best [product] for [use case]", "[product] review", "[product] vs [competitor]", "[modifier] [product]" (modifier = quiet, large, foldable, washable, automatic, manual, hooded, top-entry, premium, durable, lightweight, etc.), "best [product] for [cat type]" (kittens / senior / large / multi-cat)

RULES:
1. Each keyword must target a DIFFERENT buying intent.
2. Product-specific, Amazon-ready phrasing; include the product NOUN in every keyword. Amazon catalog matches against product titles, so question-form long-tails ("where to buy X", "how to choose X") return zero hits and waste a generation cycle.
3. No medical/vet treatment claims (no "cure", "treats disease", prescription framing).
4. Mix: roundup ("best X"), comparison ("X vs Y"), segment ("for kittens", "for large cats", "for multi-cat homes"), feature-led ("quiet X", "washable X", "foldable X").
5. No marketing terms: affiliate, deals, discount, coupon, promo.
6. NO PRICES anywhere in the keyword. Forbidden: "$" symbols, digits followed by "dollars"/"bucks"/"USD", phrases like "under $25" / "under 25 dollars" / "$50 budget". Use "affordable" or "budget" instead.
7. NO QUESTION/INTENT PREFIXES. The following are FORBIDDEN as keyword starts: "where to buy", "where can I", "how to", "how do I", "what is", "what's the best", "is [X] worth", "is [X] good", "does [X] work", "do [X]", "should I". Searchers using these have already decided what to buy and skip affiliate roundups; they also never match Amazon product titles. Use a product-led phrasing instead ("best [X] for [use]", "quiet automatic [X]", etc.).
8. Cap each keyword at 7 words. Long-tail question-style keywords (8+ words) almost never match Amazon product titles.

Return ONLY a JSON array: ["keyword one", "keyword two", ...]`;
}

/**
 * Non-price measurement units that may follow "under N" in a keyword.
 * When one of these immediately follows the number, the phrase is a
 * weight/size/capacity/age qualifier — NOT a price — and the keyword is allowed.
 * Examples: "under 15 pounds", "under 3 months", "under 10 lbs",
 *           "under 2 liters", "under 6 feet", "under 1 gallon"
 */
const NON_PRICE_UNITS =
  "pounds?|lbs?|kilograms?|kgs?|grams?|ounces?|oz|inches?|centimetres?|centimeters?|cms?|millimetres?|millimeters?|months?|years?|weeks?|feet|foot|ft|liters?|litres?|gallons?";

/**
 * Rejects "under N" when N is NOT followed by a weight/age/size/capacity
 * unit from NON_PRICE_UNITS. Compiled once at module load so keyword
 * filtering loops don't pay a regex-construction cost per call.
 *
 * The `\b` word boundary after `\d+` prevents backtracking: without it,
 * the regex engine can match a shorter prefix of a multi-digit number
 * (e.g. "1" from "15") and then the negative lookahead sees the remaining
 * digits ("5 pounds") which don't start with a unit — causing "under 15
 * pounds" to be falsely rejected.
 */
const UNDER_PRICE_RE = new RegExp(
  `\\bunder\\s+\\d+\\b(?!\\s*(?:${NON_PRICE_UNITS}))`,
  "i"
);

/**
 * Reject keywords containing prices. Matches the same patterns as
 * `stripPricesFromHtml` so a keyword that survives this gate can never end
 * up as a title that gets mangled by the price-stripper at publish time
 * (which produces gibberish titles like "Best Cat Slow Feeder Under" and
 * triggers false-positive Step 14 fingerprint failures).
 *
 * The "under N" pattern (UNDER_PRICE_RE) uses a negative lookahead to
 * exclude weight/age/size units (NON_PRICE_UNITS) so "under 15 pounds" and
 * "under 3 months" are allowed, while bare "under 25" (implied price, no
 * unit) is still rejected.
 */
function containsPrice(keyword: string): boolean {
  const patterns = [
    /\$\s?\d/,
    /\b\d{1,4}(?:\.\d{1,2})?\s+(?:dollars?|bucks?|usd)\b/i,
    /\bus\$?\s?\d/i,
    UNDER_PRICE_RE
  ];
  return patterns.some((re) => re.test(keyword));
}

/**
 * Reject keywords starting with question/intent prefixes. These never
 * match Amazon product titles (the catalog is title-based, not query-
 * based) and convert poorly for Amazon-affiliate roundups: searchers
 * using "where to buy X" have already decided to buy and bypass our
 * pages. Catches the upstream cause of the
 * `Amazon (Creators API): 0 products returned` warning storm.
 */
function hasQuestionPrefix(keyword: string): boolean {
  return /^\s*(?:where\s+(?:to|can\s+(?:i|you))\s+(?:buy|find|get|purchase)|how\s+(?:to|do\s+(?:i|you))\s+(?:choose|pick|use|clean|train|find|buy)|what(?:'s|\s+is)\s+(?:the\s+best|a\s+good)|is\s+(?:a|an|the\s+)?\s*\S+.*\s+(?:worth|good)\b|does\s+(?:a|an|the\s+)?\S+.*\s+work\b|do\s+\S+|should\s+i)\b/i.test(
    keyword
  );
}

/** Hard length cap — Amazon catalog rarely tolerates >7-word search queries. */
function isTooLong(keyword: string): boolean {
  return keyword.trim().split(/\s+/).length > 7;
}

/**
 * Reject keywords that are template echoes rather than real product-led
 * phrases — e.g. a model echoing the prompt's shape hint verbatim
 * ("best ...", "... vs ...") instead of filling it in. After stripping
 * tokens with no letters/digits (bare "...", punctuation), fewer than 2
 * real words remain. Such keywords slugify to a single generic token
 * ("best", "vs") that collides across categories and can never produce a
 * meaningful article — every attempt fails Step 14's content fingerprint
 * check and the pipeline retries it forever.
 */
export function isDegenerate(keyword: string): boolean {
  const realWords = keyword
    .trim()
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word));
  return realWords.length < 2;
}

/**
 * Generate and persist SEO keywords for a category using Kimi K2.5.
 *
 * Tries up to 3 attempts; the second and third attempts use a simplified
 * prompt to recover from over-verbose model responses. Every attempt calls
 * the model via `runKimiWithPoll()` (`kimi-model.ts`), which tries paid
 * Kimi on OpenRouter first and automatically falls back to Workers AI
 * (Qwen3) on failure — the same fallback already relied on by the writer,
 * editorial agent, and SISS optimizer — so an OpenRouter credit outage
 * degrades to Workers AI instead of leaving the category with no keywords
 * at all. Each attempt:
 *   1. Calls the model to produce a JSON array of buyer-intent keyword
 *      strings.
 *   2. Runs the raw array through a four-stage filter chain:
 *      - Price-bearing keywords (`$19`, "19 dollars") are dropped —
 *        they produce gibberish titles after the publish-time price-
 *        stripper runs.
 *      - Question/intent-prefix keywords ("how to …", "where to buy …")
 *        are dropped — they never match Amazon product titles.
 *      - Keywords exceeding 7 words are dropped — Amazon search returns
 *        zero results for long-tail phrases.
 *      - Degenerate/template-echo keywords ("best ...", "... vs ...")
 *        with fewer than 2 real words are dropped — these slugify to a
 *        single generic token that collides across categories and can
 *        never produce a publishable article.
 *   3. Inserts every surviving keyword with `INSERT OR IGNORE` into the
 *      `keywords` SQLite table so they are available to `generateArticle`.
 *
 * Returns the accepted keyword strings on success or an empty array when
 * all attempts fail (error is logged at `error` level so the failure is
 * visible in the activity feed; the pipeline continues and `saveCategory`
 * inserts a stub keyword so the category is not orphaned).
 */
export async function generateKeywords(
  agent: SEOArticleAgent,
  categoryName: string,
  categorySlug: string,
  targetCount: number = 10
): Promise<string[]> {
  agent.log(
    "info",
    `Generating ${targetCount} keywords for ${categoryName}...`,
    undefined,
    { categorySlug }
  );

  const maxAttempts = 3;

  const keywordSystemPrompt =
    "You are an SEO keyword researcher. Return ONLY a valid JSON array of strings.";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const simple = attempt > 0;
    const userPrompt = buildKeywordPrompt(categoryName, targetCount, simple);
    const keywordPromptCell = formatActivityLogModelPromptCell(
      keywordSystemPrompt,
      userPrompt
    );
    try {
      const text = await runKimiWithPoll(
        agent.envBindings,
        {
          messages: [
            { role: "system", content: keywordSystemPrompt },
            { role: "user", content: userPrompt }
          ],
          max_tokens: simple ? 1400 : 1200
        },
        {},
        agent
      );

      const jsonSlices = extractJsonArrayStrings(text);
      if (jsonSlices.length === 0) {
        agent.log(
          "warning",
          `Keywords: no JSON array in response (attempt ${attempt + 1}/${maxAttempts}).${formatKeywordResponsePreview(
            text
          )}`,
          undefined,
          { categorySlug, modelPrompt: keywordPromptCell }
        );
        continue;
      }

      let parsed: unknown;
      let parsedSuccessfully = false;
      let lastParseError: string | null = null;
      for (const jsonSlice of jsonSlices) {
        try {
          parsed = JSON.parse(jsonSlice);
          parsedSuccessfully = true;
          break;
        } catch {
          // Direct parse failed; try repairJson (handles trailing commas,
          // bare newlines inside strings, etc.) before moving to the next
          // candidate. Same two-pass pattern used by qc-agent.ts,
          // polish-agent.ts, text-editor-agent.ts, and intent-gap.ts.
          try {
            parsed = JSON.parse(repairJson(jsonSlice));
            parsedSuccessfully = true;
            break;
          } catch (err: unknown) {
            lastParseError = errMsg(err);
          }
        }
      }
      if (!parsedSuccessfully) {
        agent.log(
          "warning",
          `Keywords: JSON.parse failed for ${jsonSlices.length} candidate array(s) (attempt ${attempt + 1}/${maxAttempts})${
            lastParseError ? `: ${lastParseError}` : ""
          }.${formatKeywordResponsePreview(text)}`,
          undefined,
          { categorySlug, modelPrompt: keywordPromptCell }
        );
        continue;
      }

      if (!Array.isArray(parsed)) {
        agent.log(
          "warning",
          `Keywords: JSON was not an array (got ${describeJsonType(parsed)}) (attempt ${attempt + 1}/${maxAttempts})`,
          undefined,
          {
            categorySlug,
            modelPrompt: keywordPromptCell
          }
        );
        continue;
      }

      const allRawKeywords = parsed.filter(
        (k): k is string => typeof k === "string" && k.trim().length > 0
      );
      // Three filters all applied in one pass so any single rejection
      // reason gets logged with its own category for debugging:
      //   - price-bearing (gibberish titles after strip)
      //   - question/intent prefix (Amazon catalog can't match)
      //   - >7 words (Amazon catalog can't match)
      const rejectedPrice: string[] = [];
      const rejectedIntent: string[] = [];
      const rejectedTooLong: string[] = [];
      const rejectedDegenerate: string[] = [];
      const keywords: string[] = [];
      for (const k of allRawKeywords) {
        if (containsPrice(k)) {
          rejectedPrice.push(k);
        } else if (hasQuestionPrefix(k)) {
          rejectedIntent.push(k);
        } else if (isTooLong(k)) {
          rejectedTooLong.push(k);
        } else if (isDegenerate(k)) {
          rejectedDegenerate.push(k);
        } else {
          keywords.push(k);
        }
      }
      const logRejected = (label: string, list: string[]) => {
        if (list.length === 0) return;
        agent.log(
          "warning",
          `Keywords: dropped ${list.length} ${label} keyword(s) for category "${categorySlug}": ${list
            .slice(0, 3)
            .map((k) => `"${k}"`)
            .join(", ")}${list.length > 3 ? ", ..." : ""}`,
          undefined,
          { categorySlug }
        );
      };
      logRejected("price-bearing", rejectedPrice);
      logRejected("question/intent-prefix", rejectedIntent);
      logRejected("too-long (>7 words)", rejectedTooLong);
      logRejected("degenerate/template-echo", rejectedDegenerate);
      if (keywords.length === 0) {
        agent.log(
          "warning",
          `Keywords: empty array after parse for category "${categorySlug}" (attempt ${attempt + 1}/${maxAttempts})`,
          undefined,
          { categorySlug, modelPrompt: keywordPromptCell }
        );
        continue;
      }

      agent.log(
        "info",
        `Generated ${keywords.length} keywords for ${categoryName}`,
        undefined,
        { categorySlug, modelPrompt: keywordPromptCell }
      );

      for (const kw of keywords) {
        const slug = keywordToSlug(kw);
        const id = `${categorySlug}:${slug}`;
        agent.sql`INSERT OR IGNORE INTO keywords (id, category_slug, keyword, slug)
        VALUES (${id}, ${categorySlug}, ${kw}, ${slug})`;
      }

      return keywords;
    } catch (err: unknown) {
      agent.log(
        "warning",
        `Keywords attempt ${attempt + 1}/${maxAttempts} failed: ${errMsg(err)}`,
        undefined,
        { categorySlug, modelPrompt: keywordPromptCell }
      );
    }
  }

  agent.log(
    "error",
    "Keywords: all generation attempts failed — returning empty",
    undefined,
    { categorySlug }
  );
  return [];
}
