import { describe, expect, it } from "vitest";
import {
  detectFabricatedTestingClaims,
  removeFabricatedTestingSentences,
  stripCompliantMethodologySections,
  summarizeFabricatedTestingClaims,
  TESTING_CLAIM_RE,
  type FabricatedTestingClaimFinding
} from "../fabricated-testing-claims";

// detectFabricatedTestingClaims is a deterministic detector for
// false product-testing self-endorsements (FTC 16 CFR Part 255).
// Catsluvus.com does not physically test products. Articles must
// not claim otherwise.

describe("detectFabricatedTestingClaims — first-person-test", () => {
  it("flags 'we tested'", () => {
    const r = detectFabricatedTestingClaims(
      "We tested every litter box on the market over six months of use."
    );
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("first-person-test");
  });

  it("flags 'we tried' / 'we evaluated' / 'we compared'", () => {
    expect(
      detectFabricatedTestingClaims(
        "We tried each fountain in a multi-cat household setup."
      )[0].category
    ).toBe("first-person-test");
    expect(
      detectFabricatedTestingClaims(
        "We evaluated every product against the same five criteria."
      )[0].category
    ).toBe("first-person-test");
    expect(
      detectFabricatedTestingClaims(
        "We compared the top three brands head to head."
      )[0].category
    ).toBe("first-person-test");
  });

  it("flags 'our team tested'", () => {
    const r = detectFabricatedTestingClaims(
      "Our team tested ten different scratching posts last quarter."
    );
    expect(r[0].category).toBe("first-person-test");
  });

  it("flags 'products we've tested'", () => {
    const r = detectFabricatedTestingClaims(
      "Of all the products we've tested, this one stood out."
    );
    expect(r[0].category).toBe("first-person-test");
  });
});

describe("detectFabricatedTestingClaims — 'our testing' gerund (live-corpus gap 2026-06-05)", () => {
  it("flags 'Based on our testing at the boarding facility' — verbatim live JSON-LD FAQ leak", () => {
    const r = detectFabricatedTestingClaims(
      "Based on our testing at the boarding facility, the top-rated cat play tunnel balances safety, durability, and ease of cleaning."
    );
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].category).toBe("first-person-test");
  });

  it("flags 'Our testing showed…'", () => {
    const r = detectFabricatedTestingClaims(
      "Our testing showed that pop-up tunnels collapse faster than ring-supported ones."
    );
    expect(r[0].category).toBe("first-person-test");
  });

  it("flags 'after our testing'", () => {
    const r = detectFabricatedTestingClaims(
      "After our testing, we concluded that low-pile carpet outperforms felt-lined alternatives."
    );
    expect(r[0].category).toBe("first-person-test");
  });
});

describe("detectFabricatedTestingClaims — adjective-tested compounds (live-corpus gap 2026-06-05)", () => {
  it("flags 'top-tested picks' — verbatim live meta-description leak", () => {
    const r = detectFabricatedTestingClaims(
      "Compare our 5 top-tested picks for senior cats to find the best play tunnel."
    );
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].category).toBe("hands-on-framing");
  });

  it("flags 'expert-tested guide'", () => {
    const r = detectFabricatedTestingClaims(
      "This expert-tested guide covers every breed-size combination."
    );
    expect(r[0].category).toBe("hands-on-framing");
  });

  it("flags 'lab-tested'", () => {
    const r = detectFabricatedTestingClaims(
      "Our lab-tested rankings include only models that survived 1,000 cycles."
    );
    expect(r[0].category).toBe("hands-on-framing");
  });

  it("does NOT flag 'customer-tested' (legitimate third-party signal)", () => {
    expect(
      detectFabricatedTestingClaims(
        "Customer-tested feedback consistently rates this brand highest for senior cats."
      )
    ).toHaveLength(0);
  });

  it("does NOT flag 'user-tested' (legitimate third-party signal)", () => {
    expect(
      detectFabricatedTestingClaims(
        "User-tested in 200+ homes per the manufacturer's own published data."
      )
    ).toHaveLength(0);
  });

  it("does NOT flag bare 'tested for safety' (third-party manufacturer testing)", () => {
    expect(
      detectFabricatedTestingClaims(
        "The product has been tested for safety by an independent lab per ISO standards."
      )
    ).toHaveLength(0);
  });
});

describe("detectFabricatedTestingClaims — hands-on-framing", () => {
  it("flags 'hands-on testing'", () => {
    const r = detectFabricatedTestingClaims(
      "Our hands-on testing covered durability, ease of cleaning, and noise."
    );
    expect(r[0].category).toBe("hands-on-framing");
  });

  it("flags 'field-tested'", () => {
    const r = detectFabricatedTestingClaims(
      "This brush was field-tested across three long-haired breeds."
    );
    expect(r[0].category).toBe("hands-on-framing");
  });

  it("flags 'real-world testing'", () => {
    const r = detectFabricatedTestingClaims(
      "After real-world testing in busy households, we recommend this model."
    );
    expect(r[0].category).toBe("hands-on-framing");
  });

  it("flags 'putting it through its paces'", () => {
    const r = detectFabricatedTestingClaims(
      "We spent a week putting each carrier through its paces on short trips."
    );
    expect(r[0].category).toBe("hands-on-framing");
  });
});

describe("detectFabricatedTestingClaims — time-on-product", () => {
  it("flags 'after 6 weeks of testing'", () => {
    const r = detectFabricatedTestingClaims(
      "After 6 weeks of testing, the build quality stayed solid."
    );
    expect(r[0].category).toBe("time-on-product");
  });

  it("flags 'spent 200 hours testing'", () => {
    const r = detectFabricatedTestingClaims(
      "We spent 200 hours testing every option before settling on a winner."
    );
    // first-person-test wins because "we tested"-like trigger matches first
    // in TRIGGERS order; either category is acceptable as long as it's flagged.
    expect(r).toHaveLength(1);
    expect(["time-on-product", "first-person-test"]).toContain(r[0].category);
  });
});

describe("detectFabricatedTestingClaims — quantified-trial", () => {
  it("flags 'tested 200 times'", () => {
    const r = detectFabricatedTestingClaims(
      "Each model was tested 200 times under controlled conditions."
    );
    expect(r[0].category).toBe("quantified-trial");
  });

  it("flags 'tested over 50 products'", () => {
    const r = detectFabricatedTestingClaims(
      "We tested over 50 products before finalizing this guide."
    );
    expect(r).toHaveLength(1);
    expect(["quantified-trial", "first-person-test"]).toContain(r[0].category);
  });

  it("flags 'tested hundreds of products'", () => {
    const r = detectFabricatedTestingClaims(
      "Amelia has cared for thousands of cats and tested hundreds of products in real boarding facility conditions."
    );
    // Should hit. The "tested hundreds of products" trigger is the smoking
    // gun on the live author bio (html-builder.ts:1346 pre-fix).
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(
      r.some(
        (f) =>
          f.category === "quantified-trial" || f.category === "facility-trial"
      )
    ).toBe(true);
  });
});

describe("detectFabricatedTestingClaims — facility-trial", () => {
  it("flags 'in our boarding facility, we tested'", () => {
    const r = detectFabricatedTestingClaims(
      "In our boarding facility, we tested each box for two weeks."
    );
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(["facility-trial", "first-person-test"]).toContain(r[0].category);
  });

  it("flags 'resident cats trialed'", () => {
    const r = detectFabricatedTestingClaims(
      "Our resident cats trialed every option over a thirty-day period."
    );
    expect(r[0].category).toBe("facility-trial");
  });

  it("flags 'controlled boarding facility conditions'", () => {
    const r = detectFabricatedTestingClaims(
      "Rankings reflect observed behavior in controlled boarding facility conditions."
    );
    expect(r[0].category).toBe("facility-trial");
  });
});

describe("detectFabricatedTestingClaims — self-endorsement-claim", () => {
  it("flags 'she personally reviews and stands behind every product recommendation' — the live-corpus FTC violation found on 2026-06-04", () => {
    const liveBio =
      "Amelia Hartwell is a feline care specialist with over 15 years of professional experience at Cats Luv Us Boarding Hotel & Grooming in Laguna Niguel, California. She personally reviews and stands behind every product recommendation on this site, partnering with CatGPT — a proprietary AI tool built on the real-world knowledge of the Cats Luv Us team. Every review combines hands-on facility testing with AI-assisted research, cross-referenced against manufacturer data and veterinary literature.";
    const r = detectFabricatedTestingClaims(liveBio);
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(
      r.some(
        (f) =>
          f.category === "self-endorsement-claim" ||
          f.category === "hands-on-framing"
      )
    ).toBe(true);
  });

  it("flags 'personally tested every product'", () => {
    const r = detectFabricatedTestingClaims(
      "Amelia personally tested every product before adding it to this guide."
    );
    expect(r[0].category).toBe("self-endorsement-claim");
  });

  it("flags 'personally vetted each recommendation'", () => {
    const r = detectFabricatedTestingClaims(
      "Our team personally vetted each recommendation in this roundup."
    );
    expect(r[0].category).toBe("self-endorsement-claim");
  });

  it("flags 'stands behind every product'", () => {
    const r = detectFabricatedTestingClaims(
      "Amelia stands behind every product on this list."
    );
    expect(r[0].category).toBe("self-endorsement-claim");
  });

  it("flags 'stands behind every recommendation'", () => {
    const r = detectFabricatedTestingClaims(
      "Cats Luv Us stands behind every recommendation in this article."
    );
    expect(r[0].category).toBe("self-endorsement-claim");
  });

  it("flags 'hands-on facility testing with'", () => {
    const r = detectFabricatedTestingClaims(
      "Every review combines hands-on facility testing with AI-assisted research."
    );
    expect(r.length).toBeGreaterThanOrEqual(1);
    // Either hands-on-framing or self-endorsement-claim is acceptable
    // — both indicate the FTC violation.
    expect(
      ["hands-on-framing", "self-endorsement-claim"].includes(r[0].category)
    ).toBe(true);
  });

  it("flags 'personally verifies each pick'", () => {
    const r = detectFabricatedTestingClaims(
      "She personally verifies each pick in this guide before publishing."
    );
    expect(r[0].category).toBe("self-endorsement-claim");
  });
});

describe("detectFabricatedTestingClaims — clean negatives", () => {
  it("does NOT flag legitimate cat-care credentials", () => {
    expect(
      detectFabricatedTestingClaims(
        "Amelia has cared for thousands of cats over fifteen years."
      )
    ).toHaveLength(0);
  });

  it("does NOT flag editorial 'we recommend'", () => {
    expect(
      detectFabricatedTestingClaims(
        "We recommend choosing a model with a removable carbon filter."
      )
    ).toHaveLength(0);
  });

  it("does NOT flag third-party 'customers reported'", () => {
    expect(
      detectFabricatedTestingClaims(
        "Customers who tested the product reported quieter operation than expected."
      )
    ).toHaveLength(0);
  });

  it("does NOT flag generic 'hands-on cat-care experience'", () => {
    expect(
      detectFabricatedTestingClaims(
        "The team brings hands-on cat-care experience from years of daily boarding."
      )
    ).toHaveLength(0);
  });

  it("does NOT flag a bare mention of 'tested'", () => {
    expect(
      detectFabricatedTestingClaims(
        "The product has been tested for compliance with safety standards by the manufacturer."
      )
    ).toHaveLength(0);
  });

  it("does NOT flag generic 'we' usage", () => {
    expect(
      detectFabricatedTestingClaims(
        "We synthesize public product data and customer review aggregates."
      )
    ).toHaveLength(0);
  });
});

describe("TESTING_CLAIM_RE", () => {
  it("matches the body-wide yes/no signal used by SEO check #10", () => {
    expect(TESTING_CLAIM_RE.test("We tested every fountain for a week.")).toBe(
      true
    );
    expect(TESTING_CLAIM_RE.test("Field-tested across multiple breeds.")).toBe(
      true
    );
    expect(
      TESTING_CLAIM_RE.test(
        "Picks are synthesized from public product data and customer reviews."
      )
    ).toBe(false);
  });
});

describe("summarizeFabricatedTestingClaims", () => {
  it("returns '0 fabricated testing claims' on empty input", () => {
    expect(summarizeFabricatedTestingClaims([])).toBe(
      "0 fabricated testing claims"
    );
  });

  it("formats counts grouped by category, descending", () => {
    const summary = summarizeFabricatedTestingClaims([
      { category: "first-person-test", trigger: "we tested", sentence: "x" },
      { category: "first-person-test", trigger: "we tried", sentence: "y" },
      { category: "hands-on-framing", trigger: "field-tested", sentence: "z" }
    ]);
    expect(summary).toBe(
      "3 fabricated testing claim(s): first-person-test×2, hands-on-framing×1"
    );
  });
});

// ─── stripCompliantMethodologySections — FTC proximity exception ────────
// The `<section class="wc-methodology">` template emits a "We compared
// N products" claim followed by an explicit disclosure ("not physically
// tested" / "synthesized from public" / "review aggregates") in the same
// section. Per FTC 16 CFR Part 255, this satisfies the substantiation
// standard. The strip helper removes such compliant sections before
// detection; non-compliant sections and any text outside the section
// remain in scope and still trip the detector.

describe("stripCompliantMethodologySections — proximity exception", () => {
  const compliantSection = `
    <section class="wc-methodology">
      <h2>How We Picked</h2>
      <p>We compared 5 cat scratcher products sold on Amazon. For each pick we weighed:</p>
      <ul>
        <li>Manufacturer specifications.</li>
        <li>Customer review signal.</li>
      </ul>
      <p>Picks are synthesized from public product data and review aggregates. Products are not physically tested by Cats Luv Us.</p>
    </section>`;

  it("strips a compliant wc-methodology section entirely (FTC-compliant case)", () => {
    const out = stripCompliantMethodologySections(compliantSection);
    expect(out.trim()).toBe("");
    // And the detector sees nothing → zero findings.
    expect(detectFabricatedTestingClaims(out)).toHaveLength(0);
  });

  it("leaves a non-compliant wc-methodology section in place (no disclosure → still flags)", () => {
    const nonCompliant = `
      <section class="wc-methodology">
        <h2>How We Picked</h2>
        <p>We compared 5 cat scratcher products sold on Amazon.</p>
        <ul><li>Some criterion.</li></ul>
      </section>`;
    const out = stripCompliantMethodologySections(nonCompliant);
    expect(out).toBe(nonCompliant);
    // Detector still sees the "we compared" line.
    const text = out.replace(/<[^>]+>/g, " ");
    expect(detectFabricatedTestingClaims(text).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it("leaves text OUTSIDE any wc-methodology section in scope (page-level disclosure does NOT cover unrelated claims)", () => {
    // The compliant wc-methodology section is present (its claim is
    // exempted), but a separate paragraph elsewhere on the page contains
    // a fabricated claim. The exception must NOT cover the outside claim.
    const html = `
      ${compliantSection}
      <section class="article-body">
        <p>We tested every fountain in our boarding facility over six weeks.</p>
      </section>`;
    const stripped = stripCompliantMethodologySections(html);
    const text = stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const findings = detectFabricatedTestingClaims(text);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => /tested/i.test(f.trigger))).toBe(true);
  });

  it("does NOT exempt a different section that copies the wc-methodology disclosure text", () => {
    // A non-methodology section happens to contain the disclosure
    // phrase. The exception scope must NOT widen to it. Only the
    // literal class `wc-methodology` is recognized.
    const html = `
      <section class="random-block">
        <p>We compared 5 products. Products are not physically tested by Cats Luv Us.</p>
      </section>`;
    const stripped = stripCompliantMethodologySections(html);
    expect(stripped).toBe(html); // unchanged
    const text = stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(detectFabricatedTestingClaims(text).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it("does NOT exempt a wc-methodology section that LACKS any disclosure marker", () => {
    const html = `
      <section class="wc-methodology">
        <h2>How We Picked</h2>
        <p>We compared 5 cat scratcher products sold on Amazon.</p>
        <p>For each we weighed dimensions and price.</p>
      </section>`;
    expect(stripCompliantMethodologySections(html)).toBe(html);
  });

  it("strips multiple compliant wc-methodology sections independently", () => {
    const html = `${compliantSection}<p>middle prose</p>${compliantSection}`;
    const out = stripCompliantMethodologySections(html);
    expect(out).not.toContain("wc-methodology");
    expect(out).toContain("middle prose");
  });

  it("preserves middle-of-page text when only the methodology section is exempt", () => {
    const html = `<p>Intro that mentions cared-for thousands of cats.</p>${compliantSection}<p>Outro recommending a filter.</p>`;
    const out = stripCompliantMethodologySections(html);
    expect(out).toContain("Intro that mentions cared-for thousands of cats");
    expect(out).toContain("Outro recommending a filter");
    expect(out).not.toContain("We compared");
  });

  it("is a no-op on empty / malformed input", () => {
    expect(stripCompliantMethodologySections("")).toBe("");
    // @ts-expect-error — runtime guard test
    expect(stripCompliantMethodologySections(null)).toBe(null);
  });
});

describe("stripCompliantMethodologySections — disclosure-marker variants", () => {
  const baseClaim = `<section class="wc-methodology"><p>We compared 5 products.</p>`;

  it("recognizes 'not physically tested' as a disclosure", () => {
    const html = `${baseClaim}<p>Products are not physically tested by Cats Luv Us.</p></section>`;
    expect(stripCompliantMethodologySections(html).trim()).toBe("");
  });

  it("recognizes 'synthesized from public' as a disclosure", () => {
    const html = `${baseClaim}<p>Picks are synthesized from public Amazon listings.</p></section>`;
    expect(stripCompliantMethodologySections(html).trim()).toBe("");
  });

  it("recognizes 'review aggregates' as a disclosure", () => {
    const html = `${baseClaim}<p>Rankings reflect customer review aggregates only.</p></section>`;
    expect(stripCompliantMethodologySections(html).trim()).toBe("");
  });

  it("does NOT recognize an unrelated phrase as a disclosure", () => {
    const html = `${baseClaim}<p>We are a cat-care company.</p></section>`;
    expect(stripCompliantMethodologySections(html)).toBe(html);
  });
});

// ─── removeFabricatedTestingSentences — deterministic FTC backstop ──────────
// Added 2026-07: this exported function had zero test coverage despite being the
// last-resort FTC 16 CFR Part 255 compliance gate that fires when the LLM-based
// Polish Agent is unavailable. The docstring cites a live 2026-06-11 incident
// where FTC violations shipped because the model layer was down.

describe("removeFabricatedTestingSentences — basic removal", () => {
  it("removes a fabricated sentence and preserves surrounding content", () => {
    const sentence =
      "She personally reviews and stands behind every product recommendation.";
    const html = `<p>Safe intro text. ${sentence} Safe outro text.</p>`;
    const findings = detectFabricatedTestingClaims(sentence);
    expect(findings).toHaveLength(1);
    const { html: out, removed } = removeFabricatedTestingSentences(
      html,
      findings
    );
    expect(removed).toBe(1);
    expect(out).not.toContain("stands behind every product");
    expect(out).toContain("Safe intro text.");
    expect(out).toContain("Safe outro text.");
  });

  it("returns unchanged html and removed=0 for empty findings", () => {
    const html = "<p>No fabricated claims here at all.</p>";
    const { html: out, removed } = removeFabricatedTestingSentences(html, []);
    expect(out).toBe(html);
    expect(removed).toBe(0);
  });

  it("returns empty string and removed=0 when html is empty", () => {
    const findings = detectFabricatedTestingClaims(
      "We tested every cat fountain for two weeks."
    );
    expect(findings.length).toBeGreaterThan(0);
    const { html: out, removed } = removeFabricatedTestingSentences(
      "",
      findings
    );
    expect(out).toBe("");
    expect(removed).toBe(0);
  });

  it("skips a finding whose sentence splits to fewer than 4 words", () => {
    // The function guards: `if (words.length < 4) continue`. This is tested
    // by constructing a finding manually since detectFabricatedTestingClaims
    // only emits sentences ≥ 20 chars, and 3-word sentences are typically short.
    const finding: FabricatedTestingClaimFinding = {
      category: "first-person-test",
      trigger: "we tested",
      sentence: "We tested thoroughly." // 3 words after split
    };
    const html = "<p>We tested thoroughly. Other safe content stays here.</p>";
    const { html: out, removed } = removeFabricatedTestingSentences(html, [
      finding
    ]);
    expect(removed).toBe(0);
    expect(out).toBe(html);
  });

  it("tolerates inline tags (em/strong) between words when matching", () => {
    const plainSentence = "We tested every cat fountain for two weeks.";
    const htmlSentence = "We <em>tested</em> every cat fountain for two weeks.";
    const html = `<p>${htmlSentence} Unrelated trailing content here.</p>`;
    const findings = detectFabricatedTestingClaims(plainSentence);
    expect(findings).toHaveLength(1);
    const { html: out, removed } = removeFabricatedTestingSentences(
      html,
      findings
    );
    expect(removed).toBe(1);
    expect(out).toContain("Unrelated trailing content here.");
    expect(out).not.toContain("tested</em> every cat fountain");
  });

  it("removes multiple fabricated sentences and returns the correct count", () => {
    const s1 = "We tested every litter box on the market over six months.";
    const s2 =
      "Our team evaluated every product against the same five criteria.";
    const html = [
      `<p>${s1}</p>`,
      `<p>${s2}</p>`,
      "<p>Clean editorial content remains untouched throughout.</p>"
    ].join("\n");
    const findings = [
      ...detectFabricatedTestingClaims(s1),
      ...detectFabricatedTestingClaims(s2)
    ];
    expect(findings).toHaveLength(2);
    const { html: out, removed } = removeFabricatedTestingSentences(
      html,
      findings
    );
    expect(removed).toBe(2);
    expect(out).toContain("Clean editorial content remains untouched");
    expect(out).not.toContain("tested every litter box");
    expect(out).not.toContain("evaluated every product");
  });
});
