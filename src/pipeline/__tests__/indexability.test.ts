import { describe, expect, it } from "vitest";
import { detectNoindex } from "../indexability";

const INDEXABLE_HEAD = `<!DOCTYPE html><html><head>
<title>Best Cat Litter Boxes</title>
<link rel="canonical" href="https://catsluvus.com/cat-litter/best-boxes">
<meta name="robots" content="index, follow">
</head><body><h1>Best Cat Litter Boxes</h1></body></html>`;

describe("detectNoindex — the shipping default", () => {
  it("treats the pipeline's standard `index, follow` article as indexable", () => {
    const result = detectNoindex(INDEXABLE_HEAD);
    expect(result.noindex).toBe(false);
    expect(result.blockedBy).toHaveLength(0);
    expect(result.detail).toContain("indexable");
  });

  it("treats a page with no robots directives at all as indexable", () => {
    const result = detectNoindex("<html><head></head><body>hi</body></html>");
    expect(result.noindex).toBe(false);
    expect(result.directives).toHaveLength(0);
  });
});

describe("detectNoindex — meta tag forms", () => {
  it("flags `<meta name=robots content=noindex>`", () => {
    const result = detectNoindex('<meta name="robots" content="noindex">');
    expect(result.noindex).toBe(true);
    expect(result.blockedBy[0].source).toBe("meta-robots");
  });

  it("flags `noindex` bundled with other directives", () => {
    const result = detectNoindex(
      '<meta name="robots" content="noindex, nofollow, noarchive">'
    );
    expect(result.noindex).toBe(true);
  });

  it("flags `none`, which is shorthand for noindex+nofollow", () => {
    const result = detectNoindex('<meta name="robots" content="none">');
    expect(result.noindex).toBe(true);
  });

  it("flags a googlebot-scoped noindex", () => {
    const result = detectNoindex('<meta name="googlebot" content="noindex">');
    expect(result.noindex).toBe(true);
    expect(result.blockedBy[0].source).toBe("meta-googlebot");
  });

  it("is case-insensitive and tolerates single quotes", () => {
    const result = detectNoindex("<META NAME='ROBOTS' CONTENT='NoIndex'>");
    expect(result.noindex).toBe(true);
  });

  it("does not care about attribute order", () => {
    const result = detectNoindex('<meta content="noindex" name="robots">');
    expect(result.noindex).toBe(true);
  });

  it("ignores non-robots meta tags that merely contain the word", () => {
    const result = detectNoindex(
      '<meta name="description" content="how to noindex a page">'
    );
    expect(result.noindex).toBe(false);
  });

  it("does not treat `nofollow` alone as blocking indexation", () => {
    const result = detectNoindex('<meta name="robots" content="nofollow">');
    expect(result.noindex).toBe(false);
    expect(result.directives).toHaveLength(1);
  });

  it("does not let `max-snippet:-1` masquerade as a directive value", () => {
    const result = detectNoindex(
      '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">'
    );
    expect(result.noindex).toBe(false);
  });
});

describe("detectNoindex — X-Robots-Tag header", () => {
  it("flags a bare `X-Robots-Tag: noindex`, invisible in the HTML", () => {
    const result = detectNoindex(
      INDEXABLE_HEAD,
      new Headers({ "x-robots-tag": "noindex" })
    );
    expect(result.noindex).toBe(true);
    expect(result.blockedBy[0].source).toBe("x-robots-tag");
  });

  it("flags a googlebot-scoped header directive", () => {
    const result = detectNoindex(
      INDEXABLE_HEAD,
      new Headers({ "x-robots-tag": "googlebot: noindex, nofollow" })
    );
    expect(result.noindex).toBe(true);
  });

  it("ignores a directive scoped to a non-Google crawler", () => {
    const result = detectNoindex(
      INDEXABLE_HEAD,
      new Headers({ "x-robots-tag": "bingbot: noindex" })
    );
    expect(result.noindex).toBe(false);
  });

  it("accepts a plain object of headers with any casing", () => {
    const result = detectNoindex(INDEXABLE_HEAD, { "X-Robots-Tag": "none" });
    expect(result.noindex).toBe(true);
  });

  it("handles a null/absent header bag", () => {
    expect(detectNoindex(INDEXABLE_HEAD, null).noindex).toBe(false);
    expect(detectNoindex(INDEXABLE_HEAD).noindex).toBe(false);
  });
});

describe("detectNoindex — unavailable_after", () => {
  it("reports a scheduled drop without calling the page noindex today", () => {
    const result = detectNoindex(
      '<meta name="robots" content="index, unavailable_after: 2030-01-01T00:00:00Z">'
    );
    expect(result.noindex).toBe(false);
    expect(result.unavailableAfter).toHaveLength(1);
    expect(result.detail).toContain("scheduled to drop");
  });

  it("does not mistake the date's colons for a user-agent scope in a header", () => {
    const result = detectNoindex(
      INDEXABLE_HEAD,
      new Headers({
        "x-robots-tag": "unavailable_after: 25 Jun 2030 15:00:00 PST"
      })
    );
    expect(result.noindex).toBe(false);
    expect(result.unavailableAfter).toHaveLength(1);
  });
});

describe("detectNoindex — regression guards for real pipeline output", () => {
  it("passes a page carrying both a canonical and `index, follow`", () => {
    // The canonical+noindex contradiction is scorecard check 98; this asserts
    // the healthy shape that check expects to see.
    const result = detectNoindex(INDEXABLE_HEAD);
    expect(result.noindex).toBe(false);
  });

  it("catches a noindex added anywhere in the document, not just <head>", () => {
    const result = detectNoindex(
      `${INDEXABLE_HEAD}<meta name="robots" content="noindex">`
    );
    expect(result.noindex).toBe(true);
  });

  it("reports every source when more than one blocks", () => {
    const result = detectNoindex(
      '<meta name="robots" content="noindex"><meta name="googlebot" content="none">',
      new Headers({ "x-robots-tag": "noindex" })
    );
    expect(new Set(result.blockedBy.map((d) => d.source)).size).toBe(3);
  });
});
