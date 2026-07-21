import { describe, expect, it } from "vitest";
import {
  demoteBodyH1sToH2,
  deriveEntityNoun,
  deriveEntityNounPlural,
  deriveEntityPhrase,
  deriveMetaDescriptionFromIntro,
  normalizeHtmlWhitespace,
  normalizeTitle,
  truncateKeywordToWords
} from "../keyword-utils";

describe("normalizeHtmlWhitespace", () => {
  it("normalizes prose outside JSON-LD script blocks without mutating script content", () => {
    const jsonLd =
      '<script type="application/ld+json">{"text":"Keep ...   spacing","arr":["a...","b"]}</script>';
    const html = `<p>Alpha ...   beta !</p>${jsonLd}<p>Gamma   ?</p>`;

    expect(normalizeHtmlWhitespace(html)).toBe(
      `<p>Alpha … beta!</p>${jsonLd}<p>Gamma?</p>`
    );
  });

  it("preserves style blocks while normalizing surrounding HTML", () => {
    const style = '<style>.x::after{content:"...   "}</style>';
    const html = `${style}<div>A ...   B ,  C</div>`;

    expect(normalizeHtmlWhitespace(html)).toBe(`${style}<div>A … B, C</div>`);
  });

  it("collapses mixed tabs and spaces into single spaces", () => {
    const html = "<p>Alpha \t  beta\t gamma</p>";

    expect(normalizeHtmlWhitespace(html)).toBe("<p>Alpha beta gamma</p>");
  });
});

describe("normalizeTitle", () => {
  it("preserves a keyword that ends with trailing punctuation", () => {
    expect(normalizeTitle("Best   best-", "best-")).toBe("Best best-");
  });
});

describe("deriveEntityNoun", () => {
  it("strips 'v' shorthand comparison tails", () => {
    expect(deriveEntityNoun("cat wheelchair v dog wheelchair")).toBe(
      "cat wheelchair"
    );
  });
});

describe("demoteBodyH1sToH2", () => {
  it("returns an empty string unchanged", () => {
    expect(demoteBodyH1sToH2("")).toBe("");
  });

  it("leaves a fragment with no h1 elements unchanged", () => {
    const html = "<h2>Section</h2><p>Some content here.</p>";
    expect(demoteBodyH1sToH2(html)).toBe(html);
  });

  it("demotes a bare h1 open/close pair to h2", () => {
    expect(demoteBodyH1sToH2("<h1>Title</h1>")).toBe("<h2>Title</h2>");
  });

  it("preserves all attributes on the h1 opening tag", () => {
    expect(
      demoteBodyH1sToH2('<h1 class="hero" id="main-heading">Title</h1>')
    ).toBe('<h2 class="hero" id="main-heading">Title</h2>');
  });

  it("demotes multiple h1 elements in one pass", () => {
    const input = "<h1>First</h1><p>Para</p><h1>Second</h1>";
    expect(demoteBodyH1sToH2(input)).toBe(
      "<h2>First</h2><p>Para</p><h2>Second</h2>"
    );
  });

  it("is case-insensitive (handles uppercase H1 tags)", () => {
    expect(demoteBodyH1sToH2("<H1>Title</H1>")).toBe("<h2>Title</h2>");
  });

  it("handles self-closing-style closing tag with whitespace", () => {
    expect(demoteBodyH1sToH2("<h1>Title</h1 >")).toBe("<h2>Title</h2>");
  });
});

describe("deriveMetaDescriptionFromIntro", () => {
  it("returns empty string for empty input", () => {
    expect(deriveMetaDescriptionFromIntro("")).toBe("");
  });

  it("returns empty string when plain text is shorter than 50 chars", () => {
    expect(deriveMetaDescriptionFromIntro("Short text.")).toBe("");
  });

  it("strips HTML tags and decodes entities before measuring length", () => {
    // Tags are stripped; decoded plain text is only 11 chars — too short.
    const html = "<p><strong>Short</strong> &amp; sweet.</p>";
    expect(deriveMetaDescriptionFromIntro(html)).toBe("");
  });

  it("returns whole text truncated to maxChars when no sentence-ending punctuation", () => {
    // 60+ chars, no . ! ? — falls through to the raw-slice path.
    const text =
      "This intro has no sentence-ending punctuation so it goes to the slice path right here";
    const result = deriveMetaDescriptionFromIntro(text, 70);
    expect(result.length).toBeLessThanOrEqual(70);
    expect(result).toBe(text.slice(0, 70).trim());
  });

  it("returns a single sentence that fits within maxChars", () => {
    const sentence =
      "Compact cat travel bedding keeps your cat warm and secure on long international flights.";
    const result = deriveMetaDescriptionFromIntro(sentence);
    expect(result).toBe(sentence.trim());
  });

  it("accumulates multiple whole sentences up to maxChars", () => {
    const s1 = "Cats need comfortable travel bedding on long flights.";
    const s2 = "The right mat reduces anxiety and keeps your pet warm.";
    const s3 = "A compact design makes airline packing easier.";
    const input = `${s1} ${s2} ${s3}`;
    const result = deriveMetaDescriptionFromIntro(input, 155);
    // All three sentences fit comfortably within 155 chars.
    expect(result).toContain(s1);
    expect(result).toContain(s2);
    expect(result).toContain(s3);
    expect(result.length).toBeLessThanOrEqual(155);
  });

  it("stops accumulating when the next sentence would exceed maxChars", () => {
    const s1 = "Cats need comfortable travel bedding on long flights.";
    const s2 = "The right mat reduces anxiety and keeps your pet warm.";
    // This third sentence would push beyond a tight maxChars budget.
    const s3 =
      "An overly long sentence that definitely would not fit in a tight budget at all.";
    const input = `${s1} ${s2} ${s3}`;
    // maxChars set so s1+s2 just fit but s1+s2+s3 does not.
    const budget = (s1 + " " + s2).length + 5;
    const result = deriveMetaDescriptionFromIntro(input, budget);
    expect(result).toContain(s1);
    expect(result).toContain(s2);
    expect(result).not.toContain(s3);
  });

  it("hard-truncates at a word boundary when the first sentence exceeds maxChars", () => {
    // A single very long sentence that exceeds a small maxChars.
    const longSentence =
      "This is a very long first sentence that goes well beyond the tight character budget we have set.";
    const result = deriveMetaDescriptionFromIntro(longSentence, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    // The cut must land at a word boundary — the character immediately
    // after the result in the source is a space (no mid-word chop).
    expect(longSentence[result.length]).toBe(" ");
  });

  it("respects a custom maxChars argument", () => {
    const text =
      "Travel bedding for cats should be compact and washable. Extra features like waterproofing are a bonus.";
    const result = deriveMetaDescriptionFromIntro(text, 60);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("falls back to raw text slice when accumulated sentences are below the 50-char floor", () => {
    // A very short first sentence followed by long text without punctuation.
    // The short sentence alone is below 50 chars, so the fallback raw slice
    // is used instead.
    const shortSentence = "Cats love warmth.";
    const longTail =
      "  But choosing the right compact bedding for international air travel is a more nuanced decision";
    const input = shortSentence + longTail;
    const result = deriveMetaDescriptionFromIntro(input, 155);
    // The raw-slice path should return something ≥50 chars.
    expect(result.length).toBeGreaterThanOrEqual(50);
  });
});

describe("truncateKeywordToWords", () => {
  it("returns empty string for empty input", () => {
    expect(truncateKeywordToWords("", 6)).toBe("");
  });

  it("returns empty string when maxWords is zero", () => {
    expect(truncateKeywordToWords("best cat fountain", 0)).toBe("");
  });

  it("returns empty string when maxWords is negative", () => {
    expect(truncateKeywordToWords("best cat fountain", -1)).toBe("");
  });

  it("returns the full keyword when word count is within maxWords", () => {
    expect(truncateKeywordToWords("best cat fountain", 6)).toBe(
      "best cat fountain"
    );
  });

  it("returns the full keyword when word count exactly equals maxWords", () => {
    expect(truncateKeywordToWords("best cat fountain", 3)).toBe(
      "best cat fountain"
    );
  });

  it("truncates to the first N words when keyword exceeds maxWords", () => {
    expect(
      truncateKeywordToWords(
        "best boredom relief cat dispenser for indoor cats",
        5
      )
    ).toBe("best boredom relief cat dispenser");
  });

  it("trims leading and trailing whitespace before splitting", () => {
    expect(truncateKeywordToWords("  best cat fountain  ", 2)).toBe("best cat");
  });

  it("collapses internal whitespace when splitting", () => {
    expect(truncateKeywordToWords("best  cat\t fountain", 2)).toBe("best cat");
  });

  it("returns empty string when input is all whitespace", () => {
    expect(truncateKeywordToWords("   ", 5)).toBe("");
  });
});

describe("deriveEntityPhrase", () => {
  it("strips a leading 'best' superlative", () => {
    expect(deriveEntityPhrase("best cat tree")).toBe("cat tree");
  });

  it("strips 'the best' prefix", () => {
    expect(deriveEntityPhrase("the best automatic litter box")).toBe(
      "automatic litter box"
    );
  });

  it("strips a leading 'Top' superlative", () => {
    expect(deriveEntityPhrase("Top cat fountain")).toBe("cat fountain");
  });

  it("strips chained superlatives ('Top best')", () => {
    expect(deriveEntityPhrase("Top best litter box")).toBe("litter box");
  });

  it("preserves a non-superlative prefix like 'Premium'", () => {
    expect(deriveEntityPhrase("Premium cat harness for airline travel")).toBe(
      "Premium cat harness for airline travel"
    );
  });

  it("returns empty string for empty input", () => {
    expect(deriveEntityPhrase("")).toBe("");
  });

  it("preserves audience and travel modifiers (they are not superlatives)", () => {
    expect(deriveEntityPhrase("cat carrier for international flights")).toBe(
      "cat carrier for international flights"
    );
  });
});

describe("deriveEntityNounPlural", () => {
  it("pluralizes a basic noun phrase", () => {
    expect(deriveEntityNounPlural("cat tree")).toBe("cat trees");
  });

  it("pluralizes box → boxes", () => {
    expect(deriveEntityNounPlural("automatic litter box")).toBe(
      "automatic litter boxes"
    );
  });

  it("pluralizes brush → brushes", () => {
    expect(deriveEntityNounPlural("interactive brush")).toBe(
      "interactive brushes"
    );
  });

  it("does not double-pluralize an already-plural noun", () => {
    expect(deriveEntityNounPlural("cat toys")).toBe("cat toys");
  });

  it("strips leading superlative then pluralizes", () => {
    expect(deriveEntityNounPlural("best cat fountain for indoor cats")).toBe(
      "cat fountains"
    );
  });

  it("strips 'for airline travel' and pluralizes the core noun", () => {
    // Without the travel-modifier strip, this would incorrectly produce
    // "Premium cat flight harness for airline travels".
    expect(
      deriveEntityNounPlural("Premium cat flight harness for airline travel")
    ).toBe("Premium cat flight harnesses");
  });

  it("strips 'for international flights' and pluralizes the core noun", () => {
    expect(
      deriveEntityNounPlural("best cat carrier for international flights")
    ).toBe("cat carriers");
  });

  it("strips 'for long-haul travel' and pluralizes the core noun", () => {
    expect(deriveEntityNounPlural("cat bed for long-haul travel")).toBe(
      "cat beds"
    );
  });

  it("pluralizes study → studies (consonant-y rule)", () => {
    expect(deriveEntityNounPlural("cat behaviour study")).toBe(
      "cat behaviour studies"
    );
  });

  it("pluralizes harness → harnesses (ss-ending falls through to +es)", () => {
    expect(deriveEntityNounPlural("cat harness")).toBe("cat harnesses");
  });
});
