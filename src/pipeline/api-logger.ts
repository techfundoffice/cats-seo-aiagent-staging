/**
 * api-logger.ts — `loggedFetch()` wraps an outbound `fetch()` and emits
 * one structured activity-log entry per call under role `apiCall`. The
 * dashboard's `ApiActivityPanel` surfaces these so operators can see, in
 * real time, every external API hit the Worker makes (status, duration,
 * host, path) without grep'ing the full activity log.
 *
 * Design rules:
 *   • Pass-through: returns the response unchanged. Network errors
 *     re-throw so callers (which already have try/catch) keep their
 *     existing error paths.
 *   • Level mapping by status: 5xx + network = error, 4xx = warning,
 *     2xx/3xx = info. The panel color-codes off `level`.
 *   • Single line format: `[<api>] <op?> <METHOD> <host><path> →
 *     <status> (<ms>ms)[: <detail>]`. The panel has a regex that parses this
 *     into structured columns; keep the format stable.
 *   • Query-string safety: sensitive query params are redacted before
 *     writing to the activity log.
 */

import { errMsg, normalizeSingleLine } from "./http-utils";
import type { SEOArticleAgent } from "../server";

/**
 * Small metadata bag for `loggedFetch()` so callers can identify the
 * upstream API and optional operation name in structured activity-log lines.
 */
export interface LoggedFetchOptions {
  /** API name shown in brackets, e.g. "GitHub", "CF Browser Rendering". */
  api: string;
  /** Optional short label for the specific operation, e.g. "create issue". */
  op?: string;
}

const SENSITIVE_QUERY_PARAM_RE =
  /^(token|access[_-]?token|id[_-]?token|refresh[_-]?token|oauth[_-]?verifier|oauth[_-]?code|auth[_-]?code|authorization[_-]?code|api[_-]?key|key|secret|password|signature|auth|authorization|credential|client[_-]?id|client[_-]?secret)$/i;

const AUTH_CODE_CONTEXT_KEY_RE =
  /^(client[_-]?id|client[_-]?secret|redirect[_-]?uri|code[_-]?challenge|code[_-]?verifier|oauth[_-]?verifier|oauth[_-]?code|auth[_-]?code|authorization[_-]?code|response[_-]?type|grant[_-]?type)$/i;
// RFC 9110 `method` is a case-sensitive token; accept the full token char set
// after uppercasing for stable log formatting.
const HTTP_METHOD_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Z-]+$/;
const MAX_ERROR_BODY_EXCERPT_CHARS = 300;
// Matches `key=value` pairs in free-form text where value may be quoted and
// include spaces. Captures a leading delimiter so replacement preserves spacing.
const BODY_KEY_VALUE_RE =
  /(^|[\s,;])([^=\s,;]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/g;

function normalizeQueryParamKey(key: string): string {
  let stripped = key.trim().replace(/(?:\[\])+$/g, "");
  // Reduce dotted and/or bracket-nested keys to their leaf segment so the
  // sensitive-param regex catches paths like "auth.token" → "token",
  // "user[api_key]" → "api_key", mixed keys like
  // "auth.credentials[api_key]" → "api_key", and camelCase forms like
  // "oauth.accessToken" → "access_token".
  while (true) {
    const bracketMatch = stripped.match(/\[([^[\]]+)\]$/);
    if (bracketMatch) {
      stripped = bracketMatch[1];
      continue;
    }

    const dotIdx = stripped.lastIndexOf(".");
    if (dotIdx >= 0) {
      stripped = stripped.slice(dotIdx + 1);
      continue;
    }

    return stripped.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  }
}

function redactSearchParams(searchParams: URLSearchParams): string {
  const normalizedKeys = Array.from(
    searchParams.keys(),
    normalizeQueryParamKey
  );
  const hasAuthCodeContext = normalizedKeys.some((candidate) =>
    AUTH_CODE_CONTEXT_KEY_RE.test(candidate)
  );
  const redacted = new URLSearchParams();
  for (const [key, value] of searchParams.entries()) {
    const normalizedKey = normalizeQueryParamKey(key);
    redacted.append(
      key,
      SENSITIVE_QUERY_PARAM_RE.test(normalizedKey) ||
        // Plain `code` is too generic to redact unconditionally, but in an
        // OAuth-style query shape it usually carries a short-lived auth code.
        (normalizedKey === "code" && hasAuthCodeContext)
        ? "[REDACTED]"
        : value
    );
  }
  const serialized = redacted.toString();
  return serialized ? `?${serialized}` : "";
}

function redactRawPathQuery(raw: string): string {
  const hashStart = raw.indexOf("#");
  const queryStart = raw.indexOf("?");
  if (queryStart === -1 || (hashStart !== -1 && queryStart > hashStart)) {
    return hashStart === -1 ? raw : `${raw.slice(0, hashStart)}#…`;
  }

  const pathPart = raw.slice(0, queryStart);
  const queryPart = raw.slice(
    queryStart + 1,
    hashStart === -1 ? undefined : hashStart
  );
  // Fragment payloads can carry access tokens (e.g. OAuth implicit flow).
  // Preserve only fragment presence, never the raw fragment content.
  const hashPart = hashStart === -1 ? "" : "#…";
  const redactedQuery = redactSearchParams(new URLSearchParams(queryPart));
  return `${pathPart}${redactedQuery}${hashPart}`;
}

function redactJsonLikeBodyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonLikeBodyValue(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = SENSITIVE_QUERY_PARAM_RE.test(normalizeQueryParamKey(key))
        ? "[REDACTED]"
        : redactJsonLikeBodyValue(nested);
    }
    return result;
  }
  return value;
}

function redactSensitiveBodyExcerpt(rawExcerpt: string): string {
  const trimmed = rawExcerpt.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return normalizeSingleLine(
        JSON.stringify(redactJsonLikeBodyValue(parsed))
      );
    } catch {
      // Best-effort only; fall through to token-pattern redaction.
    }
  }
  return rawExcerpt.replace(
    BODY_KEY_VALUE_RE,
    (full, prefix: string, key: string, value: string) =>
      SENSITIVE_QUERY_PARAM_RE.test(normalizeQueryParamKey(key))
        ? `${prefix}${key}=[REDACTED]`
        : `${prefix}${key}=${value}`
  );
}

function normalizeMethod(value: unknown): string {
  if (typeof value !== "string") return "GET";
  const firstToken = normalizeSingleLine(value).split(" ")[0];
  const upper = firstToken.toUpperCase();
  return HTTP_METHOD_TOKEN_RE.test(upper) ? upper : "GET";
}

/**
 * Fetch an external URL and emit a single structured activity-log line for
 * the request outcome under role `apiCall`.
 *
 * This helper preserves the original `fetch()` behavior: successful responses
 * are returned unchanged, and network failures are re-thrown after logging so
 * callers keep their existing retry/error handling. URL query parameters are
 * redacted before logging to avoid leaking secrets into the activity feed.
 */
export async function loggedFetch(
  agent: SEOArticleAgent,
  input: string | URL | Request,
  init: RequestInit | undefined,
  opts: LoggedFetchOptions
): Promise<Response> {
  const requestMethod = input instanceof Request ? input.method : undefined;
  const urlStr =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = normalizeMethod(init?.method ?? requestMethod);
  const apiLabel = normalizeSingleLine(opts.api) || "api";
  const op = normalizeSingleLine(opts.op ?? "");

  let host = "?";
  let path = urlStr;
  try {
    const u = new URL(urlStr);
    host = u.host;
    path = `${u.pathname}${redactSearchParams(u.searchParams)}`;
  } catch {
    path = redactRawPathQuery(urlStr);
  }

  const opLabel = op ? ` ${op}` : "";
  const start = Date.now();

  let resp: Response;
  try {
    resp = await fetch(input, init);
  } catch (err: unknown) {
    const ms = Date.now() - start;
    const networkDetail = normalizeSingleLine(errMsg(err));
    const detailSuffix = networkDetail === "" ? "" : `: ${networkDetail}`;
    agent.log(
      "error",
      `[${apiLabel}]${opLabel} ${method} ${host}${path} → network error (${ms}ms)${detailSuffix}`,
      "apiCall"
    );
    throw err;
  }

  const ms = Date.now() - start;
  const status = resp.status;
  const level: "error" | "warning" | "info" =
    status >= 500 ? "error" : status >= 400 ? "warning" : "info";
  const statusDetail =
    status >= 400 ? normalizeSingleLine(resp.statusText ?? "") : "";
  const retryAfterHeader =
    status === 429 || status === 503
      ? normalizeSingleLine(resp.headers.get("retry-after") ?? "")
      : "";
  // On 4xx/5xx, peek the response body so the activity log shows the
  // API's actual error message (e.g. GitHub's `{"message":"...", "documentation_url":"..."}`)
  // instead of just the generic status text. Clones first so the caller
  // can still consume the body unchanged.
  let bodyExcerpt = "";
  if (status >= 400) {
    try {
      const peek = await resp.clone().text();
      bodyExcerpt = redactSensitiveBodyExcerpt(normalizeSingleLine(peek)).slice(
        0,
        MAX_ERROR_BODY_EXCERPT_CHARS
      );
    } catch {
      bodyExcerpt = "";
    }
  }
  const detailParts = [
    statusDetail,
    retryAfterHeader ? `retry-after=${retryAfterHeader}` : "",
    bodyExcerpt ? `body=${bodyExcerpt}` : ""
  ].filter(Boolean);
  const detailSuffix =
    detailParts.length === 0 ? "" : `: ${detailParts.join("; ")}`;

  agent.log(
    level,
    `[${apiLabel}]${opLabel} ${method} ${host}${path} → ${status} (${ms}ms)${detailSuffix}`,
    "apiCall"
  );
  return resp;
}
