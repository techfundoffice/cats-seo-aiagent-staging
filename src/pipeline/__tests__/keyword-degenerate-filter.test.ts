import { describe, expect, it } from "vitest";

import { isDegenerate } from "../keywords";

describe("isDegenerate", () => {
  it("rejects the literal prompt-shape echoes seen in production", () => {
    expect(isDegenerate("best ...")).toBe(true);
    expect(isDegenerate("... vs ...")).toBe(true);
  });

  it("rejects bare single-word keywords", () => {
    expect(isDegenerate("best")).toBe(true);
    expect(isDegenerate("vs")).toBe(true);
    expect(isDegenerate("...")).toBe(true);
    expect(isDegenerate("")).toBe(true);
  });

  it("accepts real two-or-more-word product keywords", () => {
    expect(isDegenerate("best automatic feeder")).toBe(false);
    expect(isDegenerate("quiet litter box")).toBe(false);
    expect(isDegenerate("orthopedic bed vs standard bed")).toBe(false);
  });

  it("accepts a real two-word keyword at the boundary", () => {
    expect(isDegenerate("automatic feeder")).toBe(false);
  });
});
