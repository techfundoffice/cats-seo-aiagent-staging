import { describe, expect, it } from "vitest";
import {
  evaluateCommercialKeyword,
  isCommercialKeyword
} from "../commercial-keyword-gate";

describe("commercial-keyword-gate", () => {
  it("accepts buyer-intent cat product queries", () => {
    expect(isCommercialKeyword("best cat water fountain for indoor cats")).toBe(
      true
    );
    expect(isCommercialKeyword("cat litter box review")).toBe(true);
    expect(isCommercialKeyword("automatic cat feeder vs timed feeder")).toBe(
      true
    );
    expect(
      evaluateCommercialKeyword("best cat tree for large cats").score
    ).toBeGreaterThanOrEqual(70);
  });

  it("blocks memorial, dog-only, and non-commercial", () => {
    expect(isCommercialKeyword("pet cremation jewelry for ashes")).toBe(false);
    expect(isCommercialKeyword("dog playpen for backyard")).toBe(false);
    expect(isCommercialKeyword("zeqingjw pendant")).toBe(false);
    expect(isCommercialKeyword("something", "cat-memorials-funerary")).toBe(
      false
    );
  });

  it("allows product nouns with for/kit", () => {
    expect(isCommercialKeyword("stainless steel cat fountain")).toBe(true);
    expect(isCommercialKeyword("cat dental care kit")).toBe(true);
  });
});
