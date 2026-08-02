import { describe, expect, it } from "vitest";
import {
  buildEmptySitemap,
  SITEMAP_CACHE_MAX_AGE,
  SITEMAP_KV_KEY
} from "../indexing";

/**
 * Regression guards for the `/sitemap.xml` route.
 *
 * The bug these lock down: robots.txt advertised `/sitemap.xml`, but no route
 * served it, so the request fell through to the SPA/asset handler and
 * returned the dashboard **login page with HTTP 200**. Crawlers read that as
 * a malformed sitemap and discarded it, making every published URL invisible
 * to sitemap-based discovery — while `updateSitemap()` had been correctly
 * maintaining the document in KV the whole time.
 */
describe("sitemap KV key", () => {
  it("is the exact key updateSitemap() writes", () => {
    // Drift between writer and reader silently yields an empty sitemap.
    expect(SITEMAP_KV_KEY).toBe("sitemap:flat-sitemap");
  });
});

describe("buildEmptySitemap", () => {
  const empty = buildEmptySitemap();

  it("is a well-formed XML document, not an HTML page", () => {
    expect(empty.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(
      true
    );
    expect(empty).not.toMatch(/<!doctype html>/i);
    expect(empty).not.toMatch(/<html/i);
  });

  it("declares the sitemap protocol namespace", () => {
    expect(empty).toContain(
      'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'
    );
  });

  it("opens and closes <urlset> so parsers see a complete document", () => {
    expect(empty).toContain("<urlset");
    expect(empty).toContain("</urlset>");
  });

  it("contains no <url> entries", () => {
    expect(empty).not.toContain("<url>");
    expect(empty).not.toContain("<loc>");
  });

  it("survives the same append that updateSitemap() performs", () => {
    // updateSitemap() inserts before `</urlset>`; an empty document must be a
    // valid starting point for that splice, not a dead end.
    const entry =
      "  <url><loc>https://example.com/a/b</loc><lastmod>2026-08-02</lastmod></url>\n";
    const updated = empty.replace("</urlset>", entry + "</urlset>");
    expect(updated).not.toBe(empty);
    expect(updated).toContain("<loc>https://example.com/a/b</loc>");
    expect(updated.endsWith("</urlset>")).toBe(true);
  });
});

describe("sitemap cache policy", () => {
  it("caches for one hour, matching robots.txt", () => {
    expect(SITEMAP_CACHE_MAX_AGE).toBe(3600);
  });

  it("is a positive integer usable in a Cache-Control header", () => {
    expect(Number.isInteger(SITEMAP_CACHE_MAX_AGE)).toBe(true);
    expect(SITEMAP_CACHE_MAX_AGE).toBeGreaterThan(0);
    expect(`public, max-age=${SITEMAP_CACHE_MAX_AGE}`).toBe(
      "public, max-age=3600"
    );
  });
});
