import { describe, expect, it } from "vitest";
import { templateForDefectClass } from "../defect-eval-builder";

// templateForDefectClass is a pure mapping from DefectClass → success-criterion
// template. Tests below pin the check IDs and kinds for every wired class so
// a future edit can't silently empty out a template that Copilot's eval runner
// depends on.

describe("templateForDefectClass — wired classes have non-empty checks", () => {
  it("rewrite-fragment-not-document returns the document-shape checks", () => {
    const t = templateForDefectClass("rewrite-fragment-not-document");
    expect(t.checks.length).toBeGreaterThan(0);
    const ids = t.checks.map((c) => c.id);
    expect(ids).toContain("starts-with-doctype");
    expect(ids).toContain("has-body-element");
    expect(ids).toContain("seo-not-regressed");
    expect(Object.keys(t.rationale)).toEqual(ids);
  });

  it("unsourced-ymyl-claim returns benefit-eligibility + clinical-research checks", () => {
    const t = templateForDefectClass("unsourced-ymyl-claim");
    expect(t.checks.length).toBe(3);
    const ids = t.checks.map((c) => c.id);
    expect(ids).toContain("no-benefit-eligibility-trigger");
    expect(ids).toContain("no-fabricated-clinical-research");
    expect(ids).toContain("seo-not-regressed");
    // Every check must have a matching rationale entry.
    expect(Object.keys(t.rationale)).toEqual(ids);
  });

  it("unsourced-ymyl-claim benefit-eligibility pattern matches known YMYL triggers", () => {
    const t = templateForDefectClass("unsourced-ymyl-claim");
    const benefitCheck = t.checks.find(
      (c) => c.id === "no-benefit-eligibility-trigger"
    );
    expect(benefitCheck).toBeDefined();
    if (
      !benefitCheck ||
      (benefitCheck.kind !== "regex-must-match" &&
        benefitCheck.kind !== "regex-must-not-match")
    ) {
      throw new Error("unexpected check kind");
    }
    const re = new RegExp(benefitCheck.pattern, benefitCheck.flags ?? "");
    // High-signal YMYL terms that should never appear uncited on a cat-product page.
    expect(re.test("TRICARE covers this product")).toBe(true);
    expect(re.test("Veteran-Directed Care reimbursable")).toBe(true);
    expect(re.test("FSA-eligible purchase")).toBe(true);
    expect(re.test("pre-authorization required")).toBe(true);
    // Word-boundary checks: prefix/suffix variants must not be flagged.
    expect(re.test("TRICAREX is not a real program")).toBe(false);
    expect(re.test("VDCA is a different acronym")).toBe(false);
    expect(re.test("pre-authoritative tone")).toBe(false);
    // Normal cat-product prose must not be flagged.
    expect(re.test("Great for cats who love timed feeders")).toBe(false);
  });

  it("unsourced-ymyl-claim clinical-research pattern matches fabricated credentials", () => {
    const t = templateForDefectClass("unsourced-ymyl-claim");
    const clinicalCheck = t.checks.find(
      (c) => c.id === "no-fabricated-clinical-research"
    );
    expect(clinicalCheck).toBeDefined();
    if (
      !clinicalCheck ||
      (clinicalCheck.kind !== "regex-must-match" &&
        clinicalCheck.kind !== "regex-must-not-match")
    ) {
      throw new Error("unexpected check kind");
    }
    const re = new RegExp(clinicalCheck.pattern, clinicalCheck.flags ?? "");
    expect(re.test("clinically proven to reduce anxiety")).toBe(true);
    expect(re.test("veterinary-grade materials")).toBe(true);
    // Ordinary prose must not be flagged.
    expect(re.test("Our vet recommends this feeder")).toBe(false);
  });

  it("itemlist-doubled-best returns doubled-prefix checks with matching rationale", () => {
    const t = templateForDefectClass("itemlist-doubled-best");
    expect(t.checks.length).toBe(2);
    const ids = t.checks.map((c) => c.id);
    expect(ids).toContain("no-doubled-best-in-itemlist-name");
    expect(ids).toContain("no-doubled-best-anywhere-in-html");
    expect(Object.keys(t.rationale)).toEqual(ids);
  });

  it("itemlist-doubled-best regex patterns flag 'Best best' and pass clean prose", () => {
    const t = templateForDefectClass("itemlist-doubled-best");
    const jsonldCheck = t.checks.find(
      (c) => c.id === "no-doubled-best-in-itemlist-name"
    );
    const htmlCheck = t.checks.find(
      (c) => c.id === "no-doubled-best-anywhere-in-html"
    );
    if (
      !jsonldCheck ||
      !htmlCheck ||
      jsonldCheck.kind !== "regex-must-not-match" ||
      htmlCheck.kind !== "regex-must-not-match"
    ) {
      throw new Error("unexpected check kind");
    }
    const jsonldRe = new RegExp(jsonldCheck.pattern, jsonldCheck.flags ?? "");
    const htmlRe = new RegExp(htmlCheck.pattern, htmlCheck.flags ?? "");
    // Must flag doubled-prefix bug.
    expect(jsonldRe.test('"name": "Best best automatic cat feeder"')).toBe(
      true
    );
    expect(htmlRe.test("Best best automatic cat feeder")).toBe(true);
    // Must not flag clean prose.
    expect(jsonldRe.test('"name": "Best automatic cat feeder"')).toBe(false);
    expect(htmlRe.test("Best automatic cat feeder")).toBe(false);
  });

  it("product-name-truncation returns mid-name truncation check with matching rationale", () => {
    const t = templateForDefectClass("product-name-truncation");
    expect(t.checks.length).toBe(1);
    const ids = t.checks.map((c) => c.id);
    expect(ids).toContain("no-product-name-mid-name-truncation");
    expect(Object.keys(t.rationale)).toEqual(ids);
  });

  it("product-name-truncation regex flags truncated names followed by a verb", () => {
    const t = templateForDefectClass("product-name-truncation");
    const check = t.checks.find(
      (c) => c.id === "no-product-name-mid-name-truncation"
    );
    if (!check || check.kind !== "regex-must-not-match") {
      throw new Error("unexpected check kind");
    }
    const re = new RegExp(check.pattern, check.flags ?? "");
    // Real-world example: truncated name then sentence verb.
    expect(
      re.test("Wellness Monitoring for... provides superior tracking")
    ).toBe(true);
    // Clean product prose must not be flagged.
    expect(
      re.test("The SureFeed Microchip Pet Feeder provides secure eating")
    ).toBe(false);
  });

  it("missing-why-we-like-blurb returns marker-presence check with matching rationale", () => {
    const t = templateForDefectClass("missing-why-we-like-blurb");
    expect(t.checks.length).toBe(1);
    const ids = t.checks.map((c) => c.id);
    expect(ids).toContain("has-why-we-like-this-pick-marker");
    expect(Object.keys(t.rationale)).toEqual(ids);
    // Must be a regex-must-match (presence required, not banned).
    const check = t.checks[0];
    expect(check.kind).toBe("regex-must-match");
  });

  it("faq-near-duplicate-questions returns duplicate-detection check with matching rationale", () => {
    const t = templateForDefectClass("faq-near-duplicate-questions");
    expect(t.checks.length).toBe(1);
    const ids = t.checks.map((c) => c.id);
    expect(ids).toContain("no-trivial-noun-shuffle-faq-duplicates");
    expect(Object.keys(t.rationale)).toEqual(ids);
    // Must be a regex-must-not-match (the pattern is banned).
    const check = t.checks[0];
    expect(check.kind).toBe("regex-must-not-match");
  });

  it("duplicate-top-picks-headings returns H2 dedup check with matching rationale", () => {
    const t = templateForDefectClass("duplicate-top-picks-headings");
    expect(t.checks.length).toBe(1);
    const ids = t.checks.map((c) => c.id);
    expect(ids).toContain("no-duplicate-top-picks-h2");
    expect(Object.keys(t.rationale)).toEqual(ids);
    // Must be a regex-must-not-match (duplicate H2 is banned).
    const check = t.checks[0];
    expect(check.kind).toBe("regex-must-not-match");
  });

  it("default (unimplemented) classes return empty checks without throwing", () => {
    // live-false-testing-claim and other not-yet-wired classes
    // fall to default — the function must still be total.
    const t = templateForDefectClass("live-false-testing-claim");
    expect(t.checks).toEqual([]);
    expect(t.rationale).toEqual({});
  });

  it("prepub-fabricated-testing-claim returns FTC testing-claim check + seo-not-regressed", () => {
    const t = templateForDefectClass("prepub-fabricated-testing-claim");
    expect(t.checks.length).toBe(2);
    const ids = t.checks.map((c) => c.id);
    expect(ids).toContain("no-fabricated-testing-claim");
    expect(ids).toContain("seo-not-regressed");
    expect(Object.keys(t.rationale)).toEqual(ids);
    // Must be a regex-must-not-match (fabricated testing language is banned).
    const ftcCheck = t.checks.find(
      (c) => c.id === "no-fabricated-testing-claim"
    );
    expect(ftcCheck?.kind).toBe("regex-must-not-match");
    if (!ftcCheck || ftcCheck.kind !== "regex-must-not-match") {
      throw new Error("unexpected check kind");
    }
    const re = new RegExp(ftcCheck.pattern, ftcCheck.flags ?? "");
    // Core first-person-test phrases that must be caught.
    expect(re.test("We tested every cat fountain for two weeks.")).toBe(true);
    expect(
      re.test("Our team evaluated each product against five criteria.")
    ).toBe(true);
    expect(re.test("Based on our testing, this is the best pick.")).toBe(true);
    // Hands-on framing phrases that must be caught.
    expect(re.test("Hands-on testing in our facility confirmed this.")).toBe(
      true
    );
    // Self-endorsement phrases that must be caught.
    expect(
      re.test("She personally reviewed every product recommendation.")
    ).toBe(true);
    expect(re.test("Amelia stands behind every pick in this guide.")).toBe(
      true
    );
    // Clean cat-product prose must not be flagged.
    expect(re.test("This cat fountain is great for senior cats.")).toBe(false);
    expect(
      re.test("Customers who tested the product reported high satisfaction.")
    ).toBe(false);
  });
});
