import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock, createOpenRouterMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  createOpenRouterMock: vi.fn(() => vi.fn(() => "openrouter-model"))
}));

vi.mock("ai", () => ({
  generateText: generateTextMock
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: createOpenRouterMock
}));

import {
  getScoutModel,
  isDegenerateOutput,
  runKimiWithPoll,
  setRotatedOpenRouterKey
} from "../kimi-model";

describe("runKimiWithPoll", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    createOpenRouterMock.mockClear();
    setRotatedOpenRouterKey(null);
  });

  it("throws when Claude and OpenRouter both fail, instead of billing a third provider", async () => {
    // Workers AI used to sit behind OpenRouter here, and that is precisely
    // how a month of writer traffic became a 65M-neuron invoice: whenever
    // OpenRouter credits ran dry, every call in the pipeline landed on
    // `env.AI` for as long as that lasted. There is no third leg now.
    generateTextMock.mockRejectedValueOnce(new Error("OpenRouter 402"));
    const aiRun = vi.fn();

    const logs: string[] = [];
    const agent = {
      log: (_lvl: string, msg: string) => logs.push(msg),
      rotateOpenRouterKeyFromDoppler: vi.fn().mockResolvedValue(null)
    };
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
    ).rejects.toThrow(/No model provider available/);

    // The binding must not be touched even though it is still bound.
    expect(aiRun).not.toHaveBeenCalled();
    expect(
      logs.some((m) => m.includes("no Workers AI fallback exists any more"))
    ).toBe(true);
  });

  it("calls OpenRouter with Kimi thinking disabled, and honours the caller's timeout budget", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "<article>ok</article>",
      finishReason: "stop"
    });

    const logs: string[] = [];
    const agent = {
      log: (_lvl: string, msg: string) => logs.push(msg),
      rotateOpenRouterKeyFromDoppler: vi.fn().mockResolvedValue(null)
    };
    const env = {
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

    expect(text).toBe("<article>ok</article>");
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openrouter-model",
        maxOutputTokens: 2048,
        messages: [{ role: "user", content: "Rewrite this article as HTML." }],
        providerOptions: { openrouter: { reasoning: { enabled: false } } }
      })
    );
    // OpenRouter is the last leg now, so the caller's budget has to reach it
    // rather than being replaced by that leg's own default.
    expect(logs.some((m) => m.includes("syncTimeoutMs=90000"))).toBe(true);
  });

  it("throws rather than returning degenerate OpenRouter output as a successful generation", async () => {
    // Abbreviated form of the real 2026-07-10 incident output — pure
    // digit/punctuation noise from the first character, long enough to
    // clear the empty-response check but not real prose.
    const degenerate =
      "Sam: 107000. 8.gs 165000 8. 2000... " +
      "100000450005581856567400000010158000009000145000000045002800060011800000500000664001680068000".repeat(
        3
      );
    generateTextMock.mockResolvedValue({
      text: degenerate,
      finishReason: "stop"
    });

    const logs: string[] = [];
    const agent = {
      log: (_lvl: string, msg: string) => logs.push(msg),
      rotateOpenRouterKeyFromDoppler: vi.fn().mockResolvedValue(null)
    };
    const env = {
      OPENROUTER_API_KEY: "test-openrouter-key",
      AI: { run: vi.fn() }
    } as unknown as Env;

    await expect(
      runKimiWithPoll(
        env,
        {
          messages: [{ role: "user", content: "Write an article." }],
          max_tokens: 2048
        },
        {},
        agent as never
      )
    ).rejects.toThrow(/No model provider available/);
    expect(logs.some((m) => m.includes("degenerate output"))).toBe(true);
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

describe("getScoutModel", () => {
  beforeEach(() => {
    createOpenRouterMock.mockClear();
    setRotatedOpenRouterKey(null);
  });

  it("uses the OpenRouter free router when no Claude subscription is configured", () => {
    // The scout was the only surface that ran on `env.AI` unconditionally —
    // by design, up to 3 attempts x 2000 output tokens per tick — so it was
    // a standing neuron charge that no fallback ever relieved. It now runs
    // on Claude, with the free router behind it; these tests have no Claude
    // credential, so the free router is what they see.
    getScoutModel({
      OPENROUTER_API_KEY: "test-openrouter-key",
      AI: { run: vi.fn() }
    } as unknown as Env);
    expect(createOpenRouterMock).toHaveBeenCalled();
  });

  it("refuses rather than reaching for the AI binding when no provider is configured", () => {
    const aiRun = vi.fn();
    expect(() =>
      getScoutModel({ AI: { run: aiRun } } as unknown as Env)
    ).toThrow(/No model provider available/);
    // `pickNextCategory` catches this per attempt and falls through to its
    // hardcoded Tier 2 category pool, so discovery continues without neurons.
    expect(aiRun).not.toHaveBeenCalled();
  });
});
