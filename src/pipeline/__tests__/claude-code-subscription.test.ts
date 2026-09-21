import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAnthropicMock } = vi.hoisted(() => ({
  createAnthropicMock: vi.fn((opts: Record<string, string>) => opts)
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock
}));

import {
  claudeCodeExpiryBadgeLabel,
  claudeCodeRefreshButtonHint,
  claudeCodeRefreshButtonLabel,
  claudeCodeTimeRemainingLabel
} from "../claude-code-status-display";
import {
  applyClaudeRateLimitFromError,
  buildClaudeCodeSystemAndMessages,
  CLAUDE_CODE_DEFAULT_TTL_MS,
  CLAUDE_CODE_IDENTITY_SYSTEM,
  CLAUDE_DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  clearClaudeCodeSubscriptionCache,
  clearClaudeRateLimitCooldown,
  claudeCodeSubscriptionCacheIsEmpty,
  claudeCodeSubscriptionPublicLogLine,
  claudeCodeSubscriptionStatus,
  configureClaudeCodeSubscription,
  createAnthropicFromClaudeCodeToken,
  daysRemaining,
  defaultExpiresAtMs,
  getClaudeCodeCachedRecord,
  getClaudeRateLimitCooldownRemainingMs,
  hydrateClaudeCodeSubscriptionFromStoredJson,
  isAnthropicApiKey,
  isClaudeCodeOAuthToken,
  isClaudeCodeTokenActive,
  isClaudeRateLimitError,
  maskTokenLast4,
  parseAnthropicRetryAfterMs,
  parseClaudeCodeSubscriptionJson,
  resolveClaudeCodeSubscription,
  withPreservedRefreshToken
} from "../claude-code-subscription";

function expectNoRawSkAnt(value: unknown, rawToken: string): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain(rawToken);
  expect(json).not.toMatch(/sk-ant-/);
}

afterEach(() => {
  clearClaudeCodeSubscriptionCache();
  clearClaudeRateLimitCooldown();
});

beforeEach(() => {
  createAnthropicMock.mockClear();
});

describe("claude-code-subscription helpers", () => {
  it("defaults expiry to ~1 year", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(defaultExpiresAtMs(now) - now).toBe(CLAUDE_CODE_DEFAULT_TTL_MS);
  });

  it("masks token last4", () => {
    expect(maskTokenLast4("sk-ant-api03-abcdefghijklmnop")).toBe("mnop");
  });

  it("treats future expiry as active", () => {
    const now = 1_000_000;
    expect(isClaudeCodeTokenActive(now + 1000, now)).toBe(true);
    expect(isClaudeCodeTokenActive(now - 1, now)).toBe(false);
  });

  it("prefers dashboard cache over env when active", () => {
    const now = Date.now();
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-dashboard-token-xyz9",
        expiresAtMs: now + 86_400_000,
        savedAt: new Date(now).toISOString()
      },
      "dashboard"
    );
    const resolved = resolveClaudeCodeSubscription(
      {
        CLAUDE_CODE_SUBSCRIPTION_TOKEN: "sk-ant-env-token-aaaa",
        ANTHROPIC_API_KEY: "sk-ant-env-token-aaaa"
      },
      now
    );
    expect(resolved?.token).toBe("sk-ant-dashboard-token-xyz9");
    expect(resolved?.source).toBe("dashboard");
  });

  it("falls back to env when cache empty", () => {
    const now = Date.now();
    const resolved = resolveClaudeCodeSubscription(
      {
        CLAUDE_CODE_SUBSCRIPTION_TOKEN: "sk-ant-env-token-bbbb",
        CLAUDE_CODE_SUBSCRIPTION_EXPIRES_AT: new Date(
          now + 10_000
        ).toISOString()
      },
      now
    );
    expect(resolved?.token).toBe("sk-ant-env-token-bbbb");
    expect(resolved?.source).toBe("env");
  });

  it("ignores expired dashboard token and env without valid expiry window", () => {
    const now = Date.now();
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-old-token-zzzz",
        expiresAtMs: now - 1000,
        savedAt: new Date(now - 10_000).toISOString()
      },
      "dashboard"
    );
    // Expired cache is not used for resolve; env without expiry still gets 1y default
    const resolved = resolveClaudeCodeSubscription(
      { CLAUDE_CODE_SUBSCRIPTION_TOKEN: "sk-ant-env-fresh-cccc" },
      now
    );
    expect(resolved?.token).toBe("sk-ant-env-fresh-cccc");
  });

  it("status never includes raw token", () => {
    const now = Date.now();
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-secret-token-1234",
        expiresAtMs: now + CLAUDE_CODE_DEFAULT_TTL_MS,
        savedAt: new Date(now).toISOString()
      },
      "dashboard"
    );
    const status = claudeCodeSubscriptionStatus({}, now);
    expect(status.configured).toBe(true);
    expect(status.active).toBe(true);
    expect(status.tokenLast4).toBe("1234");
    expect(status.hasRefreshToken).toBe(false);
    expectNoRawSkAnt(status, "sk-ant-secret-token-1234");
    expect(daysRemaining(now + CLAUDE_CODE_DEFAULT_TTL_MS, now)).toBe(365);
    for (const kind of [
      "saved",
      "oauth-stored",
      "oauth-refreshed",
      "local-expiry-extended"
    ] as const) {
      const line = claudeCodeSubscriptionPublicLogLine(kind, status);
      expect(line).not.toMatch(/sk-ant-/);
      if (kind !== "local-expiry-extended") {
        expect(line).toContain("…1234");
      }
    }
  });

  it("loads a SQL JSON row as the resolved token ahead of ANTHROPIC_API_KEY", () => {
    const now = Date.UTC(2026, 8, 21, 12, 0, 0);
    const sqlToken = "sk-ant-oat01-from-sql-row-zzzz";
    const refresh = "sk-ant-ort01-from-sql-row";
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-api03-console-should-lose"
    };
    expect(claudeCodeSubscriptionCacheIsEmpty()).toBe(true);
    const before = claudeCodeSubscriptionStatus(env, now);
    expect(before.source).not.toBe("dashboard");
    expect(before.active).toBe(true);
    expect(before.hasRefreshToken).toBe(false);
    const loaded = hydrateClaudeCodeSubscriptionFromStoredJson(
      JSON.stringify({
        token: sqlToken,
        refreshToken: refresh,
        expiresAtMs: now + 8 * 60 * 60 * 1000,
        savedAt: "2026-09-21T12:00:00.000Z"
      })
    );
    expect(loaded?.token).toBe(sqlToken);
    expect(loaded?.refreshToken).toBe(refresh);
    const resolved = resolveClaudeCodeSubscription(env, now);
    expect(resolved?.token).toBe(sqlToken);
    expect(resolved?.source).toBe("dashboard");
    const status = claudeCodeSubscriptionStatus(env, now);
    expect(status.active).toBe(true);
    expect(status.source).toBe("dashboard");
    expect(status.hasRefreshToken).toBe(true);
    expect(status.hoursRemaining).toBe(8);
    expect(status.uiStatus).toBe("active");
    expectNoRawSkAnt(status, sqlToken);
    expectNoRawSkAnt(status, refresh);
    expect(status.maskedToken).toBe("…zzzz");
    expect(status.tokenLast4).toBe("zzzz");
  });

  it("does not resolve an expired SQL row as active", () => {
    const now = Date.UTC(2026, 8, 21, 12, 0, 0);
    const sqlToken = "sk-ant-oat01-expired-sql-row";
    hydrateClaudeCodeSubscriptionFromStoredJson(
      JSON.stringify({
        token: sqlToken,
        refreshToken: "sk-ant-ort01-expired-sql",
        expiresAtMs: now - 60_000,
        savedAt: "2026-09-20T12:00:00.000Z"
      })
    );
    expect(resolveClaudeCodeSubscription({}, now)).toBeNull();
    const env = { ANTHROPIC_API_KEY: "sk-ant-api03-env-fallback-key" };
    const resolved = resolveClaudeCodeSubscription(env, now);
    expect(resolved?.token).not.toBe(sqlToken);
    expect(resolved?.source).toBe("env");
    const status = claudeCodeSubscriptionStatus(env, now);
    expect(status.configured).toBe(true);
    expect(status.active).toBe(false);
    expect(status.source).toBe("dashboard");
    expect(status.uiStatus).toBe("expired");
    expect(status.hasRefreshToken).toBe(true);
    expectNoRawSkAnt(status, sqlToken);
    expectNoRawSkAnt(status, "sk-ant-api03-env-fallback-key");
    expectNoRawSkAnt(status, "sk-ant-ort01-expired-sql");
  });

  it("preserves refresh_token across same-token configure and save", () => {
    const now = Date.UTC(2026, 8, 21, 12, 0, 0);
    const token = "sk-ant-oat01-same-access-token";
    const refresh = "sk-ant-ort01-keep-across-save";
    configureClaudeCodeSubscription(
      {
        token,
        refreshToken: refresh,
        expiresAtMs: now + 60_000,
        savedAt: "2026-09-21T12:00:00.000Z"
      },
      "dashboard"
    );
    configureClaudeCodeSubscription(
      {
        token,
        expiresAtMs: now + CLAUDE_CODE_DEFAULT_TTL_MS,
        savedAt: "2026-09-21T13:00:00.000Z"
      },
      "dashboard"
    );
    expect(getClaudeCodeCachedRecord()?.refreshToken).toBe(refresh);

    const saved = withPreservedRefreshToken(getClaudeCodeCachedRecord(), {
      token,
      expiresAtMs: now + CLAUDE_CODE_DEFAULT_TTL_MS,
      savedAt: "2026-09-21T14:00:00.000Z"
    });
    expect(saved.refreshToken).toBe(refresh);
    expect(JSON.stringify(saved)).toContain(refresh);

    const replaced = withPreservedRefreshToken(saved, {
      token: "sk-ant-oat01-brand-new-setup",
      expiresAtMs: now + CLAUDE_CODE_DEFAULT_TTL_MS,
      savedAt: "2026-09-21T15:00:00.000Z"
    });
    expect(replaced.refreshToken).toBeUndefined();

    const rotated = withPreservedRefreshToken(
      saved,
      {
        token: "sk-ant-oat01-rotated-access",
        expiresAtMs: now + 8 * 60 * 60 * 1000,
        savedAt: "2026-09-21T16:00:00.000Z"
      },
      { keepWhenAccessTokenChanges: true }
    );
    expect(rotated.refreshToken).toBe(refresh);

    configureClaudeCodeSubscription(
      {
        token,
        refreshToken: refresh,
        expiresAtMs: now + 60_000,
        savedAt: "2026-09-21T12:00:00.000Z"
      },
      "dashboard"
    );
    hydrateClaudeCodeSubscriptionFromStoredJson(
      JSON.stringify({
        token,
        expiresAtMs: now + 60_000,
        savedAt: "2026-09-21T12:00:00.000Z"
      })
    );
    expect(getClaudeCodeCachedRecord()?.refreshToken).toBeUndefined();
  });

  it("shows hours for an ~8h access token instead of a multi-day expiry warning", () => {
    const now = Date.UTC(2026, 8, 21, 12, 0, 0);
    const token = "sk-ant-oat01-eight-hour-token";
    hydrateClaudeCodeSubscriptionFromStoredJson(
      JSON.stringify({
        token,
        refreshToken: "sk-ant-ort01-eight-hour",
        expiresAtMs: now + 8 * 60 * 60 * 1000,
        savedAt: "2026-09-21T12:00:00.000Z"
      })
    );
    const status = claudeCodeSubscriptionStatus({}, now);
    expect(status.daysRemaining).toBe(1);
    expect(status.hoursRemaining).toBe(8);
    expect(status.uiStatus).toBe("active");
    expect(status.hasRefreshToken).toBe(true);
    const badge = claudeCodeExpiryBadgeLabel(status);
    expect(badge).toBe("Active — access token · 8h left");
    expect(badge.toLowerCase()).not.toContain("expiring");
    expect(badge).not.toMatch(/day/);
    expect(claudeCodeTimeRemainingLabel(status)).toBe("8 hours left");
    expect(claudeCodeRefreshButtonLabel(true)).toBe("Refresh token");
    expect(claudeCodeRefreshButtonHint(true)).toBeNull();
    expectNoRawSkAnt(badge, token);

    clearClaudeCodeSubscriptionCache();
    hydrateClaudeCodeSubscriptionFromStoredJson(
      JSON.stringify({
        token,
        expiresAtMs: now + 8 * 60 * 60 * 1000,
        savedAt: "2026-09-21T12:00:00.000Z"
      })
    );
    const shortLived = claudeCodeSubscriptionStatus({}, now);
    expect(shortLived.hasRefreshToken).toBe(false);
    expect(shortLived.uiStatus).toBe("expiring_soon");
    expect(claudeCodeExpiryBadgeLabel(shortLived)).toBe(
      "Expiring soon — 8 hours left"
    );
    expect(claudeCodeExpiryBadgeLabel(shortLived)).not.toMatch(/1 day/);
    expect(claudeCodeRefreshButtonLabel(false)).toBe("Extend local expiry");
    const hint = claudeCodeRefreshButtonHint(false);
    expect(hint).toMatch(/no refresh_token/i);
    expect(hint).toMatch(/local expiry|saved expiry/i);
    expect(hint).not.toMatch(/sk-ant-/);
  });

  it("still warns in days when a setup-token is inside the 7-day window", () => {
    const now = Date.UTC(2026, 8, 21, 12, 0, 0);
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-oat01-five-day-setup",
        expiresAtMs: now + 5 * 24 * 60 * 60 * 1000,
        savedAt: "2026-09-21T12:00:00.000Z"
      },
      "dashboard"
    );
    const status = claudeCodeSubscriptionStatus({}, now);
    expect(status.hasRefreshToken).toBe(false);
    expect(status.uiStatus).toBe("expiring_soon");
    expect(claudeCodeExpiryBadgeLabel(status)).toBe(
      "Expiring soon — 5 days left"
    );
    expect(claudeCodeTimeRemainingLabel(status)).toBe("5 days left");
  });

  it("parses durable JSON records", () => {
    const rec = parseClaudeCodeSubscriptionJson(
      JSON.stringify({
        token: "sk-ant-from-sql-9999",
        expiresAtMs: 2_000_000_000_000,
        savedAt: "2026-01-01T00:00:00.000Z"
      })
    );
    expect(rec?.token).toBe("sk-ant-from-sql-9999");
    expect(parseClaudeCodeSubscriptionJson("not-json")).toBeNull();
  });

  it("detects setup-token OAuth vs Console API key", () => {
    expect(isClaudeCodeOAuthToken("sk-ant-oat01-abc")).toBe(true);
    expect(isAnthropicApiKey("sk-ant-api03-abc")).toBe(true);
    expect(isClaudeCodeOAuthToken("sk-ant-api03-abc")).toBe(false);
  });

  it("uses Bearer authToken + Claude Code identity headers for OAuth setup-token", () => {
    createAnthropicFromClaudeCodeToken("sk-ant-oat01-subscription-token");
    expect(createAnthropicMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authToken: "sk-ant-oat01-subscription-token",
        headers: {
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
          "user-agent": "claude-cli/1.0.0 (external, cli)",
          "x-app": "cli"
        }
      })
    );
    // OAuth path needs a fetch wrapper — provider headers alone cannot set the
    // user-agent (provider-utils overwrites it) or the identity system block.
    const opts = createAnthropicMock.mock.calls[0]![0] as {
      fetch?: unknown;
    };
    expect(typeof opts.fetch).toBe("function");
  });

  it("uses apiKey for Console API keys", () => {
    createAnthropicFromClaudeCodeToken("sk-ant-api03-console-key");
    expect(createAnthropicMock).toHaveBeenCalledWith({
      apiKey: "sk-ant-api03-console-key"
    });
  });

  it("prefers CLAUDE_CODE_OAUTH_TOKEN env name from official docs", () => {
    const now = Date.now();
    const resolved = resolveClaudeCodeSubscription(
      {
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-env",
        ANTHROPIC_API_KEY: "sk-ant-api03-should-lose"
      },
      now
    );
    expect(resolved?.token).toBe("sk-ant-oat01-from-env");
  });

  it("parses Anthropic retry-after seconds from 429 responseHeaders", () => {
    const err = {
      statusCode: 429,
      responseHeaders: { "retry-after": "12" },
      message: "rate_limit_error"
    };
    expect(isClaudeRateLimitError(err)).toBe(true);
    expect(parseAnthropicRetryAfterMs(err)).toBe(12_000);
  });

  it("parses anthropic-ratelimit-tokens-reset RFC3339", () => {
    const now = Date.UTC(2026, 5, 24, 18, 42, 0);
    const err = {
      statusCode: 429,
      responseHeaders: {
        "anthropic-ratelimit-tokens-reset": "2026-06-24T18:42:30Z"
      }
    };
    expect(parseAnthropicRetryAfterMs(err, now)).toBe(30_000);
  });

  it("applies default cooldown when 429 has no retry-after headers", () => {
    const now = Date.now();
    const wait = applyClaudeRateLimitFromError(
      { statusCode: 429, message: "rate_limit_error" },
      now
    );
    expect(wait).toBe(CLAUDE_DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    expect(getClaudeRateLimitCooldownRemainingMs(now)).toBeGreaterThan(0);
  });

  it("prepends Claude Code identity system (required for subscription OAuth)", () => {
    const built = buildClaudeCodeSystemAndMessages([
      { role: "system", content: "Write SEO articles." },
      { role: "user", content: "Hello" }
    ]);
    expect(built.system.startsWith(CLAUDE_CODE_IDENTITY_SYSTEM)).toBe(true);
    expect(built.system).toContain("Write SEO articles.");
    expect(built.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});
