import { describe, expect, it } from "vitest";
import { detectJsonSchemaLeak } from "../html-builder";

// Regression tests for the 2026-06-11 production leak: Kimi emitted
// pretty-printed JSON (spaces after colons) inside quickAnswer and
// introduction, and the compact-literal markers missed it at every
// layer — per-field sanitizer, distributed-leak counter, and the
// Step 14 publish gate.

describe("detectJsonSchemaLeak", () => {
  it("catches the compact form (original behavior)", () => {
    const html = `<p>{"title":"X","quickAnswer":"Y"}</p>`;
    expect(detectJsonSchemaLeak(html).leaked).toBe(true);
  });

  it("catches the pretty-printed form that shipped on 2026-06-11", () => {
    // Verbatim shape from the natural-cat-anxiety-diffuser-for-kittens
    // production page (spaces after colons).
    const html = `<div class="quick-answer"><strong>Quick Answer:</strong> { "title": "Natural Cat Anxiety Diffuser for Kittens (2026)", "metaDescription": "Discover the best natural cat anxiety diffuser.", "quickAnswer": "A natural cat a</div>`;
    const r = detectJsonSchemaLeak(html);
    expect(r.leaked).toBe(true);
    expect(r.markers.length).toBeGreaterThanOrEqual(2);
  });

  it("catches newline-separated pretty-printing", () => {
    const html = `<p>{\n  "title" : "X",\n  "introduction" : "Y"\n}</p>`;
    expect(detectJsonSchemaLeak(html).leaked).toBe(true);
  });

  it("does not flag clean prose mentioning one JSON key", () => {
    const html = `<p>The API returns a "title": "value" pair in its response.</p>`;
    expect(detectJsonSchemaLeak(html).leaked).toBe(false);
  });

  it("ignores markers inside script blocks (JSON-LD is legitimate)", () => {
    const html = `<script type="application/ld+json">{"title":"x","quickAnswer":"y","sections":[{}]}</script><p>clean</p>`;
    expect(detectJsonSchemaLeak(html).leaked).toBe(false);
  });
});
