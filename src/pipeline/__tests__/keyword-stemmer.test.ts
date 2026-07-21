import { describe, expect, it } from "vitest";
import {
  countMatchingKeywordTokens,
  matchesIntroBidirectional,
  significantKeywordTokens,
  stem,
  stemCandidates
} from "../keyword-stemmer";

describe("stemCandidates — single-word inflections", () => {
  it("plurals: 'fountains' → 'fountain'", () => {
    expect(stemCandidates("fountains")).toContain("fountain");
  });

  it("ies → y: 'studies' → 'study'", () => {
    expect(stemCandidates("studies")).toContain("study");
  });

  it("ing with double consonant: 'running' → 'run'", () => {
    expect(stemCandidates("running")).toContain("run");
  });

  it("ing without double consonant: 'building' → 'build'", () => {
    expect(stemCandidates("building")).toContain("build");
  });

  it("ed with double consonant: 'stopped' → 'stop'", () => {
    expect(stemCandidates("stopped")).toContain("stop");
  });

  it("ation: 'automation' → 'autom'", () => {
    // Stripping "ation" from "automation" leaves "autom" — still >=4
    // chars, so it makes the candidate list. Substring search picks
    // this up against intro words like "automatic" / "automate".
    expect(stemCandidates("automation")).toContain("autom");
  });

  it("ly: 'gently' → 'gent'", () => {
    expect(stemCandidates("gently")).toContain("gent");
  });

  it("ness: 'darkness' → 'dark'", () => {
    expect(stemCandidates("darkness")).toContain("dark");
  });

  it("always preserves the original as the first candidate", () => {
    expect(stemCandidates("fountains")[0]).toBe("fountains");
    expect(stemCandidates("cat")[0]).toBe("cat");
  });

  it("does not stem inputs shorter than 5 chars (keeps 'cat' / 'run' intact)", () => {
    expect(stemCandidates("cat")).toEqual(["cat"]);
    expect(stemCandidates("run")).toEqual(["run"]);
  });

  it("respects the 4-char floor (won't return 'ca' for 'cats')", () => {
    const cands = stemCandidates("cats");
    expect(cands).not.toContain("ca");
    expect(cands).not.toContain("c");
  });
});

describe("stem — canonical single-form helper", () => {
  it("returns the first non-identity candidate when one exists", () => {
    expect(stem("fountains")).toBe("fountain");
    expect(stem("studies")).toBe("study");
    expect(stem("running")).toBe("run");
  });

  it("falls back to the input when no inflection is applicable", () => {
    expect(stem("cat")).toBe("cat");
    expect(stem("fountain")).toBe("fountain");
  });
});

describe("matchesIntroBidirectional", () => {
  it("strict literal: keyword 'fountain' matches intro 'fountain'", () => {
    expect(matchesIntroBidirectional("fountain", new Set(["fountain"]))).toBe(
      true
    );
  });

  it("strict substring: keyword 'fountain' matches intro 'fountain-style'", () => {
    expect(
      matchesIntroBidirectional("fountain", new Set(["fountain-style"]))
    ).toBe(true);
  });

  it("forward stem: keyword 'fountains' (plural) matches intro 'fountain'", () => {
    expect(matchesIntroBidirectional("fountains", new Set(["fountain"]))).toBe(
      true
    );
  });

  it("reverse stem: keyword 'study' matches intro 'studies'", () => {
    expect(matchesIntroBidirectional("study", new Set(["studies"]))).toBe(true);
  });

  it("running ↔ run", () => {
    expect(matchesIntroBidirectional("running", new Set(["run"]))).toBe(true);
    expect(matchesIntroBidirectional("run", new Set(["running"]))).toBe(true);
  });

  it("returns false for entirely unrelated tokens", () => {
    expect(matchesIntroBidirectional("fountain", new Set(["cat", "bed"]))).toBe(
      false
    );
  });

  it("empty intro set: never matches", () => {
    expect(matchesIntroBidirectional("fountain", new Set())).toBe(false);
  });

  it("normalizes punctuation + casing in intro tokens (Copilot regression #5483)", () => {
    // Raw intro tokens from `text.split(/\s+/)` often carry
    // trailing commas / surrounding quotes / mixed case. The
    // helper must normalize on its own so callers don't have to.
    expect(matchesIntroBidirectional("study", new Set(["Studies,"]))).toBe(
      true
    );
    expect(matchesIntroBidirectional("study", new Set(["STUDIES"]))).toBe(true);
    expect(matchesIntroBidirectional("fountain", new Set(["Fountain."]))).toBe(
      true
    );
    expect(matchesIntroBidirectional("fountain", new Set(['"fountain"']))).toBe(
      true
    );
  });

  it("normalizes punctuation + casing in the keyword token too", () => {
    expect(matchesIntroBidirectional("Studies,", new Set(["study"]))).toBe(
      true
    );
  });

  it("returns false when the input is only punctuation", () => {
    expect(matchesIntroBidirectional("---", new Set(["fountain"]))).toBe(false);
  });
});

describe("countMatchingKeywordTokens — scorecard #41 scenario", () => {
  // Reproduces the false-fail case the operator flagged: keyword
  // 'best cat fountains for senior cats' against an intro that uses
  // 'fountain' singular. Strict literal would match 'cats' + 'senior'
  // but miss 'fountains'; bidirectional stemming should give 3/3.
  it("plural keyword token matches singular intro token", () => {
    const hits = countMatchingKeywordTokens(
      ["fountains", "senior", "cats"],
      new Set(["senior", "cats", "need", "steady", "drinking", "fountain"])
    );
    expect(hits).toBe(3);
  });

  it("partial coverage: 2 of 4 keyword tokens match via stemming", () => {
    const hits = countMatchingKeywordTokens(
      ["automatic", "feeders", "senior", "cats"],
      new Set(["automatic", "feeder", "kittens", "review"])
    );
    expect(hits).toBe(2);
  });

  it("zero matches when intro is on a completely different topic", () => {
    const hits = countMatchingKeywordTokens(
      ["fountains", "senior", "cats"],
      new Set(["dog", "kennel", "harness"])
    );
    expect(hits).toBe(0);
  });
});

describe("significantKeywordTokens", () => {
  it("strips stopwords + length<4 tokens", () => {
    expect(
      significantKeywordTokens("the best cat fountain for senior cats")
    ).toEqual(["fountain", "senior", "cats"]);
  });

  it("lowercases tokens", () => {
    expect(significantKeywordTokens("Best Cat Tree FOR Senior CATS")).toEqual([
      "tree",
      "senior",
      "cats"
    ]);
  });

  it("returns empty array when every word is filtered out", () => {
    expect(significantKeywordTokens("the for and you")).toEqual([]);
  });
});

describe("anti-over-penalisation — operator-reported case", () => {
  // The bug spec verbatim: keyword 'best water fountain for senior
  // cats' should pass when intro opens with 'Senior cats need...'
  // and mentions 'fountain' anywhere.
  it("intro 'Senior cats need a steady drinking fountain' passes", () => {
    const significantTokens = significantKeywordTokens(
      "best water fountain for senior cats"
    );
    // ['water', 'fountain', 'senior', 'cats']
    const intro = new Set(
      "senior cats need a steady drinking fountain — what we tested"
        .split(/\s+/)
        .map((w) => w.toLowerCase())
    );
    const hits = countMatchingKeywordTokens(significantTokens, intro);
    // Need ceil(4/2) = 2 matches. We get fountain + senior + cats = 3.
    expect(hits).toBeGreaterThanOrEqual(2);
  });
});
