import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  generateTextMock,
  aiGenerateWithPollMock,
  createOpenRouterMock,
  createWorkersAIMock
} = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  aiGenerateWithPollMock: vi.fn(),
  createOpenRouterMock: vi.fn(() => vi.fn(() => "openrouter-model")),
  createWorkersAIMock: vi.fn(() => vi.fn(() => "workers-model"))
}));

vi.mock("ai", () => ({
  generateText: generateTextMock
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: createOpenRouterMock
}));

vi.mock("workers-ai-provider", () => ({
  createWorkersAI: createWorkersAIMock
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
  isDegenerateOutput,
  runKimiWithPoll,
  setRotatedOpenRouterKey
} from "../kimi-model";

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
    generateTextMock.mockReset();
    aiGenerateWithPollMock.mockReset();
    createOpenRouterMock.mockClear();
    createWorkersAIMock.mockClear();
    setRotatedOpenRouterKey(null);
    clearClaudeCodeSubscriptionCache();
    clearClaudeRateLimitCooldown();
  });

  afterEach(() => {
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
    ).rejects.toThrow(/OpenRouter and Workers AI were not called/);

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
    ).rejects.toThrow(/OpenRouter and Workers AI were not called/);

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

  it("falls back to Workers AI when OpenRouter returns a non-JSON response", async () => {
    generateTextMock.mockRejectedValueOnce(
      new Error("Invalid JSON response — cause: JSON parsing failed: Text:")
    );
    aiGenerateWithPollMock.mockResolvedValueOnce("<article>fallback</article>");

    const logs: Array<{ level: string; message: string; role: string }> = [];
    const agent = {
      log: (level: string, message: string, role: string) => {
        logs.push({ level, message, role });
      },
      rotateOpenRouterKeyFromDoppler: vi.fn().mockResolvedValue(null)
    } as const;

    const env = {
      AI_CHAT_FALLBACK: "kimi",
      OPENROUTER_API_KEY: "test-openrouter-key",
      AI: { run: vi.fn() }
    } as unknown as Env;

    const text = await runKimiWithPoll(
      env,
      {
        messages: [{ role: "user", content: "Rewrite this article as HTML." }],
        max_tokens: 2048
      },
      { syncTimeoutMs: 90_000 },
      agent as never
    );

    expect(text).toBe("<article>fallback</article>");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openrouter-model",
        maxOutputTokens: 2048,
        messages: [{ role: "user", content: "Rewrite this article as HTML." }],
        providerOptions: { openrouter: { reasoning: { enabled: false } } }
      })
    );
    expect(aiGenerateWithPollMock).toHaveBeenCalledWith(
      env.AI,
      "@cf/qwen/qwen3-30b-a3b-fp8",
      {
        messages: [{ role: "user", content: "Rewrite this article as HTML." }],
        max_tokens: 2048
      },
      expect.objectContaining({
        syncTimeoutMs: 90_000,
        onWarn: expect.any(Function)
      })
    );
    expect(logs).toContainEqual({
      level: "warning",
      message:
        "[kimi-model] OpenRouter call failed (Invalid JSON response — cause: JSON parsing failed: Text:); falling back to Workers AI",
      role: "contentCreator"
    });
  });

  it("falls back to Workers AI when OpenRouter returns degenerate (token-repetition-collapse) output", async () => {
    // Abbreviated form of the real 2026-07-10 incident output — pure
    // digit/punctuation noise from the first character, long enough to
    // clear the empty-response check but not real prose.
    const degenerate =
      "Sam: 107000. 8.gs 165000 8. 2000... " +
      "100000450005581856567400000010158000009000145000000045002800060011800000500000664001680068000".repeat(
        3
      );
    generateTextMock.mockResolvedValueOnce({
      text: degenerate,
      finishReason: "stop"
    });
    aiGenerateWithPollMock.mockResolvedValueOnce("<article>fallback</article>");

    const logs: Array<{ level: string; message: string; role: string }> = [];
    const agent = {
      log: (level: string, message: string, role: string) => {
        logs.push({ level, message, role });
      },
      rotateOpenRouterKeyFromDoppler: vi.fn().mockResolvedValue(null)
    } as const;

    const env = {
      AI_CHAT_FALLBACK: "Kimi",
      OPENROUTER_API_KEY: "test-openrouter-key",
      AI: { run: vi.fn() }
    } as unknown as Env;

    const text = await runKimiWithPoll(
      env,
      {
        messages: [{ role: "user", content: "Write an article." }],
        max_tokens: 2048
      },
      {},
      agent as never
    );

    expect(text).toBe("<article>fallback</article>");
    expect(aiGenerateWithPollMock).toHaveBeenCalledTimes(1);
    expect(
      logs.some(
        (l) =>
          l.level === "warning" &&
          l.message.includes("degenerate output") &&
          l.message.includes("falling back to Workers AI")
      )
    ).toBe(true);
  });

  it("uses OpenRouter after Claude fails only when AI_CHAT_FALLBACK=kimi", async () => {
    useClaudeToken();
    generateTextMock
      .mockRejectedValueOnce(new Error("claude down"))
      .mockResolvedValueOnce({
        text: "<article>from openrouter</article>",
        finishReason: "stop"
      });
    const { agent, rotate } = testAgent();

    const text = await runKimiWithPoll(
      {
        AI_CHAT_FALLBACK: "kimi",
        OPENROUTER_API_KEY: "test-openrouter-key",
        AI: { run: vi.fn() }
      } as unknown as Env,
      { messages: [{ role: "user", content: "Write an article." }] },
      {},
      agent as never
    );

    expect(text).toBe("<article>from openrouter</article>");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(createOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
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
    ).rejects.toThrow(/OpenRouter and Workers AI were not called/);
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
