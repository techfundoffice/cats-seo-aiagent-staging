import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchViaBrightData } from "../brightdata";

const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("fetchViaBrightData", () => {
  it("trims api keys before building the Authorization header", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    await fetchViaBrightData("https://example.com/source", {
      apiKey: "  test-key  ",
      zone: " custom-zone ",
      timeoutMs: 5000
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit | undefined
    ];

    expect(requestUrl).toBe("https://api.brightdata.com/request");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toContain("test-key");
    expect(headers.Authorization).not.toContain("  test-key  ");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      zone: "custom-zone",
      url: "https://example.com/source",
      format: "raw"
    });
  });

  it("uses the default zone when zone is blank", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    await fetchViaBrightData("https://example.com/source", {
      apiKey: "key",
      zone: "   "
    });

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit | undefined
    ];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      zone: "web_unlocker1"
    });
  });

  it("fails fast when apiKey is blank after trimming", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    await expect(
      fetchViaBrightData("https://example.com/source", {
        apiKey: "   "
      })
    ).rejects.toThrowError("BrightData apiKey is required");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
