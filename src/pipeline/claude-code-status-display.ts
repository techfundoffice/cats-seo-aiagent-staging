/**
 * Dashboard copy for Claude Code subscription status.
 *
 * Kept free of the AI SDK so the browser bundle can import it without
 * pulling Anthropic client code into the page.
 */

export type ClaudeCodeUiStatus =
  | "active"
  | "expiring_soon"
  | "expired"
  | "none";

/**
 * Access tokens at or under this many hours are shown in hours.
 * PKCE access tokens last ~8h; `daysRemaining` ceil's that to 1 day, which
 * used to render as a multi-day "expiring soon" plan warning.
 */
export const CLAUDE_CODE_SHORT_LIVED_HOURS = 48;

export function hoursRemaining(
  expiresAtMs: number,
  nowMs = Date.now()
): number {
  if (!Number.isFinite(expiresAtMs)) return 0;
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / (60 * 60 * 1000)));
}

export function showsHourlyClaudeExpiry(
  hours: number | null | undefined
): boolean {
  return (
    typeof hours === "number" &&
    hours > 0 &&
    hours <= CLAUDE_CODE_SHORT_LIVED_HOURS
  );
}

/**
 * Coarse color band. A stored refresh_token means `expiresAt` is the OAuth
 * access token, not the plan, so a healthy ~8h token stays `active`.
 */
export function claudeCodeUiStatus(status: {
  configured: boolean;
  active: boolean;
  daysRemaining: number | null;
  hasRefreshToken: boolean;
}): ClaudeCodeUiStatus {
  if (!status.configured) return "none";
  if (!status.active) return "expired";
  if (status.hasRefreshToken) return "active";
  const days = status.daysRemaining ?? 0;
  if (days <= 7) return "expiring_soon";
  return "active";
}

export type ClaudeCodeExpiryPresentation = {
  configured: boolean;
  active: boolean;
  uiStatus: ClaudeCodeUiStatus;
  daysRemaining: number | null;
  hoursRemaining: number | null;
  hasRefreshToken: boolean;
};

export function claudeCodeExpiryBadgeLabel(
  status: ClaudeCodeExpiryPresentation
): string {
  if (!status.configured || status.uiStatus === "none") {
    return "None — not configured";
  }
  if (!status.active || status.uiStatus === "expired") {
    return "Expired — re-authorize";
  }
  const hours = status.hoursRemaining;
  if (showsHourlyClaudeExpiry(hours)) {
    if (status.hasRefreshToken) {
      return `Active — access token · ${hours}h left`;
    }
    const unit = hours === 1 ? "hour" : "hours";
    return `Expiring soon — ${hours} ${unit} left`;
  }
  if (status.uiStatus === "expiring_soon") {
    return `Expiring soon — ${status.daysRemaining ?? "?"} days left`;
  }
  const days = status.daysRemaining;
  if (days !== null && days <= 30) return `Active — primary · ${days}d left`;
  return "Active — primary model";
}

export function claudeCodeTimeRemainingLabel(status: {
  daysRemaining: number | null;
  hoursRemaining: number | null;
}): string {
  const hours = status.hoursRemaining;
  if (showsHourlyClaudeExpiry(hours)) {
    const unit = hours === 1 ? "hour" : "hours";
    return `${hours} ${unit} left`;
  }
  if (status.daysRemaining != null) {
    const unit = status.daysRemaining === 1 ? "day" : "days";
    return `${status.daysRemaining} ${unit} left`;
  }
  return "—";
}

/** Button label. Without a refresh_token the handler only bumps local expiry. */
export function claudeCodeRefreshButtonLabel(hasRefreshToken: boolean): string {
  return hasRefreshToken ? "Refresh token" : "Extend local expiry";
}

export function claudeCodeRefreshButtonHint(
  hasRefreshToken: boolean
): string | null {
  if (hasRefreshToken) return null;
  return "No refresh_token on file. This only extends the saved expiry; it does not request a new access token.";
}
