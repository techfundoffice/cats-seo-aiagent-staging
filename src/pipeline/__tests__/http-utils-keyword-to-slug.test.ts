import { describe, expect, it } from "vitest";

import { keywordToSlug } from "../http-utils";

describe("keywordToSlug", () => {
  it("keeps multi-token keywords readable", () => {
    expect(keywordToSlug("Best puzzle feeder for fast-eating cats!")).toBe(
      "best-puzzle-feeder-for-fast-eating-cats"
    );
  });

  it("adds a deterministic suffix for single-token keywords", () => {
    expect(keywordToSlug("best")).toMatch(/^best-[a-z0-9]+$/);
    expect(keywordToSlug("best")).toBe(keywordToSlug(" best "));
    expect(keywordToSlug("best ...")).toMatch(/^best-[a-z0-9]+$/);
  });

  it("falls back to a deterministic hashed keyword slug when punctuation strips everything", () => {
    expect(keywordToSlug("  --cats--  ")).toMatch(/^cats-[a-z0-9]+$/);
    expect(keywordToSlug("  --cats--  ")).toBe(keywordToSlug("cats"));
    expect(keywordToSlug("...")).toMatch(/^keyword-[a-z0-9]+$/);
    expect(keywordToSlug("")).toBe("keyword-empty");
  });
});
