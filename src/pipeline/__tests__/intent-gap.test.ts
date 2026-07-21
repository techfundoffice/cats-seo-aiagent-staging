import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock, getKimiModelMock, getKimiProviderOptionsMock } =
  vi.hoisted(() => ({
    generateTextMock: vi.fn(),
    getKimiModelMock: vi.fn(() => "kimi-model"),
    getKimiProviderOptionsMock: vi.fn(() => ({ kimi: { test: true } }))
  }));

vi.mock("ai", () => ({
  generateText: generateTextMock
}));

vi.mock("../kimi-model", () => ({
  getKimiModel: getKimiModelMock,
  getKimiProviderOptions: getKimiProviderOptionsMock
}));

import { analyzeSerpIntentGap } from "../intent-gap";

describe("analyzeSerpIntentGap", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    getKimiModelMock.mockClear();
    getKimiProviderOptionsMock.mockClear();
  });

  it("skips malformed bucket entries instead of throwing", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify({
        buckets: [
          null,
          "not-an-object",
          7,
          {
            intent: "support",
            saturation: 0.4,
            description:
              "Explain which stair designs stay stable for heavier cats"
          }
        ]
      })
    });

    const log = vi.fn();
    const agent = {
      envBindings: {},
      log
    } as never;

    const result = await analyzeSerpIntentGap(
      agent,
      "best stairs for large senior cats",
      ["Best Cat Stairs for Senior Cats"],
      []
    );

    expect(result.skipped).toBe(false);
    expect(result.buckets).toEqual([
      {
        intent: "support",
        saturation: 0.4,
        isGap: false,
        description: "Explain which stair designs stay stable for heavier cats"
      }
    ]);
    expect(result.dominantIntent).toBe("support");
    expect(result.promptBlock).toContain("support");
    expect(log).toHaveBeenCalledWith(
      "info",
      'Intent Gap: dominant="support", gaps=[none], 1 buckets'
    );
  });

  it("normalizes percentage saturation strings as ratios", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify({
        buckets: [
          {
            intent: "support",
            saturation: "40%",
            description: "support intent"
          },
          {
            intent: "transactional",
            saturation: "20%",
            description: "buying intent"
          }
        ]
      })
    });

    const agent = {
      envBindings: {},
      log: vi.fn()
    } as never;

    const result = await analyzeSerpIntentGap(
      agent,
      "wide cat ramp for better balance",
      ["Wide Cat Ramp for Better Balance"],
      []
    );

    expect(result.skipped).toBe(false);
    expect(result.buckets).toEqual([
      {
        intent: "support",
        saturation: 0.4,
        isGap: false,
        description: "support intent"
      },
      {
        intent: "transactional",
        saturation: 0.2,
        isGap: true,
        description: "buying intent"
      }
    ]);
    expect(result.gapIntents).toEqual(["transactional"]);
  });
});
