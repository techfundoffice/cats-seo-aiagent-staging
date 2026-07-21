import { describe, expect, it } from "vitest";
import {
  categorizeFailureMessage,
  formatBreakdownOneLine,
  isCredentialFailure,
  summarizeFailureBreakdown
} from "../failure-breakdown";

describe("categorizeFailureMessage — credential / provider failures", () => {
  it("flags OpenRouter credits-exhausted as credential-openrouter-credits", () => {
    expect(
      categorizeFailureMessage(
        "OpenRouter returned 402 — insufficient credits to complete request"
      )
    ).toBe("credential-openrouter-credits");
    expect(
      categorizeFailureMessage(
        "OpenRouter credits exhausted; switching to Workers AI"
      )
    ).toBe("credential-openrouter-credits");
  });

  it("flags OpenRouter 401 as credential-openrouter-401", () => {
    expect(
      categorizeFailureMessage(
        "OpenRouter HTTP 401: invalid API key — rotate OPENROUTER_API_KEY"
      )
    ).toBe("credential-openrouter-401");
  });

  it("flags Workers AI rate limiting as credential-workers-ai-rate", () => {
    expect(
      categorizeFailureMessage("Workers AI rate limit hit; quota exhausted")
    ).toBe("credential-workers-ai-rate");
    expect(categorizeFailureMessage("Workers AI 429 from Cloudflare")).toBe(
      "credential-workers-ai-rate"
    );
  });

  it("flags DataForSEO 401/403 as credential-dataforseo-401", () => {
    expect(
      categorizeFailureMessage("DataForSEO returned 401 unauthorized")
    ).toBe("credential-dataforseo-401");
  });

  it("flags Amazon InvalidToken / 401 as credential-amazon-401", () => {
    expect(
      categorizeFailureMessage("Amazon Creators API 401 InvalidToken")
    ).toBe("credential-amazon-401");
    expect(categorizeFailureMessage("Amazon PA API 403 Forbidden")).toBe(
      "credential-amazon-401"
    );
  });

  it("flags GitHub 401 as credential-github-401", () => {
    expect(categorizeFailureMessage("GitHub API 401 Bad credentials")).toBe(
      "credential-github-401"
    );
  });

  it("catches unknown credential-shaped errors as credential-other", () => {
    expect(
      categorizeFailureMessage("Random API key invalid for unknown service")
    ).toBe("credential-other");
    expect(
      categorizeFailureMessage("HTTP 401 from unidentified upstream")
    ).toBe("credential-other");
    expect(
      categorizeFailureMessage("HTTP 429 from unidentified upstream")
    ).toBe("credential-other");
  });
});

describe("categorizeFailureMessage — content / gate failures", () => {
  it("flags thin-content-word-count as content-thin", () => {
    expect(
      categorizeFailureMessage(
        "thin-content-word-count: 650 words (need 800 for informational)"
      )
    ).toBe("content-thin");
  });

  it("flags SEO regression as content-seo-regression", () => {
    expect(
      categorizeFailureMessage(
        "Editorial Agent [step 4/4]: rewrite rejected — SEO regression (old=99 new=92)"
      )
    ).toBe("content-seo-regression");
  });

  it("flags prepub-jsonld-severe as content-jsonld-severe", () => {
    expect(
      categorizeFailureMessage(
        "Step 14.5: classifyJsonLdSeverity returned severe; prepub-jsonld-severe defect recorded"
      )
    ).toBe("content-jsonld-severe");
  });

  it("flags plagiarism overlap as content-plagiarism", () => {
    expect(
      categorizeFailureMessage("plagiarism overlap 47% exceeds threshold")
    ).toBe("content-plagiarism");
    expect(categorizeFailureMessage("wirecutter voice detected")).toBe(
      "content-plagiarism"
    );
  });

  it("flags XSS gate as content-xss", () => {
    expect(
      categorizeFailureMessage(
        "Editorial Agent: rewrite rejected — XSS gate triggered on onerror= handler"
      )
    ).toBe("content-xss");
  });

  it("flags FTC gate as content-ftc-gate", () => {
    expect(
      categorizeFailureMessage(
        "Editorial Agent [step 4/4]: rewrite rejected — FTC gate: 1 first-person-test claim. Original stays live."
      )
    ).toBe("content-ftc-gate");
    expect(categorizeFailureMessage("ftc gate fired")).toBe("content-ftc-gate");
  });

  it("flags document-shape regression as content-document-shape", () => {
    expect(
      categorizeFailureMessage(
        "rewrite rejected — document shape regression: rewrite-fragment-not-document"
      )
    ).toBe("content-document-shape");
  });

  it("flags parser errors as content-parser-error", () => {
    expect(
      categorizeFailureMessage(
        "SyntaxError: Unexpected token in JSON at position 0"
      )
    ).toBe("content-parser-error");
    expect(categorizeFailureMessage("JSON.parse failed: invalid JSON")).toBe(
      "content-parser-error"
    );
  });

  it("flags missing-sections as content-no-sections", () => {
    expect(
      categorizeFailureMessage("No sections found in parsed article")
    ).toBe("content-no-sections");
  });

  it("flags fabricated Editorial Note as content-fabricated-editorial-note", () => {
    expect(
      categorizeFailureMessage(
        "editorial-note fabrication detected in quickAnswer"
      )
    ).toBe("content-fabricated-editorial-note");
    expect(
      categorizeFailureMessage("Editorial Integrity Note fabrication stripped")
    ).toBe("content-fabricated-editorial-note");
  });

  it("flags content fingerprint mismatch as content-fingerprint-mismatch", () => {
    expect(
      categorizeFailureMessage(
        "Content fingerprint mismatch: https://catsluvus.com/cat-window-perches/acrylic-perch renders but is missing [title, buyingGuide] from this article. KV write succeeded for cat-window-perches:acrylic-perch but the live page does not contain this article's content."
      )
    ).toBe("content-fingerprint-mismatch");
    expect(
      categorizeFailureMessage(
        "content fingerprint mismatch: live page missing expected content"
      )
    ).toBe("content-fingerprint-mismatch");
  });

  it("falls back to content-other for an unrecognized gate phrase", () => {
    expect(
      categorizeFailureMessage(
        "rewrite rejected for some defect not yet classified"
      )
    ).toBe("content-other");
  });

  it("does not misclassify non-failure rewrite warnings as content failures", () => {
    expect(
      categorizeFailureMessage(
        "Editorial Agent: ignored /api/admin/editorial-review applyFix=true; rewrite mode is disabled and runs are report-only"
      )
    ).toBe("unknown");
  });
});

describe("categorizeFailureMessage — edge cases", () => {
  it("returns 'unknown' for empty / non-string input", () => {
    expect(categorizeFailureMessage("")).toBe("unknown");
    expect(categorizeFailureMessage(null)).toBe("unknown");
    expect(categorizeFailureMessage(undefined)).toBe("unknown");
    expect(categorizeFailureMessage(42)).toBe("unknown");
    expect(categorizeFailureMessage({ foo: "bar" })).toBe("unknown");
  });

  it("returns 'unknown' for plain informational text", () => {
    expect(
      categorizeFailureMessage("Generated article for keyword 'cat fountain'")
    ).toBe("unknown");
  });
});

describe("isCredentialFailure", () => {
  it("returns true for every credential-* category", () => {
    expect(isCredentialFailure("credential-openrouter-credits")).toBe(true);
    expect(isCredentialFailure("credential-openrouter-401")).toBe(true);
    expect(isCredentialFailure("credential-workers-ai-rate")).toBe(true);
    expect(isCredentialFailure("credential-dataforseo-401")).toBe(true);
    expect(isCredentialFailure("credential-amazon-401")).toBe(true);
    expect(isCredentialFailure("credential-github-401")).toBe(true);
    expect(isCredentialFailure("credential-other")).toBe(true);
  });

  it("returns false for content-* and unknown", () => {
    expect(isCredentialFailure("content-thin")).toBe(false);
    expect(isCredentialFailure("content-seo-regression")).toBe(false);
    expect(isCredentialFailure("content-ftc-gate")).toBe(false);
    expect(isCredentialFailure("content-other")).toBe(false);
    expect(isCredentialFailure("unknown")).toBe(false);
  });
});

describe("summarizeFailureBreakdown", () => {
  it("returns zeros for empty input", () => {
    const r = summarizeFailureBreakdown([]);
    expect(r.total).toBe(0);
    expect(r.credentialCount).toBe(0);
    expect(r.contentCount).toBe(0);
    expect(r.unknownCount).toBe(0);
    expect(r.credentialRate).toBe(0);
    expect(r.nonCredentialRate).toBe(0);
  });

  it("aggregates correctly for a mixed batch", () => {
    const messages = [
      "OpenRouter credits exhausted",
      "OpenRouter credits exhausted",
      "thin-content-word-count: 650 words",
      "SEO regression rejected",
      "Workers AI rate limit",
      "Some random nonsense"
    ];
    const r = summarizeFailureBreakdown(messages);
    expect(r.total).toBe(6);
    expect(r.byCategory["credential-openrouter-credits"]).toBe(2);
    expect(r.byCategory["credential-workers-ai-rate"]).toBe(1);
    expect(r.byCategory["content-thin"]).toBe(1);
    expect(r.byCategory["content-seo-regression"]).toBe(1);
    expect(r.byCategory.unknown).toBe(1);
    expect(r.credentialCount).toBe(3);
    expect(r.contentCount).toBe(2);
    expect(r.unknownCount).toBe(1);
    expect(r.credentialRate).toBeCloseTo(3 / 6);
    expect(r.nonCredentialRate).toBeCloseTo(3 / 6);
  });

  it("operator scenario: 8.7% rate, half is OpenRouter credits", () => {
    // Simulate 87 failures in 1000 generated → 8.7%. 50 of 87 are
    // OpenRouter credits. Non-credential rate should be 37/87.
    const messages: string[] = [];
    for (let i = 0; i < 50; i++)
      messages.push("OpenRouter returned 402 insufficient credits");
    for (let i = 0; i < 20; i++)
      messages.push("thin-content-word-count: 700 words (need 800)");
    for (let i = 0; i < 10; i++) messages.push("SEO regression rejected");
    for (let i = 0; i < 7; i++)
      messages.push("Editorial Agent XSS gate triggered");
    const r = summarizeFailureBreakdown(messages);
    expect(r.total).toBe(87);
    expect(r.credentialCount).toBe(50);
    expect(r.contentCount).toBe(37);
    expect(r.unknownCount).toBe(0);
    expect(r.nonCredentialRate).toBeCloseTo(37 / 87);
    // The actionable insight: 37 / 87 = 42.5% of failures are real,
    // not 100%. The defect loop should chase the 37, not the 87.
  });
});

describe("formatBreakdownOneLine", () => {
  it("formats zero-failure case", () => {
    const r = summarizeFailureBreakdown([]);
    expect(formatBreakdownOneLine(r)).toBe(
      "Failure breakdown: 0 failures in window."
    );
  });

  it("formats mixed batch with top content categories", () => {
    const messages = [
      "OpenRouter credits exhausted",
      "thin-content-word-count",
      "thin-content-word-count",
      "SEO regression rejected"
    ];
    const r = summarizeFailureBreakdown(messages);
    const line = formatBreakdownOneLine(r);
    expect(line).toContain("total=4");
    expect(line).toContain("credential=1");
    expect(line).toContain("non-credential=3");
    expect(line).toContain("thin=2");
    expect(line).toContain("seo-regression=1");
  });
});
