/**
 * Article writes require at least one real Amazon ASIN.
 * An empty catalog is a failed run — never a decision-framework stub.
 */

const ASIN_RE = /^[A-Z0-9]{10}$/;

export const NO_AMAZON_PRODUCTS_ABORT_MESSAGE =
  "No Amazon products found for this keyword — write aborted. Pick a real product keyword.";

export const NO_AMAZON_PRODUCTS_BANNER_TITLE =
  "No Amazon products — write aborted";

export const NO_AMAZON_PRODUCTS_HOW_TO_FIX =
  "Generate 1 writes only after Amazon returns a real ASIN. Refill the Cat A–Z catalog or pick a keyword that matches a live cat product.";

export function hasRealAmazonProduct(
  products: ReadonlyArray<{ asin?: string | null }>
): boolean {
  return products.some((product) => {
    const asin = (product.asin ?? "").trim().toUpperCase();
    return ASIN_RE.test(asin);
  });
}

export function isNoAmazonProductsAbort(
  error: string | null | undefined
): boolean {
  return (error ?? "").includes(NO_AMAZON_PRODUCTS_ABORT_MESSAGE);
}
