import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  generateTextMock,
  createAnthropicMock,
  anthropicDoGenerate,
  anthropicModelIds,
  refreshOAuthMock
} = vi.hoisted(() => {
  const anthropicDoGenerate = vi.fn();
  const anthropicModelIds: string[] = [];
  return {
    generateTextMock: vi.fn(),
    anthropicDoGenerate,
    anthropicModelIds,
    createAnthropicMock: vi.fn(() => (modelId: string) => {
      anthropicModelIds.push(modelId);
      return {
        specificationVersion: "v3" as const,
        provider: "anthropic",
        modelId,
        supportedUrls: {},
        doGenerate: anthropicDoGenerate,
        doStream: vi.fn()
      };
    }),
    refreshOAuthMock: vi.fn()
  };
});

vi.mock("ai", () => ({
  generateText: generateTextMock
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock
}));

vi.mock("../claude-oauth-flow", () => ({
  refreshClaudeOAuthToken: refreshOAuthMock
}));

import {
  clearClaudeCodeSubscriptionCache,
  clearClaudeRateLimitCooldown,
  configureClaudeCodeSubscription,
  defaultExpiresAtMs,
  setClaudeRateLimitCooldown
} from "../claude-code-subscription";
import {
  getKimiModel,
  getKimiProviderOptions,
  isDegenerateOutput,
  runKimiWithPoll,
  runScoutChat
} from "../kimi-model";
import {
  setClaudeChatFailureSink,
  type ClaudeChatFailureNotice
} from "../claude-chat-failure";

const EMPTY_CALL = { prompt: [] } as LanguageModelV3CallOptions;

function resetProviderMocks(): void {
  generateTextMock.mockReset();
  anthropicDoGenerate.mockReset();
  refreshOAuthMock.mockReset();
  anthropicModelIds.length = 0;
  createAnthropicMock.mockReset();
  createAnthropicMock.mockImplementation(() => (modelId: string) => {
    anthropicModelIds.push(modelId);
    return {
      specificationVersion: "v3" as const,
      provider: "anthropic",
      modelId,
      supportedUrls: {},
      doGenerate: anthropicDoGenerate,
      doStream: vi.fn()
    };
  });
}

async function generateWith(model: LanguageModel) {
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    throw new Error(
      `expected LanguageModelV3, got ${typeof model === "string" ? model : model.specificationVersion}`
    );
  }
  return model.doGenerate(EMPTY_CALL);
}

const CONTINUATION_PROMPT = "Continue from exactly where you left off.";

function useClaudeToken(): void {
  configureClaudeCodeSubscription(
    {
      token: "sk-ant-oat01-test-token",
      expiresAtMs: defaultExpiresAtMs(),
      savedAt: new Date().toISOString()
    },
    "dashboard"
  );
}

function testAgent(): {
  logs: Array<{ level: string; message: string; role: string }>;
  agent: {
    log: (level: string, message: string, role: string) => void;
  };
} {
  const logs: Array<{ level: string; message: string; role: string }> = [];
  return {
    logs,
    agent: {
      log: (level: string, message: string, role: string) => {
        logs.push({ level, message, role });
      }
    }
  };
}

describe("runKimiWithPoll", () => {
  beforeEach(() => {
    resetProviderMocks();
    clearClaudeCodeSubscriptionCache();
    clearClaudeRateLimitCooldown();
  });

  afterEach(() => {
    setClaudeChatFailureSink(null);
    clearClaudeCodeSubscriptionCache();
    clearClaudeRateLimitCooldown();
  });

  it("throws when Claude has no token and does not call the model", async () => {
    const { agent } = testAgent();
    const aiRun = vi.fn();

    await expect(
      runKimiWithPoll(
        { AI: { run: aiRun } } as unknown as Env,
        { messages: [{ role: "user", content: "Write an article." }] },
        {},
        agent as never
      )
    ).rejects.toThrow(/No other model was called/);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("throws when Claude fails and reports the red banner", async () => {
    useClaudeToken();
    generateTextMock.mockRejectedValueOnce(new Error("claude overloaded"));
    const notices: ClaudeChatFailureNotice[] = [];
    setClaudeChatFailureSink({
      report: (notice) => {
        notices.push(notice);
      },
      clear: () => undefined
    });
    const { agent } = testAgent();
    const aiRun = vi.fn();

    await expect(
      runKimiWithPoll(
        { AI: { run: aiRun } } as unknown as Env,
        { messages: [{ role: "user", content: "Write an article." }] },
        {},
        agent as never
      )
    ).rejects.toThrow(/No other model was called/);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(aiRun).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toMatch(/claude overloaded/);
    expect(notices[0]?.howToFix.length).toBeGreaterThan(20);
  });

  it("throws on an active Claude 429 cooldown without calling Claude", async () => {
    useClaudeToken();
    setClaudeRateLimitCooldown(Date.now() + 30_000);
    const { agent } = testAgent();

    await expect(
      runKimiWithPoll(
        {} as unknown as Env,
        { prompt: "Write an article." },
        {},
        agent as never
      )
    ).rejects.toThrow(/rate-limit cooldown/);

    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("returns Claude text", async () => {
    useClaudeToken();
    generateTextMock.mockResolvedValueOnce({
      text: "A finished article about cats.",
      finishReason: "stop"
    });
    const { agent } = testAgent();

    const text = await runKimiWithPoll(
      {} as unknown as Env,
      {
        messages: [{ role: "user", content: "Write an article." }],
        max_tokens: 4096
      },
      {},
      agent as never
    );

    expect(text).toBe("A finished article about cats.");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("continues Claude when finishReason is length and keeps the cut-point space", async () => {
    useClaudeToken();
    generateTextMock
      .mockResolvedValueOnce({
        text: "The quick brown ",
        finishReason: "length"
      })
      .mockResolvedValueOnce({
        text: "fox jumps over the lazy cat.",
        finishReason: "stop"
      });
    const { agent, logs } = testAgent();

    const text = await runKimiWithPoll(
      { AI: { run: vi.fn() } } as unknown as Env,
      {
        messages: [{ role: "user", content: "Write a long article." }],
        max_tokens: 4096
      },
      {},
      agent as never
    );

    expect(text).toBe("The quick brown fox jumps over the lazy cat.");
    expect(generateTextMock).toHaveBeenCalledTimes(2);

    const second = generateTextMock.mock.calls[1]?.[0] as {
      messages: Array<{ content: string }>;
      maxOutputTokens: number;
    };
    const contents = second.messages.map((m) => m.content);
    expect(contents).toContain("The quick brown ");
    expect(contents.some((c) => c.includes(CONTINUATION_PROMPT))).toBe(true);
    expect(second.maxOutputTokens).toBe(4096);
    expect(
      logs.some(
        (l) =>
          l.level === "info" &&
          l.message.includes("finishReason=length") &&
          l.message.includes("claude")
      )
    ).toBe(true);
  });

  it("stops Claude continuation after the round cap", async () => {
    useClaudeToken();
    generateTextMock
      .mockResolvedValueOnce({ text: "one ", finishReason: "length" })
      .mockResolvedValueOnce({ text: "two ", finishReason: "length" })
      .mockResolvedValueOnce({ text: "three ", finishReason: "length" });
    const { agent, logs } = testAgent();

    const text = await runKimiWithPoll(
      {} as unknown as Env,
      { prompt: "Write." },
      {},
      agent as never
    );

    expect(text).toBe("one two three ");
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(
      logs.some(
        (l) =>
          l.level === "warning" &&
          l.message.includes("still truncated after 2 continuations")
      )
    ).toBe(true);
  });

  it("keeps the Claude partial when a continuation round throws", async () => {
    useClaudeToken();
    generateTextMock
      .mockResolvedValueOnce({ text: "partial body ", finishReason: "length" })
      .mockRejectedValueOnce(new Error("continuation aborted"));
    const { agent } = testAgent();

    const text = await runKimiWithPoll(
      {} as unknown as Env,
      { prompt: "Write." },
      {},
      agent as never
    );

    expect(text).toBe("partial body ");
  });

  it("stops on degenerate Claude output and reports the banner", async () => {
    useClaudeToken();
    const degenerate =
      "Sam: 107000. 8.gs 165000 8. 2000... " +
      "100000450005581856567400000010158000009000145000000045002800060011800000500000664001680068000".repeat(
        3
      );
    generateTextMock.mockResolvedValueOnce({
      text: degenerate,
      finishReason: "stop"
    });
    const notices: ClaudeChatFailureNotice[] = [];
    setClaudeChatFailureSink({
      report: (notice) => {
        notices.push(notice);
      },
      clear: () => undefined
    });
    const { agent } = testAgent();

    await expect(
      runKimiWithPoll(
        {} as unknown as Env,
        { messages: [{ role: "user", content: "Write an article." }] },
        {},
        agent as never
      )
    ).rejects.toThrow(/degenerate output/);

    expect(notices[0]?.howToFix).toMatch(/re-authorize/i);
  });
});

describe("isDegenerateOutput", () => {
  it("flags pure digit/punctuation noise (the real 2026-07-10 incident shape)", () => {
    const degenerate =
      "Sam: 107000. 8.gs 165000 8. 2000... " +
      "100000450005581856567400000010158000009000145000000045002800060011800000500000664001680068000".repeat(
        3
      );
    expect(isDegenerateOutput(degenerate)).toBe(true);
  });

  it("does not flag normal article prose, even spec/price-heavy content", () => {
    const clean =
      "Choosing the right cat supplies can make a world of difference in your " +
      "feline's comfort and happiness. This automatic feeder holds up to 6 " +
      "cups of dry food, runs on 4 AA batteries, and costs around $45. Most " +
      "reviewers rate it 4.5 out of 5 stars for reliability over an 18-month " +
      "period, with a 2-year warranty included.".repeat(3);
    expect(isDegenerateOutput(clean)).toBe(false);
  });

  it("does not flag short responses regardless of content (other gates cover those)", () => {
    expect(isDegenerateOutput("100000 450005 581856")).toBe(false);
    expect(isDegenerateOutput("")).toBe(false);
  });

  it("is a boundary right around the 15% alpha-ratio threshold", () => {
    const justUnder = "1".repeat(300) + "a".repeat(30); // ~9% alpha
    const wellOver = "a".repeat(300); // 100% alpha
    expect(isDegenerateOutput(justUnder)).toBe(true);
    expect(isDegenerateOutput(wellOver)).toBe(false);
  });
});

describe("getKimiModel", () => {
  const env = { AI: { run: vi.fn() } } as unknown as Env;

  beforeEach(() => {
    resetProviderMocks();
    clearClaudeCodeSubscriptionCache();
    clearClaudeRateLimitCooldown();
  });

  afterEach(() => {
    setClaudeChatFailureSink(null);
    clearClaudeCodeSubscriptionCache();
    clearClaudeRateLimitCooldown();
  });

  it("returns a Claude model when the subscription path succeeds", async () => {
    useClaudeToken();
    anthropicDoGenerate.mockResolvedValue({
      finishReason: "stop",
      content: []
    });

    const model = getKimiModel(env);
    await generateWith(model);

    expect(anthropicDoGenerate).toHaveBeenCalledTimes(1);
    expect(getKimiProviderOptions(env)).toBeUndefined();
  });

  it("walks Claude model fallbacks on 404", async () => {
    useClaudeToken();
    const notFound = Object.assign(new Error("not_found_error"), {
      statusCode: 404
    });
    anthropicDoGenerate
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ finishReason: "stop", content: [] });

    await generateWith(getKimiModel(env));

    expect(anthropicModelIds.slice(0, 2)).toEqual([
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-20250929"
    ]);
  });

  it("throws on Claude failure and reports the red banner", async () => {
    useClaudeToken();
    anthropicDoGenerate.mockRejectedValue(new Error("overloaded"));
    const notices: ClaudeChatFailureNotice[] = [];
    setClaudeChatFailureSink({
      report: (notice) => {
        notices.push(notice);
      },
      clear: () => undefined
    });

    await expect(generateWith(getKimiModel(env))).rejects.toThrow(/overloaded/);

    expect(anthropicDoGenerate).toHaveBeenCalledTimes(1);
    expect(notices[0]?.message).toMatch(/overloaded/);
    expect(notices[0]?.howToFix).toMatch(/dashboard/i);
  });

  it("throws when no subscription token is configured", async () => {
    await expect(generateWith(getKimiModel(env))).rejects.toThrow(
      /No other model was called/
    );
    expect(createAnthropicMock).not.toHaveBeenCalled();
    expect(getKimiProviderOptions(env)).toBeUndefined();
  });

  it("refreshes an expiring access token before the Claude call", async () => {
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-oat01-old-token",
        refreshToken: "sk-ant-ort01-refresh",
        expiresAtMs: Date.now() - 5_000,
        savedAt: new Date().toISOString()
      },
      "dashboard"
    );
    refreshOAuthMock.mockResolvedValue({
      accessToken: "sk-ant-oat01-new-token",
      refreshToken: "sk-ant-ort01-refresh-2",
      expiresAtMs: Date.now() + 8 * 60 * 60 * 1000
    });
    anthropicDoGenerate.mockResolvedValue({
      finishReason: "stop",
      content: []
    });

    await generateWith(
      getKimiModel({ AI: { run: vi.fn() } } as unknown as Env)
    );

    expect(refreshOAuthMock).toHaveBeenCalledWith("sk-ant-ort01-refresh");
    expect(createAnthropicMock).toHaveBeenCalledWith(
      expect.objectContaining({ authToken: "sk-ant-oat01-new-token" })
    );
  });

  it("does not call Claude during a rate-limit cooldown", async () => {
    useClaudeToken();
    setClaudeRateLimitCooldown(Date.now() + 30_000);

    await expect(generateWith(getKimiModel(env))).rejects.toThrow(
      /rate-limit cooldown/
    );
    expect(anthropicDoGenerate).not.toHaveBeenCalled();
  });
});

describe("runScoutChat", () => {
  beforeEach(() => {
    resetProviderMocks();
    clearClaudeCodeSubscriptionCache();
    clearClaudeRateLimitCooldown();
  });

  afterEach(() => {
    setClaudeChatFailureSink(null);
    clearClaudeCodeSubscriptionCache();
    clearClaudeRateLimitCooldown();
  });

  it("uses the Claude helper", async () => {
    useClaudeToken();
    generateTextMock.mockResolvedValue({
      text: "senior cat ramps",
      finishReason: "stop"
    });

    const out = await runScoutChat({ AI: { run: vi.fn() } } as unknown as Env, {
      system: "Return JSON. /no_think",
      prompt: "Scout a niche",
      maxOutputTokens: 2000
    });

    expect(out.text).toBe("senior cat ramps");
    expect(out.modelId).toBe("claude-sonnet-4-5");
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("You are Claude Code")
          })
        ])
      })
    );
  });

  it("throws when Claude fails", async () => {
    useClaudeToken();
    generateTextMock.mockRejectedValue(new Error("claude down"));

    await expect(
      runScoutChat({ AI: { run: vi.fn() } } as unknown as Env, {
        system: "system",
        prompt: "prompt",
        maxOutputTokens: 200
      })
    ).rejects.toThrow(/claude down/);
  });

  it("throws when Claude is absent and does not call Workers AI", async () => {
    const aiRun = vi.fn();
    await expect(
      runScoutChat({ AI: { run: aiRun } } as unknown as Env, {
        system: "system",
        prompt: "prompt",
        maxOutputTokens: 200
      })
    ).rejects.toThrow(/No other model was called/);

    expect(aiRun).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
