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
  it("true when all three present", () => {
    expect(
      isCodebaseSearchEnabled({
        OPENAI_API_KEY: "x",
        MILVUS_ADDRESS: "y",
        MILVUS_TOKEN: "z"
      })
    ).toBe(true);
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

describe("searchCodebase — graceful degradation", () => {
  it("returns { available: false } with reason when env is missing", async () => {
    const r = await searchCodebase({}, "anything");
    expect(r.available).toBe(false);
    expect(r.hits).toEqual([]);
    expect(r.reason).toContain("missing OPENAI_API_KEY");
  });

  it("returns { available: true, hits: [] } for an empty query (no API call)", async () => {
    const mockFetch = vi.fn();
    const r = await searchCodebase(
      {
        OPENAI_API_KEY: "x",
        MILVUS_ADDRESS: "https://y",
        MILVUS_TOKEN: "z"
      },
      "   ",
      8,
      mockFetch as unknown as typeof fetch
    );
    expect(r.available).toBe(true);
    expect(r.hits).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reports OpenAI HTTP errors without crashing", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    const r = await searchCodebase(
      {
        OPENAI_API_KEY: "x",
        MILVUS_ADDRESS: "https://y",
        MILVUS_TOKEN: "z"
      },
      "find code",
      4,
      mockFetch as unknown as typeof fetch
    );
    expect(r.available).toBe(true);
    expect(r.hits).toEqual([]);
    expect(r.reason).toContain("OpenAI embed HTTP 429");
  });

  it("reports Milvus errors without crashing when embedding succeeds", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response("collection not found", { status: 404 })
      );
    const r = await searchCodebase(
      {
        OPENAI_API_KEY: "x",
        MILVUS_ADDRESS: "https://y",
        MILVUS_TOKEN: "z"
      },
      "find code",
      4,
      mockFetch as unknown as typeof fetch
    );
    expect(r.available).toBe(true);
    expect(r.hits).toEqual([]);
    expect(r.reason).toContain("Milvus search HTTP 404");
  });

  it("returns hits when both calls succeed", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                filePath: "src/pipeline/writer.ts",
                startLine: 100,
                endLine: 120,
                language: "typescript",
                snippet: "function buildArticle()",
                score: 0.92
              }
            ]
          }),
          { status: 200 }
        )
      );
    const r = await searchCodebase(
      {
        OPENAI_API_KEY: "x",
        MILVUS_ADDRESS: "https://y",
        MILVUS_TOKEN: "z"
      },
      "how does article generation work",
      4,
      mockFetch as unknown as typeof fetch
    );
    expect(r.available).toBe(true);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].filePath).toBe("src/pipeline/writer.ts");
    expect(r.hits[0].score).toBe(0.92);
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
