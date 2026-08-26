export type ArticleCssPatchResult = {
  patched: string;
  fixes: string[];
};

/**
 * Applies stored-article CSS fixes used by `/api/patch-css` and
 * `/api/patch-css-all`.
 */
export function applyArticleCssFixes(html: string): ArticleCssPatchResult {
  let patched = html;
  const fixes: string[] = [];

  if (patched.includes("word-break:break-all")) {
    const before = patched;
    patched = patched.replace(
      /a\{([^}]*?)word-break:break-all([^}]*?)\}/g,
      (_m, innerBefore, innerAfter) =>
        `a{${innerBefore}word-break:break-word${innerAfter}}`
    );
    if (patched !== before) {
      fixes.push("a{word-break:break-all} → word-break:break-word");
    }
  }

  if (!patched.includes("flex-shrink:0") && /\.amazon-btn\s*\{/.test(patched)) {
    const before = patched;
    patched = patched.replace(
      /\.amazon-btn\s*\{([^}]*?)(white-space:nowrap)([^}]*?)\}/g,
      (_m, innerBefore, whiteSpace, innerAfter) =>
        `.amazon-btn{${innerBefore}${whiteSpace}${innerAfter}word-break:normal;overflow-wrap:normal;flex-shrink:0}`
    );
    if (patched !== before) {
      fixes.push(".amazon-btn: added flex-shrink:0, word-break:normal");
    }
  }

  let pickNamePatched = false;
  patched = patched.replace(/\.pick-name\s*\{([^}]*?)\}/g, (match, inner) => {
    if (inner.includes("word-break")) return match;
    pickNamePatched = true;
    return `.pick-name{${inner}word-break:break-word}`;
  });
  if (pickNamePatched) {
    fixes.push(".pick-name: added word-break:break-word");
  }

  return { patched, fixes };
}

/**
 * Marker for the fold fix below. Presence makes the patch idempotent, so
 * repeated audit passes on the same article never stack duplicate rules.
 */
export const FOLD_FIX_MARKER = "clu-fold-fix";

export interface ConversionCssOptions {
  /**
   * Cap the hero image on small viewports so a product and a buy button
   * reach the first fold.
   *
   * The builder ships `.article-hero img{max-height:430px}`. On the 390x844
   * viewport the design audit screenshots, 430px is over half the fold
   * before site chrome, the affiliate bar, and the title are counted — so
   * the reader's first screen is frequently all picture and no product.
   * 200px leaves room for the title and the top of the content.
   */
  tightenMobileHero?: boolean;
}

/**
 * Layout fixes derived from a design audit's above-the-fold measurements.
 *
 * Kept separate from `applyArticleCssFixes` because these are *conditional*
 * — driven by what the vision audit measured on a specific article — while
 * that function is a set of unconditional repairs safe on any article.
 *
 * This is the destination the audit's non-content findings never had: an
 * issue categorised `layout` or `mobile` is `contentAddressable: false`, so
 * the Polish Agent skips it and, until now, nothing else picked it up.
 */
export function applyConversionCssFixes(
  html: string,
  opts: ConversionCssOptions
): ArticleCssPatchResult {
  let patched = html;
  const fixes: string[] = [];

  if (opts.tightenMobileHero && !patched.includes(FOLD_FIX_MARKER)) {
    const rule =
      `<style>/* ${FOLD_FIX_MARKER} */@media(max-width:480px){` +
      `.article-hero img{max-height:200px}` +
      `.article-hero{margin:0.75rem 0}` +
      `}</style>`;
    // Prefer </head>; fall back to prepending so a fragment without a head
    // still gets the rule rather than silently dropping it.
    if (/<\/head>/i.test(patched)) {
      patched = patched.replace(/<\/head>/i, `${rule}</head>`);
    } else {
      patched = rule + patched;
    }
    fixes.push("mobile fold: capped .article-hero img at 200px (was 430px)");
  }

  return { patched, fixes };
}
