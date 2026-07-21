import { describe, expect, it } from "vitest";
import {
  isActivityLogErrorLevel,
  isActivityLogWarningLevel,
  isActivityLogWarningOrErrorLevel,
  normalizeActivityLogLevel
} from "../activityLogLevels";

describe("normalizeActivityLogLevel", () => {
  it("normalizes wrapped aliases with trailing punctuation", () => {
    expect(normalizeActivityLogLevel("[warning:]")).toBe("warning");
    expect(normalizeActivityLogLevel('"warn?!"')).toBe("warning");
    expect(normalizeActivityLogLevel("((`err`))")).toBe("error");
    expect(normalizeActivityLogLevel("__warn__")).toBe("warning");
    expect(normalizeActivityLogLevel("⚠️ warning: dedup rollback failed")).toBe(
      "warning"
    );
    expect(normalizeActivityLogLevel("🚨 err - github issue POST failed")).toBe(
      "error"
    );
    expect(normalizeActivityLogLevel("warning: dedup rollback failed")).toBe(
      "warning"
    );
    expect(normalizeActivityLogLevel("err - github issue POST failed")).toBe(
      "error"
    );
    expect(normalizeActivityLogLevel("[fatal:]")).toBe("error");
    expect(normalizeActivityLogLevel("[critical:]")).toBe("error");
    expect(normalizeActivityLogLevel("crit - provider outage")).toBe("error");
  });

  it("returns canonical levels when already valid", () => {
    expect(normalizeActivityLogLevel("info")).toBe("info");
    expect(normalizeActivityLogLevel("warning")).toBe("warning");
    expect(normalizeActivityLogLevel("error")).toBe("error");
  });

  it("finds canonical/alias levels in labeled level strings", () => {
    expect(normalizeActivityLogLevel("level: warning")).toBe("warning");
    expect(normalizeActivityLogLevel("severity=err")).toBe("error");
    expect(normalizeActivityLogLevel("log level -> info")).toBe("info");
    expect(normalizeActivityLogLevel("level=warning err")).toBe("error");
  });

  it("returns null for non-strings and unknown values", () => {
    expect(normalizeActivityLogLevel(undefined)).toBeNull();
    expect(normalizeActivityLogLevel(42)).toBeNull();
    expect(normalizeActivityLogLevel("notice")).toBeNull();
  });
});

describe("activity log level predicates", () => {
  it("maps normalized aliases to warning/error checks", () => {
    expect(isActivityLogWarningLevel("*warn*")).toBe(true);
    expect(isActivityLogErrorLevel("{err:}")).toBe(true);
    expect(isActivityLogErrorLevel("fatal: upstream provider panic")).toBe(
      true
    );
    expect(isActivityLogErrorLevel("critical: upstream provider panic")).toBe(
      true
    );
    expect(isActivityLogWarningOrErrorLevel(" [warning?!] ")).toBe(true);
    expect(isActivityLogWarningOrErrorLevel("info")).toBe(false);
  });
});
