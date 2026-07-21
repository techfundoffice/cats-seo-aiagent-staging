import { describe, expect, it } from "vitest";
import {
  applyTestingVocabSwap,
  neutralizeTestingHeadings,
  replaceCasePreserving
} from "../testing-vocab-swap";

// Tests the word-boundary swap used by /api/admin/replace-testing-vocabulary.
// Two priorities: (1) case-preservation must be byte-faithful, and (2) the
// skip rules (JSON-LD vs JS scripts, href/src attrs, safelist phrases) must
// not be widened by accident — those rules ARE the safety guarantees that
// let this endpoint run against ~4,213 live articles.

describe("replaceCasePreserving", () => {
  it("lowercase match → lowercase replacement", () => {
    expect(replaceCasePreserving("we tested it", "Tested", "Compared")).toBe(
      "we compared it"
    );
  });
  it("title-case match → title-case replacement", () => {
    expect(replaceCasePreserving("Tested by us", "Tested", "Compared")).toBe(
      "Compared by us"
    );
  });
  it("ALL-CAPS match → ALL-CAPS replacement", () => {
    expect(replaceCasePreserving("THIS TESTED OK", "Tested", "Compared")).toBe(
      "THIS COMPARED OK"
    );
  });
  it("toWord case is normalized — caller can pass any case", () => {
    // Regression test for the bug found 2026-06-09 smoke audit:
    // passing capital-C "Compared" used to leak as the fallback for
    // lowercase matches, producing "top-Compared" instead of
    // "top-compared".
    expect(
      replaceCasePreserving("top-tested picks", "Tested", "Compared")
    ).toBe("top-compared picks");
    expect(
      replaceCasePreserving("top-tested picks", "Tested", "COMPARED")
    ).toBe("top-compared picks");
    expect(
      replaceCasePreserving("top-tested picks", "Tested", "compared")
    ).toBe("top-compared picks");
  });
  it("respects word boundaries — does not match inside other words", () => {
    expect(
      replaceCasePreserving("contested ground", "Tested", "Compared")
    ).toBe("contested ground");
    expect(replaceCasePreserving("untested theory", "Tested", "Compared")).toBe(
      "untested theory"
    );
  });
  it("matches across hyphen boundary (top-tested, field-tested)", () => {
    expect(replaceCasePreserving("field-tested", "Tested", "Compared")).toBe(
      "field-compared"
    );
  });
});

describe("applyTestingVocabSwap — body prose substitution", () => {
  it("swaps Test/Testing/Tested in body text", () => {
    const html = `<p>We tested 5 products. Our testing showed clear results. The Test was definitive.</p>`;
    const out = applyTestingVocabSwap(html);
    expect(out).toBe(
      `<p>We compared 5 products. Our comparison showed clear results. The Compare was definitive.</p>`
    );
  });

  it('swaps inside JSON-LD <script type="application/ld+json">', () => {
    const html = `<script type="application/ld+json">{"@type":"Answer","text":"Based on our testing at the boarding facility, the top-rated pick wins."}</script>`;
    const out = applyTestingVocabSwap(html);
    expect(out).toContain(`"Based on our comparison at the boarding facility`);
    expect(out).not.toContain("testing");
    expect(out).not.toContain("tested");
  });

  it("swaps inside JSON-LD <script> tags with quoted, unquoted, and mixed-case type attributes", () => {
    const variants = [
      `<script Type=application/ld+json>{"@type":"Answer","text":"Our testing picked the safest gate."}</script>`,
      `<script type=Application/LD+JSON>{"@type":"Answer","text":"Our testing picked the safest gate."}</script>`,
      `<script type='Application/LD+JSON'>{"@type":"Answer","text":"Our testing picked the safest gate."}</script>`,
      `<script type="Application/LD+JSON">{"@type":"Answer","text":"Our testing picked the safest gate."}</script>`
    ];
    for (const html of variants) {
      const out = applyTestingVocabSwap(html);
      expect(out).toContain(`"Our comparison picked the safest gate."`);
      expect(out).not.toContain("testing");
    }
  });

  it("does NOT swap inside non-JSON-LD <script> blocks (real JavaScript stays verbatim)", () => {
    const html = `<script>var testFn = function() { return tested ? 1 : 0; };</script>`;
    const out = applyTestingVocabSwap(html);
    expect(out).toBe(html);
  });

  it("does NOT touch URL slugs inside href attributes", () => {
    const html = `<p>See <a href="https://catsluvus.com/cat-dna-test-kits-ancestry/">our DNA Test guide</a> for more.</p>`;
    const out = applyTestingVocabSwap(html);
    expect(out).toContain(
      `href="https://catsluvus.com/cat-dna-test-kits-ancestry/"`
    );
    // The link text "DNA Test" is in the safelist → preserved.
    expect(out).toContain(`our DNA Test guide`);
  });

  it("does NOT touch URL slugs inside unquoted href attributes", () => {
    const html = `<a href=https://example.com/path-with-test/page>test details</a>`;
    const out = applyTestingVocabSwap(html);
    expect(out).toContain(`href=https://example.com/path-with-test/page`);
    expect(out).toContain(`>compare details<`);
  });

  it("does NOT touch URL slugs inside src attributes", () => {
    const html = `<img src="https://example.com/path-with-test/image.png" alt="The test image">`;
    const out = applyTestingVocabSwap(html);
    expect(out).toContain(`src="https://example.com/path-with-test/image.png"`);
    // alt-text "The test image" → swapped (it's body-visible text).
    expect(out).toContain(`alt="The compare image"`);
  });

  it("preserves safelist phrases verbatim (case-sensitive entries match exact casing)", () => {
    const samples = [
      "Look for ISO tested durability",
      "FDA tested adhesives only",
      "Pet Tested brand wheels",
      "Cat DNA testing kits",
      "safety tested by the manufacturer"
    ];
    for (const s of samples) {
      const out = applyTestingVocabSwap(`<p>${s}</p>`);
      expect(out).toContain(s);
    }
  });

  it("swaps NEAR a safelist phrase without touching the phrase itself", () => {
    const html = `<p>We tested every option. ISO tested ratings show 5/5.</p>`;
    const out = applyTestingVocabSwap(html);
    expect(out).toBe(
      `<p>We compared every option. ISO tested ratings show 5/5.</p>`
    );
  });

  it("does not treat safelist phrases as substrings inside larger words", () => {
    const html = `<p>Our benefit testing protocol is transparent.</p>`;
    const out = applyTestingVocabSwap(html);
    expect(out).toBe(`<p>Our benefit comparison protocol is transparent.</p>`);
  });

  it("preserves case across all three morphologies in the live FAQ leak", () => {
    // The actual live-corpus violation from
    // best-cat-play-tunnels-for-senior-cats-comparison.
    const html = `<script type="application/ld+json">{"text":"Based on our testing at the boarding facility, the top-rated cat play tunnel balances safety, durability, and ease of cleaning."}</script>
    <meta name="description" content="Best cat play tunnels with 5 top-tested picks">`;
    const out = applyTestingVocabSwap(html);
    expect(out).toContain(`Based on our comparison at the boarding facility`);
    expect(out).toContain(`5 top-compared picks`);
    expect(out).not.toMatch(/\b(test|testing|tested)\b/i);
  });

  it("is byte-faithful on input with no test/testing/tested anywhere", () => {
    const html = `<p>Hello world. <a href="/cat-fountains/">Fountains</a> are the best.</p>`;
    expect(applyTestingVocabSwap(html)).toBe(html);
  });

  it("does not treat literal legacy placeholder text as internal stash tokens", () => {
    const html = `<p>Literal SAFE_0 URL_0 SCRIPT_0 markers should remain intact after we tested this.</p>`;
    expect(applyTestingVocabSwap(html)).toBe(
      `<p>Literal SAFE_0 URL_0 SCRIPT_0 markers should remain intact after we compared this.</p>`
    );
  });

  it("is a no-op on empty or non-string input", () => {
    expect(applyTestingVocabSwap("")).toBe("");
    // @ts-expect-error — runtime guard test
    expect(applyTestingVocabSwap(null)).toBe(null);
    // @ts-expect-error — runtime guard test
    expect(applyTestingVocabSwap(undefined)).toBe(undefined);
  });

  it("longest-morphology-first ordering — Testing swaps before Test", () => {
    // If "Test" ran first, it would turn "Testing" into "Compareing"
    // before the "Testing" pass had a chance. Order is enforced in
    // applyTestingVocabSwap; this test would catch a reorder regression.
    const html = `<p>Our testing was thorough.</p>`;
    expect(applyTestingVocabSwap(html)).toBe(
      `<p>Our comparison was thorough.</p>`
    );
  });
});

describe("neutralizeTestingHeadings", () => {
  it("swaps testing vocabulary inside an h2 and its TOC anchor, leaving body prose alone", () => {
    // Mirrors the 2026-06-11 "elevated cat bowl reviews" publish where
    // <h2>Our Testing Methodology…</h2> + its TOC twin shipped verbatim.
    const html = [
      `<li><a href="#section-10">Our Testing Methodology and Evaluation Criteria</a></li>`,
      `<h2>Our Testing Methodology and Evaluation Criteria</h2>`,
      `<p>We never claim product testing in body prose here.</p>`
    ].join("\n");
    const { html: out, changed } = neutralizeTestingHeadings(html);
    expect(changed).toBe(2);
    expect(out).toContain(
      `<a href="#section-10">Our Comparison Methodology and Evaluation Criteria</a>`
    );
    expect(out).toContain(
      `<h2>Our Comparison Methodology and Evaluation Criteria</h2>`
    );
    // Body prose untouched — only headings/TOC are in scope.
    expect(out).toContain(
      `<p>We never claim product testing in body prose here.</p>`
    );
  });

  it("respects the safelist inside headings (DNA test stays)", () => {
    const html = `<h2>Best DNA Test Kits for Cats</h2>`;
    const { html: out, changed } = neutralizeTestingHeadings(html);
    expect(changed).toBe(0);
    expect(out).toBe(html);
  });

  it("leaves headings without testing vocabulary untouched", () => {
    const html = `<h2>How to Choose the Right Elevated Bowl</h2><a href="#faq-section">Frequently Asked Questions</a>`;
    const { html: out, changed } = neutralizeTestingHeadings(html);
    expect(changed).toBe(0);
    expect(out).toBe(html);
  });

  it("does not touch external anchors — only in-page (#) TOC links", () => {
    const html = `<a href="https://example.com/lab-testing">independent lab testing</a>`;
    const { html: out, changed } = neutralizeTestingHeadings(html);
    expect(changed).toBe(0);
    expect(out).toBe(html);
  });
});
