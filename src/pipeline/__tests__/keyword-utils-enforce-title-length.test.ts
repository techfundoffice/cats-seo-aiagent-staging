import { describe, expect, it } from "vitest";
import { enforceTitleLength } from "../keyword-utils";

// Regression suite for `enforceTitleLength`. The function is called in
// writer.ts Step 14 immediately before publishing; a silent off-by-one or
// mid-word cut would ship a malformed title to every article's <title> tag
// and JSON-LD. These tests pin the four major branches: already-fits,
// word-boundary truncation without keyword, keyword-preservation, and
// non-finite / edge-case maxChars inputs.

describe("enforceTitleLength — title already fits", () => {
  it("returns an empty string unchanged", () => {
    expect(enforceTitleLength("")).toBe("");
  });

  it("returns a title that fits within the default 60-char limit unchanged", () => {
    const t = "Best cat treat dispenser";
    expect(enforceTitleLength(t)).toBe(t);
  });

  it("trims leading and trailing whitespace on a short title", () => {
    expect(enforceTitleLength("  Best cat treat dispenser  ")).toBe(
      "Best cat treat dispenser"
    );
  });

  it("returns a title that is exactly maxChars unchanged", () => {
    const t = "A".repeat(60);
    expect(enforceTitleLength(t, undefined, 60)).toBe(t);
  });
});

describe("enforceTitleLength — truncation without keyword", () => {
  it("truncates a long title at a word boundary before the limit", () => {
    // "Best automatic cat treat dispensers for active indoor cats today"
    //  is 64 chars; the space before "today" is at index 58.
    const t =
      "Best automatic cat treat dispensers for active indoor cats today";
    const result = enforceTitleLength(t, undefined, 60);
    expect(result.length).toBeLessThanOrEqual(60);
    // The character immediately after the result in the source must be a
    // space — i.e., the cut landed at a word boundary, not mid-word.
    expect(t[result.length]).toBe(" ");
  });

  it("hard-cuts at the limit when no word boundary exists before it", () => {
    // A single token longer than the limit — fall through to hard cut.
    const longWord = "x".repeat(70);
    const result = enforceTitleLength(longWord, undefined, 60);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("strips trailing dangling punctuation after a word-boundary cut", () => {
    // Truncation at a natural word boundary can leave ", " at the edge.
    const t =
      "Best cat treat dispensers, feeders, automatic toys for indoor cats in 2026";
    const result = enforceTitleLength(t, undefined, 60);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).not.toMatch(/[,;:\-—\s]$/);
  });

  it("uses the default maxChars of 60 when none is provided", () => {
    const t =
      "Best automatic pet treat dispenser for indoor cats — Top Picks 2026";
    const result = enforceTitleLength(t);
    expect(result.length).toBeLessThanOrEqual(60);
  });
});

describe("enforceTitleLength — keyword preservation", () => {
  it("preserves a keyword that starts at the beginning of the title", () => {
    // keyword at pos 5 ("automatic pet treat dispenser" within title)
    const t =
      "Best automatic pet treat dispenser for indoor cats — Top Picks 2026";
    const kw = "automatic pet treat dispenser";
    const result = enforceTitleLength(t, kw, 60);
    expect(result).toContain(kw);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("falls through to normal truncation when keyword is absent from title", () => {
    const t =
      "Top automatic feeders for outdoor cats and kittens reviewed in 2026";
    const kw = "interactive cat toy"; // not in title
    const result = enforceTitleLength(t, kw, 60);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.length).toBeGreaterThan(0);
  });

  it("skips keyword logic when keyword length exceeds the limit", () => {
    // kw.length > limit → keyword path is bypassed entirely
    const t =
      "Short title but definitely long enough to require truncation here";
    const kw = "k".repeat(61); // > 60 chars
    const result = enforceTitleLength(t, kw, 60);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("skips keyword logic when targetKeyword is an empty string", () => {
    const t =
      "Best automatic pet treat dispenser for indoor cats — Top Picks 2026";
    const result = enforceTitleLength(t, "", 60);
    expect(result.length).toBeLessThanOrEqual(60);
  });
});

describe("enforceTitleLength — maxChars edge cases", () => {
  it("uses 60 as fallback when maxChars is NaN", () => {
    const t =
      "Best automatic pet treat dispenser for indoor cats — Top Picks 2026";
    const result = enforceTitleLength(t, undefined, NaN);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("uses 60 as fallback when maxChars is Infinity", () => {
    const t =
      "Best automatic pet treat dispenser for indoor cats — Top Picks 2026";
    const result = enforceTitleLength(t, undefined, Infinity);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("respects a custom maxChars smaller than 60", () => {
    const t = "Best automatic pet treat dispenser for indoor cats 2026";
    const result = enforceTitleLength(t, undefined, 40);
    expect(result.length).toBeLessThanOrEqual(40);
  });

  it("returns empty string when maxChars is 0", () => {
    const t = "Best automatic pet treat dispenser";
    const result = enforceTitleLength(t, undefined, 0);
    expect(result).toBe("");
  });

  // Regression: live article 2026-07-22 shipped the title
  // "2026's Best Top Entry Cat Carrier for Anxious Cats: One" — the
  // ": One Clear Winner" suffix clause was sheared mid-phrase, leaving a
  // dangling "One". A truncation that cuts inside a colon-clause must
  // drop the whole clause.
  it("drops a colon-suffix clause sheared mid-phrase by truncation", () => {
    const t =
      "2026's Best Top Entry Cat Carrier for Anxious Cats: One Clear Winner";
    const result = enforceTitleLength(
      t,
      "top entry cat carrier for anxious cats",
      60
    );
    expect(result).toBe("2026's Best Top Entry Cat Carrier for Anxious Cats");
  });

  it("keeps a colon-suffix clause that fits entirely", () => {
    const t = "Best Cat Water Fountain: 2026 Review";
    const result = enforceTitleLength(t, "best cat water fountain", 60);
    expect(result).toBe(t);
  });
});
