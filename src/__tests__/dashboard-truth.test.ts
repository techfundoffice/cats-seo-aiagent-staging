import { describe, expect, it } from "vitest";
import {
  CLAUDE_FAILURE_NO_FALLBACK,
  assessObserverNarrativeTrust,
  deriveDependencyChips,
  deriveOperatorRunPresentation,
  formatDashboardFreshness,
  formatSeoPillarRows,
  latestObserverNarrativeRaw,
  parseObserverNarrative,
  partitionEditorialReasonCounts
} from "../dashboardTruth";

describe("deriveOperatorRunPresentation", () => {
  it("calls a quiet worker idle", () => {
    const run = deriveOperatorRunPresentation({
      status: "idle",
      currentStep: null
    });
    expect(run.kind).toBe("idle");
    expect(run.label).toBe("IDLE");
  });

  it("does not call a frozen mid-pipeline step idle", () => {
    const run = deriveOperatorRunPresentation({
      status: "idle",
      currentStep: "7/24: AI Writing"
    });
    expect(run.kind).toBe("stuck");
    expect(run.label).not.toMatch(/idle/i);
    expect(run.detail).toMatch(/not idle/);
  });

  it("treats Complete as finished, not stuck", () => {
    expect(
      deriveOperatorRunPresentation({
        status: "idle",
        currentStep: "Complete"
      }).kind
    ).toBe("idle");
  });

  it("keeps an in-flight generate as running", () => {
    const run = deriveOperatorRunPresentation({
      status: "generating",
      currentStep: "12/24: SEO score"
    });
    expect(run.kind).toBe("running");
    expect(run.detail).toMatch(/SEO score/);
  });

  it("separates a manual pause from idle and from a Claude failure", () => {
    expect(
      deriveOperatorRunPresentation({ status: "paused", currentStep: null })
        .kind
    ).toBe("paused");
    const failed = deriveOperatorRunPresentation({
      status: "paused",
      currentStep: null,
      claudeChatFailure: { message: "Worker timed out during Claude writing." }
    });
    expect(failed.kind).toBe("failed");
    expect(failed.detail).toMatch(/No other chat model/);
  });
});

describe("formatDashboardFreshness", () => {
  it("names last activity and a fresh state push", () => {
    const freshness = formatDashboardFreshness({
      lastActivity: "09/21/2026 16:21:32",
      stateAgeMs: 30_000
    });
    expect(freshness.activityLine).toBe("Last activity 09/21/2026 16:21:32");
    expect(freshness.stateLine).toBe("Dashboard state updated 30s ago");
    expect(freshness.stale).toBe(false);
  });

  it("marks a long-silent state push as stale", () => {
    const freshness = formatDashboardFreshness({
      lastActivity: "09/21/2026 16:21:32",
      stateAgeMs: 21 * 60 * 1000
    });
    expect(freshness.stale).toBe(true);
    expect(freshness.stateLine).toMatch(/stale/);
  });
});

describe("partitionEditorialReasonCounts", () => {
  it("hides obsolete OpenRouter credit skips and relabels Claude audit keys", () => {
    const out = partitionEditorialReasonCounts({
      "kimi-credits-exhausted-precheck": 256,
      "kimi-credits-exhausted": 4,
      "no-actionable-fixes": 26,
      "kimi-audit-partial-fail": 3
    });
    expect(out.hiddenHistoricalCreditSkips).toBe(260);
    expect(out.visible.map((row) => row.reason)).toEqual([
      "no-actionable-fixes",
      "kimi-audit-partial-fail"
    ]);
    expect(out.visible[1]?.label).toMatch(/Claude audit partial fail/);
    expect(out.visible[1]?.label).not.toMatch(
      /OpenRouter credits are exhausted/
    );
  });
});

describe("observer narrative trust", () => {
  it("treats a Kimi OAuth fallback as untrusted, not healthy", () => {
    const raw =
      "Observer (Kimi): HEADLINE: Observer fallback — Kimi unavailable (OAuth access token is invalid.) | STATUS: yellow | WHAT'S HAPPENING: Snapshot only";
    const trust = assessObserverNarrativeTrust(raw);
    expect(trust.trust).toBe("untrusted");
    expect(trust.tier).toBe("red");
    expect(trust.howToFix).toMatch(/Claude only/);
    const parsed = parseObserverNarrative(raw);
    expect(parsed?.status).toBe("yellow");
    expect(parsed?.trust.tier).toBe("red");
  });

  it("trusts a Claude narrative even when pipeline STATUS is red", () => {
    const raw =
      "Observer (Claude): HEADLINE: Pipeline stalled | STATUS: red | WHAT'S HAPPENING: Scout database is empty | WHAT'S NOT HAPPENING (but should be): editorial loop | RECOMMENDED ACTION: import keywords";
    const parsed = parseObserverNarrative(raw);
    expect(parsed?.trust.trust).toBe("trusted");
    expect(parsed?.trust.tier).toBe("green");
    expect(parsed?.status).toBe("red");
    expect(parsed?.headline).toBe("Pipeline stalled");
  });

  it("reads emoji status words and markdown labels", () => {
    const parsed = parseObserverNarrative(
      "Observer (Claude): **HEADLINE:** Worker idle | **STATUS:** 🟡 yellow | **WHAT'S HAPPENING:** | The pipeline is quiet"
    );
    expect(parsed?.headline).toBe("Worker idle");
    expect(parsed?.status).toBe("yellow");
    expect(parsed?.whatsHappening).toBe("The pipeline is quiet");
  });

  it("ignores score-distribution meta lines when picking the latest narrative", () => {
    const raw = latestObserverNarrativeRaw([
      {
        msg: "Observer (Kimi): HEADLINE: Old | STATUS: green | WHAT'S HAPPENING: x"
      },
      { msg: "Observer: Score distribution (n=50): median=91" },
      {
        msg: "Observer (Claude): HEADLINE: Current | STATUS: red | WHAT'S HAPPENING: y"
      }
    ]);
    expect(raw).toMatch(/Current/);
    expect(parseObserverNarrative("Observer: Score distribution (n=50)")).toBe(
      null
    );
  });

  it("marks a Claude fallback narrative as amber, not a model switch", () => {
    const trust = assessObserverNarrativeTrust(
      "Observer (Claude): HEADLINE: Observer fallback — Claude unavailable (429) | STATUS: yellow | WHAT'S HAPPENING: counters only"
    );
    expect(trust.trust).toBe("fallback");
    expect(trust.tier).toBe("amber");
    expect(trust.howToFix).toMatch(/no other chat model/i);
  });
});

describe("formatSeoPillarRows", () => {
  it("renders passed/total for each pillar", () => {
    expect(
      formatSeoPillarRows({
        "I. Proof of Experience": { passed: 18, total: 20 },
        "V. Technical UX": { passed: 20, total: 25 }
      }).map((row) => row.label)
    ).toEqual(["18/20", "20/25"]);
  });
});

describe("deriveDependencyChips", () => {
  it("shows Claude active, quiet research, and an untrusted observer", () => {
    const chips = deriveDependencyChips({
      claudeConfigured: true,
      claudeActive: true,
      claudeUiStatus: "active",
      providers: [
        {
          id: "dataforseo",
          tier: "ok",
          evidence: "0 ranked-keywords HTTP 402"
        }
      ],
      observerRaw:
        "Observer (Kimi): HEADLINE: down | STATUS: yellow | WHAT'S HAPPENING: OAuth access token is invalid"
    });
    expect(chips.map((chip) => [chip.id, chip.tier])).toEqual([
      ["claude", "green"],
      ["research", "green"],
      ["observer", "red"]
    ]);
    expect(chips[0]?.detail).toMatch(/Only chat and vision/);
  });

  it("turns Claude red when the failure banner is set", () => {
    const chips = deriveDependencyChips({
      claudeConfigured: true,
      claudeActive: true,
      claudeUiStatus: "active",
      claudeFailureMessage: "Worker timed out during Claude writing.",
      providers: [],
      observerRaw: null
    });
    expect(chips[0]?.tier).toBe("red");
    expect(chips[0]?.detail).toMatch(/No fallback/);
    expect(CLAUDE_FAILURE_NO_FALLBACK).toMatch(/Nothing switches/);
  });

  it("turns DataForSEO amber on a 402", () => {
    const chips = deriveDependencyChips({
      claudeConfigured: true,
      claudeActive: true,
      claudeUiStatus: "active",
      providers: [
        {
          id: "dataforseo",
          tier: "degraded",
          evidence: "1 ranked-keywords HTTP 402 (paid tier quota)"
        }
      ],
      observerRaw:
        "Observer (Claude): HEADLINE: ok | STATUS: green | WHAT'S HAPPENING: fine"
    });
    expect(chips.find((chip) => chip.id === "research")?.tier).toBe("amber");
  });
});
