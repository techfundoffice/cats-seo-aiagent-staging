import { describe, expect, it } from "vitest";
import { __testHelpers } from "../writer";

// Import the real implementation from writer.ts so a regex change
// there is immediately caught here (previously the test duplicated
// the regex locally and would stay green even after writer.ts drifted).
const { stripEditorialNoteFabrication } = __testHelpers;

describe("stripEditorialNoteFabrication — live audit cases", () => {
  it("removes Kimi-fabricated 'Editorial Note:' block (live 2026-05-31)", () => {
    // Verbatim from
    // catsluvus.com/cat-mobility-steps-.../automatic-motorized-pet-stairs-comparison
    const raw =
      "Powered stairs reduce strain. " +
      "Editorial Note: This guide reflects hands-on testing conducted at our " +
      "feline boarding facility with actual resident cats, not " +
      "manufacturer-provided review units. Product recommendations derive " +
      "from observed durability, cat acceptance rates, and safety incident " +
      "data collected across 15+ years of daily use.\n\n" +
      "Follow-up paragraph.";
    const out = stripEditorialNoteFabrication(raw);
    expect(out).not.toMatch(/Editorial Note/i);
    expect(out).not.toMatch(/review units/i);
    expect(out).not.toMatch(/observation data/i);
    expect(out).toContain("Powered stairs reduce strain.");
    expect(out).toContain("Follow-up paragraph.");
  });

  it("removes 'Editorial Integrity Note:' block (operator-reported variant)", () => {
    const raw =
      "Editorial Integrity Note: This guide was produced independently by " +
      "Cats Luv Us staff with products purchased at retail price. No " +
      "manufacturer provided review units or compensation. Rankings reflect " +
      "observed cat behavior in controlled boarding facility conditions, " +
      "not manufacturer claims. Our affiliate relationship with Amazon does " +
      "not influence product selection or scoring methodology. Testing " +
      "protocols and raw observation data are available upon request to " +
      "verified veterinary professionals.";
    const out = stripEditorialNoteFabrication(raw);
    expect(out).toBe("");
  });

  it("removes the block when wrapped in a <p> tag", () => {
    const raw =
      "<p>Powered stairs reduce strain.</p>" +
      "<p>Editorial Note: This guide reflects hands-on testing.</p>" +
      "<p>Next paragraph.</p>";
    const out = stripEditorialNoteFabrication(raw);
    expect(out).not.toMatch(/Editorial Note/i);
    expect(out).toContain("Powered stairs reduce strain.");
    expect(out).toContain("Next paragraph.");
  });

  it("preserves text that contains the word 'editorial' but not the marker phrase", () => {
    const raw =
      "Our editorial approach: synthesize from public data. " +
      "Note that we cross-reference with experience.";
    const out = stripEditorialNoteFabrication(raw);
    expect(out).toBe(raw);
  });

  it("returns empty input unchanged", () => {
    expect(stripEditorialNoteFabrication("")).toBe("");
  });
});
