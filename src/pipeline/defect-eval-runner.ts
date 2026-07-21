/**
 * defect-eval-runner.ts — Stage 5 of the per-defect-class self-improving
 * loop.
 *
 * What this module adds:
 *
 *   Given a `runId` (the Stage 3 eval-set handle) and a
 *   `candidateBranch` (Copilot's fix branch), produce a
 *   pass/fail report by:
 *
 *     1. Reading the `EvalSpec` from KV.
 *     2. Fetching the candidate branch's source files
 *        (`editorial-agent.ts` + `editorial-lessons.ts`) via the GitHub
 *        Contents API.
 *     3. Evaluating each `EvalCheck` from the spec against the
 *        candidate source text — the "static prompt eval" path
 *        documented as Option A in the plan.
 *     4. Persisting the aggregated result to KV
 *        `eval-result:<runId>:<candidateBranch>:<timestamp>` for audit.
 *
 * Why "static prompt eval", not runtime output eval:
 *
 *   The plan's Option A (call Kimi from the prod worker with the
 *   candidate prompt + each sample's original HTML) requires
 *   extracting the candidate's prompt from source — fragile across
 *   refactors — and burns ~3×N Kimi calls per eval run. Option B
 *   (deploy each candidate branch as a Workers preview, run the eval
 *   against the preview URL) requires preview-deploy CI plumbing that
 *   doesn't exist yet.
 *
 *   Stage 5 v1 uses a third path that's strictly cheaper than both:
 *   evaluate the candidate's prompt SOURCE TEXT against the spec's
 *   patterns. For prompt-shape defects (the entire reason
 *   `rewrite-fragment-not-document` exists) this is the right
 *   abstraction — if the candidate prompt mentions `<!DOCTYPE html>`,
 *   `<head>`, `<body>`, and `application/ld+json`, the rewrite is
 *   overwhelmingly likely to emit them. Stage 6 measures whether even
 *   this minimal eval is enough.
 *
 *   The response includes `mode: "source-static"` + a `runtimeEvalNote`
 *   so consumers can tell at a glance which path produced the verdict.
 */

import type { SEOArticleAgent } from "../server";
import { type EvalCheck, readEvalSet } from "./defect-eval-builder";
import { getRepoName, getRepoOwner } from "./escalate-to-claude";
import { errMsg } from "./http-utils";

/**
 * Per-check result inside one sample's evaluation. `passed` is the
 * boolean verdict. `note` carries human-readable context (which
 * candidate-source substring matched, or why the check was indeterminate)
 * so the issue PR comment can quote a concrete reason without re-running
 * the eval.
 */
export interface CheckResult {
  id: string;
  kind: EvalCheck["kind"];
  passed: boolean;
  note: string;
}

export interface SampleResult {
  kvKey: string;
  checks: CheckResult[];
  passed: boolean;
}

export interface EvalRunResult {
  runId: string;
  candidateBranch: string;
  passed: number;
  of: number;
  samples: SampleResult[];
  /** Mode of evaluation. Today only `source-static` exists. */
  mode: "source-static";
  /** Honest disclosure of what the eval mode does/does not check. */
  runtimeEvalNote: string;
  durationMs: number;
  /** UTC ISO. */
  ranAt: string;
}

/** Fetched candidate source. Both files are loaded once per eval run. */
interface CandidateSource {
  editorialAgentTs: string;
  editorialLessonsTs: string;
}

/**
 * The two source files the eval inspects. If/when more defect classes
 * scope to different files, this list grows — but the candidate source
 * fetch is cached per-call so even adding a file is one extra HTTP.
 */
const CANDIDATE_SOURCE_PATHS = [
  "src/pipeline/editorial-agent.ts",
  "src/pipeline/editorial-lessons.ts"
] as const;

/**
 * Static heuristic mapping for `regex-must-match` checks: the spec's
 * pattern is a regex against the rewrite output, but Stage 5 v1
 * evaluates against the candidate's prompt source instead. We extract
 * the literal alphabetic tokens from the pattern (e.g. `DOCTYPE`,
 * `html`, `head`, `body`) and require ALL of them to appear in the
 * candidate source, case-insensitive. If the pattern has no
 * alphabetic tokens at all, the check is marked indeterminate and
 * fails (forcing Copilot to use a more descriptive pattern next
 * cycle).
 */
function extractLiteralTokens(pattern: string): string[] {
  const tokens = pattern.match(/[A-Za-z]{3,}/g);
  if (!tokens) return [];
  return [...new Set(tokens.map((t) => t.toLowerCase()))];
}

function evaluateRegexMustMatch(
  check: Extract<EvalCheck, { kind: "regex-must-match" }>,
  candidateSource: string
): CheckResult {
  const tokens = extractLiteralTokens(check.pattern);
  if (tokens.length === 0) {
    return {
      id: check.id,
      kind: check.kind,
      passed: false,
      note: `pattern ${check.pattern} has no literal tokens — Stage 5 v1 source-static eval cannot evaluate. Replace with a pattern containing literal text Kimi must echo.`
    };
  }
  const haystack = candidateSource.toLowerCase();
  const missing = tokens.filter((t) => !haystack.includes(t));
  if (missing.length > 0) {
    return {
      id: check.id,
      kind: check.kind,
      passed: false,
      note: `candidate source missing tokens [${missing.join(", ")}] (extracted from pattern /${check.pattern}/${check.flags ?? ""}). Add explicit prompt instructions mentioning these.`
    };
  }
  return {
    id: check.id,
    kind: check.kind,
    passed: true,
    note: `candidate source contains all tokens [${tokens.join(", ")}] (extracted from pattern /${check.pattern}/${check.flags ?? ""}).`
  };
}

function evaluateRegexMustNotMatch(
  check: Extract<EvalCheck, { kind: "regex-must-not-match" }>,
  candidateSource: string
): CheckResult {
  // Symmetric to must-match: if ALL literal tokens are present in the
  // candidate source, that's likely instructing Kimi to emit the bad
  // pattern, so fail. Otherwise pass with a note that this check is
  // weak under source-static evaluation.
  const tokens = extractLiteralTokens(check.pattern);
  if (tokens.length === 0) {
    return {
      id: check.id,
      kind: check.kind,
      passed: true,
      note: `pattern ${check.pattern} has no literal tokens — source-static eval defaults to pass; would be re-evaluated under runtime eval.`
    };
  }
  const haystack = candidateSource.toLowerCase();
  const present = tokens.filter((t) => haystack.includes(t));
  if (present.length === tokens.length) {
    return {
      id: check.id,
      kind: check.kind,
      passed: false,
      note: `candidate source contains all tokens [${tokens.join(", ")}] of forbidden pattern /${check.pattern}/${check.flags ?? ""} — likely instructing Kimi to emit the forbidden shape.`
    };
  }
  return {
    id: check.id,
    kind: check.kind,
    passed: true,
    note: `candidate source missing at least one token of forbidden pattern (present: [${present.join(", ")}]).`
  };
}

function evaluateJsonLdCount(
  check: Extract<EvalCheck, { kind: "jsonld-block-count-gte-original" }>,
  candidateSource: string
): CheckResult {
  const markers = [
    "application/ld+json",
    "ld+json",
    "json-ld",
    "JSON-LD",
    "jsonld"
  ];
  const haystack = candidateSource.toLowerCase();
  const found = markers.find((m) => haystack.includes(m.toLowerCase()));
  if (found) {
    return {
      id: check.id,
      kind: check.kind,
      passed: true,
      note: `candidate source references JSON-LD (found marker "${found}"); prompt likely instructs Kimi to preserve structured-data blocks.`
    };
  }
  return {
    id: check.id,
    kind: check.kind,
    passed: false,
    note: `candidate source contains no JSON-LD reference. Add an explicit prompt instruction to preserve every <script type="application/ld+json"> block.`
  };
}

function evaluateSeoDelta(
  check: Extract<EvalCheck, { kind: "seo-score-delta-gte" }>,
  candidateSource: string
): CheckResult {
  const haystack = candidateSource.toLowerCase();
  const hasSeoMention = haystack.includes("seo");
  const hasPreserveMention =
    haystack.includes("preserve") ||
    haystack.includes("keep") ||
    haystack.includes("retain");
  if (hasSeoMention && hasPreserveMention) {
    return {
      id: check.id,
      kind: check.kind,
      passed: true,
      note: `candidate source mentions SEO and preserve/keep/retain — prompt likely instructs Kimi to hold the SEO-relevant elements (threshold ${check.threshold}).`
    };
  }
  return {
    id: check.id,
    kind: check.kind,
    passed: false,
    note: `candidate source lacks SEO-preservation language (seoMention=${hasSeoMention}, preserveMention=${hasPreserveMention}). Add explicit instructions to preserve <title>, <h1>, headings, links, alt, meta, OG/Twitter, JSON-LD.`
  };
}

function evaluateCheck(check: EvalCheck, candidateSource: string): CheckResult {
  switch (check.kind) {
    case "regex-must-match":
      return evaluateRegexMustMatch(check, candidateSource);
    case "regex-must-not-match":
      return evaluateRegexMustNotMatch(check, candidateSource);
    case "jsonld-block-count-gte-original":
      return evaluateJsonLdCount(check, candidateSource);
    case "seo-score-delta-gte":
      return evaluateSeoDelta(check, candidateSource);
  }
}

/**
 * Fetch a single source file from a candidate branch via the GitHub
 * Contents API. Uses the same `GITHUB_TOKEN_SECRET` as the escalation
 * path. Returns the file's raw text, or null on any failure.
 */
async function fetchCandidateFile(
  agent: SEOArticleAgent,
  token: string,
  path: string,
  candidateBranch: string
): Promise<string | null> {
  const owner = getRepoOwner(agent);
  const repo = getRepoName(agent);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(candidateBranch)}`;
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // raw media type returns the file content directly (text/plain)
        // rather than the JSON envelope with base64 payload — avoids a
        // base64 decode round-trip.
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cats-seo-aiagent-eval-runner"
      }
    });
    if (!resp.ok) {
      agent.log(
        "warning",
        `Defect eval-runner: fetch ${path}@${candidateBranch} HTTP ${resp.status}`,
        "codingAgent",
        { kanbanStage: "debug" }
      );
      return null;
    }
    return await resp.text();
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Defect eval-runner: fetch ${path}@${candidateBranch} threw: ${errMsg(err)}`,
      "codingAgent",
      { kanbanStage: "debug" }
    );
    return null;
  }
}

async function fetchCandidateSource(
  agent: SEOArticleAgent,
  candidateBranch: string
): Promise<CandidateSource | { error: string }> {
  const token = agent.envBindings.GITHUB_TOKEN_SECRET?.trim();
  if (!token) {
    return { error: "GITHUB_TOKEN_SECRET not configured on the worker" };
  }
  const [editorialAgentTs, editorialLessonsTs] = await Promise.all(
    CANDIDATE_SOURCE_PATHS.map((p) =>
      fetchCandidateFile(agent, token, p, candidateBranch)
    )
  );
  if (editorialAgentTs === null) {
    return { error: `failed to fetch editorial-agent.ts@${candidateBranch}` };
  }
  if (editorialLessonsTs === null) {
    return { error: `failed to fetch editorial-lessons.ts@${candidateBranch}` };
  }
  return { editorialAgentTs, editorialLessonsTs };
}

const RUNTIME_EVAL_NOTE =
  "Stage 5 v1: source-static eval. Each check's literal tokens are matched against the candidate's editorial-agent.ts + editorial-lessons.ts source text (case-insensitive). A pass means the candidate's prompt LIKELY instructs Kimi to emit the right shape; a true runtime eval (preview deploy + actual Kimi call against each sample's original HTML) is the planned Option B follow-up. The verdict is mechanical and deterministic — but it does not exercise the model.";

/**
 * Entry point invoked by the `POST /api/admin/run-defect-eval` handler.
 *
 * Returns a structured `EvalRunResult` on success; throws only for
 * caller-side errors (bad runId, candidate fetch failure). The handler
 * translates those into HTTP 4xx/5xx; aggregate per-sample failures are
 * a SUCCESS path (HTTP 200 with `passed < of`).
 *
 * Persists the result under `eval-result:<runId>:<branch>:<ts>` for
 * audit so the Stage 6 measurement can correlate eval verdicts with
 * post-deploy convergence.
 */
export async function runDefectEval(
  agent: SEOArticleAgent,
  runId: string,
  candidateBranch: string
): Promise<
  | { ok: true; result: EvalRunResult }
  | { ok: false; status: number; error: string }
> {
  const start = Date.now();
  const spec = await readEvalSet(agent, runId);
  if (!spec) {
    return { ok: false, status: 404, error: `eval-set not found: ${runId}` };
  }
  const trimmedBranch = candidateBranch.trim();
  if (!trimmedBranch) {
    return { ok: false, status: 400, error: "candidateBranch required" };
  }
  const sourceResult = await fetchCandidateSource(agent, trimmedBranch);
  if ("error" in sourceResult) {
    return { ok: false, status: 502, error: sourceResult.error };
  }
  const combinedSource = `${sourceResult.editorialAgentTs}\n\n${sourceResult.editorialLessonsTs}`;

  const samples: SampleResult[] = spec.samples.map((sample) => {
    const checks = spec.successCriterion.perSample.map((check) =>
      evaluateCheck(check, combinedSource)
    );
    return {
      kvKey: sample.kvKey,
      checks,
      passed: checks.every((c) => c.passed)
    };
  });
  const passedCount = samples.filter((s) => s.passed).length;
  const result: EvalRunResult = {
    runId,
    candidateBranch: trimmedBranch,
    passed: passedCount,
    of: samples.length,
    samples,
    mode: "source-static",
    runtimeEvalNote: RUNTIME_EVAL_NOTE,
    durationMs: Date.now() - start,
    ranAt: new Date().toISOString()
  };

  try {
    const key = `eval-result:${runId}:${trimmedBranch}:${result.ranAt.replace(/[:.]/g, "-")}`;
    await agent.envBindings.ARTICLES_KV.put(key, JSON.stringify(result));
  } catch (err: unknown) {
    // Persisting the audit trail is best-effort — if KV is unavailable
    // we still return the verdict to the caller.
    agent.log(
      "warning",
      `Defect eval-runner: failed to persist eval result for runId=${runId} branch=${trimmedBranch}: ${errMsg(err)}`,
      "codingAgent",
      { kanbanStage: "debug" }
    );
  }

  agent.log(
    "info",
    `Defect eval-runner: runId=${runId} branch=${trimmedBranch} passed=${result.passed}/${result.of} durationMs=${result.durationMs}`,
    "codingAgent",
    { kanbanStage: "debug" }
  );
  return { ok: true, result };
}
