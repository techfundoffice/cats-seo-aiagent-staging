import { describe, expect, it } from "vitest";
import { formatActivityLogMessagePassOrFail } from "../activityLogSheetColumns";

describe("formatActivityLogMessagePassOrFail", () => {
  it("treats action_required runs with zero-job markers as neutral", () => {
    expect(
      formatActivityLogMessagePassOrFail(
        "Sanity check: conclusion=action_required jobs.total_count: 0; No failed jobs found in this workflow run"
      )
    ).toBe("Nothing");
  });

  it("flags action_required runs with real failed jobs as failures", () => {
    expect(
      formatActivityLogMessagePassOrFail(
        "Sanity check: conclusion=action_required failed_jobs=2"
      )
    ).toBe("Fail");
  });

  it("keeps emoji-prefixed zero-job action_required lines neutral", () => {
    expect(
      formatActivityLogMessagePassOrFail(
        "❌ Sanity check: conclusion=action_required jobs.total_count: 0; No failed jobs found in this workflow run"
      )
    ).toBe("Nothing");
  });

  it("treats quoted n/a failed-check markers on action_required runs as neutral", () => {
    expect(
      formatActivityLogMessagePassOrFail(
        'Sanity check: conclusion=action_required failed_checks="n/a"'
      )
    ).toBe("Nothing");
  });

  it("keeps emoji-prefixed quoted none failed-job markers neutral", () => {
    expect(
      formatActivityLogMessagePassOrFail(
        '❌ Sanity check: conclusion=action_required failed_jobs="none"'
      )
    ).toBe("Nothing");
  });

  it("classifies direct Error message payloads using their text", () => {
    expect(
      formatActivityLogMessagePassOrFail(
        new Error("Failed: sanity-check workflow crashed")
      )
    ).toBe("Fail");
  });

  it("treats serialized action_required zero-job JSON payloads as neutral", () => {
    expect(
      formatActivityLogMessagePassOrFail({
        conclusion: "action_required",
        jobs: { total_count: 0 }
      })
    ).toBe("Nothing");
  });
});
