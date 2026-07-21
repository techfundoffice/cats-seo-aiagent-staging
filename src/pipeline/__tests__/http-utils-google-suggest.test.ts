import { describe, expect, it } from "vitest";
import { getGoogleSuggestStrings } from "../http-utils";

describe("getGoogleSuggestStrings", () => {
  it("extracts and normalizes supported suggestion shapes", () => {
    expect(
      getGoogleSuggestStrings([
        "cat stairs",
        ["  best cat stairs  ", ["how to use cat stairs", 0]]
      ])
    ).toEqual(["best cat stairs", "how to use cat stairs"]);
  });

  it("returns an empty array for a valid payload with no suggestions", () => {
    expect(getGoogleSuggestStrings(["cat stairs", []])).toEqual([]);
  });

  it("returns undefined when a non-empty suggestions slot has no valid strings", () => {
    expect(
      getGoogleSuggestStrings(["cat stairs", [{ value: "bad" }, [123], null]])
    ).toBeUndefined();
    expect(getGoogleSuggestStrings(["cat stairs", ["   ", ["   ", 0]]])).toBe(
      undefined
    );
  });
});
