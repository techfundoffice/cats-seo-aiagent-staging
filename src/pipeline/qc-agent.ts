import {
  errMsg,
  extractFirstJsonObject,
  repairJson,
  unescapeHtml
} from "./http-utils";
import { generateText } from "ai";
import type { SEOArticleAgent } from "../server";
import { formatActivityLogModelPromptCell } from "../activityLogSheetColumns";
import { getKimiModel, getKimiProviderOptions } from "./kimi-model";
import { calculateSEOScore } from "./seo-score";
import { stripHtmlToPlainText } from "./plagiarism-overlap";
import type { DesignAuditReport } from "./design-audit";

/**
 * Result returned by `runQCAgent`.
 *
 * `improved` is `true` when the agent applied fixes and the rewritten
 * article's SEO score is at least as high as the original (i.e. no
 * regression). When `improved` is `false` (AI failure, no fixes needed,
 * or the rewrite lowered the score), `newHtml` is `undefined` and the
 * caller should keep the original article HTML.
 */
export interface QCResult {
  /** `true` when fixes were applied and the new SEO score is not lower than the original. */
  improved: boolean;
  /** Human-readable description of each fix applied, or a single "no fixes needed" / error entry. */
  changes: string[];
  /**
   * Rewritten article HTML. Present only when `improved === true`; callers
   * must not use this field when `improved` is `false`.
   */
  newHtml?: string;
  /** Pipeline SEO score (0–100) before the QC pass. */
  originalScore: number;
  /**
   * Pipeline SEO score after the QC pass. Equal to `originalScore` when no
   * fixes were applied (early returns) or when fixes were applied but did not
   * move the measured SEO signals.
   */
  newScore: number;
}

/**
 * QC Agent — compares our article against the #1 competitor and auto-fixes.
 *
 * 1. Strips both articles to plain text
 * 2. Asks Workers AI to identify what the competitor covers that we're missing
 * 3. Generates rewrite content for weak sections
 * 4. Injects rewrites into our HTML
 * 5. Re-scores and redeploys if improved
 */
export async function runQCAgent(
  agent: SEOArticleAgent,
  articleHtml: string,
  competitorText: string,
  competitorUrl: string,
  keyword: string,
  designAuditReport?: DesignAuditReport,
  title = ""
): Promise<QCResult> {
  const changes: string[] = [];

  // Strip our article HTML to plain text for comparison.
  // Previously capped at 3000 chars then re-sliced to 2000 in the prompt,
  // leaving the QC agent seeing only ~350 words of a 3000-word article.
  // Now we pass 6000 chars so the agent sees the full article structure.
  const ourText = unescapeHtml(stripHtmlToPlainText(articleHtml)).slice(
    0,
    6000
  );

  // Score our article before QC. Pass the real title so title-dependent checks
  // (brand-in-title, year-in-title, power-word-in-title, etc.) are evaluated
  // correctly and the QC scores are consistent with the main pipeline scores.
  const originalScoreResult = calculateSEOScore(
    articleHtml,
    keyword,
    title,
    "",
    1000
  );
  const originalScore = originalScoreResult.score;

  const designAuditBullets =
    designAuditReport && !designAuditReport.skipped
      ? designAuditReport.contentIssues
          .slice(0, 6)
          .map(
            (i) =>
              `- [${i.severity}/${i.category}] ${i.description} → ${i.suggestion}`
          )
          .join("\n")
      : "";
  const designAuditBlock = designAuditBullets
    ? `\n\nDESIGN AUDIT FINDINGS (live page, content-addressable):\n${designAuditBullets}`
    : "";

  const designAuditInstruction = designAuditBlock
    ? ", and address any content-addressable design findings above"
    : "";

  const qcSystemPrompt = `You are an SEO content QC agent. Compare two articles and find gaps. Return ONLY valid JSON. NEVER include prices, dollar amounts, or "$X" / "X dollars" / "USD X" anywhere in your fix content — Amazon Associates compliance forbids displayed prices on this site.`;
  const qcUserPrompt = `Compare these two articles about "${keyword}".

OUR ARTICLE (${ourText.split(/\s+/).length} words shown):
${ourText}

COMPETITOR #1 (${competitorUrl}):
${competitorText.slice(0, 3000)}${designAuditBlock}

Find what the competitor covers that we're MISSING or doing WORSE${designAuditInstruction}. Then write replacement content.

HARD RULE: every \`fix\` value MUST be entirely free of prices. No "$", no "dollars", no "bucks", no "USD". The competitor may mention prices — DO NOT carry those over. Use language like "affordable", "budget-friendly", or "premium" instead.

Return ONLY this JSON (no markdown fences):
{
  "gaps": ["gap 1", "gap 2", "gap 3"],
  "fixes": [
    {"issue": "what's missing/weak", "fix": "<p>New paragraph content to add. 50-100 words, HTML formatted.</p>"},
    {"issue": "what's missing/weak", "fix": "<p>New paragraph content. 50-100 words.</p>"}
  ]
}`;
  const qcPromptCell = formatActivityLogModelPromptCell(
    qcSystemPrompt,
    qcUserPrompt
  );

  let fixes: Array<{ issue: string; fix: string }> = [];
  try {
    const { text } = await generateText({
      model: getKimiModel(agent.envBindings),
      providerOptions: getKimiProviderOptions(agent.envBindings),
      system: qcSystemPrompt,
      prompt: qcUserPrompt,
      maxOutputTokens: 2000,
      abortSignal: AbortSignal.timeout(90_000)
    });

    // Use extractFirstJsonObject so truncated AI responses (no closing `}`)
    // still reach repairJson instead of being silently dropped by the greedy
    // regex /\{[\s\S]*\}/ which requires a closing brace to match at all.
    const rawJson = extractFirstJsonObject(text);
    if (rawJson) {
      // Attempt robust JSON parse: try raw first, then repair truncated JSON.
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(rawJson) as Record<string, unknown>;
      } catch {
        // Model truncated the JSON — repair and retry using the shared helper.
        try {
          parsed = JSON.parse(repairJson(rawJson)) as Record<string, unknown>;
          agent.log(
            "info",
            "QC Agent: JSON repaired successfully after parse failure",
            "qaReviewer"
          );
        } catch (repairErr: unknown) {
          throw new Error(`QC Agent JSON unrecoverable: ${errMsg(repairErr)}`);
        }
      }
      fixes = Array.isArray(parsed.fixes)
        ? (parsed.fixes as Array<{ issue: string; fix: string }>)
        : [];
      const gaps = Array.isArray(parsed.gaps) ? (parsed.gaps as string[]) : [];

      for (const gap of gaps) {
        changes.push(`Gap: ${gap}`);
      }
      agent.log(
        "info",
        `QC Agent: ${gaps.length} gaps found, ${fixes.length} fixes generated`,
        "qaReviewer",
        { kanbanStage: "aiReview", modelPrompt: qcPromptCell }
      );
    }
  } catch (err: unknown) {
    const reason = errMsg(err);
    agent.log(
      "warning",
      `QC Agent AI failed for "${keyword}": ${reason}`,
      "qaReviewer",
      {
        kanbanStage: "aiReview",
        modelPrompt: qcPromptCell
      }
    );
    // Non-fatal: continue without QC improvements rather than failing the pipeline
    return {
      improved: false,
      changes: [`QC AI failed (${reason}) — continuing`],
      originalScore,
      newScore: originalScore
    };
  }

  if (fixes.length === 0) {
    agent.log(
      "info",
      "QC Agent: no fixes needed — article matches or exceeds competitor"
    );
    return {
      improved: false,
      changes: ["No fixes needed"],
      originalScore,
      newScore: originalScore
    };
  }

  // Apply fixes — inject new content before the conclusion section
  let newHtml = articleHtml;
  const conclusionPos = newHtml.lastIndexOf('<div class="conclusion">');
  const faqPos = newHtml.lastIndexOf('class="faqs"');
  const insertPos =
    conclusionPos > 0 ? conclusionPos : faqPos > 0 ? faqPos : -1;
  let appliedFixes = false;

  if (insertPos > 0) {
    const fixesHtml = fixes
      .map((f) => {
        changes.push(`Fix: ${f.issue}`);
        return `
      <section class="qc-addition">
        ${f.fix}
      </section>`;
      })
      .join("\n");

    newHtml =
      newHtml.slice(0, insertPos) + fixesHtml + newHtml.slice(insertPos);
    appliedFixes = true;
  } else {
    // Can't find insertion point — append before closing body
    const bodyClose = newHtml.lastIndexOf("</body>");
    if (bodyClose > 0) {
      const fixesHtml = fixes
        .map((f) => {
          changes.push(`Fix: ${f.issue}`);
          return `<section class="qc-addition">${f.fix}</section>`;
        })
        .join("\n");
      newHtml =
        newHtml.slice(0, bodyClose) + fixesHtml + newHtml.slice(bodyClose);
      appliedFixes = true;
    }
  }

  if (!appliedFixes) {
    agent.log(
      "warning",
      "QC Agent: skipped fixes because no conclusion/FAQ/body insertion point was found (unexpected HTML shape)",
      "qaReviewer"
    );
    return {
      improved: false,
      changes: [...changes, "QC skipped: no insertion point found"],
      originalScore,
      newScore: originalScore
    };
  }

  // Re-score with the same title so the before/after comparison is apples-to-apples.
  const newScoreResult = calculateSEOScore(newHtml, keyword, title, "", 1000);
  const newScore = newScoreResult.score;

  const improved = newScore >= originalScore;

  for (const f of fixes) {
    agent.log("info", `  QC fix: ${f.issue}`);
  }
  agent.log(
    "info",
    `QC Agent: score ${originalScore} → ${newScore} (${improved ? "improved" : "no improvement"})`
  );

  return {
    improved,
    changes,
    newHtml: improved ? newHtml : undefined,
    originalScore,
    newScore
  };
}
