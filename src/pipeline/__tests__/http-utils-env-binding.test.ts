import { describe, expect, it } from "vitest";
import { getEnvBinding } from "../http-utils";

describe("getEnvBinding", () => {
  it("returns a trimmed string binding", () => {
    expect(getEnvBinding({ API_TOKEN: "  secret  " }, "API_TOKEN")).toBe(
      "secret"
    );
  });

  it("returns undefined for nullish, non-object, blank, and non-string input", () => {
    expect(getEnvBinding(null, "API_TOKEN")).toBeUndefined();
    expect(getEnvBinding("env", "API_TOKEN")).toBeUndefined();
    expect(getEnvBinding({ API_TOKEN: "   " }, "API_TOKEN")).toBeUndefined();
    expect(getEnvBinding({ API_TOKEN: 123 }, "API_TOKEN")).toBeUndefined();
  });

  it("returns undefined when dynamic property access throws", () => {
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        }
      }
    );

    expect(getEnvBinding(env, "API_TOKEN")).toBeUndefined();
  });

  it("ignores prototype-inherited values", () => {
    const env = Object.create({ API_TOKEN: "proto-secret" });
    expect(getEnvBinding(env, "API_TOKEN")).toBeUndefined();
  });
});
