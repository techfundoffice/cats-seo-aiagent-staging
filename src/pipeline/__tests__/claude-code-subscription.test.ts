import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAnthropicMock } = vi.hoisted(() => ({
  createAnthropicMock: vi.fn((opts: Record<string, string>) => opts)
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock
}));

import {
  applyClaudeRateLimitFromError,
  buildClaudeCodeSystemAndMessages,
  CLAUDE_CODE_DEFAULT_TTL_MS,
  CLAUDE_CODE_IDENTITY_SYSTEM,
  CLAUDE_DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  clearClaudeCodeSubscriptionCache,
  clearClaudeRateLimitCooldown,
  claudeCodeSubscriptionStatus,
  configureClaudeCodeSubscription,
  createAnthropicFromClaudeCodeToken,
  daysRemaining,
  defaultExpiresAtMs,
  getClaudeRateLimitCooldownRemainingMs,
  isAnthropicApiKey,
  isClaudeCodeOAuthToken,
  isClaudeCodeTokenActive,
  isClaudeRateLimitError,
  maskTokenLast4,
  parseAnthropicRetryAfterMs,
  parseClaudeCodeSubscriptionJson,
  resolveClaudeCodeSubscription
} from "../claude-code-subscription";

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
    expect(JSON.stringify(status)).not.toContain("sk-ant-secret");
    expect(daysRemaining(now + CLAUDE_CODE_DEFAULT_TTL_MS, now)).toBe(365);
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
