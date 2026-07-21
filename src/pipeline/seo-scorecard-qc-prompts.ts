import { errMsg } from "./http-utils";
import { generateText } from "ai";
import type { SEOArticleAgent } from "../server";
import {
  ACTIVITY_LOG_SHEET_PROMPT_MAX_CHARS,
  formatActivityLogModelPromptCell,
  truncateActivityLogSheetPromptCell
} from "../activityLogSheetColumns";
import { parseObjectLike } from "../objectLike";
import { getKimiModel, getKimiProviderOptions } from "./kimi-model";
import type { SEOCheck } from "./seo-score";

/** Max characters per JSON hint value from the batched QC model (embedded in full cell). */
const PER_HINT_CHAR_CAP = 4000;

/** Max failed checks per Workers AI call (then merge). */
const FAILED_CHECKS_PER_CALL = 35;

const SYSTEM_PROMPT = `You are a senior SEO QC reviewer (same goals as the repo "review-skill": clear, actionable, prioritized feedback).

Return ONLY a single JSON object (no markdown fences, no commentary). Keys MUST be stringified check ids like "3" or "17". Include one key for EVERY failed check listed in the user message. Values MUST be plain English: concise prioritized fix guidance (max about ${PER_HINT_CHAR_CAP} characters per value) telling the editor exactly what to change in the article/HTML to flip that check to a pass. Be specific; do not repeat the check name only.`;

function buildFailureLines(checks: readonly SEOCheck[]): string {
  return checks
    .map((c) => {
      const normalizedDetail = c.detail.replaceAll(/[\t\r\n]+/g, " ").trim();
      const det =
        normalizedDetail.length > 160
          ? `${normalizedDetail.slice(0, 157)}...`
          : normalizedDetail;
      return `#${c.id}\t${c.pillar}\t${c.name}\t${det}`;
    })
    .join("\n");
}

function applyParsedToOut(
  out: (string | null)[],
  parsed: Record<string, unknown>,
  allowedIds: ReadonlySet<number>
): void {
  for (const [k, v] of Object.entries(parsed)) {
    if (!/^\d+$/.test(k)) continue;
    const id = Number(k);
    if (!Number.isSafeInteger(id) || id < 1 || id > out.length) continue;
    if (!allowedIds.has(id)) continue;
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t === "") continue;
    out[id - 1] =
      t.length > PER_HINT_CHAR_CAP ? t.slice(0, PER_HINT_CHAR_CAP) : t;
  }
}

async function runOneBatch(
  agent: SEOArticleAgent,
  batch: readonly SEOCheck[],
  keyword: string,
  title: string,
  metaDescription: string
): Promise<Record<string, unknown>> {
  const userPrompt = `Keyword: ${keyword}
Title: ${title}
Meta description: ${metaDescription.trim().slice(0, 240)}

Failed checks (tab-separated: id, pillar, name, detail):
${buildFailureLines(batch)}

Return JSON only, keys are ids as strings, values are short fix instructions.`;

  const modelPrompt = formatActivityLogModelPromptCell(
    SYSTEM_PROMPT,
    userPrompt
  );

  try {
    const { text } = await generateText({
      model: getKimiModel(agent.envBindings),
      providerOptions: getKimiProviderOptions(agent.envBindings),
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      maxOutputTokens: 3500,
      abortSignal: AbortSignal.timeout(90_000)
    });
    agent.log(
      "info",
      `SEO scorecard QC AI: batch (${batch.length} checks, ${text.length} chars model output)`,
      "qaReviewer",
      {
        kanbanStage: "aiReview",
        sheetPipelineStepLabel: "12/24: SEO Score Card AI",
        modelPrompt
      }
    );
    const parsed = parseObjectLike(text);
    if (parsed) return parsed;

    const preview =
      text.trim().replaceAll(/\s+/g, " ").slice(0, 220) || "(empty)";
    agent.log(
      "warning",
      `SEO scorecard QC AI batch parse failed: model output was not valid JSON object (preview: ${preview})`,
      "qaReviewer",
      { kanbanStage: "aiReview" }
    );
    return {};
  } catch (err: unknown) {
    agent.log(
      "warning",
      `SEO scorecard QC AI batch failed: ${errMsg(err)}`,
      "qaReviewer",
      { kanbanStage: "aiReview" }
    );
    return {};
  }
}

/**
 * For each scorecard check (ordered by id 1..N), returns a parallel array of
 * **full** `generateText`-ready prompt strings (`formatActivityLogModelPromptCell`)
 * for failed checks; passes stay `null`. Uses one or more batched `generateText`
 * calls to produce per-check fix guidance, then wraps guidance + article HTML
 * into the final cell payload.
 */
export async function generateSeoScorecardQcPromptCells(
  agent: SEOArticleAgent,
  checks: readonly SEOCheck[],
  keyword: string,
  title: string,
  metaDescription: string,
  html: string
): Promise<(string | null)[]> {
  const n = checks.length;
  const hints: (string | null)[] = Array.from({ length: n }, () => null);
  const failed = checks.filter((c) => !c.passed);
  if (failed.length === 0) return hints;

  for (let i = 0; i < failed.length; i += FAILED_CHECKS_PER_CALL) {
    const batch = failed.slice(i, i + FAILED_CHECKS_PER_CALL);
    const allowed = new Set(batch.map((c) => c.id));
    const partial = await runOneBatch(
      agent,
      batch,
      keyword,
      title,
      metaDescription
    );
    applyParsedToOut(hints, partial, allowed);
  }

  for (const c of failed) {
    if (hints[c.id - 1] == null || String(hints[c.id - 1]).trim() === "") {
      const det =
        c.detail.length > 220 ? `${c.detail.slice(0, 217)}...` : c.detail;
      hints[c.id - 1] = `Improve this check: ${det}`.slice(
        0,
        PER_HINT_CHAR_CAP
      );
    }
  }

  const out: (string | null)[] = Array.from({ length: n }, () => null);
  for (const c of failed) {
    const hintLine = String(hints[c.id - 1] ?? "").trim();
    out[c.id - 1] = shrinkHtmlUntilFitsFormattedBudget(
      c,
      hintLine,
      keyword,
      title,
      metaDescription,
      html
    );
  }

  return out;
}

const REMEDIATION_SYSTEM_PROMPT = `You are a Workers AI HTML remediation model. When executed via generateText with the accompanying USER block, you must return improved article HTML that addresses the single failing SEO scorecard check described there, without inventing new factual claims, medical advice, or affiliate links that are not already implied by the source HTML. Preserve overall article structure unless a small refactor is required for the check. Output: full HTML document string only (no markdown fences).`;

function sliceHtmlForRemediationCell(html: string, maxChars: number): string {
  const t = html.trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n…";
}

function buildRemediationUserBlock(
  c: SEOCheck,
  hintLine: string,
  keyword: string,
  title: string,
  metaDescription: string,
  htmlSlice: string
): string {
  const meta = metaDescription.trim().slice(0, 400);
  return `Keyword: ${keyword}
Title: ${title}
Meta description: ${meta}

Failed check id: ${c.id}
Pillar: ${c.pillar}
Check name: ${c.name}
Check detail (from scorecard): ${c.detail}

QC fix guidance (from prior batched review; may be terse):
${hintLine}

Article HTML to revise (edit this body to satisfy the check; keep site tone):
${htmlSlice}`;
}

function buildRemediationModelPromptCell(
  c: SEOCheck,
  hintLine: string,
  keyword: string,
  title: string,
  metaDescription: string,
  htmlSlice: string
): string {
  return formatActivityLogModelPromptCell(
    REMEDIATION_SYSTEM_PROMPT,
    buildRemediationUserBlock(
      c,
      hintLine,
      keyword,
      title,
      metaDescription,
      htmlSlice
    )
  );
}

function shrinkHtmlUntilFitsFormattedBudget(
  c: SEOCheck,
  hintLine: string,
  keyword: string,
  title: string,
  metaDescription: string,
  html: string
): string {
  const maxFormatted = ACTIVITY_LOG_SHEET_PROMPT_MAX_CHARS - 400;
  let budget = Math.min(24_000, Math.max(4000, html.length));
  for (let attempt = 0; attempt < 14; attempt++) {
    const slice = sliceHtmlForRemediationCell(html, budget);
    const cell = buildRemediationModelPromptCell(
      c,
      hintLine,
      keyword,
      title,
      metaDescription,
      slice
    );
    if (cell.length <= maxFormatted) return cell;
    budget = Math.floor(budget * 0.82);
    if (budget < 2500) {
      return truncateActivityLogSheetPromptCell(cell, maxFormatted);
    }
  }
  return truncateActivityLogSheetPromptCell(
    buildRemediationModelPromptCell(
      c,
      hintLine,
      keyword,
      title,
      metaDescription,
      sliceHtmlForRemediationCell(html, 2500)
    ),
    maxFormatted
  );
}
