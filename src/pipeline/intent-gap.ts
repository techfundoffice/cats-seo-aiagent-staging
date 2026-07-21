import { parseObjectLike } from "../objectLike";
import {
  errMsg,
  repairJson,
  extractFirstJsonObject,
  normalizeSingleLine
} from "./http-utils";
import { generateText } from "ai";
import type { SEOArticleAgent } from "../server";
import { getKimiModel, getKimiProviderOptions } from "./kimi-model";
import { formatActivityLogModelPromptCell } from "../activityLogSheetColumns";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * A single intent bucket found in the SERP, with a saturation level and a
 * note on whether the current top-10 leaves a gap we can exploit.
 */
export interface SerpIntentBucket {
  /**
   * The intent type label as returned by the AI.
   * Examples: "transactional", "how-to-choose", "safety/warnings",
   * "comparison", "informational", "problem-solving"
   */
  intent: string;
  /**
   * Fraction of the top-10 SERP results that serve this intent (0–1).
   * e.g. 0.7 means 7 of 10 results.
   */
  saturation: number;
  /**
   * True when fewer than 3 of the top-10 results serve this intent —
   * i.e. this is an underserved angle we should target.
   */
  isGap: boolean;
  /** One-sentence description of what content satisfies this intent. */
  description: string;
}

/**
 * The full result of the SERP intent gap analysis.
 *
 * Consumed by `buildArticlePrompt` to inject a `SERP_INTENT_GAP` block
 * into the AI writing prompt. The block tells the writer:
 *   1. Which intents are already saturated (so we can differentiate)
 *   2. Which intents are underserved (the editorial angles we must own)
 */
export interface SerpIntentGapResult {
  /**
   * Ordered list of intent buckets from most-saturated to least.
   * Typically 3–5 entries.
   */
  buckets: SerpIntentBucket[];
  /**
   * The dominant intent (highest saturation). Used in logging only.
   */
  dominantIntent: string;
  /**
   * Gap intents (isGap=true). Presented to the AI as angles to own.
   */
  gapIntents: string[];
  /**
   * The formatted block injected verbatim into buildArticlePrompt.
   * Empty string when analysis failed or was skipped (no titles available).
   */
  promptBlock: string;
  /** True when the AI call was skipped (e.g. no SERP titles) */
  skipped: boolean;
  skipReason?: string;
  /** Full system+user prompt for activity-log traceability */
  modelPromptCell?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const LOG_SNIPPET_MAX_CHARS = 240;

function summarizeLogSnippet(text: string): string {
  const normalized = normalizeSingleLine(text);
  if (!normalized) return "(empty)";
  if (normalized.length <= LOG_SNIPPET_MAX_CHARS) return normalized;
  return `${normalized.slice(0, LOG_SNIPPET_MAX_CHARS)}…`;
}

/**
 * Builds a human-readable `SERP_INTENT_GAP` block for the article prompt.
 * This is the only text the article-writing model ever sees from this step.
 *
 * Intentionally concise — the block must not crowd out product grounding or
 * competitor content in the ~24K prompt budget.
 */
function buildPromptBlock(
  result: Omit<SerpIntentGapResult, "promptBlock">
): string {
  if (result.skipped || result.buckets.length === 0) return "";

  const saturatedLines = result.buckets
    .filter((b) => !b.isGap)
    .map(
      (b) =>
        `  - ${b.intent} (${Math.round(b.saturation * 10)}/10 results already cover this)`
    )
    .join("\n");

  const gapLines = result.buckets
    .filter((b) => b.isGap)
    .map(
      (b) => `  - ${b.intent}: ${b.description} ← UNDERSERVED — OWN THIS ANGLE`
    )
    .join("\n");

  const gapSection =
    gapLines.length > 0
      ? `\nUNDERSERVED GAPS TO OWN (fewer than 3 top-10 results cover these):\n${gapLines}`
      : "";

  const saturatedSection =
    saturatedLines.length > 0
      ? `\nSATURATED ANGLES (already well-covered — differentiate, don't duplicate):\n${saturatedLines}`
      : "";

  return `\nSERP INTENT GAP ANALYSIS:\nThe top-10 Google results for this keyword are dominated by: ${result.dominantIntent}.\n${saturatedSection}${gapSection}\nEDITORIAL DIRECTIVE: Your article must contain dedicated sections or subsections for each UNDERSERVED gap above. These are the angles competitors are missing — owning them is what earns a #1 ranking.\n`;
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Step 5.5/24 — SERP Intent Gap Analyzer.
 *
 * Runs a single fast AI call (Kimi-K2.5) against the top-10 SERP titles
 * and PAA questions already captured in Step 2. Classifies them into intent
 * buckets, identifies which buckets are underserved (<3 of 10 results), and
 * returns a pre-formatted `promptBlock` ready to inject into buildArticlePrompt.
 *
 * NEVER throws — all errors are caught and surfaced as a skipped result so
 * the main pipeline always continues. The `promptBlock` will be empty string
 * on skip, so buildArticlePrompt degrades gracefully with no behavior change.
 *
 * @param agent   The SEOArticleAgent (for AI binding + logging)
 * @param keyword The target keyword (for AI context)
 * @param titles  Top-10 SERP titles from analyzeSERP (serpData.topTitles)
 * @param paa     PAA questions from Step 3 (paaQuestions)
 */
export async function analyzeSerpIntentGap(
  agent: SEOArticleAgent,
  keyword: string,
  titles: string[],
  paa: string[]
): Promise<SerpIntentGapResult> {
  const skipped = (reason: string): SerpIntentGapResult => ({
    buckets: [],
    dominantIntent: "",
    gapIntents: [],
    promptBlock: "",
    skipped: true,
    skipReason: reason
  });

  if (titles.length === 0) {
    agent.log("info", "Intent Gap: skipped — no SERP titles available");
    return skipped("no SERP titles available");
  }

  const titleList = titles
    .slice(0, 10)
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");

  const paaList =
    paa.length > 0
      ? `\nPeople Also Ask questions:\n${paa
          .slice(0, 8)
          .map((q) => `- ${q}`)
          .join("\n")}`
      : "";

  const systemPrompt =
    "You are an SEO strategist. Return ONLY a valid JSON object. " +
    "Never include markdown code fences, explanations, or text outside the JSON. " +
    "Your response starts with { and ends with }.";

  const userPrompt =
    `Keyword: "${keyword}"\n\n` +
    `Top-10 Google search result titles:\n${titleList}${paaList}\n\n` +
    `Classify these results into intent buckets and identify which intents are ` +
    `underserved (covered by fewer than 3 of the 10 results). ` +
    `An intent is a distinct reason someone searches for this keyword ` +
    `(e.g. "transactional — want to buy now", "how-to-choose — researching ` +
    `before buying", "safety/warnings — worried about risks", ` +
    `"comparison — want to decide between options", ` +
    `"problem-solving — have a specific issue to fix"). ` +
    `\n\nReturn ONLY this JSON object:\n` +
    `{\n` +
    `  "buckets": [\n` +
    `    {\n` +
    `      "intent": "string — intent type label (3-4 words max)",\n` +
    `      "saturation": number between 0 and 1 (fraction of 10 results covering this intent),\n` +
    `      "isGap": boolean (true if fewer than 3 of 10 results cover this),\n` +
    `      "description": "string — one sentence: what content satisfies this intent"\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `Rules:\n` +
    `- 3 to 5 buckets total\n` +
    `- Buckets must be ordered highest saturation first\n` +
    `- Saturations across all buckets must sum to approximately 1.0\n` +
    `- isGap=true only when saturation < 0.3 (fewer than 3 of 10 results)\n` +
    `- description is written as a content prescription, e.g. ` +
    `"Explain what features to evaluate and which specs matter most before buying"\n` +
    `- Respond with the JSON object ONLY. Start with { and end with }.`;

  const modelPromptCell = formatActivityLogModelPromptCell(
    systemPrompt,
    userPrompt
  );

  let rawText = "";
  try {
    const result = await generateText({
      model: getKimiModel(agent.envBindings),
      providerOptions: getKimiProviderOptions(agent.envBindings),
      system: systemPrompt,
      prompt: userPrompt,
      maxOutputTokens: 900,
      abortSignal: AbortSignal.timeout(90_000)
    });
    rawText = result.text?.trim() ?? "";
  } catch (err: unknown) {
    const msg = errMsg(err);
    agent.log(
      "warning",
      `Intent Gap: Kimi K2.5 failed — skipping step (${msg})`,
      "analyst",
      { modelPrompt: modelPromptCell }
    );
    return skipped(msg);
  }

  if (!rawText || rawText.length < 20) {
    agent.log(
      "warning",
      "Intent Gap: Kimi K2.5 returned empty response — skipping step",
      "analyst",
      { modelPrompt: modelPromptCell }
    );
    return skipped("Kimi K2.5 returned empty response");
  }

  // Extract JSON — strip markdown fences if the model added them, then use
  // extractFirstJsonObject to find the first well-delimited object boundary.
  // This handles trailing text / extra `}` characters after the JSON that
  // cause the simpler indexOf/lastIndexOf approach to produce invalid JSON.
  let jsonStr = rawText;
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) jsonStr = fenced[1].trim();
  const extracted = extractFirstJsonObject(jsonStr);
  if (extracted === null) {
    agent.log(
      "warning",
      `Intent Gap: AI response contained no JSON object; skipping (responseSnippet=${JSON.stringify(
        summarizeLogSnippet(rawText)
      )})`
    );
    return skipped("no JSON object in AI response");
  }
  jsonStr = extracted;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Model may have emitted trailing commas or unquoted keys — try to repair.
    try {
      parsed = JSON.parse(repairJson(jsonStr));
      agent.log(
        "info",
        "Intent Gap: JSON repaired successfully after parse failure"
      );
    } catch (err: unknown) {
      const parseMessage = errMsg(err);
      agent.log(
        "warning",
        `Intent Gap: JSON.parse failed (${parseMessage}); skipping (responseSnippet=${JSON.stringify(
          summarizeLogSnippet(jsonStr)
        )})`
      );
      return skipped(`JSON.parse failed: ${parseMessage}`);
    }
  }

  const obj = parseObjectLike(parsed);
  if (!obj) {
    agent.log(
      "warning",
      "Intent Gap: parsed JSON root was not an object; skipping"
    );
    return skipped("parsed JSON root was not an object");
  }
  if (!Array.isArray(obj.buckets) || obj.buckets.length === 0) {
    agent.log(
      "warning",
      "Intent Gap: buckets array missing or empty; skipping"
    );
    return skipped("buckets array missing or empty");
  }

  // Normalise and validate each bucket
  const buckets: SerpIntentBucket[] = [];
  for (const raw of obj.buckets as unknown[]) {
    const b = parseObjectLike(raw);
    if (!b) continue;
    const intent = typeof b.intent === "string" ? b.intent.trim() : "";
    const rawSat = b.saturation;
    const satNum =
      typeof rawSat === "number"
        ? rawSat
        : typeof rawSat === "string"
          ? (() => {
              const text = rawSat.trim();
              if (!text) return NaN;
              if (text.endsWith("%")) {
                const percent = Number(text.slice(0, -1).trim());
                return Number.isFinite(percent) ? percent / 100 : NaN;
              }
              return Number(text);
            })()
          : NaN;
    const saturation = Number.isFinite(satNum)
      ? Math.min(1, Math.max(0, satNum))
      : 0;
    const isGap = typeof b.isGap === "boolean" ? b.isGap : saturation < 0.3;
    const description =
      typeof b.description === "string" ? b.description.trim() : "";
    if (!intent) continue;
    buckets.push({ intent, saturation, isGap, description });
  }

  if (buckets.length === 0) {
    agent.log(
      "warning",
      "Intent Gap: no valid buckets after normalisation; skipping"
    );
    return skipped("no valid buckets after normalisation");
  }

  // Sort highest saturation first (AI should already do this, but enforce)
  buckets.sort((a, b) => b.saturation - a.saturation);

  const dominantIntent = buckets[0].intent;
  const gapIntents = buckets.filter((b) => b.isGap).map((b) => b.intent);

  const partial = {
    buckets,
    dominantIntent,
    gapIntents,
    skipped: false as const,
    modelPromptCell
  };
  const promptBlock = buildPromptBlock(partial);

  agent.log(
    "info",
    `Intent Gap: dominant="${dominantIntent}", gaps=[${gapIntents.join(", ") || "none"}], ${buckets.length} buckets`
  );

  return { ...partial, promptBlock };
}
