import { errMsg, normalizeSingleLine, repairJson } from "./http-utils";
import { generateText } from "ai";
import type { ActivityLogEntry, SEOArticleAgent } from "../server";
import { formatActivityLogModelPromptCell } from "../activityLogSheetColumns";
import { isActivityLogWarningOrErrorLevel } from "../activityLogLevels";
import { getKimiModel, getKimiProviderOptions } from "./kimi-model";
import {
  extractEmbeddedJsonCandidates,
  parseJsonStringValue
} from "../objectLike";

const SUMMARY_MAX_CHARS = 400;
const PIPELINE_CONTEXT_JSON_MAX = 8000;
const SUMMARY_FALLBACK_TEXT = "No error summary available.";
const JSON_SNIPPET_CANDIDATE_LIMIT = 5;
const INVALID_JSON_RESPONSE_PREVIEW_MAX_CHARS = 280;
const FALLBACK_REASON_PREVIEW_MAX_CHARS = 280;
const FALLBACK_LOG_MESSAGE_MAX_CHARS = 1200;

const JSON_CONTRACT_SYSTEM = `You are a senior on-call engineer for a Cloudflare Workers SEO article agent (Durable Object + SQLite, Workers AI, direct Google Sheets mirror, KV/R2 when applicable).

Return ONLY a single JSON object (no markdown fences, no commentary). Required keys:
- "summary": string, <=400 characters, concise human-readable error summary (do not paste the entire log message unless it is already short).
- "remediationUser": string, detailed USER-style instructions for an upstream LLM: what broke, why it matters, and concrete remediation steps that respect Worker CPU/time limits, Durable Object storage, Google Sheets API rate limits, and Workers AI constraints.`;

const REMEDIATION_CELL_SYSTEM = `You are assisting an engineer who will fix failures in a Cloudflare Workers SEO article Durable Object pipeline. Follow the USER block carefully; prefer minimal, verifiable changes and cite likely file areas (Worker entry, Durable Object class, pipeline modules) when obvious from context.`;

/**
 * Returns true only for log levels that should trigger remediation
 * generation. Info/debug entries are intentionally excluded so we only
 * spend model calls on warning/error rows.
 * Accepts legacy aliases: "warn" => "warning", "err" => "error".
 */
export function activityLogLevelsQualifyForErrorRemediation(
  level: ActivityLogEntry["level"]
): boolean {
  return isActivityLogWarningOrErrorLevel(level);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.length > 4000) {
    return `${value.slice(0, 3997)}...`;
  }
  return value;
}

function safePipelineContextJson(ctx: unknown): string {
  if (ctx == null) return "";
  try {
    const serialized = JSON.stringify(ctx, jsonReplacer, 2);
    if (typeof serialized !== "string") {
      return "[pipeline context unavailable: context is not JSON-serializable]";
    }
    if (serialized.length <= PIPELINE_CONTEXT_JSON_MAX) return serialized;
    return `${serialized.slice(0, PIPELINE_CONTEXT_JSON_MAX)}\n…`;
  } catch (error: unknown) {
    const reason = errMsg(error).trim() || "unknown serialization error";
    return `[pipeline context unavailable: ${reason}]`;
  }
}

function parseSummaryRemediation(
  text: string
): { summary: string; remediationUser: string } | null {
  const nestedContractKeys = [
    "result",
    "data",
    "output",
    "payload",
    "response",
    "response_data",
    "responseData"
  ] as const;
  const normalizeContractKey = (key: string): string =>
    key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const parseCandidate = (
    candidate: unknown
  ): { summary: string; remediationUser: string } | null => {
    if (!candidate || typeof candidate !== "object") return null;
    const records = Array.isArray(candidate) ? candidate : [candidate];
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        continue;
      }
      const rec = record as Record<string, unknown>;
      const recEntries = Object.entries(rec);
      const normalizedRec = new Map<string, unknown>();
      for (const [key, value] of recEntries) {
        const normalizedKey = normalizeContractKey(key);
        if (!normalizedRec.has(normalizedKey)) {
          normalizedRec.set(normalizedKey, value);
        }
      }
      const resolveField = (...aliases: string[]): unknown => {
        for (const alias of aliases) {
          if (alias in rec) return rec[alias];
          const normalizedAlias = normalizeContractKey(alias);
          if (normalizedRec.has(normalizedAlias)) {
            return normalizedRec.get(normalizedAlias);
          }
        }
        return undefined;
      };
      const summaryRaw = resolveField("summary");
      const remediationRaw = resolveField(
        "remediationUser",
        "remediation_user",
        "user",
        "remediation"
      );
      const summary = typeof summaryRaw === "string" ? summaryRaw.trim() : "";
      const remediationUser =
        typeof remediationRaw === "string" ? remediationRaw.trim() : "";
      if (summary !== "" && remediationUser !== "") {
        return { summary, remediationUser };
      }
      for (const nestedKey of nestedContractKeys) {
        const nested = resolveField(nestedKey);
        const nestedParsed = parseCandidate(nested);
        if (nestedParsed) return nestedParsed;
        const nestedParsedFromString = parseCandidate(
          parseJsonStringValue(nested)
        );
        if (nestedParsedFromString) return nestedParsedFromString;
      }
    }
    return null;
  };

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const normalized = parseCandidate(parsed);
      if (normalized) return normalized;
    } catch {
      try {
        const repaired = JSON.parse(repairJson(trimmed)) as unknown;
        const normalized = parseCandidate(repaired);
        if (normalized) return normalized;
      } catch {
        // Fall through to snippet extraction below.
      }
    }
  }

  const jsonCandidates = extractEmbeddedJsonCandidates(
    text,
    JSON_SNIPPET_CANDIDATE_LIMIT
  );
  for (const jsonCandidate of jsonCandidates) {
    try {
      let o: unknown;
      try {
        o = JSON.parse(jsonCandidate) as unknown;
      } catch {
        o = JSON.parse(repairJson(jsonCandidate)) as unknown;
      }
      const normalized = parseCandidate(o);
      if (normalized) return normalized;
    } catch {
      continue;
    }
  }
  return null;
}

function clampSummary(summary: string): string {
  const t = normalizeSingleLine(summary).trim();
  if (t === "") return SUMMARY_FALLBACK_TEXT;
  if (t.length <= SUMMARY_MAX_CHARS) return t;
  return `${t.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

function fallbackLogMessage(msg: unknown): string {
  let raw = typeof msg === "string" ? msg : errMsg(msg);
  if (
    typeof msg === "object" &&
    msg !== null &&
    (raw.trim() === "" || raw.trim().startsWith("[object "))
  ) {
    try {
      raw = JSON.stringify(msg, jsonReplacer, 2);
    } catch {
      // Keep `raw` from errMsg when object serialization fails.
    }
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("[object ")) {
    return SUMMARY_FALLBACK_TEXT;
  }
  if (trimmed.length <= FALLBACK_LOG_MESSAGE_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, FALLBACK_LOG_MESSAGE_MAX_CHARS - 1)}…`;
}

function formatPromptFieldValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? "—" : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "object") {
    return "—";
  }
  const fallback = errMsg(value).trim();
  if (fallback === "" || fallback.startsWith("[object ")) {
    return "—";
  }
  return fallback;
}

function formatInvalidContractResponseReason(responseText: string): string {
  const normalized = normalizeSingleLine(responseText);
  if (normalized === "") {
    return "Model response did not match the required JSON contract.";
  }
  const preview =
    normalized.length <= INVALID_JSON_RESPONSE_PREVIEW_MAX_CHARS
      ? normalized
      : `${normalized.slice(0, INVALID_JSON_RESPONSE_PREVIEW_MAX_CHARS - 1)}…`;
  return `Model response did not match the required JSON contract. Response preview: ${preview}`;
}

function formatFallbackReason(reason: string | null): string {
  if (!reason) return "";
  const normalized = normalizeSingleLine(reason).trim();
  if (normalized === "") return "";
  const preview =
    normalized.length <= FALLBACK_REASON_PREVIEW_MAX_CHARS
      ? normalized
      : `${normalized.slice(0, FALLBACK_REASON_PREVIEW_MAX_CHARS - 1)}…`;
  return `Fallback reason:\n${preview}\n\n`;
}

function buildFallback(
  entry: ActivityLogEntry,
  fallbackReason: string | null = null
): {
  summary: string;
  remediationCell: string;
} {
  const msg = fallbackLogMessage(entry.msg);
  const reasonBlock = formatFallbackReason(fallbackReason);
  const level = formatPromptFieldValue(entry.level);
  const stepNumber = formatPromptFieldValue(entry.stepNumber);
  const keyword = formatPromptFieldValue(entry.keyword);
  const categorySlug = formatPromptFieldValue(entry.categorySlug);
  const articleUrl = formatPromptFieldValue(entry.articleUrl);
  const user = `Automated JSON remediation output was missing or invalid.

Level: ${level}
Step #: ${stepNumber}
Keyword: ${keyword}
Category: ${categorySlug}
Article URL: ${articleUrl}

Message:
${msg}

${reasonBlock}Non-AI fallback checklist:
1) Inspect Worker / Durable Object logs for this article run (wrangler tail).
2) Confirm Google Sheets connectivity (service account) and header layout version drift.
3) Re-check Workers AI model availability and request limits for the failing call.
4) If this was a transient model/JSON parse failure, retry the failing pipeline step.`;
  return {
    summary: clampSummary(msg),
    remediationCell: formatActivityLogModelPromptCell(
      REMEDIATION_CELL_SYSTEM,
      user
    )
  };
}

/**
 * Workers AI enrichment for activity-log mirror: short summary + full
 * SYSTEM/USER remediation cell (truncated) for warning/error rows.
 */
export async function generateActivityLogErrorRemediationCell(
  agent: SEOArticleAgent,
  entry: ActivityLogEntry
): Promise<{ summary: string; remediationCell: string } | null> {
  if (!activityLogLevelsQualifyForErrorRemediation(entry.level)) {
    return null;
  }

  const pipelineSnippet = safePipelineContextJson(entry.pipelineContext);
  const level = formatPromptFieldValue(entry.level);
  const stepNumber = formatPromptFieldValue(entry.stepNumber);
  const timeDate = formatPromptFieldValue(entry.timeDate);
  const timeTime = formatPromptFieldValue(entry.timeTime);
  const keyword = formatPromptFieldValue(entry.keyword);
  const categorySlug = formatPromptFieldValue(entry.categorySlug);
  const articleUrl = formatPromptFieldValue(entry.articleUrl);
  const pipelineStepLabel = formatPromptFieldValue(entry.pipelineStepLabel);
  const activeRole = formatPromptFieldValue(entry.activeRole);
  const promptMessage = fallbackLogMessage(entry.msg);

  const user = `Log level: ${level}
Step #: ${stepNumber}
DATE: ${timeDate}
TIME: ${timeTime}
Keyword: ${keyword}
Category: ${categorySlug}
Article URL: ${articleUrl}
Pipeline step label: ${pipelineStepLabel}
Active role: ${activeRole}

Full message:
${promptMessage}

Pipeline context JSON (may be truncated):
${pipelineSnippet === "" ? "(none)" : pipelineSnippet}

Return JSON only with keys "summary" and "remediationUser" as described in the system message.`;

  try {
    const { text } = await generateText({
      model: getKimiModel(agent.envBindings),
      providerOptions: getKimiProviderOptions(agent.envBindings),
      system: JSON_CONTRACT_SYSTEM,
      prompt: user,
      maxOutputTokens: 2500,
      abortSignal: AbortSignal.timeout(90_000)
    });
    const parsed = parseSummaryRemediation(text);
    if (parsed) {
      return {
        summary: clampSummary(parsed.summary),
        remediationCell: formatActivityLogModelPromptCell(
          REMEDIATION_CELL_SYSTEM,
          parsed.remediationUser
        )
      };
    }
    return buildFallback(entry, formatInvalidContractResponseReason(text));
  } catch (error: unknown) {
    return buildFallback(entry, errMsg(error));
  }
}
