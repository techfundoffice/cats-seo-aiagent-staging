import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SEOArticleAgent } from "../../server";

const { assignCopilotToIssueMock, createIssueDirectMock } = vi.hoisted(() => ({
  assignCopilotToIssueMock: vi.fn(),
  createIssueDirectMock: vi.fn()
}));

vi.mock("../escalate-to-claude", () => ({
  assignCopilotToIssue: assignCopilotToIssueMock,
  createIssueDirect: createIssueDirectMock,
  getAdminBase: () => "https://cats-seo-aiagent.webmaster-bc8.workers.dev",
  getRepoName: () => "cats-seo-aiagent-cloudflare",
  getRepoOwner: () => "techfundoffice",
  NPM_RUN_CHECK_RULE:
    "- Run `npm run check` before committing (format, lint, typecheck, and tests).",
  getSafeKeyword: (value: string) => value,
  isDurableObjectResetError: () => false,
  renderMarkdownInlineCode: (value: string) => `\`${value}\``
}));

import { triggerCodebaseImprovement } from "../improvement-agent";

function makeAgent(githubToken: string | undefined) {
  const kv = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined)
  };
  const agent = {
    envBindings: {
      GITHUB_TOKEN_SECRET: githubToken,
      ARTICLES_KV: kv
    },
    log: vi.fn()
  };
  return { agent, kv };
}

const sampleInput = {
  kvKey: "cat-stairs:lightweight-portable-cat-stairs",
  keyword: "lightweight portable cat stairs",
  categorySlug: "cat-stairs",
  articleUrl:
    "https://catsluvus.com/reviews/cat-stairs/lightweight-portable-cat-stairs"
};

describe("triggerCodebaseImprovement disabled", () => {
  beforeEach(() => {
    assignCopilotToIssueMock.mockReset();
    createIssueDirectMock.mockReset();
  });

  it("no-ops and does not call GitHub when GITHUB_TOKEN_SECRET is set", async () => {
    const { agent, kv } = makeAgent("token");

    await triggerCodebaseImprovement(
      agent as unknown as SEOArticleAgent,
      sampleInput
    );

    expect(createIssueDirectMock).not.toHaveBeenCalled();
    expect(assignCopilotToIssueMock).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.delete).not.toHaveBeenCalled();
    expect(agent.log).toHaveBeenCalledTimes(1);
    expect(agent.log).toHaveBeenCalledWith(
      "info",
      "Improvement Agent: disabled",
      "improvementAgent"
    );
  });

  it("no-ops the same way when the GitHub token is missing", async () => {
    const { agent, kv } = makeAgent("   ");

    await triggerCodebaseImprovement(
      agent as unknown as SEOArticleAgent,
      sampleInput
    );

    expect(createIssueDirectMock).not.toHaveBeenCalled();
    expect(assignCopilotToIssueMock).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    const logMessages = agent.log.mock.calls.map((call) => String(call[1]));
    expect(logMessages).toEqual(["Improvement Agent: disabled"]);
    expect(logMessages.some((msg) => msg.includes("GITHUB_TOKEN_SECRET"))).toBe(
      false
    );
  });
});
