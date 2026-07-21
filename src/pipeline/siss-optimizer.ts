import { runKimiWithPoll } from "./kimi-model";
import type { SEOArticleAgent } from "../server";
import { formatActivityLogModelPromptCell } from "../activityLogSheetColumns";
import { errMsg, getGoogleSuggestStrings, unescapeHtml } from "./http-utils";
import { stripHtmlToPlainText } from "./plagiarism-overlap";
import { truncateKeywordToWords } from "./keyword-utils";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Minimum SISS score before auto-remediation rewrite is triggered. */
const SISS_REMEDIATION_THRESHOLD = 78;

/**
 * Max chars of article HTML passed to the remediation rewrite.
 * Only the above-the-fold zone (first ~400 words) + conclusion are rewritten,
 * so we don't need the full doc here.
 */
const SISS_REWRITE_HTML_MAX_CHARS = 18_000;

/** Timeout for each Autocomplete fetch (ms). */
const AUTOCOMPLETE_FETCH_TIMEOUT_MS = 8_000;

/** Max sub-intents fetched from Autocomplete before scoring. */
const MAX_SUB_INTENTS = 16;

/**
 * Minimum char count for the SISS rewrite Kimi-output to be accepted.
 * Anything shorter than this is treated as a degraded model response
 * (truncation, refusal, prompt-injection short-circuit) and rejected
 * by the length-gate path.
 */
const MIN_REWRITE_RESPONSE_CHARS = 500;

/**
 * Substantivity-gate ratio: the rewrite is only accepted when its
 * character count is at least this fraction of the original article's
 * char count. 0.9 = the rewrite may shrink the article by at most 10%
 * before we reject. Lower thresholds allow Kimi to silently truncate
 * the body; higher thresholds reject legitimate trimming.
 */
const MIN_REWRITE_SUBSTANTIVITY_RATIO = 0.9;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SissOptimizerInput {
  keyword: string;
  articleHtml: string;
  articleUrl: string;
  kvKey: string;
  title: string;
  metaDescription: string;
}

export interface SissOptimizerResult {
  /** 0-based sub-intent coverage score (0–100). */
  sissScore: number;
  /** Score after remediation rewrite (same as sissScore when rewrite skipped). */
  sissScoreAfter: number;
  /** Delta: sissScoreAfter − sissScore. 0 when rewrite skipped. */
  sissDelta: number;
  /** Whether a remediation rewrite was triggered and written back to KV. */
  sissRemediated: boolean;
  /** Sub-intents extracted from Autocomplete. */
  subIntents: string[];
  /** Sub-intents covered by the article. */
  covered: string[];
  /** Sub-intents missing from the article. */
  missing: string[];
  /** Full system+user prompt for the activity-log modelPrompt column. */
  modelPromptCell: string;
  /** Whether the step was skipped (e.g. Autocomplete returned nothing). */
  skipped: boolean;
  skipReason?: string;
}

// ── Autocomplete sub-intent fetcher ───────────────────────────────────────────

/**
 * Fetches buyer sub-intents for `keyword` from the Google Autocomplete API.
 * Uses the same `suggestqueries.google.com` endpoint as the existing Step 3
 * PAA helper — no new secrets or bindings required.
 *
 * Strategy: build seed queries from a truncated (≤5 word) prefix of the
 * keyword. Google Autocomplete returns 0 suggestions for queries longer than
 * ~6 words from datacenter IPs; truncating to 5 words reliably returns
 * 6–10 buyer-intent completions per seed.
 *
 * The shorter prefix intentionally lets Google fill in the tail — those
 * suffixes are the sub-intents we score the article against.
 */
interface AutocompleteSubIntentsResult {
  subIntents: string[];
  /** Total raw suggestions returned by Google across all seeds, before on-topic filtering. */
  totalRawSuggestions: number;
  /** Number of seed queries that returned a valid (non-error) response. */
  successfulSeedFetches: number;
  /** Number of seed queries that failed (non-2xx or threw), even when some seeds succeeded. */
  failedSeedCount: number;
}

async function fetchSubIntentsFromAutocomplete(
  keyword: string
): Promise<AutocompleteSubIntentsResult> {
  const subIntents: string[] = [];
  const seen = new Set<string>();
  let successfulSeedFetches = 0;
  let totalRawSuggestions = 0;
  const seedFetchErrors: string[] = [];

  // Truncate to ≤5 words so Autocomplete actually returns suggestions.
  // Long-tail keywords (>6 words) return empty arrays from datacenter IPs.
  const prefix = truncateKeywordToWords(keyword, 5);
  if (!prefix)
    return {
      subIntents: [],
      totalRawSuggestions: 0,
      successfulSeedFetches: 0,
      failedSeedCount: 0
    };

  // Seed queries: prefix alone (broadest) + buyer-intent suffix variants.
  // The shorter variants surface different sub-intent clusters.
  // Skip any suffix that the prefix already ends with — e.g. for the keyword
  // "best slow feeder bowl for kittens" the 5-word prefix is "best slow
  // feeder bowl for", so appending "for" would produce the nonsensical query
  // "best slow feeder bowl for for" which returns 0 Autocomplete suggestions
  // and wastes one HTTP call.
  // Also skip "vs" when the prefix already contains " vs " in the middle —
  // e.g. for "cat GPS tracker vs AirTag comparison" the 5-word prefix is
  // "cat GPS tracker vs AirTag", and appending "vs" produces the semantically
  // broken query "cat GPS tracker vs AirTag vs" which Google autocompletes
  // with off-topic brand comparisons (e.g. "vs Samsung SmartTag") that would
  // then appear as missing sub-intents and incorrectly lower the SISS score
  // or trigger a remediation rewrite about topics irrelevant to the article.
  const prefixLower = prefix.toLowerCase();
  const seeds: string[] = [prefix];
  for (const suffix of ["for", "best", "review", "vs", "how to", "that"]) {
    if (
      !prefixLower.endsWith(` ${suffix}`) &&
      !(suffix === "vs" && prefixLower.includes(" vs "))
    ) {
      seeds.push(`${prefix} ${suffix}`);
    }
  }

  // For comparison keywords whose 5-word truncated prefix ends with " vs"
  // (e.g. "cat GPS smart collar vs Apple AirTag" → prefix "cat GPS smart
  // collar vs"), ALL of the seeds above have Autocomplete complete the
  // comparison side — returning suggestions like "cat GPS smart collar vs
  // Fi collar" or "cat GPS smart collar vs Tractive" rather than feature
  // sub-intents (battery life, subscription fee, range, accuracy…).
  // Adding the pre-"vs" portion as an extra seed surfaces those feature-
  // and attribute-level buyer intents, which are the ones the article must
  // cover to rank for the comparison query.
  if (prefixLower.endsWith(" vs")) {
    seeds.push(prefix.slice(0, prefix.length - 3)); // drop trailing " vs"
  }

  // Significant words from the full keyword used for on-topic filtering.
  // Words with ≤ 3 chars (e.g. "cat", "GPS", "bed") are excluded to avoid
  // matching generic stop-words.  When ALL keyword words are short (e.g.
  // "cat bed"), kwWords ends up empty and the some() check below would
  // always return false — silently discarding every suggestion.  Track
  // whether the filter produced anything so we can fall back gracefully.
  // Precompute the lowercase form once; it is also reused inside the inner
  // suggestion loop (duplicate-with-keyword guard) so we avoid calling
  // keyword.toLowerCase() on every suggestion across every seed fetch.
  const keywordLower = keyword.toLowerCase();
  const kwWords = keywordLower.split(/\s+/).filter((w) => w.length > 3);
  const hasKwFilter = kwWords.length > 0;

  for (const seed of seeds) {
    try {
      const resp = await fetch(
        `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(seed)}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          },
          signal: AbortSignal.timeout(AUTOCOMPLETE_FETCH_TIMEOUT_MS)
        }
      );

      if (!resp.ok) {
        seedFetchErrors.push(
          `"${seed}" returned HTTP ${resp.status} ${resp.statusText}`
        );
        continue;
      }
      const suggestions = getGoogleSuggestStrings(await resp.json());
      if (!suggestions) {
        seedFetchErrors.push(
          `"${seed}" returned malformed autocomplete payload`
        );
        continue;
      }
      successfulSeedFetches += 1;

      for (const s of suggestions) {
        const normalized = s.trim().toLowerCase();
        // Skip if this is identical to the base keyword (no new info)
        if (normalized === keywordLower) continue;
        // Skip exact dupes
        if (seen.has(normalized)) continue;
        // Count every non-duplicate suggestion before the topic filter so
        // callers can distinguish "Google returned nothing" from "Google
        // returned suggestions but the topic filter excluded them all".
        totalRawSuggestions += 1;
        // Must contain at least one significant word from the full keyword.
        // When kwWords is empty (all keyword words are ≤ 3 chars, e.g.
        // "cat GPS"), skip the topic filter so we still collect suggestions
        // rather than returning an empty sub-intent list.
        const isOnTopic =
          !hasKwFilter || kwWords.some((w) => normalized.includes(w));
        if (!isOnTopic) continue;

        seen.add(normalized);
        subIntents.push(s.trim());

        if (subIntents.length >= MAX_SUB_INTENTS) break;
      }
    } catch (err: unknown) {
      const message = errMsg(err);
      seedFetchErrors.push(`"${seed}" failed: ${message}`);
    }

    if (subIntents.length >= MAX_SUB_INTENTS) break;
  }

  if (
    subIntents.length === 0 &&
    successfulSeedFetches === 0 &&
    seedFetchErrors.length > 0
  ) {
    const sampledSeedErrors = seedFetchErrors.slice(0, 3).join("; ");
    throw new Error(
      `Autocomplete seed requests all failed for prefix "${prefix}" (${seedFetchErrors.length}/${seeds.length} seeds). Sample errors: ${sampledSeedErrors}`
    );
  }

  return {
    subIntents,
    totalRawSuggestions,
    successfulSeedFetches,
    failedSeedCount: seedFetchErrors.length
  };
}

// ── Coverage checker ──────────────────────────────────────────────────────────

/**
 * Checks which sub-intents are addressed in the article HTML.
 * A sub-intent is "covered" when its key differentiator terms appear
 * together in the article body (within a reasonable proximity window).
 *
 * This is intentionally a heuristic string check, not an LLM call —
 * it must be fast and deterministic.
 */
function checkSubIntentCoverage(
  articleHtml: string,
  subIntents: string[],
  keyword: string
): { covered: string[]; missing: string[] } {
  const covered: string[] = [];
  const missing: string[] = [];

  // Strip HTML tags, decode entities, and normalise whitespace for matching.
  // Uses the shared stripHtmlToPlainText helper (script/style removal + tag
  // stripping + whitespace collapse) so the logic stays in one place and
  // improvements to the shared function automatically benefit SISS scoring.
  const bodyText = unescapeHtml(stripHtmlToPlainText(articleHtml))
    .replace(/\s+/g, " ")
    .toLowerCase();

  // Autocomplete seeds were built from the ≤5-word prefix; sub-intents
  // therefore start with that prefix, not the full keyword.  Using the full
  // keyword as kwBase makes `replace(kwBase, "")` a no-op for keywords longer
  // than 5 words — the differentiator becomes the whole intent string and the
  // first 4 diffWords are base-keyword words the article always contains,
  // inflating the SISS score.  Use the same truncated prefix here so the
  // strip consistently peels off the prefix and leaves only the new content.
  const kwBase = truncateKeywordToWords(keyword, 5).toLowerCase();

  for (const intent of subIntents) {
    const intentLower = intent.toLowerCase();

    // Extract the "differentiator" — the part of the completion that extends
    // beyond the base keyword. That's what must appear in the article.
    // Use startsWith+slice (not String.replace) so only the prefix is
    // stripped — replace() would remove the first occurrence anywhere in
    // the string, producing a wrong differentiator for off-topic suggestions
    // that don't start with kwBase.
    const rawDifferentiator = intentLower.startsWith(kwBase)
      ? intentLower.slice(kwBase.length)
      : intentLower;
    const differentiator = rawDifferentiator
      .trim()
      .replace(/^(for|with|that|and|or|to|a|an|the)\s+/i, "")
      .trim();

    if (differentiator.length < 2) {
      // No meaningful differentiator — count it as covered (base keyword present)
      if (bodyText.includes(kwBase)) {
        covered.push(intent);
      } else {
        missing.push(intent);
      }
      continue;
    }

    // Split differentiator into significant words (>3 chars)
    const diffWords = differentiator
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 4);

    if (diffWords.length === 0) {
      if (bodyText.includes(differentiator)) {
        covered.push(intent);
      } else {
        missing.push(intent);
      }
      continue;
    }

    // For multi-word differentiators, require at least half the words to appear
    const matchCount = diffWords.filter((w) => bodyText.includes(w)).length;
    const coverageRatio = matchCount / diffWords.length;

    if (coverageRatio >= 0.5) {
      covered.push(intent);
    } else {
      missing.push(intent);
    }
  }

  return { covered, missing };
}

// ── SISS score calculator ─────────────────────────────────────────────────────

function computeSissScore(covered: string[], total: string[]): number {
  if (total.length === 0) return 0;
  return Math.round((covered.length / total.length) * 100);
}

// ── Remediation rewriter ──────────────────────────────────────────────────────

const SISS_REWRITE_SYSTEM = `You are an expert SEO content editor for catsluvus.com.
You receive article HTML and a list of missing buyer sub-intents — search query
completions that real users type after the main keyword, revealing exactly what
they want to find in the article.

Your task: inject targeted, concise coverage for each missing sub-intent into
the article HTML. Rules:
1. Add or expand content ONLY where sub-intents are not yet covered.
2. Work within the existing HTML structure — do NOT restructure the page.
3. For each missing sub-intent, add a short <p> or <li> block (40-80 words)
   where it fits naturally (e.g. inside the closest related <section> or FAQ).
4. If a sub-intent maps well to an FAQ question, add it as a new <div class="faq-item">.
5. Do NOT add new top-level <h2> headings for sub-intents — keep them as body copy.
6. Return the FULL modified HTML. No JSON, no markdown, no preamble.
7. Do NOT change existing content — only ADD.`;

async function runSissRemediationRewrite(
  agent: SEOArticleAgent,
  articleHtml: string,
  keyword: string,
  missingSubIntents: string[]
): Promise<{
  newHtml: string;
  modelPromptCell: string;
  rewriteSucceeded: boolean;
}> {
  const truncatedHtml =
    articleHtml.length > SISS_REWRITE_HTML_MAX_CHARS
      ? articleHtml.slice(0, SISS_REWRITE_HTML_MAX_CHARS) +
        "\n<!-- truncated -->"
      : articleHtml;

  const userPrompt =
    `Keyword: "${keyword}"\n\n` +
    `Missing buyer sub-intents (from Google Autocomplete — what real users search for):\n` +
    missingSubIntents.map((s, i) => `${i + 1}. ${s}`).join("\n") +
    `\n\nArticle HTML:\n${truncatedHtml}`;

  const modelPromptCell = formatActivityLogModelPromptCell(
    SISS_REWRITE_SYSTEM,
    userPrompt
  );

  try {
    const text = await runKimiWithPoll(
      agent.envBindings,
      {
        messages: [
          { role: "system", content: SISS_REWRITE_SYSTEM },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 8000
      },
      {},
      agent
    );

    const trimmed = text?.trim() ?? "";
    // Strip markdown code fences (e.g. ```html … ```) that the model
    // occasionally wraps the HTML response in despite the "no markdown"
    // instruction — same defensive strip used by repairJson() for JSON.
    const unfenced = trimmed
      .replace(/^```(?:[a-z]*)?\s*\n?/i, "")
      .replace(/\n?```\s*$/m, "");
    const hasHtml = unfenced.includes("<");
    const isLongEnough = unfenced.length > MIN_REWRITE_RESPONSE_CHARS;
    // XSS gate: reject the rewrite if it contains script-injection
    // patterns that NEVER legitimately appear in a generated article.
    // Event handler attributes (`on*="…"`) and `javascript:` /
    // `vbscript:` URLs are not produced by `html-builder.ts` or any
    // other template path, so any occurrence in a Kimi-rewritten body
    // is a prompt-injection signal. Bare `<script>` is NOT gated here
    // because legitimate JSON-LD blocks use `<script
    // type="application/ld+json">`.
    const handlerOrJsUrlRe =
      /(?:\bon[a-z]+\s*=|\b(?:javascript|vbscript)\s*:)/i;
    // JSON-LD regression gate: count `<script type="application/ld+json">`
    // blocks in original vs rewrite. If Kimi dropped any of them, the
    // article loses Rich Results eligibility — a silent SEO regression
    // that no other gate catches today (qc-gate.ts's `validateJsonLd`
    // accepts zero-block articles as "valid" because there are no
    // parse errors to report). Mirrors the editorial-agent's
    // document-shape-regression guard for the same reason.
    const jsonLdBlockCountRe =
      /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>/gi;
    const originalJsonLdBlocks = (articleHtml.match(jsonLdBlockCountRe) || [])
      .length;
    const rewriteJsonLdBlocks = (unfenced.match(jsonLdBlockCountRe) || [])
      .length;
    const droppedJsonLd = rewriteJsonLdBlocks < originalJsonLdBlocks;
    if (handlerOrJsUrlRe.test(unfenced)) {
      agent.log(
        "warning",
        `SISS: rewrite response rejected (XSS gate): event-handler or javascript:/vbscript: URL detected`,
        "analyst",
        { kanbanStage: "aiReview" }
      );
    } else if (droppedJsonLd) {
      agent.log(
        "warning",
        `SISS: rewrite response rejected (JSON-LD regression): rewrite has ${rewriteJsonLdBlocks} JSON-LD block(s); original had ${originalJsonLdBlocks}`,
        "analyst",
        { kanbanStage: "aiReview" }
      );
    } else if (isLongEnough && hasHtml) {
      return { newHtml: unfenced, modelPromptCell, rewriteSucceeded: true };
    }
    // Model responded but the content doesn't look like HTML (too short or no
    // tags). Log a warning so the activity feed distinguishes this from a
    // complete call failure — the caller only logs at INFO level
    // ("no substantive changes") which masks the real reason otherwise.
    agent.log(
      "warning",
      `SISS: rewrite response rejected (non-fatal): ` +
        `${isLongEnough ? "length-ok" : `too-short (<${MIN_REWRITE_RESPONSE_CHARS} chars)`}, ` +
        `${hasHtml ? "html-markup-detected" : "missing-html-markup"} ` +
        `— received ${unfenced.length} chars; returning original`,
      "analyst",
      { kanbanStage: "aiReview" }
    );
  } catch (err: unknown) {
    // Rewrite failure is non-fatal — return original HTML, but log so the
    // activity feed shows the real reason instead of "no substantive changes".
    agent.log(
      "warning",
      `SISS: rewrite call failed (non-fatal): ${errMsg(err)}`,
      "analyst",
      { kanbanStage: "aiReview", modelPrompt: modelPromptCell }
    );
  }

  return { newHtml: articleHtml, modelPromptCell, rewriteSucceeded: false };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a skipped `SissOptimizerResult` with all numeric/array fields zeroed.
 * Used by the two early-exit branches in `runSissOptimizer` so the identical
 * object shape is not duplicated in each return statement.
 */
function makeSkipResult(reason: string): SissOptimizerResult {
  return {
    sissScore: 0,
    sissScoreAfter: 0,
    sissDelta: 0,
    sissRemediated: false,
    subIntents: [],
    covered: [],
    missing: [],
    modelPromptCell: "",
    skipped: true,
    skipReason: reason
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Step 20/24 — SISS Optimizer (Search Intent Satisfaction Score)
 *
 * Uses Google Autocomplete to discover the real buyer sub-intents searchers
 * express for the keyword, then checks whether the published article covers
 * each one. Articles that miss sub-intents get a targeted remediation rewrite
 * injecting the missing coverage — without restructuring the page.
 *
 * No new API keys or secrets required: uses the same
 * `suggestqueries.google.com` endpoint already used by Step 5 PAA expansion,
 * plus Workers AI (already bound via `agent.envBindings.AI`) and
 * ARTICLES_KV for the write-back.
 */
export async function runSissOptimizer(
  agent: SEOArticleAgent,
  input: SissOptimizerInput
): Promise<SissOptimizerResult> {
  const { keyword, articleHtml, articleUrl, kvKey, title, metaDescription } =
    input;

  // ── 1. Fetch sub-intents from Google Autocomplete ─────────────────────────
  let subIntents: string[] = [];
  let totalRawSuggestions = 0;
  let successfulSeedFetches = 0;
  let failedSeedCount = 0;
  try {
    ({
      subIntents,
      totalRawSuggestions,
      successfulSeedFetches,
      failedSeedCount
    } = await fetchSubIntentsFromAutocomplete(keyword));
  } catch (err: unknown) {
    const reason = `Autocomplete fetch failed: ${errMsg(err)}`;
    agent.log("warning", `SISS: ${reason}`, "analyst", {
      kanbanStage: "aiReview"
    });
    return makeSkipResult(reason);
  }

  // Warn when some seed requests failed even though we still collected
  // sub-intents from the successful ones.  Partial failures are silent by
  // default because fetchSubIntentsFromAutocomplete only throws when ALL
  // seeds fail; surfacing them here lets operators notice intermittent
  // Autocomplete outages that may be silently reducing SISS coverage.
  if (failedSeedCount > 0 && subIntents.length > 0) {
    agent.log(
      "warning",
      `SISS: ${failedSeedCount} Autocomplete seed request(s) failed (${successfulSeedFetches} succeeded); ${subIntents.length} sub-intents collected from successful seeds — keyword: "${keyword}"`,
      "analyst",
      { kanbanStage: "aiReview" }
    );
  }

  if (subIntents.length === 0) {
    // Distinguish three root causes so operators can act on the right one:
    // • totalRawSuggestions > 0 → Google returned completions but the
    //   on-topic filter (significant words from the keyword) excluded them
    //   all.  This is a warning because it likely means the keyword has
    //   unusual brand names / compound words that the filter doesn't match.
    // • totalRawSuggestions === 0 → Google returned no suggestions at all
    //   for any seed (empty results from datacenter IP, rare keyword, etc).
    //   That's expected for niche long-tails so it stays at info.
    //   Include successfulSeedFetches in the message so operators can
    //   distinguish "Google is reachable but has no completions" from
    //   "seeds partially failed due to a network issue".
    // • failedSeedCount > 0 (in either case above) → some seeds failed
    //   alongside the zero-yield result; append the failure count so
    //   the skip reason surfaces the partial outage instead of silently
    //   attributing an empty result to normal Google behaviour.  Upgrade
    //   to "warning" even when totalRawSuggestions === 0 because the
    //   network failures may be the reason no sub-intents were collected.
    const failedSeedSuffix =
      failedSeedCount > 0
        ? `; ${failedSeedCount} seed request(s) also failed`
        : "";
    const reason =
      totalRawSuggestions > 0
        ? `Autocomplete returned ${totalRawSuggestions} suggestion(s) but all were filtered as off-topic for "${keyword}"${failedSeedSuffix}`
        : `Autocomplete returned no sub-intents for "${keyword}" (${successfulSeedFetches} seed(s) responded${failedSeedSuffix})`;
    agent.log(
      totalRawSuggestions > 0 || failedSeedCount > 0 ? "warning" : "info",
      `SISS: skipped — ${reason}`,
      "analyst",
      { kanbanStage: "aiReview" }
    );
    return makeSkipResult(reason);
  }

  // ── 2. Check article coverage of each sub-intent ──────────────────────────
  const { covered, missing } = checkSubIntentCoverage(
    articleHtml,
    subIntents,
    keyword
  );
  const sissScore = computeSissScore(covered, subIntents);

  agent.log(
    "info",
    `SISS: score ${sissScore}/100 — ${covered.length}/${subIntents.length} sub-intents covered` +
      (missing.length > 0
        ? ` | missing: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ""}`
        : ""),
    "analyst",
    { kanbanStage: "aiReview" }
  );

  // ── 3. Remediation rewrite when score is below threshold ──────────────────
  if (sissScore >= SISS_REMEDIATION_THRESHOLD || missing.length === 0) {
    // Score is good — no rewrite needed
    const modelPromptCell = formatActivityLogModelPromptCell(
      undefined,
      `SISS coverage check for keyword: "${keyword}"\n` +
        `Sub-intents (${subIntents.length}): ${subIntents.join(", ")}\n` +
        `Covered (${covered.length}): ${covered.join(", ")}\n` +
        `Score: ${sissScore}/100 — above threshold ${SISS_REMEDIATION_THRESHOLD}, no rewrite.`
    );
    return {
      sissScore,
      sissScoreAfter: sissScore,
      sissDelta: 0,
      sissRemediated: false,
      subIntents,
      covered,
      missing,
      modelPromptCell,
      skipped: false
    };
  }

  // Score below threshold — run the remediation rewrite.
  // When the article HTML is longer than SISS_REWRITE_HTML_MAX_CHARS the model
  // only sees the first SISS_REWRITE_HTML_MAX_CHARS characters (the prompt in
  // runSissRemediationRewrite slices and appends "<!-- truncated -->").  After
  // the model returns its modified excerpt we splice the unmodified tail back
  // so the KV write always contains the full article — not just the portion the
  // model saw — preventing data loss and making the standard 90 % length gate
  // work correctly even for large articles.
  agent.log(
    "info",
    `SISS: score ${sissScore} < threshold ${SISS_REMEDIATION_THRESHOLD} — rewriting ${missing.length} missing sub-intents`,
    "analyst",
    { kanbanStage: "aiReview" }
  );

  const {
    newHtml: rawNewHtml,
    modelPromptCell,
    rewriteSucceeded
  } = await runSissRemediationRewrite(agent, articleHtml, keyword, missing);

  // For truncated articles, splice the unmodified tail onto the model's output.
  // The truncation marker ("<!-- truncated -->") is stripped before the join so
  // it doesn't appear in the published article.  Only splice when the rewrite
  // actually succeeded — on model failure rawNewHtml is the full original
  // articleHtml and the splice would incorrectly append the tail a second time
  // (double-tail), causing rewriteApplied to be true on corrupted in-memory
  // content and logging a misleading "rewrite did not improve coverage" message.
  const wasTruncated = articleHtml.length > SISS_REWRITE_HTML_MAX_CHARS;
  const effectiveNewHtml =
    rewriteSucceeded && wasTruncated
      ? rawNewHtml.replace(/(?:\n)?<!-- truncated -->\s*$/, "") +
        articleHtml.slice(SISS_REWRITE_HTML_MAX_CHARS)
      : rawNewHtml;

  // Was the rewrite substantive? After splicing, effectiveNewHtml is roughly
  // the same length as articleHtml even for truncated articles, so the 90 %
  // length gate is meaningful in all cases.
  const rewriteApplied =
    effectiveNewHtml !== articleHtml &&
    effectiveNewHtml.length >
      articleHtml.length * MIN_REWRITE_SUBSTANTIVITY_RATIO;

  let sissScoreAfter = sissScore;
  let sissRemediated = false;

  if (rewriteApplied) {
    // Re-check coverage on the rewritten HTML
    const { covered: coveredAfter } = checkSubIntentCoverage(
      effectiveNewHtml,
      subIntents,
      keyword
    );
    sissScoreAfter = computeSissScore(coveredAfter, subIntents);

    // Write back to KV only if the rewrite actually improved coverage
    if (sissScoreAfter > sissScore) {
      try {
        await agent.envBindings.ARTICLES_KV.put(kvKey, effectiveNewHtml, {
          metadata: {
            title,
            keyword,
            metaDescription,
            sissRemediated: "true",
            sissScore: String(sissScoreAfter)
          }
        });
        sissRemediated = true;
        agent.log(
          "info",
          `✅ SISS: rewrite improved score ${sissScore} → ${sissScoreAfter} (+${sissScoreAfter - sissScore}) — KV updated`,
          "analyst",
          {
            kanbanStage: "done",
            articleUrl,
            modelPrompt: modelPromptCell
          }
        );
      } catch (kvErr: unknown) {
        // Rewrite was computed in-memory but failed to persist, so the live
        // article content (and effective score) remains unchanged.
        sissScoreAfter = sissScore;
        agent.log(
          "warning",
          `SISS: KV write-back failed: ${errMsg(kvErr)} — keeping score at ${sissScore}`,
          "analyst",
          { kanbanStage: "aiReview" }
        );
      }
    } else {
      agent.log(
        "info",
        `SISS: rewrite did not improve coverage (${sissScore} → ${sissScoreAfter}) — KV unchanged`,
        "analyst",
        { kanbanStage: "aiReview", modelPrompt: modelPromptCell }
      );
      sissScoreAfter = sissScore; // reset — no improvement
    }
  } else {
    agent.log(
      "info",
      `SISS: rewrite returned no substantive changes — KV unchanged`,
      "analyst",
      { kanbanStage: "aiReview", modelPrompt: modelPromptCell }
    );
  }

  return {
    sissScore,
    sissScoreAfter,
    sissDelta: sissScoreAfter - sissScore,
    sissRemediated,
    subIntents,
    covered,
    missing,
    modelPromptCell,
    skipped: false
  };
}

// Re-exports for unit-test convenience without exposing private logic.
export const __testHelpers = {
  checkSubIntentCoverage,
  computeSissScore
};
