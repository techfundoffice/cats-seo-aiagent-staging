import { describe, expect, it } from "vitest";
import {
  computeKimiProviderHealth,
  isKimiCurrentlyDegraded
} from "../kimiProviderHealth";

// Pure derivation from the activity-log buffer. Keeps the dashboard
// banner's classification testable without an end-to-end React render.

const makeEntry = (msg: string) => ({ msg });

describe("computeKimiProviderHealth — tiers", () => {
  it("empty log → ok", () => {
    expect(computeKimiProviderHealth([])).toEqual({
      tier: "ok",
      openrouterFailures: 0,
      creditsExhaustedHits: 0
    });
  });

  it("no kimi-model entries → ok", () => {
    const log = [
      makeEntry("Editorial Agent [step 4/4]: rewriting article"),
      makeEntry("step 8 Article URL: https://catsluvus.com/x"),
      makeEntry("Observer (Kimi): HEADLINE: …")
    ];
    expect(computeKimiProviderHealth(log).tier).toBe("ok");
  });

  it("non-credit OpenRouter failure → degraded (yellow)", () => {
    const log = [
      makeEntry(
        "[kimi-model] OpenRouter call failed (AbortError); falling back to Workers AI"
      )
    ];
    const out = computeKimiProviderHealth(log);
    expect(out.tier).toBe("degraded");
    expect(out.openrouterFailures).toBe(1);
    expect(out.creditsExhaustedHits).toBe(0);
  });

  it("under the threshold of credit-exhausted hits → degraded", () => {
    const log = Array.from({ length: 4 }, () =>
      makeEntry(
        "[kimi-model] OpenRouter call failed (This request requires more credits, or fewer max_tokens. You requested up to 2048 tokens, but can only afford 317.); falling back to Workers AI"
      )
    );
    const out = computeKimiProviderHealth(log);
    expect(out.tier).toBe("degraded");
    expect(out.creditsExhaustedHits).toBe(4);
  });

  it("at the threshold (5) → exhausted (red)", () => {
    const log = Array.from({ length: 5 }, () =>
      makeEntry(
        "[kimi-model] OpenRouter call failed (This request requires more credits, or fewer max_tokens. You requested up to 2048 tokens, but can only afford 317.); falling back to Workers AI"
      )
    );
    const out = computeKimiProviderHealth(log);
    expect(out.tier).toBe("exhausted");
    expect(out.creditsExhaustedHits).toBe(5);
  });

  it("mixes count toward the right buckets", () => {
    const log = [
      makeEntry(
        "[kimi-model] OpenRouter call failed (AbortError); falling back to Workers AI"
      ),
      makeEntry(
        "[kimi-model] OpenRouter call failed (This request requires more credits); falling back to Workers AI"
      ),
      makeEntry(
        "[kimi-model] OpenRouter call failed (can only afford 12); falling back to Workers AI"
      ),
      makeEntry("Editorial Agent: success")
    ];
    const out = computeKimiProviderHealth(log);
    expect(out.openrouterFailures).toBe(3);
    expect(out.creditsExhaustedHits).toBe(2);
    expect(out.tier).toBe("degraded");
  });
});

describe("computeKimiProviderHealth — defensive", () => {
  it("entries with missing msg field don't crash", () => {
    const log = [
      makeEntry("[kimi-model] OpenRouter call failed (whatever)"),
      { msg: undefined } as { msg?: string },
      {} as { msg?: string }
    ];
    const out = computeKimiProviderHealth(log);
    expect(out.openrouterFailures).toBe(1);
    expect(out.tier).toBe("degraded");
  });

  it("only matches the canonical kimi-model prefix, not free text mentioning openrouter", () => {
    const log = [
      makeEntry("https://openrouter.ai/settings/credits — manual visit"),
      makeEntry("openrouter says hi")
    ];
    expect(computeKimiProviderHealth(log).tier).toBe("ok");
  });

  it("ignores non-failure OpenRouter status lines", () => {
    const log = [
      makeEntry("[kimi-model] OpenRouter healthcheck ok"),
      makeEntry("[kimi-model] OpenRouter credits refreshed successfully")
    ];
    expect(computeKimiProviderHealth(log)).toEqual({
      tier: "ok",
      openrouterFailures: 0,
      creditsExhaustedHits: 0
    });
  });
});

// ── isKimiCurrentlyDegraded ───────────────────────────────────────────
// Precheck used by runEditorialAgent to short-circuit Kimi-dependent
// work BEFORE the call. Threshold is intentionally lower than the
// "exhausted" banner tier so we save compute as soon as the pattern
// is unambiguous, not after the situation is already red.

describe("isKimiCurrentlyDegraded", () => {
  const exhausted = (msg = "test"): { msg?: string } => ({
    msg: `[kimi-model] OpenRouter call failed (This request requires more credits, ${msg}); falling back to Workers AI`
  });
  const benign = (msg = "test"): { msg?: string } => ({
    msg: `[kimi-model] OpenRouter call failed (${msg}); falling back to Workers AI`
  });

  it("empty log → not degraded (don't block first call)", () => {
    expect(isKimiCurrentlyDegraded([])).toBe(false);
  });

  it("1 credit-exhausted hit → not degraded yet", () => {
    expect(isKimiCurrentlyDegraded([exhausted()])).toBe(false);
  });

  it("2 credit-exhausted hits → not degraded yet", () => {
    expect(isKimiCurrentlyDegraded([exhausted(), exhausted()])).toBe(false);
  });

  it("3 credit-exhausted hits → degraded (precheck threshold)", () => {
    expect(
      isKimiCurrentlyDegraded([exhausted(), exhausted(), exhausted()])
    ).toBe(true);
  });

  it("many non-credit failures alone do NOT trip the precheck", () => {
    // We want to skip on the BILLING wall specifically, not on transient
    // provider errors (which Workers AI fallback may still recover from).
    const log = Array.from({ length: 10 }, () => benign());
    expect(isKimiCurrentlyDegraded(log)).toBe(false);
  });

  it("missing msg fields don't crash", () => {
    const log = [
      exhausted(),
      { msg: undefined } as { msg?: string },
      exhausted(),
      {} as { msg?: string },
      exhausted()
    ];
    expect(isKimiCurrentlyDegraded(log)).toBe(true);
  });
});
