import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  generateTextMock,
  aiGenerateWithPollMock,
  createOpenRouterMock,
  createWorkersAIMock,
  createAnthropicMock,
  anthropicDoGenerate,
  anthropicModelIds,
  refreshOAuthMock
} = vi.hoisted(() => {
  const anthropicDoGenerate = vi.fn();
  const anthropicModelIds: string[] = [];
  return {
    generateTextMock: vi.fn(),
    aiGenerateWithPollMock: vi.fn(),
    createOpenRouterMock: vi.fn(
      (): ((...args: unknown[]) => unknown) => () => "openrouter-model"
    ),
    createWorkersAIMock: vi.fn(
      (): ((...args: unknown[]) => unknown) => () => "workers-model"
    ),
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

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: createOpenRouterMock
}));

vi.mock("workers-ai-provider", () => ({
  createWorkersAI: createWorkersAIMock
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock
}));

vi.mock("../claude-oauth-flow", () => ({
  refreshClaudeOAuthToken: refreshOAuthMock
}));

vi.mock("../ai-poll", () => ({
  aiGenerateWithPoll: aiGenerateWithPollMock
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
  aiGenerateWithPollMock.mockReset();
  anthropicDoGenerate.mockReset();
  refreshOAuthMock.mockReset();
  anthropicModelIds.length = 0;
  createOpenRouterMock.mockReset();
  createOpenRouterMock.mockImplementation(() => () => "openrouter-model");
  createWorkersAIMock.mockReset();
  createWorkersAIMock.mockImplementation(() => () => "workers-model");
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
  rotate: ReturnType<typeof vi.fn>;
  agent: {
    log: (level: string, message: string, role: string) => void;
    rotateOpenRouterKeyFromDoppler: ReturnType<typeof vi.fn>;
  };
} {
  const logs: Array<{ level: string; message: string; role: string }> = [];
  const rotate = vi.fn().mockResolvedValue(null);
  return {
    logs,
    rotate,
    agent: {
      log: (level: string, message: string, role: string) => {
        logs.push({ level, message, role });
      },
      rotateOpenRouterKeyFromDoppler: rotate
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

  it("throws without calling OpenRouter or Workers AI when Claude has no token", async () => {
    const { agent, rotate } = testAgent();
    const env = {
      OPENROUTER_API_KEY: "test-openrouter-key",
      AI: { run: vi.fn() }
    } as unknown as Env;

    await expect(
      runKimiWithPoll(
        env,
        { messages: [{ role: "user", content: "Write an article." }] },
        {},
        agent as never
      )
    ).rejects.toThrow(/No other model was called/);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("throws when Claude fails and does not rotate or fall back", async () => {
    useClaudeToken();
    generateTextMock.mockRejectedValueOnce(new Error("claude overloaded"));
    const { agent, rotate } = testAgent();
    const env = {
      OPENROUTER_API_KEY: "test-openrouter-key",
      AI: { run: vi.fn() }
    } as unknown as Env;

    await expect(
      runKimiWithPoll(
        env,
        { messages: [{ role: "user", content: "Write an article." }] },
        {},
        agent as never
      )
    ).rejects.toThrow(/No other model was called/);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("throws on an active Claude 429 cooldown without calling any provider", async () => {
    useClaudeToken();
    setClaudeRateLimitCooldown(Date.now() + 30_000);
    const { agent, rotate } = testAgent();
    const env = {
      OPENROUTER_API_KEY: "test-openrouter-key",
      AI: { run: vi.fn() }
    } as unknown as Env;

    await expect(
      runKimiWithPoll(env, { prompt: "Write an article." }, {}, agent as never)
    ).rejects.toThrow(/rate-limit cooldown/);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("returns Claude text and ignores an OpenRouter key", async () => {
    useClaudeToken();
    generateTextMock.mockResolvedValueOnce({
      text: "A finished article about cats.",
      finishReason: "stop"
    });
    const { agent } = testAgent();
    const env = {
      OPENROUTER_API_KEY: "test-openrouter-key",
      AI: { run: vi.fn() }
    } as unknown as Env;

    const text = await runKimiWithPoll(
      env,
      {
        messages: [{ role: "user", content: "Write an article." }],
        max_tokens: 4096
      },
      {},
      agent as never
    );

    expect(text).toBe("A finished article about cats.");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
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
    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();

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
    const { agent, rotate } = testAgent();

    const text = await runKimiWithPoll(
      { OPENROUTER_API_KEY: "test-openrouter-key" } as unknown as Env,
      { prompt: "Write." },
      {},
      agent as never
    );

    expect(text).toBe("partial body ");
    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("does not call OpenRouter or Workers AI when Claude fails, even if AI_CHAT_FALLBACK=kimi", async () => {
    useClaudeToken();
    generateTextMock.mockRejectedValueOnce(new Error("claude down"));
    const notices: ClaudeChatFailureNotice[] = [];
    setClaudeChatFailureSink({
      report: (notice) => {
        notices.push(notice);
      },
      clear: () => undefined
    });
    const { agent, rotate } = testAgent();
    const aiRun = vi.fn();

    await expect(
      runKimiWithPoll(
        {
          AI_CHAT_FALLBACK: "kimi",
          OPENROUTER_API_KEY: "test-openrouter-key",
          AI: { run: aiRun }
        } as unknown as Env,
        { messages: [{ role: "user", content: "Write an article." }] },
        {},
        agent as never
      )
    ).rejects.toThrow(/No other model was called/);

    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(createWorkersAIMock).not.toHaveBeenCalled();
    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toMatch(/claude down/);
    expect(notices[0]?.howToFix.length).toBeGreaterThan(20);
  });

  it("stops on degenerate Claude output without calling Workers AI", async () => {
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
        {
          AI_CHAT_FALLBACK: "Kimi",
          OPENROUTER_API_KEY: "test-openrouter-key",
          AI: { run: vi.fn() }
        } as unknown as Env,
        { messages: [{ role: "user", content: "Write an article." }] },
        {},
        agent as never
      )
    ).rejects.toThrow(/degenerate output/);

    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(notices[0]?.howToFix).toMatch(/re-authorize/i);
  });

  it("does not treat other AI_CHAT_FALLBACK values as the Kimi hatch", async () => {
    const { agent } = testAgent();
    await expect(
      runKimiWithPoll(
        {
          AI_CHAT_FALLBACK: "true",
          OPENROUTER_API_KEY: "test-openrouter-key"
        } as unknown as Env,
        { prompt: "Write." },
        {},
        agent as never
      )
    ).rejects.toThrow(/No other model was called/);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
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
  const envWithKey = {
    OPENROUTER_API_KEY: "test-openrouter-key",
    AI: { run: vi.fn() }
  } as unknown as Env;

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

  it("does not hand OpenRouter when the subscription path succeeds", async () => {
    useClaudeToken();
    anthropicDoGenerate.mockResolvedValue({
      finishReason: "stop",
      content: []
    });

    const model = getKimiModel(envWithKey);
    await generateWith(model);

    expect(anthropicDoGenerate).toHaveBeenCalledTimes(1);
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(createWorkersAIMock).not.toHaveBeenCalled();
    expect(getKimiProviderOptions(envWithKey)).toBeUndefined();
  });

  it("walks Claude model fallbacks on 404 and still skips OpenRouter", async () => {
    useClaudeToken();
    const notFound = Object.assign(new Error("not_found_error"), {
      statusCode: 404
    });
    anthropicDoGenerate
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ finishReason: "stop", content: [] });

    await generateWith(getKimiModel(envWithKey));

    expect(anthropicModelIds.slice(0, 2)).toEqual([
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-20250929"
    ]);
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(createWorkersAIMock).not.toHaveBeenCalled();
  });

  it("throws on Claude failure without calling OpenRouter or Workers AI", async () => {
    useClaudeToken();
    anthropicDoGenerate.mockRejectedValue(new Error("overloaded"));

    await expect(generateWith(getKimiModel(envWithKey))).rejects.toThrow(
      /overloaded/
    );

    expect(anthropicDoGenerate).toHaveBeenCalledTimes(1);
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(createWorkersAIMock).not.toHaveBeenCalled();
  });

  it("throws when no subscription token is configured", async () => {
    await expect(generateWith(getKimiModel(envWithKey))).rejects.toThrow(
      /No other model was called/
    );
    expect(createAnthropicMock).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(getKimiProviderOptions(envWithKey)).toBeUndefined();
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
    expect(createOpenRouterMock).not.toHaveBeenCalled();
  });

  it("does not call Claude during a rate-limit cooldown", async () => {
    useClaudeToken();
    setClaudeRateLimitCooldown(Date.now() + 30_000);

    await expect(generateWith(getKimiModel(envWithKey))).rejects.toThrow(
      /rate-limit cooldown/
    );
    expect(anthropicDoGenerate).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();
  });

  it("ignores AI_CHAT_FALLBACK and still throws without OpenRouter or Workers AI", async () => {
    useClaudeToken();
    anthropicDoGenerate.mockRejectedValue(new Error("overloaded"));
    const notices: ClaudeChatFailureNotice[] = [];
    setClaudeChatFailureSink({
      report: (notice) => {
        notices.push(notice);
      },
      clear: () => undefined
    });

    await expect(
      generateWith(
        getKimiModel({
          AI_CHAT_FALLBACK: "kimi",
          OPENROUTER_API_KEY: "test-openrouter-key",
          AI: { run: vi.fn() }
        } as unknown as Env)
      )
    ).rejects.toThrow(/overloaded/);

    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(createWorkersAIMock).not.toHaveBeenCalled();
    expect(getKimiProviderOptions(envWithKey)).toBeUndefined();
    expect(notices[0]?.message).toMatch(/overloaded/);
    expect(notices[0]?.howToFix).toMatch(/dashboard/i);
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

  it("uses the Claude helper and does not call Workers AI Qwen", async () => {
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
    expect(createWorkersAIMock).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();
  });

  it("throws when Claude fails and does not call Qwen", async () => {
    useClaudeToken();
    generateTextMock.mockRejectedValue(new Error("claude down"));

    await expect(
      runScoutChat({ AI: { run: vi.fn() } } as unknown as Env, {
        system: "system",
        prompt: "prompt",
        maxOutputTokens: 200
      })
    ).rejects.toThrow(/claude down/);

    expect(createWorkersAIMock).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();
  });

  it("does not call Qwen when AI_CHAT_FALLBACK=kimi and Claude is absent", async () => {
    const aiRun = vi.fn();
    await expect(
      runScoutChat(
        {
          AI_CHAT_FALLBACK: "kimi",
          AI: { run: aiRun }
        } as unknown as Env,
        { system: "system", prompt: "prompt", maxOutputTokens: 200 }
      )
    ).rejects.toThrow(/No other model was called/);

    expect(createWorkersAIMock).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
  });
});
