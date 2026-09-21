/**
 * Claude chat/vision failures stop the pipeline. There is no second model.
 *
 * `describeClaudeChatFailure` is pure so tests can lock the banner copy.
 * The Durable Object installs a sink (`setClaudeChatFailureSink`) that
 * writes the dashboard banner and pauses the autonomous loop.
 */

import { errMsg } from "./http-utils";

export type ClaudeChatFailureNotice = {
  /** Human-readable Claude error (no stack, no secrets). */
  message: string;
  /** Concrete next step for the operator. */
  howToFix: string;
};

const HOW_TO_FIX_MISSING_TOKEN =
  "Paste a Claude Code setup-token, or click Authorize on the Claude Code panel on this dashboard.";

const HOW_TO_FIX_AUTH =
  "Re-authorize on the Claude Code panel (Authorize, or paste a fresh setup-token). Check that the access token has not expired and that a refresh token is still stored.";

const HOW_TO_FIX_RATE_LIMIT =
  "Wait for the Anthropic rate-limit cooldown to finish, then retry this job from the dashboard. No other model will run in the meantime.";

const HOW_TO_FIX_EMPTY =
  "Retry the job after the Claude Code panel shows Active. If Claude keeps returning nothing, re-authorize the subscription.";

const HOW_TO_FIX_DEGENERATE =
  "Retry the job. If Claude keeps returning unusable text, re-authorize the Claude Code subscription on the dashboard.";

const HOW_TO_FIX_GENERIC =
  "Confirm the Claude Code subscription on the dashboard is active (token present, not expired). Re-authorize if the panel shows expired or missing, then retry. No other model will be called.";

/**
 * Map a Claude failure onto banner copy: the error itself, plus the
 * operator action that matches it (missing token, expired auth, 429, …).
 */
export function describeClaudeChatFailure(
  err: unknown
): ClaudeChatFailureNotice {
  const raw = errMsg(err).replace(/\s+/g, " ").trim();
  const message = (raw || "Claude returned no usable response.").slice(0, 500);
  const lower = message.toLowerCase();

  if (/429|rate[- ]?limit|too many requests|cooldown/.test(lower)) {
    return { message, howToFix: HOW_TO_FIX_RATE_LIMIT };
  }
  if (
    /no active claude|subscription token|missing token|not configured|token is unset|claude_code_oauth_token/.test(
      lower
    )
  ) {
    return { message, howToFix: HOW_TO_FIX_MISSING_TOKEN };
  }
  if (
    /\b401\b|\b403\b|unauthorized|invalid_grant|authentication|expired|refresh token|auth error|\(auth\)/.test(
      lower
    )
  ) {
    return { message, howToFix: HOW_TO_FIX_AUTH };
  }
  if (/degenerate/.test(lower)) {
    return { message, howToFix: HOW_TO_FIX_DEGENERATE };
  }
  if (/\bempty\b/.test(lower)) {
    return { message, howToFix: HOW_TO_FIX_EMPTY };
  }
  return { message, howToFix: HOW_TO_FIX_GENERIC };
}

/** Thrown when a chat or vision step stops because Claude failed. */
export class ClaudeChatStoppedError extends Error {
  readonly notice: ClaudeChatFailureNotice;

  constructor(notice: ClaudeChatFailureNotice) {
    super(`${notice.message} — ${notice.howToFix}`);
    this.name = "ClaudeChatStoppedError";
    this.notice = notice;
  }
}

export function isClaudeChatStoppedError(
  err: unknown
): err is ClaudeChatStoppedError {
  return (
    err instanceof ClaudeChatStoppedError ||
    (err instanceof Error && err.name === "ClaudeChatStoppedError")
  );
}

export type ClaudeChatFailureSink = {
  report: (notice: ClaudeChatFailureNotice) => void;
  clear: () => void;
};

let sink: ClaudeChatFailureSink | null = null;

/** Installed by `SEOArticleAgent` so chat helpers can reach dashboard state. */
export function setClaudeChatFailureSink(
  next: ClaudeChatFailureSink | null
): void {
  sink = next;
}

/**
 * Record the failure for the dashboard banner and return the error callers
 * should throw. A sink failure must not hide the Claude error.
 */
export function reportClaudeChatFailure(err: unknown): ClaudeChatStoppedError {
  if (isClaudeChatStoppedError(err)) {
    try {
      sink?.report(err.notice);
    } catch {
      /* banner must not mask the original failure */
    }
    return err;
  }
  const notice = describeClaudeChatFailure(err);
  try {
    sink?.report(notice);
  } catch {
    /* banner must not mask the original failure */
  }
  return new ClaudeChatStoppedError(notice);
}

/** Drop the banner after a successful Claude chat or vision call. */
export function clearClaudeChatFailureBanner(): void {
  try {
    sink?.clear();
  } catch {
    /* a cleared banner is not required for the successful call */
  }
}
