import { describe, expect, it } from "vitest";
import { applySerpSnippet, extractSerpSnippet } from "../idle-tick";

const PAGE = `<!DOCTYPE html><html><head>
<title>Old Boring Title</title>
<meta name="description" content="Old boring description.">
<meta property="og:title" content="Old Boring Title">
<meta property="og:description" content="Old boring description.">
</head><body><h1>Old Boring Title</h1><p>Body text stays.</p></body></html>`;

describe("extractSerpSnippet", () => {
  it("pulls the current title and meta description", () => {
    expect(extractSerpSnippet(PAGE)).toEqual({
      title: "Old Boring Title",
      metaDescription: "Old boring description."
    });
  });
});

describe("applySerpSnippet", () => {
  it("swaps title, meta description, and og mirrors — body untouched", () => {
    const out = applySerpSnippet(PAGE, extractSerpSnippet(PAGE), {
      title: "New Clickable Title",
      metaDescription: "New better promise."
    });
    expect(out).toContain("<title>New Clickable Title</title>");
    expect(out).toContain('content="New better promise."');
    expect(out).toContain('og:title" content="New Clickable Title"');
    // Body H1 keeps the on-page heading — head-only edit.
    expect(out).toContain("<h1>Old Boring Title</h1>");
    expect(out).toContain("Body text stays.");
    expect(out).not.toContain("<title>Old Boring Title</title>");
  });
});
