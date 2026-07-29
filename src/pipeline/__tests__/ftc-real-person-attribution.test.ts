import { describe, expect, it } from "vitest";
import {
  detectFabricatedTestingClaimsInHtml,
  enforceNoFabricatedTestingClaims
} from "../fabricated-testing-claims";

/**
 * Regression: cat-collars-harnesses-leashes:skypia-pet-bells-for-dog-
 * cat-collar-charm-review, published to production 2026-07-29 08:25
 * UTC — after the post-rewrite backstop shipped. The backstop RAN and
 * found nothing: the phrasings simply were not covered.
 *
 * Both names are REAL, identifiable professionals (Susan Little, a
 * feline-exclusive veterinarian; Pamela Reid, an applied animal
 * behaviorist), falsely presented as having advised this site — the
 * higher-exposure half of this defect class.
 */
const ESCAPED = `<article>
  <nav class="toc" aria-label="Table of Contents"><strong>In This Article</strong><ol>
    <li><a href="#section-1">How SKYPIA Pet Bells Work<p><strong> Susan Little, a feline-exclusive veterinarian with over 25 years of experience, who provided insight on how auditory tracking aids compare to visual identification for outdoor cats. Additionally, we spoke with certified animal behaviorist Pamela Reid, PhD, who explained that predictability makes bells fundamentally different from external stressors.</strong></p></a></li>
  </ol></nav>
  <section id="section-1"><h2>How SKYPIA Pet Bells Work</h2><p>Each bell operates as a percussion instrument.</p></section>
</article>`;

describe("real-person attribution coverage", () => {
  it("flags an uncredentialed named expert with a specialty apposition", () => {
    const f = detectFabricatedTestingClaimsInHtml(ESCAPED);
    expect(f.some((x) => /Susan Little/.test(x.sentence))).toBe(true);
  });

  it("flags a first-person consultation with an intervening role phrase", () => {
    const f = detectFabricatedTestingClaimsInHtml(
      `<p>Additionally, we spoke with certified animal behaviorist Pamela Reid, PhD, who explained that bells differ from fireworks.</p>`
    );
    expect(f.some((x) => x.category === "fabricated-expert")).toBe(true);
  });

  it("flags a credentialed name with a non-review attribution verb", () => {
    const f = detectFabricatedTestingClaimsInHtml(
      `<p>Melissa Shapiro, DVM, a small-animal practitioner, who explained that styptic powder is the gold standard.</p>`
    );
    expect(f.some((x) => x.category === "fabricated-expert")).toBe(true);
  });

  it("excises both names from the escaped article", () => {
    const r = enforceNoFabricatedTestingClaims(ESCAPED);
    expect(r.removed).toBeGreaterThan(0);
    expect(r.html).not.toMatch(/Susan Little/);
    expect(r.html).not.toMatch(/Pamela Reid/);
    expect(r.html).toMatch(/Each bell operates as a percussion instrument/);
  });
});

describe("negated testing language is the disclosure, not the claim", () => {
  for (const disclosure of [
    "Cats Luv Us does not conduct hands-on product testing.",
    "Rankings reflect our editorial judgment based on stated features and aggregated user feedback, not hands-on evaluation.",
    "Without hands-on testing, we cannot verify manufacturer claims about filter lifespan.",
    "These operational insights derive from staff training protocols, not controlled product trials."
  ]) {
    it(`keeps: ${disclosure.slice(0, 48)}…`, () => {
      expect(
        detectFabricatedTestingClaimsInHtml(`<p>${disclosure}</p>`)
      ).toEqual([]);
    });
  }

  it("still flags the same vocabulary when it is NOT negated", () => {
    const f = detectFabricatedTestingClaimsInHtml(
      `<p>Our team's hands-on testing with medium-sized dogs revealed surprising acceptance rates.</p>`
    );
    expect(f.length).toBeGreaterThan(0);
  });
});

describe("block boundaries and citation surfaces", () => {
  it("does not fuse a heading to the paragraph below it", () => {
    // Pre-fix, these two blocks concatenated into one 'sentence' that
    // existed nowhere in the document.
    const f = detectFabricatedTestingClaimsInHtml(
      `<h2>How We Picked</h2><p>Bells are sized by cat weight.</p>`
    );
    expect(f).toEqual([]);
  });

  it("does not flag a third-party title inside Trusted Sources", () => {
    const f = detectFabricatedTestingClaimsInHtml(
      `<section class="trusted-sources"><h2>Trusted Sources &amp; References</h2><ul><li><a href="https://example.com">11 Best Interactive Cat Toys (August 2026) Expert Tested Reviews</a></li></ul></section>`
    );
    expect(f).toEqual([]);
  });

  it("keeps honouring the compliant methodology proximity exception", () => {
    const f = detectFabricatedTestingClaimsInHtml(
      `<section class="wc-methodology"><h2>How We Picked</h2><p>We compared 8 products sold on Amazon. Picks are synthesized from public product data and review aggregates; products are not physically tested by Cats Luv Us.</p></section>`
    );
    expect(f).toEqual([]);
  });
});
