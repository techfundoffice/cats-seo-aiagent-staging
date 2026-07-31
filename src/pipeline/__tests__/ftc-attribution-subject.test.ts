import { describe, expect, it } from "vitest";
import { detectFabricatedTestingClaimsInHtml } from "../fabricated-testing-claims";

const flags = (s: string) =>
  detectFabricatedTestingClaimsInHtml(`<p>${s}</p>`).some(
    (f) => f.category === "fabricated-expert"
  );

/**
 * A full-corpus sweep (437 live articles) showed the attribution
 * lead-in pattern firing on third parties. Its `[A-Z][a-z]+` name guard
 * carried an `/i` flag, which made it match any two lowercase words —
 * so a claim about the MANUFACTURER read as a claim about us.
 */
describe("attribution requires US as the subject and a PERSON as the source", () => {
  it("flags an expert we claim advised us", () => {
    expect(
      flags(
        "This review incorporates insights from Dr. Elena Voss, who specializes in bereavement."
      )
    ).toBe(true);
  });

  it("does not flag the manufacturer taking expert advice", () => {
    expect(
      flags(
        "The first major leap came when FDW engineers incorporated feedback from feline behaviorists who emphasized scent neutrality."
      )
    ).toBe(false);
  });

  it("does not flag a product shaped by its own users", () => {
    expect(
      flags(
        "This particular model incorporates feedback from frequent travelers who need one carrier for car rides and air travel."
      )
    ).toBe(false);
  });

  it("does not flag generic prose about what reviews contain", () => {
    expect(
      flags(
        "The review becomes particularly valuable when it incorporates feedback from multiple users over extended periods."
      )
    ).toBe(false);
  });

  it("does not flag citing a published organisation's guidance", () => {
    expect(
      flags(
        "Our analysis incorporates guidance from the American Veterinary Medical Association on safe restraint practices."
      )
    ).toBe(false);
    expect(
      flags(
        "We also incorporated insights from the National Cat Groomers Institute of America regarding design standards."
      )
    ).toBe(false);
  });
});

/**
 * The same sweep found the inverse gap: claims of expert engagement
 * with no name at all, which every name-anchored pattern missed.
 */
describe("unnamed expert engagement by us", () => {
  for (const claim of [
    "Our assessments incorporate insights from consultations with veterinary nutritionists regarding treat integration.",
    "Our recommendations incorporate insights from certified feline behavior consultants and veterinary technicians on staff.",
    "According to customer review patterns and our consultation with veterinary grief counselors, the motion creates continuing bonds.",
    "This review was prepared by the Cats Luv Us content team using product specifications and consultation with veterinary professionals."
  ]) {
    it(`flags: ${claim.slice(0, 52)}…`, () => {
      expect(flags(claim)).toBe(true);
    });
  }

  it("does not flag a citation with no credentialed role as the source", () => {
    expect(
      flags(
        "Our evaluation incorporates guidance from the manufacturer's published specification sheet."
      )
    ).toBe(false);
  });
});
