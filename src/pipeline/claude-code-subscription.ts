/**
 * Claude Code subscription OAuth token — primary AI path before OpenRouter /
 * Workers AI.
 *
 * Official auth flow (Claude Code docs — Authentication → Generate a long-lived
 * token): https://code.claude.com/docs/en/authentication
 *
 *   1. On any machine with Claude Code + Pro/Max/Team/Enterprise plan:
 *        claude setup-token
 *   2. Complete the browser authorize flow (same as /login).
 *   3. Copy the printed **one-year OAuth token** and paste it in the SEO
 *      dashboard (or set CLAUDE_CODE_OAUTH_TOKEN).
 *
 * OAuth tokens (typically `sk-ant-oat01-…`) authenticate as
 * `Authorization: Bearer` (AI SDK `authToken`). Console API keys
 * (`sk-ant-api…`) use `x-api-key` (`apiKey`). We auto-detect by prefix.
 *
 * Token is stored in Durable Object SQLite (`pipeline_secrets`), not in
 * broadcast `SEOAgentState` (only masked status is public).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { errMsg } from "./http-utils";
import { refreshClaudeOAuthToken } from "./claude-oauth-flow";

/** Default subscription lifetime when the operator does not pick a date. */
export const CLAUDE_CODE_DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Strong default for long-form SEO writing. Override via
 * `CLAUDE_CODE_MODEL` env if Anthropic renames the id.
 * Prefer current alias — live 2026-08: dated `claude-sonnet-4-20250514`
 * returns 404 not_found for OAuth tokens on api.anthropic.com.
 */
export const DEFAULT_CLAUDE_CODE_MODEL = "claude-sonnet-4-5";

/** Tried in order when the primary model returns not_found. */
export const CLAUDE_CODE_MODEL_FALLBACKS = [
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-0",
  "claude-sonnet-4-20250514"
] as const;

export const CLAUDE_CODE_CALL_FAILED_LOG_PREFIX =
  "[claude-code] Anthropic call failed";

/** Default per-call abort budget when the caller does not size one. */
export const CLAUDE_CALL_TIMEOUT_MS = 120_000;

/**
 * Ceiling for a caller-supplied budget. A Claude call runs inside a Durable
 * Object step, so an unbounded budget would pin the pipeline on one article.
 */
export const CLAUDE_MAX_CALL_TIMEOUT_MS = 300_000;

/** Resolve the abort budget for one call: caller value, clamped, else default. */
export function resolveClaudeCallTimeoutMs(requested?: number): number {
  if (!Number.isFinite(requested) || (requested as number) <= 0) {
    return CLAUDE_CALL_TIMEOUT_MS;
  }
  return Math.min(Math.floor(requested as number), CLAUDE_MAX_CALL_TIMEOUT_MS);
}

/** SQL key for the durable secret row. */
export const CLAUDE_CODE_SECRET_KEY = "claude_code_subscription";

/**
 * Claude Code OAuth / setup-token shape (subscription plan).
 * See docs: `claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN.
 * Canonical prefix from community + Claude Code tooling: sk-ant-oat01-
 */
export function isClaudeCodeOAuthToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  // setup-token / claude.ai OAuth access tokens
  if (t.startsWith("sk-ant-oat")) return true;
  // refresh tokens (not used as request auth, but treat as OAuth family)
  if (t.startsWith("sk-ant-ort")) return true;
  return false;
}

/**
 * Console pay-per-token API key (`x-api-key`).
 */
export function isAnthropicApiKey(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t.startsWith("sk-ant-api") || t.startsWith("sk-ant-admin");
}

/**
 * Validate a token the operator pastes after `claude setup-token`.
 * Prefers subscription OAuth (`sk-ant-oat…`); allows Console API keys with a warning.
 */
export function validateClaudeCodeTokenInput(token: string): {
  ok: boolean;
  error?: string;
  warning?: string;
  kind: "oauth" | "api_key" | "unknown";
} {
  const t = token.trim();
  if (t.length < 20) {
    return {
      ok: false,
      kind: "unknown",
      error:
        "Token too short. Run `claude setup-token`, authorize in the browser, and paste the full printed token (usually starts with sk-ant-oat01-)."
    };
  }
  if (isClaudeCodeOAuthToken(t)) {
    if (!/^sk-ant-oat01-/i.test(t) && !/^sk-ant-oat/i.test(t)) {
      return {
        ok: true,
        kind: "oauth",
        warning: "Unusual OAuth token prefix — expected sk-ant-oat01-…"
      };
    }
    return { ok: true, kind: "oauth" };
  }
  if (isAnthropicApiKey(t)) {
    return {
      ok: true,
      kind: "api_key",
      warning:
        "This looks like a Claude Console API key (pay-per-token), not a subscription setup-token. For Pro/Max plan quota use `claude setup-token` (sk-ant-oat01-…)."
    };
  }
  return {
    ok: false,
    kind: "unknown",
    error:
      "Token format invalid. Subscription OAuth tokens from `claude setup-token` start with sk-ant-oat01-."
  };
}

/** Dashboard status band for countdown UI. */
export type ClaudeCodeUiStatus =
  | "active"
  | "expiring_soon"
  | "expired"
  | "none";

export function claudeCodeUiStatus(
  status: ClaudeCodeSubscriptionStatus
): ClaudeCodeUiStatus {
  if (!status.configured) return "none";
  if (!status.active) return "expired";
  const days = status.daysRemaining ?? 0;
  if (days <= 7) return "expiring_soon";
  return "active";
}

export type ClaudeCodeSubscriptionRecord = {
  token: string;
  /** Unix ms when the token stops being preferred. */
  expiresAtMs: number;
  /** ISO when the operator last saved the token. */
  savedAt: string;
  /** OAuth refresh_token from Claude Code PKCE exchange (optional). */
  refreshToken?: string;
};

/** Safe for dashboard / state broadcast — never includes the raw token. */
export type ClaudeCodeSubscriptionStatus = {
  configured: boolean;
  active: boolean;
  /** Coarse band for UI color: active | expiring_soon | expired | none */
  uiStatus: ClaudeCodeUiStatus;
  expiresAt: string | null;
  daysRemaining: number | null;
  tokenLast4: string | null;
  /** Masked form e.g. `…JwAA` */
  maskedToken: string | null;
  savedAt: string | null;
  source: "dashboard" | "env" | null;
};

type ClaudeCodeEnv = {
  /** Official env name from Claude Code docs (`claude setup-token`). */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  /** Legacy alias used by earlier dashboard wiring. */
  CLAUDE_CODE_SUBSCRIPTION_TOKEN?: string;
  CLAUDE_CODE_SUBSCRIPTION_EXPIRES_AT?: string;
  CLAUDE_CODE_MODEL?: string;
  /** Console API key (pay-per-token) — not subscription OAuth. */
  ANTHROPIC_API_KEY?: string;
};

let _cached: ClaudeCodeSubscriptionRecord | null = null;
let _cacheSource: "dashboard" | "env" | null = null;

export function configureClaudeCodeSubscription(
  record: ClaudeCodeSubscriptionRecord | null,
  source: "dashboard" | "env" | null = record ? "dashboard" : null
): void {
  if (!record?.token?.trim()) {
    _cached = null;
    _cacheSource = null;
    return;
  }
  _cached = {
    token: record.token.trim(),
    expiresAtMs: record.expiresAtMs,
    savedAt: record.savedAt || new Date().toISOString(),
    // MUST be preserved: dropping it here made every refresh path (dashboard
    // "Refresh" button and the on-401 auto-refresh below) fall through to the
    // "no refresh_token on file" branch, which only extended the *local*
    // expiry while the real 8h OAuth access_token stayed dead.
    refreshToken: record.refreshToken?.trim() || undefined
  };
  _cacheSource = source;
}

/** Test helper — clear module cache between cases. */
export function clearClaudeCodeSubscriptionCache(): void {
  _cached = null;
  _cacheSource = null;
  _refreshFailedUntilMs = 0;
  clearMintedSubscriptionApiKey();
}

export function defaultExpiresAtMs(fromMs = Date.now()): number {
  return fromMs + CLAUDE_CODE_DEFAULT_TTL_MS;
}

export function maskTokenLast4(token: string): string {
  const t = token.trim();
  if (t.length < 4) return "****";
  return t.slice(-4);
}

export function isClaudeCodeTokenActive(
  expiresAtMs: number,
  nowMs = Date.now()
): boolean {
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

export function daysRemaining(expiresAtMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(expiresAtMs)) return 0;
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / (24 * 60 * 60 * 1000)));
}

/**
 * Resolve an active Claude Code / Anthropic token for AI calls.
 * Prefers dashboard-loaded cache, then env secrets.
 */
export function resolveClaudeCodeSubscription(
  env: ClaudeCodeEnv,
  nowMs = Date.now()
): {
  token: string;
  expiresAtMs: number;
  source: "dashboard" | "env";
} | null {
  if (_cached?.token && isClaudeCodeTokenActive(_cached.expiresAtMs, nowMs)) {
    return {
      token: _cached.token,
      expiresAtMs: _cached.expiresAtMs,
      source: _cacheSource ?? "dashboard"
    };
  }

  // Prefer official CLAUDE_CODE_OAUTH_TOKEN (setup-token / subscription),
  // then dashboard aliases, then Console API key as last env fallback.
  const envToken =
    env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
    env.CLAUDE_CODE_SUBSCRIPTION_TOKEN?.trim() ||
    env.ANTHROPIC_API_KEY?.trim() ||
    "";
  if (!envToken) return null;

  let expiresAtMs = defaultExpiresAtMs(nowMs);
  const rawExp = env.CLAUDE_CODE_SUBSCRIPTION_EXPIRES_AT?.trim();
  if (rawExp) {
    const parsed = Date.parse(rawExp);
    if (Number.isFinite(parsed)) expiresAtMs = parsed;
  }
  if (!isClaudeCodeTokenActive(expiresAtMs, nowMs)) return null;

  return { token: envToken, expiresAtMs, source: "env" };
}

function buildStatus(
  partial: Omit<ClaudeCodeSubscriptionStatus, "uiStatus" | "maskedToken"> & {
    maskedToken?: string | null;
  }
): ClaudeCodeSubscriptionStatus {
  const tokenLast4 = partial.tokenLast4;
  const maskedToken =
    partial.maskedToken ?? (tokenLast4 ? `…${tokenLast4}` : null);
  const base: ClaudeCodeSubscriptionStatus = {
    ...partial,
    maskedToken,
    uiStatus: "none"
  };
  base.uiStatus = claudeCodeUiStatus(base);
  return base;
}

export function claudeCodeSubscriptionStatus(
  env: ClaudeCodeEnv,
  nowMs = Date.now()
): ClaudeCodeSubscriptionStatus {
  // Prefer showing dashboard cache even if expired (operator must renew)
  if (_cached?.token) {
    const active = isClaudeCodeTokenActive(_cached.expiresAtMs, nowMs);
    return buildStatus({
      configured: true,
      active,
      expiresAt: new Date(_cached.expiresAtMs).toISOString(),
      daysRemaining: daysRemaining(_cached.expiresAtMs, nowMs),
      tokenLast4: maskTokenLast4(_cached.token),
      savedAt: _cached.savedAt,
      source: _cacheSource ?? "dashboard"
    });
  }

  const resolved = resolveClaudeCodeSubscription(env, nowMs);
  if (!resolved) {
    return buildStatus({
      configured: false,
      active: false,
      expiresAt: null,
      daysRemaining: null,
      tokenLast4: null,
      savedAt: null,
      source: null
    });
  }
  return buildStatus({
    configured: true,
    active: true,
    expiresAt: new Date(resolved.expiresAtMs).toISOString(),
    daysRemaining: daysRemaining(resolved.expiresAtMs, nowMs),
    tokenLast4: maskTokenLast4(resolved.token),
    savedAt: null,
    source: resolved.source
  });
}

/** Expose current in-memory record for refresh/clear (token never leaves server). */
export function getClaudeCodeCachedRecord(): ClaudeCodeSubscriptionRecord | null {
  return _cached;
}

export function parseClaudeCodeSubscriptionJson(
  raw: string | null | undefined
): ClaudeCodeSubscriptionRecord | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ClaudeCodeSubscriptionRecord>;
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    const expiresAtMs = Number(parsed.expiresAtMs);
    if (!token || !Number.isFinite(expiresAtMs)) return null;
    return {
      token,
      expiresAtMs,
      savedAt:
        typeof parsed.savedAt === "string" && parsed.savedAt
          ? parsed.savedAt
          : new Date().toISOString(),
      refreshToken:
        typeof parsed.refreshToken === "string" && parsed.refreshToken.trim()
          ? parsed.refreshToken.trim()
          : undefined
    };
  } catch {
    return null;
  }
}

export function getClaudeCodeModelId(env: ClaudeCodeEnv): string {
  return env.CLAUDE_CODE_MODEL?.trim() || DEFAULT_CLAUDE_CODE_MODEL;
}

/**
 * Required system identity for Claude Code subscription OAuth (Bearer) calls.
 * Without this block Anthropic rejects the credential as "only authorized for
 * use with Claude Code". Promptfoo + Claude Code reverse-engineering + OpenCode
 * all prepend this exact first system block on every Messages request.
 * @see https://www.promptfoo.dev/docs/providers/anthropic/
 */
export const CLAUDE_CODE_IDENTITY_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Claude Code identity headers for subscription OAuth on
 * `api.anthropic.com/v1/messages`. Beta order matches Promptfoo/OpenCode:
 * `claude-code-20250219,oauth-2025-04-20`.
 */
export const CLAUDE_OAUTH_BETA_HEADERS = {
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "user-agent": "claude-cli/1.0.0 (external, cli)",
  "x-app": "cli"
} as const;

type AnthropicSystemBlock = { type: string; text?: string };

/**
 * Force the Claude Code wire contract onto an outgoing `/v1/messages` body.
 *
 * Anthropic gates subscription OAuth credentials on the **first system block
 * being exactly** {@link CLAUDE_CODE_IDENTITY_SYSTEM}; anything else is
 * rejected with "This credential is only authorized for use with Claude Code".
 * The AI SDK collapses `system:` (a string) into ONE text block, so the old
 * `identity + "\n\n" + callerSystem` join produced a single non-matching block
 * and every article call failed auth.
 *
 * Verified against @ai-sdk/anthropic 3.0.107: N `role: "system"` messages map
 * to N `system` text blocks, so we normalize to that shape here — centrally,
 * so the ~9 `generateText({ model: getClaudeModel(...), system })` call sites
 * (QC, polish, observer, intent-gap, …) get it without each one knowing.
 */
export function applyClaudeCodeIdentityToBody(rawBody: string): string {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return rawBody;
  }
  if (!body || typeof body !== "object" || !("messages" in body)) {
    return rawBody;
  }

  const identity: AnthropicSystemBlock = {
    type: "text",
    text: CLAUDE_CODE_IDENTITY_SYSTEM
  };
  const raw = body.system;
  let blocks: AnthropicSystemBlock[];

  if (typeof raw === "string") {
    blocks = raw.trim() ? [{ type: "text", text: raw }] : [];
  } else if (Array.isArray(raw)) {
    blocks = raw as AnthropicSystemBlock[];
  } else {
    blocks = [];
  }

  const first = blocks[0];
  const firstText = typeof first?.text === "string" ? first.text : "";
  if (firstText === CLAUDE_CODE_IDENTITY_SYSTEM) {
    body.system = blocks;
    return JSON.stringify(body);
  }

  // Undo the legacy `identity\n\n<caller system>` join into two real blocks.
  if (firstText.startsWith(`${CLAUDE_CODE_IDENTITY_SYSTEM}\n`)) {
    const rest = firstText.slice(CLAUDE_CODE_IDENTITY_SYSTEM.length).trim();
    body.system = [
      identity,
      ...(rest ? [{ ...first, type: "text", text: rest }] : []),
      ...blocks.slice(1)
    ];
    return JSON.stringify(body);
  }

  body.system = [identity, ...blocks];
  return JSON.stringify(body);
}

/**
 * `fetch` wrapper for subscription OAuth calls.
 *
 * Two things the AI SDK cannot express through provider options:
 * 1. `user-agent` — provider-level headers are overwritten downstream by
 *    provider-utils' own UA, so the `claude-cli/…` UA has to be set here.
 * 2. the identity system block (see {@link applyClaudeCodeIdentityToBody}).
 */
function claudeCodeOAuthFetch(baseFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", CLAUDE_OAUTH_BETA_HEADERS["user-agent"]);
    const body =
      typeof init?.body === "string"
        ? applyClaudeCodeIdentityToBody(init.body)
        : init?.body;
    return baseFetch(input, { ...init, headers, body });
  }) as typeof fetch;
}

/**
 * Build Anthropic provider for Claude Code **subscription** OAuth tokens.
 * - setup-token / dashboard PKCE access_token (sk-ant-oat… or opaque):
 *   Authorization: Bearer + Claude Code identity headers/system block
 * - Minted subscription keys / Console keys (sk-ant-api…): x-api-key, and no
 *   identity block (a normal API credential is rejected if it claims to be
 *   Claude Code).
 */
export function createAnthropicFromClaudeCodeToken(token: string) {
  const t = token.trim();
  if (isAnthropicApiKey(t) && !isClaudeCodeOAuthToken(t)) {
    return createAnthropic({ apiKey: t });
  }
  // Subscription OAuth access_token / setup-token: Bearer + identity headers
  return createAnthropic({
    authToken: t,
    headers: { ...CLAUDE_OAUTH_BETA_HEADERS },
    fetch: claudeCodeOAuthFetch(globalThis.fetch.bind(globalThis))
  });
}

/**
 * Mint a Claude CLI API key from a subscription OAuth access_token.
 * Endpoint used by Claude Code / OpenCode after PKCE (scope org:create_api_key):
 *   POST https://api.anthropic.com/api/oauth/claude_cli/create_api_key
 * This is still **subscription** auth — not a separate Console billing key paste.
 */
export async function mintClaudeCliApiKeyFromOAuthAccessToken(
  accessToken: string
): Promise<{ rawKey: string } | { error: string; status: number }> {
  const res = await fetch(
    "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken.trim()}`,
        "content-type": "application/json",
        accept: "application/json",
        ...CLAUDE_OAUTH_BETA_HEADERS
      },
      body: "{}"
    }
  );
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      status: res.status,
      error: `create_api_key non-JSON (${res.status}): ${text.slice(0, 180)}`
    };
  }
  if (!res.ok) {
    const nested =
      json.error && typeof json.error === "object"
        ? (json.error as Record<string, unknown>)
        : null;
    const msg =
      (nested && typeof nested.message === "string" && nested.message) ||
      (typeof json.error === "string" && json.error) ||
      (typeof json.message === "string" && json.message) ||
      text.slice(0, 180);
    return { status: res.status, error: String(msg) };
  }
  const rawKey =
    (typeof json.raw_key === "string" && json.raw_key) ||
    (typeof json.rawKey === "string" && json.rawKey) ||
    (typeof json.api_key === "string" && json.api_key) ||
    (typeof json.key === "string" && json.key) ||
    "";
  if (!rawKey || rawKey.length < 20) {
    return {
      status: res.status,
      error: `create_api_key missing raw_key: ${text.slice(0, 180)}`
    };
  }
  return { rawKey };
}

/**
 * Persistence hook so a refreshed access_token survives isolate restarts.
 * The Durable Object installs this in `onStart` (writes `pipeline_secrets`);
 * without it a refresh only lives in module memory.
 */
export type ClaudeCodePersistHandler = (
  record: ClaudeCodeSubscriptionRecord
) => void | Promise<void>;

let _persistHandler: ClaudeCodePersistHandler | null = null;

export function setClaudeCodePersistHandler(
  handler: ClaudeCodePersistHandler | null
): void {
  _persistHandler = handler;
}

/** Back-off after a failed refresh before trying the endpoint again. */
export const CLAUDE_REFRESH_RETRY_COOLDOWN_MS = 5 * 60_000;

/** Set when a refresh attempt fails; suppresses retries until it passes. */
let _refreshFailedUntilMs = 0;

/** In-flight refresh, so parallel pipeline steps don't stampede the endpoint. */
let _refreshInFlight: Promise<ClaudeCodeSubscriptionRecord | null> | null =
  null;

/**
 * Exchange the stored `refresh_token` for a fresh access_token, update the
 * module cache, and persist via {@link setClaudeCodePersistHandler}.
 *
 * PKCE access tokens live ~8h (`expires_in`), so without this the pipeline
 * dies every night until someone re-authorizes on the dashboard.
 * Returns null when there is no refresh_token on file.
 */
export async function refreshClaudeCodeAccessToken(): Promise<ClaudeCodeSubscriptionRecord | null> {
  if (_refreshInFlight) return _refreshInFlight;
  const refreshToken = _cached?.refreshToken?.trim();
  if (!refreshToken) return null;
  // A refresh_token that is itself dead would otherwise add a failed
  // round-trip to every single Claude call until someone re-authorizes.
  if (Date.now() < _refreshFailedUntilMs) return null;

  _refreshInFlight = (async () => {
    try {
      const tokens = await refreshClaudeOAuthToken(refreshToken);
      const record: ClaudeCodeSubscriptionRecord = {
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? refreshToken,
        expiresAtMs: tokens.expiresAtMs,
        savedAt: new Date().toISOString()
      };
      configureClaudeCodeSubscription(record, _cacheSource ?? "dashboard");
      clearMintedSubscriptionApiKey();
      if (_persistHandler) {
        try {
          await _persistHandler(record);
        } catch {
          /* cache is already updated; persistence is best-effort */
        }
      }
      _refreshFailedUntilMs = 0;
      return record;
    } catch (err: unknown) {
      _refreshFailedUntilMs = Date.now() + CLAUDE_REFRESH_RETRY_COOLDOWN_MS;
      throw err;
    } finally {
      _refreshInFlight = null;
    }
  })();

  return _refreshInFlight;
}

/** Refresh proactively when the access_token is within this window of expiry. */
export const CLAUDE_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

/**
 * True when the stored OAuth token should be swapped for a fresh one — i.e.
 * it is within {@link CLAUDE_TOKEN_REFRESH_SKEW_MS} of expiry **or already
 * expired**. Both cases refresh deliberately: an already-expired access_token
 * is the common one (PKCE tokens last ~8h, so any overnight gap expires them),
 * and it is exactly the case that used to kill the pipeline until someone
 * re-authorized by hand. Repeated attempts on a dead refresh_token are bounded
 * by the failure cooldown in {@link refreshClaudeCodeAccessToken}, not by
 * narrowing this window.
 */
export function shouldRefreshClaudeToken(nowMs = Date.now()): boolean {
  if (!_cached?.refreshToken) return false;
  if (nowMs < _refreshFailedUntilMs) return false;
  return _cached.expiresAtMs - nowMs <= CLAUDE_TOKEN_REFRESH_SKEW_MS;
}

/** Module cache: subscription-minted key from OAuth access_token (this isolate). */
let _mintedSubscriptionApiKey: string | null = null;

export function getMintedSubscriptionApiKey(): string | null {
  return _mintedSubscriptionApiKey;
}

export function clearMintedSubscriptionApiKey(): void {
  _mintedSubscriptionApiKey = null;
}

/**
 * Split caller messages into Claude Code identity system + non-system turns.
 * Identity MUST be first system content; caller systems follow (Promptfoo).
 */
export function buildClaudeCodeSystemAndMessages(
  messages: Array<{ role: "user" | "system" | "assistant"; content: string }>
): {
  /** Legacy joined form — kept for callers that want one string. */
  system: string;
  /** Wire form: one entry per Anthropic system block, identity first. */
  systemBlocks: string[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const callerSystems: string[] = [];
  const rest: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      const c = m.content.trim();
      if (c && c !== CLAUDE_CODE_IDENTITY_SYSTEM) callerSystems.push(c);
      continue;
    }
    rest.push({ role: m.role, content: m.content });
  }
  const systemBlocks = [CLAUDE_CODE_IDENTITY_SYSTEM, ...callerSystems].filter(
    Boolean
  );
  return { system: systemBlocks.join("\n\n"), systemBlocks, messages: rest };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Anthropic rate-limit handling (platform.claude.com/docs/en/api/rate-limits):
 * - 429 + `retry-after` (seconds) — wait that long; earlier retries fail
 * - `anthropic-ratelimit-*-reset` RFC3339 when present
 * - Official SDKs retry transient 429s ~twice with backoff, honoring retry-after
 * - Do not thrash model fallbacks on 429 (same org bucket)
 */
/** Cap a single wait inside one Worker request (ms). */
export const CLAUDE_MAX_RETRY_AFTER_WAIT_MS = 90_000;
/** If Anthropic omits retry-after, default cooldown (ms). */
export const CLAUDE_DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Matches Anthropic SDK / AI SDK default retry count on 429. */
export const CLAUDE_RATE_LIMIT_MAX_RETRIES = 2;

/** Isolate-level cooldown so polish/QC do not stampede after a 429. */
let _claudeRateLimitUntilMs = 0;

export function getClaudeRateLimitCooldownRemainingMs(
  nowMs = Date.now()
): number {
  return Math.max(0, _claudeRateLimitUntilMs - nowMs);
}

export function clearClaudeRateLimitCooldown(): void {
  _claudeRateLimitUntilMs = 0;
}

export function setClaudeRateLimitCooldown(untilMs: number): void {
  if (!Number.isFinite(untilMs)) return;
  _claudeRateLimitUntilMs = Math.max(_claudeRateLimitUntilMs, untilMs);
}

export function isClaudeRateLimitError(err: unknown): boolean {
  const msg = errMsg(err);
  if (/\b429\b|rate.?limit/i.test(msg)) return true;
  if (err && typeof err === "object" && "statusCode" in err) {
    return Number((err as { statusCode?: unknown }).statusCode) === 429;
  }
  // AI SDK RetryError after exhausted 429 retries
  if (err && typeof err === "object" && "errors" in err) {
    const errors = (err as { errors?: unknown[] }).errors;
    if (Array.isArray(errors)) {
      return errors.some((e) => isClaudeRateLimitError(e));
    }
  }
  return false;
}

function extractResponseHeaders(err: unknown): Record<string, string> | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur; depth++) {
    if (cur && typeof cur === "object" && "responseHeaders" in cur) {
      const h = (cur as { responseHeaders?: unknown }).responseHeaders;
      if (h && typeof h === "object" && !Array.isArray(h)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
          if (v != null) out[k.toLowerCase()] = String(v);
        }
        if (Object.keys(out).length > 0) return out;
      }
    }
    if (cur && typeof cur === "object" && "errors" in cur) {
      const errors = (cur as { errors?: unknown[] }).errors;
      if (Array.isArray(errors)) {
        for (const e of errors) {
          const nested = extractResponseHeaders(e);
          if (nested) return nested;
        }
      }
    }
    if (cur instanceof Error && "cause" in cur) {
      cur = (cur as Error & { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return null;
}

/**
 * Parse Anthropic-documented wait from a 429 error.
 * Prefers `retry-after` / `retry-after-ms`, then ratelimit reset headers.
 * Returns null when unknown (caller should use default cooldown).
 */
export function parseAnthropicRetryAfterMs(
  err: unknown,
  nowMs = Date.now()
): number | null {
  const headers = extractResponseHeaders(err);
  if (!headers) return null;

  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs) {
    const n = parseFloat(retryAfterMs);
    if (!Number.isNaN(n) && n >= 0) return Math.ceil(n);
  }

  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const sec = parseFloat(retryAfter);
    if (!Number.isNaN(sec) && sec >= 0) return Math.ceil(sec * 1000);
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
  }

  // Prefer the soonest reset among requests / tokens / input / output
  let soonest: number | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (!/anthropic-ratelimit-.*-reset$/i.test(key)) continue;
    const dateMs = Date.parse(value);
    if (Number.isNaN(dateMs)) continue;
    const wait = Math.max(0, dateMs - nowMs);
    soonest = soonest == null ? wait : Math.min(soonest, wait);
  }
  return soonest;
}

/** Apply cooldown from a 429 (or default 60s). Returns wait ms applied. */
export function applyClaudeRateLimitFromError(
  err: unknown,
  nowMs = Date.now()
): number {
  const parsed = parseAnthropicRetryAfterMs(err, nowMs);
  const waitMs = Math.max(
    1_000,
    parsed ?? CLAUDE_DEFAULT_RATE_LIMIT_COOLDOWN_MS
  );
  // Cap stored cooldown at 5 minutes so we re-probe eventually
  const capped = Math.min(waitMs, 5 * 60_000);
  setClaudeRateLimitCooldown(nowMs + capped);
  return capped;
}

export function getClaudeCodeLanguageModel(
  env: ClaudeCodeEnv
): LanguageModel | null {
  const resolved = resolveClaudeCodeSubscription(env);
  if (!resolved) return null;
  return createAnthropicFromClaudeCodeToken(resolved.token)(
    getClaudeCodeModelId(env)
  );
}

function isModelNotFoundError(err: unknown): boolean {
  const msg = errMsg(err);
  const status =
    err && typeof err === "object" && "statusCode" in err
      ? Number((err as { statusCode?: unknown }).statusCode)
      : NaN;
  if (status === 404) return true;
  // Anthropic body: not_found_error message "model: <id>"
  if (/not_found_error|model not found|does not exist/i.test(msg)) return true;
  if (/^model:\s*claude-/i.test(msg) || /\bmodel:\s*claude-/i.test(msg)) {
    return true;
  }
  return false;
}

function modelCandidates(env: ClaudeCodeEnv): string[] {
  const primary = getClaudeCodeModelId(env);
  const out: string[] = [primary];
  for (const id of CLAUDE_CODE_MODEL_FALLBACKS) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function enrichClaudeError(modelId: string, err: unknown): Error {
  const status =
    err && typeof err === "object" && "statusCode" in err
      ? String((err as { statusCode?: unknown }).statusCode)
      : "";
  const body =
    err && typeof err === "object" && "responseBody" in err
      ? String((err as { responseBody?: unknown }).responseBody).slice(0, 240)
      : "";
  const detail = [status && `status=${status}`, body && `body=${body}`]
    .filter(Boolean)
    .join(" ");
  return new Error(
    `Claude ${modelId} failed: ${errMsg(err)}${detail ? ` ${detail}` : ""}`,
    { cause: err }
  );
}

/**
 * Call Claude via Messages API using **Claude Code subscription OAuth**.
 *
 * Required for subscription tokens (not optional):
 * 1. Authorization: Bearer (access_token / setup-token)
 * 2. anthropic-beta: claude-code-20250219,oauth-2025-04-20
 * 3. system first block: "You are Claude Code, Anthropic's official CLI for Claude."
 *
 * Rate limits: honor retry-after / cooldown. No Console API key path here —
 * subscription OAuth only.
 */
export async function callClaudeCodeText(
  env: ClaudeCodeEnv,
  params: {
    messages?: Array<{
      role: "user" | "system" | "assistant";
      content: string;
    }>;
    prompt?: string;
    max_tokens?: number;
    /**
     * Per-call abort budget. Callers sizing a long job (the editorial
     * full-article rewrite asks for 180s) must be able to exceed the default,
     * and the retry paths depend on getting a *different* budget than the
     * attempt that just timed out. Clamped to CLAUDE_MAX_CALL_TIMEOUT_MS.
     */
    timeoutMs?: number;
  }
): Promise<string | null> {
  // An expired-but-refreshable access_token must be renewed *before* resolving,
  // otherwise `resolveClaudeCodeSubscription` reports "no active Claude token"
  // and the article fails even though we hold a valid refresh_token.
  if (shouldRefreshClaudeToken()) {
    try {
      await refreshClaudeCodeAccessToken();
    } catch {
      /* fall through — the call below surfaces the real auth error */
    }
  }

  let resolved = resolveClaudeCodeSubscription(env);
  if (!resolved) return null;

  const callTimeoutMs = resolveClaudeCallTimeoutMs(params.timeoutMs);

  const rawMessages =
    params.messages ??
    (params.prompt ? [{ role: "user" as const, content: params.prompt }] : []);
  if (rawMessages.length === 0) return null;

  // Claude Code subscription: identity system is mandatory
  const built = buildClaudeCodeSystemAndMessages(rawMessages);
  const systemBlocks = built.systemBlocks;
  const chatMessages =
    built.messages.length > 0
      ? built.messages
      : ([{ role: "user" as const, content: "Continue." }] as Array<{
          role: "user" | "assistant";
          content: string;
        }>);

  // Respect prior 429 cooldown (docs: earlier retries fail).
  const cooldownMs = getClaudeRateLimitCooldownRemainingMs();
  if (cooldownMs > 0) {
    const maxWait = 5 * 60_000;
    if (cooldownMs <= maxWait) {
      await sleep(cooldownMs);
    } else {
      throw new Error(
        `Claude subscription rate-limit cooldown ${Math.ceil(cooldownMs / 1000)}s remaining (Anthropic retry-after); wait and retry generate later`
      );
    }
  }

  const candidates = modelCandidates(env);
  let lastErr: unknown;

  // Credential order for subscription:
  // 1) OAuth access_token / setup-token as Bearer + identity system
  // 2) Minted subscription API key via create_api_key (org:create_api_key scope)
  type Cred = { token: string; label: string; useIdentitySystem: boolean };
  const creds: Cred[] = [
    {
      token: resolved.token,
      label: resolved.source,
      useIdentitySystem: !(
        isAnthropicApiKey(resolved.token) &&
        !isClaudeCodeOAuthToken(resolved.token)
      )
    }
  ];
  if (
    _mintedSubscriptionApiKey &&
    _mintedSubscriptionApiKey !== resolved.token
  ) {
    creds.push({
      token: _mintedSubscriptionApiKey,
      label: "oauth-minted-key",
      useIdentitySystem: false
    });
  }

  const runOnce = async (
    cred: Cred,
    modelId: string,
    maxRetries: number
  ): Promise<string | null> => {
    const provider = createAnthropicFromClaudeCodeToken(cred.token);
    // OAuth Bearer: identity system required, and it MUST be its own system
    // block — one `role: "system"` message per Anthropic system block.
    // Minted subscription keys are normal API credentials: no identity block.
    const blocks = cred.useIdentitySystem
      ? systemBlocks
      : systemBlocks.filter((b) => b !== CLAUDE_CODE_IDENTITY_SYSTEM);
    const { text } = await generateText({
      model: provider(modelId),
      messages: [
        ...blocks.map((content) => ({ role: "system" as const, content })),
        ...chatMessages
      ] as ModelMessage[],
      maxOutputTokens: params.max_tokens ?? 4096,
      maxRetries,
      abortSignal: AbortSignal.timeout(callTimeoutMs)
    });
    return text?.trim() ? text.trim() : null;
  };

  const tryCred = async (cred: Cred): Promise<string | null> => {
    for (const modelId of candidates) {
      try {
        const out = await runOnce(cred, modelId, CLAUDE_RATE_LIMIT_MAX_RETRIES);
        if (out) {
          clearClaudeRateLimitCooldown();
          lastClaudeSuccessMeta = {
            modelId,
            tokenSource: cred.label,
            chars: out.length
          };
          return out;
        }
        return null;
      } catch (err: unknown) {
        lastErr = err;
        if (isModelNotFoundError(err)) continue;
        if (isClaudeRateLimitError(err)) {
          const waitMs = applyClaudeRateLimitFromError(err);
          if (waitMs > 0 && waitMs <= CLAUDE_MAX_RETRY_AFTER_WAIT_MS) {
            await sleep(waitMs);
            try {
              const out = await runOnce(cred, modelId, 0);
              if (out) {
                clearClaudeRateLimitCooldown();
                lastClaudeSuccessMeta = {
                  modelId,
                  tokenSource: cred.label,
                  chars: out.length
                };
                return out;
              }
            } catch (retryErr: unknown) {
              lastErr = retryErr;
              if (isClaudeRateLimitError(retryErr)) {
                applyClaudeRateLimitFromError(retryErr);
              }
            }
          }
          // Rate limited this credential — try next credential if any
          break;
        }
        // Auth / other — try next credential
        break;
      }
    }
    return null;
  };

  // Pass 1: OAuth Bearer + Claude Code identity (subscription inference)
  let out = await tryCred(creds[0]!);
  if (out) return out;

  const firstErr = lastErr;

  // Pass 1b: auth failure with a refresh_token on file — the access_token has
  // almost certainly aged out (PKCE tokens last ~8h). Refresh and retry once
  // before falling back to minting, which is the rarer case.
  if (
    firstErr != null &&
    !isClaudeRateLimitError(firstErr) &&
    isClaudeAuthError(firstErr) &&
    _cached?.refreshToken
  ) {
    try {
      const refreshed = await refreshClaudeCodeAccessToken();
      if (refreshed && refreshed.token !== resolved.token) {
        resolved = {
          token: refreshed.token,
          expiresAtMs: refreshed.expiresAtMs,
          source: resolved.source
        };
        out = await tryCred({
          token: refreshed.token,
          label: "oauth-refreshed",
          useIdentitySystem: true
        });
        if (out) return out;
      }
    } catch (refreshErr: unknown) {
      lastErr = new Error(
        `${errMsg(firstErr)}; refresh_token exchange: ${errMsg(refreshErr)}`
      );
    }
  }

  // Pass 2: only on auth failure — mint via create_api_key (scope org:create_api_key).
  // Skip on pure rate_limit (same quota; mint often returns 403 without that scope).
  const tryMint =
    firstErr != null &&
    !isClaudeRateLimitError(firstErr) &&
    (isClaudeAuthError(firstErr) ||
      /authorized for use with Claude Code|invalid/i.test(errMsg(firstErr))) &&
    (!isAnthropicApiKey(resolved.token) ||
      isClaudeCodeOAuthToken(resolved.token));

  if (tryMint) {
    const mint = await mintClaudeCliApiKeyFromOAuthAccessToken(resolved.token);
    if ("rawKey" in mint) {
      _mintedSubscriptionApiKey = mint.rawKey;
      out = await tryCred({
        token: mint.rawKey,
        label: "oauth-create_api_key",
        useIdentitySystem: false
      });
      if (out) return out;
    } else if (mint.status !== 403) {
      // Keep first error primary; append mint detail only if unexpected
      lastErr = new Error(`${errMsg(firstErr)}; create_api_key: ${mint.error}`);
    }
  }

  if (firstErr) {
    throw enrichClaudeError(resolved.source, firstErr);
  }
  if (lastErr) {
    throw enrichClaudeError(resolved.source, lastErr);
  }
  return null;
}

/** Last successful Claude call metadata (for activity log). */
export let lastClaudeSuccessMeta: {
  modelId: string;
  tokenSource: string;
  chars: number;
} | null = null;

/** Walk `statusCode` across AI SDK wrappers (RetryError.errors, Error.cause). */
function findStatusCode(err: unknown, depth = 0): number | null {
  if (!err || typeof err !== "object" || depth > 6) return null;
  if ("statusCode" in err) {
    const n = Number((err as { statusCode?: unknown }).statusCode);
    if (Number.isFinite(n)) return n;
  }
  if ("errors" in err) {
    const errors = (err as { errors?: unknown[] }).errors;
    if (Array.isArray(errors)) {
      for (const e of errors) {
        const nested = findStatusCode(e, depth + 1);
        if (nested != null) return nested;
      }
    }
  }
  if ("cause" in err) {
    return findStatusCode((err as { cause?: unknown }).cause, depth + 1);
  }
  return null;
}

/**
 * Auth-class failure detection.
 *
 * Must inspect `statusCode`, not just the message: the AI SDK surfaces the
 * Anthropic body message verbatim ("invalid bearer", "This credential is only
 * authorized for use with Claude Code…"), none of which match a message-only
 * regex — so real 401s were being mis-classified as generic failures and never
 * triggered the refresh/mint recovery paths.
 */
export function isClaudeAuthError(err: unknown): boolean {
  const status = findStatusCode(err);
  if (status === 401 || status === 403) return true;
  const msg = errMsg(err);
  return /\b401\b|\b403\b|unauthorized|invalid[_\s-]?api[_\s-]?key|invalid[_\s-]?bearer|authentication|permission|credential|only authorized for use with claude code/i.test(
    msg
  );
}
