/**
 * defect-escalate.ts — Stage 4 of the per-defect-class self-improving
 * loop.
 *
 * What this module adds:
 *
 *   When the Stage 2 pattern trigger fires for a defect class (5+
 *   findings in 24h, no in-flight lock), this module:
 *
 *     1. Builds the Stage 3 eval-set (via `buildEvalSet`) so the
 *        runId + success criterion exist BEFORE the issue is opened.
 *     2. Opens a GitHub issue labeled `claude-fix-with-eval` +
 *        `defect-class:<class>` with a STRUCTURED runbook:
 *          • per-sample evidence rows linking to the production trace
 *          • scoped code surface (Copilot MAY edit X, must NOT edit Y)
 *          • mechanical success criterion + exact eval curl command
 *          • ambiguity escape hatch ("route back, don't band-aid")
 *     3. Assigns Copilot via the existing GraphQL flow so the issue
 *        produces a draft PR autonomously.
 *
 * The Stage 4 runbook is what makes Copilot's task BOUNDED. Without
 * the scoped surface + deny list, Copilot wanders the codebase; with
 * it, the surface area Copilot may touch is one or two files. Without
 * the eval curl, Copilot opens a PR on hope; with it, Copilot's fix
 * has a measurable success condition attached BEFORE the PR opens.
 *
 * Separated from `escalate-to-claude.ts` (article-level escalations
 * keyed off kvKey) for a single reason: this module needs
 * `readFindings` from `defect-findings.ts`, and `defect-findings.ts`
 * needs to call back into this module to fire Stage 4 on trigger. A
 * static import edge would be circular. By living in its own file
 * AND by being invoked from `defect-findings.ts` via dynamic import,
 * the cycle is broken cleanly. Static utilities (`createIssueDirect`,
 * `assignCopilotToIssue`, etc.) are imported from
 * `escalate-to-claude.ts` — one-way edge.
 */

import type { SEOArticleAgent } from "../server";
import { buildEvalSet, readEvalSet } from "./defect-eval-builder";
import { readFindings, type DefectClass } from "./defect-findings";
import {
  assignCopilotToIssue,
  createIssueDirect,
  getAdminBase,
  NPM_RUN_CHECK_RULE,
  getRepoName,
  getRepoOwner,
  renderMarkdownInlineCode
} from "./escalate-to-claude";
import { errMsg } from "./http-utils";

/**
 * Per-defect-class Stage 4 runbook. Each entry holds the human-readable
 * fragments the `claude-fix-with-eval` issue body needs: summary,
 * scoped code surface (Copilot MAY edit), explicit deny list (Copilot
 * must NOT touch), read-only context pointers, and the "ambiguous case
 * → route back" escape hatch.
 *
 * Stays in sync per-class with the Stage 3 template in
 * `defect-eval-builder.ts`. Splitting the runbook from the eval
 * checks is a deliberate separation of concerns: one is mechanical
 * grading, the other is human-readable scope.
 */
function defectClassRunbook(defectClass: DefectClass): {
  summary: string;
  scopedSurface: string[];
  denyList: string[];
  readOnlyContext: string[];
  ambiguityEscape: string;
} {
  switch (defectClass) {
    case "rewrite-fragment-not-document":
      return {
        summary:
          "Multiple articles in the last 24h had the editorial rewrite rejected because Kimi returned an `<article>` fragment instead of a full HTML document with `<!DOCTYPE html>`, `<html>`, `<head>`, and `<body>`. This drives both the `document-shape-regression` rejection and the head-content slice of `seo-regression` (lost `<title>`, meta, JSON-LD).",
        scopedSurface: [
          "`src/pipeline/editorial-agent.ts` — function `runRewriteAttempt`, the system+user prompt construction (the `OUTPUT FORMAT` block). The fix almost certainly lives in the prompt instructions, not in post-processing.",
          '`src/pipeline/editorial-lessons.ts` — the `reasonToInstruction("document-shape-regression")` mapping, if the lesson text needs to be sharper.'
        ],
        denyList: [
          "`src/pipeline/writer.ts` — initial-writer prompts. The defect is in the rewrite path only.",
          "`src/pipeline/html-builder.ts` — the canonical full-document shape is the reference; do not alter it.",
          "`src/pipeline/qc-gate.ts` — the gates correctly rejected these articles; the fix is upstream of them."
        ],
        readOnlyContext: [
          "Canonical full-document shape: `src/pipeline/html-builder.ts` — `buildArticleHtml` is the structure Kimi must mirror.",
          "Current rewrite prompt: read `runRewriteAttempt` in `src/pipeline/editorial-agent.ts`.",
          "Active lessons currently injected: `GET /api/admin/editorial-stats` surfaces what's already in the prompt."
        ],
        ambiguityEscape:
          "If the smoking gun is NOT in the prompt construction — e.g. Kimi physically cannot return a 60kB+ HTML document inside the `maxOutputTokens` budget, or the fragment-return is a tokenizer artifact — comment on this issue with your hypothesis. Do NOT lower `maxOutputTokens`, do NOT truncate output, do NOT add a post-process that wraps fragments in a synthetic `<html><head><body>` shell. Those are band-aids that hide the eval-detectable signal."
      };
    case "itemlist-doubled-best":
      return {
        summary:
          'Multiple articles in the last 24h shipped with a JSON-LD `ItemList.name` value starting with `"Best best ..."`. The ItemList builder prepends `"Best "` unconditionally even when the keyword already starts with `"best"`, producing a crawler-visible doubled prefix in structured data.',
        scopedSurface: [
          '`src/pipeline/html-builder.ts` — function `buildArticleHtml` around the `productSchema = { @type: "ItemList", name: \\`Best ${keyword} Comparison\\`, ... }` block (~line 535). The fix is a one-line conditional that strips a leading "best " from the keyword before prepending.'
        ],
        denyList: [
          "`src/pipeline/writer.ts` — the keyword arrives here already shaped; do not mutate the keyword upstream of html-builder.",
          "`src/pipeline/qc-gate.ts` — the gate detects the defect; do not weaken the detector to make the eval pass."
        ],
        readOnlyContext: [
          'Live example of the defect: `https://catsluvus.com/cat-window-hammocks-for-apartment-cats/best-cat-window-hammocks-for-apartment-cats` (view JSON-LD `<script type="application/ld+json">` block).',
          "Display layer behaviour: the H1 and `<title>` correctly avoid the doubled prefix via title-casing — only structured data has the bug. Confirm the fix brings JSON-LD into line with the display layer."
        ],
        ambiguityEscape:
          'If the keyword distribution includes terms that legitimately start with "best" as a brand or proper noun (rare but possible), do not strip indiscriminately. Comment with hypothesis. Do NOT remove the "Best " prefix entirely — it adds value for keywords that don\'t start with "best".'
      };
    case "product-name-truncation":
      return {
        summary:
          'Multiple articles in the last 24h shipped with product names truncated mid-token followed by an unrelated sentence verb. Example shape: `"...Wellness Monitoring for... provides superior real-time tracking ..."`. Reader sees broken prose; Google\'s content-quality models see fragmented entity references.',
        scopedSurface: [
          "`src/pipeline/writer.ts` — the product-pick blurb generation prompt (system+user). The fix is in the OUTPUT FORMAT instruction telling Kimi to ALWAYS spell out the full product name with no ellipsis-truncation before continuing a sentence.",
          "`src/pipeline/html-builder.ts` — `renderProductBlurb` or equivalent — if the truncation happens during HTML assembly (slicing names to N chars), the fix is removing that slice or raising its limit."
        ],
        denyList: [
          "`src/pipeline/qc-gate.ts` — the gate detects; do not relax the detector.",
          "`src/pipeline/editorial-agent.ts` — the editorial rewrite runs AFTER initial publish; the defect is upstream."
        ],
        readOnlyContext: [
          "Live example of the defect: `https://catsluvus.com/cat-gps-trackers-for-outdoor-cats/best-cat-gps-trackers-for-outdoor-cats` — search for `...` in product blurbs.",
          "Product-pick template skill: `.claude/skills/product-pick-blurb.md` if present — canonical blurb shape."
        ],
        ambiguityEscape:
          "If Kimi's output contains the full name and post-processing truncates it, fix the post-processor, not the prompt. If the prompt is producing truncation, sharpen the prompt rule. Do NOT lower the eval pattern's specificity to let truncations through."
      };
    case "missing-why-we-like-blurb":
      return {
        summary:
          "Multiple articles in the last 24h shipped product picks WITHOUT the required closing `Why we like this pick:` line. The product-pick template requires this marker as the last line of every product blurb; its absence means the template is being silently dropped during render.",
        scopedSurface: [
          "`src/pipeline/writer.ts` — the product-pick prompt, specifically the OUTPUT FORMAT block instructing Kimi to end every blurb with `Why we like this pick: <rationale>`.",
          "`src/pipeline/html-builder.ts` — the product-pick render path. If Kimi emits the marker correctly but the HTML assembly drops it, fix the assembly."
        ],
        denyList: [
          "`src/pipeline/qc-gate.ts` — do not weaken the eval check.",
          "`src/pipeline/editorial-agent.ts` — the rewrite path is downstream."
        ],
        readOnlyContext: [
          "Skill canonical: `.claude/skills/product-pick-blurb.md` if present.",
          "Live example with NO `Why we like` markers: `https://catsluvus.com/cat-gps-trackers-for-outdoor-cats/best-cat-gps-trackers-for-outdoor-cats`."
        ],
        ambiguityEscape:
          "If the marker is being stripped by a sanitizer for plagiarism/voice reasons, comment with hypothesis — the fix is to whitelist the marker, not remove the prompt instruction."
      };
    case "faq-near-duplicate-questions":
      return {
        summary:
          "Multiple articles shipped FAQ sections with 3 nearly-identical questions distinguished only by one swapped noun (e.g. `What is the best cat tracker?` + `What is the best cat GPS?` + `What is the best cat GPS collar?`). Content-fingerprint defect — Google's helpful-content classifier penalizes shallow keyword stuffing.",
        scopedSurface: [
          "`src/pipeline/writer.ts` — the FAQ generation prompt. The fix is requiring distinct buyer-intent ANGLES per question (e.g. price-tier / battery-life / size-fit / setup-time) instead of noun-shuffle variants of `best cat X?`."
        ],
        denyList: [
          "`src/pipeline/qc-gate.ts` — the gate detects; do not relax.",
          "`src/pipeline/editorial-agent.ts` — FAQ is generated upstream of editorial."
        ],
        readOnlyContext: [
          "Live example: `https://catsluvus.com/cat-gps-trackers-for-outdoor-cats/best-cat-gps-trackers-for-outdoor-cats`.",
          "Compare to good FAQ on any older article — distinct angles, no noun-shuffle."
        ],
        ambiguityEscape:
          "If the FAQ source list comes from DataForSEO PAA (People Also Ask), the near-duplicates may be authentic Google data. In that case dedupe at our side before emitting, do NOT degrade the dedupe to pass the eval."
      };
    case "duplicate-top-picks-headings":
      return {
        summary:
          "Multiple articles shipped with TWO H2 section headings matching `^(Our )?Top Picks$` — `Top Picks` AND `Our Top Picks` both appearing as section headings. Section duplication; reader confusion; anchor-link ambiguity.",
        scopedSurface: [
          "`src/pipeline/html-builder.ts` — the section-assembly path where product picks are wrapped in an H2. Search for both `Top Picks` and `Our Top Picks` literal strings; one of the two sections is redundant.",
          "`src/pipeline/writer.ts` — if Kimi emits `Top Picks` as a section heading on top of the template-injected `Our Top Picks`, the fix is suppressing one side."
        ],
        denyList: ["`src/pipeline/qc-gate.ts` — do not weaken the detector."],
        readOnlyContext: [
          "Live example: `https://catsluvus.com/cat-gps-trackers-for-outdoor-cats/best-cat-gps-trackers-for-outdoor-cats` — view source for `<h2>Top Picks</h2>` and `<h2>Our Top Picks</h2>` both present."
        ],
        ambiguityEscape:
          "If one heading is in JSON-LD context (ItemList.name) and the other is the visible H2, those are not duplicates — refine the detector to only match visible H2s. Comment with hypothesis before changing scope."
      };
    case "live-title-orphan-modifier":
      return {
        summary:
          "Multiple live articles have titles that end in an orphan trailing modifier (`Top`, `Buying`, `&`, `+`, `for`, etc.) or exceed the 60-char SERP window after HTML-entity decode. These defects are caught post-publish by the live quality probe — they were not stopped by the pre-publish gates — meaning `enforceTitleSerpWindow` failed to normalize the title before the article was written to KV.",
        scopedSurface: [
          "`src/pipeline/title-meta-normalizer.ts` — `enforceTitleSerpWindow`: the orphan-detection logic (trim, strip punctuation, check last token against `TITLE_TRAILING_ORPHAN_MODIFIERS`) may be missing edge cases observed in the finding evidence. Extend `TITLE_TRAILING_ORPHAN_MODIFIERS` if new orphan words appear, or tighten the truncation pass so it never leaves a title ending mid-phrase.",
          "`src/pipeline/writer.ts` — the initial title-generation prompt and the call to `enforceTitleSerpWindow` after Kimi returns: verify the normalizer is actually being called on the final stored title."
        ],
        denyList: [
          "`src/pipeline/editorial-agent.ts` — the live probe records defects for already-published articles; the editorial rewrite path is downstream and should not be the primary fix surface.",
          "`src/pipeline/live-quality-probe.ts` — the probe correctly detects the defect; do not weaken `endsWithOrphanModifier` or `isOverSerpWindow` to make findings disappear."
        ],
        readOnlyContext: [
          "`TITLE_TRAILING_ORPHAN_MODIFIERS` in `src/pipeline/title-meta-normalizer.ts` — the canonical set of orphan tokens; extend here if findings show new ones.",
          "`enforceTitleSerpWindow` in `src/pipeline/title-meta-normalizer.ts` — the enforcement function that must keep every stored title ≤60 chars AND free of orphan last-tokens.",
          "Per-article evidence in this issue body: inspect the `orphanWord` and `overSerpWindow` fields to see exactly which token triggered the finding."
        ],
        ambiguityEscape:
          "If the title is already in-window and has no orphan token but the probe still fires (false positive), confirm by checking the `orphanShape` and `overSerpWindow` evidence fields. If both are `false`, the probe has a detection bug — fix the detection logic in `live-quality-probe.ts::endsWithOrphanModifier`, not the normalizer. Comment with your hypothesis before changing scope."
      };
    case "live-thin-h2-count":
      return {
        summary:
          "Multiple live articles have fewer than 4 `<h2>` section headings. Under-structured articles likely under-rank: thin H2 coverage signals shallow topical depth to Google's content-quality models. Detected post-publish by the live quality probe.",
        scopedSurface: [
          "`src/pipeline/writer.ts` — the article-body generation prompt. Verify the `REQUIRED SECTIONS` or equivalent instruction specifies a minimum section count (≥4), and that Kimi reliably meets it. If Kimi is returning fewer sections under token pressure, consider raising `maxOutputTokens` or splitting the generation into two calls.",
          "`src/pipeline/html-builder.ts` — if sections are generated correctly but collapsed or dropped during HTML assembly, the fix is in the assembly path."
        ],
        denyList: [
          "`src/pipeline/editorial-agent.ts` — live probe findings are for initial-publish content; the editorial rewrite runs downstream.",
          "`src/pipeline/live-quality-probe.ts` — the probe correctly flags thin-H2 articles; do not raise the threshold or suppress the defect class."
        ],
        readOnlyContext: [
          "`countH2s` in `src/pipeline/live-quality-probe.ts` — the detection helper; threshold is `h2.total < 4`.",
          "Per-article evidence in this issue body: inspect `h2Count` to see how many sections were actually emitted."
        ],
        ambiguityEscape:
          "If the article legitimately requires fewer than 4 H2s (very short format, single-product review), the threshold in the probe may need adjusting. Comment with the article URL and keyword before lowering the threshold — this should be rare and data-driven."
      };
    case "live-missing-faq-coverage":
      return {
        summary:
          "Multiple live articles have zero question-style `<h2>` headings AND no `FAQPage` JSON-LD schema. This eliminates rich-result eligibility (FAQ rich snippets in SERP) and indicates the FAQ section was either not generated or not assembled into the final HTML. Detected post-publish by the live quality probe.",
        scopedSurface: [
          "`src/pipeline/writer.ts` — the FAQ generation prompt. Verify it requests at least 3–5 distinct question-and-answer pairs with genuine buyer-intent angles, and that the output shape matches what `html-builder.ts` expects.",
          "`src/pipeline/html-builder.ts` — the `faqSchema` emitter and the FAQ-section HTML assembly. If Kimi returns `faqs[]` but the builder silently skips it (empty array, wrong key name, type mismatch), the fix is in the assembly path."
        ],
        denyList: [
          "`src/pipeline/editorial-agent.ts` — FAQs are generated upstream of the editorial rewrite; this is an initial-publish issue.",
          "`src/pipeline/live-quality-probe.ts` — the probe correctly detects absent FAQ coverage; do not suppress the defect class or weaken `hasFaqPageSchema`."
        ],
        readOnlyContext: [
          '`hasFaqPageSchema` in `src/pipeline/live-quality-probe.ts` — inspects all `<script type="application/ld+json">` blocks for a `FAQPage` `@type` with a non-empty `mainEntity` array.',
          "`countH2s` in `src/pipeline/live-quality-probe.ts` — counts question-style H2s (`text.endsWith('?')`).",
          "Per-article evidence in this issue body: inspect `questionH2Count` and `hasFaqSchema` to understand which signal triggered the finding."
        ],
        ambiguityEscape:
          "If the FAQ array is populated in Kimi's JSON response but `hasFaqPageSchema` returns false, the JSON-LD block may be malformed (unclosed tag, invalid JSON). In that case fix the JSON-LD serialiser in `html-builder.ts`, not the FAQ prompt. Comment with hypothesis before changing scope."
      };
    // Other classes get specialised runbooks as they get wired in
    // subsequent PRs. The default keeps the function total and emits a
    // generic-but-honest runbook so the loop is never silently broken
    // for an unconfigured class.
    default:
      return {
        summary: `The ${defectClass} rejection pattern crossed the trigger threshold (5+ findings in 24h). The Stage 4 runbook for this class is not yet specialised — treat the rejection-site code path in \`editorial-agent.ts\` as the suspected surface and the rewrite prompt + lessons mapping as the most likely fix locations.`,
        scopedSurface: [
          "`src/pipeline/editorial-agent.ts` — the rejection site for this class.",
          "`src/pipeline/editorial-lessons.ts` — the `reasonToInstruction` mapping for this class."
        ],
        denyList: [
          "`src/pipeline/writer.ts` and `src/pipeline/qc-gate.ts` — out of scope without explicit reason."
        ],
        readOnlyContext: [
          `Recent findings for this class: see the per-sample evidence block in this issue body. The full rolling blob lives at KV key \`defect-findings:${defectClass}\`.`
        ],
        ambiguityEscape:
          "If the root cause is unclear from the sample evidence, comment on this issue with your hypothesis BEFORE pushing a fix. The eval will still reject anything that doesn't meet the mechanical criterion — don't chase a green eval by fitting to the samples."
      };
  }
}

/**
 * Stage 4 entry point. Called from `defect-findings.recordFinding` when
 * the pattern trigger fires AND the in-flight lock was just acquired.
 *
 * Fire-and-forget: never throws. Returns the runId of the eval-set
 * attached to this escalation on success, or null on any failure
 * (missing token, eval-build failed, GitHub API error). Caller does
 * not branch on the result — it's there for log correlation.
 */
export async function escalateDefectClassToCopilot(
  agent: SEOArticleAgent,
  defectClass: DefectClass,
  context: { triggerCount: number; sampleKvKey: string }
): Promise<string | null> {
  const ghToken = agent.envBindings.GITHUB_TOKEN_SECRET?.trim();
  if (!ghToken) {
    agent.log(
      "warning",
      `Defect escalation: skipping (no GITHUB_TOKEN_SECRET) for defectClass=${defectClass}`,
      "codingAgent",
      { kanbanStage: "debug" }
    );
    return null;
  }

  // Build the Stage 3 eval-set first. The issue body embeds the runId
  // + the success criterion; without them the issue is just a bug
  // report, which is the thing this whole loop is supposed to prevent.
  const runId = await buildEvalSet(agent, defectClass);
  if (!runId) {
    agent.log(
      "warning",
      `Defect escalation: buildEvalSet returned null for defectClass=${defectClass} (not enough distinct samples or KV failure). Skipping issue; next finding will retry.`,
      "codingAgent",
      { kanbanStage: "debug" }
    );
    return null;
  }
  const spec = await readEvalSet(agent, runId);
  if (!spec) {
    agent.log(
      "warning",
      `Defect escalation: readEvalSet returned null for fresh runId=${runId}; KV write race. Skipping issue.`,
      "codingAgent",
      { kanbanStage: "debug" }
    );
    return null;
  }
  const findings = await readFindings(agent, defectClass);
  const runbook = defectClassRunbook(defectClass);
  const adminBase = getAdminBase(agent);
  const owner = getRepoOwner(agent);
  const repo = getRepoName(agent);

  const title = `[auto] defect: ${defectClass} — eval runId=${runId.slice(0, 64)}`;
  const body = renderDefectIssueBody({
    defectClass,
    runId,
    spec,
    findings,
    triggerCount: context.triggerCount,
    runbook,
    adminBase
  });

  try {
    const data = await createIssueDirect(agent, ghToken, {
      owner,
      repo,
      title,
      body,
      labels: [
        "claude-fix",
        "claude-fix-with-eval",
        `defect-class:${defectClass}`
      ]
    });
    if (!data) {
      agent.log(
        "error",
        `Defect escalation: createIssueDirect failed for defectClass=${defectClass} runId=${runId}`,
        "codingAgent",
        { kanbanStage: "debug" }
      );
      return null;
    }
    const issueRef = data.number ? `#${data.number}` : "(unknown #)";
    const issueUrl = data.html_url ? ` — ${data.html_url}` : "";
    agent.log(
      "info",
      `Defect escalation: opened issue ${issueRef} for defectClass=${defectClass} runId=${runId} triggerCount=${context.triggerCount} sampleKvKey=${context.sampleKvKey}${issueUrl}`,
      "codingAgent",
      { kanbanStage: "debug" }
    );

    if (data.node_id && data.number) {
      try {
        await assignCopilotToIssue(
          agent,
          data.node_id,
          data.number,
          `defect-${defectClass}`
        );
      } catch (err: unknown) {
        agent.log(
          "warning",
          `Defect escalation: Copilot assignment failed for ${issueRef} (defectClass=${defectClass}): ${errMsg(err)}`,
          "codingAgent",
          { kanbanStage: "debug" }
        );
      }
    }
    return runId;
  } catch (err: unknown) {
    agent.log(
      "error",
      `Defect escalation: issue POST threw for defectClass=${defectClass} runId=${runId}: ${errMsg(err)}`,
      "codingAgent",
      { kanbanStage: "debug" }
    );
    return null;
  }
}

function renderDefectIssueBody(params: {
  defectClass: DefectClass;
  runId: string;
  spec: NonNullable<Awaited<ReturnType<typeof readEvalSet>>>;
  findings: Awaited<ReturnType<typeof readFindings>>;
  triggerCount: number;
  runbook: ReturnType<typeof defectClassRunbook>;
  adminBase: string;
}): string {
  const {
    defectClass,
    runId,
    spec,
    findings,
    triggerCount,
    runbook,
    adminBase
  } = params;

  const sampleLines: string[] = [];
  for (const sample of spec.samples) {
    const finding = findings.find((f) => f.kvKey === sample.kvKey);
    const evidenceKeys = finding
      ? Object.entries(finding.evidence)
          .slice(0, 6)
          .map(([k, v]) => {
            const str =
              typeof v === "string" ? v.slice(0, 80) : JSON.stringify(v);
            return `    - ${k}: ${renderMarkdownInlineCode(String(str))}`;
          })
      : [];
    sampleLines.push(
      `- **kvKey**: ${renderMarkdownInlineCode(sample.kvKey)}`,
      `  - finding captured: ${sample.findingTimestamp}`,
      `  - kimi-raw (raw model output): \`${adminBase}/api/admin/kimi-raw/${encodeURIComponent(sample.kvKey)}\``,
      `  - published HTML: \`${adminBase}/api/admin/kv/${encodeURIComponent(sample.kvKey)}\``,
      `  - pre-editorial snapshot (the "good" baseline): KV prefix \`${sample.snapshotKey}\` — resolve via list-by-prefix`,
      ...(evidenceKeys.length
        ? [`  - structured evidence (first 6 fields):`, ...evidenceKeys]
        : [])
    );
  }

  const checkLines = spec.successCriterion.perSample.map((check) => {
    const desc = (() => {
      switch (check.kind) {
        case "regex-must-match":
          return `regex ${renderMarkdownInlineCode(`/${check.pattern}/${check.flags ?? ""}`)} must match the rewrite output`;
        case "regex-must-not-match":
          return `regex ${renderMarkdownInlineCode(`/${check.pattern}/${check.flags ?? ""}`)} must NOT match the rewrite output`;
        case "jsonld-block-count-gte-original":
          return 'rewrite must contain at least as many `<script type="application/ld+json">` blocks as the original';
        case "seo-score-delta-gte":
          return `rewrite's SEO-score delta vs original must be ≥ ${check.threshold}`;
      }
    })();
    const rationale = spec.rationale[check.id];
    return `- **${check.id}** — ${desc}${rationale ? ` — _${rationale}_` : ""}`;
  });

  const evalCurl = [
    "```bash",
    "# Run from Copilot's PR workspace once a candidate fix is in place.",
    "# Bearer-gated; ADMIN_API_TOKEN is the existing repo secret.",
    "curl -sS -X POST \\",
    '  -H "Authorization: Bearer $ADMIN_API_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify({ runId, candidateBranch: "<your-branch-name>" })}' \\`,
    `  ${adminBase}/api/admin/run-defect-eval`,
    "```",
    "",
    `Eval passes when the response is \`{ "passed": ${spec.successCriterion.passThreshold.samplesPassed}, "of": ${spec.successCriterion.passThreshold.of}, ... }\` AND your branch's \`npm run check\` succeeds. Include the eval response JSON in your PR description.`
  ];

  return [
    `## Defect-class escalation (Stage 4 of self-improving loop)`,
    ``,
    `**defectClass**: ${renderMarkdownInlineCode(defectClass)}`,
    `**runId**: ${renderMarkdownInlineCode(runId)}`,
    `**trigger**: ${triggerCount} findings within the last 24h crossed the pattern threshold`,
    ``,
    `### Defect summary`,
    runbook.summary,
    ``,
    `### Sample evidence (${spec.samples.length} representative cases — distinct kvKeys, newest first)`,
    ...sampleLines,
    ``,
    `### Success criterion (mechanical — no LLM in the grader)`,
    `Pass threshold: **${spec.successCriterion.passThreshold.samplesPassed} of ${spec.successCriterion.passThreshold.of}** samples must pass ALL per-sample checks:`,
    ``,
    ...checkLines,
    ``,
    `### Scoped code surface (Copilot MAY edit these files)`,
    ...runbook.scopedSurface.map((s) => `- ${s}`),
    ``,
    `### Out of scope (Copilot must NOT edit these files)`,
    ...runbook.denyList.map((s) => `- ${s}`),
    ``,
    `### Read-only context (consult freely)`,
    ...runbook.readOnlyContext.map((s) => `- ${s}`),
    ``,
    `### Validation BEFORE opening the PR`,
    `Run this eval against your candidate branch. Do not open the PR until it passes.`,
    ``,
    ...evalCurl,
    ``,
    `### What "ambiguous" looks like (escape hatch)`,
    runbook.ambiguityEscape,
    ``,
    `### Rules for Copilot`,
    `- Fix the root cause inside the scoped surface above.`,
    NPM_RUN_CHECK_RULE,
    `- Run the eval curl above and paste the response JSON into your PR description.`,
    `- Open the PR titled \`fix(defect:${defectClass}): [root cause]\`. Never push to \`main\` directly.`,
    `- Close this issue with \`Fixes #<issue>\` in the PR description.`,
    ``,
    `<!-- emitted by src/pipeline/defect-escalate.ts:escalateDefectClassToCopilot -->`
  ].join("\n");
}
