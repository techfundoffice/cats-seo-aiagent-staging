import { describe, expect, it } from "vitest";
import { errMsg } from "../http-utils";

describe("errMsg", () => {
  it("returns the message of a plain Error", () => {
    expect(errMsg(new Error("something went wrong"))).toBe(
      "something went wrong"
    );
  });

  it("falls back to String(e) when Error message is empty", () => {
    const e = new TypeError("");
    expect(errMsg(e)).toBe("TypeError");
  });

  it("appends cause message for chained errors", () => {
    const cause = new TypeError("connection refused");
    const e = new Error("fetch failed", { cause });
    expect(errMsg(e)).toBe("fetch failed — cause: connection refused");
  });

  it("omits cause suffix when cause message equals the base message", () => {
    const cause = new Error("same message");
    const e = new Error("same message", { cause });
    expect(errMsg(e)).toBe("same message");
  });

  it("omits cause suffix when cause is null or undefined", () => {
    const e = new Error("no cause") as Error & { cause?: unknown };
    e.cause = null;
    expect(errMsg(e)).toBe("no cause");
  });

  it("returns the string value for non-Error strings", () => {
    expect(errMsg("raw string error")).toBe("raw string error");
  });

  it("coerces null to the string 'null'", () => {
    expect(errMsg(null)).toBe("null");
  });

  it("coerces undefined to the string 'undefined'", () => {
    expect(errMsg(undefined)).toBe("undefined");
  });

  it("extracts message from a plain object with a message field", () => {
    expect(errMsg({ message: "structured error" })).toBe("structured error");
  });

  it("extracts message from a plain object with a detail field", () => {
    expect(errMsg({ detail: "detail error" })).toBe("detail error");
  });

  it("extracts message from a nested error.message field", () => {
    expect(errMsg({ error: { message: "nested message" } })).toBe(
      "nested message"
    );
  });

  it("extracts first string from an errors array", () => {
    expect(errMsg({ errors: ["first error", "second error"] })).toBe(
      "first error"
    );
  });
});
