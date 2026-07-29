/**
 * trust-box-removal.ts — strip the "Why You Should Trust Us" block.
 *
 * The block was a free-text field (`article.whyTrustUs`) rendered inside
 * `<section class="wc-trust-box">`. Because the model wrote it fresh
 * every time, it kept manufacturing credentials the site does not have:
 *
 *   "Our staff includes certified feline behavior consultants and
 *    experienced installers."
 *   "We consulted with Dr. Sarah Chen, DVM, a veterinary behaviorist…"
 *   "Our team observes daily how different tools perform across diverse
 *    cat breeds…"
 *
 * Each variant was patched individually and the next generation invented
 * a new one. `html-builder.ts` no longer renders the block at all, which
 * fixes every future article; this module removes it from the ~500
 * already published.
 *
 * Removal is structural, not textual: the whole `<section>` goes,
 * heading and icon included. A heading-only match would leave the
 * paragraph orphaned under the previous section.
 */

/** The template's own block, the common case. */
const TRUST_BOX_SECTION_RE =
  /<section\b[^>]*\bclass="[^"]*\bwc-trust-box\b[^"]*"[^>]*>[\s\S]*?<\/section\s*>/gi;

/**
 * Fallback for articles a model rewrite reshaped — the class attribute
 * is gone but the heading survives. Matches from the heading (plus an
 * immediately preceding icon div, if any) up to the next heading or the
 * end of its container, so nothing after the block is swallowed.
 */
const TRUST_BOX_HEADING_RE =
  /(?:<div\b[^>]*>\s*(?:&#128300;|🔬)\s*<\/div>\s*)?<h[23]\b[^>]*>\s*(?:&#128300;|🔬)?\s*Why\s+You\s+Should\s+Trust\s+Us\s*<\/h[23]\s*>(?:(?!<h[1-6]\b)[\s\S])*?(?=<h[1-6]\b|<\/section\b|<\/div\b|$)/gi;

/**
 * The block's stylesheet rules, which live in the article's inline
 * `<style>`. They must be handled separately from the markup: a naive
 * "does the page mention wc-trust-box" check matches the CSS on EVERY
 * article, including ones whose block is already gone, and reports a
 * removal as leaving residue.
 */
const TRUST_BOX_CSS_RE = /\.wc-trust-(?:box|icon|content)\b[^{}]*\{[^}]*\}/gi;

/** Strip style and script bodies so their text is not read as content. */
function withoutStyleAndScript(html: string): string {
  return html.replace(
    /<style[^>]*>[\s\S]*?<\/style\s*>|<script[^>]*>[\s\S]*?<\/script\s*>/gi,
    " "
  );
}

/**
 * Honest disclosure text that models sometimes nested INSIDE the trust
 * box. Removing the section wholesale would delete it — and it is the
 * FTC language the page needs, not the fabricated part. Observed in 15
 * of 424 live blocks, e.g. "No free products were received, and our
 * Amazon affiliate relationship does not influence ranking order."
 */
const PRESERVE_MARKER_RE =
  /Editorial\s+Note|No\s+free\s+products|affiliate\s+relationship\s+does\s+not\s+influence|fact[- ]check|not\s+physically\s+tested|synthesized\s+from\s+public|do(?:es)?\s+not\s+receive\s+(?:free\s+)?samples/i;

/** Direct `<div>`/`<p>` children of a block, non-nested. */
const CHILD_BLOCK_RE = /<(div|p)\b[^>]*>(?:(?!<\1\b)[\s\S])*?<\/\1\s*>/gi;

/**
 * Given the inner HTML of a trust box, return the child blocks that
 * carry a disclosure and must survive its removal. The trust-box
 * heading and its own paragraph are never preserved.
 */
function extractPreservedChildren(inner: string): string {
  const keep: string[] = [];
  for (const m of inner.matchAll(CHILD_BLOCK_RE)) {
    const block = m[0];
    if (/Why\s+You\s+Should\s+Trust\s+Us/i.test(block)) continue;
    if (PRESERVE_MARKER_RE.test(block)) keep.push(block);
  }
  return keep.join("\n");
}

const TRUST_BOX_ORPHAN_HEADING_RE =
  /(?:&#128300;|🔬)?\s*Why\s+You\s+Should\s+Trust\s+Us\s*<\/h[23]\s*>(?:(?!<h[1-6]\b)[\s\S])*?(?=<h[1-6]\b|<\/section\b|<\/div\b|$)/gi;

export interface TrustBoxRemovalResult {
  html: string;
  /** How many blocks were removed. */
  removed: number;
}

/**
 * Remove every "Why You Should Trust Us" block from an article.
 * Idempotent and a no-op on articles that never had one.
 */
export function removeTrustBox(html: string): TrustBoxRemovalResult {
  if (!html || typeof html !== "string") return { html, removed: 0 };
  let removed = 0;
  let out = html.replace(TRUST_BOX_SECTION_RE, (section) => {
    removed++;
    // Keep any disclosure the model nested inside the block.
    return extractPreservedChildren(section);
  });
  if (/Why\s+You\s+Should\s+Trust\s+Us/i.test(out)) {
    out = out.replace(TRUST_BOX_HEADING_RE, () => {
      removed++;
      return "";
    });
  }
  // Last resort: an ORPHANED heading whose opening tag a model rewrite
  // consumed, leaving `Why You Should Trust Us</h2>` with nothing in
  // front of it. Observed live on one article whose preceding block had
  // swallowed the `<h2>`.
  if (/Why\s+You\s+Should\s+Trust\s+Us/i.test(out)) {
    out = out.replace(TRUST_BOX_ORPHAN_HEADING_RE, () => {
      removed++;
      return "";
    });
  }
  // The stylesheet rules go whether or not markup was found — they are
  // dead weight on every article once the block stops being rendered.
  const cssBefore = out;
  out = out.replace(TRUST_BOX_CSS_RE, "");
  const cssRemoved = out !== cssBefore;
  if (removed > 0 || cssRemoved) {
    // Tidy the wrappers the block sat in, and the icon if it was a
    // sibling rather than a child.
    out = out
      .replace(
        /<div\b[^>]*\bclass="[^"]*\bwc-trust-(?:icon|content)\b[^"]*"[^>]*>\s*<\/div\s*>/gi,
        ""
      )
      .replace(/<div\b[^>]*>\s*(?:&#128300;|🔬)\s*<\/div\s*>/gi, "")
      .replace(/<section\b[^>]*>\s*<\/section\s*>/gi, "")
      .replace(/<p\b[^>]*>\s*<\/p\s*>/gi, "")
      // An @media wrapper emptied by the CSS strip above.
      .replace(/@media[^{]*\{\s*\}/gi, "")
      .replace(/\n{3,}/g, "\n\n");
  }
  return { html: out, removed };
}

/** True when an article still carries a trust box. */
export function hasTrustBox(html: string): boolean {
  if (!html || typeof html !== "string") return false;
  const body = withoutStyleAndScript(html);
  return (
    /\bwc-trust-box\b/i.test(body) ||
    /Why\s+You\s+Should\s+Trust\s+Us/i.test(body)
  );
}
