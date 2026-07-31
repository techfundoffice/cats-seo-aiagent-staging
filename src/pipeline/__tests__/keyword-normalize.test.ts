import { describe, expect, it } from "vitest";
import { normalizeKeywordText } from "../keyword-normalize";

describe("normalizeKeywordText", () => {
  it("removes an orphaned period token", () => {
    expect(
      normalizeKeywordText("shake-away coyote/fox urine granules . review")
    ).toBe("shake-away coyote fox urine granules review");
  });

  it("removes dangling punctuation and orphan tokens together", () => {
    expect(
      normalizeKeywordText(
        "angry orange pet odor eliminator . bottle- industrial review"
      )
    ).toBe("angry orange pet odor eliminator bottle industrial review");
  });

  it("drops a trailing colon inside a product name", () => {
    expect(
      normalizeKeywordText(
        "vetoquinol laxatone: oral hairball lubricant gel for cats review"
      )
    ).toBe("vetoquinol laxatone oral hairball lubricant gel for cats review");
  });

  it("preserves hyphens that join words", () => {
    for (const kw of [
      "self-cleaning slicker brush review",
      "shake-away granules review",
      "non-slip cat bowl review",
      "u-100 pet insulin syringes review"
    ]) {
      expect(normalizeKeywordText(kw)).toBe(kw);
    }
  });

  it("is a no-op on already-clean keywords", () => {
    for (const kw of [
      "best cat litter box for large cats",
      "purina friskies cat treats review",
      "cat water fountain stainless steel review"
    ]) {
      expect(normalizeKeywordText(kw)).toBe(kw);
    }
  });

  it("is idempotent", () => {
    const once = normalizeKeywordText("a / b . c- d review");
    expect(normalizeKeywordText(once)).toBe(once);
  });

  it("survives empty and non-string input", () => {
    expect(normalizeKeywordText("")).toBe("");
    expect(normalizeKeywordText(undefined as unknown as string)).toBe(
      undefined
    );
  });

  it("does not change how a keyword slugifies", () => {
    // The stored slug is authoritative; normalization must never imply a
    // different URL. Mirrors the pipeline's slug rule: lowercase,
    // non-alphanumerics to hyphens, collapse, trim.
    const slugify = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    for (const kw of [
      "shake-away coyote/fox urine granules . review",
      "angry orange pet odor eliminator . bottle- industrial review",
      "vetoquinol laxatone: oral hairball lubricant gel for cats review"
    ]) {
      expect(slugify(normalizeKeywordText(kw))).toBe(slugify(kw));
    }
  });
});
