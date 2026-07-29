import { describe, expect, it } from "vitest";
import { isDataForSeoSerpQuotaError } from "../serp";
import { isIndexNowEligibleHost } from "../indexing";
import { enforceMetaSerpWindow } from "../title-meta-normalizer";
import { ensureWhyWeLikeMarker } from "../html-builder";
import { calculateSEOScore } from "../seo-score";

describe("isDataForSeoSerpQuotaError — live HTTP 402 shape", () => {
  it("matches HTTP 402 body prefix (live staging)", () => {
    expect(
      isDataForSeoSerpQuotaError(
        'HTTP 402: {"version":"0.1","status_code":20000}'
      )
    ).toBe(true);
  });
  it("matches HTTP 429", () => {
    expect(isDataForSeoSerpQuotaError("HTTP 429 Too Many Requests")).toBe(true);
  });
  it("matches status_code=40200", () => {
    expect(isDataForSeoSerpQuotaError("status_code=40200")).toBe(true);
  });
  it("does not match ordinary 500", () => {
    expect(isDataForSeoSerpQuotaError("HTTP 500 Internal")).toBe(false);
  });
});

describe("isIndexNowEligibleHost", () => {
  it("allows catsluvus.com", () => {
    expect(isIndexNowEligibleHost("catsluvus.com")).toBe(true);
  });
  it("allows www.catsluvus.com", () => {
    expect(isIndexNowEligibleHost("www.catsluvus.com")).toBe(true);
  });
  it("rejects staging workers.dev", () => {
    expect(
      isIndexNowEligibleHost(
        "cats-seo-aiagent-staging.webmaster-bc8.workers.dev"
      )
    ).toBe(false);
  });
  it("rejects empty", () => {
    expect(isIndexNowEligibleHost("")).toBe(false);
  });
});

describe("meta pads — no hands-on / facility testing language", () => {
  it("short meta pad never contains hands-on or we tested", () => {
    const r = enforceMetaSerpWindow("Short meta.", "best cat fountain");
    expect(r.meta.toLowerCase()).not.toMatch(/hands-on/);
    expect(r.meta.toLowerCase()).not.toMatch(/we tested/);
    expect(r.meta.toLowerCase()).not.toMatch(/facility testing/);
    expect(r.meta.length).toBeGreaterThanOrEqual(140);
  });
});

describe("ensureWhyWeLikeMarker — product metrics wired", () => {
  it("includes Rated line when ratingValue + reviewCount present", () => {
    const out = ensureWhyWeLikeMarker("", {
      keyword: "best cat carrier",
      productName: "Petmate Soft Carrier",
      ratingValue: 4.5,
      reviewCount: 1200,
      features: "Breathable mesh sides for airflow; Removable pad"
    });
    expect(out).toMatch(/Rated 4\.5\/5/);
    expect(out).toMatch(/1,200/);
    expect(out).toMatch(/Standout detail/);
    expect(out).toMatch(/Why we like this pick:/);
  });
});

describe("seo-score FTC alignment", () => {
  const baseHtml = (body: string) =>
    `<html><body><h1>Best Cat Fountain</h1>
    <div class="author-box">Amelia Hartwell</div>
    <p>Laguna Niguel Cats Luv Us Boarding Hotel.</p>
    ${body}
    <a href="https://www.amazon.com/dp/B00TEST1234?tag=catsluvus03-20">Buy</a>
    <div class="conclusion">Done.</div>
    </body></html>`;

  it("check #5 does not pass solely on we tested", () => {
    const html = baseHtml(
      `<p>We tested twelve fountains in our lab last week.</p>`
    );
    const score = calculateSEOScore(
      html,
      "best cat fountain",
      "Best Cat Fountain Guide 2026",
      "A long enough meta description about cat water fountains for multi-cat homes that passes the length floor easily.",
      1500
    );
    const c5 = score.checks.find((c) => c.id === 5);
    const c10 = score.checks.find((c) => c.id === 10);
    expect(c5?.passed).toBe(false);
    expect(c10?.passed).toBe(false);
  });

  it("check #63 fails on our testing language", () => {
    const html = baseHtml(
      `<p>Our testing showed the Quiet model wins for apartments.</p>`
    );
    const score = calculateSEOScore(
      html,
      "best cat fountain",
      "Best Cat Fountain Guide 2026",
      "A long enough meta description about cat water fountains for multi-cat homes that passes the length floor easily.",
      1500
    );
    const c63 = score.checks.find((c) => c.id === 63);
    expect(c63?.passed).toBe(false);
  });
});
