/**
 * kimi-model.ts — Claude Code subscription selector for article / pipeline calls.
 *
 * Chat and vision stay on Claude. A failure throws `ClaudeChatStoppedError`
 * and the dashboard shows a red banner. This module does not call OpenRouter,
 * Workers AI chat (Kimi or Qwen), Doppler key rotation, or any other LLM.
 * Model-id retry stays inside Claude (`CLAUDE_CODE_MODEL_FALLBACKS` on HTTP 404).
 *
 * Flux image generation and OpenAI embeddings are not chat and do not live here.
 *
 * - `getKimiModel(env)` → LanguageModel for Vercel AI SDK `generateText()` /
 *   `generateObject()` sites, including tool loops. Claude only.
 * - `runScoutChat(env, params)` → category-scout AI tier. Claude only.
 * - `runKimiWithPoll(env, params)` → raw-binding call sites (writer,
 *   siss-optimizer, editorial, keywords, text editor). Claude only.
 *
 * `getKimiProviderOptions` returns `undefined`. Claude does not need the
 * Kimi thinking-mode switch those options used to carry.
 */

import { errMsg } from "./http-utils";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import type { SEOArticleAgent } from "../server";
import {
  clearClaudeChatFailureBanner,
  isClaudeChatStoppedError,
  reportClaudeChatFailure
} from "./claude-chat-failure";
import {
  callClaudeCodeText,
  callClaudeCodeTextResult,
  CLAUDE_CODE_CALL_FAILED_LOG_PREFIX,
  CLAUDE_CODE_MODEL_FALLBACKS,
  createAnthropicFromClaudeCodeToken,
  getClaudeCodeModelId,
  getClaudeRateLimitCooldownRemainingMs,
  isClaudeAuthError,
  isModelNotFoundError,
  lastClaudeSuccessMeta,
  refreshClaudeCodeAccessToken,
  resolveClaudeCallTimeoutMs,
  resolveClaudeCodeSubscription,
  shouldRefreshClaudeToken
} from "./claude-code-subscription";

/**
 * Detects token-repetition-collapse output: a long response of near-pure
 * digit/punctuation noise. Real English prose is dominated by letters.
 * Short responses are left alone — other gates cover those.
 */
export function isDegenerateOutput(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 200) return false;
  const alphaChars = (trimmed.match(/[a-zA-Z]/g) || []).length;
  return alphaChars / trimmed.length < 0.15;
}

const STOPPED = "No other model was called. The pipeline stopped.";

function claudeModelIds(env: Env): string[] {
  const primary = getClaudeCodeModelId(env);
  const out = [primary];
  for (const id of CLAUDE_CODE_MODEL_FALLBACKS) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function asLanguageModelV3(model: LanguageModel): LanguageModelV3 {
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    const spec = typeof model === "string" ? model : model.specificationVersion;
    throw new Error(`Expected LanguageModelV3, received ${spec}`);
  }
  return model;
}

/**
 * Claude subscription call for `generateText` / `generateObject`. Refreshes
 * an expiring access token first, then walks model ids on 404. Any other
 * failure throws. OpenRouter and Workers AI are not called.
 */
async function callClaudeChatModel<T>(
  env: Env,
  options: LanguageModelV3CallOptions,
  invoke: (
    model: LanguageModelV3,
    options: LanguageModelV3CallOptions
  ) => PromiseLike<T>,
  onModelId: (modelId: string) => void
): Promise<T> {
  if (shouldRefreshClaudeToken()) {
    try {
      await refreshClaudeCodeAccessToken();
    } catch {
      /* the call below surfaces the real auth error */
    }
  }

  const cooldownMs = getClaudeRateLimitCooldownRemainingMs();
  if (cooldownMs > 0) {
    throw reportClaudeChatFailure(
      `[claude-code] Claude rate-limit cooldown ${Math.ceil(cooldownMs / 1000)}s remaining after the existing retry/cooldown; ${STOPPED}`
    );
  }

  const resolved = resolveClaudeCodeSubscription(env);
  if (!resolved) {
    throw reportClaudeChatFailure(
      `[claude-code] no active Claude subscription token; ${STOPPED}`
    );
  }

  const candidates = claudeModelIds(env);
  let lastErr: unknown;
  for (const modelId of candidates) {
    const model = asLanguageModelV3(
      createAnthropicFromClaudeCodeToken(resolved.token)(modelId)
    );
    try {
      onModelId(modelId);
      const result = await invoke(model, options);
      clearClaudeChatFailureBanner();
      return result;
    } catch (err: unknown) {
      lastErr = err;
      if (isClaudeChatStoppedError(err)) throw err;
      if (isModelNotFoundError(err)) continue;
      throw reportClaudeChatFailure(err);
    }
  }
  throw reportClaudeChatFailure(
    lastErr instanceof Error
      ? lastErr
      : `[claude-code] no Claude model answered; ${errMsg(lastErr)}; ${STOPPED}`
  );
}

function createClaudeChatLanguageModel(env: Env): LanguageModelV3 {
  let modelId = getClaudeCodeModelId(env);
  const dispatch = <T>(
    options: LanguageModelV3CallOptions,
    invoke: (
      model: LanguageModelV3,
      options: LanguageModelV3CallOptions
    ) => PromiseLike<T>
  ): Promise<T> => {
    const run = (
      model: LanguageModelV3,
      next: LanguageModelV3CallOptions
    ): Promise<T> => {
      modelId = model.modelId;
      return Promise.resolve(invoke(model, next));
    };
    return callClaudeChatModel(env, options, run, (id) => {
      modelId = id;
    });
  };

  return {
    specificationVersion: "v3",
    provider: "anthropic",
    get modelId() {
      return modelId;
    },
    supportedUrls: {},
    doGenerate: (options) =>
      dispatch(options, (model, next) => model.doGenerate(next)),
    doStream: (options) =>
      dispatch(options, (model, next) => model.doStream(next))
  };
}

/**
 * LanguageModel for Vercel AI SDK chat sites (`generateText` /
 * `generateObject`), including `useAgentTools` and `useCloudflareApiTool`.
 *
 * Claude Code subscription only. The model refreshes an expiring access
 * token before the call and, on HTTP 404, tries `CLAUDE_CODE_MODEL_FALLBACKS`.
 * Failure throws `ClaudeChatStoppedError`. Provider swap is not available.
 */
export function getKimiModel(env: Env): LanguageModel {
  return createClaudeChatLanguageModel(env);
}

/**
 * Category-scout AI tier. Claude Code subscription (`callClaudeCodeText`)
 * only — that helper refreshes an expiring token and walks
 * `CLAUDE_CODE_MODEL_FALLBACKS` on 404. An empty or missing Claude
 * response throws so the scout can retry Claude, then use its non-LLM
 * category list. Workers AI Qwen is not called.
 */
export async function runScoutChat(
  env: Env,
  params: { system: string; prompt: string; maxOutputTokens: number },
  _warn?: (message: string) => void
): Promise<{ text: string; modelId: string }> {
  let text: string | null;
  try {
    text = await callClaudeCodeText(env, {
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.prompt }
      ],
      max_tokens: params.maxOutputTokens
    });
  } catch (err: unknown) {
    throw reportClaudeChatFailure(err);
  }
  if (!text) {
    throw reportClaudeChatFailure(
      `[claude-code] scout returned empty; ${STOPPED}`
    );
  }
  clearClaudeChatFailureBanner();
  return {
    text,
    modelId: lastClaudeSuccessMeta?.modelId ?? getClaudeCodeModelId(env)
  };
}

/**
 * Claude needs no provider options. Kept so existing `generateText` call
 * sites can keep passing it.
 */
export function getKimiProviderOptions(_env: Env): undefined {
  return undefined;
}

/**
 * Hard cap on continuation rounds when a chat call returns
 * `finishReason: "length"`. Each round costs ~one max_tokens budget, so
 * 2 rounds = up to 3× the normal call cost.
 */
const MAX_CONTINUATION_ROUNDS = 2;

const CONTINUATION_USER_PROMPT =
  "Continue from exactly where you left off. Do not repeat any text. Do not add a preamble. Finish the response cleanly so the final character is part of a complete sentence (or, if you were emitting JSON, a complete and valid JSON object).";

type ChatTurn = {
  role: "user" | "system" | "assistant";
  content: string;
};

type TextFinish = { text: string; finishReason: string };

function continuationTurns(base: ChatTurn[], combined: string): ChatTurn[] {
  return [
    ...base,
    { role: "assistant", content: combined },
    { role: "user", content: CONTINUATION_USER_PROMPT }
  ];
}

/**
 * Concatenate follow-up rounds while Claude stops on `finishReason`
 * `"length"`. Raw text is appended so a trailing space at the cut survives.
 * A later round that throws keeps the partial so a long article is not
 * discarded.
 */
async function appendContinuations(
  agent: SEOArticleAgent,
  baseMessages: ChatTurn[],
  initial: TextFinish,
  call: (msgs: ChatTurn[]) => Promise<TextFinish | null>
): Promise<string> {
  let combined = initial.text;
  let finish = initial.finishReason;
  let rounds = 0;
  while (finish === "length" && rounds < MAX_CONTINUATION_ROUNDS) {
    rounds++;
    agent.log(
      "info",
      `[kimi-model] finishReason=length, requesting continuation ${rounds}/${MAX_CONTINUATION_ROUNDS} (claude, current length: ${combined.length} chars)`,
      "contentCreator"
    );
    let next: TextFinish | null;
    try {
      next = await call(continuationTurns(baseMessages, combined));
    } catch (err: unknown) {
      if (isClaudeChatStoppedError(err)) throw err;
      agent.log(
        "warning",
        `[kimi-model] continuation ${rounds} failed (${errMsg(err)}); using truncated result (${combined.length} chars)`,
        "contentCreator"
      );
      break;
    }
    if (!next) {
      agent.log(
        "warning",
        `[kimi-model] continuation ${rounds} returned empty; using truncated result (${combined.length} chars)`,
        "contentCreator"
      );
      break;
    }
    combined += next.text;
    finish = next.finishReason;
  }
  if (finish === "length") {
    agent.log(
      "warning",
      `[kimi-model] still truncated after ${MAX_CONTINUATION_ROUNDS} continuations — final length ${combined.length} chars. Downstream parser will get a possibly-incomplete response.`,
      "contentCreator"
    );
  }
  return combined;
}

/**
 * Options still accepted by `runKimiWithPoll`. Only `syncTimeoutMs` is
 * forwarded to the Claude call. The Workers AI batch-poll knobs that used
 * to live on this object were removed with `ai-poll.ts`.
 */
interface ClaudePollOptions {
  /** Timeout ms forwarded to `resolveClaudeCallTimeoutMs`. */
  syncTimeoutMs?: number;
}

/**
 * Raw-binding chat helper. Claude Code subscription only.
 *
 *  1. Require an active Claude subscription that is not in a 429 cooldown.
 *  2. Call `callClaudeCodeTextResult`. On `finishReason === "length"`,
 *     continue up to `MAX_CONTINUATION_ROUNDS`.
 *  3. On failure — missing token, cooldown, thrown error (including 429
 *     after Claude's own retry), empty, or degenerate — throw
 *     `ClaudeChatStoppedError`. Do not call another model.
 *
 * All call sites must pass an `agent` for proper logging.
 */
export async function runKimiWithPoll(
  env: Env,
  params: {
    messages?: Array<{
      role: "user" | "system" | "assistant";
      content: string;
    }>;
    prompt?: string;
    max_tokens?: number;
  },
  opts: ClaudePollOptions = {},
  agent: SEOArticleAgent
): Promise<string> {
  const messages =
    params.messages ??
    (params.prompt ? [{ role: "user", content: params.prompt }] : []);

  const stop = (message: string): never => {
    agent.log("warning", message, "contentCreator");
    throw reportClaudeChatFailure(message);
  };

  if (!resolveClaudeCodeSubscription(env)) {
    stop(`[claude-code] no active Claude subscription token; ${STOPPED}`);
  }

  const claudeCooldownMs = getClaudeRateLimitCooldownRemainingMs();
  if (claudeCooldownMs > 0) {
    const seconds = Math.ceil(claudeCooldownMs / 1000);
    stop(
      `[claude-code] Claude rate-limit cooldown ${seconds}s remaining after the existing retry/cooldown; ${STOPPED}`
    );
  }

  const claudeCallTimeoutMs = resolveClaudeCallTimeoutMs(opts.syncTimeoutMs);
  const callClaude = (msgs: ChatTurn[]): Promise<TextFinish | null> =>
    callClaudeCodeTextResult(env, {
      messages: msgs,
      max_tokens: params.max_tokens,
      timeoutMs: claudeCallTimeoutMs
    });

  try {
    const initial = await callClaude(messages);
    if (!initial) {
      return stop(`[claude-code] returned empty; ${STOPPED}`);
    }
    const combined = await appendContinuations(
      agent,
      messages,
      initial,
      callClaude
    );
    if (isDegenerateOutput(combined)) {
      stop(
        `[claude-code] returned degenerate output (${combined.length} chars, alpha-ratio below threshold — likely token-repetition collapse); ${STOPPED}`
      );
    }
    const meta = lastClaudeSuccessMeta;
    agent.log(
      "info",
      `[claude-code] primary OK (${combined.length} chars, model=${meta?.modelId ?? getClaudeCodeModelId(env)}, source=${meta?.tokenSource ?? "unknown"})`,
      "contentCreator"
    );
    clearClaudeChatFailureBanner();
    return combined;
  } catch (err: unknown) {
    if (isClaudeChatStoppedError(err)) throw err;
    const msg = errMsg(err);
    const auth = isClaudeAuthError(err);
    const tag = auth ? " (auth)" : "";
    agent.log(
      "warning",
      `${CLAUDE_CODE_CALL_FAILED_LOG_PREFIX}${tag} (${msg}); ${STOPPED}`,
      "contentCreator"
    );
    throw reportClaudeChatFailure(
      `${CLAUDE_CODE_CALL_FAILED_LOG_PREFIX}${tag} (${msg}); ${STOPPED}`
    );
  }
}
