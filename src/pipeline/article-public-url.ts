/**
 * Public article URL shapes.
 *
 * KV keys stay `{category}:{slug}`. Staging workshop pages stay
 * two-segment `/{category}/{slug}`. Production (catsluvus.com) pages
 * promoted from this worker are `https://{host}/reviews/{category}/{slug}`.
 */

/** Path prefix inserted only on production article URLs. */
export const REVIEWS_PATH_PREFIX = "/reviews";

const REVIEWS_SEGMENT = "reviews";

export interface ParsedArticlePath {
  categorySlug: string;
  slug: string;
  /** True when the pathname already started with `/reviews/`. */
  reviewsPrefixed: boolean;
}

/**
 * Staging workshop path. Does not include `/reviews`.
 */
export function workshopArticlePath(
  categorySlug: string,
  slug: string
): string {
  return `/${categorySlug}/${slug}`;
}

/** Production article path: `/reviews/{category}/{slug}`. */
export function prodArticlePath(categorySlug: string, slug: string): string {
  return `${REVIEWS_PATH_PREFIX}/${categorySlug}/${slug}`;
}

/** `https://{host}/reviews/{category}/{slug}`. */
export function prodArticleUrl(
  host: string,
  categorySlug: string,
  slug: string
): string {
  return `https://${host}${prodArticlePath(categorySlug, slug)}`;
}

function bareHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

/**
 * Article path for `host`. Production hosts (catsluvus.com, or an explicit
 * promotion target) get `/reviews`; every other host stays two-segment.
 */
export function articlePathForHost(
  host: string,
  categorySlug: string,
  slug: string,
  productionHost = "catsluvus.com"
): string {
  const bare = bareHost(host);
  if (bare === bareHost(productionHost) || bare === "catsluvus.com") {
    return prodArticlePath(categorySlug, slug);
  }
  return workshopArticlePath(categorySlug, slug);
}

function splitPath(pathname: string): string[] {
  const clean = pathname.split("?")[0]?.split("#")[0] ?? "";
  const trimmed = clean.replace(/\/+$/, "");
  if (!trimmed) return [];
  return trimmed.split("/").filter((segment) => segment.length > 0);
}

/**
 * Map an article pathname to category + slug.
 *
 * Accepts the production form `/reviews/{category}/{slug}` and the legacy
 * two-segment form `/{category}/{slug}`. Other shapes (home, category
 * index, `/reviews` alone, deeper paths) return null.
 */
export function parseArticlePath(pathname: string): ParsedArticlePath | null {
  if (!pathname || typeof pathname !== "string") return null;
  const parts = splitPath(pathname);
  let reviewsPrefixed = false;
  if (parts.length === 3 && parts[0]?.toLowerCase() === REVIEWS_SEGMENT) {
    reviewsPrefixed = true;
    parts.shift();
  }
  if (parts.length !== 2) return null;
  const categorySlug = parts[0];
  const slug = parts[1];
  if (!categorySlug || !slug) return null;
  return { categorySlug, slug, reviewsPrefixed };
}

/** `/{category}/{slug}` or `/reviews/{category}/{slug}` → `category:slug`. */
export function articlePathToKvKey(pathname: string): string | null {
  const parsed = parseArticlePath(pathname);
  if (!parsed) return null;
  return `${parsed.categorySlug}:${parsed.slug}`;
}

/**
 * Insert `/reviews` in front of a two-segment article path.
 * Leaves other paths alone, including anything that already starts with
 * `/reviews`, so a second pass cannot double-prefix.
 * Query strings and hashes are preserved.
 */
export function prefixReviewsOnArticlePath(pathWithSuffix: string): string {
  const match = /^([^?#]*)([?#].*)?$/.exec(pathWithSuffix);
  if (!match) return pathWithSuffix;
  const path = match[1] ?? "";
  const suffix = match[2] ?? "";
  if (!path.startsWith("/")) return pathWithSuffix;

  const parts = splitPath(path);
  if (parts[0]?.toLowerCase() === REVIEWS_SEGMENT) {
    return pathWithSuffix;
  }
  if (parts.length !== 2) return pathWithSuffix;

  const trailing = path.length > 1 && path.endsWith("/") ? "/" : "";
  return `${REVIEWS_PATH_PREFIX}/${parts[0]}/${parts[1]}${trailing}${suffix}`;
}

/**
 * True when both absolute URLs identify the same article KV key,
 * whether or not one of them uses the `/reviews` prefix.
 */
export function articleUrlsShareKvKey(a: string, b: string): boolean {
  let pathA: string;
  let pathB: string;
  try {
    pathA = new URL(a).pathname;
    pathB = new URL(b).pathname;
  } catch {
    return false;
  }
  const keyA = articlePathToKvKey(pathA);
  const keyB = articlePathToKvKey(pathB);
  return keyA !== null && keyA === keyB;
}
