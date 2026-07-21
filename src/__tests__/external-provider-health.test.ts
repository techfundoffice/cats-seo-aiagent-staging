import { describe, expect, it } from "vitest";
import {
  computeExternalProviderHealth,
  degradedProviders
} from "../externalProviderHealth";

// Unified multi-provider health detection. Each known external service
// gets one row regardless of provider — so a future provider added to
// the helper automatically appears in the dashboard without a UI change.

const makeEntry = (msg: string) => ({ msg });

describe("computeExternalProviderHealth — empty log", () => {
  it("all providers ok", () => {
    const out = computeExternalProviderHealth([]);
    expect(out.every((p) => p.tier === "ok")).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

describe("computeExternalProviderHealth — per-provider detection", () => {
  it("Composio 401 ak_ pattern → composio degraded", () => {
    const log = [
      makeEntry(
        'Sheet mirror skipped: 401 {"error":{"message":"Invalid API key: ak_WLlo0*****"}}'
      )
    ];
    const out = computeExternalProviderHealth(log);
    const composio = out.find((p) => p.id === "composio")!;
    expect(composio.tier).toBe("degraded");
    expect(composio.failures).toBe(1);
    expect(composio.remediationUrl).toContain("composio");
  });

  it("DataForSEO HTTP 402 pattern → dataforseo degraded", () => {
    const log = [
      makeEntry(
        "[WARNING] Analytics tick: ranked_keywords failed for x:y: HTTP 402: {body}"
      )
    ];
    const out = computeExternalProviderHealth(log);
    const dfs = out.find((p) => p.id === "dataforseo")!;
    expect(dfs.tier).toBe("degraded");
    expect(dfs.failures).toBe(1);
  });

  it("OpenRouter credit-exhausted shape → kimi exhausted at 5+", () => {
    const log = Array.from({ length: 5 }, () =>
      makeEntry(
        "[kimi-model] OpenRouter call failed (This request requires more credits); falling back to Workers AI"
      )
    );
    const out = computeExternalProviderHealth(log);
    const kimi = out.find((p) => p.id === "kimi")!;
    expect(kimi.tier).toBe("exhausted");
  });

  it("Composio reaches exhausted tier at the 5+ threshold", () => {
    const log = Array.from({ length: 5 }, () =>
      makeEntry(
        'Sheet mirror skipped: 401 {"error":{"message":"Invalid API key: ak_xyz"}}'
      )
    );
    const out = computeExternalProviderHealth(log);
    const composio = out.find((p) => p.id === "composio")!;
    expect(composio.tier).toBe("exhausted");
    expect(composio.failures).toBe(5);
  });

  it("mixed: multiple providers degraded simultaneously", () => {
    const log = [
      makeEntry(
        "[kimi-model] OpenRouter call failed (This request requires more credits); falling back to Workers AI"
      ),
      makeEntry(
        'Sheet mirror skipped: 401 {"error":{"message":"Invalid API key: ak_xyz"}}'
      ),
      makeEntry(
        "[WARNING] Analytics tick: ranked_keywords failed for x:y: HTTP 402: {body}"
      )
    ];
    const out = computeExternalProviderHealth(log);
    expect(out.filter((p) => p.tier !== "ok")).toHaveLength(3);
  });

  it("non-secret prose does not trip any provider", () => {
    const log = [
      makeEntry("Editorial Agent [step 4/4]: rewrite rejected"),
      makeEntry("[INFO] Published https://catsluvus.com/x"),
      makeEntry("Step 14.5: JSON-LD validation passed")
    ];
    const out = computeExternalProviderHealth(log);
    expect(out.every((p) => p.tier === "ok")).toBe(true);
  });

  it("bare Composio key prefix does not count as a real auth failure token", () => {
    const log = [
      makeEntry(
        'Sheet mirror skipped: 401 {"error":{"message":"Invalid API key: ak_"}}'
      )
    ];
    const out = computeExternalProviderHealth(log);
    const composio = out.find((p) => p.id === "composio")!;
    expect(composio.tier).toBe("ok");
    expect(composio.failures).toBe(0);
  });
});

describe("degradedProviders — filtered view for banner", () => {
  it("returns nothing when all green", () => {
    expect(degradedProviders([])).toEqual([]);
  });

  it("returns only providers that have failures", () => {
    const log = [
      makeEntry(
        'Sheet mirror skipped: 401 {"error":{"message":"Invalid API key: ak_xyz"}}'
      )
    ];
    const out = degradedProviders(log);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("composio");
  });

  it("preserves canonical order even when some are filtered", () => {
    const log = [
      makeEntry(
        "[kimi-model] OpenRouter call failed (some msg); falling back to Workers AI"
      ),
      makeEntry(
        "[WARNING] Analytics tick: ranked_keywords failed for x:y: HTTP 402: {body}"
      )
    ];
    const out = degradedProviders(log);
    expect(out.map((p) => p.id)).toEqual(["kimi", "dataforseo"]);
  });
});

describe("computeExternalProviderHealth — defensive", () => {
  it("missing msg fields don't crash", () => {
    const log = [
      makeEntry(
        'Sheet mirror skipped: 401 {"error":{"message":"Invalid API key: ak_xyz"}}'
      ),
      { msg: undefined } as { msg?: string },
      {} as { msg?: string }
    ];
    const out = computeExternalProviderHealth(log);
    const composio = out.find((p) => p.id === "composio")!;
    expect(composio.failures).toBe(1);
  });
});

describe("computeExternalProviderHealth — Amazon + IndexNow patterns", () => {
  it("Amazon Creators API 401 → amazon degraded", () => {
    const log = [
      makeEntry(
        'Amazon (Creators API primary): Creators API: OAuth2 token exchange failed (401 Unauthorized) — {"error_description":"Client authentication failed"}'
      )
    ];
    const out = computeExternalProviderHealth(log);
    const amazon = out.find((p) => p.id === "amazon")!;
    expect(amazon.tier).toBe("degraded");
    expect(amazon.failures).toBe(1);
    expect(amazon.remediation).toMatch(/AMAZON_APP_ID/);
    expect(amazon.remediation).toMatch(/AMAZON_API_SECRET/);
  });

  it("Amazon Client authentication failed (without 401 prefix) → amazon degraded", () => {
    const log = [
      makeEntry(
        'Amazon (Creators API primary): Creators API call returned Client authentication failed — {"error":"invalid_client"}'
      )
    ];
    const out = computeExternalProviderHealth(log);
    const amazon = out.find((p) => p.id === "amazon")!;
    expect(amazon.tier).toBe("degraded");
  });

  it("Amazon reaches exhausted tier at the 5+ threshold", () => {
    const log = Array.from({ length: 5 }, () =>
      makeEntry(
        "Amazon (Creators API primary): Creators API: OAuth2 token exchange failed (401 Unauthorized)"
      )
    );
    const out = computeExternalProviderHealth(log);
    const amazon = out.find((p) => p.id === "amazon")!;
    expect(amazon.tier).toBe("exhausted");
    expect(amazon.failures).toBe(5);
  });

  it("IndexNow 403 UserForbiddedToAccessSite → indexnow degraded", () => {
    const log = [
      makeEntry(
        'IndexNow: 403 for https://catsluvus.com/x: Forbidden — {"errorCode":"UserForbiddedToAccessSite","message":"User is unauthorized to access the site"}'
      )
    ];
    const out = computeExternalProviderHealth(log);
    const indexnow = out.find((p) => p.id === "indexnow")!;
    expect(indexnow.tier).toBe("degraded");
    expect(indexnow.failures).toBe(1);
  });

  it("ordinary IndexNow 200 logs do NOT trip the indexnow detector", () => {
    const log = [
      makeEntry("IndexNow: final ping sent (fully-polished version)")
    ];
    const out = computeExternalProviderHealth(log);
    const indexnow = out.find((p) => p.id === "indexnow")!;
    expect(indexnow.tier).toBe("ok");
  });

  it("all 5 providers detected at once when all degraded", () => {
    const log = [
      makeEntry(
        "[kimi-model] OpenRouter call failed (This request requires more credits); falling back to Workers AI"
      ),
      makeEntry(
        'Sheet mirror skipped: 401 {"error":{"message":"Invalid API key: ak_xyz"}}'
      ),
      makeEntry(
        "[WARNING] Analytics tick: ranked_keywords failed for x:y: HTTP 402: {body}"
      ),
      makeEntry(
        "Amazon (Creators API primary): Creators API: OAuth2 token exchange failed (401 Unauthorized)"
      ),
      makeEntry(
        'IndexNow: 403 for https://catsluvus.com/x: Forbidden — {"errorCode":"UserForbiddedToAccessSite"}'
      )
    ];
    const out = computeExternalProviderHealth(log);
    expect(out.filter((p) => p.tier !== "ok")).toHaveLength(5);
  });
});
