/**
 * Google Autocomplete PAA scraping.
 *
 * Uses Google's public `suggestqueries.google.com` endpoint (no key,
 * CF-friendly) to mine question-style auto-suggestions for a keyword.
 * Shared between writer.ts (step 5, PAA list building) and serp.ts
 * (fallback tier PAA supplementation) so neither has to reinvent the
 * filtering logic.
 */

import { errMsg, getGoogleSuggestStrings } from "./http-utils";
import { truncateKeywordToWords } from "./keyword-utils";

/** Per-request timeout for Google Autocomplete fetches (ms). */
const AUTOCOMPLETE_TIMEOUT_MS = 5_000;

/**
 * Maximum keyword words to embed inside a PAA question prefix query.
 * Google Autocomplete returns 0 suggestions for queries longer than ~6 words
 * from datacenter IPs (Cloudflare Workers egress).  The longest question
 * prefix used below is 3 words ("how to use"), so capping at 3 keeps the
 * assembled query at 6 words or fewer — the reliable suggestion window.
 */
const MAX_PAA_KEYWORD_WORDS = 3;

/**
 * Runs a handful of question-style prefix queries through Google
 * Autocomplete and returns up to 8 deduped, capitalised questions.
 * Individual prefix failures are tolerated, but when every prefix fails
 * `onWarn` is called (if provided) so callers can surface the outage in
 * the activity feed.  Matches the `onWarn?` callback pattern used by the
 * Amazon fetch helpers in `amazon.ts`.
 */
export async function fetchGoogleAutocompletePAA(
  keyword: string,
  onWarn?: (msg: string) => void
): Promise<string[]> {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) return [];

  // Truncate to ≤3 words so every assembled PAA query stays ≤6 words total.
  // The longest question prefix below is 3 words ("how to use"), so a 3-word
  // keyword cap keeps the full query at the 6-word threshold where Google
  // Autocomplete reliably returns suggestions from datacenter IPs.
  const paaKeyword = truncateKeywordToWords(
    normalizedKeyword,
    MAX_PAA_KEYWORD_WORDS
  );

  // Strip a leading "best"/"top" modifier so the "best … for" prefix template
  // does not double the word (e.g. "best slow feeder" → "best slow feeder for"
  // rather than the malformed "best best slow feeder for").
  const paaKeywordCore = paaKeyword.replace(/^(?:best|top)\s+/i, "");

  const questions: string[] = [];
  const seen = new Set<string>();

  // Try direct question-style queries first — more likely to yield question results
  const prefixes = [
    `how to use ${paaKeyword}`,
    `what is ${paaKeyword}`,
    `best ${paaKeywordCore} for`,
    `how do I`,
    `why do cats`,
    `can cats use`,
    "is it safe"
  ];
  let failedPrefixes = 0;
  const failureReasons: string[] = [];

  const kwLower = paaKeyword.toLowerCase();
  for (const prefix of prefixes) {
    try {
      // Use the prefix as-is when it already contains the (truncated) keyword
      // (first three entries are template literals that include it); otherwise
      // append the truncated keyword so the total query stays ≤6 words.
      const fullQuery = prefix.toLowerCase().includes(kwLower)
        ? prefix
        : `${prefix} ${paaKeyword}`;
      const query = encodeURIComponent(fullQuery);
      const resp = await fetch(
        `https://suggestqueries.google.com/complete/search?client=firefox&q=${query}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          },
          signal: AbortSignal.timeout(AUTOCOMPLETE_TIMEOUT_MS)
        }
      );
      if (!resp.ok) {
        failedPrefixes += 1;
        failureReasons.push(
          `"${prefix}" → HTTP ${resp.status} ${resp.statusText}`
        );
        continue;
      }

      const suggestions = getGoogleSuggestStrings(await resp.json());
      if (!suggestions) {
        failedPrefixes += 1;
        failureReasons.push(`"${prefix}" → malformed autocomplete payload`);
        continue;
      }
      for (const s of suggestions.slice(0, 3)) {
        const lower = s.toLowerCase();
        if (
          !seen.has(lower) &&
          (s.includes("?") ||
            lower.startsWith("what") ||
            lower.startsWith("how") ||
            lower.startsWith("why") ||
            lower.startsWith("can") ||
            lower.startsWith("is") ||
            lower.startsWith("do") ||
            lower.startsWith("will") ||
            lower.startsWith("should"))
        ) {
          seen.add(lower);
          const q = s.endsWith("?") ? s : s + "?";
          questions.push(q.charAt(0).toUpperCase() + q.slice(1));
        }
      }
    } catch (err: unknown) {
      failedPrefixes += 1;
      // Individual prefix failures are non-fatal
      failureReasons.push(`"${prefix}" → ${errMsg(err)}`);
    }
  }

  if (failedPrefixes === prefixes.length) {
    const detail =
      failureReasons.length > 0
        ? ` (${failureReasons.slice(0, 3).join("; ")})`
        : "";
    onWarn?.(
      `Autocomplete PAA: all prefix lookups failed for keyword ${JSON.stringify(normalizedKeyword)}${detail}`
    );
  }

  return questions.slice(0, 8);
}
