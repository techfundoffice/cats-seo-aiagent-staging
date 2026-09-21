import { describe, expect, it } from "vitest";
import {
  ClaudeChatStoppedError,
  describeClaudeChatFailure,
  isClaudeChatStoppedError
} from "../claude-chat-failure";

describe("describeClaudeChatFailure", () => {
  it("tells the operator to paste or authorize when the token is missing", () => {
    const notice = describeClaudeChatFailure(
      new Error(
        "[claude-code] no active Claude subscription token; No other model was called. The pipeline stopped."
      )
    );
    expect(notice.message).toMatch(/no active Claude subscription token/);
    expect(notice.howToFix).toMatch(/Authorize/);
    expect(notice.howToFix).toMatch(/setup-token/);
  });

  it("tells the operator to re-authorize when the token is expired", () => {
    const notice = describeClaudeChatFailure(
      new Error("Claude call failed (auth) (401 invalid_grant refresh token)")
    );
    expect(notice.howToFix).toMatch(/Re-authorize/);
    expect(notice.howToFix).toMatch(/expired/);
  });

  it("tells the operator to wait on a 429", () => {
    const notice = describeClaudeChatFailure(
      new Error(
        "[claude-code] Claude rate-limit cooldown 30s remaining after the existing retry/cooldown"
      )
    );
    expect(notice.howToFix).toMatch(/Wait for the Anthropic rate-limit/);
    expect(notice.howToFix).toMatch(/No other model/);
  });

  it("keeps a generic failure actionable", () => {
    const notice = describeClaudeChatFailure(new Error("overloaded"));
    expect(notice.message).toBe("overloaded");
    expect(notice.howToFix).toMatch(/dashboard/);
  });

  it("tells the operator to retry generate-one when the worker times out", () => {
    const notice = describeClaudeChatFailure(
      new Error("The operation was aborted")
    );
    expect(notice.message).toBe("The operation was aborted");
    expect(notice.howToFix).toMatch(/retry generate-one/);
    expect(notice.howToFix).toMatch(/shorten the article or raise limits/);
  });

  it("marks the thrown error so callers can stop the pipeline", () => {
    const notice = describeClaudeChatFailure(new Error("claude down"));
    const err = new ClaudeChatStoppedError(notice);
    expect(isClaudeChatStoppedError(err)).toBe(true);
    expect(err.message).toContain("claude down");
    expect(err.message).toContain(notice.howToFix);
    expect(err.notice).toEqual(notice);
  });
});
