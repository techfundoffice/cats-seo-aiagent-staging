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

describe("triggerCodebaseImprovement CI instructions", () => {
  beforeEach(() => {
    assignCopilotToIssueMock.mockReset();
    assignCopilotToIssueMock.mockResolvedValue(undefined);
    createIssueDirectMock.mockReset();
    createIssueDirectMock.mockResolvedValue({ number: 123 });
  });

  it("uses the github-mcp-server-get_job_logs tool name in issue body instructions", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "token",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-steps-for-senior-cats-with-arthritis-high-beds:stable-cat-stairs-for-tall-mattress",
      keyword: "stable cat stairs for tall mattress",
      categorySlug: "cat-steps-for-senior-cats-with-arthritis-high-beds",
      articleUrl:
        "https://catsluvus.com/cat-steps-for-senior-cats-with-arthritis-high-beds/stable-cat-stairs-for-tall-mattress"
    });

    const body = createIssueDirectMock.mock.calls[0]?.[2]?.body;
    expect(typeof body).toBe("string");
    expect(body).toContain(
      '`github-mcp-server-get_job_logs` with `{ owner: "techfundoffice", repo: "cats-seo-aiagent-cloudflare", run_id: [that_run_id], failed_only: true }`'
    );
    expect(body).toContain(
      '`owner: "techfundoffice"`, `repo: "cats-seo-aiagent-cloudflare"`'
    );
    expect(body).toContain(
      '`{ owner: "techfundoffice", repo: "cats-seo-aiagent-cloudflare", run_id: [that_run_id], failed_only: true }`'
    );
    expect(body).toContain("`copilot/improve-auto-...`");
    expect(body).toContain(
      "Run `git rev-parse --abbrev-ref HEAD` and copy the exact branch output."
    );
    expect(body).toContain(
      "if your environment auto-opens/updates a PR anyway, immediately rename it to"
    );
    expect(body).toContain("mark it ready-for-review, and only then");
    expect(body).toContain("inspect CI or run CI MCP queries");
    expect(body).toContain(
      "**Mandatory PR rule:** only open a new PR when your actual code change is ready to review."
    );
    expect(body).toContain(
      "If no PR exists yet, wait until the change is ready, then open one as **ready-for-review**"
    );
    expect(body).toContain(
      "If a PR already exists for your branch, reuse it: rename it to"
    );
    expect(body).toContain("Do **not** open a placeholder PR before coding.");
    expect(body).toContain(
      "If no PR exists yet, wait until the change is ready, then open one as **ready-for-review**"
    );
    expect(body).toContain("If a PR already exists for your branch, reuse it:");
    expect(body).toContain("and keep only that one PR open.");
    expect(body).toContain(
      "`/repos/{owner}/{repo}/pulls/{pull_number}/convert_to_draft` and then"
    );
    expect(body).toContain(
      '`owner: "techfundoffice"`, `repo: "cats-seo-aiagent-cloudflare"`, `resource_id: "sanity-check.yml"`, `per_page: 10`, and `workflow_runs_filter: { branch: "[exact git branch from \'git rev-parse --abbrev-ref HEAD\']", event: "pull_request", status: "completed" }`'
    );
    expect(body).toContain(
      "reruns auto-merge checks with jobs instead of another zero-job"
    );
    expect(body).toContain("or post progress updates that rely on CI status.");
    expect(body).toContain(
      "Do not call `engine-tools-report_progress` / `report_progress` for an initial checklist before code is ready"
    );
    expect(body).toContain(
      "If your tooling has a startup progress step, keep it local/non-PR (no commit/push) until code is ready;"
    );
    expect(body).toContain(
      "- Run `npm run check` before committing (format, lint, typecheck, and tests)."
    );
    expect(body).toContain(
      "Start by running `search_code_subagent` to locate relevant implementations before manual file inspection."
    );
    expect(body).not.toContain(
      "`get_job_logs` with `{ run_id: [that_run_id], failed_only: true }`"
    );
  });

  it("pins the exact ready-to-copy improve(auto) PR title format", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "token",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-stairs-and-steps-for-senior-cats-with-arthritis:lightweight-portable-cat-stairs-travel",
      keyword: "lightweight portable cat stairs travel",
      categorySlug: "cat-stairs-and-steps-for-senior-cats-with-arthritis",
      articleUrl:
        "https://catsluvus.com/cat-stairs-and-steps-for-senior-cats-with-arthritis/lightweight-portable-cat-stairs-travel"
    });

    const body = createIssueDirectMock.mock.calls[0]?.[2]?.body;
    expect(typeof body).toBe("string");
    expect(body).toContain(
      "Copy/paste PR title when your change is ready: `improve(auto): [one-line root cause or area]`"
    );
    expect(body).toContain(
      "Use the exact lowercase prefix `improve(auto): ` (do not use `Improve(auto):`)."
    );
    expect(body).not.toContain("improve(auto): <one-line root cause or area>");
  });

  it("lists cloudflare-browser-rendering in available skill docs", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "token",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-ramp-for-heavy-cats-with-arthritis:durable-cat-ramp-for-heavy-cats",
      keyword: "durable cat ramp for heavy cats",
      categorySlug: "cat-ramp-for-heavy-cats-with-arthritis",
      articleUrl:
        "https://catsluvus.com/cat-ramp-for-heavy-cats-with-arthritis/durable-cat-ramp-for-heavy-cats"
    });

    const body = createIssueDirectMock.mock.calls[0]?.[2]?.body;
    expect(typeof body).toBe("string");
    expect(body).toContain(
      "- `.claude/skills/cloudflare-browser-rendering/SKILL.md`"
    );
  });

  it("logs rollback failures when dedup cleanup fails after dispatch errors", async () => {
    createIssueDirectMock.mockRejectedValueOnce(
      new Error("issue dispatch failed")
    );
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockRejectedValue(new Error("kv delete failed"))
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "token",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-window-perches-for-large-breed-cats:elevated-cat-window-perch-with-heating-pad",
      keyword: "elevated cat window perch with heating pad",
      categorySlug: "cat-window-perches-for-large-breed-cats",
      articleUrl:
        "https://catsluvus.com/cat-window-perches-for-large-breed-cats/elevated-cat-window-perch-with-heating-pad"
    });

    const logMessages = agent.log.mock.calls.map((call) => String(call[1]));
    expect(
      logMessages.some((msg) =>
        msg.includes("failed to rollback pre-issue dedup key")
      )
    ).toBe(true);
    expect(
      logMessages.some((msg) => msg.includes("after dispatch threw"))
    ).toBe(true);
    expect(logMessages.some((msg) => msg.includes("kv delete failed"))).toBe(
      true
    );
  });

  it("logs rollback failures when dedup cleanup fails after empty create response", async () => {
    createIssueDirectMock.mockResolvedValueOnce(null);
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockRejectedValue(new Error("kv delete failed"))
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "token",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-window-perches-for-large-cats-and-multi-cat-households:best-cat-window-perch-for-senior-cats",
      keyword: "best cat window perch for senior cats",
      categorySlug:
        "cat-window-perches-for-large-cats-and-multi-cat-households",
      articleUrl:
        "https://catsluvus.com/cat-window-perches-for-large-cats-and-multi-cat-households/best-cat-window-perch-for-senior-cats"
    });

    const logMessages = agent.log.mock.calls.map((call) => String(call[1]));
    expect(
      logMessages.some((msg) =>
        msg.includes("failed to rollback pre-issue dedup key")
      )
    ).toBe(true);
    expect(
      logMessages.some((msg) =>
        msg.includes("after direct issue create returned no data")
      )
    ).toBe(true);
    expect(logMessages.some((msg) => msg.includes("kv delete failed"))).toBe(
      true
    );
  });

  it("logs derived article URL when token is missing and input URL is omitted", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "   ",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-window-perches-for-large-cats-and-multi-cat-households:cat-window-perch-wall-mount-alternative",
      keyword: "cat window perch wall mount alternative",
      categorySlug: "cat-window-perches-for-large-cats-and-multi-cat-households"
    });

    const logMessages = agent.log.mock.calls.map((call) => String(call[1]));
    expect(
      logMessages.some((msg) =>
        msg.includes(
          'articleUrl="https://catsluvus.com/cat-window-perches-for-large-cats-and-multi-cat-households/cat-window-perch-wall-mount-alternative"'
        )
      )
    ).toBe(true);
    expect(createIssueDirectMock).not.toHaveBeenCalled();
  });

  it("accepts cross-realm URL-like articleUrl values without coercion warnings", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "token",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };
    const liveUrl =
      "https://catsluvus.com/cat-window-perches-for-large-cats-and-multi-cat-households/cat-window-perch-wall-mount-alternative";
    const articleUrl = {
      href: liveUrl,
      toString: () => liveUrl
    } as unknown as URL;

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-window-perches-for-large-cats-and-multi-cat-households:cat-window-perch-wall-mount-alternative",
      keyword: "cat window perch wall mount alternative",
      categorySlug:
        "cat-window-perches-for-large-cats-and-multi-cat-households",
      articleUrl
    });

    const body = createIssueDirectMock.mock.calls[0]?.[2]?.body;
    expect(typeof body).toBe("string");
    expect(body).toContain(
      "- **Live URL**: https://catsluvus.com/cat-window-perches-for-large-cats-and-multi-cat-households/cat-window-perch-wall-mount-alternative"
    );
    const logMessages = agent.log.mock.calls.map((call) => String(call[1]));
    expect(
      logMessages.some((msg) =>
        msg.includes("coerced non-string input field articleUrl")
      )
    ).toBe(false);
  });

  it("uses href when URL-like articleUrl has a throwing toString()", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "token",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };
    const liveUrl =
      "https://catsluvus.com/cat-window-perches-for-large-cats-and-multi-cat-households/cat-window-perch-wall-mount-alternative";
    const articleUrl = {
      href: liveUrl,
      toString: () => {
        throw new Error("toString exploded");
      }
    } as unknown as URL;

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-window-perches-for-large-cats-and-multi-cat-households:cat-window-perch-wall-mount-alternative",
      keyword: "cat window perch wall mount alternative",
      categorySlug:
        "cat-window-perches-for-large-cats-and-multi-cat-households",
      articleUrl
    });

    const body = createIssueDirectMock.mock.calls[0]?.[2]?.body;
    expect(typeof body).toBe("string");
    expect(body).toContain(`- **Live URL**: ${liveUrl}`);
    const logMessages = agent.log.mock.calls.map((call) => String(call[1]));
    expect(
      logMessages.some((msg) =>
        msg.includes("failed to render URL-like articleUrl via toString()")
      )
    ).toBe(false);
  });

  it("falls back to a valid toString() URL when href is invalid", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "token",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };
    const liveUrl =
      "https://catsluvus.com/cat-window-perches-for-apartment-living/window-mounted-cat-hammock";
    const articleUrl = {
      href: "not a valid url",
      toString: () => liveUrl
    } as unknown as URL;

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-window-perches-for-apartment-living:window-mounted-cat-hammock",
      keyword: "window mounted cat hammock",
      categorySlug: "cat-window-perches-for-apartment-living",
      articleUrl
    });

    const body = createIssueDirectMock.mock.calls[0]?.[2]?.body;
    expect(typeof body).toBe("string");
    expect(body).toContain(`- **Live URL**: ${liveUrl}`);
    expect(body).not.toContain("not a valid url");
  });

  it("keeps the published live URL when kvKey includes extra colon segments", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "token",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-stairs-and-steps-for-senior-cats-with-arthritis:indoor-cat-ramp-stairs-combo-senior:extra",
      keyword: "indoor cat ramp stairs combo senior",
      categorySlug: "cat-stairs-and-steps-for-senior-cats-with-arthritis",
      articleUrl:
        "https://catsluvus.com/cat-stairs-and-steps-for-senior-cats-with-arthritis/indoor-cat-ramp-stairs-combo-senior"
    });

    const body = createIssueDirectMock.mock.calls[0]?.[2]?.body;
    expect(typeof body).toBe("string");
    expect(body).toContain(
      "- **Live URL**: https://catsluvus.com/cat-stairs-and-steps-for-senior-cats-with-arthritis/indoor-cat-ramp-stairs-combo-senior"
    );
    expect(body).not.toContain("indoor-cat-ramp-stairs-combo-senior-extra");
  });

  it("falls back to the kvKey-derived live URL when publish metadata points at a different article", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    };
    const agent = {
      envBindings: {
        GITHUB_TOKEN_SECRET: "token",
        ARTICLES_KV: kv
      },
      log: vi.fn()
    };

    await triggerCodebaseImprovement(agent as unknown as SEOArticleAgent, {
      kvKey:
        "cat-window-perches-for-apartment-living:window-mounted-cat-hammock",
      keyword: "window mounted cat hammock",
      categorySlug: "cat-window-perches-for-apartment-living",
      articleUrl:
        "https://catsluvus.com/cat-window-perches-for-apartment-living/another-window-perch"
    });

    const body = createIssueDirectMock.mock.calls[0]?.[2]?.body;
    expect(typeof body).toBe("string");
    expect(body).toContain(
      "- **Live URL**: https://catsluvus.com/cat-window-perches-for-apartment-living/window-mounted-cat-hammock"
    );
    expect(body).not.toContain(
      "https://catsluvus.com/cat-window-perches-for-apartment-living/another-window-perch"
    );

    const logMessages = agent.log.mock.calls.map((call) => String(call[1]));
    expect(
      logMessages.some((msg) => msg.includes("did not match kvKey-derived URL"))
    ).toBe(true);
  });
});
