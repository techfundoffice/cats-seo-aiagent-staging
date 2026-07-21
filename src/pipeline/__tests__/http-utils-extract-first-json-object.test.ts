import { describe, expect, it } from "vitest";
import { extractFirstJsonObject } from "../http-utils";

describe("extractFirstJsonObject", () => {
  it("returns the first complete JSON object", () => {
    expect(
      extractFirstJsonObject('prefix {"a":1,"nested":{"b":2}} trailing text')
    ).toBe('{"a":1,"nested":{"b":2}}');
  });

  it("skips non-object brace groups before JSON output", () => {
    expect(
      extractFirstJsonObject(
        'model note {not json} and then result {"status":"ok"}'
      )
    ).toBe('{"status":"ok"}');
  });

  it("returns the trailing slice for a truncated object", () => {
    expect(extractFirstJsonObject('prefix {"status":"ok"')).toBe(
      '{"status":"ok"'
    );
  });

  it("returns null when braces exist but no object-like block is present", () => {
    expect(extractFirstJsonObject("prefix {placeholder} suffix")).toBeNull();
  });

  it("skips malformed brace groups like {:} and keeps scanning", () => {
    expect(extractFirstJsonObject('prefix {:} then {"ok":true}')).toBe(
      '{"ok":true}'
    );
  });
});
