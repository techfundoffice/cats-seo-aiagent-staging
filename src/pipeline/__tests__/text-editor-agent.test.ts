import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleData } from "../html-builder";

const { runKimiWithPollMock } = vi.hoisted(() => ({
  runKimiWithPollMock: vi.fn()
}));

vi.mock("../kimi-model", () => ({
  runKimiWithPoll: runKimiWithPollMock
}));

import { runTextEditorAgent } from "../text-editor-agent";

const baseArticle: ArticleData = {
  title: "Best Elevated Bowl...",
  metaDescription: "Helpful cat bowl guide.",
  quickAnswer: "Use a bowl that keeps your cat comfortable while eating.",
  keyTakeaways: ["Raised bowls can reduce neck strain for some cats."],
  introduction: "Senior cats may eat more comfortably with the right setup.",
  sections: [
    {
      heading: "Why height matters",
      content:
        "The right bowl height can make mealtimes easier for senior cats with joint discomfort."
    }
  ],
  whyTrustUs:
    "We review product features and comfort details that matter for aging cats.",
  faqs: [
    {
      question: "Are elevated bowls good for senior cats?",
      answer:
        "They can help some senior cats eat with a more comfortable posture."
    }
  ],
  conclusion: "Choose a stable bowl that matches your cat's posture needs."
};

describe("runTextEditorAgent", () => {
  beforeEach(() => {
    runKimiWithPollMock.mockReset();
  });

  it("rejects malformed rewrite candidates instead of throwing", async () => {
    runKimiWithPollMock.mockResolvedValueOnce(
      JSON.stringify({
        ...baseArticle,
        sections: undefined
      })
    );

    const log = vi.fn();
    const agent = {
      envBindings: {},
      log
    } as never;

    const result = await runTextEditorAgent(agent, baseArticle, "... vs ...");

    expect(result).toBe(baseArticle);
    expect(log).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining(
        "safeguard rejection — returning original (sections missing or invalid)"
      ),
      "textEditorAgent"
    );
  });
});
