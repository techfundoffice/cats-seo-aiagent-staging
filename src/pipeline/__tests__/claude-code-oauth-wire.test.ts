/**
 * Wire-level contract for Claude Code subscription OAuth calls.
 *
 * These assert the actual JSON that leaves the Worker, not just the provider
 * options, because the regression they cover was invisible at the options
 * layer: `createAnthropic({ headers })` looked correct while the AI SDK
 * collapsed the system prompt into one block and dropped our user-agent.
 *
 * Anthropic rejects a subscription credential unless the FIRST system block is
 * exactly `CLAUDE_CODE_IDENTITY_SYSTEM`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyClaudeCodeIdentityToBody,
  callClaudeCodeText,
  CLAUDE_CALL_TIMEOUT_MS,
  CLAUDE_CODE_IDENTITY_SYSTEM,
  CLAUDE_MAX_CALL_TIMEOUT_MS,
  clearClaudeCodeSubscriptionCache,
  clearClaudeRateLimitCooldown,
  configureClaudeCodeSubscription,
  defaultExpiresAtMs,
  refreshClaudeCodeAccessToken,
  resolveClaudeCallTimeoutMs,
  shouldRefreshClaudeToken
} from "../claude-code-subscription";

type Captured = {
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const realFetch = globalThis.fetch;

function stubAnthropic(): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (
    _url: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      headers,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    });
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "generated article body" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return { calls };
}

beforeEach(() => {
  clearClaudeCodeSubscriptionCache();
  clearClaudeRateLimitCooldown();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearClaudeCodeSubscriptionCache();
  clearClaudeRateLimitCooldown();
});

/**
 * A fetch that never answers in time and — like the real one — rejects as soon
 * as the caller's AbortSignal fires. Honoring the signal is the point: a stub
 * that ignores it can never show whether the budget was applied.
 */
function slowFetch(delayMs = 30_000): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(new Response("{}", { status: 200 })),
        delayMs
      );
      const signal = init?.signal;
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError"
          )
        );
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    })) as typeof fetch;
}

function useOAuthToken(token = "sk-ant-oat01-test-token"): void {
  configureClaudeCodeSubscription(
    {
      token,
      expiresAtMs: defaultExpiresAtMs(),
      savedAt: new Date().toISOString()
    },
    "dashboard"
  );
}

describe("applyClaudeCodeIdentityToBody", () => {
  const user = { messages: [{ role: "user", content: "hi" }] };

  it("adds the identity block when there is no system prompt", () => {
    const out = JSON.parse(
      applyClaudeCodeIdentityToBody(JSON.stringify({ ...user }))
    ) as { system: Array<{ type: string; text: string }> };
    expect(out.system).toEqual([
      { type: "text", text: CLAUDE_CODE_IDENTITY_SYSTEM }
    ]);
  });

  it("keeps a caller system prompt as its own second block", () => {
    const out = JSON.parse(
      applyClaudeCodeIdentityToBody(
        JSON.stringify({
          ...user,
          system: [{ type: "text", text: "You are an SEO writer." }]
        })
      )
    ) as { system: Array<{ type: string; text: string }> };
    expect(out.system).toHaveLength(2);
    expect(out.system[0]!.text).toBe(CLAUDE_CODE_IDENTITY_SYSTEM);
    expect(out.system[1]!.text).toBe("You are an SEO writer.");
  });

  it("splits the legacy identity+caller join back into two blocks", () => {
    const out = JSON.parse(
      applyClaudeCodeIdentityToBody(
        JSON.stringify({
          ...user,
          system: [
            {
              type: "text",
              text: `${CLAUDE_CODE_IDENTITY_SYSTEM}\n\nYou are an SEO writer.`
            }
          ]
        })
      )
    ) as { system: Array<{ type: string; text: string }> };
    expect(out.system).toHaveLength(2);
    expect(out.system[0]!.text).toBe(CLAUDE_CODE_IDENTITY_SYSTEM);
    expect(out.system[1]!.text).toBe("You are an SEO writer.");
  });

  it("is idempotent when identity is already the first block", () => {
    const body = JSON.stringify({
      ...user,
      system: [
        { type: "text", text: CLAUDE_CODE_IDENTITY_SYSTEM },
        { type: "text", text: "You are an SEO writer." }
      ]
    });
    expect(
      applyClaudeCodeIdentityToBody(applyClaudeCodeIdentityToBody(body))
    ).toBe(applyClaudeCodeIdentityToBody(body));
    const out = JSON.parse(applyClaudeCodeIdentityToBody(body)) as {
      system: unknown[];
    };
    expect(out.system).toHaveLength(2);
  });

  it("leaves non-Messages bodies untouched", () => {
    expect(applyClaudeCodeIdentityToBody("not json")).toBe("not json");
    expect(applyClaudeCodeIdentityToBody("{}")).toBe("{}");
  });
});

describe("callClaudeCodeText wire shape", () => {
  it("sends the identity as its own first system block", async () => {
    const { calls } = stubAnthropic();
    useOAuthToken();

    const out = await callClaudeCodeText(
      {},
      {
        messages: [
          { role: "system", content: "You are an SEO writer." },
          { role: "user", content: "Write about cat litter boxes." }
        ]
      }
    );

    expect(out).toBe("generated article body");
    expect(calls).toHaveLength(1);
    const system = calls[0]!.body.system as Array<{
      type: string;
      text: string;
    }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0]).toEqual({
      type: "text",
      text: CLAUDE_CODE_IDENTITY_SYSTEM
    });
    expect(system[1]!.text).toBe("You are an SEO writer.");
  });

  it("authenticates with Bearer and never sends x-api-key", async () => {
    const { calls } = stubAnthropic();
    useOAuthToken("sk-ant-oat01-bearer-me");

    await callClaudeCodeText({}, { prompt: "Write about cats." });

    const headers = calls[0]!.headers;
    expect(headers.authorization).toBe("Bearer sk-ant-oat01-bearer-me");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("sends both Claude Code beta flags and the claude-cli user-agent", async () => {
    const { calls } = stubAnthropic();
    useOAuthToken();

    await callClaudeCodeText({}, { prompt: "Write about cats." });

    const headers = calls[0]!.headers;
    expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    // Regression: provider-utils overwrites provider-level user-agent, so this
    // only holds because the OAuth fetch wrapper re-sets it.
    expect(headers["user-agent"]).toContain("claude-cli");
    expect(headers["x-app"]).toBe("cli");
  });

  it("omits the identity block for Console API keys", async () => {
    const { calls } = stubAnthropic();
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-api03-console-key",
        expiresAtMs: defaultExpiresAtMs(),
        savedAt: new Date().toISOString()
      },
      "dashboard"
    );

    await callClaudeCodeText(
      {},
      {
        messages: [
          { role: "system", content: "You are an SEO writer." },
          { role: "user", content: "Write about cats." }
        ]
      }
    );

    const body = calls[0]!.body as {
      system?: Array<{ text: string }>;
    };
    const texts = (body.system ?? []).map((b) => b.text);
    expect(texts).not.toContain(CLAUDE_CODE_IDENTITY_SYSTEM);
    expect(texts).toContain("You are an SEO writer.");
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-ant-api03-console-key");
  });
});

describe("direct AI SDK call sites (getClaudeModel path)", () => {
  it("gets the identity block injected without passing system messages", async () => {
    const { calls } = stubAnthropic();
    const { generateText } = await import("ai");
    const { createAnthropicFromClaudeCodeToken } =
      await import("../claude-code-subscription");

    // Mirrors qc-agent / polish-agent: plain `system:` string, no identity.
    await generateText({
      model: createAnthropicFromClaudeCodeToken("sk-ant-oat01-test-token")(
        "claude-sonnet-4-5"
      ),
      system: "Return JSON only.",
      prompt: "Score this article.",
      maxOutputTokens: 100,
      maxRetries: 0
    });

    const system = calls[0]!.body.system as Array<{ text: string }>;
    expect(system[0]!.text).toBe(CLAUDE_CODE_IDENTITY_SYSTEM);
    expect(system[1]!.text).toBe("Return JSON only.");
  });
});

describe("OAuth access_token auto-refresh", () => {
  it("refreshes on 401 and retries the call", async () => {
    const refreshed = "sk-ant-oat01-refreshed";
    let messagesCalls = 0;
    let refreshCalls = 0;

    globalThis.fetch = (async (
      url: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const href = String(url);
      if (href.includes("/oauth/token")) {
        refreshCalls++;
        return new Response(
          JSON.stringify({
            access_token: refreshed,
            refresh_token: "sk-ant-ort01-next",
            expires_in: 28800
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      messagesCalls++;
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Bearer ${refreshed}`) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid bearer" }
          }),
          { status: 401, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          id: "msg_ok",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "article after refresh" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    configureClaudeCodeSubscription(
      {
        token: "sk-ant-oat01-expired",
        refreshToken: "sk-ant-ort01-stored",
        expiresAtMs: defaultExpiresAtMs(),
        savedAt: new Date().toISOString()
      },
      "dashboard"
    );

    const out = await callClaudeCodeText({}, { prompt: "Write about cats." });

    expect(refreshCalls).toBeGreaterThan(0);
    expect(messagesCalls).toBeGreaterThan(1);
    expect(out).toBe("article after refresh");
  });

  it("keeps the refresh_token in the module cache", async () => {
    const { getClaudeCodeCachedRecord } =
      await import("../claude-code-subscription");
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-oat01-abc",
        refreshToken: "sk-ant-ort01-keep-me",
        expiresAtMs: defaultExpiresAtMs(),
        savedAt: new Date().toISOString()
      },
      "dashboard"
    );
    // Regression: this used to be dropped, which silently disabled every
    // refresh path (dashboard button and auto-refresh alike).
    expect(getClaudeCodeCachedRecord()?.refreshToken).toBe(
      "sk-ant-ort01-keep-me"
    );
  });
});

describe("per-call abort budget", () => {
  it("defaults, clamps, and rejects nonsense budgets", () => {
    expect(resolveClaudeCallTimeoutMs(undefined)).toBe(CLAUDE_CALL_TIMEOUT_MS);
    expect(resolveClaudeCallTimeoutMs(0)).toBe(CLAUDE_CALL_TIMEOUT_MS);
    expect(resolveClaudeCallTimeoutMs(-5)).toBe(CLAUDE_CALL_TIMEOUT_MS);
    expect(resolveClaudeCallTimeoutMs(Number.NaN)).toBe(CLAUDE_CALL_TIMEOUT_MS);
    expect(resolveClaudeCallTimeoutMs(Number.POSITIVE_INFINITY)).toBe(
      CLAUDE_CALL_TIMEOUT_MS
    );
    // The editorial rewrite's 180s and its 150s retry must survive verbatim —
    // both were previously collapsed to the 120s default.
    expect(resolveClaudeCallTimeoutMs(180_000)).toBe(180_000);
    expect(resolveClaudeCallTimeoutMs(150_000)).toBe(150_000);
    // ...but a runaway budget cannot pin the pipeline on one article.
    expect(resolveClaudeCallTimeoutMs(60 * 60_000)).toBe(
      CLAUDE_MAX_CALL_TIMEOUT_MS
    );
  });

  it("aborts the Anthropic call at the caller's budget", async () => {
    globalThis.fetch = slowFetch();
    useOAuthToken();

    const started = Date.now();
    await expect(
      callClaudeCodeText({}, { prompt: "Write.", timeoutMs: 250 })
    ).rejects.toThrow();
    // Aborted at the caller's 250ms budget, not the 120s default.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("runKimiWithPoll forwards syncTimeoutMs instead of swallowing it", async () => {
    globalThis.fetch = slowFetch();
    useOAuthToken();

    // Staging's equivalent of prod's dedicated `runClaudeWithPoll` is
    // `runKimiWithPoll` in `kimi-model.ts` — Claude-first with a fallback to
    // Kimi (OpenRouter/Workers AI) so staging never goes dark on a Claude
    // failure. That means a Claude-leg timeout is caught internally rather
    // than propagating as-is; what must survive is the *budget itself*, on
    // both legs it touches.
    const { runKimiWithPoll } = await import("../kimi-model");
    const logged: string[] = [];
    const agent = {
      log: (_lvl: string, msg: string) => {
        logged.push(msg);
      }
    };

    const started = Date.now();
    await expect(
      runKimiWithPoll(
        {} as unknown as Env,
        { prompt: "Rewrite this article." },
        { syncTimeoutMs: 250 },
        agent as never
      )
    ).rejects.toThrow();
    // Aborted at the caller's 250ms budget on the Claude leg, not the 120s
    // default — and the Kimi fallback (which also has no working binding in
    // this test env) fails fast too, instead of hanging on its own timeout.
    expect(Date.now() - started).toBeLessThan(2000);

    // The Claude leg must actually have been aborted by the 250ms budget
    // (not have silently waited out the 120s default) before falling back.
    expect(
      logged.some((m) => m.includes("[claude-code]") && /abort/i.test(m))
    ).toBe(true);
    // The 250ms budget must also reach the Kimi/Workers-AI fallback leg
    // (`ai-poll`'s syncTimeoutMs) rather than being swallowed and replaced
    // with that leg's own default.
    expect(logged.some((m) => m.includes("syncTimeoutMs=250"))).toBe(true);
  });
});

describe("shouldRefreshClaudeToken", () => {
  it("fires for a token already past expiry, not just one nearing it", () => {
    const now = Date.now();
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-oat01-expired",
        refreshToken: "sk-ant-ort01-live",
        expiresAtMs: now - 60_000,
        savedAt: new Date().toISOString()
      },
      "dashboard"
    );
    // An already-expired access_token is the COMMON case (PKCE tokens last
    // ~8h, so any overnight gap expires them) and is exactly what used to
    // stall the pipeline. Narrowing this window would reintroduce that.
    expect(shouldRefreshClaudeToken(now)).toBe(true);
  });

  it("stays quiet when the token is comfortably valid or unrefreshable", () => {
    const now = Date.now();
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-oat01-fresh",
        refreshToken: "sk-ant-ort01-live",
        expiresAtMs: now + 60 * 60_000,
        savedAt: new Date().toISOString()
      },
      "dashboard"
    );
    expect(shouldRefreshClaudeToken(now)).toBe(false);

    configureClaudeCodeSubscription(
      {
        token: "sk-ant-oat01-no-refresh",
        expiresAtMs: now - 60_000,
        savedAt: new Date().toISOString()
      },
      "dashboard"
    );
    expect(shouldRefreshClaudeToken(now)).toBe(false);
  });

  it("backs off after a failed refresh instead of retrying every call", async () => {
    let refreshAttempts = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes("/oauth/token")) {
        refreshAttempts++;
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("{}", { status: 500 });
    }) as typeof fetch;

    const now = Date.now();
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-oat01-expired",
        refreshToken: "sk-ant-ort01-dead",
        expiresAtMs: now - 60_000,
        savedAt: new Date().toISOString()
      },
      "dashboard"
    );

    await expect(refreshClaudeCodeAccessToken()).rejects.toThrow();
    expect(refreshAttempts).toBe(1);

    // A dead refresh_token must not add a failed round-trip to every call.
    expect(shouldRefreshClaudeToken()).toBe(false);
    expect(await refreshClaudeCodeAccessToken()).toBeNull();
    expect(refreshAttempts).toBe(1);
  });
});
