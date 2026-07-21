export type ActivityLogCanonicalLevel = "info" | "warning" | "error";

const ACTIVITY_LOG_LEVEL_WRAPPER_CHARS = `[](){}"'*_\``;
const ACTIVITY_LOG_LEVEL_TRAILING_PUNCTUATION = /[:;.,!?]+$/;

function trimActivityLogLevelNoise(value: string): string {
  let normalized = value;
  while (normalized.length > 0) {
    const before = normalized;
    normalized = normalized.trim();
    while (normalized.length > 0) {
      const first = normalized[0];
      if (!ACTIVITY_LOG_LEVEL_WRAPPER_CHARS.includes(first)) break;
      normalized = normalized.slice(1);
    }
    while (normalized.length > 0) {
      const last = normalized[normalized.length - 1];
      if (!ACTIVITY_LOG_LEVEL_WRAPPER_CHARS.includes(last)) break;
      normalized = normalized.slice(0, -1);
    }
    normalized = normalized.replace(
      ACTIVITY_LOG_LEVEL_TRAILING_PUNCTUATION,
      ""
    );
    if (normalized === before) break;
  }
  return normalized;
}

/**
 * Normalizes activity-log levels across legacy aliases.
 * Supported aliases: "warn" -> "warning", "err"/"fatal"/"crit"/"critical" -> "error".
 * Also accepts common wrappers/punctuation
 * (e.g. "[warning:]", "{warning}", '"warn"', "`err`", "*warn*").
 */
export function normalizeActivityLogLevel(
  level: unknown
): ActivityLogCanonicalLevel | null {
  if (typeof level !== "string") return null;
  const normalized = trimActivityLogLevelNoise(level.trim().toLowerCase());
  const tokens = normalized.match(/[a-z]+/g) ?? [normalized];
  let sawWarning = false;
  let sawInfo = false;
  for (const token of tokens) {
    const canonical =
      token === "warn"
        ? "warning"
        : token === "err" ||
            token === "fatal" ||
            token === "crit" ||
            token === "critical"
          ? "error"
          : token;
    if (canonical === "error") return "error";
    if (canonical === "warning") sawWarning = true;
    if (canonical === "info") sawInfo = true;
  }
  if (sawWarning) return "warning";
  if (sawInfo) return "info";
  return null;
}

/** Returns true when the level resolves to canonical `"error"` (including `"err"`). */
export function isActivityLogErrorLevel(level: unknown): boolean {
  return normalizeActivityLogLevel(level) === "error";
}

/** Returns true when the level resolves to canonical `"warning"` (including `"warn"`). */
export function isActivityLogWarningLevel(level: unknown): boolean {
  return normalizeActivityLogLevel(level) === "warning";
}

/** Returns true when the level resolves to canonical `"warning"` or `"error"`. */
export function isActivityLogWarningOrErrorLevel(level: unknown): boolean {
  const canonical = normalizeActivityLogLevel(level);
  return canonical === "warning" || canonical === "error";
}
