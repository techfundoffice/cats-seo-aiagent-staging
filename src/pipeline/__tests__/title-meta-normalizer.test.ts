import { describe, expect, it } from "vitest";
import {
  META_MAX_CHARS,
  META_MIN_CHARS,
  TITLE_MAX_CHARS,
  TITLE_MIN_CHARS,
  enforceMetaSerpWindow,
  enforceTitleSerpWindow,
  trimTrailingTitleOrphanModifiers
} from "../title-meta-normalizer";

// Closes the 44% in-window-miss rate surfaced by the Priority 1 audit.
// Property: regardless of input, the output ALWAYS fits the SERP
// truncation window. The writer prompt is the first line of defense;
// these helpers are the unconditional belt.

describe("enforceTitleSerpWindow — passthrough when in-window", () => {
  it.each([
    "Best Cat Fountains for Senior Cats 2026 — Buying", // 50 chars
    "Best Automatic Cat Feeders for Multi-Cat Homes 2026", // 51 chars
    "x".repeat(45),
    "x".repeat(60)
  ])("leaves '%s' (%i chars) untouched", (input) => {
    const r = enforceTitleSerpWindow(input, "cat fountains");
    expect(r.changed).toBe(false);
    expect(r.title).toBe(input);
  });
});

describe("enforceTitleSerpWindow — too long → trim at word boundary", () => {
  it("65-char title trimmed to ≤60, no half-word, no dangling punct", () => {
    const input =
      "Best Cat Fountains for Senior Cats with Arthritis: A Complete Buying Guide";
    const r = enforceTitleSerpWindow(input, "cat fountains for senior cats");
    expect(r.changed).toBe(true);
    expect(r.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(r.title.length).toBeGreaterThanOrEqual(TITLE_MIN_CHARS);
    expect(r.title).not.toMatch(/[,:\-—]$/);
    // Ensures trim happened at whitespace, not mid-word.
    expect(input.startsWith(r.title.replace(/[.!?]+$/, "").trim())).toBe(true);
  });

  it("title ending with a colon has the colon stripped after trim", () => {
    const input = "x".repeat(58) + ":";
    const r = enforceTitleSerpWindow(input, "cats");
    expect(r.title).not.toMatch(/:$/);
    expect(r.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });
});

describe("enforceTitleSerpWindow — too short → pad with year+suffix", () => {
  it("12-char title gets padded into 45-60 window with year suffix", () => {
    const r = enforceTitleSerpWindow(
      "Cat Fountains",
      "best cat fountains",
      new Date("2026-05-30T00:00:00Z")
    );
    expect(r.changed).toBe(true);
    expect(r.title.length).toBeGreaterThanOrEqual(TITLE_MIN_CHARS);
    expect(r.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(r.title).toMatch(/2026/);
  });

  it("empty title is synthesized from keyword + year", () => {
    const r = enforceTitleSerpWindow(
      "",
      "cat fountains for senior cats",
      new Date("2026-05-30T00:00:00Z")
    );
    expect(r.changed).toBe(true);
    expect(r.title.length).toBeGreaterThanOrEqual(TITLE_MIN_CHARS);
    expect(r.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    // Title-case keyword expected somewhere in output.
    expect(r.title.toLowerCase()).toContain("cat fountains");
  });

  it("title that overshoots after padding gets re-trimmed in-window", () => {
    // A 35-char title + " | Best Picks 2026" (16 chars) = 51 chars in-window.
    // But if the keyword is huge, the synth could overshoot, then trim.
    const r = enforceTitleSerpWindow(
      "",
      "best cat scissors for matted long-haired persian senior cats with arthritis",
      new Date("2026-05-30T00:00:00Z")
    );
    expect(r.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(r.title.length).toBeGreaterThanOrEqual(TITLE_MIN_CHARS);
  });
});

describe("enforceMetaSerpWindow — passthrough when in-window", () => {
  it("140-char meta passes through", () => {
    const input = "x".repeat(140);
    const r = enforceMetaSerpWindow(input, "cats");
    expect(r.changed).toBe(false);
    expect(r.meta).toBe(input);
  });

  it("160-char meta passes through", () => {
    const input = "x".repeat(160);
    const r = enforceMetaSerpWindow(input, "cats");
    expect(r.changed).toBe(false);
  });
});

describe("enforceMetaSerpWindow — too long → trim at sentence boundary", () => {
  it("long meta with mid-string period trims at sentence terminator", () => {
    // Build a 200-char input where a "." lands at exactly char 158.
    const head = "x".repeat(157);
    const input = head + ". And then more filler after the period.";
    const r = enforceMetaSerpWindow(input, "cats");
    expect(r.changed).toBe(true);
    expect(r.meta.length).toBeLessThanOrEqual(META_MAX_CHARS);
    expect(r.meta.length).toBeGreaterThanOrEqual(META_MIN_CHARS);
    expect(r.meta).toMatch(/\.$/);
  });

  it("no sentence boundary → word-boundary trim + appended period", () => {
    const input = "a ".repeat(120); // 240 chars, no terminators
    const r = enforceMetaSerpWindow(input, "cats");
    expect(r.changed).toBe(true);
    expect(r.meta.length).toBeLessThanOrEqual(META_MAX_CHARS);
    expect(r.meta).toMatch(/\.$/);
  });
});

describe("enforceMetaSerpWindow — too short → pad with CTA", () => {
  it("50-char meta gets padded into 140-160 window", () => {
    const r = enforceMetaSerpWindow(
      "Tested cat fountains for senior arthritic cats.",
      "best cat fountains for senior cats"
    );
    expect(r.changed).toBe(true);
    expect(r.meta.length).toBeGreaterThanOrEqual(META_MIN_CHARS);
    expect(r.meta.length).toBeLessThanOrEqual(META_MAX_CHARS);
    // Keyword should appear in the padded portion at least once.
    expect(r.meta.toLowerCase()).toContain("cat fountains");
  });

  it("empty meta synthesized from keyword alone, still in-window", () => {
    const r = enforceMetaSerpWindow("", "best cat fountains for senior cats");
    expect(r.changed).toBe(true);
    expect(r.meta.length).toBeGreaterThanOrEqual(META_MIN_CHARS);
    expect(r.meta.length).toBeLessThanOrEqual(META_MAX_CHARS);
  });
});

describe("invariant — output ALWAYS in-window across random fuzz", () => {
  it("enforceTitleSerpWindow: 50 random inputs all land in [45,60]", () => {
    // Mix of empty, short, medium, long, very-long strings.
    const fuzz = [
      "",
      "x",
      "xx",
      "a b",
      "Cat Fountains",
      "Best Cat Fountains for Senior Cats with Arthritis 2026 Plus More Bonus",
      "x".repeat(15),
      "x".repeat(30),
      "x".repeat(44),
      "x".repeat(45),
      "x".repeat(50),
      "x".repeat(59),
      "x".repeat(60),
      "x".repeat(61),
      "x".repeat(75),
      "x".repeat(100),
      "x".repeat(200)
    ];
    for (let i = 0; i < 33; i++) fuzz.push("y".repeat(i + 1));
    for (const input of fuzz) {
      const r = enforceTitleSerpWindow(input, "cat fountains");
      expect(
        r.title.length,
        `input ${JSON.stringify(input)}`
      ).toBeGreaterThanOrEqual(TITLE_MIN_CHARS);
      expect(
        r.title.length,
        `input ${JSON.stringify(input)}`
      ).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    }
  });

  it("enforceMetaSerpWindow: 50 random inputs all land in [140,160]", () => {
    const fuzz: string[] = [];
    for (let i = 0; i < 50; i++) fuzz.push("y".repeat(i * 5));
    for (const input of fuzz) {
      const r = enforceMetaSerpWindow(input, "cats");
      expect(r.meta.length, `input len=${input.length}`).toBeGreaterThanOrEqual(
        META_MIN_CHARS
      );
      expect(r.meta.length, `input len=${input.length}`).toBeLessThanOrEqual(
        META_MAX_CHARS
      );
    }
  });
});

describe("invariant — idempotent", () => {
  it("enforceTitleSerpWindow: applying twice produces identical output", () => {
    const inputs = ["", "short", "x".repeat(75), "x".repeat(30)];
    for (const i of inputs) {
      const a = enforceTitleSerpWindow(i, "cat fountains");
      const b = enforceTitleSerpWindow(a.title, "cat fountains");
      expect(b.title).toBe(a.title);
      expect(b.changed).toBe(false);
    }
  });

  it("enforceMetaSerpWindow: applying twice produces identical output", () => {
    const inputs = ["", "short.", "y".repeat(200), "y".repeat(50)];
    for (const i of inputs) {
      const a = enforceMetaSerpWindow(i, "cats");
      const b = enforceMetaSerpWindow(a.meta, "cats");
      expect(b.meta).toBe(a.meta);
      expect(b.changed).toBe(false);
    }
  });
});

describe("trimTrailingTitleOrphanModifiers", () => {
  it("returns the title unchanged when no orphan modifiers at the end", () => {
    expect(trimTrailingTitleOrphanModifiers("Best Cat Fountains 2026")).toBe(
      "Best Cat Fountains 2026"
    );
  });

  it("strips a single trailing modifier", () => {
    expect(trimTrailingTitleOrphanModifiers("Best Cat Fountains for")).toBe(
      "Best Cat Fountains"
    );
  });

  it("strips trailing punctuation before the orphan check", () => {
    expect(trimTrailingTitleOrphanModifiers("Best Cat Fountains for,")).toBe(
      "Best Cat Fountains"
    );
  });

  it("strips multiple consecutive trailing modifiers", () => {
    expect(trimTrailingTitleOrphanModifiers("Best Cat Fountains for the")).toBe(
      "Best Cat Fountains"
    );
  });

  it("returns empty string when only modifiers remain", () => {
    expect(trimTrailingTitleOrphanModifiers("for the best")).toBe("");
  });

  it("decodes HTML entities before checking modifiers (&amp; → &)", () => {
    expect(trimTrailingTitleOrphanModifiers("Best Cat Fountains &amp;")).toBe(
      "Best Cat Fountains"
    );
  });

  it("strips bare & without entity encoding", () => {
    expect(trimTrailingTitleOrphanModifiers("Best Cat Fountains &")).toBe(
      "Best Cat Fountains"
    );
  });

  it("returns empty string for empty input", () => {
    expect(trimTrailingTitleOrphanModifiers("")).toBe("");
  });
});
