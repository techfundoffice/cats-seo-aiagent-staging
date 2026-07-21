import { describe, expect, it } from "vitest";
import { __testHelpers } from "../editorial-lessons";

const { reasonToInstruction } = __testHelpers;

// ── Mapped (specific) cases ───────────────────────────────────────────────────

describe("reasonToInstruction — mapped rejection reasons", () => {
  it("returns a specific instruction for seo-regression", () => {
    const inst = reasonToInstruction("seo-regression");
    expect(inst).toContain("SEO");
    expect(inst).not.toContain("AVOID THE FAILURE MODE");
  });

  it("returns a specific instruction for document-shape-regression", () => {
    const inst = reasonToInstruction("document-shape-regression");
    expect(inst).toContain("<!DOCTYPE html>");
    expect(inst).not.toContain("AVOID THE FAILURE MODE");
  });

  it("returns a specific instruction for jsonld-regression", () => {
    const inst = reasonToInstruction("jsonld-regression");
    expect(inst).toContain("application/ld+json");
    expect(inst).not.toContain("AVOID THE FAILURE MODE");
  });

  it("returns a specific instruction for xss-handler-or-script-url", () => {
    const inst = reasonToInstruction("xss-handler-or-script-url");
    expect(inst).toContain("NEVER EMIT EXECUTABLE CONTENT");
    expect(inst).toContain("onclick");
    expect(inst).not.toContain("AVOID THE FAILURE MODE");
  });

  it("returns a specific instruction for salvage-failed", () => {
    const inst = reasonToInstruction("salvage-failed");
    expect(inst).toContain("RETURN VALID HTML");
    expect(inst).not.toContain("AVOID THE FAILURE MODE");
  });

  it("shares the salvage-failed instruction for 'rewrite too short'", () => {
    expect(reasonToInstruction("rewrite too short")).toBe(
      reasonToInstruction("salvage-failed")
    );
  });

  it("returns a specific instruction for live-title-orphan-modifier", () => {
    const inst = reasonToInstruction("live-title-orphan-modifier");
    expect(inst).toContain("TITLE SHAPE GUARD");
    expect(inst).not.toContain("AVOID THE FAILURE MODE");
  });
});

// ── ftc-false-endorsement — the new mapped case ───────────────────────────────

describe("reasonToInstruction — ftc-false-endorsement", () => {
  it("returns a specific FTC instruction, not the generic default", () => {
    const inst = reasonToInstruction("ftc-false-endorsement");
    expect(inst).not.toContain("AVOID THE FAILURE MODE");
    expect(inst).toContain("FTC FALSE-ENDORSEMENT BAN");
  });

  it("explicitly bans first-person testing phrasings", () => {
    const inst = reasonToInstruction("ftc-false-endorsement");
    // Core first-person test verbs
    expect(inst).toContain("we tested");
    expect(inst).toContain("we evaluated");
    expect(inst).toContain("hands-on testing");
    expect(inst).toContain("field-tested");
  });

  it("explicitly bans self-endorsement / personal-review phrasings", () => {
    const inst = reasonToInstruction("ftc-false-endorsement");
    expect(inst).toContain("personally reviews");
    expect(inst).toContain("stands behind every recommendation");
  });

  it("provides safe editorial-voice alternatives", () => {
    const inst = reasonToInstruction("ftc-false-endorsement");
    expect(inst).toContain("verified buyer reviews");
  });

  it("explains the consequence (rewrite rejected, original stays live)", () => {
    const inst = reasonToInstruction("ftc-false-endorsement");
    expect(inst).toContain("rewrite is rejected");
    expect(inst).toContain("original stays live");
  });
});

// ── Generic default ───────────────────────────────────────────────────────────

describe("reasonToInstruction — default fallback", () => {
  it("uses AVOID THE FAILURE MODE for unmapped reasons", () => {
    const inst = reasonToInstruction("some-unknown-gate");
    expect(inst).toContain("AVOID THE FAILURE MODE");
    expect(inst).toContain("some-unknown-gate");
  });

  it("sanitizes special characters in the reason before interpolation", () => {
    const inst = reasonToInstruction('reason with "quotes" and\nnewlines');
    // Special chars must not pass through raw to the prompt.
    expect(inst).not.toContain('"quotes"');
    expect(inst).not.toContain("\n");
    // The sanitized version replaces non-alphanum (except -) with hyphens.
    expect(inst).toContain("AVOID THE FAILURE MODE");
  });

  it("truncates very long reason strings to 60 chars", () => {
    const longReason = "a".repeat(100);
    const inst = reasonToInstruction(longReason);
    // Sanitized reason is capped at 60 chars inside the label quotes.
    const match = inst.match(/LABELED "([^"]+)"/);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? "").length).toBeLessThanOrEqual(60);
  });
});
