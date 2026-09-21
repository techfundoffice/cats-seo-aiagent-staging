import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock, createWorkersAIMock, createOpenRouterMock } =
  vi.hoisted(() => ({
    generateTextMock: vi.fn(),
    createWorkersAIMock: vi.fn(
      (): ((...args: unknown[]) => unknown) => () => "workers-model"
    ),
    createOpenRouterMock: vi.fn(
      (): ((...args: unknown[]) => unknown) => () => "openrouter-model"
    )
  }));

vi.mock("ai", () => ({
  generateText: generateTextMock
}));

vi.mock("workers-ai-provider", () => ({
  createWorkersAI: createWorkersAIMock
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: createOpenRouterMock
}));

vi.mock("../keywords", () => ({
  generateKeywords: vi.fn(async () => 1)
}));

import {
  clearClaudeCodeSubscriptionCache,
  clearClaudeRateLimitCooldown,
  configureClaudeCodeSubscription,
  defaultExpiresAtMs
} from "../claude-code-subscription";
import { scoutHighTicketCategory } from "../scout";

const SCOUT_JSON = JSON.stringify({
  name: "Cat Ramps For Senior Cats",
  slug: "cat-ramps-for-senior-cats",
  estimatedKeywords: 12,
  avgPrice: "$40-$120",
  reasoning: "mobility niche",
  categoryRoiScore: 8
});

function scoutAgent(env: Record<string, unknown>) {
  return {
    envBindings: env,
    state: { activityLog: [] },
    log: vi.fn(),
    sql: (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (/COUNT\(\*\)/i.test(query)) return [{ cnt: 1 }];
      if (/FROM categories/i.test(query)) return [];
      return [];
    }
  };
}

describe("scoutHighTicketCategory AI tier", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    createWorkersAIMock.mockReset();
    createWorkersAIMock.mockImplementation(() => () => "workers-model");
    createOpenRouterMock.mockReset();
    clearClaudeCodeSubscriptionCache();
    clearClaudeRateLimitCooldown();
  });

  afterEach(() => {
    clearClaudeCodeSubscriptionCache();
    clearClaudeRateLimitCooldown();
  });

  it("uses Claude by default and does not call Workers AI Qwen", async () => {
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-oat01-test-token",
        expiresAtMs: defaultExpiresAtMs(),
        savedAt: new Date().toISOString()
      },
      "dashboard"
    );
    generateTextMock.mockResolvedValue({
      text: SCOUT_JSON,
      finishReason: "stop"
    });

    const saved = await scoutHighTicketCategory(
      scoutAgent({ AI: { run: vi.fn() } }) as never
    );

    expect(saved?.slug).toBe("cat-ramps-for-senior-cats");
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

  it("does not call Qwen when Claude fails", async () => {
    configureClaudeCodeSubscription(
      {
        token: "sk-ant-oat01-test-token",
        expiresAtMs: defaultExpiresAtMs(),
        savedAt: new Date().toISOString()
      },
      "dashboard"
    );
    generateTextMock.mockRejectedValue(new Error("claude down"));

    const saved = await scoutHighTicketCategory(
      scoutAgent({ AI: { run: vi.fn() } }) as never
    );

    expect(saved?.slug).toBe("cat-water-fountains");
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(createWorkersAIMock).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();
  });

  it("does not call Qwen when AI_CHAT_FALLBACK=kimi and Claude is absent", async () => {
    const aiRun = vi.fn();
    const saved = await scoutHighTicketCategory(
      scoutAgent({
        AI_CHAT_FALLBACK: "kimi",
        AI: { run: aiRun }
      }) as never
    );

    expect(saved?.slug).toBe("cat-water-fountains");
    expect(createWorkersAIMock).not.toHaveBeenCalled();
    expect(createOpenRouterMock).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
  });
});
