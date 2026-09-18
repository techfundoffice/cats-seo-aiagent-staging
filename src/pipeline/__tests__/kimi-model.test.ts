import { beforeEach, describe, expect, it, vi } from "vitest";

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
  isDegenerateOutput,
  runKimiWithPoll,
  setRotatedOpenRouterKey
} from "../kimi-model";

describe("runKimiWithPoll", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    aiGenerateWithPollMock.mockReset();
    createOpenRouterMock.mockClear();
    createWorkersAIMock.mockClear();
    setRotatedOpenRouterKey(null);
  });

  it("refuses the Workers AI fallback when the neuron kill switch is at its default", async () => {
    // Claude absent + OpenRouter failing used to drop every call onto
    // `env.AI`, which is how a month of writer traffic turned into a
    // 65M-neuron invoice. With no WORKERS_AI_* flag set the call must
    // refuse instead of billing, and must not touch the binding at all.
    generateTextMock.mockRejectedValueOnce(new Error("OpenRouter 402"));
    const aiRun = vi.fn();

    const agent = { log: vi.fn(), rotateOpenRouterKeyFromDoppler: vi.fn() };
    const env = {
      OPENROUTER_API_KEY: "test-openrouter-key",
      AI: { run: aiRun }
    } as unknown as Env;

    await expect(
      runKimiWithPoll(
        env,
        { messages: [{ role: "user", content: "Write." }], max_tokens: 2048 },
        {},
        agent as never
      )
    ).rejects.toThrow(/disabled to stop neuron billing/);

    expect(aiGenerateWithPollMock).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
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
      OPENROUTER_API_KEY: "test-openrouter-key",
      // This test is specifically about the Workers AI fallback leg, so it
      // opts that surface back in past the neuron kill switch (which
      // defaults every env.AI surface to off).
      WORKERS_AI_TEXT_ENABLED: "true",
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
      OPENROUTER_API_KEY: "test-openrouter-key",
      // This test is specifically about the Workers AI fallback leg, so it
      // opts that surface back in past the neuron kill switch (which
      // defaults every env.AI surface to off).
      WORKERS_AI_TEXT_ENABLED: "true",
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
