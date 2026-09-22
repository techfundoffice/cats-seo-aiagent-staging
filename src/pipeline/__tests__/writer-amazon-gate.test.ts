import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SEOArticleAgent } from "../../server";
import { fetchViaApify, fetchViaCreatorsApi } from "../amazon";
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
    fetchViaCreatorsApi: vi.fn(async () => []),
    fetchViaApify: vi.fn(async () => [])
  };
});

const PA_API_LOG = /PA API|paapi5|webservices\.amazon\.com|UnrecognizedClient/;

function agent(env: Record<string, unknown> = {}): {
  agent: SEOArticleAgent;
  puts: string[];
  logs: string[];
} {
  const puts: string[] = [];
  const logs: string[] = [];
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
    log: (_level: string, msg: string) => {
      logs.push(msg);
    },
    updateStep: () => undefined,
    setCurrentCompetitorUrl: () => undefined,
    ingestDebugLog: () => undefined,
    sql: () => [],
    waitUntil: () => undefined,
    state: {}
  };
  return { agent: stub as unknown as SEOArticleAgent, puts, logs };
}

describe("generateArticle Amazon product gate", () => {
  beforeEach(() => {
    vi.mocked(runKimiWithPoll).mockClear();
    vi.mocked(fetchViaCreatorsApi).mockReset();
    vi.mocked(fetchViaCreatorsApi).mockResolvedValue([]);
    vi.mocked(fetchViaApify).mockReset();
    vi.mocked(fetchViaApify).mockResolvedValue([]);
  });

  it("fails before prose, HTML, or KV publish when Creators and Apify are empty", async () => {
    const {
      agent: stub,
      puts,
      logs
    } = agent({
      AMAZON_APP_ID: "amzn1.application.test",
      AMAZON_API_SECRET: "secret",
      AMAZON_ACCESS_KEY: "AKIA_TEST",
      AMAZON_SECRET_KEY: "pa-secret",
      AMAZON_ACCESS_KEY_FALLBACK: "AKIA_FALLBACK",
      AMAZON_SECRET_KEY_FALLBACK: "pa-fallback-secret"
    });
    const result = await generateArticle(
      stub,
      "dashboard refill cat toy",
      "dashboard-refill-cat-toy",
      "cat-toys"
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(NO_AMAZON_PRODUCTS_ABORT_MESSAGE);
    expect(fetchViaCreatorsApi).toHaveBeenCalled();
    expect(fetchViaApify).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/Creators API\): 0 products/);
    expect(logs.join("\n")).not.toMatch(PA_API_LOG);
    expect(runKimiWithPoll).not.toHaveBeenCalled();
    expect(puts).not.toContain("cat-toys:dashboard-refill-cat-toy");
    expect(puts.some((key) => key.startsWith("kimi-raw:"))).toBe(false);
  });

  it("fails when Creators returns rows with no real ASIN and does not call PA-API", async () => {
    vi.mocked(fetchViaCreatorsApi).mockResolvedValue([
      {
        name: "Keyword Placeholder",
        displayName: "Keyword Placeholder",
        source: "creators-api"
      }
    ]);
    const {
      agent: stub,
      puts,
      logs
    } = agent({
      AMAZON_APP_ID: "amzn1.application.test",
      AMAZON_API_SECRET: "secret",
      AMAZON_ACCESS_KEY: "AKIA_TEST",
      AMAZON_SECRET_KEY: "pa-secret"
    });
    const result = await generateArticle(
      stub,
      "cat toy",
      "cat-toy",
      "cat-toys"
    );
    expect(fetchViaCreatorsApi).toHaveBeenCalled();
    expect(fetchViaApify).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toMatch(PA_API_LOG);
    expect(result.success).toBe(false);
    expect(result.error).toBe(NO_AMAZON_PRODUCTS_ABORT_MESSAGE);
    expect(runKimiWithPoll).not.toHaveBeenCalled();
    expect(puts).not.toContain("cat-toys:cat-toy");
    expect(puts.some((key) => key.startsWith("kimi-raw:"))).toBe(false);
  });

  it("uses Apify only after Creators returns empty, still without PA-API", async () => {
    const { agent: stub, logs } = agent({
      AMAZON_APP_ID: "amzn1.application.test",
      AMAZON_API_SECRET: "secret",
      AMAZON_ACCESS_KEY: "AKIA_TEST",
      AMAZON_SECRET_KEY: "pa-secret",
      APIFY_TOKEN: "apify-token-test"
    });
    const result = await generateArticle(
      stub,
      "cat toy",
      "cat-toy",
      "cat-toys"
    );
    expect(fetchViaCreatorsApi).toHaveBeenCalled();
    expect(fetchViaApify).toHaveBeenCalledWith(
      "cat toy",
      "apify-token-test",
      "catsluvus03-20",
      expect.any(Function)
    );
    expect(logs.join("\n")).toMatch(/Creators API\): 0 products/);
    expect(logs.join("\n")).not.toMatch(PA_API_LOG);
    expect(result.success).toBe(false);
    expect(result.error).toBe(NO_AMAZON_PRODUCTS_ABORT_MESSAGE);
  });
});
