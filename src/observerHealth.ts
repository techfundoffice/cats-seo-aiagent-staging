/**
 * Compute the observer health tier from two log timestamps. Both
 * timestamps are wall-clock strings emitted by `agent.log()`'s formatter
 * (`MM/DD/YYYY HH:MM:SS`), so the difference is timezone-independent
 * regardless of where the browser parsing them sits.
 *
 * Returns:
 *   - `{ tier: "green",   ageMinutes }`  when latest tick < 15 min ago
 *   - `{ tier: "yellow",  ageMinutes }`  when 15–30 min
 *   - `{ tier: "red",     ageMinutes }`  when > 30 min
 *   - `{ tier: "unknown", ageMinutes: null }` when either timestamp is
 *     missing/unparseable
 *
 * Defensive cases enforced here:
 *   - Future tick timestamps (clock skew, manual edits) clamp to age 0.
 *   - Missing or empty strings → `unknown`.
 *   - Unparseable strings → `unknown`.
 *
 * Extracted from `ObserverAgentPanel` so the boundary thresholds and
 * timezone-independence claim are testable in isolation without
 * standing up a React render harness.
 */
export type ObserverHealthTier = "green" | "yellow" | "red" | "unknown";

export type ObserverHealth = {
  tier: ObserverHealthTier;
  ageMinutes: number | null;
};

function parseAgentLogTimestamp(value: string): number | null {
  const match = value
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, monthText, dayText, yearText, hourText, minuteText, secondText] =
    match;
  const month = Number(monthText);
  const day = Number(dayText);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(ms);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
    ? ms
    : null;
}

/**
 * Computes observer health by comparing the latest observer tick timestamp
 * to the latest activity-log timestamp. Both inputs must use the
 * `MM/DD/YYYY HH:MM:SS` format emitted by `agent.log()`.
 */
export function computeObserverHealth(
  latestTickRanAt: string | null | undefined,
  lastActivity: string | null | undefined
): ObserverHealth {
  if (!latestTickRanAt || !lastActivity) {
    return { tier: "unknown", ageMinutes: null };
  }
  const tNow = parseAgentLogTimestamp(lastActivity);
  const tTick = parseAgentLogTimestamp(latestTickRanAt);
  if (tNow === null || tTick === null) {
    return { tier: "unknown", ageMinutes: null };
  }
  const ageMinutes = Math.max(0, Math.floor((tNow - tTick) / 60000));
  const tier: ObserverHealthTier =
    ageMinutes < 15 ? "green" : ageMinutes <= 30 ? "yellow" : "red";
  return { tier, ageMinutes };
}
