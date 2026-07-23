import { describe, expect, it } from "vitest";
import { __testHelpers } from "../writer";

const { decodeJsonStringLiteral } = __testHelpers;

// Regression: the live best-cat-litter article rendered its video caption
// as "Tuft & Paw" — YouTube's inline JSON is captured raw by regex,
// so escape sequences reached published HTML undecoded.
describe("decodeJsonStringLiteral", () => {
  it("decodes unicode escapes from YouTube inline JSON", () => {
    expect(decodeJsonStringLiteral("Tuft \\u0026 Paw")).toBe("Tuft & Paw");
  });

  it("decodes escaped quotes and backslashes", () => {
    expect(decodeJsonStringLiteral('The \\"Best\\" Litter')).toBe(
      'The "Best" Litter'
    );
  });

  it("returns plain strings unchanged and never throws on junk", () => {
    expect(decodeJsonStringLiteral("Plain Channel Name")).toBe(
      "Plain Channel Name"
    );
    expect(decodeJsonStringLiteral('broken " literal')).toBe(
      'broken " literal'
    );
  });
});
