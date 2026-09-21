import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn()
}));

vi.mock("ai", () => ({
  generateText: generateTextMock,
  tool: (def: unknown) => def
}));

import { clearClaudeCodeSubscriptionCache } from "../claude-code-subscription";
import {
  setClaudeChatFailureSink,
  type ClaudeChatFailureNotice
} from "../claude-chat-failure";
import { analyzeScreenshotWithVision } from "../../tools/vision-audit";

const EMPTY_CALL = { prompt: [] } as LanguageModelV3CallOptions;

async function invokeModel(model: LanguageModel): Promise<{ text: string }> {
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    throw new Error("expected a Claude LanguageModel");
  }
  await model.doGenerate(EMPTY_CALL);
  return { text: '{"issues":[]}', finishReason: "stop" } as {
    text: string;
  };
}

describe("analyzeScreenshotWithVision", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    clearClaudeCodeSubscriptionCache();
    setClaudeChatFailureSink(null);
  });

  it("does not call Workers AI when Claude has no token", async () => {
    generateTextMock.mockImplementation(
      async (args: { model: LanguageModel }) => invokeModel(args.model)
    );
    const aiRun = vi.fn();
    const notices: ClaudeChatFailureNotice[] = [];
    setClaudeChatFailureSink({
      report: (notice) => {
        notices.push(notice);
      },
      clear: () => undefined
    });
    const agent = {
      envBindings: { AI: { run: aiRun } },
      log: vi.fn()
    };

    await expect(
      analyzeScreenshotWithVision(
        agent as never,
        new Uint8Array([1, 2, 3]),
        "https://catsluvus.com/reviews/example",
        "mobile"
      )
    ).rejects.toThrow(/No other model was called/);

    expect(aiRun).not.toHaveBeenCalled();
    expect(notices[0]?.howToFix).toMatch(/Authorize|setup-token/);
    expect(agent.log).toHaveBeenCalledWith(
      "error",
      expect.stringMatching(/stopped the pipeline/),
      "qaReviewer"
    );
  });

  it("does not call Workers AI when the Claude vision call throws", async () => {
    generateTextMock.mockRejectedValue(new Error("vision overloaded"));
    const aiRun = vi.fn();
    const notices: ClaudeChatFailureNotice[] = [];
    setClaudeChatFailureSink({
      report: (notice) => {
        notices.push(notice);
      },
      clear: () => undefined
    });

    await expect(
      analyzeScreenshotWithVision(
        {
          envBindings: { AI: { run: aiRun } },
          log: vi.fn()
        } as never,
        new Uint8Array([9]),
        "https://catsluvus.com/reviews/example",
        "desktop"
      )
    ).rejects.toThrow(/vision overloaded/);

    expect(aiRun).not.toHaveBeenCalled();
    const model = generateTextMock.mock.calls[0]?.[0] as {
      model?: { provider?: string };
    };
    expect(model.model?.provider).toBe("anthropic");
    expect(notices[0]?.message).toMatch(/vision overloaded/);
    expect(notices[0]?.howToFix.length).toBeGreaterThan(10);
  });
});
