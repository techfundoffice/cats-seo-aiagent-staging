import { describe, expect, it } from "vitest";
import {
  TITLE_TRAILING_ORPHAN_MODIFIERS,
  trimTrailingTitleOrphanModifiers
} from "../editorial-agent";
import {
  TITLE_MAX_CHARS,
  TITLE_MIN_CHARS,
  enforceTitleSerpWindow
} from "../title-meta-normalizer";

function repairTitle(rawTitle: string, keyword = ""): string {
  const noOrphanTail = trimTrailingTitleOrphanModifiers(rawTitle);
  return enforceTitleSerpWindow(noOrphanTail, keyword || rawTitle).title;
}

describe("editorial post-rewrite title orphan repair", () => {
  it.each([
    "Best Dual Clip Cat Harness for Hiking: 2026 Top Picks for",
    "Cat Stairs vs Cat Ramp for Senior Cats: vs",
    "Cat Harness Review Escape Proof (2026): Expert-Tested Top",
    "Lightweight Cat Window Perch Travel Friendly: 2026's Top",
    "Budget Cat Window Perch Under Value: 2026's Top Picks &amp;",
    "Quiet Bamboo Elevated Cat Bowls With Stand: Top 5 Picks for",
    "Premium Cat Wheelchair with Support Harness: Expert-Tested Top:",
    "Premium Cat Wheelchair with Support Harness: Expert-Tested Top;",
    "Premium Memory Foam Cat Stairs for Senior Cats: Top Picks for—",
    "Premium Memory Foam Cat Stairs for Senior Cats: Top Picks for)",
    "Premium Memory Foam Cat Stairs for Senior Cats: Top Picks for”"
  ])("repairs trailing orphan tokens for '%s'", (input) => {
    const repaired = repairTitle(input, "");
    const last = repaired.split(/\s+/).pop()?.toLowerCase() ?? "";
    expect(TITLE_TRAILING_ORPHAN_MODIFIERS.has(last)).toBe(false);
    expect(repaired.length).toBeGreaterThanOrEqual(TITLE_MIN_CHARS);
    expect(repaired.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it("returns empty when the title is only orphan modifiers", () => {
    expect(trimTrailingTitleOrphanModifiers("for")).toBe("");
    expect(trimTrailingTitleOrphanModifiers("for with:")).toBe("");
  });
});
