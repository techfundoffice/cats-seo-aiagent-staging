import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchViaApify } from "../amazon";

const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * Drives the real shipped `fetchViaApify` entry point with a mocked Apify
 * API that mirrors junglee/Amazon-crawler success responses. Proves:
 * - actor id is junglee~amazon-crawler (not the dead gajo-cz actor)
 * - search uses Amazon search URLs
 * - junglee field shapes map to ASIN affiliate URLs
 * - dog-only + invalid ASIN rows are dropped
 */
describe("fetchViaApify (junglee Amazon-crawler)", () => {
  it("maps junglee dataset items to products with real ASIN affiliate URLs", async () => {
    const warnings: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("junglee~amazon-crawler") && url.includes("/runs")) {
        expect(url).not.toContain("gajo-cz");
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          categoryOrProductUrls?: Array<{ url: string }>;
        };
        expect(body.categoryOrProductUrls?.[0]?.url).toContain(
          "amazon.com/s?k="
        );
        expect(decodeURIComponent(body.categoryOrProductUrls?.[0]?.url ?? "")).toContain(
          "cat water fountain"
        );
        return new Response(
          JSON.stringify({
            data: {
              id: "run-test-1",
              status: "SUCCEEDED",
              defaultDatasetId: "ds-test-1"
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/datasets/ds-test-1/items")) {
        return new Response(
          JSON.stringify([
            {
              asin: "B08NCDBT7Q",
              title: "Veken Cat Water Fountain 95oz Automatic",
              price: { value: 29.99, currency: "$" },
              stars: 4.4,
              reviewsCount: 12034,
              imageUrl: "https://m.media-amazon.com/images/I/example.jpg"
            },
            {
              asin: "NOTVALID",
              title: "Broken ASIN row must be dropped",
              price: { value: 1, currency: "$" },
              stars: 5,
              reviewsCount: 1
            },
            {
              // valid ASIN shape but dog-only title → filtered
              asin: "B0DOGONLY1",
              title: "Premium Dog Water Bowl Dispenser",
              price: { value: 19.99, currency: "$" },
              stars: 4,
              reviewsCount: 50
            },
            {
              asin: "b0dzwwpgdn",
              title: "Veken Cat Fountain Detachable Tank",
              price: { value: 18.99, currency: "$" },
              stars: 4.2,
              reviewsCount: 1523,
              imageUrl: "https://m.media-amazon.com/images/I/example2.jpg"
            }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(`unexpected url ${url}`, { status: 500 });
    }) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const products = await fetchViaApify(
      "cat water fountain",
      "apify_test_token",
      "catsluvus03-20",
      (msg) => warnings.push(msg)
    );

    expect(warnings).toEqual([]);
    expect(fetchMock).toHaveBeenCalled();
    expect(products.length).toBe(2);
    expect(products[0].asin).toBe("B08NCDBT7Q");
    expect(products[0].url).toBe(
      "https://www.amazon.com/dp/B08NCDBT7Q?tag=catsluvus03-20"
    );
    expect(products[0].name).toContain("Veken");
    expect(products[0].ratingValue).toBe(4.4);
    expect(products[0].reviewCount).toBe(12034);
    expect(products[0].source).toBe("apify");

    // lowercased ASIN normalized
    expect(products[1].asin).toBe("B0DZWWPGDN");
    expect(products[1].url).toContain("/dp/B0DZWWPGDN?tag=catsluvus03-20");

    // dog-only and invalid ASIN excluded
    expect(products.every((p) => /^[A-Z0-9]{10}$/.test(p.asin ?? ""))).toBe(
      true
    );
    expect(products.some((p) => /dog/i.test(p.name))).toBe(false);
  });

  it("returns [] and warns when the Apify actor is missing (404)", async () => {
    const warnings: string[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              type: "record-not-found",
              message: "Actor with this name was not found"
            }
          }),
          { status: 404, statusText: "Not Found" }
        )
      );

    const products = await fetchViaApify(
      "best cat water fountain",
      "apify_test_token",
      "catsluvus03-20",
      (msg) => warnings.push(msg)
    );

    expect(products).toEqual([]);
    expect(warnings.some((w) => w.includes("404"))).toBe(true);
  });
});
