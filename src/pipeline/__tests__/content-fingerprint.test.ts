import { describe, expect, it, vi } from "vitest";
import {
  checkContentFingerprint,
  normalizeForFingerprint
} from "../content-fingerprint";

describe("normalizeForFingerprint", () => {
  it("strips tags, decodes entities, and collapses whitespace", () => {
    expect(
      normalizeForFingerprint(
        `<p>Best&nbsp;Cats &amp; Kittens &lt;3</p>\n<div>  Ready </div>`
      )
    ).toBe("best cats & kittens <3 ready");
  });
});

describe("checkContentFingerprint", () => {
  it("retries a rendered mismatch before failing", async () => {
    const render = vi
      .fn()
      .mockResolvedValueOnce({
        html: "<html><head><title>Best Cat Mobility Cart for Hind Legs: 2026 Top 4 Picks</title></head><body><h1>Best Cat Mobility Cart for Hind Legs: 2026 Top 4 Picks</h1><p>Older intro copy only.</p></body></html>"
      })
      .mockResolvedValueOnce({
        html: "<html><head><title>Best Cat Mobility Cart for Hind Legs: 2026 Top 4 Picks</title></head><body><p>Pet wheelchair | cat wheelchair for back legs | mobility aid for pets with disabilities helps support recovery.</p></body></html>"
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onWarning = vi.fn();

    const result = await checkContentFingerprint({
      titleFingerprint: normalizeForFingerprint(
        "Best Cat Mobility Cart for Hind Legs: 2026 Top 4 Picks"
      ),
      bodyFingerprint: normalizeForFingerprint(
        "Pet wheelchair | cat wheelchair for back legs | mobility aid for pets with disabilities"
      ).slice(0, 80),
      bodyFingerprintSource: "intro",
      render,
      sleep,
      onWarning
    });

    expect(result).toEqual({
      ok: true,
      renderedLength: expect.any(Number)
    });
    expect(render).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      "Content fingerprint attempt 1 rendered HTML missing [body:intro]"
    );
  });

  it("returns the persistent missing fingerprint when every attempt mismatches", async () => {
    const render = vi.fn().mockResolvedValue({
      html: "<html><body><h1>Wrong title</h1><p>Wrong body.</p></body></html>"
    });

    const result = await checkContentFingerprint({
      titleFingerprint: normalizeForFingerprint("Expected title"),
      bodyFingerprint: normalizeForFingerprint(
        "Expected intro body fingerprint text"
      ),
      bodyFingerprintSource: "intro",
      render,
      sleep: vi.fn().mockResolvedValue(undefined)
    });

    expect(result).toEqual({
      ok: false,
      skipped: false,
      missing: "title,body:intro",
      renderedLength: expect.any(Number)
    });
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("skips the gate when rendering never returns html", async () => {
    const render = vi.fn().mockResolvedValue({
      html: null,
      error: "HTTP 502"
    });

    const result = await checkContentFingerprint({
      titleFingerprint: "title",
      bodyFingerprint: "this body fingerprint is definitely long enough",
      bodyFingerprintSource: "intro",
      render,
      sleep: vi.fn().mockResolvedValue(undefined)
    });

    expect(result).toEqual({
      ok: false,
      skipped: true,
      lastRenderError: "HTTP 502"
    });
    expect(render).toHaveBeenCalledTimes(3);
  });
});
