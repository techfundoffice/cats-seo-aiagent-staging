import { describe, expect, it } from "vitest";
import {
  FRESH_WINDOW_MS,
  aggregateOpenAiCalls,
  classifyFeedStatus,
  estimateOpenAiCostUsd,
  formatUsdCompact,
  parseMilvusActivityMsg,
  parseOpenAiActivityMsg
} from "../infra-activity-monitor";

describe("classifyFeedStatus", () => {
  const NOW = new Date("2026-06-01T16:30:00Z");

  it("returns 'unknown' when there are no events", () => {
    expect(classifyFeedStatus(null, NOW)).toBe("unknown");
  });

  it("returns 'red' when the newest event is an error (regardless of age)", () => {
    expect(
      classifyFeedStatus(
        {
          timestamp: new Date("2026-06-01T16:29:00Z"),
          isError: true
        },
        NOW
      )
    ).toBe("red");
    // Even a stale error still flags red.
    expect(
      classifyFeedStatus(
        {
          timestamp: new Date("2026-06-01T15:00:00Z"),
          isError: true
        },
        NOW
      )
    ).toBe("red");
  });

  it("returns 'green' when the newest event is recent (≤5 min) and non-error", () => {
    expect(
      classifyFeedStatus(
        {
          timestamp: new Date("2026-06-01T16:28:00Z"),
          isError: false
        },
        NOW
      )
    ).toBe("green");
  });

  it("returns 'yellow' when the newest event is non-error but >5 min old", () => {
    expect(
      classifyFeedStatus(
        {
          timestamp: new Date("2026-06-01T16:20:00Z"),
          isError: false
        },
        NOW
      )
    ).toBe("yellow");
  });

  it("treats exact boundary (== FRESH_WINDOW_MS) as fresh", () => {
    const exactlyFresh = new Date(NOW.getTime() - FRESH_WINDOW_MS);
    expect(
      classifyFeedStatus({ timestamp: exactlyFresh, isError: false }, NOW)
    ).toBe("green");
  });

  it("accepts ISO string timestamps", () => {
    expect(
      classifyFeedStatus(
        {
          timestamp: "2026-06-01T16:29:30Z",
          isError: false
        },
        NOW
      )
    ).toBe("green");
  });

  it("returns 'unknown' for an unparseable timestamp", () => {
    expect(
      classifyFeedStatus({ timestamp: "not-a-date", isError: false }, NOW)
    ).toBe("unknown");
  });
});

describe("estimateOpenAiCostUsd", () => {
  it("computes the embedding-small cost correctly ($0.02 per 1M)", () => {
    // 1,000,000 tokens × $0.02 / 1M = $0.02 exactly
    expect(
      estimateOpenAiCostUsd("text-embedding-3-small", 1_000_000)
    ).toBeCloseTo(0.02, 10);
    // 1,000 tokens × $0.02 / 1M = $0.00002
    expect(estimateOpenAiCostUsd("text-embedding-3-small", 1000)).toBeCloseTo(
      0.00002,
      10
    );
  });

  it("computes gpt-4o input + output separately", () => {
    // 100k input × $5/1M + 50k output × $15/1M = $0.5 + $0.75 = $1.25
    expect(estimateOpenAiCostUsd("gpt-4o", 100_000, 50_000)).toBeCloseTo(
      1.25,
      10
    );
  });

  it("returns 0 for an unknown model (never NaN)", () => {
    expect(estimateOpenAiCostUsd("model-that-does-not-exist", 1_000_000)).toBe(
      0
    );
  });

  it("ignores negative token counts (clamped to 0)", () => {
    expect(estimateOpenAiCostUsd("text-embedding-3-small", -100, -100)).toBe(0);
  });

  it("supports embedding-only models with completion=0", () => {
    expect(
      estimateOpenAiCostUsd("text-embedding-3-small", 5000, 0)
    ).toBeGreaterThan(0);
  });
});

describe("aggregateOpenAiCalls", () => {
  it("returns zeros for an empty input list", () => {
    const r = aggregateOpenAiCalls([]);
    expect(r).toEqual({
      calls: 0,
      errorCalls: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      estimatedUsdTotal: 0
    });
  });

  it("sums tokens + cost across multiple calls", () => {
    const r = aggregateOpenAiCalls([
      {
        model: "text-embedding-3-small",
        promptTokens: 1000,
        completionTokens: 0,
        isError: false
      },
      {
        model: "text-embedding-3-small",
        promptTokens: 2000,
        completionTokens: 0,
        isError: false
      },
      {
        model: "gpt-4o-mini",
        promptTokens: 500,
        completionTokens: 200,
        isError: true
      }
    ]);
    expect(r.calls).toBe(3);
    expect(r.errorCalls).toBe(1);
    expect(r.totalPromptTokens).toBe(3500);
    expect(r.totalCompletionTokens).toBe(200);
    expect(r.estimatedUsdTotal).toBeGreaterThan(0);
  });
});

describe("parseOpenAiActivityMsg", () => {
  it("parses an ok msg with all fields", () => {
    const r = parseOpenAiActivityMsg({
      msg: "[OpenAI embed] model=text-embedding-3-small tokens=1500 latency=234ms status=ok",
      timeDate: "06/01/2026",
      timeTime: "16:43:00"
    });
    expect(r.model).toBe("text-embedding-3-small");
    expect(r.promptTokens).toBe(1500);
    expect(r.latencyMs).toBe(234);
    expect(r.status).toBe("ok");
    expect(r.errorReason).toBeUndefined();
  });

  it("parses an error msg with quoted error text", () => {
    const r = parseOpenAiActivityMsg({
      msg: `[OpenAI embed] model=text-embedding-3-small tokens=0 latency=12ms status=error error="HTTP 429 rate limited"`
    });
    expect(r.status).toBe("error");
    expect(r.errorReason).toBe("HTTP 429 rate limited");
    expect(r.promptTokens).toBe(0);
  });

  it("defaults sensibly for a malformed msg", () => {
    const r = parseOpenAiActivityMsg({ msg: "[OpenAI embed] garbage" });
    expect(r.model).toBe("unknown");
    expect(r.promptTokens).toBe(0);
    expect(r.latencyMs).toBe(0);
    expect(r.status).toBe("ok");
  });

  it("prefers the in-msg ts=<ISO> over LA-local timeDate/timeTime (timezone-safe)", () => {
    const r = parseOpenAiActivityMsg({
      msg: "[OpenAI embed] ts=2026-06-01T16:43:00Z model=text-embedding-3-small tokens=1500 latency=234ms status=ok",
      timeDate: "06/01/2026",
      timeTime: "09:43:00" // intentionally different to prove ts= wins
    });
    expect(r.timestamp).toBe("2026-06-01T16:43:00Z");
  });

  it("falls back to LA-local timestamp when ts= is absent (back-compat)", () => {
    const r = parseOpenAiActivityMsg({
      msg: "[OpenAI embed] model=text-embedding-3-small tokens=100 latency=20ms status=ok",
      timeDate: "06/01/2026",
      timeTime: "09:43:00"
    });
    expect(r.timestamp).toBe("06/01/2026 09:43:00");
  });

  it("falls back to LA-local when ts= is not a valid date", () => {
    const r = parseOpenAiActivityMsg({
      msg: "[OpenAI embed] ts=not-an-iso model=foo tokens=0 latency=0ms status=ok",
      timeDate: "06/01/2026",
      timeTime: "09:43:00"
    });
    expect(r.timestamp).toBe("06/01/2026 09:43:00");
  });
});

describe("parseMilvusActivityMsg", () => {
  it("parses an ok msg with collection + hits + latency", () => {
    const r = parseMilvusActivityMsg({
      msg: "[Milvus search] collection=code_chunks hits=8 latency=45ms status=ok"
    });
    expect(r.collection).toBe("code_chunks");
    expect(r.hits).toBe(8);
    expect(r.latencyMs).toBe(45);
    expect(r.status).toBe("ok");
  });

  it("parses error rows", () => {
    const r = parseMilvusActivityMsg({
      msg: `[Milvus search] collection=code_chunks hits=0 latency=8ms status=error error="HTTP 404 collection not found"`
    });
    expect(r.status).toBe("error");
    expect(r.errorReason).toContain("404");
  });
});

describe("formatUsdCompact", () => {
  it("uses 4 decimals for sub-$1 values", () => {
    expect(formatUsdCompact(0.00002)).toBe("$0.0000");
    expect(formatUsdCompact(0.42)).toBe("$0.4200");
    expect(formatUsdCompact(0.999)).toBe("$0.9990");
  });

  it("uses 2 decimals for ≥$1 values", () => {
    expect(formatUsdCompact(1)).toBe("$1.00");
    expect(formatUsdCompact(12.5)).toBe("$12.50");
    expect(formatUsdCompact(100.123)).toBe("$100.12");
  });
});
