import { afterEach, describe, expect, it, vi } from "vitest";
import { probeUrlHttpStatus } from "../articleUrlHttpStatus";

const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("probeUrlHttpStatus", () => {
  it("returns an empty sheet cell for blank, sentinel, and non-https URLs", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    await expect(probeUrlHttpStatus("")).resolves.toEqual({
      status: 0,
      sheetCell: ""
    });
    await expect(probeUrlHttpStatus("error")).resolves.toEqual({
      status: 0,
      sheetCell: ""
    });
    await expect(
      probeUrlHttpStatus("http://catsluvus.com/article")
    ).resolves.toEqual({
      status: 0,
      sheetCell: ""
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries with a ranged GET when HEAD is blocked", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    await expect(
      probeUrlHttpStatus("https://catsluvus.com/article", 2_500)
    ).resolves.toEqual({
      status: 200,
      sheetCell: "200"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://catsluvus.com/article",
      expect.objectContaining({ method: "HEAD", redirect: "follow" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://catsluvus.com/article",
      expect.objectContaining({
        method: "GET",
        redirect: "follow",
        headers: { Range: "bytes=0-0" }
      })
    );
  });

  it("uses a provided fetcher binding instead of global fetch", async () => {
    const globalFetchMock = vi.fn<typeof fetch>();
    (globalThis as { fetch: typeof fetch }).fetch = globalFetchMock;
    const fetcher = {
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    };

    await expect(
      probeUrlHttpStatus(
        "https://catsluvus.com/article",
        2_500,
        fetcher as unknown as Fetcher
      )
    ).resolves.toEqual({
      status: 204,
      sheetCell: "204"
    });

    expect(globalFetchMock).not.toHaveBeenCalled();
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(fetcher.fetch.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    expect(fetcher.fetch.mock.calls[0]?.[0]?.url).toBe(
      "https://catsluvus.com/article"
    );
    expect(fetcher.fetch.mock.calls[0]?.[0]?.method).toBe("HEAD");
  });
});
