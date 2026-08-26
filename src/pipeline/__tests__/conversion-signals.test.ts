import { describe, expect, it } from "vitest";
import {
  EMPTY_CONVERSION_SIGNALS,
  parseConversionSignals,
  summarizeConversionSignals
} from "../../tools/vision-audit";

describe("parseConversionSignals", () => {
  it("reads a well-formed signals block", () => {
    const signals = parseConversionSignals({
      signals: {
        ctaAboveFold: true,
        productVisibleAboveFold: true,
        contentStartsAboveFold: false,
        heroFraction: 0.7
      },
      issues: []
    });

    expect(signals).toEqual({
      ctaAboveFold: true,
      productVisibleAboveFold: true,
      contentStartsAboveFold: false,
      heroFraction: 0.7
    });
  });

  it("accepts a bare signals object without the wrapper", () => {
    expect(parseConversionSignals({ ctaAboveFold: false }).ctaAboveFold).toBe(
      false
    );
  });

  it("coerces the string booleans vision models keep returning", () => {
    const signals = parseConversionSignals({
      signals: {
        ctaAboveFold: "true",
        productVisibleAboveFold: "NO",
        contentStartsAboveFold: "Yes"
      }
    });

    expect(signals.ctaAboveFold).toBe(true);
    expect(signals.productVisibleAboveFold).toBe(false);
    expect(signals.contentStartsAboveFold).toBe(true);
  });

  it("accepts heroFraction as a percentage", () => {
    expect(
      parseConversionSignals({ heroFraction: 70 }).heroFraction
    ).toBeCloseTo(0.7, 6);
    expect(
      parseConversionSignals({ heroFraction: "85%" }).heroFraction
    ).toBeCloseTo(0.85, 6);
  });

  it("clamps a nonsense heroFraction into range", () => {
    expect(parseConversionSignals({ heroFraction: -3 }).heroFraction).toBe(0);
    expect(parseConversionSignals({ heroFraction: 250 }).heroFraction).toBe(1);
  });

  it("returns null — not false — for anything unanswered", () => {
    // The distinction matters: `false` is a finding worth acting on,
    // `null` means the model never answered and nothing should be logged.
    expect(parseConversionSignals({ issues: [] })).toEqual(
      EMPTY_CONVERSION_SIGNALS
    );
    expect(parseConversionSignals({ ctaAboveFold: "maybe" }).ctaAboveFold).toBe(
      null
    );
    expect(parseConversionSignals(null)).toEqual(EMPTY_CONVERSION_SIGNALS);
    expect(parseConversionSignals("not an object")).toEqual(
      EMPTY_CONVERSION_SIGNALS
    );
  });
});

describe("summarizeConversionSignals", () => {
  it("renders answered fields and flags the misses in caps", () => {
    const summary = summarizeConversionSignals({
      ctaAboveFold: false,
      productVisibleAboveFold: true,
      contentStartsAboveFold: null,
      heroFraction: 0.62
    });

    expect(summary).toContain("CTA above fold: NO");
    expect(summary).toContain("product above fold: yes");
    expect(summary).toContain("hero takes 62% of fold");
    // Unanswered fields are omitted rather than reported as a measurement.
    expect(summary).not.toContain("body copy");
  });

  it("says so plainly when the model returned nothing", () => {
    expect(summarizeConversionSignals(EMPTY_CONVERSION_SIGNALS)).toBe(
      "no signals returned"
    );
  });
});
