import { describe, expect, it } from "vitest";
import { repairJson } from "../http-utils";

// Unit tests for repairJson — a best-effort normaliser for AI-model JSON
// output used by objectLike.ts, text-editor-agent.ts, keywords.ts, and
// polish-agent.ts. Despite being on the critical parsing path with complex
// multi-step logic it had no test coverage.

describe("repairJson — passthrough for already-valid JSON", () => {
  it("leaves a well-formed object unchanged", () => {
    const s = '{"a":1,"b":"hello"}';
    expect(JSON.parse(repairJson(s))).toEqual({ a: 1, b: "hello" });
  });

  it("leaves an empty object unchanged", () => {
    expect(repairJson("{}")).toBe("{}");
  });

  it("leaves a nested object unchanged", () => {
    const s = '{"outer":{"inner":"v"}}';
    expect(JSON.parse(repairJson(s))).toEqual({ outer: { inner: "v" } });
  });
});

describe("repairJson — markdown fence stripping", () => {
  it("strips ```json fence", () => {
    const s = '```json\n{"a":1}\n```';
    expect(JSON.parse(repairJson(s))).toEqual({ a: 1 });
  });

  it("strips bare ``` fence", () => {
    const s = '```\n{"a":1}\n```';
    expect(JSON.parse(repairJson(s))).toEqual({ a: 1 });
  });

  it("strips fences without trailing newline inside", () => {
    const s = '```json{"a":1}```';
    expect(JSON.parse(repairJson(s))).toEqual({ a: 1 });
  });
});

describe("repairJson — trailing comma removal", () => {
  it("removes trailing comma before }", () => {
    const s = '{"a":1,"b":2,}';
    expect(JSON.parse(repairJson(s))).toEqual({ a: 1, b: 2 });
  });

  it("removes trailing comma before ]", () => {
    const s = '{"arr":[1,2,3,]}';
    expect(JSON.parse(repairJson(s))).toEqual({ arr: [1, 2, 3] });
  });
});

describe("repairJson — unquoted and single-quoted keys", () => {
  it("quotes a bare unquoted key", () => {
    const s = '{key: "val"}';
    expect(JSON.parse(repairJson(s))).toEqual({ key: "val" });
  });

  it("quotes a bare key with underscore", () => {
    const s = '{my_key: "val"}';
    expect(JSON.parse(repairJson(s))).toEqual({ my_key: "val" });
  });

  it("converts a single-quoted key to double-quoted", () => {
    const s = "{'key': \"val\"}";
    expect(JSON.parse(repairJson(s))).toEqual({ key: "val" });
  });
});

describe("repairJson — single-quoted values", () => {
  it("converts a single-quoted value to double-quoted", () => {
    const s = "{\"key\": 'val'}";
    expect(JSON.parse(repairJson(s))).toEqual({ key: "val" });
  });

  it("converts a single-quoted value without special chars", () => {
    const s = "{'key': 'simple value'}";
    expect(JSON.parse(repairJson(s))).toEqual({ key: "simple value" });
  });

  it("escapes inner backslashes when converting single to double", () => {
    const s = "{'key': 'path\\\\to\\\\file'}";
    const result = JSON.parse(repairJson(s)) as { key: string };
    // The original single-quoted value `path\to\file` has its backslashes
    // doubled so the resulting double-quoted JSON is syntactically valid.
    expect(result.key).toContain("path");
    expect(result.key).toContain("file");
  });
});

describe("repairJson — unclosed structure", () => {
  it("closes a missing closing brace", () => {
    const s = '{"a":1';
    expect(JSON.parse(repairJson(s))).toEqual({ a: 1 });
  });

  it("closes a missing closing brace when value is already complete", () => {
    const s = '{"a":"hello"';
    expect(JSON.parse(repairJson(s))).toEqual({ a: "hello" });
  });

  it("closes a missing array bracket", () => {
    const s = '{"arr":[1,2,3';
    expect(JSON.parse(repairJson(s))).toEqual({ arr: [1, 2, 3] });
  });

  it("closes nested structures in the correct order", () => {
    // {"arr": [{"key": "val"  should become  {"arr": [{"key": "val"}]}
    const s = '{"arr":[{"key":"val"';
    expect(JSON.parse(repairJson(s))).toEqual({ arr: [{ key: "val" }] });
  });
});

describe("repairJson — truncated string literal", () => {
  it("appends missing closing quote for a truncated string value", () => {
    // {"key": "truncated  (no closing quote or brace)
    const s = '{"key": "truncated';
    expect(JSON.parse(repairJson(s))).toEqual({ key: "truncated" });
  });

  it("does NOT add extra quote when string is already closed (only brace missing)", () => {
    // {"key": "value"  — string is closed; only } is missing
    const s = '{"key": "value"';
    const parsed = JSON.parse(repairJson(s)) as { key: string };
    // Should NOT have a double-close-quote like "value""
    expect(parsed.key).toBe("value");
  });

  it("handles escaped quote inside truncated string correctly", () => {
    // {"key": "value with \" escaped  — the \" is an escape, not the end of string
    const s = '{"key": "value with \\" escaped';
    expect(JSON.parse(repairJson(s))).toEqual({
      key: 'value with " escaped'
    });
  });
});

describe("repairJson — newline escaping", () => {
  it("escapes bare LF inside a JSON string so JSON.parse succeeds", () => {
    // A literal newline inside a JSON string value is invalid JSON.
    const s = '{"text":"line1\nline2"}';
    expect(JSON.parse(repairJson(s))).toEqual({ text: "line1\nline2" });
  });

  it("normalizes CRLF to escaped LF", () => {
    const s = '{"text":"line1\r\nline2"}';
    // After CRLF→LF and then LF→\\n the value parses back to "line1\nline2".
    expect(JSON.parse(repairJson(s))).toEqual({ text: "line1\nline2" });
  });
});

describe("repairJson — combined real-world truncation scenarios", () => {
  it("handles bare keys + trailing comma + truncated brace", () => {
    const s = '{title: "Best picks", count: 5,';
    expect(JSON.parse(repairJson(s))).toEqual({
      title: "Best picks",
      count: 5
    });
  });

  it("handles a JSON-fenced truncated response with missing closing brace", () => {
    const s = '```json\n{"status":"ok","items":[1,2,3';
    expect(JSON.parse(repairJson(s))).toEqual({
      status: "ok",
      items: [1, 2, 3]
    });
  });
});
