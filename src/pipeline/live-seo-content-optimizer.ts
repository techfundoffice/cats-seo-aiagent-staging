import { errMsg } from "./http-utils";
import { generateText } from "ai";
import type { SEOArticleAgent } from "../server";
import { getKimiModel, getKimiProviderOptions } from "./kimi-model";

/** Max characters of the live article HTML excerpt passed to the model. */
const LIVE_HTML_MAX_CHARS = 22_000;
/** Timeout for the live article HTML fetch (ms). */
const LIVE_FETCH_TIMEOUT_MS = 15_000;
/** Timeout for the Kimi model call (ms). */
const LIVE_MODEL_TIMEOUT_MS = 90_000;

/**
 * Workers-side pass inspired by agentskill.sh **`@anthropic/seo-content-optimizer`**
 * (article-focused SEO after publication): fetches the **live** article HTML from
 * the public URL, then runs Workers AI on the excerpt for post-publish optimization
 * notes (headings, on-page signals, readability, snippet-oriented tweaks).
 */
const SEO_CONTENT_OPTIMIZER_SYSTEM = `You follow the intent of the Agent Skills catalog skill @anthropic/seo-content-optimizer: optimize **published article HTML** for search and helpfulness **after** it is live.

You receive a truncated HTML excerpt the Worker already fetched from the real URL. Do not invent fetch results.

Respond in plain text (no JSON). Use short sections:
1) Executive summary (2–4 sentences)
2) Priority fixes (numbered; each with **Issue** / **Why it matters** / **Suggested change**)
3) Quick wins (bullets)
4) Optional deeper ideas (bullets)

Stay concrete and tied to the provided HTML/keyword. Max ~900 words.`;

export type LiveSeoContentOptimizerInput = {
  articleUrl: string;
  keyword: string;
  title: string;
  metaDescription: string;
  /** Pipeline SEO score before this live pass (for context only). */
  pipelineSeoScore: number;
};

export type LiveSeoContentOptimizerResult = {
  notes: string;
  httpStatus: number;
  fetchOk: boolean;
  systemPrompt: string;
  userPrompt: string;
};

/**
 * Step 19/24 live-pass: fetches the published article from its public URL,
 * strips `<script>` and `<style>` blocks, and runs a Kimi model call to
 * produce post-publish SEO optimization notes (headings, on-page signals,
 * readability, featured-snippet tweaks).
 *
 * Non-fatal: network errors and model failures are caught and returned in
 * `result.notes` rather than thrown, so the pipeline step always completes.
 * Callers should log `result.notes` and the `result.systemPrompt` /
 * `result.userPrompt` pair via `formatActivityLogModelPromptCell`.
 *
 * @param agent - The active `SEOArticleAgent` Durable Object instance
 *   (provides env bindings and the activity log).
 * @param input - Article metadata: live URL, keyword, title, meta
 *   description, and the heuristic SEO score from the pipeline.
 * @returns Notes from the model (or an error summary when the fetch or
 *   model call fails), the HTTP status of the live-fetch attempt, a flag
 *   indicating whether the fetch succeeded, and the full system + user
 *   prompt for the activity-log `modelPrompt` column.
 */
export async function runLiveSeoContentOptimizerPass(
  agent: SEOArticleAgent,
  input: LiveSeoContentOptimizerInput
): Promise<LiveSeoContentOptimizerResult> {
  const userPromptHead = `Keyword: ${input.keyword}
Live article URL (HTML was fetched from here): ${input.articleUrl}
Title (from pipeline): ${input.title}
Meta description (from pipeline): ${input.metaDescription}
Prior on-pipeline SEO score (heuristic): ${input.pipelineSeoScore}/100

--- Fetched live HTML excerpt (truncated; scripts/styles stripped) ---
`;

  let httpStatus = 0;
  let fetchOk = false;
  let excerpt = "";
  let fetchNetworkError = "";

  try {
    const res = await fetch(input.articleUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; CatsLuvUs-SEOAgent/1.0; +https://catsluvus.com)",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
      },
      signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS)
    });
    httpStatus = res.status;
    fetchOk = res.ok;
    if (fetchOk) {
      const raw = await res.text();
      excerpt = raw
        .replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, "")
        .slice(0, LIVE_HTML_MAX_CHARS);
    }
  } catch (fetchErr: unknown) {
    fetchOk = false;
    excerpt = "";
    fetchNetworkError = errMsg(fetchErr);
  }

  const userPrompt = `${userPromptHead}${excerpt || "(empty)"}`;

  let notes: string;
  if (!fetchOk) {
    notes =
      fetchNetworkError !== ""
        ? `Live fetch threw a network error: ${fetchNetworkError}. No HTML was analyzed.`
        : `Live fetch failed (HTTP ${httpStatus || "n/a"}). No HTML was analyzed.`;
  } else if (excerpt.trim().length < 200) {
    notes =
      "Live HTML was too short after stripping scripts/styles — skipped model pass.";
  } else {
    try {
      const out = await generateText({
        model: getKimiModel(agent.envBindings),
        providerOptions: getKimiProviderOptions(agent.envBindings),
        system: SEO_CONTENT_OPTIMIZER_SYSTEM,
        prompt: userPrompt,
        maxOutputTokens: 2500,
        abortSignal: AbortSignal.timeout(LIVE_MODEL_TIMEOUT_MS)
      });
      const t = out.text?.trim() ?? "";
      notes =
        t !== "" ? t : "Model returned empty text for live SEO content pass.";
    } catch (err: unknown) {
      notes = `Live SEO model error: ${errMsg(err)}`;
    }
  }

  return {
    notes,
    httpStatus,
    fetchOk,
    systemPrompt: SEO_CONTENT_OPTIMIZER_SYSTEM,
    userPrompt
  };
}
