import { describe, expect, it } from "vitest";
import {
  detectFabricatedTestingClaimsInHtml,
  enforceNoFabricatedTestingClaims
} from "../fabricated-testing-claims";

/**
 * Regression: cat-memorials-funerary:custom-cat-name-memorial-grave-
 * stake-marker-review, published to production 2026-07-29 04:48 UTC —
 * 44 minutes AFTER the fabricated-expert detector shipped.
 *
 * A post-Step-14.7 model rewrite injected an "Editorial Process Note"
 * into the template's own `<p class="date-info">` element. The mangled
 * markup (a `</time>` close tag with no opener) is the fingerprint of
 * the rewrite. Step 14.7 had already run and passed on the builder's
 * clean HTML, and nothing re-checked the rewrite before it hit KV.
 */
const ESCAPED_HTML = `<article>
  <h1>Custom Cat Name Memorial Grave Stake Marker Review</h1>
  <p>Memorial markers vary widely in weather resistance.</p>
  <p class="date-info">Editorial Process Note: This review incorporates insights from Dr. Elena Voss, DVM, who specializes in companion animal bereavement and has consulted with memorial product manufacturers on designs that honor the human-animal bond. Her perspective on how physical memorials facilitate healthy grief processing informed our evaluation criteria. Veterinary input was supplemented by interviews with three professional pet cemetery groundskeepers regarding weather exposure patterns. Last Updated: July 29, 2026</time></p>
  <section class="wc-methodology">
    <h2>How We Picked</h2>
    <p>We compared 8 memorial marker products sold on Amazon. Picks are synthesized from public product data and review aggregates; products are not physically tested by Cats Luv Us.</p>
  </section>
</article>`;

describe("post-rewrite FTC backstop", () => {
  it("detects a fabricated expert injected into a template element", () => {
    const findings = detectFabricatedTestingClaimsInHtml(ESCAPED_HTML);
    expect(findings.some((f) => f.category === "fabricated-expert")).toBe(true);
    expect(findings.some((f) => /Elena Voss/.test(f.sentence))).toBe(true);
  });

  it("excises the fabricated expert while keeping the article intact", () => {
    const result = enforceNoFabricatedTestingClaims(ESCAPED_HTML);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.html).not.toMatch(/Elena Voss/);
    // No residue: the orphaned lead-in, the label that introduced the
    // block, and the unnamed-interview sourcing claim all go too.
    expect(result.html).not.toMatch(/insights from Dr/i);
    expect(result.html).not.toMatch(/Editorial Process Note/i);
    expect(result.html).not.toMatch(/Her perspective on how physical/i);
    expect(result.html).not.toMatch(/Veterinary input was supplemented/i);
    // Real content survives.
    expect(result.html).toMatch(/Memorial markers vary widely/);
    expect(result.html).toMatch(/Last Updated: July 29, 2026/);
  });

  it("does not flag the compliant methodology block's comparison claim", () => {
    const clean = `<article>
      <p>Memorial markers vary widely in weather resistance.</p>
      <section class="wc-methodology">
        <h2>How We Picked</h2>
        <p>We compared 8 memorial marker products sold on Amazon. Picks are synthesized from public product data and review aggregates; products are not physically tested by Cats Luv Us.</p>
      </section>
    </article>`;
    expect(detectFabricatedTestingClaimsInHtml(clean)).toEqual([]);
  });

  it("is a no-op on already-clean HTML", () => {
    const clean = `<article><p>Memorial markers vary widely in weather resistance across climates.</p></article>`;
    const result = enforceNoFabricatedTestingClaims(clean);
    expect(result.removed).toBe(0);
    expect(result.headingsChanged).toBe(0);
    expect(result.html).toBe(clean);
  });
});
