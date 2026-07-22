import {
  errMsg,
  escXml,
  extractFirstJsonObject,
  repairJson,
  unescapeHtml
} from "./http-utils";
import { generateText } from "ai";
import type { SEOArticleAgent } from "../server";
import { formatActivityLogModelPromptCell } from "../activityLogSheetColumns";
import { getKimiModel, getKimiProviderOptions } from "./kimi-model";
import { stripHtmlToPlainText } from "./plagiarism-overlap";
import type { SEOCheck } from "./seo-score";
import { SEO_SCORECARD_CHECK_COUNT } from "./seo-score";
import type { DesignAuditReport } from "./design-audit";
import type { UnsourcedClaimFinding } from "./unsourced-claims";
import type { FabricatedTestingClaimFinding } from "./fabricated-testing-claims";
import type { ProcessLanguageFinding } from "./content-quality";

export interface PolishResult {
  /** Whether at least one find/replace rewrite was successfully applied. */
  improved: boolean;
  /** The updated article HTML. Equals the input HTML when `improved` is false. */
  newHtml: string;
  /** Number of successful find/replace rewrites applied. 0 when `improved` is false. */
  changeCount: number;
  /** Human-readable summary from the AI model, e.g. "Fixed 3 of 8 failed checks". */
  summary: string;
  /**
   * Check IDs whose per-check column-H fix-guidance prompt was sourced from
   * `seoScorecardQcPromptCells` (step 9.55) and attached to the Polish AI
   * rewrite call as a `CUSTOM PROMPT` note. Lets the operator verify in the
   * sheet that column H is actually feeding back into the rewriter.
   */
  remediationPromptsConsumed: number[];
}

/**
 * Builds a map of SEO check id → per-check fix-guidance string from the
 * `seoScorecardQcPromptCells` array produced by
 * `generateSeoScorecardQcPromptCells` (step 9.55).
 *
 * `qcPromptCells` is a parallel array where index `i` (0-based) holds the
 * column-H prompt for check id `i + 1`, or `null` for passed checks.
 * Reading directly from the caller-supplied array avoids two layers of
 * indirection that previously broke this feature:
 *   1. Individual SEO check failures are intentionally logged at "info" level
 *      (to keep the warnings panel clean). The Workers AI enrichment pass in
 *      `enqueueSheetActivityLog` only calls `generateActivityLogErrorRemediationCell`
 *      for warning/error entries, so "info"-level SEO check entries never receive
 *      an `errorRemediationPrompt` — the old code's level filter matched nothing.
 *   2. `seoCheckQcPromptCells` is stripped from persisted activity-log entries
 *      by `compactActivityLogEntryForPersistedState` to save DO state space,
 *      so scanning `agent.state.activityLog` cannot find them.
 */
function collectRemediationPromptsFromQcCells(
  failedChecks: SEOCheck[],
  qcPromptCells: readonly (string | null)[] | null | undefined
): Map<number, string> {
  const out = new Map<number, string>();
  if (!Array.isArray(qcPromptCells) || qcPromptCells.length === 0) return out;
  for (const c of failedChecks) {
    if (c.id < 1 || c.id > qcPromptCells.length) continue;
    const prompt = qcPromptCells[c.id - 1];
    if (typeof prompt === "string" && prompt.trim() !== "") {
      out.set(c.id, prompt);
    }
  }
  return out;
}

/**
 * Heuristic gate: reject AI-emitted HTML snippets that look like XSS
 * payloads before they're spliced into the published article. The
 * polish-agent's `rw.replace` field comes straight from Kimi's JSON
 * output; prompt-injection through any upstream input (Amazon product
 * names, audit reports, FAQ questions) could in principle propagate a
 * `<script>` or `onerror=` payload all the way into here. The article
 * is then served from KV → live page → user browser, where the
 * payload runs in our origin's context.
 *
 * The patterns matched are deliberately narrow — legitimate body-text
 * rewrites contain none of these, so a true reject is information-loss
 * free; a false reject just means polish skips one of N rewrites.
 *
 * Returns true when the snippet is safe to splice into HTML.
 */
function rewriteSnippetLooksSafe(snippet: string): boolean {
  if (typeof snippet !== "string" || !snippet) return false;
  // <script> tags — anywhere, any case, with or without attributes.
  if (/<script\b/i.test(snippet)) return false;
  // Event handlers: on* = "..." inside any tag. Permissive on
  // whitespace + quote style so `onclick =` and `onMouseOver='…'`
  // both match.
  if (/\bon[a-z]+\s*=/i.test(snippet)) return false;
  // `javascript:` and `vbscript:` URLs anywhere in the snippet.
  if (/\b(?:javascript|vbscript)\s*:/i.test(snippet)) return false;
  return true;
}

/**
 * Polish Agent — fixes failed SEO checks by rewriting article HTML.
 *
 * Takes the list of failed checks from the 100-point SEO scorecard
 * and generates targeted HTML rewrites to pass as many as possible.
 */
export async function runPolishAgent(
  agent: SEOArticleAgent,
  articleHtml: string,
  keyword: string,
  failedChecks: SEOCheck[],
  designAuditReport?: DesignAuditReport,
  qcPromptCells?: readonly (string | null)[] | null,
  unsourcedClaims: readonly UnsourcedClaimFinding[] = [],
  testingClaims: readonly FabricatedTestingClaimFinding[] = [],
  processFindings: readonly ProcessLanguageFinding[] = []
): Promise<PolishResult> {
  const designContentIssues =
    designAuditReport && !designAuditReport.skipped
      ? designAuditReport.contentIssues
      : [];
  if (
    failedChecks.length === 0 &&
    designContentIssues.length === 0 &&
    unsourcedClaims.length === 0 &&
    testingClaims.length === 0 &&
    processFindings.length === 0
  ) {
    return {
      improved: false,
      newHtml: articleHtml,
      changeCount: 0,
      summary: "Perfect score — no fixes needed",
      remediationPromptsConsumed: []
    };
  }

  // Load per-check fix-guidance prompts (column H) directly from the QC cells
  // produced by generateSeoScorecardQcPromptCells at step 9.55.
  const remediationPrompts = collectRemediationPromptsFromQcCells(
    failedChecks,
    qcPromptCells
  );
  const remediationPromptsConsumed: number[] = [];

  // Build the fix prompt from actual failed checks; attach CUSTOM PROMPT where
  // a column-H remediation cell was enriched for this check.
  const checkList = failedChecks
    .slice(0, 15)
    .map((c) => {
      const custom = remediationPrompts.get(c.id);
      if (custom) {
        remediationPromptsConsumed.push(c.id);
        const trimmed = custom.slice(0, 800);
        return `  #${c.id} [${c.pillar}] ${c.name}: ${c.detail}\n    CUSTOM PROMPT (from sheet column H):\n${trimmed}`;
      }
      return `  #${c.id} [${c.pillar}] ${c.name}: ${c.detail}`;
    })
    .join("\n");

  if (remediationPromptsConsumed.length > 0) {
    agent.log(
      "info",
      `Polish Agent: consumed ${remediationPromptsConsumed.length} remediation prompts from sheet col H for checks #${remediationPromptsConsumed.join(", #")}`,
      "promptEngineer",
      { kanbanStage: "aiReview" }
    );
  } else {
    agent.log(
      "info",
      `Polish Agent: 0 remediation prompts consumed (no QC cells available) — using built-in prompt`,
      "promptEngineer",
      { kanbanStage: "aiReview" }
    );
  }

  const designIssueList = designContentIssues
    .slice(0, 6)
    .map(
      (i, idx) =>
        `  D${idx + 1} [${i.severity}/${i.category}] ${i.description} → ${i.suggestion}`
    )
    .join("\n");
  const designBlock = designIssueList
    ? `\n\nDESIGN AUDIT — content-addressable issues on the live page:\n${designIssueList}`
    : "";

  // YMYL fabricated-claim block (from detectUnsourcedClaims, writer.ts
  // Step 14.5). Each entry is a sentence asserting a benefit-eligibility,
  // regulatory/certification, quantified-research, or named-endorsement
  // claim with no citation. The model must qualify or remove each — never
  // invent a citation. Highest editorial priority: these are legal/trust
  // risks, not SEO-score nits.
  const claimList = unsourcedClaims
    .slice(0, 8)
    .map(
      (c, idx) => `  U${idx + 1} [${c.category}] "${c.sentence.slice(0, 220)}"`
    )
    .join("\n");
  const claimBlock = claimList
    ? `\n\nUNSOURCED YMYL CLAIMS — statements asserted as fact with no citation. For EACH, generate a rewrite that does ONE of: (a) attribute to a verifiable named source, (b) soften to an honest hedge ("some veterans explore…", "may qualify case-by-case", "in our facility testing we observed…"), or (c) remove the specific unverifiable assertion. NEVER fabricate a citation, statistic, program name, certification, or partnership. Use checkId "U1", "U2", … to reference these:\n${claimList}`
    : "";

  // Fabricated-testing block (from detectFabricatedTestingClaims, writer.ts
  // Step 14.7). The exact flagged sentences are quoted so the model can
  // rewrite them even when they fall outside the truncated ARTICLE TEXT
  // excerpt below — the 2026-06-11 "elevated cat bowl reviews" publish
  // shipped "systematic testing protocols developed over eight years"
  // untouched because the offending section started past the excerpt cap.
  const testingList = testingClaims
    .slice(0, 8)
    .map(
      (c, idx) => `  T${idx + 1} [${c.category}] "${c.sentence.slice(0, 220)}"`
    )
    .join("\n");
  const testingBlock = testingList
    ? `\n\nFABRICATED TESTING CLAIMS — sentences implying Cats Luv Us physically tested/trialled products (FTC false-endorsement risk, see HARD RULE 2). For EACH, generate a rewrite that removes the product-trial claim and re-attributes the basis to public product specs, customer reviews, or general cat-care experience. The "find" text must be copied from the quoted sentence. Use checkId "T1", "T2", … to reference these:\n${testingList}`
    : "";

  // Process-language block (from analyzeContentQuality, writer.ts Step
  // 14.8). Sentences and headings that expose the writing process instead
  // of serving the reader. The Polish model rewrites each around the
  // reader's problem and payoff — no new claims, no prices, no testing
  // language (HARD RULES still apply to these rewrites).
  const processList = processFindings
    .slice(0, 8)
    .map(
      (f, idx) => `  P${idx + 1} [${f.category}] "${f.snippet.slice(0, 220)}"`
    )
    .join("\n");
  const processBlock = processList
    ? `\n\nPROCESS-LANGUAGE PASSAGES — prose that exposes the writing process instead of serving the reader (self-referential "this guide/article", "at the time of writing", "we chose/picked/excluded", methodology or exclusion talk, process-note headings). For EACH, rewrite to state the fact or recommendation directly and drop the process framing — keep the useful information, cut the meta-commentary. A [meta-heading] entry is a heading: replace it with a reader-facing section title that describes the content. The "find" text must be copied from the quoted passage. Use checkId "P1", "P2", … to reference these:\n${processList}`
    : "";

  // Strip HTML to text for context
  const plainText = unescapeHtml(stripHtmlToPlainText(articleHtml)).slice(
    0,
    4000
  );

  const polishSystemPrompt = `You are an SEO content editor. You fix specific SEO check failures by rewriting parts of articles. When a failed check has a CUSTOM PROMPT attached, follow those instructions for that specific check — they come from the sheet and take priority over the generic examples. Return ONLY valid JSON, no markdown fences.`;
  const polishUserPrompt = `This article about "${keyword}" scored ${SEO_SCORECARD_CHECK_COUNT - failedChecks.length}/${SEO_SCORECARD_CHECK_COUNT} on our SEO scorecard. Fix the failed checks below by generating HTML rewrites.

FAILED CHECKS:
${checkList}${designBlock}${claimBlock}${testingBlock}${processBlock}

ARTICLE TEXT (for context):
${plainText}

For each fixable check or design issue, generate a rewrite. Examples:
- #5 "Personal anecdotes" failed → Add a brief observational note about cat behavior the team has seen during boarding (e.g. "boarding-floor staff notice cats avoid scented litter") — NEVER about product testing
- #10 "No fabricated testing claims" failed → Remove any first-person product-testing language (e.g. "we tested", "hands-on testing", "field-tested", "after N weeks of use", "in our facility we tried", "tested 200 times", "controlled boarding facility conditions"). Rewrite the sentence to attribute the basis of the claim to public product specs, customer reviews, or general cat-care experience — never claim a product trial that did not happen.
- #33 "Proper citations" failed → Add "according to [source]" references
- #62 "New perspective" failed → Add a unique angle or hot take
- #67 "Value guidance" failed → Add what features separate cheap vs premium options WITHOUT stating dollar amounts (Amazon Associates: never publish prices)
- #72 "Common myths" failed → Add a "Common Misconception" paragraph

HARD RULE 1: never add prices, price ranges, or dollar amounts anywhere in any rewrite. Amazon Associates compliance — the affiliate link shows the current price on Amazon.
HARD RULE 2: never claim Cats Luv Us physically tested, tried, evaluated, or trialled any product. This is an FTC false-endorsement risk. Cat-care credentials ("cared for thousands of cats", "boarding-floor observations") are fine; product-trial claims ("we tested", "hands-on testing", "in our facility", "field-tested", "tested N times") are forbidden.

Return ONLY this JSON:
{
  "rewrites": [
    {"checkId": 5, "find": "exact text from article (20-80 chars)", "replace": "improved text that passes the check", "reason": "Passes check #5: Personal anecdotes"}
  ],
  "summary": "Fixed N of M failed checks"
}

Rules:
- Each "find" must be an EXACT substring from the article text
- Only fix checks where you can make a meaningful content change
- Skip checks about technical HTML structure (meta tags, schema, scripts)
- Maximum 10 rewrites`;
  const polishPromptCell = formatActivityLogModelPromptCell(
    polishSystemPrompt,
    polishUserPrompt
  );

  try {
    const { text } = await generateText({
      model: getKimiModel(agent.envBindings),
      providerOptions: getKimiProviderOptions(agent.envBindings),
      system: polishSystemPrompt,
      prompt: polishUserPrompt,
      maxOutputTokens: 3000,
      abortSignal: AbortSignal.timeout(90_000)
    });

    agent.log(
      "info",
      `Polish Agent: Workers AI response (${text.length} chars)`,
      "editor",
      {
        kanbanStage: "aiReview",
        modelPrompt: polishPromptCell
      }
    );

    // Use extractFirstJsonObject so truncated AI responses (no closing `}`)
    // still reach repairJson instead of being silently dropped by the greedy
    // regex /\{[\s\S]*\}/ which requires a closing brace to match at all.
    const rawJson = extractFirstJsonObject(text);
    if (!rawJson) {
      return {
        improved: false,
        newHtml: articleHtml,
        changeCount: 0,
        summary: "Polish AI returned no JSON",
        remediationPromptsConsumed
      };
    }

    // The writer prompt uses D1/D2/D3... tokens for design-audit
    // findings, and the model sometimes copies those tokens literally
    // into the JSON as unquoted identifiers (`"checkId": D1,` instead
    // of `"checkId": "D1"`). Quote anything that looks like a
    // D-prefixed bare word in a checkId slot before parsing, so one
    // malformed token doesn't kill the whole polish pass.
    const repaired = rawJson.replace(
      /("checkId"\s*:\s*)([A-Za-z][A-Za-z0-9]*)(\s*[,}])/g,
      '$1"$2"$3'
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(repaired) as Record<string, unknown>;
    } catch {
      // Model truncated the JSON — repair and retry using the shared helper.
      try {
        parsed = JSON.parse(repairJson(repaired)) as Record<string, unknown>;
        agent.log(
          "info",
          "Polish Agent: JSON repaired successfully after parse failure",
          "editor"
        );
      } catch (repairErr: unknown) {
        throw new Error(
          `Polish Agent JSON unrecoverable: ${errMsg(repairErr)}`
        );
      }
    }
    const rewrites = Array.isArray(parsed.rewrites) ? parsed.rewrites : [];

    if (rewrites.length === 0) {
      return {
        improved: false,
        newHtml: articleHtml,
        changeCount: 0,
        summary: String(
          parsed.summary || "No content-level fixes possible for failed checks"
        ),
        remediationPromptsConsumed
      };
    }

    // Apply rewrites to the HTML.
    // Strategy:
    //   1. Try direct substring match (fast path — works when AI echo'd from HTML).
    //   2. If that fails, build a loose regex that allows optional inline HTML tags
    //      (<strong>, <em>, <a …>, etc.) between every word of rw.find — this
    //      handles the common case where the AI generated rw.find from the
    //      plain-text excerpt while the real HTML has inline tags interspersed.
    let newHtml = articleHtml;
    let applied = 0;
    for (const rw of rewrites) {
      if (
        !rw.find ||
        !rw.replace ||
        typeof rw.find !== "string" ||
        typeof rw.replace !== "string"
      )
        continue;

      // Never allow a rewrite to touch the <title> tag — that would
      // desync the title from og:title / H1, hurting CTR and rankings.
      const titleTagMatch = newHtml.match(/<title>([^<]*)<\/title>/i);
      if (
        titleTagMatch &&
        titleTagMatch[1] &&
        rw.find.includes(titleTagMatch[1].trim().slice(0, 20))
      ) {
        // Expected guard behavior, not a fault — info keeps it out of
        // the dashboard's warning rollup.
        agent.log(
          "info",
          `  Polish: skipped rewrite that would mutate <title> tag`
        );
        continue;
      }

      // XSS gate: reject rewrites whose `replace` field looks like a
      // script payload before splicing into HTML. See
      // `rewriteSnippetLooksSafe` for the matched patterns.
      if (!rewriteSnippetLooksSafe(rw.replace)) {
        agent.log(
          "warning",
          `  Polish: skipped rewrite #${rw.checkId || "?"} — replacement contains script-like content`
        );
        continue;
      }

      if (newHtml.includes(rw.find)) {
        // Fast path — exact match in HTML.
        // Use a function replacer so any `$` sequences in `rw.replace`
        // (e.g. `$&`, `$1`, `$'`, `` $` ``) are inserted as literal
        // characters rather than interpreted as String#replace special
        // patterns. Without this, an AI-emitted `"replace": "for $5 …"`
        // would have `$5` substituted with the regex's $5 group (empty)
        // and ship corrupted text. Matches the pattern used in
        // reverse-internal-link-injector.ts at the analogous site.
        const replacement = rw.replace;
        newHtml = newHtml.replace(rw.find, () => replacement);
        applied++;
        agent.log("info", `  Polish fix #${rw.checkId || "?"}: ${rw.reason}`);
      } else {
        // Fuzzy path — allow inline tags between words so plain-text excerpts
        // still match HTML with <strong>/<em>/<a> interspersed.
        try {
          const words = rw.find
            .split(/\s+/)
            .filter(Boolean)
            .map((w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
          if (words.length < 3) continue; // too short — skip to avoid false matches
          // Between each pair of adjacent words allow: optional whitespace and
          // zero-or-more INLINE tags only. Previously matched `<[^>]{1,120}>`
          // which was permissive enough to swallow block-level tags like
          // `<section class="faqs" id="faq-section">` when a rewrite's find
          // text spanned a section boundary — the replace then stripped the
          // `<section ` opener and orphaned `class="faqs" id="faq-section">`
          // as visible text on the published page.
          //
          // Restricted list = inline phrasing + line-break only. Block
          // elements (section/div/article/aside/header/footer/nav/p/h1-h6/
          // ul/ol/li/table/tr/td/th/figure/pre/blockquote) are explicitly
          // excluded so fuzzy-match replace cannot cross structural
          // boundaries.
          const INLINE_TAGS =
            "a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr";
          const inlineTagPat = `(?:<\\/?(?:${INLINE_TAGS})\\b[^>]{0,200}>\\s*)*`;
          const pattern = words.join(`\\s*${inlineTagPat}`);
          const re = new RegExp(pattern, "i");
          const fuzzyMatch = newHtml.match(re);
          if (fuzzyMatch && fuzzyMatch[0]) {
            // Safety belt: reject fuzzy matches longer than 3x the find
            // text. If the regex ate much more than intended, skip rather
            // than corrupt the HTML.
            if (fuzzyMatch[0].length > rw.find.length * 3) {
              agent.log(
                "warning",
                `  Polish fix #${rw.checkId || "?"} fuzzy match too greedy (${fuzzyMatch[0].length} vs ${rw.find.length} chars) — skipping`
              );
              continue;
            }
            // Function replacer — same `$`-pattern-literalisation
            // reason as the fast-path branch above.
            const fuzzyReplacement = rw.replace;
            newHtml = newHtml.replace(fuzzyMatch[0], () => fuzzyReplacement);
            applied++;
            agent.log(
              "info",
              `  Polish fix #${rw.checkId || "?"} (fuzzy): ${rw.reason}`
            );
          }
        } catch (patErr: unknown) {
          agent.log(
            "warning",
            `  Polish fix #${rw.checkId || "?"} fuzzy regex build failed — skipping: ${errMsg(patErr)}`
          );
        }
      }
    }

    // ── Keyword repetition final pass (deterministic) ─────────────────
    // Keep at most MAX_KW_REPS exact-phrase occurrences in visible body
    // text. We do this deterministically — no AI call needed — by
    // scanning the HTML for occurrences outside <head>, <title>,
    // <meta>, and <h2> tags (those must keep the exact keyword for SEO)
    // and replacing extras with rotating short synonyms.  This runs
    // AFTER the main polish pass.
    const MAX_KW_REPS = 5;
    // Defensive: if `keyword` is empty (caller error or upstream
    // truncation), `kwEscaped` is "" → `new RegExp("", "gi")` matches a
    // zero-width position at every character, producing hundreds of
    // spurious "matches" that get replaced with synonyms derived from
    // an empty word list. Skip the pass entirely instead of corrupting
    // the article.
    if (!keyword || !keyword.trim()) {
      return {
        improved: applied > 0,
        newHtml: applied > 0 ? newHtml : articleHtml,
        changeCount: applied,
        summary: String(parsed.summary || `${applied} checks fixed`),
        remediationPromptsConsumed
      };
    }
    const kwEscaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const kwRegex = new RegExp(kwEscaped, "gi");
    // Build a list of synonyms from the keyword words so they read
    // naturally.  Prefer the last noun phrase (e.g. "replacement top",
    // "corner protector") and fallback to "it" / "one".
    //
    // Keyword text is HTML-escaped via `escXml` before becoming a
    // synonym because it's spliced directly into article body text
    // below — if a keyword ever contained HTML special chars (`<`,
    // `>`, `&`, `"`, `'`) the unescaped form would be a stored-XSS
    // surface in the rendered page.
    //
    // For "X for Y" keywords ("refillable cat anxiety diffuser for
    // large cats") the last two words are the AUDIENCE, not the
    // product — substituting them produced "Selecting the optimal
    // large cats" in production on 2026-06-11. Derive the noun from
    // the segment before " for ".
    const kwCore = / for /i.test(keyword)
      ? keyword.split(/ for /i)[0].trim() || keyword
      : keyword;
    const kwWords = kwCore.split(/\s+/);
    const shortNoun = escXml(
      kwWords.length >= 3
        ? kwWords.slice(-2).join(" ") // last 2 words
        : kwWords[kwWords.length - 1] // last word
    );
    const synonyms = [
      shortNoun,
      "it",
      "one",
      "this option",
      "the product",
      shortNoun,
      "it",
      "one"
    ];
    // Walk the HTML manually so we can check context for each match.
    // We find all match positions first, then build the output string.
    const headEnd = newHtml.indexOf("</head>");
    // Find all match positions (start index, matched text)
    interface KwMatch {
      index: number;
      text: string;
    }
    const allMatches: KwMatch[] = [];
    let m: RegExpExecArray | null;
    const scanRe = new RegExp(kwEscaped, "gi");
    while ((m = scanRe.exec(newHtml)) !== null) {
      allMatches.push({ index: m.index, text: m[0] });
    }
    // Deterministic-template skip zones: these blocks embed the keyword
    // in fixed sentences whose grammar breaks under substitution. Both
    // shipped broken in production on 2026-06-11: "We compared 5 this
    // option sold on Amazon" (wc-methodology) and "fits the brief for
    // it." (top-picks blurbs).
    const skipRanges: Array<[number, number]> = [];
    for (const m of newHtml.matchAll(
      /<section class="wc-methodology"[\s\S]*?<\/section>/gi
    )) {
      skipRanges.push([m.index, m.index + m[0].length]);
    }
    for (const m of newHtml.matchAll(/Why we like this pick:/gi)) {
      skipRanges.push([m.index, m.index + 400]);
    }
    const inSkipRange = (idx: number) =>
      skipRanges.some(([s, e]) => idx >= s && idx < e);

    // Decide which to replace: skip <head>, skip inside h1/h2.
    let bodyKeepCount = 0;
    let synIdx = 0;
    let thinApplied = 0;
    const replacements = new Map<number, string>();
    for (const km of allMatches) {
      const { index } = km;
      // Always preserve occurrences in <head>
      if (headEnd >= 0 && index < headEnd) continue;
      if (inSkipRange(index)) continue;
      // Preserve occurrences inside heading tags
      const before = newHtml.slice(Math.max(0, index - 300), index);
      if (/<h[12][^>]*>[^<]*$/.test(before)) continue;
      // Preserve occurrences inside <title> or <meta>
      if (/<(?:title|meta)[^>]*>[^<]*$/.test(before)) continue;
      bodyKeepCount++;
      if (bodyKeepCount <= MAX_KW_REPS) continue; // keep first N
      // Never substitute when the keyword directly follows a
      // determiner/demonstrative: "These <keyword> emerged…" must not
      // become "These it emerged…" — that exact garbling shipped in
      // the 2026-06-11 "elevated cat bowl reviews" article. Pronoun
      // and noun synonyms are both unsafe there ("These it", "a bowl
      // reviews"), so keep the original occurrence. Same for counted
      // phrases: "We compared 5 <keyword>" must not become
      // "We compared 5 it".
      const precedingText = before.replace(/<[^>]*>/g, " ");
      if (
        /\b(?:the|a|an|this|that|these|those|our|your|their|its|my|his|her|each|every|any|some|all|both|no|\d+)\s+$/i.test(
          precedingText
        )
      )
        continue;
      // Mark for replacement
      const syn = synonyms[synIdx % synonyms.length];
      synIdx++;
      thinApplied++;
      replacements.set(index, syn);
    }
    if (thinApplied > 0) {
      // Rebuild HTML with replacements applied (in reverse order to keep indices stable)
      const sortedPositions = [...replacements.entries()].sort(
        (a, b) => b[0] - a[0]
      );
      let thinHtml = newHtml;
      for (const [pos, syn] of sortedPositions) {
        const matchAtPos = allMatches.find((km) => km.index === pos);
        if (!matchAtPos) {
          agent.log(
            "error",
            `Polish Agent: keyword match lost at position ${pos} — replacements/allMatches desync. Aborting thin-keyword pass.`,
            "editor"
          );
          // Roll back: discard any partial replacements already applied so
          // the article isn't left in a half-modified state.
          thinHtml = newHtml;
          thinApplied = 0;
          break;
        }
        const original = matchAtPos.text;
        thinHtml =
          thinHtml.slice(0, pos) + syn + thinHtml.slice(pos + original.length);
      }
      newHtml = thinHtml;
      applied += thinApplied;
      const afterCount = (
        newHtml
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .match(kwRegex) || []
      ).length;
      agent.log(
        "info",
        `  Polish thinning: ${allMatches.length}× → ${afterCount}× (${thinApplied} replaced deterministically)`,
        "editor"
      );
    }

    return {
      improved: applied > 0,
      newHtml: applied > 0 ? newHtml : articleHtml,
      changeCount: applied,
      summary: String(parsed.summary || `${applied} checks fixed`),
      remediationPromptsConsumed
    };
  } catch (err: unknown) {
    const keywordLabel = keyword.trim() || "unknown keyword";
    agent.log(
      "warning",
      `Polish Agent error (${keywordLabel}): ${errMsg(err)}`,
      "editor",
      {
        kanbanStage: "aiReview",
        modelPrompt: polishPromptCell
      }
    );
    return {
      improved: false,
      newHtml: articleHtml,
      changeCount: 0,
      summary: "Polish Agent failed",
      remediationPromptsConsumed
    };
  }
}
