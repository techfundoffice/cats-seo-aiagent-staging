import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBestsellersByBrowseNode } from "../amazon";

describe("fetchBestsellersByBrowseNode", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockJsonResponse(body: unknown, ok = true, status = 200) {
    return {
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as Response;
  }

  it("sends BrowseNodeId (not Keywords) in the request payload", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ SearchResult: { Items: [] } })
    );

    await fetchBestsellersByBrowseNode(
      "2975241011",
      "AKIA_TEST",
      "secret-test",
      "catsluvus03-20"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://webservices.amazon.com/paapi5/searchitems");
    const body = JSON.parse(init.body as string);
    expect(body.BrowseNodeId).toBe("2975241011");
    expect(body).not.toHaveProperty("Keywords");
    expect(body.PartnerTag).toBe("catsluvus03-20");
    expect(body.PartnerType).toBe("Associates");
    expect(typeof body.ItemCount).toBe("number");
  });

  it("signs the request with an AWS4-HMAC-SHA256 authorization header", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ SearchResult: { Items: [] } })
    );

    await fetchBestsellersByBrowseNode(
      "2975241011",
      "AKIA_TEST",
      "secret-test",
      "catsluvus03-20"
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA_TEST\//
    );
    expect(headers["x-amz-target"]).toBe(
      "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems"
    );
  });

  it("parses real products out of a realistic PA API response shape", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        SearchResult: {
          Items: [
            {
              ASIN: "b0abcdefgh".toUpperCase(),
              ItemInfo: {
                Title: { DisplayValue: "Cat Scratching Post Deluxe" },
                Features: { DisplayValues: ["Sisal rope", "36 inches tall"] },
                ByLineInfo: { Brand: { DisplayValue: "Acme Pets" } }
              },
              Offers: {
                Listings: [
                  { Price: { DisplayAmount: "$39.99", Amount: 39.99 } }
                ]
              },
              Images: {
                Primary: {
                  Large: { URL: "https://example.com/large.jpg" },
                  Medium: { URL: "https://example.com/medium.jpg" }
                }
              },
              CustomerReviews: { StarRating: { Value: 4.5 }, Count: 1203 }
            }
          ]
        }
      })
    );

    const products = await fetchBestsellersByBrowseNode(
      "2975241011",
      "AKIA_TEST",
      "secret-test",
      "catsluvus03-20"
    );

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      name: "Cat Scratching Post Deluxe",
      asin: "B0ABCDEFGH",
      brand: "Acme Pets",
      ratingValue: 4.5,
      reviewCount: 1203,
      source: "pa-api-v5",
      url: "https://www.amazon.com/dp/B0ABCDEFGH?tag=catsluvus03-20"
    });
  });

  it("drops items with a missing or malformed ASIN", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        SearchResult: {
          Items: [
            { ASIN: "", ItemInfo: { Title: { DisplayValue: "No ASIN" } } },
            {
              ASIN: "short",
              ItemInfo: { Title: { DisplayValue: "Bad ASIN" } }
            }
          ]
        }
      })
    );

    const products = await fetchBestsellersByBrowseNode(
      "2975241011",
      "AKIA_TEST",
      "secret-test",
      "catsluvus03-20"
    );

    expect(products).toHaveLength(0);
  });

  it("drops items with no title", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        SearchResult: {
          Items: [{ ASIN: "B0ABCDEFGH", ItemInfo: {} }]
        }
      })
    );

    const products = await fetchBestsellersByBrowseNode(
      "2975241011",
      "AKIA_TEST",
      "secret-test",
      "catsluvus03-20"
    );

    expect(products).toHaveLength(0);
  });

  it("returns an empty array and does not throw on a non-ok response", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(
        { Errors: [{ Message: "InvalidParameterValue" }] },
        false,
        400
      )
    );

    const products = await fetchBestsellersByBrowseNode(
      "2975241011",
      "AKIA_TEST",
      "secret-test",
      "catsluvus03-20"
    );

    expect(products).toEqual([]);
  });

  it("returns an empty array and does not throw when fetch itself rejects", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const products = await fetchBestsellersByBrowseNode(
      "2975241011",
      "AKIA_TEST",
      "secret-test",
      "catsluvus03-20"
    );

    expect(products).toEqual([]);
  });

  it("suppresses the price display when PA API returns no dollar amount", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        SearchResult: {
          Items: [
            {
              ASIN: "B0ABCDEFGH",
              ItemInfo: { Title: { DisplayValue: "No Price Product" } }
            }
          ]
        }
      })
    );

    const products = await fetchBestsellersByBrowseNode(
      "2975241011",
      "AKIA_TEST",
      "secret-test",
      "catsluvus03-20"
    );

    expect(products).toHaveLength(1);
    expect(products[0].price).toBe("");
    expect(products[0].priceValue).toBe(0);
  });
});
