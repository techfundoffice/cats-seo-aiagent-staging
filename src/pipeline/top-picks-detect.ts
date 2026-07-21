/**
 * Honest "Our Top Picks" detection for Scorecard / eval jobs.
 *
 * The honesty empty strip still contains the words "Our Top Picks", so a
 * bare `/Our Top Picks/i` greps false-positive commercial success when
 * products.length === 0. Require a real affiliate product URL as well.
 */

const HONESTY_EMPTY =
  /doesn't have that section on purpose|we don't rank products we haven't verified/i;

const TOP_PICKS_MARKER =
  /class=["'][^"']*top-picks[^"']*["']|<h2[^>]*>\s*Our Top Picks\b|Our Top Picks/i;

const AMAZON_DP = /amazon\.com\/dp\/[A-Z0-9]{10}/i;

/**
 * True only when HTML has a real Top Picks section with ≥1 Amazon ASIN link
 * and is not the intentional empty-picks honesty copy.
 */
export function articleHasRealTopPicks(html: string | null | undefined): boolean {
  if (!html || html.length < 20) return false;
  if (HONESTY_EMPTY.test(html)) return false;
  if (!TOP_PICKS_MARKER.test(html)) return false;
  return AMAZON_DP.test(html);
}

/** Unique 10-char ASINs from amazon.com/dp/ links in HTML. */
export function extractProductAsins(html: string | null | undefined): string[] {
  if (!html) return [];
  const matches = html.match(/\/dp\/([A-Z0-9]{10})/gi) ?? [];
  return [
    ...new Set(matches.map((m) => m.slice(4).toUpperCase()))
  ];
}
