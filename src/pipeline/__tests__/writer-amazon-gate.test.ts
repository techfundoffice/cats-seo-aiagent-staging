import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SEOArticleAgent } from "../../server";
import { fetchViaPaApi } from "../amazon";
import { runKimiWithPoll } from "../kimi-model";
import { NO_AMAZON_PRODUCTS_ABORT_MESSAGE } from "../product-write-gate";
import { generateArticle } from "../writer";

vi.mock("../kimi-model", async () => {
  const actual =
    await vi.importActual<typeof import("../kimi-model")>("../kimi-model");
  return {
    ...actual,
    runKimiWithPoll: vi.fn(async () => {
      throw new Error("article prose must not run without an Amazon ASIN");
    })
  };
});

vi.mock("../amazon", async () => {
  const actual = await vi.importActual<typeof import("../amazon")>("../amazon");
  return {
    ...actual,
    fetchViaPaApi: vi.fn(async () => []),
    fetchViaCreatorsApi: vi.fn(async () => []),
    fetchViaApify: vi.fn(async () => [])
  };
});

function agent(env: Record<string, unknown> = {}): {
  agent: SEOArticleAgent;
  puts: string[];
} {
  const puts: string[] = [];
  const stub = {
    envBindings: {
      DOMAIN: "staging.example",
      AMAZON_AFFILIATE_TAG: "catsluvus03-20",
      ARTICLES_KV: {
        get: async () => null,
        put: async (key: string) => {
          puts.push(key);
        }
      },
      ...env
    },
    log: () => undefined,
    updateStep: () => undefined,
    setCurrentCompetitorUrl: () => undefined,
    ingestDebugLog: () => undefined,
    sql: () => [],
    waitUntil: () => undefined,
    state: {}
  };
  return { agent: stub as unknown as SEOArticleAgent, puts };
}

describe("generateArticle Amazon product gate", () => {
  beforeEach(() => {
    vi.mocked(runKimiWithPoll).mockClear();
    vi.mocked(fetchViaPaApi).mockReset();
    vi.mocked(fetchViaPaApi).mockResolvedValue([]);
  });

  it("fails before prose, HTML, or KV publish when every Amazon tier is empty", async () => {
    const { agent: stub, puts } = agent();
    const result = await generateArticle(
      stub,
      "dashboard refill cat toy",
      "dashboard-refill-cat-toy",
      "cat-toys"
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(NO_AMAZON_PRODUCTS_ABORT_MESSAGE);
    expect(runKimiWithPoll).not.toHaveBeenCalled();
    expect(puts).not.toContain("cat-toys:dashboard-refill-cat-toy");
    expect(puts.some((key) => key.startsWith("kimi-raw:"))).toBe(false);
  });

  it("fails when Amazon returns rows with no real ASIN", async () => {
    vi.mocked(fetchViaPaApi).mockResolvedValue([
      {
        name: "Keyword Placeholder",
        displayName: "Keyword Placeholder",
        source: "pa-api-v5"
      }
    ]);
    const { agent: stub, puts } = agent({
      AMAZON_ACCESS_KEY: "AKIA_TEST",
      AMAZON_SECRET_KEY: "secret"
    });
    const result = await generateArticle(
      stub,
      "cat toy",
      "cat-toy",
      "cat-toys"
    );
    expect(fetchViaPaApi).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe(NO_AMAZON_PRODUCTS_ABORT_MESSAGE);
    expect(runKimiWithPoll).not.toHaveBeenCalled();
    expect(puts).not.toContain("cat-toys:cat-toy");
    expect(puts.some((key) => key.startsWith("kimi-raw:"))).toBe(false);
  });
});
