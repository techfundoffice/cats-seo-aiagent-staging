import { describe, expect, it, vi } from "vitest";
import {
  buildEmbeddingRequest,
  buildMilvusSearchRequest,
  getMissingCodebaseSearchVars,
  indexCodebase,
  isCodebaseSearchEnabled,
  parseMilvusSearchResponse,
  searchCodebase
} from "../codebase-search";

describe("getMissingCodebaseSearchVars", () => {
  it("flags every required var when none are set", () => {
    expect(getMissingCodebaseSearchVars({})).toEqual([
      "OPENAI_API_KEY",
      "MILVUS_ADDRESS",
      "MILVUS_TOKEN"
    ]);
  });

  it("returns empty list when all three are set", () => {
    expect(
      getMissingCodebaseSearchVars({
        OPENAI_API_KEY: "sk-x",
        MILVUS_ADDRESS: "https://zilliz",
        MILVUS_TOKEN: "tok"
      })
    ).toEqual([]);
  });

  it("treats whitespace-only values as missing", () => {
    expect(
      getMissingCodebaseSearchVars({
        OPENAI_API_KEY: "  ",
        MILVUS_ADDRESS: "https://zilliz",
        MILVUS_TOKEN: "tok"
      })
    ).toContain("OPENAI_API_KEY");
  });
});

describe("isCodebaseSearchEnabled", () => {
  it("is false even with all three vars present — the OpenAI embeddings provider is switched off", () => {
    // Claude is the only model provider in this repo and Anthropic has no
    // embeddings API, so semantic search is disabled rather than migrated.
    // Asserted with the keys PRESENT so a stray OPENAI_API_KEY cannot quietly
    // reintroduce a second provider.
    expect(
      isCodebaseSearchEnabled({
        OPENAI_API_KEY: "x",
        MILVUS_ADDRESS: "y",
        MILVUS_TOKEN: "z"
      })
    ).toBe(false);
  });

  it("false when any missing", () => {
    expect(
      isCodebaseSearchEnabled({
        OPENAI_API_KEY: "x",
        MILVUS_ADDRESS: "y"
      })
    ).toBe(false);
  });
});

describe("buildEmbeddingRequest", () => {
  it("targets OpenAI v1/embeddings and sends model + input", () => {
    const r = buildEmbeddingRequest("how does keyword density work");
    expect(r.url).toBe("https://api.openai.com/v1/embeddings");
    const body = JSON.parse(r.body) as {
      model: string;
      input: string;
    };
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toBe("how does keyword density work");
  });
});

describe("buildMilvusSearchRequest", () => {
  it("strips trailing slash on address and posts to v1/vector/search", () => {
    const r = buildMilvusSearchRequest(
      "https://in03.zilliz.com/",
      "code_chunks",
      [0.1, 0.2, 0.3],
      5
    );
    expect(r.url).toBe("https://in03.zilliz.com/v1/vector/search");
    const body = JSON.parse(r.body) as {
      collectionName: string;
      vector: number[];
      limit: number;
      outputFields: string[];
    };
    expect(body.collectionName).toBe("code_chunks");
    expect(body.vector).toEqual([0.1, 0.2, 0.3]);
    expect(body.limit).toBe(5);
    expect(body.outputFields).toContain("filePath");
    expect(body.outputFields).toContain("snippet");
  });
});

describe("parseMilvusSearchResponse", () => {
  it("returns empty array for null / missing data", () => {
    expect(parseMilvusSearchResponse(null)).toEqual([]);
    expect(parseMilvusSearchResponse({})).toEqual([]);
    expect(parseMilvusSearchResponse({ data: "nope" })).toEqual([]);
  });

  it("maps Zilliz REST response into typed hits", () => {
    const hits = parseMilvusSearchResponse({
      data: [
        {
          filePath: "src/pipeline/writer.ts",
          startLine: 100,
          endLine: 120,
          language: "typescript",
          snippet: "function buildArticle()",
          score: 0.87
        },
        {
          filePath: "src/pipeline/seo-score.ts",
          startLine: 200,
          endLine: 210,
          language: "typescript",
          snippet: "// keyword density check",
          distance: 0.12
        }
      ]
    });
    expect(hits).toHaveLength(2);
    expect(hits[0].filePath).toBe("src/pipeline/writer.ts");
    expect(hits[0].score).toBe(0.87);
    // distance fallback when no score
    expect(hits[1].score).toBe(0.12);
  });

  it("drops rows missing filePath or snippet", () => {
    const hits = parseMilvusSearchResponse({
      data: [
        { filePath: "a.ts", snippet: "x" },
        { filePath: "b.ts" }, // missing snippet
        { snippet: "no-path" }, // missing filePath
        null
      ]
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].filePath).toBe("a.ts");
  });
});

describe("searchCodebase — disabled (no OpenAI provider)", () => {
  // These used to exercise the live embed-then-vector-search path. That path
  // called OpenAI, which is no longer a provider in this repo, so the contract
  // is now "always unavailable, and never makes a network call".
  const FULL_ENV = {
    OPENAI_API_KEY: "sk-test",
    MILVUS_ADDRESS: "https://milvus.example",
    MILVUS_TOKEN: "tok"
  };

  it("returns unavailable with an explanatory reason even when every var is set", async () => {
    const res = await searchCodebase(FULL_ENV, "how does the writer work?");
    expect(res.available).toBe(false);
    expect(res.hits).toEqual([]);
    expect(res.reason).toMatch(/disabled/i);
    expect(res.reason).toMatch(/embeddings/i);
  });

  it("makes NO http request — this is what keeps OpenAI off the bill", async () => {
    const fetchSpy = vi.fn();
    await searchCodebase(
      FULL_ENV,
      "anything",
      8,
      fetchSpy as unknown as typeof fetch
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays unavailable for an empty query and with vars missing", async () => {
    const fetchSpy = vi.fn();
    for (const env of [FULL_ENV, {}]) {
      for (const q of ["", "  ", "real query"]) {
        const res = await searchCodebase(
          env,
          q,
          8,
          fetchSpy as unknown as typeof fetch
        );
        expect(res.available).toBe(false);
        expect(res.hits).toEqual([]);
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("indexCodebase", () => {
  it("is a no-op stub explaining why in-worker indexing isn't available", async () => {
    const r = await indexCodebase();
    expect(r.triggered).toBe(false);
    expect(r.reason).toContain("CF Workers");
    expect(r.reason).toContain("scripts/index-codebase.mjs");
  });
});
