/**
 * kimi-model.ts — Provider selector for article / pipeline calls.
 *
 * **Claude-first (staging):** every call site here tries the Claude Code
 * subscription (`./claude-code-subscription`) before Kimi. Unlike prod
 * (Claude-only, OpenRouter commented out), staging must keep
 * working when there is no active Claude credential, so the existing
 * OpenRouter Kimi path below remains a real fallback — not dead
 * code. Claude is skipped (falling straight through to Kimi) when:
 *   - there is no active Claude subscription token
 *     (`resolveClaudeCodeSubscription` returns null), or
 *   - a prior Anthropic 429 put us in a rate-limit cooldown
 *     (`getClaudeRateLimitCooldownRemainingMs() > 0`), or
 *   - the Claude call itself fails (including auth errors —
 *     `isClaudeAuthError`).
 *
 * When `env.OPENROUTER_API_KEY` is set, the Kimi fallback routes through
 * OpenRouter (~33% cheaper on K2.5: $0.44/$2.00 per M tokens vs the Workers
 * AI pricing this module no longer uses). When the key is unset, calls stay
 * on the Claude Code subscription.
 *
 * - `getKimiModel(env)` → returns a LanguageModel for use with Vercel AI
 *   SDK `generateText()` / `generateObject()` sites. Returns the Claude
 *   LanguageModel when a subscription is active and not cooling down,
 *   otherwise the OpenRouter Kimi model. Because this returns a
 *   model reference (not an awaited call), it cannot retry mid-call — a
 *   Claude auth/runtime error surfacing from a `generateText()` call built
 *   on this model is the caller's to handle. `runKimiWithPoll` below is the
 *   integration point with real try-Claude-then-fall-back behavior.
 * - `runKimiWithPoll(env, params)` → the awaited call helper used at the
 *   writer / siss-optimizer call sites. Tries Claude first; on
 *   no-subscription/cooldown/failure falls through to OpenRouter via AI
 *   SDK. There is no third leg: Workers AI was removed (see below).
 *
 * **No Workers AI.** Every `env.AI` path in this module is gone. Workers AI
 * inference is billed in neurons, and the Aug 14 – Sep 13, 2026 Cloudflare
 * invoice charged 65,371,887 of them ($719.09 of a $788.68 bill). The
 * Claude Code subscription is already paid for and costs no neurons, so it
 * serves these calls instead. Do not reintroduce an `env.AI` fallback here.
 *
 * Kimi thinking mode is disabled on the OpenRouter path so max_tokens fund
 * content, not reasoning:
 *   - OpenRouter: `providerOptions.openrouter.reasoning = { enabled: false }`
 *     ⚠️  `{ exclude: true }` only HIDES reasoning output — Kimi still burns
 *     max_tokens on it and returns `content: null`. `{ enabled: false }`
 *     actually disables reasoning so tokens fund visible content.
 * Claude needs no such provider options — `getKimiProviderOptions` returns
 * `undefined` whenever the Claude path is in play.
 */

import { errMsg } from "./http-utils";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { SEOArticleAgent } from "../server";
import {
  callClaudeCodeText,
  CLAUDE_CODE_CALL_FAILED_LOG_PREFIX,
  getClaudeCodeLanguageModel,
  getClaudeCodeModelId,
  getClaudeRateLimitCooldownRemainingMs,
  isClaudeAuthError,
  lastClaudeSuccessMeta,
  resolveClaudeCallTimeoutMs,
  resolveClaudeCodeSubscription
} from "./claude-code-subscription";

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

/**
 * Per-call knobs for `runKimiWithPoll`. This used to be `ai-poll.ts`'s
 * options type, back when the terminal fallback was a Workers AI
 * sync→async-batch runner; that module is gone along with the neuron
 * spend, so the surviving fields are the ones both remaining legs honour.
 */
export interface AiPollOptions {
  /**
   * Total wall-clock budget for one call, in ms. Applied to the Claude leg
   * and, capped by the provider's own ceiling, to the OpenRouter leg — a
   * caller's budget must not be silently replaced by a leg's default.
   */
  syncTimeoutMs?: number;
  /** Routes transient warnings to the activity feed instead of console. */
  onWarn?: (msg: string) => void;
}
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
 * AI. Unlike `runKimiWithPoll`, this returns a model reference rather than
 * an awaited call, so it cannot retry Claude→Kimi mid-request; callers that
 * need that resilience (writer, siss-optimizer, text-editor-agent,
 * editorial-agent, keywords) should use `runKimiWithPoll` instead.
 *
 * The OpenRouter path disables Kimi's thinking mode so max_tokens fund
 * visible content, not internal reasoning that overflows and leaves
 * content="": `providerOptions.openrouter.reasoning.enabled=false`, applied
 * separately via `getKimiProviderOptions(env)`.
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
  // No third provider. Workers AI used to sit here and is what turned a
  // month of writer traffic into a 65M-neuron invoice; every hot call site
  // (writer, qc, polish, traffic-sources, intent-gap, …) already wraps its
  // `generateText`/`generateObject` in try/catch and treats a provider
  // failure as "this step produced nothing".
  throw new NoModelProviderError(
    "no Claude Code subscription and no OPENROUTER_API_KEY"
  );
}

/**
 * Thrown when neither Claude nor OpenRouter can serve a call. Typed so call
 * sites can tell "provider not configured" apart from "the model failed".
 */
export class NoModelProviderError extends Error {
  constructor(detail: string) {
    super(`No model provider available: ${detail}`);
    this.name = "NoModelProviderError";
  }
}

/**
 * OpenRouter's Free Models Router (`openrouter/free`) — auto-routes to an
 * available free model at zero credit cost using the same
 * `OPENROUTER_API_KEY`. Used where basic text generation doesn't need
 * Kimi-grade output and a paid-credit outage must not block the pipeline:
 * the category scout (all attempts) and keyword-generation retries.
 * Falls back to the Claude Code subscription when no OpenRouter key is
 * configured (local dev).
 */
export function getFreeModel(env: Env): LanguageModel {
  const key = resolveOpenRouterKey(env);
  if (key) {
    return createOpenRouter({ apiKey: key })(OPENROUTER_FREE_MODEL);
  }
  // Was Workers AI Kimi; now the Claude Code subscription, which is already
  // paid for and costs no neurons.
  if (useClaudeForKimi(env)) {
    const claude = getClaudeCodeLanguageModel(env);
    if (claude) return claude;
  }
  throw new NoModelProviderError(
    "no OPENROUTER_API_KEY and no Claude Code subscription"
  );
}

/**
 * Model for the category scout. Runs on the Claude Code subscription, with
 * the OpenRouter free-model router behind it —
 * regardless of whether `OPENROUTER_API_KEY` is set. The scout is a low-stakes,
 * high-frequency discovery task that does not need Kimi-grade output, so this
 * keeps it off paid credits and off the shared Kimi quota. `enable_thinking:
 * false` keeps Qwen3's default reasoning from overflowing the scout's modest
 * output budget and returning empty content.
 */
export function getScoutModel(env: Env): LanguageModel {
  // Was the one surface that ran on `env.AI` unconditionally (Qwen3-30B, up
  // to 3 attempts x 2000 output tokens per tick), which made it a standing
  // neuron charge no fallback ever relieved. It now runs on the Claude Code
  // subscription like every other model call, with the OpenRouter free-model
  // router behind it so a Claude outage does not stop category discovery.
  if (useClaudeForKimi(env)) {
    const claude = getClaudeCodeLanguageModel(env);
    if (claude) return claude;
  }
  const key = resolveOpenRouterKey(env);
  if (key) {
    return createOpenRouter({ apiKey: key })(OPENROUTER_FREE_MODEL);
  }
  // `pickNextCategory` catches per attempt and falls through to its
  // hardcoded Tier 2 category pool, so refusing here is safe.
  throw new NoModelProviderError(
    "no Claude Code subscription and no OPENROUTER_API_KEY"
  );
}

/**
 * Provider options to pass to `generateText()` so Kimi thinking stays off.
 * Only OpenRouter needs thinking disabled
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
 * Hard cap on continuation rounds when Kimi returns `finishReason: "length"`.
 * Each round costs ~one max_tokens budget, so 2 rounds = up to 3× the
 * normal call cost. In practice the writer's article-body generation
 * very rarely needs more than 1 round; this exists so a runaway prompt
 * can't burn unbounded cost.
 */
const MAX_CONTINUATION_ROUNDS = 2;

/**
 * Claude-first with a Kimi fallback, so staging never goes dark for lack of
 * a Claude credential:
 *  1. If a Claude Code subscription is active and we are not in an
 *     Anthropic rate-limit cooldown, call `callClaudeCodeText()`. On
 *     success, return its text. On failure (including auth errors), no
 *     subscription, or an active cooldown, fall through to Kimi.
 *  2. If OPENROUTER_API_KEY is set, call OpenRouter via AI SDK
 *     `generateText()`. On HTTP error or empty response, fall through.
 *  3. Nothing. Workers AI was the third leg and is gone — it is what the
 *     65M-neuron invoice was made of. A call that gets here throws
 *     `NoModelProviderError`.
 *
 * All call sites must pass an `agent` for proper logging.
 *
 * Truncation handling (OpenRouter path only): when `finishReason ===
 * "length"` the response stops mid-sentence — this is the root cause of
 * "ends with ..." paragraphs on the live site. We detect this and issue
 * up to `MAX_CONTINUATION_ROUNDS` continuation calls, each prompting
 * Kimi to resume from the cut point and finish cleanly. The concatenated
 * text is returned as if it were a single response. Claude's response is
 * not continuation-chased here — `callClaudeCodeText` uses its own
 * `max_tokens` budget and this call site's callers size it generously;
 * the Kimi continuation dance exists specifically to compensate for
 * Kimi's smaller effective output budget on OpenRouter.
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

  // The caller's budget has to reach this leg. It used to terminate at the
  // Workers AI runner (`ai-poll`'s syncTimeoutMs); with that gone, OpenRouter
  // is the last leg and must honour it rather than silently substituting its
  // own 120s default for a caller that asked for less.
  const openRouterTimeoutMs = Math.min(
    OPENROUTER_CALL_TIMEOUT_MS,
    opts.syncTimeoutMs ?? OPENROUTER_CALL_TIMEOUT_MS
  );
  if (opts.syncTimeoutMs != null) {
    const note = `[kimi-model] syncTimeoutMs=${opts.syncTimeoutMs} applied to the OpenRouter leg`;
    agent.log("info", note, "contentCreator");
    opts.onWarn?.(note);
  }

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
      abortSignal: AbortSignal.timeout(openRouterTimeoutMs)
    });
    if (text && text.trim().length > 0) {
      return { text, finishReason: String(finishReason ?? "") };
    }
    return null;
  };

  /**
   * Run the initial call + continuation loop. Returns concatenated text
   * once a non-length finish (`stop`, `content_filter`, etc.) is seen or
   * the round cap is hit.
   */
  const callOpenRouterWithContinuation = async (
    apiKey: string
  ): Promise<string | null> => {
    const initial = await callOpenRouter(apiKey, messages);
    if (!initial) return null;
    let combined = initial.text;
    let finish = initial.finishReason;
    let rounds = 0;
    while (finish === "length" && rounds < MAX_CONTINUATION_ROUNDS) {
      rounds++;
      agent.log(
        "info",
        `[kimi-model] finishReason=length, requesting continuation ${rounds}/${MAX_CONTINUATION_ROUNDS} (current length: ${combined.length} chars)`,
        "contentCreator"
      );
      // Standard continuation prompt: feed the partial back as an
      // assistant turn and ask the user-turn to resume. Kimi handles this
      // pattern natively and produces seamless concatenated output.
      const continuationMessages: Array<{
        role: "user" | "system" | "assistant";
        content: string;
      }> = [
        ...messages,
        { role: "assistant", content: combined },
        {
          role: "user",
          content:
            "Continue from exactly where you left off. Do not repeat any text. Do not add a preamble. Finish the response cleanly so the final character is part of a complete sentence (or, if you were emitting JSON, a complete and valid JSON object)."
        }
      ];
      const next = await callOpenRouter(apiKey, continuationMessages);
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
  };

  // ── Claude path (primary) ───────────────────────────────────────────────
  // Try the Claude Code subscription first. We only attempt this when a
  // token is on file and we are not sitting out a prior 429's cooldown —
  // both checks are synchronous and cheap, so we can skip straight to Kimi
  // without ever touching the network on a known-bad Claude state. Any
  // other failure (auth error, timeout, degenerate output, empty response)
  // is caught below and also falls through to Kimi — staging must not go
  // dark just because the Claude credential is missing or expired.
  if (!resolveClaudeCodeSubscription(env)) {
    agent.log(
      "info",
      "[claude-code] no active Claude subscription token; using Kimi (OpenRouter)",
      "contentCreator"
    );
  } else {
    const claudeCooldownMs = getClaudeRateLimitCooldownRemainingMs();
    if (claudeCooldownMs > 0) {
      agent.log(
        "info",
        `[claude-code] skipping Claude — ${Math.ceil(claudeCooldownMs / 1000)}s remaining in Anthropic rate-limit cooldown; using Kimi (OpenRouter)`,
        "contentCreator"
      );
    } else {
      const claudeCallTimeoutMs = resolveClaudeCallTimeoutMs(
        opts.syncTimeoutMs
      );
      try {
        const claudeText = await callClaudeCodeText(env, {
          ...params,
          timeoutMs: claudeCallTimeoutMs
        });
        if (claudeText && !isDegenerateOutput(claudeText)) {
          const meta = lastClaudeSuccessMeta;
          agent.log(
            "info",
            `[claude-code] primary OK (${claudeText.length} chars, model=${meta?.modelId ?? getClaudeCodeModelId(env)}, source=${meta?.tokenSource ?? "unknown"})`,
            "contentCreator"
          );
          return claudeText;
        }
        if (claudeText) {
          agent.log(
            "warning",
            `[claude-code] returned degenerate output (${claudeText.length} chars, alpha-ratio below threshold — likely token-repetition collapse); falling back to Kimi (OpenRouter)`,
            "contentCreator"
          );
        } else {
          agent.log(
            "warning",
            "[claude-code] returned empty; falling back to Kimi (OpenRouter)",
            "contentCreator"
          );
        }
      } catch (err: unknown) {
        const msg = errMsg(err);
        const auth = isClaudeAuthError(err);
        const tag = auth ? " (auth)" : "";
        agent.log(
          "warning",
          `${CLAUDE_CODE_CALL_FAILED_LOG_PREFIX}${tag} (${msg}); falling back to Kimi (OpenRouter)`,
          "contentCreator"
        );
      }
    }
  }

  // ── OpenRouter path ─────────────────────────────────────────────────────
  const key = resolveOpenRouterKey(env);
  if (key) {
    try {
      const text = await callOpenRouterWithContinuation(key);
      if (text && !isDegenerateOutput(text)) return text;
      if (text) {
        agent.log(
          "warning",
          `[kimi-model] OpenRouter returned degenerate output (${text.length} chars, alpha-ratio below threshold — likely token-repetition collapse); no provider left after OpenRouter`,
          "contentCreator"
        );
      } else {
        agent.log(
          "warning",
          "[kimi-model] OpenRouter returned empty; no provider left after OpenRouter",
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
                ? `[kimi-model] OpenRouter returned degenerate output after key rotation (${retried.length} chars); no provider left after OpenRouter`
                : "[kimi-model] OpenRouter returned empty after key rotation; no provider left",
              "contentCreator"
            );
          } catch (retryErr: unknown) {
            agent.log(
              "warning",
              `[kimi-model] OpenRouter retry after rotation failed (${errMsg(retryErr)}); no provider left after OpenRouter`,
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
          // operators know the call is about to fail outright — without
          // re-reporting the 401 as an unrelated generic failure.
          rotationAttempted = true;
          agent.log(
            "warning",
            "[kimi-model] OpenRouter 401 — key rotation did not produce a fresh key (see prior warning); no provider left",
            "contentCreator"
          );
        }
      }
      if (!rotationAttempted) {
        agent.log(
          "warning",
          `${OPENROUTER_CALL_FAILED_LOG_PREFIX} (${msg}); no provider left after Claude and OpenRouter`,
          "contentCreator"
        );
      }
    }
  }

  // ── No provider left ────────────────────────────────────────────────────
  // Workers AI used to sit here, on Qwen3 via a sync→async-batch runner. It
  // was the last-resort leg, which is exactly why it became expensive: when
  // OpenRouter credits ran dry the entire writer landed on it for as long as
  // that lasted, and a month of that is what the 65M-neuron invoice was. The
  // Claude Code subscription now serves this call from the top of the
  // function, so reaching this point means Claude and OpenRouter both failed
  // or are unconfigured, and there is nothing cheaper to try.
  //
  // Throwing rather than returning "" is deliberate: every caller treats a
  // throw as "this step produced nothing" and has its own recovery, whereas
  // an empty string reads as a successful generation and can publish.
  agent.log(
    "warning",
    "[kimi-model] Claude and OpenRouter both unavailable; no Workers AI " +
      "fallback exists any more, so this call produces nothing",
    "contentCreator"
  );
  throw new NoModelProviderError(
    "Claude Code subscription and OpenRouter both unavailable for this call"
  );
}
