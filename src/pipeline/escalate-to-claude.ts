/**
 * escalate-to-claude.ts — open a GitHub issue labeled `claude-fix` when the
 * article pipeline hits a self-diagnosable failure mode.
 *
 * The issue is assigned to GitHub Copilot Coding Agent, which reads the
 * runbook in the issue body and calls the worker's bearer-protected
 * `/api/admin/*` endpoints to inspect logs, raw Kimi output, and published
 * HTML before opening a fix PR.
 *
 * Design rules (all enforced here):
 *   • NEVER throw. Escalation is best-effort; a failing issue POST must not
 *     crash or retry the article pipeline.
 *   • Rate-limit per `<kvKey>:<category>` via KV to prevent issue spam when
 *     the same keyword fails multiple retries in the same hour.
 *   • Every escalation is mirrored to the activity log under role
 *     `codingAgent` so operators can see in the dashboard that the Coding
 *     Agent was invoked for this article.
 *   • No secrets in the issue body — only kvKey/keyword/error category.
 *     Raw Kimi output is fetched by Copilot via the authenticated
 *     `/api/admin/kimi-raw/<kvKey>` endpoint.
 */

import type { SEOArticleAgent } from "../server";
import { isActivityLogErrorLevel } from "../activityLogLevels";
import { loggedFetch } from "./api-logger";
import {
  errMsg,
  keywordToSlug,
  normalizeSingleLine,
  redactSecrets
} from "./http-utils";

/**
 * Substrings that Cloudflare's Durable Object runtime inserts into errors
 * thrown when a DO is reset for any transient infrastructure reason.  Any
 * error whose message contains one of these strings is a transient event —
 * NOT a code bug — and must not be escalated to GitHub.
 *
 * Known variants:
 *   1. Reset triggered by a new code deployment.
 *   2. Reset triggered by an internal storage error (eviction, memory
 *      pressure, etc.) — this surfaces as a SqlError from `_setStateInternal`
 *      with the message "SQL query failed: Internal error in Durable Object
 *      storage caused object to be reset."
 *   3. Transient Durable Object storage connectivity issue — this can surface
 *      as "SQL query failed: Network connection lost."
 */
const DO_RESET_MESSAGE_FRAGMENTS: readonly string[] = [
  "Durable Object reset because its code was updated",
  "Internal error in Durable Object storage caused object to be reset",
  "SQL query failed: Network connection lost"
];

/**
 * Returns true when `err` is a transient Cloudflare Durable Object reset
 * error (deployment eviction or internal storage reset).  Callers should
 * rethrow these errors rather than escalating them, so they propagate up to
 * the `autonomousLoop` catch block, which keeps the keyword in `generating`
 * state.  `onStart()` then automatically resets `generating → pending` so
 * the article is retried on the next cycle.
 */
export function isDurableObjectResetError(err: unknown): boolean {
  const messages = collectErrorMessages(err);
  return messages.some((msg) => {
    const normalized = msg.toLowerCase();
    return DO_RESET_MESSAGE_FRAGMENTS.some((fragment) =>
      normalized.includes(fragment.toLowerCase())
    );
  });
}

export const NPM_RUN_CHECK_RULE =
  "- Run `npm run check` before committing (format, lint, typecheck, and tests).";

function collectErrorMessages(err: unknown): string[] {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null) continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof AggregateError) {
      messages.push(current.message);
      if ("cause" in current) {
        queue.push((current as AggregateError & { cause?: unknown }).cause);
      }
      for (const nested of current.errors) {
        queue.push(nested);
      }
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if ("cause" in current) {
        queue.push((current as Error & { cause?: unknown }).cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const candidate = current as {
        message?: unknown;
        cause?: unknown;
        errors?: unknown;
      };
      if (typeof candidate.message === "string") {
        messages.push(candidate.message);
      }
      if ("cause" in candidate) {
        queue.push(candidate.cause);
      }
      if (Array.isArray(candidate.errors)) {
        for (const nested of candidate.errors) {
          queue.push(nested);
        }
      }
      continue;
    }

    messages.push(String(current));
  }

  return messages;
}

/** Categorises the failure so the coding-agent prompt is targeted. */
export type EscalationCategory =
  | "publish-gate-leak"
  | "post-publish-live-leak"
  | "content-fingerprint-missing"
  | "content-gate-too-thin"
  | "kimi-empty-or-errored"
  | "pipeline-unknown-failure"
  | "pipeline-hang-timeout"
  | "low-quality-publish"
  | "generate-one-failed"
  | "parser-error"
  | "prepub-h1-count-regression";

export interface EscalationInput {
  kvKey: string;
  keyword: string;
  categorySlug: string;
  errorCategory: EscalationCategory;
  errorMessage: string;
  /** Optional extra context — e.g. word count, leak markers, retry count. */
  metadata?: Record<string, string | number | boolean>;
}

/** Repo coordinates are hard-wired — this is a single-repo Worker. */
const REPO_OWNER = "techfundoffice";
const REPO_NAME = "cats-seo-aiagent-staging";
const ADMIN_BASE = "https://cats-seo-aiagent.webmaster-bc8.workers.dev";

/**
 * Returns the GitHub repo owner, preferring the `REPO_OWNER` env var so
 * forks or staging deployments can override without code changes.
 *
 * Exported so `improvement-agent.ts` can reuse the same resolution rule.
 */
export function getRepoOwner(agent: SEOArticleAgent): string {
  return agent.envBindings.REPO_OWNER?.trim() || REPO_OWNER;
}

/**
 * Returns the GitHub repo name, preferring the `REPO_NAME` env var so
 * forks or staging deployments can override without code changes.
 *
 * Exported so `improvement-agent.ts` can reuse the same resolution rule.
 */
export function getRepoName(agent: SEOArticleAgent): string {
  return agent.envBindings.REPO_NAME?.trim() || REPO_NAME;
}

/**
 * Returns the Worker base URL for admin API calls, preferring the
 * `WORKER_BASE_URL` env var so forks or staging deployments can override
 * without code changes.
 *
 * Exported so `improvement-agent.ts` can build its own diagnostic runbook
 * using the same URL resolution rule.
 */
export function getAdminBase(agent: SEOArticleAgent): string {
  return normalizeBaseUrl(agent.envBindings.WORKER_BASE_URL) || ADMIN_BASE;
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    const isLocalHost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
    const isHttps = parsed.protocol === "https:";
    const isLocalHttp = parsed.protocol === "http:" && isLocalHost;
    if (!isHttps && !isLocalHttp) {
      return "";
    }
    const normalizedPath =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    return "";
  }
}

/** 1h dedup window so a flaky keyword doesn't open the same issue repeatedly. */
const DEDUP_TTL_SECONDS = 60 * 60;
const MAX_ESCALATION_METADATA_VALUE_LENGTH = 200;
const MAX_ESCALATION_ERROR_MESSAGE_LENGTH = 500;

// (The local `redactSecrets` helper was moved into
// `http-utils.ts` as `redactSecrets` so the same pattern set covers
// every leak sink — agent.log activity entries, sheet mirror,
// dashboard render, defect-findings evidence, GitHub issue bodies.
// See `redactSecrets` in http-utils.ts.)

/**
 * Fire-and-forget escalation. Logs to the activity feed under role
 * `codingAgent`, dedups via KV, opens a GitHub issue on miss. Swallows every
 * error — caller must never branch on the outcome.
 */
export async function escalateToCodingAgent(
  agent: SEOArticleAgent,
  input: EscalationInput
): Promise<void> {
  // Transient Cloudflare infrastructure event — not a code bug.  Suppress
  // entirely so we don't spam the issue tracker on every deployment.
  if (isDurableObjectResetError(new Error(input.errorMessage))) {
    return;
  }
  const { kvKey, keyword, errorCategory } = input;
  const safeKeyword = getSafeKeyword(keyword);
  const safeKvKey = normalizeSingleLine(kvKey).trim();
  const ghToken = agent.envBindings.GITHUB_TOKEN_SECRET?.trim();
  if (!ghToken) {
    agent.log(
      "warning",
      `Coding Agent: skipping issue (no GITHUB_TOKEN_SECRET) for ${safeKeyword}`,
      "codingAgent",
      { kanbanStage: "debug" }
    );
    return;
  }

  const safeKeywordSlug = keywordToSlug(safeKeyword) || "unknown-keyword";
  if (!safeKvKey) {
    agent.log(
      "warning",
      `Coding Agent: using fallback dedup key for ${errorCategory} on ${JSON.stringify(
        safeKeyword
      )} (missing kvKey)`,
      "codingAgent",
      { kanbanStage: "debug" }
    );
  }
  const dedupKeyKvPart = safeKvKey || `missing-kvkey:${safeKeywordSlug}`;
  const dedupKey = `escalation-dedup:${dedupKeyKvPart}:${errorCategory}`;
  try {
    const seen = await agent.envBindings.ARTICLES_KV.get(dedupKey);
    if (seen !== null) {
      agent.log(
        "info",
        `Coding Agent: deduped ${errorCategory} for ${safeKeyword} (kvKey=${safeKvKey || "null"}; key=${dedupKey}; fired <${DEDUP_TTL_SECONDS}s ago)`,
        "codingAgent",
        { kanbanStage: "debug" }
      );
      return;
    }
  } catch (err: unknown) {
    if (isDurableObjectResetError(err)) {
      agent.log(
        "info",
        `Coding Agent: suppressed transient Durable Object reset during dedup read for ${errorCategory} on "${safeKeyword}" (continuing without dedup)`,
        "codingAgent",
        { kanbanStage: "debug" }
      );
    } else {
      agent.log(
        "warning",
        `Coding Agent: dedup read failed for ${errorCategory} on "${safeKeyword}" (continuing): ${errMsg(
          err
        )}`,
        "codingAgent",
        { kanbanStage: "debug" }
      );
    }
  }

  const title = `[auto] ${errorCategory}: ${safeKeyword.slice(0, 80)}`;
  const adminBase = getAdminBase(agent);
  const body = renderIssueBody(input, adminBase);

  // Write the dedup key FIRST so a transient KV failure after issue
  // creation can't produce duplicate issues + duplicate Copilot PRs.
  // The previous ordering (issue create → KV.put) had this exact race:
  // if the put silently failed (CF KV transient error), the next
  // escalation within DEDUP_TTL_SECONDS would think the key was fresh
  // and open another issue. Better to occasionally MISS an
  // escalation (when KV.put fails AND we never rollback) than to
  // spam duplicates. If issue creation fails after this write, the
  // catch block below deletes the dedup record so the next attempt
  // can retry — preventing the "lost escalation" failure mode.
  try {
    await agent.envBindings.ARTICLES_KV.put(dedupKey, String(Date.now()), {
      expirationTtl: DEDUP_TTL_SECONDS
    });
  } catch (err: unknown) {
    if (isDurableObjectResetError(err)) {
      agent.log(
        "info",
        `Coding Agent: suppressed transient Durable Object reset during pre-issue dedup write for ${errorCategory} on "${safeKeyword}"`,
        "codingAgent",
        { kanbanStage: "debug" }
      );
    } else {
      agent.log(
        "warning",
        `Coding Agent: pre-issue dedup write failed for ${errorCategory} on "${safeKeyword}" (continuing without dedup — duplicate-issue risk): ${errMsg(err)}`,
        "codingAgent",
        { kanbanStage: "debug" }
      );
    }
  }

  try {
    const data = await createIssueDirect(agent, ghToken, {
      owner: getRepoOwner(agent),
      repo: getRepoName(agent),
      title,
      body,
      labels: ["claude-fix", "auto"]
    });
    if (!data) {
      agent.log(
        "error",
        `Coding Agent: direct GitHub issue create failed for ${safeKeyword} (see prior warning for HTTP detail). Rolling back dedup record so next attempt can retry.`,
        "codingAgent",
        { kanbanStage: "debug" }
      );
      // Best-effort rollback so a failed create doesn't burn the
      // dedup TTL window. Swallow rollback errors — at worst the
      // next attempt waits up to DEDUP_TTL_SECONDS to retry.
      try {
        await agent.envBindings.ARTICLES_KV.delete(dedupKey);
      } catch {
        /* best-effort */
      }
      return;
    }
    const issueRef = data.number ? `#${data.number}` : "(unknown #)";
    const issueUrlSuffix = data.html_url ? ` — ${data.html_url}` : "";
    agent.log(
      "info",
      `Coding Agent: opened issue ${issueRef} for ${errorCategory} on ${JSON.stringify(
        safeKeyword
      )}${issueUrlSuffix}`,
      "codingAgent",
      { kanbanStage: "debug" }
    );

    // Delegate to GitHub Copilot Coding Agent so it opens the fix PR
    // autonomously. Uses the user's existing Copilot subscription; no
    // expiring tokens. Fire-and-forget: issue is already open and operators
    // can still assign manually if this call fails.
    if (data.node_id && data.number) {
      try {
        await assignCopilotToIssue(
          agent,
          data.node_id,
          data.number,
          safeKeyword
        );
      } catch (err: unknown) {
        agent.log(
          "warning",
          `Coding Agent: Copilot assignment failed for ${issueRef} (${safeKeyword}): ${errMsg(
            err
          )}`,
          "codingAgent",
          { kanbanStage: "debug" }
        );
      }
    }

    // (Dedup KV-write moved BEFORE issue creation above to prevent
    // duplicate issues on transient KV-write failure — see the
    // pre-issue try/catch block.)
  } catch (err: unknown) {
    if (isDurableObjectResetError(err)) {
      agent.log(
        "info",
        `Coding Agent: suppressed transient Durable Object reset during dispatch for ${errorCategory} on "${safeKeyword}"`,
        "codingAgent",
        { kanbanStage: "debug" }
      );
      return;
    }
    agent.log(
      "error",
      `Coding Agent: issue POST threw for ${safeKeyword}: ${errMsg(err)}`,
      "codingAgent",
      { kanbanStage: "debug" }
    );
    // Rollback the pre-issue dedup record so the next attempt can
    // retry. Best-effort — at worst the next attempt waits up to
    // DEDUP_TTL_SECONDS to retry, same fallback as the !data branch.
    try {
      await agent.envBindings.ARTICLES_KV.delete(dedupKey);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Normalizes escalation keywords for single-line titles/logs and falls back
 * to a stable placeholder when the input is blank after trimming.
 *
 * Exported so `improvement-agent.ts` can reuse the same normalization rule
 * without duplicating the implementation.
 */
export function getSafeKeyword(value: string): string {
  return normalizeSingleLine(value) || "(empty keyword)";
}

/**
 * Create a GitHub issue via the REST API directly. Historically this
 * went through a hosted tool-proxy whose connection could drop, at which
 * point every issue-create returned `null` and
 * the auto-heal loop loses its exit valve. The direct path uses the
 * `GITHUB_TOKEN_SECRET` worker secret already required for article
 * backups — no extra config.
 *
 * Exported so `improvement-agent.ts` can post its own issues without
 * duplicating ~50 lines of REST plumbing. Behaviour identical for both
 * callers — only the title/body/labels differ.
 */
export async function createIssueDirect(
  agent: SEOArticleAgent,
  token: string,
  input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels: string[];
    logPrefix?: string;
    logRole?: "codingAgent" | "improvementAgent";
  }
): Promise<{ number?: number; html_url?: string; node_id?: string } | null> {
  const logPrefix = input.logPrefix ?? "Coding Agent";
  const logRole = input.logRole ?? "codingAgent";
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`;
  let resp: Response;
  try {
    resp = await loggedFetch(
      agent,
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "cats-seo-aiagent-coding-agent",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          labels: input.labels
        })
      },
      { api: "GitHub", op: "create issue" }
    );
  } catch (err: unknown) {
    agent.log(
      "warning",
      `${logPrefix}: GitHub REST POST /issues threw: ${errMsg(err)}`,
      logRole,
      { kanbanStage: "debug" }
    );
    return null;
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    agent.log(
      "warning",
      `${logPrefix}: GitHub REST POST /issues HTTP ${resp.status}: ${formatGitHubResponseSnippet(detail)}`,
      logRole,
      { kanbanStage: "debug" }
    );
    return null;
  }
  const rawBody = await resp.text().catch(() => "");
  if (!rawBody.trim()) {
    agent.log(
      "warning",
      `${logPrefix}: GitHub REST POST /issues returned an empty success body`,
      logRole,
      { kanbanStage: "debug" }
    );
    return null;
  }
  try {
    return JSON.parse(rawBody) as {
      number?: number;
      html_url?: string;
      node_id?: string;
    };
  } catch (err: unknown) {
    agent.log(
      "warning",
      `${logPrefix}: GitHub REST POST /issues returned non-JSON success body: ${formatGitHubResponseSnippet(
        rawBody
      )} (parse error: ${errMsg(err)})`,
      logRole,
      { kanbanStage: "debug" }
    );
    return null;
  }
}

/** Markdown body the coding agent reads when it picks up the issue. */
function renderIssueBody(input: EscalationInput, adminBase: string): string {
  const {
    kvKey,
    keyword,
    categorySlug,
    errorCategory,
    errorMessage,
    metadata
  } = input;
  const keywordCode = renderMarkdownInlineCode(keyword);
  const categoryCode = renderMarkdownInlineCode(categorySlug);
  const kvKeyCode = renderMarkdownInlineCode(kvKey);
  // Redact secret-shaped substrings BEFORE truncation so a key that
  // straddles the cut isn't half-leaked. The issue body is
  // world-readable on github.com — see `redactSecrets`.
  const errorLine = redactSecrets(normalizeSingleLine(errorMessage)).slice(
    0,
    MAX_ESCALATION_ERROR_MESSAGE_LENGTH
  );
  // force:true — this runbook command is meant to run only after a real
  // code fix has landed, so it should always be able to resurrect a
  // keyword that /api/admin/retry has since marked 'abandoned' (3+ failed
  // attempts). Without force, a keyword that failed 3 times before the fix
  // landed would stay stuck refusing retry even after the root cause is
  // fixed.
  const retryPayload = renderShellSingleQuoted(
    JSON.stringify({ keyword, purgeKv: true, force: true })
  );
  const liveRenderArticleUrl = resolveEscalationRenderableArticleUrl(
    categorySlug,
    kvKey
  );
  const liveRenderDiagnosticLines = liveRenderArticleUrl
    ? [
        `# Live-rendered HTML (post-JS, post-deploy) via Cloudflare Browser`,
        `# Rendering. Prefer this over /api/admin/kv when verifying a fix`,
        `# actually landed on the live site.`,
        `curl -sS -H "Authorization: Bearer $ADMIN_API_TOKEN" \\`,
        `  "${adminBase}/api/admin/render?url=${encodeURIComponent(liveRenderArticleUrl)}"`
      ]
    : [
        `# Live-rendered HTML unavailable (categorySlug/kvKey did not produce`,
        `# a valid article URL path).`
      ];
  const metaLines = metadata
    ? Object.entries(metadata).map(
        ([k, v]) =>
          `- **${k}**: ${renderMarkdownInlineCode(
            redactSecrets(String(v)).slice(
              0,
              MAX_ESCALATION_METADATA_VALUE_LENGTH
            )
          )}`
      )
    : [];

  return [
    `## Autonomous Coding Agent escalation`,
    ``,
    `The article pipeline hit \`${errorCategory}\` on a generated article.`,
    `Investigate and open a PR fixing the root cause.`,
    ``,
    `### Failed article`,
    `- **Keyword**: ${keywordCode}`,
    `- **Category**: ${categoryCode}`,
    `- **kvKey**: ${kvKeyCode}`,
    `- **Error**: ${errorLine}`,
    ...(metaLines.length ? [``, `### Pipeline context`, ...metaLines] : []),
    ``,
    `### Diagnostic runbook`,
    `Bearer-authenticate with \`$ADMIN_API_TOKEN\` (repo secret). Each endpoint is bearer-gated.`,
    ``,
    `\`\`\`bash`,
    `# Raw Kimi output that produced this article (48h TTL)`,
    `curl -sS -H "Authorization: Bearer $ADMIN_API_TOKEN" \\`,
    `  ${adminBase}/api/admin/kimi-raw/${encodeURIComponent(kvKey)}`,
    ``,
    `# Published HTML (if the article made it past the publish gate)`,
    `curl -sS -H "Authorization: Bearer $ADMIN_API_TOKEN" \\`,
    `  ${adminBase}/api/admin/kv/${encodeURIComponent(kvKey)}`,
    ``,
    ...liveRenderDiagnosticLines,
    ``,
    `# Last 200 activity-log entries (JSON)`,
    `curl -sS -H "Authorization: Bearer $ADMIN_API_TOKEN" \\`,
    `  "${adminBase}/api/admin/logs?limit=200"`,
    ``,
    `# After landing a fix, retry this keyword:`,
    `curl -sS -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${retryPayload} \\`,
    `  ${adminBase}/api/admin/retry`,
    `\`\`\``,
    ``,
    `### Rules for the coding agent`,
    `- Fix the root cause in \`src/\`, not in test data or config.`,
    `- If tools are missing in a fresh clone, run \`npm ci\` first.`,
    NPM_RUN_CHECK_RULE,
    `- Open a PR titled \`fix(auto): [one-line root cause]\`. Never push to \`main\` directly.`,
    `- Never skip hooks, bypass lint, or edit secrets.`,
    `- If the root cause is in raw Kimi output (hallucination), fix the writer prompt.`,
    `- If it's a post-process bug (parser, gate, truncation), fix the code path.`,
    `- Close this issue with \`Fixes #<issue>\` in the PR description when merging.`,
    ``,
    `<!-- emitted by src/pipeline/escalate-to-claude.ts -->`
  ].join("\n");
}

/**
 * Wrap `value` in a CommonMark-safe inline code span.
 *
 * Algorithm (per CommonMark §6.1):
 *  1. Collapse newlines to spaces so the span stays on one line.
 *  2. Count the longest run of consecutive backticks inside `value`.
 *     The opening/closing fence must be one backtick longer than that
 *     maximum run — otherwise a backtick inside the content would
 *     prematurely close the span.
 *  3. When `value` itself starts or ends with a backtick, CommonMark
 *     requires a single space of padding inside the fence so the
 *     parser does not treat the backtick as part of the delimiter.
 *
 * Used by both the Coding-Agent escalation issue body and the
 * self-improvement issue body to render keywords, kvKeys, and category
 * slugs as inline code without risking Markdown injection.
 */
export function renderMarkdownInlineCode(value: string): string {
  const singleLine = value.replaceAll(/\r\n?|\n/g, " ");
  const backtickRuns = singleLine.match(/`+/g);
  const maxBacktickRunLength = backtickRuns
    ? Math.max(...backtickRuns.map((run) => run.length))
    : 0;
  const fence = "`".repeat(maxBacktickRunLength + 1);
  const content =
    singleLine.startsWith("`") || singleLine.endsWith("`")
      ? ` ${singleLine} `
      : singleLine;
  return `${fence}${content}${fence}`;
}

function formatGitHubResponseSnippet(text: string): string {
  return normalizeSingleLine(text).slice(0, 240);
}

function renderShellSingleQuoted(value: string): string {
  const shellEscapedSingleQuote = `'"'"'`;
  return `'${value.split("'").join(shellEscapedSingleQuote)}'`;
}

function resolveEscalationRenderableArticleUrl(
  categorySlug: string,
  kvKey: string
): string {
  const normalizedCategorySlug = normalizeEscalationSlug(categorySlug);
  const separatorIndex = kvKey.indexOf(":");
  if (separatorIndex <= 0) {
    return "";
  }
  const kvCategorySlug = normalizeEscalationSlug(
    kvKey.slice(0, separatorIndex)
  );
  const articleSlug = normalizeEscalationSlug(kvKey.slice(separatorIndex + 1));
  if (!kvCategorySlug || !articleSlug) {
    return "";
  }
  if (normalizedCategorySlug && normalizedCategorySlug !== kvCategorySlug) {
    return "";
  }
  const resolvedCategorySlug = normalizedCategorySlug || kvCategorySlug;
  return `https://catsluvus.com/${resolvedCategorySlug}/${articleSlug}`;
}

function normalizeEscalationSlug(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = normalizeSingleLine(value).trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : "";
}

// Matches both legacy V8 ("Unexpected token") and modern V8 9.4+ descriptive
// JSON-parse error messages ("Expected ':' after property name in JSON at
// position N", "No number after minus sign in JSON at position N", etc.)
// used by the Cloudflare Workers runtime (~2022+).
const PARSER_ERROR_PATTERN =
  /(?:Unexpected token|Unexpected end of JSON|Unterminated string in JSON|is not valid JSON|Expected.*in JSON|Unexpected non-whitespace character after JSON|in JSON at position \d+)/i;

/**
 * Detects JSON-parse-crash patterns in a warning/error log message and
 * escalates as a `parser-error` — catches cases like
 *   `SERP (marginalia) failed: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
 * where an upstream provider returned HTML instead of JSON and our parser
 * threw. These are real code bugs (missing content-type check, missing
 * try/catch around JSON.parse) that the Coding Agent can fix.
 *
 * Non-parser warnings (HTTP 403 from upstream, rate limits, etc.) are
 * intentionally skipped — those are dependency health issues, not code
 * bugs, and would spam the issue tracker.
 *
 * Safe to call unconditionally from `agent.log()`: returns fast when the
 * level doesn't resolve to canonical `"error"` or the pattern doesn't
 * match.
 */
export async function maybeEscalateParserError(
  agent: SEOArticleAgent,
  params: {
    level: string;
    msg: string;
    keyword: string | undefined;
    categorySlug: string | undefined;
  }
): Promise<void> {
  // Only error-level logs (including legacy alias `err`). The SERP tier chain (serp.ts) logs its
  // JSON-decode failures at `warning` level because it's designed to fall
  // through to the next tier on failure — those are handled gracefully and
  // DO NOT warrant a Copilot issue. Real parser crashes (writer/Kimi output,
  // QC/polish repair paths, top-level try/catch) log at `error` level.
  if (!isActivityLogErrorLevel(params.level)) return;
  if (!PARSER_ERROR_PATTERN.test(params.msg)) return;
  // SERP tier warning format: `SERP (<tier>) failed: <msg>` is also
  // emitted at error level by some upstream paths; keep excluding those
  // since the chain still falls through after the log.
  if (/^SERP \([a-z-]+\) failed:/i.test(params.msg)) return;
  // Need at least a keyword + category to build a kvKey for dedup.
  const keyword = (params.keyword ?? "").trim();
  const categorySlug = (params.categorySlug ?? "").trim();
  if (!keyword || !categorySlug) return;
  const slug = keywordToSlug(keyword);
  const kvKey = `${categorySlug}:${slug}`;
  await escalateToCodingAgent(agent, {
    kvKey,
    keyword,
    categorySlug,
    errorCategory: "parser-error",
    errorMessage: params.msg.slice(0, 400),
    metadata: {
      logLevel: params.level,
      matchedPattern: "JSON.parse crash (upstream returned non-JSON)"
    }
  });
}

/**
 * Assigns the GitHub Copilot Coding Agent bot to a freshly-opened issue so
 * it produces a fix PR autonomously.
 *
 * Uses the GraphQL `replaceActorsForAssignable` mutation — the REST
 * `/assignees` endpoint does NOT accept the Copilot SWE bot (it validates
 * assignees against users with push access, and bot apps fail that check
 * with 422). GraphQL's `replaceActorsForAssignable` is the only surface
 * that GitHub supports for assigning Copilot to an issue; this is the
 * same call that `mcp__github__assign_copilot_to_issue` uses internally.
 *
 * Flow:
 *   1. Look up the Copilot bot's actor ID via the repo's `suggestedActors`
 *      GraphQL field. Cached in KV for 7 days to avoid re-querying on
 *      every failure.
 *   2. Call `replaceActorsForAssignable` with the issue's node_id + the
 *      bot's actor ID.
 *
 * Fire-and-forget: on any failure (Copilot not enabled on the repo, bot
 * not available, network error) the issue remains open with its
 * diagnostic runbook, and operators can still assign manually.
 *
 * Exported so `improvement-agent.ts` can hand its own freshly-opened
 * improvement issue to Copilot without duplicating the GraphQL plumbing.
 * The 7-day `copilot-bot-id` KV cache is shared between both callers, so
 * steady-state cost stays at one GraphQL roundtrip per assignment.
 */
export async function assignCopilotToIssue(
  agent: SEOArticleAgent,
  issueNodeId: string,
  issueNumber: number,
  keyword: string,
  options?: {
    logPrefix?: string;
    logRole?: "codingAgent" | "improvementAgent";
  }
): Promise<void> {
  const token = agent.envBindings.GITHUB_TOKEN_SECRET?.trim();
  if (!token) return;
  const safeKeyword = normalizeSingleLine(keyword) || "(empty keyword)";
  const logPrefix = options?.logPrefix ?? "Coding Agent";
  const logRole = options?.logRole ?? "codingAgent";
  try {
    const botId = await getCopilotBotActorId(agent, token, logPrefix, logRole);
    if (!botId) {
      agent.log(
        "warning",
        `${logPrefix}: Copilot bot not found in repo suggestedActors — issue #${issueNumber} (${safeKeyword}) stays unassigned. Possible cause: Copilot Coding Agent not enabled for this repo.`,
        logRole,
        { kanbanStage: "debug" }
      );
      return;
    }

    const mutation = `
      mutation AssignCopilot($assignableId: ID!, $actorIds: [ID!]!) {
        replaceActorsForAssignable(input: {
          assignableId: $assignableId,
          actorIds: $actorIds
        }) {
          assignable {
            ... on Issue { number }
          }
        }
      }
    `;
    const raw = await runGitHubGraphQL(
      agent,
      token,
      mutation,
      { assignableId: issueNodeId, actorIds: [botId] },
      logPrefix,
      logRole
    );
    if (!raw) {
      agent.log(
        "warning",
        `${logPrefix}: Copilot GraphQL assignment direct call returned null for issue #${issueNumber} (${safeKeyword})`,
        logRole,
        { kanbanStage: "debug" }
      );
      return;
    }
    if (raw.errors.length > 0) {
      agent.log(
        "warning",
        `${logPrefix}: Copilot GraphQL assignment failed for issue #${issueNumber} (${safeKeyword}): ${raw.errors.join("; ").slice(0, 300)}`,
        logRole,
        { kanbanStage: "debug" }
      );
      return;
    }
    agent.log(
      "info",
      `${logPrefix}: assigned Copilot to issue #${issueNumber} (${safeKeyword}) — PR pending`,
      logRole,
      { kanbanStage: "debug" }
    );
  } catch (err: unknown) {
    agent.log(
      "warning",
      `${logPrefix}: Copilot assignment threw for issue #${issueNumber} (${safeKeyword}): ${errMsg(err)}`,
      logRole,
      { kanbanStage: "debug" }
    );
  }
}

/**
 * Direct GitHub GraphQL call. Direct REST/GraphQL for the same reason as
 * `createIssueDirect`. Returns `{ data, errors }` on a parseable response,
 * or `null` on transport/HTTP failure (caller already logs).
 *
 * `logPrefix` and `logRole` are threaded from the outermost caller so that
 * transport/HTTP errors show up under the correct dashboard role (e.g.
 * "improvementAgent" when called from the self-improvement loop rather than
 * the failure-escalation path).
 */
async function runGitHubGraphQL(
  agent: SEOArticleAgent,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  logPrefix: string,
  logRole: "codingAgent" | "improvementAgent"
): Promise<{ data: unknown; errors: string[] } | null> {
  let resp: Response;
  try {
    resp = await loggedFetch(
      agent,
      "https://api.github.com/graphql",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "cats-seo-aiagent-coding-agent",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables })
      },
      { api: "GitHub", op: "graphql" }
    );
  } catch (err: unknown) {
    agent.log(
      "warning",
      `${logPrefix}: GitHub GraphQL POST threw: ${errMsg(err)}`,
      logRole,
      { kanbanStage: "debug" }
    );
    return null;
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    agent.log(
      "warning",
      `${logPrefix}: GitHub GraphQL HTTP ${resp.status}: ${formatGitHubResponseSnippet(detail)}`,
      logRole,
      { kanbanStage: "debug" }
    );
    return null;
  }
  const json = (await resp.json().catch(() => null)) as {
    data?: unknown;
    errors?: Array<{ message?: string }>;
  } | null;
  if (!json) return null;
  const errors = Array.isArray(json.errors)
    ? json.errors
        .map((e) => (typeof e?.message === "string" ? e.message : ""))
        .filter((m) => m.length > 0)
    : [];
  return { data: json.data ?? null, errors };
}

/**
 * Looks up the Copilot SWE bot's GraphQL actor ID for this repo. Result
 * is cached in KV under `copilot-bot-id:<owner>/<repo>` with 7-day TTL —
 * the bot ID is stable per repo so we don't need to re-query on every
 * escalation. Returns `null` if Copilot isn't available on this repo.
 */
const COPILOT_BOT_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

async function getCopilotBotActorId(
  agent: SEOArticleAgent,
  token: string,
  logPrefix: string,
  logRole: "codingAgent" | "improvementAgent"
): Promise<string | null> {
  const owner = getRepoOwner(agent);
  const name = getRepoName(agent);
  const cacheKey = `copilot-bot-id:${owner}/${name}`;
  try {
    const cached = await agent.envBindings.ARTICLES_KV.get(cacheKey);
    if (cached) return cached;
  } catch (e: unknown) {
    agent.log(
      "warning",
      `${logPrefix}: Copilot bot-ID cache read failed (${cacheKey}) — falling through to GraphQL query (${errMsg(e)})`,
      logRole,
      { kanbanStage: "debug" }
    );
  }

  const query = `
    query FindCopilotBot($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
          nodes {
            __typename
            ... on Bot { id login }
            ... on User { id login }
          }
        }
      }
    }
  `;
  type SuggestedActorNode = { id?: string; login?: string };
  const raw = await runGitHubGraphQL(
    agent,
    token,
    query,
    { owner, name },
    logPrefix,
    logRole
  );
  if (!raw || raw.errors.length > 0) return null;
  const gqlData = raw.data as {
    repository?: { suggestedActors?: { nodes?: SuggestedActorNode[] } };
  } | null;
  const nodes: SuggestedActorNode[] =
    gqlData?.repository?.suggestedActors?.nodes ?? [];
  const copilot = nodes.find(
    (n: SuggestedActorNode) =>
      n.login === "copilot-swe-agent" || n.login === "Copilot"
  );
  if (!copilot?.id) return null;
  try {
    await agent.envBindings.ARTICLES_KV.put(cacheKey, copilot.id, {
      expirationTtl: COPILOT_BOT_CACHE_TTL_SECONDS
    });
  } catch (e: unknown) {
    agent.log(
      "warning",
      `${logPrefix}: Copilot bot-ID cache write failed (${cacheKey}) — will re-query on next call (${errMsg(e)})`,
      logRole,
      { kanbanStage: "debug" }
    );
  }
  return copilot.id;
}
