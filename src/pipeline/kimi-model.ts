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
import type { LanguageModel } from "ai";
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

/** Called by the agent's self-heal after a successful Doppler rotation. */
export function setRotatedOpenRouterKey(_key: string | null): void {
  // No-op. OpenRouter is no longer a provider, so a rotated OpenRouter key has
  // nothing to configure. Kept as an export because `server.ts`'s Doppler
  // self-heal path (`rotateOpenRouterKeyFromDoppler`) still calls it; that
  // path is now dead weight and is the next thing to delete.
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
 * Returns the Claude Code subscription LanguageModel, or throws.
 *
 * Claude is the ONLY model provider in this repo. OpenRouter/Kimi used to sit
 * behind Claude here and Workers AI behind that; both are gone. There is
 * deliberately nothing to fall back to — see § One provider in CLAUDE.md.
 */
export function getKimiModel(env: Env): LanguageModel {
  return requireClaude(env);
}

/**
 * Thrown when Claude cannot serve a call. Typed so call sites can tell
 * "provider not configured" apart from "the model failed".
 */
export class NoModelProviderError extends Error {
  constructor(detail: string) {
    super(`No model provider available: ${detail}`);
    this.name = "NoModelProviderError";
  }
}

/**
 * The single provider gate. Every model selector in this module funnels
 * through here, so there is exactly one place that decides what runs.
 */
function requireClaude(env: Env): LanguageModel {
  if (useClaudeForKimi(env)) {
    const claude = getClaudeCodeLanguageModel(env);
    if (claude) return claude;
  }
  throw new NoModelProviderError(
    "the Claude Code subscription is the only configured provider and it is " +
      "unavailable (no token, an expired/invalid token, or an active " +
      "rate-limit cooldown)"
  );
}

/**
 * Formerly the OpenRouter free-model router for low-stakes work. Claude now
 * serves it, so this is an alias kept for the existing call sites.
 */
export function getFreeModel(env: Env): LanguageModel {
  return requireClaude(env);
}

/**
 * Category-scout model. Was Qwen3-30B on `env.AI`, then Claude-with-OpenRouter
 * behind it; now Claude only. `pickNextCategory` catches per attempt and falls
 * through to its hardcoded Tier 2 category pool, so throwing here is safe.
 */
export function getScoutModel(env: Env): LanguageModel {
  return requireClaude(env);
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
export function getKimiProviderOptions(_env: Env): undefined {
  // Only ever carried OpenRouter's `reasoning` flag. Claude needs no provider
  // options, and OpenRouter is gone, so this is always undefined. Kept so the
  // ~8 `generateText`/`generateObject` call sites need no edit.
  return undefined;
}

/**
 * Awaited text call used by the writer, siss-optimizer, text-editor,
 * editorial-agent, idle-tick and keywords call sites.
 *
 * **Claude only.** This used to be Claude → OpenRouter/Kimi → Workers AI.
 * Workers AI went first (it is what the 65M-neuron invoice was made of), and
 * OpenRouter went with this change, so there is exactly one provider left and
 * nothing to fall back to.
 *
 * On any Claude failure this THROWS rather than returning "". Every caller
 * treats a throw as "this step produced nothing" and has its own recovery,
 * whereas an empty string reads as a successful generation and can publish.
 *
 * `opts.syncTimeoutMs` is the caller's wall-clock budget and is honoured
 * (via `resolveClaudeCallTimeoutMs`) rather than silently replaced.
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
  if (opts.syncTimeoutMs != null) {
    const note = `[kimi-model] syncTimeoutMs=${opts.syncTimeoutMs} applied to the Claude call`;
    agent.log("info", note, "contentCreator");
    opts.onWarn?.(note);
  }

  const cooldownMs = getClaudeRateLimitCooldownRemainingMs();
  if (cooldownMs > 0) {
    const msg =
      `[claude-code] skipping Claude — ${Math.ceil(cooldownMs / 1000)}s ` +
      "remaining in Anthropic rate-limit cooldown, and Claude is the only " +
      "provider, so this call produces nothing";
    agent.log("warning", msg, "contentCreator");
    throw new NoModelProviderError(msg);
  }

  if (resolveClaudeCodeSubscription(env) == null) {
    const msg =
      "[claude-code] no active Claude subscription token, and Claude is the " +
      "only provider, so this call produces nothing";
    agent.log("warning", msg, "contentCreator");
    throw new NoModelProviderError(msg);
  }

  try {
    const claudeText = await callClaudeCodeText(env, {
      ...params,
      timeoutMs: resolveClaudeCallTimeoutMs(opts.syncTimeoutMs)
    });
    if (claudeText && !isDegenerateOutput(claudeText)) {
      const meta = lastClaudeSuccessMeta;
      agent.log(
        "info",
        `[claude-code] OK (${claudeText.length} chars, model=${meta?.modelId ?? getClaudeCodeModelId(env)}, source=${meta?.tokenSource ?? "unknown"})`,
        "contentCreator"
      );
      return claudeText;
    }
    // Degenerate or empty. There is no second provider to try, so surface it
    // as a failure instead of handing unusable text to the publish gates.
    const detail = claudeText
      ? `returned degenerate output (${claudeText.length} chars, alpha-ratio below threshold — likely token-repetition collapse)`
      : "returned empty";
    agent.log("warning", `[claude-code] ${detail}`, "contentCreator");
    throw new NoModelProviderError(`Claude ${detail}`);
  } catch (err: unknown) {
    if (err instanceof NoModelProviderError) throw err;
    const msg = errMsg(err);
    agent.log(
      isClaudeAuthError(err) ? "error" : "warning",
      `${CLAUDE_CODE_CALL_FAILED_LOG_PREFIX} (${msg}); no fallback provider exists`,
      "contentCreator"
    );
    throw err;
  }
}
