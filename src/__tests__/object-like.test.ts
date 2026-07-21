import { describe, expect, it } from "vitest";
import {
  filterObjectArrayEntries,
  parseJsonStringValue,
  parseObjectLike
} from "../objectLike";

describe("parseObjectLike", () => {
  it("parses JSON strings wrapped in a single-item array", () => {
    expect(parseObjectLike(['{"k":"v"}'])).toEqual({ k: "v" });
  });

  it("parses embedded JSON objects wrapped in prose with apostrophes", () => {
    expect(parseObjectLike(`Here's the payload: {"k":"v"}`)).toEqual({
      k: "v"
    });
  });

  it("parses fenced JSON objects wrapped in surrounding prose", () => {
    expect(
      parseObjectLike('Result:\n```json\n{"k":"v"}\n```\nThanks!')
    ).toEqual({ k: "v" });
  });

  it("parses fenced JSON objects when the fence has a non-json language label", () => {
    expect(
      parseObjectLike('Result:\n```javascript\n{"k":"v"}\n```\nThanks!')
    ).toEqual({ k: "v" });
  });
});

describe("parseJsonStringValue", () => {
  it("parses JSON objects embedded in prose with apostrophes", () => {
    expect(parseJsonStringValue(`Here's the payload: {"k":"v"}`)).toEqual({
      k: "v"
    });
  });

  it("returns undefined for non-string values", () => {
    expect(parseJsonStringValue({ k: "v" })).toBeUndefined();
  });
});

describe("filterObjectArrayEntries", () => {
  it("returns an empty array for non-array input", () => {
    expect(filterObjectArrayEntries("not-an-array")).toEqual([]);
  });

  it("keeps only plain object entries from mixed arrays", () => {
    expect(
      filterObjectArrayEntries<{ id: number }>([
        null,
        undefined,
        0,
        "x",
        ["nested"],
        { id: 1 },
        { id: 2 }
      ])
    ).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
