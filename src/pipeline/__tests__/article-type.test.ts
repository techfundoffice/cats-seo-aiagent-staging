import { describe, expect, it } from "vitest";
import {
  MIN_WORDS,
  THIN_CONTENT_FAILURE_REASON,
  classifyArticleType
} from "../article-type";

// Per Chief Engineer direction (2026-05-30):
//   - Informational articles: 800 words minimum
//   - Comparison / best-of / review articles: 1200 words minimum
//   - Any article under minimum: FAIL pre-publish with reason
//     "thin-content-word-count"
// This suite pins the classification heuristic + the policy constants.

describe("classifyArticleType — comparison/review keywords", () => {
  it.each([
    "heavy duty cat window perch review",
    "best cat fountains for senior cats",
    "top automatic cat feeders 2026",
    "cheapest cat litter box",
    "quietest cat water fountain",
    "review of the petlibro fountain",
    "cat wheelchair v dog wheelchair",
    "petlibro vs catit fountain",
    "petlibro versus catit",
    "cat fountain buying guide",
    "cat fountain alternatives for travel",
    "premium cat litter mat"
  ])("'%s' → comparison-or-review (1200 min)", (kw) => {
    const r = classifyArticleType(kw);
    expect(r.type).toBe("comparison-or-review");
    expect(r.minWords).toBe(1200);
  });
});

describe("classifyArticleType — informational keywords", () => {
  it.each([
    "how to introduce a new cat",
    "how-to introduce a new cat",
    "how do cats see in the dark",
    "what is a cat tree",
    "what are calico cats",
    "why does my cat knead me",
    "why is my cat sneezing",
    "when to neuter a cat",
    "when should I bathe my cat",
    "where to buy cat food",
    "do cats like baths",
    "can cats eat tuna",
    "are cats colorblind",
    "should cats be vaccinated"
  ])("'%s' → informational (800 min)", (kw) => {
    const r = classifyArticleType(kw);
    expect(r.type).toBe("informational");
    expect(r.minWords).toBe(800);
  });
});

describe("classifyArticleType — ambiguous / default cases", () => {
  it("empty keyword → comparison-or-review (safe default)", () => {
    expect(classifyArticleType("").type).toBe("comparison-or-review");
    expect(classifyArticleType("").minWords).toBe(1200);
  });

  it("whitespace-only keyword → comparison-or-review", () => {
    expect(classifyArticleType("   ").type).toBe("comparison-or-review");
  });

  it("both signals fire → comparison wins (stricter floor)", () => {
    // "best" is comparison, "how to" is informational. Comparison wins
    // because the affiliate-site default leans toward stricter content.
    const r = classifyArticleType("how to find the best cat fountain");
    expect(r.type).toBe("comparison-or-review");
    expect(r.minWords).toBe(1200);
  });

  it("neither signal → defaults to comparison-or-review", () => {
    // A bare product-noun keyword like "cat tower" with no head
    // qualifier falls back to comparison because that's the modal
    // article type on catsluvus.com.
    const r = classifyArticleType("cat tower");
    expect(r.type).toBe("comparison-or-review");
    expect(r.minWords).toBe(1200);
  });
});

describe("classifyArticleType — case insensitive", () => {
  it("uppercase keyword classifies identically", () => {
    expect(classifyArticleType("BEST CAT FOUNTAIN").type).toBe(
      "comparison-or-review"
    );
    expect(classifyArticleType("HOW TO INTRODUCE A NEW CAT").type).toBe(
      "informational"
    );
  });

  it("mixed-case keyword classifies identically", () => {
    expect(classifyArticleType("Best Cat Fountain").type).toBe(
      "comparison-or-review"
    );
  });
});

describe("policy constants", () => {
  it("MIN_WORDS pins the policy thresholds", () => {
    expect(MIN_WORDS.informational).toBe(800);
    expect(MIN_WORDS["comparison-or-review"]).toBe(1200);
  });

  it("THIN_CONTENT_FAILURE_REASON is the exact string the dashboard expects", () => {
    expect(THIN_CONTENT_FAILURE_REASON).toBe("thin-content-word-count");
  });
});
