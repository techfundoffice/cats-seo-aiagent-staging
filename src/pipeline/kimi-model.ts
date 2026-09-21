/**
 * kimi-model.ts — Provider selector for article / pipeline calls.
 *
 * **`runKimiWithPoll` is Claude-only by default.** It calls the Claude Code
 * subscription (`callClaudeCodeTextResult`) and throws on failure — including
 * a missing token, an Anthropic 429 after the existing retry/cooldown, an
 * empty or degenerate response. It does not call OpenRouter, Workers AI, or
 * Doppler OpenRouter key rotation unless the escape hatch is set:
 *
 *   `AI_CHAT_FALLBACK=kimi`
 *
 * That var (Worker var or secret; case-insensitive) restores the previous
 * chain: Claude, then OpenRouter when `OPENROUTER_API_KEY` is set, then
 * Workers AI Qwen via `aiGenerateWithPoll`. Any other value, including
 * unset, keeps the Claude-only path. OpenRouter code stays in this file
 * for that hatch and for `getKimiModel` / `getFreeModel` (later PRs).
 *
 * - `getKimiModel(env)` → unchanged this release. Returns a LanguageModel
 *   for Vercel AI SDK `generateText()` / `generateObject()` sites: Claude
 *   when a subscription is active and not cooling down, otherwise
 *   OpenRouter/Workers AI Kimi. It cannot retry mid-call. Scout and
 *   `getKimiModel`-only sites are out of scope here.
 * - `runKimiWithPoll(env, params)` → raw-binding call sites (writer,
 *   siss-optimizer, editorial, keywords, text editor). Claude only, unless
 *   `AI_CHAT_FALLBACK=kimi`.
 *
 * Kimi thinking mode is disabled in both Kimi paths so max_tokens fund
 * content, not reasoning:
 *   - Workers AI: `chat_template_kwargs: { enable_thinking: false, ... }` (inside
 *     aiGenerateWithPoll)
 *   - OpenRouter: `providerOptions.openrouter.reasoning = { enabled: false }`
 *     ⚠️  `{ exclude: true }` only HIDES reasoning output — Kimi still burns
 *     max_tokens on it and returns `content: null`. `{ enabled: false }`
 *     actually disables reasoning so tokens fund visible content.
 * Claude needs no such provider options — `getKimiProviderOptions` returns
 * `undefined` whenever the Claude path is in play.
 */

import { errMsg } from "./http-utils";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { aiGenerateWithPoll, type AiPollOptions } from "./ai-poll";
import type { SEOArticleAgent } from "../server";
import {
  callClaudeCodeTextResult,
  CLAUDE_CODE_CALL_FAILED_LOG_PREFIX,
  getClaudeCodeLanguageModel,
  getClaudeCodeModelId,
  getClaudeRateLimitCooldownRemainingMs,
  isClaudeAuthError,
  lastClaudeSuccessMeta,
  resolveClaudeCallTimeoutMs,
  resolveClaudeCodeSubscription
} from "./claude-code-subscription";

const WORKERS_AI_KIMI_MODEL = "@cf/moonshotai/kimi-k2.5";
/**
 * Default OpenRouter model for the writer. `:nitro` routes to the
 * highest-throughput provider (benchmarked ~15% faster output than the
 * default routing, same model/pricing class). Override per-deploy with
 * the OPENROUTER_KIMI_MODEL env/secret (e.g. to trial a new model).
 */
const OPENROUTER_KIMI_MODEL_DEFAULT = "moonshotai/kimi-k2.5:nitro";
function openRouterKimiModelId(env: Env): string {
  return env.OPENROUTER_KIMI_MODEL?.trim() || OPENROUTER_KIMI_MODEL_DEFAULT;
}
const OPENROUTER_FREE_MODEL = "openrouter/free";
const OPENROUTER_REASONING_DISABLED = { reasoning: { enabled: false } };
const OPENROUTER_REASONING_LOW = { reasoning: { effort: "low" as const } };

/**
 * Model-aware reasoning options. Kimi ships a thinking-overflow bug so we
 * hard-disable reasoning; xAI Grok models REJECT `enabled: false`
 * (reasoning is mandatory) so they get low effort instead — keeps token
 * burn minimal while satisfying the endpoint.
 */
function openRouterReasoningOptions(env: Env) {
  return /^x-ai\//i.test(openRouterKimiModelId(env))
    ? OPENROUTER_REASONING_LOW
    : OPENROUTER_REASONING_DISABLED;
}

/**
 * Hard cap on a single OpenRouter `generateText()` call. Without this, a
 * stalled OpenRouter connection (no response, no error — just an unresolved
 * fetch) hangs `runKimiWithPoll` forever. Because that hang never throws, it
 * bypasses every catch block and the escalation system (which only fires on
 * thrown errors / explicit failResult), silently wedging the single-flight
 * Durable Object alarm loop: no further cron ticks run until the current one
 * finishes, so one hung call stops article generation entirely. Root cause
 * of the 2026-07-06 stuck-at-"SISS Optimizer" incident.
 */
const OPENROUTER_CALL_TIMEOUT_MS = 120_000;

/**
 * Shared prefix for the "OpenRouter call failed" warning logged by
 * `runKimiWithPoll`. `kimiProviderHealth.ts` matches against this
 * prefix to count OpenRouter failures in the activity log — exporting
 * it here keeps producer and consumer in sync so a log-message rename
 * never silently breaks the health detector.
 */
export const OPENROUTER_CALL_FAILED_LOG_PREFIX =
  "[kimi-model] OpenRouter call failed";

/**
 * Detects token-repetition-collapse output — a real, observed OpenRouter
 * failure mode distinct from an empty/truncated response: the model returns
 * a long, well-formed-looking HTTP 200 full of near-pure digit/punctuation
 * noise (e.g. "100000450005581856567400000010158..."), with no coherent
 * prose. This slips past the empty-response check below (`text` is
 * non-empty) and, left unhandled, burns a full downstream pipeline run
 * before the SEO scorecard eventually fails it at 0 — wasted generation
 * cost and pipeline time for a defect that's cheap to catch here instead.
 *
 * Heuristic: real English prose (even spec-heavy, price-heavy content) is
 * dominated by alphabetic characters. Degenerate digit-collapse output is
 * not. Short responses are left alone — other gates (thin-content, JSON
 * parse) already cover those; this only targets long responses that would
 * otherwise look "successful" by length alone.
 */
export function isDegenerateOutput(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 200) return false;
  const alphaChars = (trimmed.match(/[a-zA-Z]/g) || []).length;
  return alphaChars / trimmed.length < 0.15;
}

/**
 * Fast Cloudflare Workers AI model: Qwen3-30B-A3B (fp8). A mixture-of-experts
 * model that activates only ~3B params per forward pass, so it completes well
 * inside the 150s sync window AND supports batch queuing — unlike
 * `@cf/moonshotai/kimi-k2.5`, which routinely times out on real generations
 * and rejects queuing with error 8007. Runs entirely on the `env.AI` binding:
 * no OpenRouter credits, no paid-Kimi tokens, no external key to rotate.
 *
 * Used as:
 *   1. the category-scout model (`getScoutModel`), and
 *   2. the `runKimiWithPoll` Workers AI fallback when `AI_CHAT_FALLBACK=kimi`
 *      — so that escape hatch still generates when OpenRouter credits are
 *      exhausted instead of wedging on the timing-out Kimi binding (the root
 *      cause of the 6/6→6/10 publish drought).
 *
 * Qwen3 ships with reasoning ON by default and can burn the output budget on
 * thinking; callers disable it (`chat_template_kwargs.enable_thinking=false`
 * in `aiGenerateWithPoll`; a `/no_think` token in the scout prompt).
 */
const WORKERS_AI_QWEN_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

/**
 * In-memory override for `OPENROUTER_API_KEY`. Set by the agent's
 * `rotateOpenRouterKeyFromDoppler()` self-heal path when a 401 is detected
 * and Doppler has a fresher value than the Worker's env binding. Lives for
 * the lifetime of the Durable Object instance — next cold start reads the
 * (possibly still-dead) env binding again and re-triggers rotation.
 *
 * Module-level because DO isolates don't share state, so this is safely
 * per-instance without any `this` gymnastics.
 */
let _rotatedOpenRouterKey: string | null = null;

function normalizeOpenRouterKey(
  key: string | null | undefined
): string | undefined {
  return key?.trim() || undefined;
}

/** Called by the agent's self-heal after a successful Doppler rotation. */
export function setRotatedOpenRouterKey(key: string | null): void {
  _rotatedOpenRouterKey = normalizeOpenRouterKey(key) ?? null;
}

/** Returns the override-or-env OpenRouter key (trimmed), or `undefined`. */
function resolveOpenRouterKey(env: Env): string | undefined {
  const rotated = normalizeOpenRouterKey(_rotatedOpenRouterKey);
  if (rotated) return rotated;
  return normalizeOpenRouterKey(env.OPENROUTER_API_KEY);
}

/** Best-effort 401/auth detection across provider error shapes. */
function isOpenRouterAuthError(err: unknown): boolean {
  const msg = errMsg(err);
  return /\b401\b|unauthorized|invalid[_\s-]?api[_\s-]?key|invalid authentication credentials/i.test(
    msg
  );
}

/**
 * True when `getKimiModel`/`getKimiProviderOptions` should prefer Claude:
 * an active Claude Code subscription token exists AND we are not sitting
 * out an Anthropic 429 cooldown. Shared so the model-selection decision and
 * the provider-options decision never disagree with each other.
 */
function useClaudeForKimi(env: Env): boolean {
  if (getClaudeRateLimitCooldownRemainingMs() > 0) return false;
  return resolveClaudeCodeSubscription(env) != null;
}

/**
 * Returns a LanguageModel for Vercel AI SDK call sites (Claude-first).
 *
 * Prefers the Claude Code subscription (`getClaudeCodeLanguageModel`) when
 * one is active and not rate-limit-cooling-down; otherwise falls back to
 * Kimi K2.5 — OpenRouter when OPENROUTER_API_KEY is set, otherwise Workers
 * AI. Unchanged this release (PR 3 covers scout / getKimiModel-only sites).
 * Unlike `runKimiWithPoll`, this returns a model reference rather than an
 * awaited call, so it cannot switch providers mid-request. Raw-binding
 * callers (writer, siss-optimizer, text-editor-agent, editorial-agent,
 * keywords) should use `runKimiWithPoll` instead.
 *
 * Both Kimi paths disable Kimi's thinking mode so max_tokens fund visible
 * content, not internal reasoning that overflows and leaves content="":
 *   - Workers AI: `chat_template_kwargs` passthrough on model settings
 *     (matches the raw-binding behavior in `aiGenerateWithPoll`).
 *   - OpenRouter: `providerOptions.openrouter.reasoning.enabled=false` —
 *     applied separately via `getKimiProviderOptions(env)`.
 */
export function getKimiModel(env: Env): LanguageModel {
  if (useClaudeForKimi(env)) {
    const claude = getClaudeCodeLanguageModel(env);
    if (claude) return claude;
  }
  const key = resolveOpenRouterKey(env);
  if (key) {
    return createOpenRouter({ apiKey: key })(openRouterKimiModelId(env));
  }
  return makeWorkersAiKimiModel(env);
}

function makeWorkersAiKimiModel(env: Env): LanguageModel {
  return createWorkersAI({ binding: env.AI })(WORKERS_AI_KIMI_MODEL, {
    // Passthrough to binding.run — kills the thinking-overflow empty-
    // response bug.
    chat_template_kwargs: {
      thinking: false,
      enable_thinking: false,
      clear_thinking: true
    }
  });
}

/**
 * OpenRouter's Free Models Router (`openrouter/free`) — auto-routes to an
 * available free model at zero credit cost using the same
 * `OPENROUTER_API_KEY`. Used where basic text generation doesn't need
 * Kimi-grade output and a paid-credit outage must not block the pipeline:
 * the category scout (all attempts) and keyword-generation retries.
 * Falls back to the Workers AI Kimi path when no OpenRouter key is
 * configured (local dev).
 */
export function getFreeModel(env: Env): LanguageModel {
  const key = resolveOpenRouterKey(env);
  if (key) {
    return createOpenRouter({ apiKey: key })(OPENROUTER_FREE_MODEL);
  }
  return makeWorkersAiKimiModel(env);
}

/**
 * Cloudflare Workers AI model for the category scout. Unconditionally runs on
 * the `env.AI` binding (Qwen3-30B-A3B) — it never touches OpenRouter or Kimi,
 * regardless of whether `OPENROUTER_API_KEY` is set. The scout is a low-stakes,
 * high-frequency discovery task that does not need Kimi-grade output, so this
 * keeps it off paid credits and off the shared Kimi quota. `enable_thinking:
 * false` keeps Qwen3's default reasoning from overflowing the scout's modest
 * output budget and returning empty content.
 */
export function getScoutModel(env: Env): LanguageModel {
  return createWorkersAI({ binding: env.AI })(WORKERS_AI_QWEN_MODEL, {
    chat_template_kwargs: { enable_thinking: false }
  });
}

/**
 * Provider options to pass to `generateText()` so Kimi thinking stays off.
 * Workers AI disables thinking via model-level `chat_template_kwargs`
 * (handled by the provider); OpenRouter uses `reasoning: { enabled: false }`.
 * Claude needs no special provider options, so this returns `undefined`
 * whenever `getKimiModel` would have picked Claude — keep the two in sync
 * via `useClaudeForKimi`.
 *
 * Shape matches the AI SDK's `SharedV3ProviderOptions`
 * (`Record<string, JSONObject>`); the explicit literal avoids the looser
 * `Record<string, unknown>` inference which isn't assignable there.
 */
export function getKimiProviderOptions(env: Env):
  | {
      openrouter: { reasoning: { enabled: boolean } | { effort: "low" } };
    }
  | undefined {
  if (useClaudeForKimi(env)) return undefined;
  if (resolveOpenRouterKey(env)) {
    return { openrouter: openRouterReasoningOptions(env) };
  }
  return undefined;
}

/**
 * Hard cap on continuation rounds when a chat call returns
 * `finishReason: "length"`. Each round costs ~one max_tokens budget, so
 * 2 rounds = up to 3× the normal call cost. Stops a runaway prompt from
 * burning unbounded cost. Applies to Claude (default) and to OpenRouter
 * when `AI_CHAT_FALLBACK=kimi`.
 */
const MAX_CONTINUATION_ROUNDS = 2;

const CONTINUATION_USER_PROMPT =
  "Continue from exactly where you left off. Do not repeat any text. Do not add a preamble. Finish the response cleanly so the final character is part of a complete sentence (or, if you were emitting JSON, a complete and valid JSON object).";

const NO_KIMI_FALLBACK_SUFFIX =
  "OpenRouter and Workers AI were not called. Set AI_CHAT_FALLBACK=kimi to restore that chain.";

type ChatTurn = {
  role: "user" | "system" | "assistant";
  content: string;
};

type TextFinish = { text: string; finishReason: string };

/**
 * True only for the explicit escape hatch. Any other value, including
 * unset, keeps `runKimiWithPoll` on the Claude Code subscription alone.
 */
export function isAiChatFallbackKimi(env: {
  AI_CHAT_FALLBACK?: string;
}): boolean {
  return env.AI_CHAT_FALLBACK?.trim().toLowerCase() === "kimi";
}

function continuationTurns(base: ChatTurn[], combined: string): ChatTurn[] {
  return [
    ...base,
    { role: "assistant", content: combined },
    { role: "user", content: CONTINUATION_USER_PROMPT }
  ];
}

/**
 * Concatenate follow-up rounds while the model stops on `finishReason`
 * `"length"`. Raw text is appended so a trailing space at the cut survives.
 * OpenRouter rethrows continuation errors (the hatch then tries Workers AI).
 * Claude keeps the partial (`keepPartialOnError`) so a long article is not
 * discarded when a later round fails.
 */
async function appendContinuations(
  agent: SEOArticleAgent,
  baseMessages: ChatTurn[],
  initial: TextFinish,
  call: (msgs: ChatTurn[]) => Promise<TextFinish | null>,
  opts: { providerLabel?: string; keepPartialOnError: boolean }
): Promise<string> {
  let combined = initial.text;
  let finish = initial.finishReason;
  let rounds = 0;
  while (finish === "length" && rounds < MAX_CONTINUATION_ROUNDS) {
    rounds++;
    const where = opts.providerLabel ? `${opts.providerLabel}, ` : "";
    agent.log(
      "info",
      `[kimi-model] finishReason=length, requesting continuation ${rounds}/${MAX_CONTINUATION_ROUNDS} (${where}current length: ${combined.length} chars)`,
      "contentCreator"
    );
    let next: TextFinish | null;
    try {
      next = await call(continuationTurns(baseMessages, combined));
    } catch (err: unknown) {
      if (!opts.keepPartialOnError) throw err;
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
 * Raw-binding chat helper. Claude Code subscription only, unless
 * `AI_CHAT_FALLBACK=kimi`.
 *
 * Default:
 *  1. Require an active Claude subscription that is not in a 429 cooldown.
 *  2. Call `callClaudeCodeTextResult`. On `finishReason === "length"`,
 *     continue up to `MAX_CONTINUATION_ROUNDS` (same resume prompt the
 *     OpenRouter path uses) so a ~4096 token cap does not truncate the body.
 *  3. On failure — missing token, cooldown, thrown error (including 429
 *     after Claude's own retry), empty, or degenerate — throw. Do not call
 *     OpenRouter, `aiGenerateWithPoll`, or Doppler key rotation.
 *
 * `AI_CHAT_FALLBACK=kimi` restores the previous chain: Claude, then
 * OpenRouter (`OPENROUTER_API_KEY`), then Workers AI Qwen.
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
  opts: AiPollOptions = {},
  agent: SEOArticleAgent
): Promise<string> {
  const messages =
    params.messages ??
    (params.prompt ? [{ role: "user", content: params.prompt }] : []);

  const callOpenRouter = async (
    apiKey: string,
    msgs: Array<{ role: "user" | "system" | "assistant"; content: string }>
  ): Promise<{ text: string; finishReason: string } | null> => {
    const openrouter = createOpenRouter({ apiKey });
    const { text, finishReason } = await generateText({
      model: openrouter(openRouterKimiModelId(env)),
      // AI SDK expects typed message roles; cast from our narrowed shape.
      messages: msgs as ModelMessage[],
      maxOutputTokens: params.max_tokens ?? 4096,
      providerOptions: { openrouter: openRouterReasoningOptions(env) },
      abortSignal: AbortSignal.timeout(OPENROUTER_CALL_TIMEOUT_MS)
    });
    if (text && text.trim().length > 0) {
      return { text, finishReason: String(finishReason ?? "") };
    }
    return null;
  };

  const callOpenRouterWithContinuation = async (
    apiKey: string
  ): Promise<string | null> => {
    const initial = await callOpenRouter(apiKey, messages);
    if (!initial) return null;
    return appendContinuations(
      agent,
      messages,
      initial,
      (msgs) => callOpenRouter(apiKey, msgs),
      { keepPartialOnError: false }
    );
  };

  const kimiFallback = isAiChatFallbackKimi(env);
  const miss = (
    fallbackLevel: "info" | "warning",
    fallbackMessage: string,
    stopMessage: string
  ): void => {
    if (kimiFallback) {
      agent.log(fallbackLevel, fallbackMessage, "contentCreator");
      return;
    }
    agent.log("warning", stopMessage, "contentCreator");
    throw new Error(stopMessage);
  };

  // ── Claude path (only path unless AI_CHAT_FALLBACK=kimi) ───────────────
  if (!resolveClaudeCodeSubscription(env)) {
    miss(
      "info",
      "[claude-code] no active Claude subscription token; using Kimi (OpenRouter/Workers AI)",
      `[claude-code] no active Claude subscription token; ${NO_KIMI_FALLBACK_SUFFIX}`
    );
  } else {
    const claudeCooldownMs = getClaudeRateLimitCooldownRemainingMs();
    if (claudeCooldownMs > 0) {
      const seconds = Math.ceil(claudeCooldownMs / 1000);
      miss(
        "info",
        `[claude-code] skipping Claude — ${seconds}s remaining in Anthropic rate-limit cooldown; using Kimi (OpenRouter/Workers AI)`,
        `[claude-code] Claude rate-limit cooldown ${seconds}s remaining after the existing retry/cooldown; ${NO_KIMI_FALLBACK_SUFFIX}`
      );
    } else {
      const claudeCallTimeoutMs = resolveClaudeCallTimeoutMs(
        opts.syncTimeoutMs
      );
      const callClaude = (msgs: ChatTurn[]): Promise<TextFinish | null> =>
        callClaudeCodeTextResult(env, {
          messages: msgs,
          max_tokens: params.max_tokens,
          timeoutMs: claudeCallTimeoutMs
        });
      let claudeMiss: {
        fallbackMessage: string;
        stopMessage: string;
      } | null = null;
      try {
        const initial = await callClaude(messages);
        if (initial) {
          const combined = await appendContinuations(
            agent,
            messages,
            initial,
            callClaude,
            { providerLabel: "claude", keepPartialOnError: true }
          );
          if (!isDegenerateOutput(combined)) {
            const meta = lastClaudeSuccessMeta;
            agent.log(
              "info",
              `[claude-code] primary OK (${combined.length} chars, model=${meta?.modelId ?? getClaudeCodeModelId(env)}, source=${meta?.tokenSource ?? "unknown"})`,
              "contentCreator"
            );
            return combined;
          }
          claudeMiss = {
            fallbackMessage: `[claude-code] returned degenerate output (${combined.length} chars, alpha-ratio below threshold — likely token-repetition collapse); falling back to Kimi (OpenRouter/Workers AI)`,
            stopMessage: `[claude-code] returned degenerate output (${combined.length} chars, alpha-ratio below threshold — likely token-repetition collapse); ${NO_KIMI_FALLBACK_SUFFIX}`
          };
        } else {
          claudeMiss = {
            fallbackMessage:
              "[claude-code] returned empty; falling back to Kimi (OpenRouter/Workers AI)",
            stopMessage: `[claude-code] returned empty; ${NO_KIMI_FALLBACK_SUFFIX}`
          };
        }
      } catch (err: unknown) {
        const msg = errMsg(err);
        const auth = isClaudeAuthError(err);
        const tag = auth ? " (auth)" : "";
        claudeMiss = {
          fallbackMessage: `${CLAUDE_CODE_CALL_FAILED_LOG_PREFIX}${tag} (${msg}); falling back to Kimi (OpenRouter/Workers AI)`,
          stopMessage: `${CLAUDE_CODE_CALL_FAILED_LOG_PREFIX}${tag} (${msg}); ${NO_KIMI_FALLBACK_SUFFIX}`
        };
      }
      if (claudeMiss) {
        miss("warning", claudeMiss.fallbackMessage, claudeMiss.stopMessage);
      }
    }
  }

  if (!kimiFallback) {
    throw new Error(
      `[claude-code] Claude call did not return text; ${NO_KIMI_FALLBACK_SUFFIX}`
    );
  }

  // ── OpenRouter path (AI_CHAT_FALLBACK=kimi only) ────────────────────────
  const key = resolveOpenRouterKey(env);
  if (key) {
    try {
      const text = await callOpenRouterWithContinuation(key);
      if (text && !isDegenerateOutput(text)) return text;
      if (text) {
        agent.log(
          "warning",
          `[kimi-model] OpenRouter returned degenerate output (${text.length} chars, alpha-ratio below threshold — likely token-repetition collapse); falling back to Workers AI`,
          "contentCreator"
        );
      } else {
        agent.log(
          "warning",
          "[kimi-model] OpenRouter returned empty; falling back to Workers AI",
          "contentCreator"
        );
      }
    } catch (err: unknown) {
      const msg = errMsg(err);
      // Self-heal: 401 from OpenRouter → ask the agent to rotate the key
      // from Doppler and retry once.
      let rotationAttempted = false;
      if (isOpenRouterAuthError(err)) {
        const fresh =
          await agent.rotateOpenRouterKeyFromDoppler("runKimiWithPoll");
        if (fresh) {
          rotationAttempted = true;
          try {
            const retried = await callOpenRouterWithContinuation(fresh);
            if (retried && !isDegenerateOutput(retried)) return retried;
            agent.log(
              "warning",
              retried
                ? `[kimi-model] OpenRouter returned degenerate output after key rotation (${retried.length} chars); falling back to Workers AI`
                : "[kimi-model] OpenRouter returned empty after key rotation; falling back to Workers AI",
              "contentCreator"
            );
          } catch (retryErr: unknown) {
            agent.log(
              "warning",
              `[kimi-model] OpenRouter retry after rotation failed (${errMsg(retryErr)}); falling back to Workers AI`,
              "contentCreator"
            );
          }
          // The rotation+retry path already logged all relevant context above.
          // Skip the generic "call failed" message so operators don't see a
          // second warning that re-reports the original auth error as if it
          // were a new unrelated failure.
        } else {
          // rotateOpenRouterKeyFromDoppler already logged why rotation could
          // not produce a fresh key. Emit only the fallback notice so
          // operators know execution continues on Workers AI — without
          // re-reporting the 401 as an unrelated generic failure.
          rotationAttempted = true;
          agent.log(
            "warning",
            "[kimi-model] OpenRouter 401 — key rotation did not produce a fresh key (see prior warning); falling back to Workers AI",
            "contentCreator"
          );
        }
      }
      if (!rotationAttempted) {
        agent.log(
          "warning",
          `${OPENROUTER_CALL_FAILED_LOG_PREFIX} (${msg}); falling back to Workers AI`,
          "contentCreator"
        );
      }
    }
  }

  // ── Workers AI fallback (AI_CHAT_FALLBACK=kimi only) ────────────────────
  // Runs on fast Qwen3, NOT @cf/moonshotai/kimi-k2.5. The Kimi binding
  // routinely overruns the 150s sync timeout on real generations and rejects
  // batch queuing (error 8007), so when OpenRouter credits are exhausted the
  // hatch had no working path — that wedge caused the 6/6→6/10 publish
  // drought. Qwen3 (MoE, ~3B active params) completes inside the sync window
  // and supports batch. This block is not reached unless
  // `AI_CHAT_FALLBACK=kimi`.
  //
  // No continuation handling here — `aiGenerateWithPoll` does not expose
  // finishReason. The writer issues bounded per-section calls (≤4096 tokens),
  // so truncation is unlikely; threading finishReason through is the follow-up
  // if it recurs.
  const workersAiResult = await aiGenerateWithPoll(
    env.AI,
    WORKERS_AI_QWEN_MODEL,
    params,
    {
      ...opts,
      onWarn: (msg) =>
        agent.log("warning", `[kimi-model] ${msg}`, "contentCreator")
    }
  );
  // No further fallback exists past Workers AI, so this is diagnostic-only —
  // still return the result and let the downstream thin-content/SEO-score
  // gates make the final call, but flag it clearly so a degenerate Workers
  // AI response isn't mistaken for an OpenRouter-side issue when triaging.
  if (isDegenerateOutput(workersAiResult)) {
    agent.log(
      "warning",
      `[kimi-model] Workers AI (last-resort fallback) returned degenerate output (${workersAiResult.length} chars, alpha-ratio below threshold — likely token-repetition collapse); no further fallback available, returning as-is for downstream gates to reject`,
      "contentCreator"
    );
  }
  return workersAiResult;
}
