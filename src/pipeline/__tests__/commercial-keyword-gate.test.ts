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

  it("blocks synthetic test keywords", () => {
    expect(
      isCommercialKeyword("furhaven microvelvet cat bed e2e claude only review")
    ).toBe(false);
    expect(isCommercialKeyword("cat fountain dashboard refill")).toBe(false);
    expect(isCommercialKeyword("cat fountain dashboard-refill")).toBe(false);
    expect(isCommercialKeyword("claude-only cat toy review")).toBe(false);
    expect(evaluateCommercialKeyword("dashboard refill").reason).toBe(
      "blocked-junk"
    );
  });

  it("accepts a real Cat A–Z product title and still blocks junk in that category", () => {
    expect(isCommercialKeyword("Feliway Optimum Diffuser", "cat-f")).toBe(true);
    expect(
      isCommercialKeyword("Acme dashboard refill Cat Litter", "cat-a")
    ).toBe(false);
    expect(isCommercialKeyword("dog leash deluxe", "cat-d")).toBe(false);
    expect(isCommercialKeyword("zeqingjw pendant")).toBe(false);
  });
});
