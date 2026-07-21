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
