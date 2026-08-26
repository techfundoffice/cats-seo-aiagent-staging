import { describe, expect, it } from "vitest";
import { assessRenderedFreshness } from "../audit-freshness";

/** ~60 distinct content words, enough to clear the minWords floor. */
const ARTICLE = `
Choosing a self cleaning litter box means weighing rake reliability against
cabin size. The Litter Robot 4 sifts waste into a carbon filtered drawer
roughly ninety seconds after your cat steps off the platform, which keeps
ammonia from building in a small apartment bathroom. Larger cats above
eighteen pounds need the extra entryway clearance, and multi cat homes
should expect to empty the drawer twice weekly rather than the advertised
seven days.
`;

const CHROME = `
CatsLuvUs Boarding Hotel Grooming Services Contact Affiliate disclosure
we may earn a commission Home Categories Newsletter Privacy Policy
`;

describe("assessRenderedFreshness", () => {
  it("passes when the rendered page carries the stored article", () => {
    const result = assessRenderedFreshness(ARTICLE, CHROME + ARTICLE);

    expect(result.checked).toBe(true);
    expect(result.drifted).toBe(false);
    expect(result.headOverlap).toBeCloseTo(1, 5);
    expect(result.summary).toMatch(/matches 100%/);
  });

  it("flags drift when the live page still serves a different article", () => {
    const stale = `${CHROME}
      Best automatic cat feeders reviewed. Portion control matters more than
      hopper capacity for most kitchens, and gravity models jam with larger
      kibble shapes so a motorised auger is worth the extra outlay here.`;

    const result = assessRenderedFreshness(ARTICLE, stale);

    expect(result.checked).toBe(true);
    expect(result.drifted).toBe(true);
    expect(result.summary).toMatch(/stale version/);
  });

  it("survives an 8KB-truncated render of a long article", () => {
    // The real collector truncates rendered text at 8000 chars. The stored
    // article is far longer, so any length-ratio check would false-positive;
    // the head-overlap check must not.
    const tail = " additional buying guidance paragraph".repeat(400);
    const stored = ARTICLE + tail;
    const rendered = (CHROME + ARTICLE + tail).slice(0, 8000);

    const result = assessRenderedFreshness(stored, rendered);

    expect(result.checked).toBe(true);
    expect(result.drifted).toBe(false);
  });

  it("reports not-checked rather than drift when the render came back empty", () => {
    const result = assessRenderedFreshness(ARTICLE, "");

    // A screenshot failure must never be reported as a stale page.
    expect(result.checked).toBe(false);
    expect(result.drifted).toBe(false);
    expect(result.summary).toMatch(/not checked/);
  });

  it("reports not-checked when the stored article is too thin to judge", () => {
    const result = assessRenderedFreshness(
      "Short stub page.",
      CHROME + ARTICLE
    );

    expect(result.checked).toBe(false);
    expect(result.drifted).toBe(false);
    expect(result.summary).toMatch(/stored content words/);
  });

  it("ignores punctuation, case, and chrome boilerplate", () => {
    const shouty = ARTICLE.toUpperCase().replace(/,/g, " —— ");

    expect(assessRenderedFreshness(ARTICLE, shouty).drifted).toBe(false);
  });

  it("honours a caller-supplied threshold", () => {
    const partial = `${CHROME}
      Choosing a self cleaning litter box means weighing rake reliability
      against cabin size. The Litter Robot 4 sifts waste into a carbon
      filtered drawer roughly ninety seconds after your cat steps off.`;

    const lenient = assessRenderedFreshness(ARTICLE, partial, {
      minOverlap: 0.3
    });
    const strict = assessRenderedFreshness(ARTICLE, partial, {
      minOverlap: 0.95
    });

    expect(lenient.drifted).toBe(false);
    expect(strict.drifted).toBe(true);
    expect(lenient.headOverlap).toBeCloseTo(strict.headOverlap, 5);
  });
});
