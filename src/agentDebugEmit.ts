/** Debug pipeline: persist on the DO (see `ingestDebugLog`) + optional local Cursor ingest. */

import { errMsg } from "./pipeline/http-utils";

const LOCAL_DEBUG_INGEST =
  "http://127.0.0.1:7276/ingest/8078d976-ad4a-41cd-9b43-196435b2f79e";
const DEFAULT_DEBUG_SESSION_ID = "c661fb";
const MAX_DEBUG_SESSION_ID_LENGTH = 64;
const DEBUG_SESSION_ID_UNSAFE_CHARS_RE = /[^A-Za-z0-9._-]+/g;
let localDebugMirrorAvailable = true;
const EXPECTED_LOCAL_INGEST_UNAVAILABLE_RE =
  /(fetch failed|econnrefused|econnreset|connection refused|socket hang up|network(?:error| request failed)|timed? out|aborted)/i;
// 404/410: the local Cursor ingest server isn't running this session.
// 403: Cloudflare Workers cannot reach 127.0.0.1 in production — the
// runtime returns HTTP 403 with "error code: 1003" ("Direct IP access
// not allowed"). Before this entry was added, every single debug
// emit produced a "Agent debug: local mirror returned HTTP 403
// Forbidden" warning in the activity log — pure noise that buried
// real errors. Detecting it here flips `localDebugMirrorAvailable`
// false on the first attempt and stops the subsequent storm.
const EXPECTED_LOCAL_INGEST_UNAVAILABLE_STATUSES = new Set([403, 404, 410]);

function sanitizeDebugSessionId(value: string): string {
  return value
    .replace(DEBUG_SESSION_ID_UNSAFE_CHARS_RE, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, MAX_DEBUG_SESSION_ID_LENGTH);
}

/**
 * Minimal sink contract for structured debug-log persistence.
 * Implementations receive the final entry after `emitAgentDebugLog()` injects
 * its fallback `sessionId` and `timestamp`, and should avoid throwing.
 * `log` is used to surface debug-pipeline failures to the React dashboard;
 * `SEOArticleAgent` satisfies this interface automatically.
 */
export type AgentDebugLogSink = {
  ingestDebugLog(entry: Record<string, unknown>): void;
  log(level: string, msg: string): void;
};

/**
 * Normalize a debug session identifier. Empty/whitespace values fall back to
 * the default so `/api/debug-ndjson` queries stay discoverable. Unsafe header
 * characters are normalized to keep mirroring requests valid.
 */
export function normalizeDebugSessionId(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_DEBUG_SESSION_ID;
  }
  const normalized = sanitizeDebugSessionId(value.trim());
  return normalized === "" ? DEFAULT_DEBUG_SESSION_ID : normalized;
}

/**
 * Best-effort debug emitter for pipeline observability.
 * Ensures every payload has a `sessionId` and `timestamp`, writes to
 * the Durable Object sink, and mirrors to the local ingest endpoint
 * when available. Never throws.
 */
export function emitAgentDebugLog(
  agent: AgentDebugLogSink,
  entry: Record<string, unknown>
): void {
  const sessionId = normalizeDebugSessionId(entry.sessionId);
  const timestamp =
    typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : Date.now();
  const full: Record<string, unknown> = {
    ...entry,
    sessionId,
    timestamp
  };
  try {
    agent.ingestDebugLog(full);
  } catch (error: unknown) {
    agent.log(
      "warning",
      `Agent debug: DO ingest failed (non-fatal) — ${errMsg(error)}`
    );
  }
  if (!localDebugMirrorAvailable) {
    return;
  }
  // #region agent log
  fetch(LOCAL_DEBUG_INGEST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": sessionId
    },
    body: JSON.stringify(full),
    signal: AbortSignal.timeout(1_000)
  })
    .then(async (response) => {
      if (response.ok) {
        return;
      }
      if (EXPECTED_LOCAL_INGEST_UNAVAILABLE_STATUSES.has(response.status)) {
        localDebugMirrorAvailable = false;
        return;
      }
      const statusDetail = response.statusText
        ? `${response.status} ${response.statusText}`
        : String(response.status);
      let responseDetail = "";
      try {
        const responseBody = (await response.text())
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 240);
        if (responseBody) {
          responseDetail = ` — ${responseBody}`;
        }
      } catch (error: unknown) {
        responseDetail = ` — response body unavailable: ${errMsg(error)}`;
      }
      agent.log(
        "warning",
        `Agent debug: local mirror returned HTTP ${statusDetail}${responseDetail}`
      );
    })
    .catch((error: unknown) => {
      const detail = errMsg(error);
      if (EXPECTED_LOCAL_INGEST_UNAVAILABLE_RE.test(detail)) {
        localDebugMirrorAvailable = false;
        return;
      }
      agent.log(
        "warning",
        `Agent debug: local mirror fetch failed — ${detail}`
      );
    });
  // #endregion
}
