import { errMsg } from "./http-utils";
/**
 * ai-poll.ts
 *
 * Resilient wrapper for Cloudflare Workers AI text generation.
 *
 * EXECUTION ORDER:
 *  1. SYNC PATH (primary) — direct `ai.run()` with a 150s timeout.
 *     Workers AI IO-wait does NOT count against CPU quota, so the Worker
 *     can safely wait 2+ minutes for a large model to respond.
 *
 *  2. ASYNC BATCH PATH (fallback) — if sync throws or returns empty,
 *     submit with `queueRequest: true` and poll with exponential back-off.
 *     Capped at 90s so we bail fast when the batch queue stalls.
 *
 *  3. SYNC RETRY (fallback when async not supported) — if the async batch
 *     path fails with Workers AI error 8007 ("This model does not support
 *     request queuing", e.g. kimi-k2.5), retry the sync path once. The
 *     initial sync timeout is often a transient Workers AI overload.
 *
 *  4. CAPACITY RETRY (fallback for overloaded cluster) — if the sync path
 *     fails with Workers AI error 3040 ("Capacity temporarily exceeded") and
 *     the async batch path also times out (capacity still exhausted), wait
 *     60 s and retry the sync path once. The overload is transient and
 *     typically clears within a minute.
 *
 * Kimi K2.5 specifics:
 *  - thinking is enabled by default and consumes all max_tokens before
 *    producing content, returning content: null. We disable it via
 *    chat_template_kwargs on every call.
 *  - extractText reads reasoning_content as last-resort fallback when
 *    choices[0].message.content is null (K2.5 thinking overflow bug).
 *  - Do NOT pass stream: false in the body — the binding handles it.
 */

/** Minimal shape of the Cloudflare Ai binding we rely on. */
interface AiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

interface CompletedResponse {
  response?: string;
  result?: string;
  status?: string;
  error?: string;
  request_id?: string;
  choices?: Array<{
    message?: {
      content?:
        | string
        | null
        | Array<{
            type?: string;
            text?: string;
          }>;
      reasoning_content?: string;
      reasoning?: string;
    };
    text?: string;
  }>;
  /**
   * Batch API poll result: one entry per queued request. Elements are
   * either the completion object directly or a `{ id, success, result }`
   * wrapper around it, depending on model backend.
   */
  responses?: unknown[];
  [key: string]: unknown;
}

const MAX_ERROR_TEXT_NESTING_DEPTH = 3;
const NON_TERMINAL_BATCH_STATUSES = new Set([
  "queued",
  "running",
  "in_progress",
  "pending",
  "processing"
]);

function normalizeNonEmptyString(
  value: unknown,
  transform?: (value: string) => string
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = transform ? transform(value.trim()) : value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBatchStatus(value: unknown): string | undefined {
  return normalizeNonEmptyString(value, (normalized) =>
    normalized.toLowerCase()
  );
}

export interface AiPollOptions {
  /**
   * Timeout ms for the primary synchronous path.
   * Default: 150_000 (2.5 min).
   */
  syncTimeoutMs?: number;
  /**
   * Max total wait ms for the async batch fallback path.
   * Default: 90_000 (90s) — bail out fast if batch queue stalls.
   */
  asyncMaxWaitMs?: number;
  /** Initial poll interval ms. Default: 4_000. */
  initialPollMs?: number;
  /** Max poll interval ms (exponential cap). Default: 16_000. */
  maxPollMs?: number;
  /**
   * Optional callback for transient retry warnings (sync→async fallback,
   * "no queue support" retry). When provided, warnings are routed through
   * this callback instead of `console.warn` so callers with an agent
   * reference can surface them in the activity feed.
   *
   * Matches the `onWarn?` callback pattern used by `fetchGoogleAutocompletePAA`
   * in `autocomplete.ts`.
   */
  onWarn?: (msg: string) => void;
}

/**
 * Generate text using Workers AI.
 *
 * Always disables Kimi thinking mode so tokens are spent on content, not
 * reasoning. Tries synchronous call first; falls back to async batch+poll
 * only if sync fails or returns empty.
 */
export async function aiGenerateWithPoll(
  ai: AiBinding,
  model: string,
  params: {
    messages?: Array<{ role: string; content: string }>;
    prompt?: string;
    max_tokens?: number;
  },
  opts: AiPollOptions = {}
): Promise<string> {
  const {
    syncTimeoutMs: rawSyncTimeoutMs = 150_000,
    asyncMaxWaitMs: rawAsyncMaxWaitMs = 90_000,
    initialPollMs: rawInitialPollMs = 4_000,
    maxPollMs: rawMaxPollMs = 16_000,
    onWarn = (msg: string) => console.warn(msg)
  } = opts;
  const syncTimeoutMs = normalizePositiveMs(rawSyncTimeoutMs, 150_000);
  const asyncMaxWaitMs = normalizePositiveMs(rawAsyncMaxWaitMs, 90_000);
  const initialPollMs = normalizePositiveMs(rawInitialPollMs, 4_000);
  const maxPollMs = normalizePositiveMs(rawMaxPollMs, 16_000);
  const fallbackWindow = `syncTimeoutMs=${syncTimeoutMs}, asyncMaxWaitMs=${asyncMaxWaitMs}`;

  // Disable Kimi thinking mode so max_tokens are used for content output,
  // not internal reasoning.
  const callParams = {
    ...params,
    chat_template_kwargs: {
      thinking: false,
      enable_thinking: false,
      clear_thinking: true
    }
  };

  // ── Path 1: Synchronous call (preferred) ────────────────────────────────
  let syncError: string | null = null;
  try {
    const text = await syncGenerate(ai, model, callParams, syncTimeoutMs);
    if (text && text.trim().length > 0) return text;
    syncError = "sync returned empty response";
    onWarn(
      `[ai-poll] sync path returned empty response for ${model} (${fallbackWindow}); trying async batch`
    );
  } catch (err: unknown) {
    syncError = errMsg(err);
    onWarn(
      `[ai-poll] sync path failed for ${model} (${syncError}; ${fallbackWindow}); trying async batch`
    );
  }

  // ── Path 2: Async batch + poll (fallback) ────────────────────────────────
  try {
    // The Batch API requires the `requests: [...]` envelope — submitting
    // the bare single-request shape with queueRequest:true gets accepted
    // at enqueue time but the job then fails validation ("1 validation
    // error for VllmBatchRequest", internalCode 3030), which is what
    // killed 100 editorial rewrites on @cf/qwen/qwen3-30b-a3b-fp8 on
    // 6/10-6/11. Both the qwen batch schema and the Kimi K2.5 async-API
    // changelog document the requests-array envelope.
    const queued = toCompletedResponse(
      await ai.run(model, { requests: [callParams] }, { queueRequest: true })
    );

    if (!queued?.request_id) {
      if (normalizeBatchStatus(queued?.status) === "error" || queued?.error) {
        const asyncErrorDetail =
          queued?.error?.trim() || "Status: error (no detail provided)";
        throw new Error(
          `Workers AI batch error for ${model}: ${asyncErrorDetail}`
        );
      }
      const text = extractText(queued);
      if (text && text.trim().length > 0) return text;
      const asyncStatus = normalizeBatchStatus(queued?.status) ?? "unknown";
      throw new Error(
        `aiGenerateWithPoll: async batch returned no request_id and no text for ${model} ` +
          `(status: ${asyncStatus}; sync error: ${syncError})`
      );
    }

    const { request_id } = queued as { request_id: string };
    const deadline = Date.now() + asyncMaxWaitMs;
    let pollDelay = initialPollMs;
    let lastPollError: string | null = null;
    let terminalStatusWithoutText: string | null = null;

    while (Date.now() < deadline) {
      await sleep(pollDelay);
      pollDelay = Math.min(pollDelay * 2, maxPollMs);

      let pollResult: CompletedResponse;
      try {
        pollResult = toCompletedResponse(await ai.run(model, { request_id }));
        lastPollError = null;
      } catch (pollErr: unknown) {
        lastPollError = errMsg(pollErr);
        continue;
      }

      const status = normalizeBatchStatus(pollResult?.status);
      if (status && NON_TERMINAL_BATCH_STATUSES.has(status)) continue;

      if (status === "error" || pollResult?.error) {
        throw new Error(
          `Workers AI batch error for ${model}: ${String(pollResult?.error ?? "unknown")}`
        );
      }

      const text = extractText(pollResult);
      if (text && text.trim().length > 0) return text;
      terminalStatusWithoutText = status ?? "unknown";
      break;
    }

    if (terminalStatusWithoutText !== null) {
      throw new Error(
        `aiGenerateWithPoll: model ${model} completed without text output — ` +
          `sync: ${syncError}; async status: ${terminalStatusWithoutText}${
            lastPollError ? `; last poll error: ${lastPollError}` : ""
          }`
      );
    }

    throw new Error(
      `aiGenerateWithPoll: model ${model} did not complete — ` +
        `sync: ${syncError}; async batch timed out after ${asyncMaxWaitMs}ms${
          lastPollError ? `; last poll error: ${lastPollError}` : ""
        }`
    );
  } catch (asyncErr: unknown) {
    const asyncMsg = errMsg(asyncErr);
    const retrySyncOnce = async (
      retryReason: string,
      asyncFailureDetail: string
    ): Promise<string> => {
      onWarn(
        `[ai-poll] ${retryReason} for ${model} (${asyncFailureDetail}); ` +
          `waiting 30s then retrying sync path once (first sync error: ${syncError})`
      );
      // Wait 30 s before retrying — the first sync timeout is typically a
      // transient Workers AI overload; an immediate retry hits the same
      // saturated cluster and often fails again. 30 s is usually enough for
      // Workers AI to shed load without meaningfully extending wall-clock
      // time when the retry succeeds.
      await sleep(30_000);
      try {
        const text = await syncGenerate(ai, model, callParams, syncTimeoutMs);
        if (text && text.trim().length > 0) return text;
        throw new Error("sync retry returned empty response");
      } catch (retryErr: unknown) {
        const retryMsg = errMsg(retryErr);
        throw new Error(
          `aiGenerateWithPoll: all paths failed for ${model} — ` +
            `sync: ${syncError}; async: ${asyncFailureDetail}; ` +
            `sync-retry: ${retryMsg}`
        );
      }
    };

    // Workers AI error 8007 = "This model does not support request queuing"
    // (e.g. kimi-k2.5). The async batch path is permanently unavailable for
    // this model, so retry the sync path once — the initial timeout is often
    // a transient Workers AI overload rather than a hard model limit.
    const isNoQueueSupport =
      asyncMsg.includes("8007") ||
      /does not support request queuing/i.test(asyncMsg);

    if (isNoQueueSupport) {
      return retrySyncOnce(
        "async queue unsupported",
        "model does not support queuing"
      );
    }

    const isAsyncBatchTimeout =
      /model .* did not complete/i.test(asyncMsg) ||
      /async batch timed out/i.test(asyncMsg);
    if (isAsyncBatchTimeout) {
      return retrySyncOnce("async batch timed out", asyncMsg);
    }

    // Workers AI error 3040 = "Capacity temporarily exceeded" — the cluster
    // is overloaded and both the sync call and the async batch queue failed.
    // Retry the sync path once after a 60 s back-off; the overload is
    // transient and typically clears within a minute. We use 60 s (vs the
    // 30 s used for the no-queue-support path above) because capacity
    // exhaustion is a heavier condition and benefits from a longer cool-down.
    const capacityPattern = /\b3040\b|capacity\s+temporarily\s+exceeded/i;
    const isCapacityExceeded =
      capacityPattern.test(syncError ?? "") || capacityPattern.test(asyncMsg);

    if (isCapacityExceeded) {
      onWarn(
        `[ai-poll] ${model} capacity temporarily exceeded on both sync and async paths; ` +
          `waiting 60s then retrying sync path once (sync error: ${syncError})`
      );
      try {
        await sleep(60_000);
        const text = await syncGenerate(ai, model, callParams, syncTimeoutMs);
        if (text && text.trim().length > 0) return text;
        throw new Error(`sync retry for ${model} returned empty response`);
      } catch (retryErr: unknown) {
        const retryMsg = errMsg(retryErr);
        throw new Error(
          `aiGenerateWithPoll: all paths failed for ${model} — ` +
            `sync: ${syncError}; async: capacity exceeded (${asyncMsg}); ` +
            `sync-retry: ${retryMsg}`
        );
      }
    }

    throw new Error(
      `aiGenerateWithPoll: all paths failed for ${model} — ` +
        `sync: ${syncError}; async: ${asyncMsg}`
    );
  }
}

/**
 * Direct synchronous AI.run() wrapped in a Promise.race timeout.
 * Does NOT pass stream:false — the binding default is non-streaming.
 */
async function syncGenerate(
  ai: AiBinding,
  model: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`syncGenerate: ${model} timed out after ${timeoutMs}ms`)
        ),
      timeoutMs
    );
  });

  try {
    const result = await Promise.race([ai.run(model, params), timeoutP]);
    return extractText(toCompletedResponse(result)) ?? "";
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePositiveMs(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Normalizes unknown Workers AI binding output into the subset of fields
 * this module reads. Unrecognized shapes become `{}` so callers can treat
 * them as empty/non-terminal responses without throwing.
 */
function toCompletedResponse(value: unknown): CompletedResponse {
  if (typeof value === "string") return { response: value };
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const normalized: CompletedResponse = {};
  if (typeof raw.response === "string") normalized.response = raw.response;
  if (typeof raw.result === "string") normalized.result = raw.result;
  if (typeof raw.status === "string") normalized.status = raw.status;
  const normalizedError =
    normalizeErrorText(raw.error) ??
    normalizeErrorText(
      Array.isArray(raw.errors) && raw.errors.length > 0
        ? raw.errors
        : undefined
    ) ??
    normalizeErrorText(raw.message);
  if (normalizedError) normalized.error = normalizedError;
  const requestIdCandidate =
    normalizeNonEmptyString(raw.request_id) ??
    normalizeNonEmptyString(raw.requestId) ??
    normalizeNonEmptyString(raw.id);
  if (requestIdCandidate) normalized.request_id = requestIdCandidate;
  if (Array.isArray(raw.choices)) normalized.choices = raw.choices;
  if (Array.isArray(raw.responses)) normalized.responses = raw.responses;
  return normalized;
}

function normalizeErrorText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const nested = extractNestedErrorText(value);
  if (nested) return nested;
  // Keep a final fallback for primitive/non-standard thrown values.
  const normalized = errMsg(value).trim();
  return normalized !== "" && normalized !== "[object Object]"
    ? normalized
    : undefined;
}

function extractNestedErrorText(value: unknown, depth = 0): string | undefined {
  // Handles common API error wrappers (error.error.message, errors[].message)
  // without risking unbounded recursion on malformed cyclic payloads.
  if (
    depth > MAX_ERROR_TEXT_NESTING_DEPTH ||
    value === null ||
    value === undefined
  ) {
    return undefined;
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : undefined;
  }
  if (value instanceof Error) {
    const text = value.message.trim();
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(value)) {
    const messages = value
      .map((entry) => extractNestedErrorText(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry));
    return messages.length > 0 ? messages.join("; ") : undefined;
  }
  if (typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const code =
    typeof raw.code === "number" ||
    (typeof raw.code === "string" && raw.code.trim().length > 0)
      ? String(raw.code)
      : "";
  const withCode = (text: string): string =>
    code && !new RegExp(`^code\\s+${escapeRegExp(code)}:`, "i").test(text)
      ? `code ${code}: ${text}`
      : text;
  if (typeof raw.message === "string") {
    const text = raw.message.trim();
    if (text.length > 0) {
      return withCode(text);
    }
  }
  if (Array.isArray(raw.errors)) {
    const messages = raw.errors
      .map((entry) => extractNestedErrorText(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry));
    if (messages.length > 0) return withCode(messages.join("; "));
  }
  if ("error" in raw) {
    const nested = extractNestedErrorText(raw.error, depth + 1);
    return nested ? withCode(nested) : undefined;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractText(result: CompletedResponse): string {
  if (!result) return "";

  // Workers AI standard: { response: "..." }
  if (typeof result.response === "string" && result.response.length > 0)
    return result.response;

  // Batch API poll result: responses[0] is the completion for our single
  // queued request — either the completion object itself or wrapped as
  // { id, success, result }. Recurse so all the single-response shapes
  // below (response/choices/result) apply unchanged.
  if (Array.isArray(result.responses) && result.responses.length > 0) {
    const first = result.responses[0];
    if (first && typeof first === "object") {
      const wrapper = first as Record<string, unknown>;
      const inner =
        wrapper.result && typeof wrapper.result === "object"
          ? wrapper.result
          : first;
      const text = extractText(toCompletedResponse(inner));
      if (text.length > 0) return text;
    }
  }

  // OpenAI-compat choices array (Kimi K2.5 / K2.6)
  if (Array.isArray(result.choices) && result.choices.length > 0) {
    const msg = result.choices[0]?.message;
    // Normal content field
    const messageContent = extractMessageContent(msg?.content);
    if (messageContent.length > 0) return messageContent;
    // Kimi K2.5/K2.6 thinking overflow: content is null but reasoning_content
    // has the actual answer embedded. Use it as last resort.
    const reasoning =
      typeof msg?.reasoning_content === "string"
        ? msg.reasoning_content
        : typeof msg?.reasoning === "string"
          ? msg.reasoning
          : "";
    if (reasoning.length > 0) return reasoning;
    // Legacy text field
    if (typeof result.choices[0]?.text === "string")
      return result.choices[0].text;
  }

  // Some models: { result: "..." }
  if (typeof result.result === "string" && result.result.length > 0)
    return result.result;

  return "";
}

function extractMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // OpenAI-compatible providers may return content as an array of text parts,
  // and some adapters can include plain-string entries in the same array.
  // We extract only text-bearing parts in order, then concatenate directly so
  // we do not inject formatting that was not present in the provider payload.
  const textParts = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isTextContentPart(part)) return part.text;
      return "";
    })
    .filter((text) => text.length > 0);
  return textParts.join("");
}

function isTextContentPart(
  value: unknown
): value is { type?: string; text: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; text?: unknown };
  return (
    typeof candidate.text === "string" &&
    (candidate.type === undefined ||
      candidate.type === "text" ||
      candidate.type === "output_text")
  );
}
