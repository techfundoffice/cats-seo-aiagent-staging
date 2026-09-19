import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  callClaudeCodeTextMock,
  getClaudeCodeLanguageModelMock,
  resolveClaudeCodeSubscriptionMock,
  cooldownMock
} = vi.hoisted(() => ({
  callClaudeCodeTextMock: vi.fn(),
  getClaudeCodeLanguageModelMock: vi.fn(() => "claude-model"),
  resolveClaudeCodeSubscriptionMock: vi.fn((): { token: string } | null => ({
    token: "t"
  })),
  cooldownMock: vi.fn(() => 0)
}));

vi.mock("../claude-code-subscription", () => ({
  callClaudeCodeText: callClaudeCodeTextMock,
  getClaudeCodeLanguageModel: getClaudeCodeLanguageModelMock,
  resolveClaudeCodeSubscription: resolveClaudeCodeSubscriptionMock,
  getClaudeRateLimitCooldownRemainingMs: cooldownMock,
  resolveClaudeCallTimeoutMs: (ms?: number) => ms ?? 120_000,
  getClaudeCodeModelId: () => "claude-sonnet-4-5",
  isClaudeAuthError: () => false,
  lastClaudeSuccessMeta: { modelId: "claude-sonnet-4-5", tokenSource: "test" },
  CLAUDE_CODE_CALL_FAILED_LOG_PREFIX: "[claude-code] Anthropic call failed"
}));

import {
  getFreeModel,
  getKimiModel,
  getScoutModel,
  isDegenerateOutput,
  runKimiWithPoll
} from "../kimi-model";

const ENV = {} as unknown as Env;

function makeAgent() {
  const logs: string[] = [];
  return {
    agent: { log: (_l: string, m: string) => logs.push(m) } as never,
    logs
  };
}

beforeEach(() => {
  callClaudeCodeTextMock.mockReset();
  getClaudeCodeLanguageModelMock.mockClear();
  getClaudeCodeLanguageModelMock.mockReturnValue("claude-model");
  resolveClaudeCodeSubscriptionMock.mockReturnValue({ token: "t" });
  cooldownMock.mockReturnValue(0);
});

describe("Claude is the only provider", () => {
  it("returns Claude's text and honours the caller's timeout budget", async () => {
    callClaudeCodeTextMock.mockResolvedValueOnce("<article>ok</article>");
    const { agent, logs } = makeAgent();

    const text = await runKimiWithPoll(
      ENV,
      { prompt: "Write." },
      { syncTimeoutMs: 90_000 },
      agent
    );

    expect(text).toBe("<article>ok</article>");
    expect(callClaudeCodeTextMock).toHaveBeenCalledWith(
      ENV,
      expect.objectContaining({ prompt: "Write.", timeoutMs: 90_000 })
    );
    expect(logs.some((m) => m.includes("syncTimeoutMs=90000"))).toBe(true);
  });

  it("throws instead of falling back when Claude fails — there is no second provider", async () => {
    // OpenRouter/Kimi used to sit here and Workers AI behind that. Both are
    // gone, so a Claude failure has to surface, not silently degrade.
    callClaudeCodeTextMock.mockRejectedValueOnce(
      new Error("401 invalid token")
    );
    const { agent, logs } = makeAgent();

    await expect(
      runKimiWithPoll(ENV, { prompt: "Write." }, {}, agent)
    ).rejects.toThrow(/401 invalid token/);
    expect(logs.some((m) => m.includes("no fallback provider exists"))).toBe(
      true
    );
  });

  it("throws when no Claude subscription is configured, without calling out", async () => {
    resolveClaudeCodeSubscriptionMock.mockReturnValue(null);
    const { agent } = makeAgent();

    await expect(
      runKimiWithPoll(ENV, { prompt: "Write." }, {}, agent)
    ).rejects.toThrow(/No model provider available/);
    expect(callClaudeCodeTextMock).not.toHaveBeenCalled();
  });

  it("throws while an Anthropic rate-limit cooldown is active", async () => {
    cooldownMock.mockReturnValue(30_000);
    const { agent } = makeAgent();

    await expect(
      runKimiWithPoll(ENV, { prompt: "Write." }, {}, agent)
    ).rejects.toThrow(/rate-limit cooldown/);
    expect(callClaudeCodeTextMock).not.toHaveBeenCalled();
  });

  it("refuses degenerate Claude output rather than passing it off as a generation", async () => {
    const degenerate =
      "Sam: 107000. 8.gs 165000 8. 2000... " +
      "100000450005581856567400000010158000009000145000000045002800060011800000500000664001680068000".repeat(
        3
      );
    callClaudeCodeTextMock.mockResolvedValueOnce(degenerate);
    const { agent } = makeAgent();

    await expect(
      runKimiWithPoll(ENV, { prompt: "Write." }, {}, agent)
    ).rejects.toThrow(/degenerate output/);
  });

  it("routes every model selector to Claude", () => {
    for (const pick of [getKimiModel, getFreeModel, getScoutModel]) {
      getClaudeCodeLanguageModelMock.mockClear();
      expect(pick(ENV)).toBe("claude-model");
      expect(getClaudeCodeLanguageModelMock).toHaveBeenCalled();
    }
  });

  it("makes every selector throw when Claude is unavailable", () => {
    resolveClaudeCodeSubscriptionMock.mockReturnValue(null);
    for (const pick of [getKimiModel, getFreeModel, getScoutModel]) {
      expect(() => pick(ENV)).toThrow(/No model provider available/);
    }
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
