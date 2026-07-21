import { describe, expect, it } from "vitest";
import { renderMarkdownInlineCode } from "../escalate-to-claude";

describe("renderMarkdownInlineCode", () => {
  it("normalizes CR, LF, and CRLF line breaks to spaces", () => {
    expect(
      renderMarkdownInlineCode("keyword\rwith\r\nmixed\nline breaks")
    ).toBe("`keyword with mixed line breaks`");
  });

  it("pads edge backticks and uses a longer fence than the content", () => {
    expect(renderMarkdownInlineCode("`tick``edge`")).toBe(
      "``` `tick``edge` ```"
    );
  });
});
