import { describe, expect, it } from "vitest";
import { applyConversionCssFixes, FOLD_FIX_MARKER } from "../patch-css";

/** Mirrors the hero style the html-builder actually emits. */
const HERO_STYLE = `<style>.article-hero{margin:1.25rem 0}.article-hero img{width:100%;height:auto;max-height:430px;object-fit:cover;border-radius:12px;display:block}</style>`;
const PAGE = `<html><head><title>Best Cat Litter Boxes</title>${HERO_STYLE}</head><body><figure class="article-hero"><img src="hero.jpg" alt=""></figure><p>Body copy.</p></body></html>`;

describe("applyConversionCssFixes", () => {
  it("caps the mobile hero when the audit asks for it", () => {
    const { patched, fixes } = applyConversionCssFixes(PAGE, {
      tightenMobileHero: true
    });

    expect(patched).toContain("@media(max-width:480px)");
    expect(patched).toContain(".article-hero img{max-height:200px}");
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatch(/capped .article-hero img/);
  });

  it("injects inside <head> so the rule wins the cascade", () => {
    const { patched } = applyConversionCssFixes(PAGE, {
      tightenMobileHero: true
    });

    const injectedAt = patched.indexOf(FOLD_FIX_MARKER);
    const headCloses = patched.indexOf("</head>");
    const builderStyleAt = patched.indexOf("max-height:430px");

    expect(injectedAt).toBeGreaterThan(-1);
    expect(injectedAt).toBeLessThan(headCloses);
    // Must come after the builder's own rule, or equal specificity would
    // leave the 430px cap winning by source order.
    expect(injectedAt).toBeGreaterThan(builderStyleAt);
  });

  it("does nothing when the audit did not ask for it", () => {
    const { patched, fixes } = applyConversionCssFixes(PAGE, {});

    expect(patched).toBe(PAGE);
    expect(fixes).toEqual([]);
  });

  it("is idempotent — repeated audits never stack the rule", () => {
    const once = applyConversionCssFixes(PAGE, { tightenMobileHero: true });
    const twice = applyConversionCssFixes(once.patched, {
      tightenMobileHero: true
    });

    expect(twice.patched).toBe(once.patched);
    expect(twice.fixes).toEqual([]);
    expect(once.patched.split(FOLD_FIX_MARKER)).toHaveLength(2);
  });

  it("still applies to a fragment with no <head>", () => {
    const fragment = `<figure class="article-hero"><img src="h.jpg" alt=""></figure>`;

    const { patched, fixes } = applyConversionCssFixes(fragment, {
      tightenMobileHero: true
    });

    expect(patched).toContain(FOLD_FIX_MARKER);
    expect(patched).toContain(fragment);
    expect(fixes).toHaveLength(1);
  });

  it("leaves the article's own markup untouched", () => {
    const { patched } = applyConversionCssFixes(PAGE, {
      tightenMobileHero: true
    });

    expect(patched).toContain("<p>Body copy.</p>");
    expect(patched).toContain('<figure class="article-hero">');
    // The builder's original rule is preserved; the override rides on top
    // rather than rewriting what is already there.
    expect(patched).toContain("max-height:430px");
  });
});
