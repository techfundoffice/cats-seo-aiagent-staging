import { describe, expect, it } from "vitest";
import { createArticleResponseHeaders } from "../article-response";

describe("createArticleResponseHeaders", () => {
  it("forces article HTML to revalidate instead of serving stale cached copies", () => {
    const headers = createArticleResponseHeaders();

    expect(headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });
});
