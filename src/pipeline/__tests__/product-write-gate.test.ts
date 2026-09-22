import { describe, expect, it } from "vitest";
import {
  hasRealAmazonProduct,
  isNoAmazonProductsAbort,
  NO_AMAZON_PRODUCTS_ABORT_MESSAGE
} from "../product-write-gate";

describe("product write gate", () => {
  it("rejects an empty Amazon result", () => {
    expect(hasRealAmazonProduct([])).toBe(false);
    expect(hasRealAmazonProduct([{ asin: "" }, { asin: "not-an-asin" }])).toBe(
      false
    );
  });

  it("accepts one real ASIN", () => {
    expect(
      hasRealAmazonProduct([{ asin: "b0armham01" }, { asin: undefined }])
    ).toBe(true);
  });

  it("recognizes the abort message used to stop Generate 1", () => {
    expect(isNoAmazonProductsAbort(NO_AMAZON_PRODUCTS_ABORT_MESSAGE)).toBe(
      true
    );
    expect(isNoAmazonProductsAbort("Kimi K2.5 error: timeout")).toBe(false);
    expect(NO_AMAZON_PRODUCTS_ABORT_MESSAGE).toMatch(/write aborted/i);
    expect(NO_AMAZON_PRODUCTS_ABORT_MESSAGE).toMatch(/real product keyword/i);
  });
});
