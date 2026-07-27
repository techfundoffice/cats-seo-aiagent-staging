import { describe, expect, it } from "vitest";
import {
  checkContentFingerprint,
  normalizeForFingerprint
} from "../content-fingerprint";

/**
 * Root cause of the 3 stranded articles on 2026-07-26/27.
 *
 * Kimi opens intros with a [PRODUCT_N] slot token — the raw output for
 * `ring pan-tilt indoor cam review` began literally:
 *
 *   <p>[PRODUCT_1] stands out in our cat camera lineup as the solution…
 *
 * The published HTML always carries the hydrated product name, so a
 * fingerprint taken from text still containing the token can only ever
 * produce a false mismatch — and the token sits inside the 80-char
 * window the gate inspects. Confirmed live: the article was complete and
 * correct, the intro present, the title matching, yet it never reached
 * production.
 */
const stripSlotTokens = (s: string) => s.replace(/\[PRODUCT_\d+\]/gi, " ");

describe("fingerprint slot-token stripping", () => {
  const rawIntro =
    "<p>[PRODUCT_1] stands out in our cat camera lineup as the solution for complete room coverage without hardware complexity.</p>";
  const publishedPage =
    "<title>Ring Pan-Tilt Indoor Cam Review (2026)</title>" +
    '<div class="introduction"><p>Ring Pan-Tilt Indoor Cam (newest model) stands out in our cat camera lineup as the solution for complete room coverage without hardware complexity.</p></div>';

  it("an un-stripped fingerprint false-mismatches against the real page", async () => {
    const bad = normalizeForFingerprint(rawIntro).slice(0, 80);
    expect(bad).toContain("[product_1]");
    expect(normalizeForFingerprint(publishedPage)).not.toContain(bad);
  });

  it("stripping the slot token makes the fingerprint match the real page", async () => {
    const good = normalizeForFingerprint(stripSlotTokens(rawIntro)).slice(
      0,
      80
    );
    expect(good).not.toContain("[product_1]");
    const result = await checkContentFingerprint({
      titleFingerprint: normalizeForFingerprint(
        "Ring Pan-Tilt Indoor Cam Review (2026)"
      ),
      bodyFingerprint: good,
      bodyFingerprintSource: "intro",
      render: async () => ({ html: publishedPage }),
      sleep: async () => {}
    });
    expect(result.ok).toBe(true);
  });

  it("reports body-only mismatch distinctly from a title mismatch", async () => {
    const bodyOnly = await checkContentFingerprint({
      titleFingerprint: normalizeForFingerprint(
        "Ring Pan-Tilt Indoor Cam Review (2026)"
      ),
      bodyFingerprint: "text that does not appear anywhere on the page at all",
      bodyFingerprintSource: "intro",
      render: async () => ({ html: publishedPage }),
      sleep: async () => {}
    });
    expect(bodyOnly.ok).toBe(false);
    if (!bodyOnly.ok && !bodyOnly.skipped) {
      // Title present => caller treats this as a source divergence, not a
      // bad publish, and must NOT strand the article.
      expect(bodyOnly.missing).toBe("body:intro");
      expect(bodyOnly.missing).not.toContain("title");
    }

    const wrongPage = await checkContentFingerprint({
      titleFingerprint: normalizeForFingerprint("A Totally Different Article"),
      bodyFingerprint: "text that does not appear anywhere on the page at all",
      bodyFingerprintSource: "intro",
      render: async () => ({ html: publishedPage }),
      sleep: async () => {}
    });
    expect(wrongPage.ok).toBe(false);
    if (!wrongPage.ok && !wrongPage.skipped) {
      // Title missing => genuinely the wrong page; still a hard failure.
      expect(wrongPage.missing).toContain("title");
    }
  });
});
