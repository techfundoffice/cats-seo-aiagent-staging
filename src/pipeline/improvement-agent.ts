/**
 * improvement-agent.ts — fire-and-forget self-improvement loop.
 *
 * Fires once per successful article publish (from `finalizeArticle()`).
 * Opens a GitHub issue labeled `improvement` + `auto`, then assigns
 * GitHub Copilot Coding Agent to it. Copilot reads the issue body,
 * picks ONE high-leverage `src/` improvement, reads any relevant
 * `.claude/skills/<slug>/SKILL.md`, runs `npm run check`, and opens a
 * PR titled `improve(auto): [one-line]`. Existing
 * `.github/workflows/auto-merge-copilot.yml` squash-merges the PR once
 * `check (ubuntu-24.04)` passes.
 *
 * Mirrors the failure-escalation flow (`escalate-to-claude.ts`); the
 * only behavioural differences are: (1) fires on success, not failure;
 * (2) issue label is `improvement` not `claude-fix`; (3) 24h KV dedup
 * window per kvKey (vs 1h per category) — a republish via the editorial
 * agent must NOT re-trigger improvement on the same article.
 *
 * Design rules (mirror escalate-to-claude.ts):
 *   • NEVER throw. Best-effort; a failing dispatch must not crash or
 *     retry the article pipeline.
 *   • Rate-limit per `<kvKey>` via KV (24h) to prevent issue spam when
 *     an article is republished within the day.
 *   • Every dispatch is mirrored to the activity log under role
 *     `improvementAgent` so operators can see in the dashboard that
 *     the improvement loop fired.
 *   • No secrets in the issue body — only kvKey/keyword/categorySlug/
 *     articleUrl + the local skill inventory.
 */

import { errMsg, keywordToSlug, normalizeSingleLine } from "./http-utils";
import type { SEOArticleAgent } from "../server";
import {
  assignCopilotToIssue,
  createIssueDirect,
  getAdminBase,
  getRepoName,
  getRepoOwner,
  NPM_RUN_CHECK_RULE,
  getSafeKeyword,
  isDurableObjectResetError,
  renderMarkdownInlineCode
} from "./escalate-to-claude";

export interface ImprovementInput {
  kvKey: string;
  keyword: string;
  categorySlug: string;
  articleUrl?: string | URL;
}

// Use `{ query: "?url", import: "default" }` so Vite treats each match
// as a static URL rather than a JS module.  Without this option Vite
// attempts to parse SKILL.md files as JS (they contain YAML front-matter)
// and the build fails with 16+ [PARSE_ERROR] errors.  We only consume
// `Object.keys(localSkillFiles)` — the content is never loaded.
const localSkillFiles = import.meta.glob("../../.claude/skills/*/SKILL.md", {
  query: "?url",
  import: "default"
});

function getLocalSkillSlugFromPath(pathKey: string): string | null {
  const normalizedPath = pathKey.replaceAll("\\", "/");
  return normalizedPath.match(/\/skills\/([^/]+)\/SKILL\.md$/)?.[1] ?? null;
}

/**
 * Skill slugs discovered at build time from `.claude/skills/<slug>/SKILL.md`.
 * This avoids prompt drift when skill docs are added/removed and guarantees
 * generated issue bodies only point at docs that exist in this repo snapshot.
 */
const INSTALLED_SKILL_SLUGS: readonly string[] = [
  ...Object.keys(localSkillFiles)
    .map(getLocalSkillSlugFromPath)
    .filter((slug): slug is string => Boolean(slug))
].sort((a, b) => a.localeCompare(b));

const DEDUP_KEY_PREFIX = "improvement-dedup:";
const CLOUDFLARE_KV_KEY_MAX_BYTES = 512;
const DEDUP_KEY_KV_PART_MAX_BYTES =
  CLOUDFLARE_KV_KEY_MAX_BYTES - DEDUP_KEY_PREFIX.length;
const DEDUP_TRUNCATION_HASH_SUFFIX_PREFIX = ":h";
const DEDUP_TRUNCATION_HASH_HEX_LENGTH = 8;
const IMPROVEMENT_ISSUE_TITLE_PREFIX = "[auto] improvement: ";
const IMPROVEMENT_ISSUE_TITLE_SUFFIX_MAX_BYTES = 80;
const IMPROVEMENT_ISSUE_TITLE_FALLBACK_SUFFIX = "unknown keyword";
const SUGGESTED_PR_TITLE_PREFIX = "improve(auto): ";
const SUGGESTED_PR_TITLE_SUFFIX = "[one-line root cause or area]";
const SUGGESTED_PR_TITLE_MAX_BYTES = 72;
const SANITY_CHECK_WORKFLOW_FILTER_EXAMPLE_TEMPLATE =
  '`owner: "{owner}"`, `repo: "{repo}"`, `resource_id: "sanity-check.yml"`, `per_page: 10`, and ' +
  '`workflow_runs_filter: { branch: "[exact git branch from \'git rev-parse --abbrev-ref HEAD\']", event: "pull_request", status: "completed" }`';
const UTF8_ENCODER = new TextEncoder();
const SUGGESTED_PR_TITLE_PREFIX_BYTES = UTF8_ENCODER.encode(
  SUGGESTED_PR_TITLE_PREFIX
).length;

type UrlLikeInput = {
  href?: string;
  toString: () => string;
};

/**
 * 24h dedup so a republish (editorial agent variant B, manual retry)
 * doesn't fire a second improvement issue for the same article on the
 * same day.
 */
const IMPROVEMENT_DEDUP_TTL_SECONDS = 60 * 60 * 24;

/**
 * Fire-and-forget self-improvement trigger. Logs to the activity feed
 * under role `improvementAgent`, dedups via KV, opens a GitHub issue
 * + assigns Copilot on dedup miss. Swallows every error — caller must
 * never branch on the outcome.
 */
export async function triggerCodebaseImprovement(
  agent: SEOArticleAgent,
  input: ImprovementInput
): Promise<void> {
  const keyword = normalizeInputField(agent, "keyword", input.keyword);
  const kvKey = normalizeInputField(agent, "kvKey", input.kvKey);
  const categorySlug = normalizeInputField(
    agent,
    "categorySlug",
    input.categorySlug
  );
  // `articleUrl` can be reconstructed from `kvKey`; avoid warning-noise when a
  // caller omits it and let `resolveRenderableArticleUrl()` derive a fallback.
  const articleUrl = normalizeArticleUrlField(agent, input.articleUrl);
  const normalizedInputArticleUrl = normalizeRenderableArticleUrl(articleUrl);
  const derivedArticleUrlFromKvKey = deriveRenderableArticleUrl(kvKey);

  const safeKeyword = getSafeKeyword(keyword);
  const safeKvKey = normalizeSingleLine(kvKey).trim();
  const safeKvKeyForLog = safeKvKey || "(empty kvKey)";
  const safeCategorySlugForLog =
    normalizeSingleLine(categorySlug).trim() || "(empty category)";
  const safeArticleUrlForLog =
    normalizedInputArticleUrl || derivedArticleUrlFromKvKey || "(unavailable)";
  const dedupKvKey = safeKvKey.toLowerCase();
  let dedupKeyKvPart = dedupKvKey;
  if (!dedupKvKey) {
    const safeKeywordSlug = keywordToSlug(safeKeyword);
    const safeCategorySlug = keywordToSlug(normalizeSingleLine(categorySlug));
    const articlePathDedupSuffix = deriveArticlePathDedupSuffixFromUrl(
      normalizedInputArticleUrl
    );
    dedupKeyKvPart = articlePathDedupSuffix
      ? `missing-kvkey:url:${articlePathDedupSuffix}`
      : `missing-kvkey:${safeCategorySlug}:${safeKeywordSlug}`;
    agent.log(
      "warning",
      `Improvement Agent: using fallback dedup key ${JSON.stringify(
        dedupKeyKvPart
      )} for ${safeKeyword} (missing kvKey=${JSON.stringify(
        safeKvKeyForLog
      )}; category=${JSON.stringify(safeCategorySlugForLog)}; articleUrl=${JSON.stringify(
        safeArticleUrlForLog
      )})`,
      "improvementAgent",
      { kanbanStage: "debug" }
    );
  }
  const dedupKeyKvPartBytes = UTF8_ENCODER.encode(dedupKeyKvPart).length;
  const cappedDedupKeyKvPart = capDedupKeyKvPart(
    dedupKeyKvPart,
    DEDUP_KEY_KV_PART_MAX_BYTES
  );
  if (cappedDedupKeyKvPart !== dedupKeyKvPart) {
    agent.log(
      "warning",
      `Improvement Agent: dedup key part for ${safeKeyword} exceeded ${DEDUP_KEY_KV_PART_MAX_BYTES} bytes (${dedupKeyKvPartBytes}); truncated key=${JSON.stringify(
        `${DEDUP_KEY_PREFIX}${cappedDedupKeyKvPart}`
      )}; kvKey=${JSON.stringify(safeKvKeyForLog)}`,
      "improvementAgent",
      { kanbanStage: "debug" }
    );
    dedupKeyKvPart = cappedDedupKeyKvPart;
  }

  const ghToken = agent.envBindings.GITHUB_TOKEN_SECRET?.trim();
  if (!ghToken) {
    agent.log(
      "warning",
      `Improvement Agent: skipping (missing GITHUB_TOKEN_SECRET; set Worker secret GITHUB_TOKEN_SECRET to enable auto-improvement issue dispatch) for ${safeKeyword} (kvKey=${JSON.stringify(
        safeKvKeyForLog
      )}; category=${JSON.stringify(safeCategorySlugForLog)}; articleUrl=${JSON.stringify(
        safeArticleUrlForLog
      )})`,
      "improvementAgent",
      { kanbanStage: "debug" }
    );
    return;
  }

  const dedupKey = `${DEDUP_KEY_PREFIX}${dedupKeyKvPart}`;
  let seen: string | null = null;
  try {
    seen = await agent.envBindings.ARTICLES_KV.get(dedupKey);
  } catch (err: unknown) {
    if (isDurableObjectResetError(err)) {
      agent.log(
        "info",
        `Improvement Agent: transient Durable Object reset during dedup read for ${safeKeyword}; retrying once`,
        "improvementAgent",
        { kanbanStage: "debug" }
      );
      try {
        seen = await agent.envBindings.ARTICLES_KV.get(dedupKey);
      } catch (retryErr: unknown) {
        if (isDurableObjectResetError(retryErr)) {
          agent.log(
            "info",
            `Improvement Agent: suppressed transient Durable Object reset during dedup read retry for ${safeKeyword} (key=${JSON.stringify(
              dedupKey
            )}; continuing without dedup, so this run may open a duplicate issue)`,
            "improvementAgent",
            { kanbanStage: "debug" }
          );
        } else {
          agent.log(
            "warning",
            `Improvement Agent: dedup read retry failed for ${safeKeyword} (key=${JSON.stringify(dedupKey)}) (continuing): ${errMsg(
              retryErr
            )}`,
            "improvementAgent",
            { kanbanStage: "debug" }
          );
        }
      }
    } else {
      agent.log(
        "warning",
        `Improvement Agent: dedup read failed for ${safeKeyword} (key=${JSON.stringify(dedupKey)}) (continuing): ${errMsg(
          err
        )}`,
        "improvementAgent",
        { kanbanStage: "debug" }
      );
    }
  }
  if (seen !== null) {
    const dedupMarkerDetail = summarizeDedupMarkerDetail(seen);
    agent.log(
      "info",
      `Improvement Agent: deduped ${safeKeyword} (kvKey=${JSON.stringify(
        safeKvKeyForLog
      )}; key=${JSON.stringify(dedupKey)}; ${dedupMarkerDetail}; already fired within the last 24h)`,
      "improvementAgent",
      { kanbanStage: "debug" }
    );
    return;
  }

  if (
    normalizedInputArticleUrl &&
    derivedArticleUrlFromKvKey &&
    normalizedInputArticleUrl !== derivedArticleUrlFromKvKey
  ) {
    agent.log(
      "warning",
      `Improvement Agent: publish metadata article URL ${JSON.stringify(
        normalizedInputArticleUrl
      )} did not match kvKey-derived URL ${JSON.stringify(
        derivedArticleUrlFromKvKey
      )}; diagnostics will use the kvKey-derived URL for ${safeKeyword} (kvKey=${JSON.stringify(
        safeKvKeyForLog
      )})`,
      "improvementAgent",
      { kanbanStage: "debug" }
    );
  }

  const title = buildImprovementIssueTitle(keyword);
  const adminBase = getAdminBase(agent);
  const owner = getRepoOwner(agent);
  const repo = getRepoName(agent);
  const body = renderImprovementIssueBody(
    { kvKey, keyword, categorySlug, articleUrl },
    adminBase,
    owner,
    repo
  );

  // Write the dedup record BEFORE creating the issue so a transient
  // KV.put failure later can't produce duplicate issues + duplicate
  // Copilot PRs. Mirrors the reorder shipped for escalate-to-claude.ts
  // in #4732 — same exact race shape. If issue creation fails, the
  // catch block below best-effort deletes the dedup record so the next
  // attempt can retry without waiting for the 24h TTL.
  let dedupWritePreIssue = false;
  try {
    await agent.envBindings.ARTICLES_KV.put(dedupKey, String(Date.now()), {
      expirationTtl: IMPROVEMENT_DEDUP_TTL_SECONDS
    });
    dedupWritePreIssue = true;
  } catch (err: unknown) {
    if (isDurableObjectResetError(err)) {
      agent.log(
        "info",
        `Improvement Agent: suppressed transient Durable Object reset during pre-issue dedup write for ${safeKeyword} (kvKey=${JSON.stringify(safeKvKeyForLog)})`,
        "improvementAgent",
        { kanbanStage: "debug" }
      );
    } else {
      agent.log(
        "warning",
        `Improvement Agent: pre-issue dedup write failed for ${safeKeyword} (continuing without dedup — duplicate-issue risk): ${errMsg(err)}`,
        "improvementAgent",
        { kanbanStage: "debug" }
      );
    }
  }

  try {
    const data = await createIssueDirect(agent, ghToken, {
      owner,
      repo,
      title,
      body,
      labels: ["improvement", "auto"],
      logPrefix: "Improvement Agent",
      logRole: "improvementAgent"
    });
    if (!data) {
      agent.log(
        "error",
        `Improvement Agent: direct GitHub issue create failed for ${safeKeyword} (kvKey=${JSON.stringify(
          safeKvKeyForLog
        )}; category=${JSON.stringify(
          safeCategorySlugForLog
        )}; see prior warning for HTTP detail). Rolling back dedup record so next attempt can retry.`,
        "improvementAgent",
        { kanbanStage: "debug" }
      );
      await rollbackPreIssueDedupKey(agent, {
        dedupKey,
        didWriteDedupKey: dedupWritePreIssue,
        keyword: safeKeyword,
        kvKey: safeKvKeyForLog,
        categorySlug: safeCategorySlugForLog,
        failureContext: "after direct issue create returned no data"
      });
      return;
    }
    const issueRef = data.number ? `#${data.number}` : "(unknown #)";
    const issueUrl =
      data.html_url ??
      (data.number
        ? `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${data.number}`
        : "");
    const issueUrlSuffix = issueUrl ? ` — ${issueUrl}` : "";
    agent.log(
      "info",
      `Improvement Agent: opened issue ${issueRef} for ${JSON.stringify(
        safeKeyword
      )}${issueUrlSuffix}`,
      "improvementAgent",
      { kanbanStage: "debug" }
    );

    if (data.node_id && data.number) {
      try {
        await assignCopilotToIssue(agent, data.node_id, data.number, keyword, {
          logPrefix: "Improvement Agent",
          logRole: "improvementAgent"
        });
      } catch (err: unknown) {
        agent.log(
          "warning",
          `Improvement Agent: Copilot assignment failed for ${issueRef} (${safeKeyword}): ${errMsg(
            err
          )}`,
          "improvementAgent",
          { kanbanStage: "debug" }
        );
      }
    } else {
      const missingFields = [
        !data.node_id ? "node_id" : null,
        !data.number ? "number" : null
      ]
        .filter((field): field is string => field !== null)
        .join(", ");
      agent.log(
        "warning",
        `Improvement Agent: opened issue ${issueRef} missing ${missingFields || "required assignment fields"}; Copilot assignment skipped for ${safeKeyword} (kvKey=${JSON.stringify(
          safeKvKeyForLog
        )}; category=${JSON.stringify(safeCategorySlugForLog)})`,
        "improvementAgent",
        { kanbanStage: "debug" }
      );
    }

    // (Dedup KV-write moved BEFORE issue creation above to prevent
    // duplicate issues on transient KV-write failure — see the
    // pre-issue try/catch block + rollback in the !data branch.)
  } catch (err: unknown) {
    if (isDurableObjectResetError(err)) {
      agent.log(
        "info",
        `Improvement Agent: suppressed transient Durable Object reset during dispatch for ${safeKeyword} (kvKey=${JSON.stringify(
          safeKvKeyForLog
        )}; category=${JSON.stringify(safeCategorySlugForLog)})`,
        "improvementAgent",
        { kanbanStage: "debug" }
      );
      return;
    }
    agent.log(
      "error",
      `Improvement Agent: dispatch threw for ${safeKeyword} (kvKey=${JSON.stringify(
        safeKvKeyForLog
      )}; category=${JSON.stringify(safeCategorySlugForLog)}): ${errMsg(err)}`,
      "improvementAgent",
      { kanbanStage: "debug" }
    );
    await rollbackPreIssueDedupKey(agent, {
      dedupKey,
      didWriteDedupKey: dedupWritePreIssue,
      keyword: safeKeyword,
      kvKey: safeKvKeyForLog,
      categorySlug: safeCategorySlugForLog,
      failureContext: "after dispatch threw"
    });
  }
}

/**
 * Markdown body Copilot reads when it picks up the improvement issue.
 * Includes:
 *   • Pointer to the freshly-published article (so Copilot has a real
 *     example of current pipeline output).
 *   • Bearer-auth curl commands so the agent can inspect live logs
 *     without a separate lookup of the API base URL, plus fallback
 *     guidance when the local clone does not have `ADMIN_API_TOKEN`.
 *   • The skill inventory (so Copilot knows which `.claude/skills/<slug>`
 *     docs to consult before editing).
 *   • Hard rules (one improvement, run check, no main pushes, etc.).
 */
function renderImprovementIssueBody(
  input: ImprovementInput,
  adminBase: string,
  owner: string,
  repo: string
): string {
  const { kvKey, keyword, categorySlug, articleUrl = "" } = input;
  const safeArticleUrl = resolveRenderableArticleUrl(articleUrl, kvKey);
  const keywordCode = renderIssueBodyField(keyword, "(empty keyword)");
  const categoryCode = renderIssueBodyField(categorySlug, "(empty category)");
  const kvKeyCode = renderIssueBodyField(kvKey, "(empty kvKey)");
  // Bare URL so GitHub auto-links it as a clickable hyperlink.
  // renderMarkdownInlineCode would wrap it in backticks (code span),
  // which is unclickable and harder for Copilot to navigate to.
  const articleUrlDisplay =
    safeArticleUrl || renderMarkdownInlineCode("(unavailable)");
  const skillBullets = renderSkillDocBullets(INSTALLED_SKILL_SLUGS);
  const suggestedPrTitle = buildSuggestedImprovementPrTitle();
  const suggestedPrTitleCode = renderMarkdownInlineCode(suggestedPrTitle);
  const sanityCheckWorkflowFilterExample =
    SANITY_CHECK_WORKFLOW_FILTER_EXAMPLE_TEMPLATE.replace(
      '"{owner}"',
      JSON.stringify(owner)
    ).replace('"{repo}"', JSON.stringify(repo));
  const renderDiagnosticLines = safeArticleUrl
    ? [
        `# Live-rendered HTML of the triggering article (post-JS via Cloudflare Browser)`,
        `curl -sS -H "Authorization: Bearer $ADMIN_API_TOKEN" \\`,
        `  "${adminBase}/api/admin/render?url=${encodeURIComponent(safeArticleUrl)}"`
      ]
    : [
        `# Live-rendered HTML unavailable (triggering article URL was missing, not a valid catsluvus.com https URL, or did not look like an article path in publish metadata)`
      ];

  return [
    `## Autonomous self-improvement run`,
    ``,
    `> **Mandatory PR rule:** only open a new PR when your actual code change is ready to review.`,
    `> If a PR already exists for your branch and it is draft or starts with \`[WIP]\`,`,
    `> rename it to ${suggestedPrTitleCode}, mark it ready-for-review, and only then`,
    `> inspect CI or run CI MCP queries (\`github-mcp-server-actions_list\` with \`method: "list_workflow_runs"\`,`,
    `> \`github-mcp-server-actions_list\` with \`method: "list_workflow_jobs"\`, and \`github-mcp-server-get_job_logs\`)`,
    `> or post progress updates that rely on CI status.`,
    `> Do not call \`engine-tools-report_progress\` / \`report_progress\` for an initial checklist before code is ready — that commit can auto-open/update a PR early and trigger a zero-job \`action_required\` run.`,
    `> If your tooling has a startup progress step, keep it local/non-PR (no commit/push) until code is ready;`,
    `> if your environment auto-opens/updates a PR anyway, immediately rename it to ${suggestedPrTitleCode}`,
    `> and set ready-for-review before using CI status.`,
    ``,
    `An article just published successfully. Use this opportunity to make`,
    `the codebase **slightly better** — pick exactly **ONE** high-leverage`,
    `improvement in \`src/\`, ship a clean PR, and exit.`,
    ``,
    `### Required PR setup`,
    `- Copy/paste PR title when your change is ready: ${suggestedPrTitleCode}`,
    `- Use the exact lowercase prefix \`improve(auto): \` (do not use \`Improve(auto):\`).`,
    `- Do **not** open a placeholder PR before coding.`,
    `- If no PR exists yet, wait until the change is ready, then open one as **ready-for-review** with title ${suggestedPrTitleCode} (do not start with \`[WIP]\`).`,
    `- If a PR already exists for your branch, reuse it: rename it to ${suggestedPrTitleCode} and keep only that one PR open.`,
    `- If that existing PR is draft or its title starts with \`[WIP]\`, fix the title/state before`,
    `  relying on CI status so GitHub schedules real jobs instead of`,
    `  another zero-job \`action_required\` run.`,
    `- Good title example: \`improve(auto): clarify improvement-agent PR setup instructions\`.`,
    `- Bad title example: \`[WIP] Improve codebase for best cat carrier article\`.`,
    `- Leaving the PR as draft or \`[WIP]\` keeps Copilot auto-merge workflows in`,
    `  \`action_required\`, so treat this rename/readiness step as mandatory.`,
    `- If the PR opened as non-draft with \`[WIP]\`, rename it, then toggle`,
    `  draft -> ready-for-review once so GitHub emits \`ready_for_review\` and`,
    `  reruns auto-merge checks with jobs instead of another zero-job`,
    `  \`action_required\` run.`,
    `- If you need to do this via API, PATCH \`/repos/{owner}/{repo}/pulls/{pull_number}\``,
    `  with \`{"title":${JSON.stringify(suggestedPrTitle)}}\`, then:`,
    `  - if the PR is draft, POST \`/repos/{owner}/{repo}/pulls/{pull_number}/ready_for_review\`;`,
    `  - if the PR is already non-draft with \`[WIP]\`, POST`,
    `    \`/repos/{owner}/{repo}/pulls/{pull_number}/convert_to_draft\` and then`,
    `    POST \`/repos/{owner}/{repo}/pulls/{pull_number}/ready_for_review\` to force`,
    `    a fresh \`ready_for_review\` run with jobs.`,
    `- Once a PR exists and you are checking CI, verify the PR has a run with real jobs via MCP:`,
    `  1. Run \`git rev-parse --abbrev-ref HEAD\` and copy the exact branch output.`,
    `  2. Run \`github-mcp-server-actions_list\` with \`method: "list_workflow_runs"\` and ${sanityCheckWorkflowFilterExample}.`,
    `  3. Take the latest completed run id from that filtered list.`,
    `  4. Run \`github-mcp-server-actions_list\` with \`owner: ${JSON.stringify(owner)}\`, \`repo: ${JSON.stringify(repo)}\`, \`method: "list_workflow_jobs"\`, and \`resource_id: "[that_run_id]"\` (replace with your run id).`,
    `  5. Run \`github-mcp-server-get_job_logs\` with \`{ owner: ${JSON.stringify(owner)}, repo: ${JSON.stringify(repo)}, run_id: [that_run_id], failed_only: true }\` (replace with your run id).`,
    `  6. Only treat \`action_required\` + zero jobs (for example \`jobs.total_count: 0\` or`,
    `     \`total_jobs: 0\`) as draft/\`[WIP]\` gating.`,
    `  \`No failed jobs found in this workflow run\` can appear for both`,
    `  zero-job draft/\`[WIP]\` runs and real-job passing runs, so always`,
    `  interpret it together with \`total_jobs\` / \`jobs.total_count\` and the run conclusion.`,
    ``,
    `### Triggering article`,
    `- **Keyword**: ${keywordCode}`,
    `- **Category**: ${categoryCode}`,
    `- **kvKey**: ${kvKeyCode}`,
    `- **Live URL**: ${articleUrlDisplay}`,
    ``,
    `### Diagnostic access`,
    `Bearer-authenticate with \`$ADMIN_API_TOKEN\` (repo secret). Each endpoint is bearer-gated.`,
    `If \`$ADMIN_API_TOKEN\` is unavailable in your local clone, or the admin endpoint`,
    `is unreachable from your environment (for example DNS/network blocking),`,
    `skip the bearer-only diagnostics and choose a priority-(2) or priority-(3) improvement after`,
    `inspecting the checked-in code and running \`npm ci && npm run check\`.`,
    ``,
    `\`\`\`bash`,
    `if [ -n "$ADMIN_API_TOKEN" ]; then`,
    `  # Last 200 activity-log entries — look for repeated warnings or silent errors`,
    `  curl -sS -H "Authorization: Bearer $ADMIN_API_TOKEN" \\`,
    `    "${adminBase}/api/admin/logs?limit=200"`,
    ``,
    ...renderDiagnosticLines.map((line) => `  ${line}`),
    `else`,
    `  echo "ADMIN_API_TOKEN missing; skipping bearer-only diagnostics."`,
    `fi`,
    `\`\`\``,
    ``,
    `### Available skill docs`,
    `Before editing, read every SKILL.md that's relevant to the area you`,
    `intend to change. Pick from:`,
    ``,
    ...skillBullets,
    ``,
    `### Picking the improvement`,
    `Choose ONE of (in priority order):`,
    `1. A real bug or edge case visible in recent activity logs`,
    `   (\`/api/admin/logs?limit=200\`) — silent fall-throughs, swallowed`,
    `   errors, repeated warnings.`,
    `2. A code-quality issue: dead code, unused exports, duplicated logic,`,
    `   a TODO/FIXME with a clear fix, a missing-but-trivial test.`,
    `3. A small ergonomic improvement: a clearer log message, a missing`,
    `   JSDoc on an exported function, a typed \`unknown\` that should be`,
    `   typed properly.`,
    ``,
    `### Hard rules`,
    `- **Exactly one improvement per PR.** No drive-by refactors. If you`,
    `  notice a second issue, leave it for the next run.`,
    `- In a fresh clone, run \`npm ci\` before any validation commands.`,
    NPM_RUN_CHECK_RULE,
    `- Open the PR titled ${suggestedPrTitleCode}.`,
    `  Replace the suffix with the actual root cause/area you changed.`,
    `- Keep the exact title prefix case: \`improve(auto): \` (lowercase \`improve\`).`,
    `- Never use \`[WIP]\` in the PR title or leave the PR as draft once it exists.`,
    `- Never push to \`main\` directly.`,
    `- Never skip hooks, bypass lint, or edit secrets.`,
    `- Never edit generated files (\`worker-configuration.d.ts\`, \`env.d.ts\`, \`dist/\`, lockfiles unless adding/removing a dependency).`,
    `- Start by running \`search_code_subagent\` to locate relevant implementations before manual file inspection.`,
    `- If CI/build/test checks fail, inspect GitHub Actions with MCP tools:`,
    `  list workflow runs first, then fetch failed-job logs before coding a fix.`,
    `- Do not omit the branch filter in \`list_workflow_runs\` — unfiltered`,
    `  runs can include thousands of unrelated \`action_required\` entries and`,
    `  mislead your triage.`,
    `- Before running MCP CI queries, capture your exact branch with`,
    `  \`git rev-parse --abbrev-ref HEAD\` and use that exact output in the branch filter.`,
    `- When listing workflow runs for CI triage, filter to the \`sanity-check.yml\` workflow on your current PR branch`,
    `  (for example \`copilot/improve-auto-...\`) before inspecting logs so`,
    `  \`action_required\` runs from other branches or other workflows don't get misclassified as your failure.`,
    `- Example MCP filter: \`list_workflow_runs\` with ${sanityCheckWorkflowFilterExample}`,
    `  before fetching job logs.`,
    `- If a run is \`action_required\` with zero jobs (for example MCP logs say`,
    `  \`jobs.total_count: 0\` or \`total_jobs: 0\` and \`No failed jobs found in this workflow run\`), treat`,
    `  it as draft/\`[WIP]\` PR gating: rename to ${suggestedPrTitleCode}, mark`,
    `  ready-for-review, then re-check workflow runs before attempting a code fix.`,
    `- If you cannot find a clean improvement in **30 minutes**, close`,
    `  this issue with a one-line "no clean improvement found this run"`,
    `  comment. Do **not** force a low-quality PR.`,
    ``,
    `<!-- emitted by src/pipeline/improvement-agent.ts -->`
  ].join("\n");
}

function renderSkillDocBullets(slugs: readonly string[]): string[] {
  const uniqueByCaseInsensitiveSlug = new Map<string, string>();
  for (const slug of slugs) {
    const trimmed = slug.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!uniqueByCaseInsensitiveSlug.has(key)) {
      uniqueByCaseInsensitiveSlug.set(key, trimmed);
    }
  }
  const canonicalSlugs = [...uniqueByCaseInsensitiveSlug.values()]
    .filter((slug) => /^[A-Za-z0-9_-]+$/.test(slug))
    .sort((a, b) => a.localeCompare(b));
  if (canonicalSlugs.length === 0) {
    return [
      "- _No local skill docs were detected in `.claude/skills/`; choose a priority-2 or priority-3 improvement from checked-in code._"
    ];
  }
  return canonicalSlugs.map((slug) => `- \`.claude/skills/${slug}/SKILL.md\``);
}

function renderIssueBodyField(value: string, fallback: string): string {
  const normalized = normalizeSingleLine(value).trim();
  return renderMarkdownInlineCode(normalized || fallback);
}

function buildSuggestedImprovementPrTitle(): string {
  const suffixMaxBytes = Math.max(
    0,
    SUGGESTED_PR_TITLE_MAX_BYTES - SUGGESTED_PR_TITLE_PREFIX_BYTES
  );
  const suffix = truncateUtf8ToMaxBytes(
    SUGGESTED_PR_TITLE_SUFFIX,
    suffixMaxBytes
  );
  return `${SUGGESTED_PR_TITLE_PREFIX}${suffix}`;
}

function buildImprovementIssueTitle(keyword: string): string {
  const normalizedKeyword = normalizeSingleLine(keyword).trim();
  const fallbackSuffix = IMPROVEMENT_ISSUE_TITLE_FALLBACK_SUFFIX;
  const suffix = truncateUtf8ToMaxBytes(
    normalizedKeyword || fallbackSuffix,
    IMPROVEMENT_ISSUE_TITLE_SUFFIX_MAX_BYTES
  );
  return `${IMPROVEMENT_ISSUE_TITLE_PREFIX}${suffix || fallbackSuffix}`;
}

interface RollbackPreIssueDedupKeyOptions {
  dedupKey: string;
  didWriteDedupKey: boolean;
  keyword: string;
  kvKey: string;
  categorySlug: string;
  failureContext: string;
}

async function rollbackPreIssueDedupKey(
  agent: SEOArticleAgent,
  options: RollbackPreIssueDedupKeyOptions
): Promise<void> {
  if (!options.didWriteDedupKey) {
    return;
  }
  // Best-effort rollback so a failed create/dispatch doesn't burn the
  // dedup TTL window. See escalate-to-claude.ts #4732.
  try {
    await agent.envBindings.ARTICLES_KV.delete(options.dedupKey);
  } catch (rollbackErr: unknown) {
    agent.log(
      "warning",
      `Improvement Agent: failed to rollback pre-issue dedup key ${JSON.stringify(
        options.dedupKey
      )} for ${options.keyword} ${options.failureContext} (kvKey=${JSON.stringify(
        options.kvKey
      )}; category=${JSON.stringify(options.categorySlug)}): ${errMsg(
        rollbackErr
      )}`,
      "improvementAgent",
      { kanbanStage: "debug" }
    );
  }
}

function summarizeDedupMarkerDetail(rawMarker: string): string {
  const marker = normalizeSingleLine(rawMarker).trim();
  if (!marker) {
    return "dedup marker is empty";
  }

  const markerTimestamp = Number(marker);
  if (Number.isFinite(markerTimestamp) && markerTimestamp > 0) {
    const markerDate = new Date(markerTimestamp);
    if (!Number.isNaN(markerDate.getTime())) {
      return `dedup marker timestamp=${markerDate.toISOString()}`;
    }
  }

  return `dedup marker=${JSON.stringify(truncateUtf8ToMaxBytes(marker, 80))}`;
}

function truncateUtf8ToMaxBytes(value: string, maxBytes: number): string {
  if (!value || maxBytes <= 0) return "";
  if (UTF8_ENCODER.encode(value).length <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (UTF8_ENCODER.encode(value.slice(0, mid)).length <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return dropTrailingHighSurrogate(value.slice(0, low));
}

function dropTrailingHighSurrogate(value: string): string {
  if (!value) return value;
  const lastCode = value.charCodeAt(value.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? value.slice(0, -1) : value;
}

function capDedupKeyKvPart(value: string, maxBytes: number): string {
  if (!value || maxBytes <= 0) return "";
  if (UTF8_ENCODER.encode(value).length <= maxBytes) return value;

  const hash = fnv1aHash32Hex(value);
  let hashSuffix = `${DEDUP_TRUNCATION_HASH_SUFFIX_PREFIX}${hash}`;
  if (UTF8_ENCODER.encode(hashSuffix).length > maxBytes) {
    hashSuffix = truncateUtf8ToMaxBytes(hashSuffix, maxBytes);
  }
  const hashSuffixBytes = UTF8_ENCODER.encode(hashSuffix).length;
  const headMaxBytes = maxBytes - hashSuffixBytes;
  if (headMaxBytes <= 0) {
    return hashSuffix;
  }

  const head = truncateUtf8ToMaxBytes(value, headMaxBytes);
  return `${head}${hashSuffix}`;
}

/**
 * Return the 32-bit FNV-1a hash for a string as lowercase hex.
 *
 * Used when truncating oversized improvement-agent dedup keys so the
 * retained prefix still carries a cheap collision-resistant suffix.
 */
function fnv1aHash32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of UTF8_ENCODER.encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // 32-bit unsigned hashes are up to 8 hex chars (0xFFFFFFFF).
  return hash.toString(16).padStart(DEDUP_TRUNCATION_HASH_HEX_LENGTH, "0");
}

/**
 * Canonical article URL used in improvement-issue diagnostics.
 * Prefers a normalized published URL only when it still points at the
 * article identified by `kvKey`; otherwise falls back to the canonical
 * article path derived from `kvKey`.
 * Returns empty string when neither source yields a valid
 * `https://catsluvus.com/<category>/<slug>` article URL.
 */
function resolveRenderableArticleUrl(
  articleUrl: string | URL,
  kvKey: string
): string {
  const normalizedArticleUrl = normalizeRenderableArticleUrl(articleUrl);
  const derivedArticleUrlFromKvKey = deriveRenderableArticleUrl(kvKey);
  if (!derivedArticleUrlFromKvKey) {
    return normalizedArticleUrl;
  }
  if (normalizedArticleUrl === derivedArticleUrlFromKvKey) {
    return normalizedArticleUrl;
  }
  return derivedArticleUrlFromKvKey;
}

/**
 * Normalizes published article metadata to the canonical live article URL.
 * Returns empty string for non-HTTPS, non-catsluvus hosts, non-default
 * ports, URLs that are
 * not exactly an article path (`/<category>/<slug>`), or path segments
 * that are not slug-like. Query strings and hash fragments are stripped
 * and the result is normalized to `https://catsluvus.com/...`.
 */
function normalizeRenderableArticleUrl(value: string | URL): string {
  const trimmed =
    typeof value === "string" ? value.trim() : value.toString().trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:") {
    return "";
  }
  if (
    parsed.hostname !== "catsluvus.com" &&
    parsed.hostname !== "www.catsluvus.com"
  ) {
    return "";
  }
  const pathSegments = getTwoSegmentPath(parsed.pathname);
  if (!pathSegments) {
    return "";
  }
  const normalizedPathSegments = pathSegments.map((segment) =>
    segment.trim().toLowerCase()
  );
  if (!normalizedPathSegments.every(isSlugLikePathSegment)) {
    return "";
  }
  // The WHATWG URL parser normalises default ports (http:80, https:443) to
  // the empty string, so explicit "80"/"443" comparisons were removed as they
  // could never be true and represented dead code.
  if (parsed.port) {
    return "";
  }
  parsed.hostname = "catsluvus.com";
  parsed.port = "";
  parsed.pathname = `/${normalizedPathSegments.join("/")}`;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function deriveRenderableArticleUrl(kvKey: string): string {
  const normalizedKvKey = normalizeSingleLine(kvKey).trim().toLowerCase();
  const kvKeyPath = deriveArticlePathFromKvKey(normalizedKvKey);
  if (!kvKeyPath) {
    return "";
  }
  return `https://catsluvus.com/${kvKeyPath.normalizedCategorySlug}/${kvKeyPath.normalizedArticleSlug}`;
}

function deriveArticlePathFromKvKey(normalizedKvKey: string): {
  normalizedCategorySlug: string;
  normalizedArticleSlug: string;
} | null {
  const parts = normalizedKvKey
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // kvKey shape is strictly "<categorySlug>:<articleSlug>".
  // Reject extra ":" segments so malformed keys do not override a valid
  // published article URL with an incorrect derived fallback URL.
  if (parts.length !== 2) {
    return null;
  }
  const normalizedCategorySlug = normalizeSlugLikePathSegment(parts[0]);
  const normalizedArticleSlug = normalizeSlugLikePathSegment(parts[1]);
  if (!normalizedCategorySlug || !normalizedArticleSlug) {
    return null;
  }
  return { normalizedCategorySlug, normalizedArticleSlug };
}

function deriveArticlePathDedupSuffixFromUrl(
  normalizedArticleUrl: string
): string {
  if (!normalizedArticleUrl) {
    return "";
  }
  try {
    const parsed = new URL(normalizedArticleUrl);
    const pathSegments = getTwoSegmentPath(parsed.pathname);
    if (!pathSegments) {
      return "";
    }
    return `${pathSegments[0]}:${pathSegments[1]}`;
  } catch {
    return "";
  }
}

function getTwoSegmentPath(pathname: string): [string, string] | null {
  const pathSegments = pathname
    .split("/")
    .filter((segment) => segment.trim().length > 0);
  if (pathSegments.length !== 2) {
    return null;
  }
  return [pathSegments[0], pathSegments[1]];
}

function normalizeSlugLikePathSegment(value: string): string {
  const normalized = value.trim().toLowerCase();
  return isSlugLikePathSegment(normalized) ? normalized : "";
}

function isSlugLikePathSegment(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function normalizeInputField(
  agent: SEOArticleAgent,
  fieldName: keyof ImprovementInput,
  value: unknown
): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    agent.log(
      "warning",
      `Improvement Agent: coerced primitive input field ${fieldName} (type=${describeInputFieldType(
        value
      )}; value=${describeInputFieldValue(value)}) to string`,
      "improvementAgent",
      { kanbanStage: "debug" }
    );
    return String(value);
  }
  agent.log(
    "warning",
    `Improvement Agent: coerced non-string input field ${fieldName} (type=${describeInputFieldType(
      value
    )}; value=${describeInputFieldValue(value)}) to empty string`,
    "improvementAgent",
    { kanbanStage: "debug" }
  );
  return "";
}

function normalizeArticleUrlField(
  agent: SEOArticleAgent,
  value: unknown
): string {
  if (!isUrlLikeObject(value)) {
    return normalizeInputField(agent, "articleUrl", value ?? "");
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (typeof value.href === "string" && value.href.trim().length > 0) {
    try {
      new URL(value.href);
      return value.href;
    } catch {
      // Ignore invalid href and fall through to a validated toString() result.
    }
  }
  try {
    return value.toString();
  } catch (error: unknown) {
    agent.log(
      "warning",
      `Improvement Agent: failed to render URL-like articleUrl via toString() (type=${describeInputFieldType(
        value
      )}; value=${describeInputFieldValue(value)}) — falling back to empty string: ${errMsg(
        error
      )}`,
      "improvementAgent",
      { kanbanStage: "debug" }
    );
    return "";
  }
}

function describeInputFieldType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function isUrlLikeObject(value: unknown): value is UrlLikeInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (value instanceof URL) {
    return true;
  }
  const urlLike = value as {
    href?: unknown;
    toString?: () => string;
  };
  if (typeof urlLike.href === "string") {
    try {
      new URL(urlLike.href);
      return true;
    } catch {
      // Ignore invalid href and try toString fallback.
    }
  }
  if (typeof urlLike.toString === "function") {
    try {
      const rendered = urlLike.toString.call(value);
      if (typeof rendered === "string" && rendered.trim().length > 0) {
        new URL(rendered);
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function describeInputFieldValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return JSON.stringify(
      truncateUtf8ToMaxBytes(normalizeSingleLine(value), 120) || "(empty)"
    );
  }
  const type = typeof value;
  if (type === "number" || type === "boolean" || type === "bigint") {
    return String(value);
  }
  if (type === "undefined") {
    return "undefined";
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string" && serialized.length > 0) {
      return truncateUtf8ToMaxBytes(serialized, 120);
    }
  } catch {
    return `[${describeInputFieldType(value)}; unserializable]`;
  }
  return `[${describeInputFieldType(value)}]`;
}
