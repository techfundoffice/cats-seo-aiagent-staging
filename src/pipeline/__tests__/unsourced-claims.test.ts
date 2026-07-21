import { describe, expect, it } from "vitest";
import {
  detectUnsourcedClaims,
  summarizeUnsourcedClaims
} from "../unsourced-claims";

// detectUnsourcedClaims is a deterministic YMYL fabricated-claim
// pre-filter. It flags sentences that assert a benefit-eligibility,
// regulatory/certification, quantified-research, or named-endorsement
// claim AND carry no citation/attribution marker. Writer.ts Step 14.6
// records a defect-finding on any hit and feeds the sentences to the
// Polish Agent for qualification.

describe("detectUnsourcedClaims — benefit-eligibility", () => {
  it("flags VA Veteran-Directed Care reimbursement claim", () => {
    const r = detectUnsourcedClaims(
      "Certain pet mobility equipment qualifies for reimbursement through Veteran-Directed Care programs."
    );
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("benefit-eligibility");
  });

  it("flags a TRICARE durable medical equipment pre-authorization claim", () => {
    const r = detectUnsourcedClaims(
      "The product offers a TRICARE durable medical equipment pre-authorization pathway for veterans."
    );
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("benefit-eligibility");
  });

  it("flags VR&E chapter 31 acceptance", () => {
    const r = detectUnsourcedClaims(
      "It supports acceptance of VR&E chapter 31 benefits at checkout."
    );
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].category).toBe("benefit-eligibility");
  });
});

describe("detectUnsourcedClaims — regulatory-cert", () => {
  it("flags ADA compliance + durability-cycle testing claim", () => {
    const r = detectUnsourcedClaims(
      "Manufacturers must demonstrate compliance with ADA accessibility guidelines and provide durability testing of 50,000+ wheel cycles."
    );
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].category).toBe("regulatory-cert");
  });

  it("flags a bare 50,000-cycle durability claim", () => {
    const r = detectUnsourcedClaims(
      "Each frame survives rigorous durability testing exceeding 50,000 cycles before shipping."
    );
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("regulatory-cert");
  });
});

describe("detectUnsourcedClaims — research-stat", () => {
  it("flags 'studies demonstrate' with a percentage", () => {
    const r = detectUnsourcedClaims(
      "Veterinary motion-capture studies demonstrate a 60% reduction in peak vertical acceleration."
    );
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("research-stat");
  });

  it("flags a 'reduces ... by approximately 40%' claim", () => {
    const r = detectUnsourcedClaims(
      "The shock-absorbing geometry reduces peak impact forces by approximately 40% compared to budget designs."
    );
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].category).toBe("research-stat");
  });

  it("flags decimal percentage claims like 12.5% reduction", () => {
    const r = detectUnsourcedClaims(
      "Independent testing found a 12.5% reduction in joint loading with this design."
    );
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("research-stat");
  });
});

describe("detectUnsourcedClaims — endorsement-partnership", () => {
  it("flags a named-organization partnership claim", () => {
    const r = detectUnsourcedClaims(
      "ROODO maintains active partnerships with Veterans of Foreign Wars post suppliers."
    );
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("endorsement-partnership");
  });

  it("flags a 'partnered with' claim", () => {
    const r = detectUnsourcedClaims(
      "The manufacturer has partnered with the American Veterinary Medical Association."
    );
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("endorsement-partnership");
  });

  it("flags an 'endorsed by' claim", () => {
    const r = detectUnsourcedClaims(
      "This feeder is endorsed by the Feline Nutrition Foundation."
    );
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("endorsement-partnership");
  });

  it("does NOT flag 'endorsed by' when a citation marker is present", () => {
    const r = detectUnsourcedClaims(
      "According to their website, this product is endorsed by veterinarians across the country."
    );
    expect(r).toHaveLength(0);
  });
});

describe("detectUnsourcedClaims — citation suppresses the flag", () => {
  it("does NOT flag a claim with 'according to'", () => {
    const r = detectUnsourcedClaims(
      "According to the VA, Veteran-Directed Care budgets cover certain independent-living goods."
    );
    expect(r).toHaveLength(0);
  });

  it("does NOT flag a claim with an inline URL", () => {
    const r = detectUnsourcedClaims(
      "Studies demonstrate a 60% reduction in joint loading (https://example.com/study)."
    );
    expect(r).toHaveLength(0);
  });

  it("does NOT flag a claim with 'per FDA' (all-caps acronym citation)", () => {
    // Regression: the original pattern [A-Z][a-z]+ required a lowercase
    // continuation and silently missed all-caps acronyms like FDA or AVMA.
    const r = detectUnsourcedClaims(
      "Per FDA guidance, this ramp material is considered safe for pets."
    );
    expect(r).toHaveLength(0);
  });

  it("does NOT flag a claim with 'per the AVMA' (all-caps acronym after 'the')", () => {
    const r = detectUnsourcedClaims(
      "This product meets weight-bearing standards, per the AVMA recommendations."
    );
    expect(r).toHaveLength(0);
  });

  it("does NOT flag a claim with a footnote marker", () => {
    const r = detectUnsourcedClaims(
      "Independent testing confirmed durability beyond 50,000 cycles [3]."
    );
    expect(r).toHaveLength(0);
  });
});

describe("detectUnsourcedClaims — clean / edge cases", () => {
  it("returns empty for ordinary uncontroversial prose", () => {
    const r = detectUnsourcedClaims(
      "This stroller folds flat for easy storage and has a roomy interior your cat will enjoy on neighborhood walks."
    );
    expect(r).toHaveLength(0);
  });

  it("returns empty for empty / non-string input", () => {
    expect(detectUnsourcedClaims("")).toHaveLength(0);
    // @ts-expect-error — exercising the runtime guard
    expect(detectUnsourcedClaims(null)).toHaveLength(0);
  });

  it("reports each offending sentence only once", () => {
    const text =
      "It is reimbursable through TRICARE and Veteran-Directed Care programs.";
    const r = detectUnsourcedClaims(text);
    expect(r).toHaveLength(1);
  });

  it("caps findings at 20", () => {
    const sentence =
      "It is reimbursable through Veteran-Directed Care programs. ";
    const r = detectUnsourcedClaims(sentence.repeat(30));
    // All identical sentences dedupe to one; verify the cap path with
    // distinct sentences instead.
    expect(r.length).toBeLessThanOrEqual(20);
  });

  it("caps distinct findings at 20", () => {
    const sentences = Array.from(
      { length: 30 },
      (_, i) => `Model ${i} reduces impact forces by ${10 + i}% in our lab.`
    ).join(" ");
    const r = detectUnsourcedClaims(sentences);
    expect(r).toHaveLength(20);
  });
});

describe("summarizeUnsourcedClaims", () => {
  it("summarizes by category with counts", () => {
    const findings = detectUnsourcedClaims(
      "It is reimbursable through Veteran-Directed Care. " +
        "It also accepts TRICARE benefits. " +
        "Studies demonstrate a 60% reduction in joint loading."
    );
    const s = summarizeUnsourcedClaims(findings);
    expect(s).toContain("unsourced YMYL claim(s)");
    expect(s).toContain("benefit-eligibility");
  });

  it("reports zero cleanly", () => {
    expect(summarizeUnsourcedClaims([])).toBe("0 unsourced YMYL claims");
  });
});
