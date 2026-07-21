import { describe, expect, it } from "vitest";
import {
  buildObserverWhatsNot,
  describeFindingClassForNarrative,
  OBSERVER_NARRATIVE_TRIGGER_COUNT
} from "../observer-agent";

// Regression suite for the observer fallback-narrative truth-telling.
// Pre-fix, the narrative said "one more finding fires the loop" for any
// class with ≥ 4 findings — but classes at ≥ 5 had already fired the
// trigger and were in a 24h `inflight-lock` cooldown. The misleading
// phrasing led to a real user-reported confusion at
// `missing-why-we-like-blurb:14/5`. The new logic distinguishes those
// states; these tests pin the distinction.

describe("describeFindingClassForNarrative", () => {
  it("0 findings → counts toward 'remaining'", () => {
    expect(describeFindingClassForNarrative("foo", 0)).toMatch(
      /5 more findings/
    );
  });

  it("count below trigger — exact remaining count + singular/plural", () => {
    expect(describeFindingClassForNarrative("foo", 4)).toMatch(
      /1 more finding\b/
    );
    expect(describeFindingClassForNarrative("foo", 4)).not.toMatch(
      /1 more findings/
    );
    expect(describeFindingClassForNarrative("foo", 3)).toMatch(
      /2 more findings/
    );
  });

  it("count at trigger → already-triggered language", () => {
    const out = describeFindingClassForNarrative("foo", 5);
    expect(out).toMatch(/loop already triggered/i);
    expect(out).toMatch(/24h cooldown/);
    expect(out).not.toMatch(/more finding/i);
  });

  it("count well above trigger (14) → still 'already triggered', not 'one more fires'", () => {
    // The exact scenario the user observed: missing-why-we-like-blurb:14
    // pre-fix said "one more fires the loop" — a lie. Post-fix it MUST
    // say "already triggered".
    const out = describeFindingClassForNarrative(
      "missing-why-we-like-blurb",
      14
    );
    expect(out).toMatch(/loop already triggered/i);
    expect(out).not.toMatch(/more finding/i);
  });

  it("uses the canonical trigger count constant", () => {
    expect(OBSERVER_NARRATIVE_TRIGGER_COUNT).toBe(5);
    expect(describeFindingClassForNarrative("x", 2)).toContain(
      `:2/${OBSERVER_NARRATIVE_TRIGGER_COUNT}`
    );
  });
});

describe("buildObserverWhatsNot", () => {
  it("empty findings → kimi-down fallback text", () => {
    expect(buildObserverWhatsNot({})).toMatch(
      /No AI narrative available this tick/
    );
  });

  it("findings all below half-trigger → kimi-down fallback text", () => {
    // Half of 5 = 3 (ceil). 1-2 findings shouldn't surface.
    expect(
      buildObserverWhatsNot({
        "itemlist-doubled-best": 1,
        "product-name-truncation": 2
      })
    ).toMatch(/No AI narrative available this tick/);
  });

  it("surfaces read failures when findings cannot be loaded", () => {
    const out = buildObserverWhatsNot({
      "itemlist-doubled-best": -1
    });
    expect(out).toMatch(/reads failed/i);
    expect(out).toContain("itemlist-doubled-best");
  });

  it("mixed: only ≥ half-trigger classes surface", () => {
    const out = buildObserverWhatsNot({
      "itemlist-doubled-best": 2, // below half
      "product-name-truncation": 3, // at half
      "faq-near-duplicate-questions": 4, // near trigger
      "missing-why-we-like-blurb": 14 // already triggered
    });
    expect(out).not.toContain("itemlist-doubled-best");
    expect(out).toContain("product-name-truncation");
    expect(out).toContain("faq-near-duplicate-questions");
    expect(out).toContain("missing-why-we-like-blurb");
  });

  it("triggered classes carry the cooldown phrase", () => {
    const out = buildObserverWhatsNot({ "missing-why-we-like-blurb": 14 });
    expect(out).toMatch(/loop already triggered/);
  });

  it("near-trigger classes carry the remaining-count phrase", () => {
    const out = buildObserverWhatsNot({ "faq-near-duplicate-questions": 4 });
    expect(out).toMatch(/1 more finding/);
    expect(out).not.toMatch(/loop already triggered/);
  });

  it("each surfaced class is named once in the narrative", () => {
    const out = buildObserverWhatsNot({
      "itemlist-doubled-best": 3,
      "product-name-truncation": 4,
      "missing-why-we-like-blurb": 5
    });
    // Counter inside one of the cooldown phrases may itself include "; ",
    // so we don't rely on string-splitting — we just confirm each class
    // appears exactly once, with its expected "<count>/5" prefix.
    expect(out.match(/itemlist-doubled-best:3\/5/g)).toHaveLength(1);
    expect(out.match(/product-name-truncation:4\/5/g)).toHaveLength(1);
    expect(out.match(/missing-why-we-like-blurb:5\/5/g)).toHaveLength(1);
  });
});
