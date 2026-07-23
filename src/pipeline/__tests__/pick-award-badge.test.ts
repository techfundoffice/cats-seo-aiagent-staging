import { describe, expect, it } from "vitest";
import { PICK_AWARD_BADGE_SVG } from "../html-builder";

describe("PICK_AWARD_BADGE_SVG", () => {
  it("carries the brand award text with no year (badge must never go stale)", () => {
    expect(PICK_AWARD_BADGE_SVG).toContain("CATS LUV US");
    expect(PICK_AWARD_BADGE_SVG).toContain("BEST");
    expect(PICK_AWARD_BADGE_SVG).toContain("PICK");
    expect(PICK_AWARD_BADGE_SVG).not.toMatch(/\b20\d{2}\b/);
  });

  it("is a self-contained accessible SVG", () => {
    expect(PICK_AWARD_BADGE_SVG).toMatch(/^<svg /);
    expect(PICK_AWARD_BADGE_SVG).toContain(
      'aria-label="Cats Luv Us Best Pick award"'
    );
    expect(PICK_AWARD_BADGE_SVG).not.toContain("http://www.w3.org/1999/xlink");
  });
});
