import { describe, expect, it } from "vitest";
import {
  analyzeContentQuality,
  analyzeReadability,
  summarizeContentQuality
} from "../content-quality";

// analyzeContentQuality is a deterministic detector for process language —
// prose that exposes the writing process ("this guide", "at the time of
// writing", "we chose") instead of serving the reader — plus readability
// metrics. Ported from every-app/sam's publish-readiness/readability
// analyzers (MIT) and adapted to rendered-HTML input.

function page({
  intro = "<p>Hooded litter boxes cut tracking and contain odor. The right pick depends on your cat's size and your cleaning routine.</p>",
  sections = ""
}: { intro?: string; sections?: string } = {}) {
  return `<html><head><title>Best Hooded Litter Box</title></head><body>
<h1>Best Hooded Litter Box</h1>
<div class="introduction" itemprop="articleBody">${intro}</div>
${sections}
<h2>Conclusion</h2>
<p>Measure your cat before you buy and pick the larger size when in doubt.</p>
</body></html>`;
}

describe("analyzeReadability", () => {
  it("pins word, sentence, and long-sentence counts on a known fixture", () => {
    const text =
      "Cats need space. A hooded box that is too small for a large adult cat will push the cat to perch awkwardly on the entry lip and scatter litter across the floor every single day. Pick a bigger box.";
    const r = analyzeReadability(text, 2);
    expect(r.sentenceCount).toBe(3);
    expect(r.words).toBe(39);
    // Middle sentence has 32 words — the only one at/over the 25-word bar.
    expect(r.longSentences).toBe(1);
    expect(r.paragraphCount).toBe(2);
    expect(r.averageSentenceLength).toBe(13);
    expect(r.averageParagraphLength).toBe(1.5);
  });

  it("returns zeros on empty input", () => {
    const r = analyzeReadability("", 0);
    expect(r.words).toBe(0);
    expect(r.sentenceCount).toBe(0);
    expect(r.averageSentenceLength).toBe(0);
    expect(r.complexWordRate).toBe(0);
  });

  it("counts complex words (10+ chars, non-stopword) into the rate", () => {
    const r = analyzeReadability(
      "Straightforward maintenance considerations dominate everything.",
      1
    );
    expect(r.complexWordRate).toBeGreaterThan(0);
  });
});

describe("analyzeContentQuality — process language", () => {
  it("flags 'at the time of writing' sentences as findings", () => {
    const report = analyzeContentQuality(
      page({
        sections:
          "<h2>What to Look For</h2><p>At the time of writing, most hooded boxes use the same carbon filter design across brands.</p>"
      })
    );
    const temporal = report.findings.filter(
      (f) => f.category === "temporal-qualifier"
    );
    expect(temporal).toHaveLength(1);
    expect(temporal[0].snippet).toContain("At the time of writing");
  });

  it("flags writer-process and curation language", () => {
    const report = analyzeContentQuality(
      page({
        sections:
          "<h2>Options</h2><p>We excluded every box under twenty inches because large cats cannot turn around in them.</p><p>This curated shortlist focuses on covered designs only, nothing else made the cut.</p>"
      })
    );
    const categories = report.findings.map((f) => f.category);
    expect(categories).toContain("writer-process");
    expect(categories).toContain("curation");
  });

  it("flags process-note headings and raises a heading issue", () => {
    const report = analyzeContentQuality(
      page({
        sections:
          "<h2>How We Chose These Boxes</h2><p>Large boxes suit large cats better than compact ones in every scenario we describe below.</p>"
      })
    );
    expect(report.findings.some((f) => f.category === "meta-heading")).toBe(
      true
    );
    expect(
      report.issues.some((i) => i.includes("internal process notes"))
    ).toBe(true);
  });

  it("raises an intro issue when two process patterns appear in the intro", () => {
    const report = analyzeContentQuality(
      page({
        intro:
          "<p>This guide explains hooded litter boxes in detail. We chose covered designs because most owners fight litter scatter daily.</p>"
      })
    );
    expect(report.issues.some((i) => i.includes("process language"))).toBe(
      true
    );
  });

  it("raises a consolidation issue at three distinct body patterns", () => {
    const report = analyzeContentQuality(
      page({
        sections:
          "<h2>Details</h2>" +
          "<p>At the time of writing, filters are interchangeable between most major brands on the market.</p>" +
          "<p>We excluded open pans from consideration because they do nothing to contain litter scatter.</p>" +
          "<p>Our methodology weighted odor control twice as heavily as any other single factor here.</p>"
      })
    );
    expect(
      report.issues.some((i) =>
        i.includes("repeated methodology or exclusion language")
      )
    ).toBe(true);
  });

  it("flags an intro that exceeds 220 words", () => {
    const longIntro = `<p>${Array(230).fill("word").join(" ")}.</p>`;
    const report = analyzeContentQuality(page({ intro: longIntro }));
    expect(report.introWords).toBeGreaterThan(220);
    expect(report.issues.some((i) => i.includes("Get to the answer"))).toBe(
      true
    );
  });

  it("reads the full intro past a nested div (callout/badge)", () => {
    // A non-greedy </div> capture would truncate at the callout's close and
    // miss the trailing paragraph — including its process language.
    const report = analyzeContentQuality(
      page({
        intro:
          "<p>Hooded boxes contain scatter.</p>" +
          '<div class="callout"><p>Vet tip: pick a box one and a half times your cat\'s length.</p></div>' +
          "<p>At the time of writing, most models on this list share the same filter design, which we chose deliberately.</p>"
      })
    );
    expect(report.introWords).toBeGreaterThan(30);
    expect(report.issues.some((i) => i.includes("process language"))).toBe(
      true
    );
  });
});

describe("analyzeContentQuality — template chrome exemptions", () => {
  const methodologyBox = `<section class="wc-methodology" style="margin:32px 0">
  <h2>How We Picked</h2>
  <p>We compared 8 hooded litter boxes sold on Amazon. For each pick we weighed manufacturer specifications and customer review signal.</p>
  <p>Picks are synthesized from public product data. No physical product trials are conducted by Cats Luv Us.</p>
</section>`;

  it("never fires on the wc-methodology template box", () => {
    const report = analyzeContentQuality(page({ sections: methodologyBox }));
    expect(report.findings).toHaveLength(0);
    expect(report.issues).toHaveLength(0);
  });

  it("still fires on process language outside the methodology box", () => {
    const report = analyzeContentQuality(
      page({
        sections:
          methodologyBox +
          "<h2>Sizing</h2><p>At the time of writing, jumbo boxes remain the safest choice for Maine Coons and similar breeds.</p>"
      })
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].category).toBe("temporal-qualifier");
  });

  it("ignores the table-of-contents nav", () => {
    const report = analyzeContentQuality(
      page({
        sections:
          '<nav class="toc" aria-label="Table of Contents"><ul><li><a href="#a">How We Chose These Boxes</a></li></ul></nav>' +
          "<h2>Sizing</h2><p>Jumbo boxes remain the safest choice for Maine Coons and similar large breeds.</p>"
      })
    );
    expect(report.findings).toHaveLength(0);
  });
});

describe("analyzeContentQuality — clean article", () => {
  it("returns no findings or issues on reader-facing prose", () => {
    const report = analyzeContentQuality(
      page({
        sections:
          "<h2>What to Look For</h2><p>A wide entry keeps senior cats comfortable, and a tall hood stops over-the-edge spray.</p>" +
          "<h2>Why we like this pick</h2><p>Why we like this pick: solves daily scooping drudgery, keeps odor contained, ideal for busy single-cat owners.</p>"
      })
    );
    expect(report.findings).toHaveLength(0);
    expect(report.issues).toHaveLength(0);
    expect(report.readability.words).toBeGreaterThan(0);
  });

  it("summarizeContentQuality renders a one-line metric summary", () => {
    const report = analyzeContentQuality(page());
    const summary = summarizeContentQuality(report);
    expect(summary).toContain("words");
    expect(summary).toContain("process-language finding(s)");
  });
});
