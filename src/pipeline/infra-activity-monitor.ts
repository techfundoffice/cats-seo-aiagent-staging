/**
 * Infrastructure Activity Monitor — pure helpers for the dashboard panel.
 *
 * Three live feeds (GitHub / OpenAI / Milvus) share two pieces of logic:
 *
 *   1. Status-dot classification — given the newest event in a feed,
 *      decide whether the dot is green (recent success), yellow (stale),
 *      or red (latest event was an error).
 *
 *   2. OpenAI cost estimate — given a model name and a token count,
 *      return the USD cost using the published per-1M-token rates.
 *
 * Both are pure functions so they can be reused on both ends (server
 * for endpoint responses, client for dashboard rendering) and so they
 * are trivially unit-testable.
 *
 * No I/O. No state.
 */

/** Status dot for the panel header — derived from the newest feed event. */
export type FeedStatus = "green" | "yellow" | "red" | "unknown";

/** How long since the last event counts as "fresh"? Anything older is stale. */
export const FRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Classify a feed's health by looking at the newest event.
 *
 * - `red`     — newest event is an error/failure (regardless of age).
 * - `green`   — newest event is non-error AND within FRESH_WINDOW_MS.
 * - `yellow`  — newest event is non-error but older than FRESH_WINDOW_MS.
 * - `unknown` — no events at all.
 */
export function classifyFeedStatus(
  newestEvent: { timestamp: string | Date; isError: boolean } | null,
  now: Date = new Date()
): FeedStatus {
  if (!newestEvent) return "unknown";
  if (newestEvent.isError) return "red";
  const ts =
    newestEvent.timestamp instanceof Date
      ? newestEvent.timestamp
      : new Date(newestEvent.timestamp);
  const ageMs = now.getTime() - ts.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  return ageMs <= FRESH_WINDOW_MS ? "green" : "yellow";
}

/**
 * OpenAI per-1M-token USD rates. Keep in lockstep with
 * https://openai.com/api/pricing/ — used for the cost rollup shown in
 * the OpenAI section's "rolling cost estimate".
 *
 * Only the models we actually call from this worker are listed. Adding
 * a new model: add the entry here AND wire the call site to pass the
 * model name into the activity-log instrumentation.
 */
export const OPENAI_RATES_USD_PER_1M_TOKENS: Readonly<
  Record<string, { input: number; output: number }>
> = {
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
  "text-embedding-ada-002": { input: 0.1, output: 0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 5.0, output: 15.0 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 }
};

/**
 * Compute the USD cost of a single OpenAI call. Returns 0 for unknown
 * models (caller can flag in UI as "rate not configured") so the
 * rolling estimate never goes NaN.
 */
export function estimateOpenAiCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number = 0
): number {
  const rate = OPENAI_RATES_USD_PER_1M_TOKENS[model];
  if (!rate) return 0;
  const inputCost = (Math.max(0, promptTokens) / 1_000_000) * rate.input;
  const outputCost = (Math.max(0, completionTokens) / 1_000_000) * rate.output;
  return inputCost + outputCost;
}

/** Single OpenAI API call record used by `aggregateOpenAiCalls`. */
export interface OpenAiCallRecord {
  model: string;
  promptTokens: number;
  completionTokens: number;
  isError: boolean;
}

/**
 * Aggregate a list of OpenAI call records into the rolling totals
 * shown in the OpenAI section header (calls / tokens / cost).
 */
export function aggregateOpenAiCalls(calls: readonly OpenAiCallRecord[]): {
  calls: number;
  errorCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  estimatedUsdTotal: number;
} {
  let errorCalls = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let estimatedUsdTotal = 0;
  for (const c of calls) {
    if (c.isError) errorCalls++;
    totalPromptTokens += Math.max(0, c.promptTokens);
    totalCompletionTokens += Math.max(0, c.completionTokens);
    estimatedUsdTotal += estimateOpenAiCostUsd(
      c.model,
      c.promptTokens,
      c.completionTokens
    );
  }
  return {
    calls: calls.length,
    errorCalls,
    totalPromptTokens,
    totalCompletionTokens,
    estimatedUsdTotal
  };
}

/**
 * Format a USD amount (dollars, not cents) into a compact display
 * string for the dashboard ($0.0023, $0.42, $12.50). Uses 4 decimals
 * for sub-$1 values to surface real signal on embedding-only
 * workloads where individual calls cost fractions of a cent.
 */
export function formatUsdCompact(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Parsed OpenAI activity-log row. The msg format on the wire is:
 *   `[OpenAI embed] model=... tokens=N latency=Nms status=ok|error [error="..."]`
 * Lenient parser — missing/malformed fields default sensibly so the
 * dashboard never crashes on a partial-write log line.
 */
export interface ParsedOpenAiRow {
  timestamp: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: "ok" | "error";
  errorReason?: string;
}

export interface ParsedMilvusRow {
  timestamp: string;
  collection: string;
  hits: number;
  latencyMs: number;
  status: "ok" | "error";
  errorReason?: string;
}

function getField(msg: string, key: string): string | undefined {
  // Match `key=value` (unquoted) OR `key="..."` (quoted).
  const quoted = new RegExp(`\\b${key}="((?:[^"\\\\]|\\\\.)*)"`).exec(msg);
  if (quoted) return quoted[1];
  const bare = new RegExp(`\\b${key}=(\\S+)`).exec(msg);
  return bare?.[1];
}

function intField(msg: string, key: string, fallback = 0): number {
  const v = getField(msg, key);
  if (!v) return fallback;
  const m = v.match(/\d+/);
  return m ? parseInt(m[0], 10) : fallback;
}

/**
 * Resolve the timestamp for a parsed activity-log row. Order of
 * preference:
 *
 *   1. `ts=...` field embedded in the log msg — timezone-safe ISO
 *      written by the producer at log-emit time. Use this when
 *      present; client-side staleness math is reliable.
 *   2. `timeDate timeTime` on the entry — legacy LA-local format
 *      that `Date.parse()` interprets in the viewer's local
 *      timezone (can wrongly flag green→red on travel/locale
 *      changes). Tolerable fallback only.
 *   3. `new Date().toISOString()` — last-resort default so parsers
 *      never emit a null timestamp the UI would crash on.
 */
function resolveRowTimestamp(
  msg: string,
  entry: { timeDate?: string; timeTime?: string }
): string {
  const tsField = getField(msg, "ts");
  if (tsField && !Number.isNaN(Date.parse(tsField))) return tsField;
  if (entry.timeDate && entry.timeTime) {
    return `${entry.timeDate} ${entry.timeTime}`;
  }
  return new Date().toISOString();
}

/**
 * Parse a `[OpenAI ...]` activity-log entry. Accepts an entry shape
 * matching `{ msg, timeDate?, timeTime?, errorMessage? }`; only `msg`
 * is required. Prefers an in-msg `ts=<ISO>` for timezone-safe
 * timestamps (Copilot review feedback on #5480) and falls back to
 * the legacy LA-local timeDate/timeTime when absent.
 */
export function parseOpenAiActivityMsg(entry: {
  msg?: string;
  timeDate?: string;
  timeTime?: string;
  errorMessage?: string;
}): ParsedOpenAiRow {
  const msg = entry.msg ?? "";
  const status = getField(msg, "status") === "error" ? "error" : "ok";
  return {
    timestamp: resolveRowTimestamp(msg, entry),
    model: getField(msg, "model") ?? "unknown",
    promptTokens: intField(msg, "tokens"),
    completionTokens: 0, // embedding-only at runtime
    latencyMs: intField(msg, "latency"),
    status,
    errorReason:
      status === "error"
        ? (getField(msg, "error") ?? entry.errorMessage)
        : undefined
  };
}

/**
 * Parse a `[Milvus ...]` activity-log entry. Same lenient semantics
 * as `parseOpenAiActivityMsg` (including the timezone-safe
 * `ts=<ISO>` preference).
 */
export function parseMilvusActivityMsg(entry: {
  msg?: string;
  timeDate?: string;
  timeTime?: string;
  errorMessage?: string;
}): ParsedMilvusRow {
  const msg = entry.msg ?? "";
  const status = getField(msg, "status") === "error" ? "error" : "ok";
  return {
    timestamp: resolveRowTimestamp(msg, entry),
    collection: getField(msg, "collection") ?? "unknown",
    hits: intField(msg, "hits"),
    latencyMs: intField(msg, "latency"),
    status,
    errorReason:
      status === "error"
        ? (getField(msg, "error") ?? entry.errorMessage)
        : undefined
  };
}
