import { describe, expect, it } from "vitest";
import { computeObserverHealth } from "../observerHealth";

// Boundary suite for the panel's "Last observer tick: X min ago" tier
// calculation. Cadence is 15 min; thresholds: <15 green, 15-30 yellow,
// >30 red. Anything missing/unparseable → unknown.

describe("computeObserverHealth — tier boundaries", () => {
  it("0 min → green", () => {
    const r = computeObserverHealth(
      "05/29/2026 13:00:00",
      "05/29/2026 13:00:00"
    );
    expect(r).toEqual({ tier: "green", ageMinutes: 0 });
  });

  it("14 min → green (just below the 15-min threshold)", () => {
    const r = computeObserverHealth(
      "05/29/2026 12:46:00",
      "05/29/2026 13:00:00"
    );
    expect(r).toEqual({ tier: "green", ageMinutes: 14 });
  });

  it("14m59s → green (does not round up into yellow)", () => {
    const r = computeObserverHealth(
      "05/29/2026 12:45:01",
      "05/29/2026 13:00:00"
    );
    expect(r).toEqual({ tier: "green", ageMinutes: 14 });
  });

  it("exactly 15 min → yellow (boundary)", () => {
    const r = computeObserverHealth(
      "05/29/2026 12:45:00",
      "05/29/2026 13:00:00"
    );
    expect(r).toEqual({ tier: "yellow", ageMinutes: 15 });
  });

  it("exactly 30 min → yellow (top of yellow band)", () => {
    const r = computeObserverHealth(
      "05/29/2026 12:30:00",
      "05/29/2026 13:00:00"
    );
    expect(r).toEqual({ tier: "yellow", ageMinutes: 30 });
  });

  it("30m59s → yellow (does not round up into red)", () => {
    const r = computeObserverHealth(
      "05/29/2026 12:29:01",
      "05/29/2026 13:00:00"
    );
    expect(r).toEqual({ tier: "yellow", ageMinutes: 30 });
  });

  it("31 min → red", () => {
    const r = computeObserverHealth(
      "05/29/2026 12:29:00",
      "05/29/2026 13:00:00"
    );
    expect(r).toEqual({ tier: "red", ageMinutes: 31 });
  });

  it("8 min → green (the docstring example)", () => {
    const r = computeObserverHealth(
      "05/29/2026 13:17:00",
      "05/29/2026 13:25:00"
    );
    expect(r).toEqual({ tier: "green", ageMinutes: 8 });
  });
});

describe("computeObserverHealth — defensive cases", () => {
  it("future tick (clock skew) clamps to age 0 / green", () => {
    const r = computeObserverHealth(
      "05/29/2026 13:30:00", // 30 min in the future relative to lastActivity
      "05/29/2026 13:00:00"
    );
    expect(r).toEqual({ tier: "green", ageMinutes: 0 });
  });

  it("missing latestTickRanAt → unknown", () => {
    expect(computeObserverHealth(null, "05/29/2026 13:00:00")).toEqual({
      tier: "unknown",
      ageMinutes: null
    });
  });

  it("missing lastActivity → unknown", () => {
    expect(computeObserverHealth("05/29/2026 13:00:00", null)).toEqual({
      tier: "unknown",
      ageMinutes: null
    });
  });

  it("undefined inputs → unknown", () => {
    expect(computeObserverHealth(undefined, undefined)).toEqual({
      tier: "unknown",
      ageMinutes: null
    });
  });

  it("empty string inputs → unknown", () => {
    expect(computeObserverHealth("", "")).toEqual({
      tier: "unknown",
      ageMinutes: null
    });
  });

  it("garbage strings → unknown", () => {
    expect(computeObserverHealth("not a date", "05/29/2026 13:00:00")).toEqual({
      tier: "unknown",
      ageMinutes: null
    });
    expect(computeObserverHealth("05/29/2026 13:00:00", "not a date")).toEqual({
      tier: "unknown",
      ageMinutes: null
    });
  });

  it("rejects impossible wall-clock timestamps instead of normalizing them", () => {
    expect(
      computeObserverHealth("13/29/2026 13:00:00", "05/29/2026 13:00:00")
    ).toEqual({
      tier: "unknown",
      ageMinutes: null
    });
    expect(
      computeObserverHealth("05/29/2026 24:00:00", "05/29/2026 13:00:00")
    ).toEqual({
      tier: "unknown",
      ageMinutes: null
    });
  });
});

describe("computeObserverHealth — timezone-independence", () => {
  it("identical wall-clock strings yield the same diff regardless of locale", () => {
    // The math subtracts two Date.parse() values from the same formatter.
    // Both come from agent.log() which uses the worker's local TZ — but
    // since the same offset is applied to both, it cancels out. We assert
    // by re-running with deliberately shifted strings whose textual diff
    // is what matters, not the absolute TZ each parses to.
    const r1 = computeObserverHealth(
      "05/29/2026 13:00:00",
      "05/29/2026 13:20:00"
    );
    const r2 = computeObserverHealth(
      "05/29/2026 05:00:00",
      "05/29/2026 05:20:00"
    );
    expect(r1.ageMinutes).toBe(r2.ageMinutes);
    expect(r1.tier).toBe(r2.tier);
  });
});
