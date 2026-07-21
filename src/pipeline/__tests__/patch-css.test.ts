import { describe, expect, it } from "vitest";
import { applyArticleCssFixes } from "../patch-css";

describe("applyArticleCssFixes", () => {
  it("patches .pick-name even when word-break:break-word exists elsewhere", () => {
    const html =
      "<style>.other{word-break:break-word}.pick-name{color:red;}</style>";

    const result = applyArticleCssFixes(html);

    expect(result.fixes).toContain(".pick-name: added word-break:break-word");
    expect(result.patched).toContain(
      ".pick-name{color:red;word-break:break-word}"
    );
  });

  it("does not report .pick-name fix when selector already has word-break", () => {
    const html = "<style>.pick-name{word-break:break-word;color:red;}</style>";

    const result = applyArticleCssFixes(html);

    expect(result.fixes).not.toContain(
      ".pick-name: added word-break:break-word"
    );
    expect(result.patched).toBe(html);
  });

  it("replaces word-break:break-all with word-break:break-word inside a{} selectors", () => {
    const html =
      "<style>a{color:blue;word-break:break-all;font-size:1em}</style>";

    const result = applyArticleCssFixes(html);

    expect(result.fixes).toContain(
      "a{word-break:break-all} → word-break:break-word"
    );
    expect(result.patched).toContain(
      "a{color:blue;word-break:break-word;font-size:1em}"
    );
  });

  it("does not report a{} fix when word-break:break-all is absent", () => {
    const html = "<style>a{color:blue;word-break:break-word}</style>";

    const result = applyArticleCssFixes(html);

    expect(result.fixes).not.toContain(
      "a{word-break:break-all} → word-break:break-word"
    );
    expect(result.patched).toBe(html);
  });

  it("adds flex-shrink:0 and word-break:normal to .amazon-btn when white-space:nowrap present", () => {
    const html =
      "<style>.amazon-btn{display:inline-flex;white-space:nowrap;padding:8px}</style>";

    const result = applyArticleCssFixes(html);

    expect(result.fixes).toContain(
      ".amazon-btn: added flex-shrink:0, word-break:normal"
    );
    expect(result.patched).toContain("flex-shrink:0");
    expect(result.patched).toContain("word-break:normal");
    expect(result.patched).toContain("overflow-wrap:normal");
  });

  it("does not patch .amazon-btn when flex-shrink:0 already present", () => {
    const html = "<style>.amazon-btn{white-space:nowrap;flex-shrink:0}</style>";

    const result = applyArticleCssFixes(html);

    expect(result.fixes).not.toContain(
      ".amazon-btn: added flex-shrink:0, word-break:normal"
    );
    expect(result.patched).toBe(html);
  });
});
