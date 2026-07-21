import { describe, expect, it } from "vitest";
import { __testHelpers } from "../siss-optimizer";

const { checkSubIntentCoverage, computeSissScore } = __testHelpers;

// ── computeSissScore ──────────────────────────────────────────────────────────

describe("computeSissScore", () => {
  it("returns 0 when total is empty", () => {
    expect(computeSissScore([], [])).toBe(0);
  });

  it("returns 100 when all intents are covered", () => {
    const intents = ["a", "b", "c"];
    expect(computeSissScore(intents, intents)).toBe(100);
  });

  it("returns 0 when none are covered", () => {
    expect(computeSissScore([], ["a", "b", "c"])).toBe(0);
  });

  it("rounds to nearest integer", () => {
    // 1 of 3 = 33.33...% → rounds to 33
    expect(computeSissScore(["a"], ["a", "b", "c"])).toBe(33);
    // 2 of 3 = 66.66...% → rounds to 67
    expect(computeSissScore(["a", "b"], ["a", "b", "c"])).toBe(67);
  });
});

// ── checkSubIntentCoverage ────────────────────────────────────────────────────

const BODY_HTML =
  "<p>This article covers calming supplements for cats after surgery, " +
  "including natural remedies and vet-approved options. " +
  "Anxiety relief and post-operative recovery tips are also discussed.</p>";

describe("checkSubIntentCoverage — basic coverage", () => {
  it("marks an intent covered when its differentiator appears in the body", () => {
    const { covered, missing } = checkSubIntentCoverage(
      BODY_HTML,
      ["cat calming supplement natural"],
      "cat calming supplement"
    );
    expect(covered).toContain("cat calming supplement natural");
    expect(missing).toHaveLength(0);
  });

  it("marks an intent missing when its differentiator is absent from the body", () => {
    const { covered, missing } = checkSubIntentCoverage(
      BODY_HTML,
      ["cat calming supplement thunderstorm"],
      "cat calming supplement"
    );
    expect(missing).toContain("cat calming supplement thunderstorm");
    expect(covered).toHaveLength(0);
  });

  it("returns empty covered and missing arrays when subIntents is empty", () => {
    const { covered, missing } = checkSubIntentCoverage(BODY_HTML, [], "cat");
    expect(covered).toHaveLength(0);
    expect(missing).toHaveLength(0);
  });
});

describe("checkSubIntentCoverage — short differentiator (< 2 chars)", () => {
  it("counts as covered when kwBase appears in the body", () => {
    // Intent equals kwBase exactly → differentiator is empty → short path
    const html = "<p>calming supplement for cats.</p>";
    const { covered } = checkSubIntentCoverage(
      html,
      ["calming supplement"],
      "calming supplement"
    );
    expect(covered).toContain("calming supplement");
  });

  it("counts as missing when kwBase is absent from body", () => {
    const { missing } = checkSubIntentCoverage(
      "<p>unrelated content</p>",
      ["calming supplement"],
      "calming supplement"
    );
    expect(missing).toContain("calming supplement");
  });
});

describe("checkSubIntentCoverage — keyword truncated to 5 words", () => {
  it("uses only the first 5 words of a long keyword as the base prefix", () => {
    // Keyword has 7 words; base is truncated to 5 ("top cat calming supplement after")
    // Intent extends with "surgery" which must appear in the body
    const html =
      "<p>top cat calming supplement after surgery is important.</p>";
    const { covered } = checkSubIntentCoverage(
      html,
      ["top cat calming supplement after surgery"],
      "top cat calming supplement after surgery recovery"
    );
    expect(covered).toContain("top cat calming supplement after surgery");
  });
});

describe("checkSubIntentCoverage — leading stop-word stripping", () => {
  it("strips a leading 'for' from the differentiator before matching", () => {
    const html = "<p>recovery tips and anxiety relief.</p>";
    const { covered } = checkSubIntentCoverage(
      html,
      ["calming supplement for recovery"],
      "calming supplement"
    );
    expect(covered).toContain("calming supplement for recovery");
  });
});

describe("checkSubIntentCoverage — multi-word ≥0.5 coverage ratio", () => {
  it("covers an intent when half of its diffWords appear in the body", () => {
    // diffWords after filtering >3 chars: ["recovery", "tips"]
    // body contains "recovery" → 1/2 = 0.5 → covered
    const html = "<p>post-surgery recovery for cats.</p>";
    const { covered } = checkSubIntentCoverage(
      html,
      ["cat supplement recovery tips"],
      "cat supplement"
    );
    expect(covered).toContain("cat supplement recovery tips");
  });

  it("marks as missing when fewer than half of diffWords appear", () => {
    // diffWords: ["thunder", "storm", "anxiety"] — none in body
    const html = "<p>post-surgery recovery for cats.</p>";
    const { missing } = checkSubIntentCoverage(
      html,
      ["cat supplement thunder storm anxiety"],
      "cat supplement"
    );
    expect(missing).toContain("cat supplement thunder storm anxiety");
  });
});

describe("checkSubIntentCoverage — HTML is decoded before matching", () => {
  it("matches through HTML entities in the body", () => {
    const html = "<p>calming &amp; recovery supplement for cats.</p>";
    const { covered } = checkSubIntentCoverage(
      html,
      ["calming recovery supplement"],
      "calming"
    );
    expect(covered).toContain("calming recovery supplement");
  });
});
