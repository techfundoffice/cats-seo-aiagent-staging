/**
 * Shared HTTP helpers for pipeline fetchers.
 *
 * Every tier in a fallback chain (SERP, Amazon, competitor, benchmark)
 * has to decide: on a non-2xx, is it worth retrying, is it worth
 * skipping this source for a while, or is it a hard client-side error
 * not worth bothering with?  The canonical lists live here so every
 * caller agrees.
 */

/**
 * HTTP status codes that indicate the remote is either rate-limiting
 * or having a transient server-side problem — worth retrying once.
 * Intentionally excludes 403 / 408 / 425 because those can mean "your
 * request is malformed or unauthorised" and a plain retry rarely
 * helps.  Used only to seed TRANSIENT_HTTP_STATUSES below.
 */
const RETRY_5XX_STATUSES = new Set([
  429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530
]);

/**
 * HTTP status codes that signal "this source is unhealthy for us
 * right now" — includes everything in RETRY_5XX_STATUSES plus
 * 403 / 408 / 425, which in our environment almost always mean the
 * Cloudflare Worker egress IP got soft-blocked by a bot-detection
 * system.  The source-health circuit breaker uses this set to decide
 * when to put a source in cooldown.
 */
export const TRANSIENT_HTTP_STATUSES = new Set<number>([
  ...RETRY_5XX_STATUSES,
  403,
  408,
  425
]);

/** AbortSignal.timeout() accepts delays in the uint32 range (2^32 - 1 max). */
export const MAX_ABORT_TIMEOUT_MS = 4_294_967_295;

/**
 * Clamp an optional timeout to the range accepted by `AbortSignal.timeout()`.
 *
 * Returns `undefined` when the input is missing, non-finite, or <= 0 so
 * callers can either omit the timeout entirely or apply their own default.
 */
export function clampAbortTimeoutMs(
  timeoutMs: number | undefined
): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return undefined;
  }
  const normalized = Math.trunc(timeoutMs);
  if (normalized <= 0) {
    return undefined;
  }
  return Math.min(normalized, MAX_ABORT_TIMEOUT_MS);
}

/**
 * Escape characters that are special in HTML/XML documents.
 * Used by html-builder.ts for article HTML, and by feed-syndication.ts and
 * indexing.ts for sitemap/RSS content.
 * Handles the five predefined XML entities: &, <, >, ", '.
 * Nullish/non-string inputs normalize to "" so scraped optional values do not
 * crash downstream sitemap/RSS builders.
 */
export function escXml(s: string | null | undefined): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Decode the HTML entities that `escXml` above produces, plus `&nbsp;` /
 * `&#160;` / `&#xA0;` and the numeric `&#39;` apostrophe form.  Used by the
 * several "strip HTML and get visible text" helpers scattered across the
 * pipeline (writer, serp, siss-optimizer, editorial-agent) so entity handling
 * stays consistent in one place.
 *
 * Decodes the named entities emitted by `escXml` / pipeline-generated HTML,
 * plus the three non-breaking-space forms (`&nbsp;`, `&#160;`, `&#xA0;`) that
 * appear in scraped competitor and SERP pages. Decodes `&amp;` last so already-
 * escaped entities like `&amp;lt;` are reduced to `&lt;` (single decode) instead
 * of over-decoding to `<`. It is NOT a general-purpose HTML entity decoder.
 * Nullish/non-string inputs normalize to "" so scraped optional text does not
 * fail before callers can trim or fallback.
 */
export function unescapeHtml(s: string | null | undefined): string {
  // &amp; is decoded last so doubly-encoded entities (e.g. &amp;lt;) are only
  // single-decoded to &lt; rather than being incorrectly resolved all the way
  // to <.  All other named/numeric entities are safe to decode first because
  // they cannot produce a new &-prefixed sequence after substitution.
  if (typeof s !== "string") return "";
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&#xA0;/gi, " ")
    .replace(/&amp;/g, "&");
}

function hashKeywordSlug(normalizedKeyword: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalizedKeyword.length; i++) {
    hash ^= normalizedKeyword.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Convert a keyword string to a URL-safe slug.
 *
 * Lowercases the input, replaces every run of non-alphanumeric characters
 * with a single hyphen, then strips any leading or trailing hyphens. When
 * that sanitization would erase the whole keyword, falls back to a
 * deterministic hashed slug so downstream KV/database keys never become
 * blank. Single-token slugs also receive a stable hash suffix to avoid
 * broad head-term routes like `/best` colliding with non-article pages on
 * the live site.
 *
 * Examples:
 *   `keywordToSlug("Best puzzle feeder for fast-eating cats!")` → `"best-puzzle-feeder-for-fast-eating-cats"`
 *   `keywordToSlug("best")` → `"best-<hash>"`
 *   `keywordToSlug("  --cats--  ")` → `"cats-<hash>"`
 *
 * Used in keywords.ts, scout.ts, escalate-to-claude.ts, and server.ts to
 * derive the database/KV key slug from a raw keyword string.  Centralised
 * here so the derivation is consistent everywhere.
 */
export function keywordToSlug(keyword: string): string {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) {
    return "keyword-empty";
  }
  const slug = normalizedKeyword
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const slugParts = slug.split("-").filter(Boolean);
  if (slugParts.length > 1) {
    return slug;
  }
  const suffix = hashKeywordSlug(slug || normalizedKeyword);
  if (slug) {
    return `${slug}-${suffix}`;
  }
  return `keyword-${suffix}`;
}

/**
 * Extract the message string from an unknown thrown value.
 *
 * Returns a non-empty string in all cases:
 * - For `Error` instances: returns the trimmed `e.message`; when that is
 *   blank falls back to `String(e)` (gives at least the class name, e.g.
 *   `"TypeError"` or `"DOMException"`) so callers never receive `""`.
 *   When the error has a `.cause` field (e.g. `new Error("x", { cause: y })`),
 *   one level of cause context is appended as `"x — cause: y"` for richer
 *   activity-log diagnostics.
 * - For structured non-`Error` objects: prefers the first non-empty message
 *   found in `message`, `detail`, nested `error.message`, or the first entry in
 *   `errors[]` / `issues[]`, so API payloads like `{ error: "..." }` or
 *   `{ errors: [{ message: "..." }] }` log something useful instead of
 *   `[object Object]`.
 * - For anything else: `String(e)`, with `"Unknown error"` as last resort.
 *
 * Safe to call in any `catch (err: unknown)` block regardless of what was
 * thrown.
 *
 * Companion to `errStack` — use both when you need a compact message and
 * a stack trace for escalation metadata.
 *
 * Usage:
 *   ```ts
 *   } catch (err: unknown) {
 *     agent.log("error", `Step failed: ${errMsg(err)}`);
 *   }
 *   ```
 */
export function errMsg(e: unknown): string {
  const base = errMsgBase(e);
  if (!(e instanceof Error)) {
    return base;
  }
  // Append one level of error.cause when present so chained errors
  // (e.g. `new Error("fetch failed", { cause: new TypeError("connection refused") })`)
  // surface the root cause in activity-log messages without a separate helper.
  const cause = (e as { cause?: unknown }).cause;
  if (cause != null) {
    const causeMsg = errMsgBase(cause);
    if (causeMsg && causeMsg !== base) {
      return `${base} — cause: ${causeMsg}`;
    }
  }
  return base;
}

/**
 * Inner variant of `errMsg` used for cause-expansion: same extraction logic
 * but without recursing into `.cause` again, preventing unbounded nesting in
 * deeply-chained errors.
 */
function errMsgBase(e: unknown): string {
  if (e instanceof Error) {
    const msg = e.message.trim();
    // Fall back to String(e) so callers see at least "TypeError" rather than "".
    // In V8, Error.prototype.toString() omits the ": " separator when message is
    // blank, so `String(new TypeError(""))` yields "TypeError", not "TypeError: ".
    const fallback = String(e).trim();
    return msg || fallback || "Unknown error";
  }
  const structured = getStructuredErrorMessage(e);
  if (structured) return structured;
  try {
    return String(e).trim() || "Unknown error";
  } catch {
    return "Unknown error";
  }
}

function getStructuredErrorMessage(
  value: unknown,
  depth = 0
): string | undefined {
  if (depth > 2 || typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["message", "detail"] as const) {
    const candidate = safeReadRecordField(record, key);
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }

  const nestedError = safeReadRecordField(record, "error");
  if (typeof nestedError === "string") {
    const trimmed = nestedError.trim();
    if (trimmed) return trimmed;
  }
  const nestedErrorMessage = getStructuredErrorMessage(nestedError, depth + 1);
  if (nestedErrorMessage) {
    return nestedErrorMessage;
  }

  for (const key of ["errors", "issues"] as const) {
    const collection = safeReadRecordField(record, key);
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed) return trimmed;
        continue;
      }
      const nestedEntryMessage = getStructuredErrorMessage(entry, depth + 1);
      if (nestedEntryMessage) {
        return nestedEntryMessage;
      }
    }
  }

  return undefined;
}

function safeReadRecordField(record: Record<string, unknown>, key: string) {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

/**
 * Extract the stack trace from an unknown thrown value, capped to `maxLen`
 * characters (default 1000).  Returns an empty string when the thrown
 * value has no string `stack` property.
 *
 * Handles both native `Error` instances and Error-like objects (e.g. errors
 * thrown across Cloudflare Worker boundaries or from third-party libraries)
 * that carry a string `stack` field without being an `instanceof Error`.
 * Mirrors the non-Error handling already present in `errMsg`.
 *
 * Companion to `errMsg` — use both together when you want to capture a
 * compact stack head for escalation metadata without writing the inline
 * `err instanceof Error ? (err.stack?.slice(0, 1000) ?? "") : ""` ternary
 * every time.
 *
 * Usage:
 *   `catch (err: unknown) {
 *     const stack = errStack(err);
 *     await escalate({ metadata: stack ? { stackHead: stack } : undefined });
 *   }`
 */
export function errStack(e: unknown, maxLen = 1000): string {
  const normalizedMaxLen =
    Number.isFinite(maxLen) && maxLen > 0 ? Math.trunc(maxLen) : 0;
  if (normalizedMaxLen <= 0) return "";
  if (e instanceof Error) return e.stack?.slice(0, normalizedMaxLen) ?? "";
  if (
    typeof e === "object" &&
    e !== null &&
    "stack" in e &&
    typeof (e as { stack?: unknown }).stack === "string"
  ) {
    return (e as { stack: string }).stack.slice(0, normalizedMaxLen);
  }
  return "";
}

/**
 * Collapse every run of whitespace (including newlines and tabs) into a
 * single space and trim both ends.
 *
 * Used wherever arbitrary text must be embedded in a single-line log
 * message, GitHub issue title, or similar context that cannot safely
 * contain embedded newlines.
 *
 * Centralized here so the two near-identical private copies that lived
 * in `api-logger.ts` and `escalate-to-claude.ts` stay in sync.
 *
 * Accepts unknown runtime input defensively. Non-string values are coerced via
 * `String(...)`; null/undefined and unstringifiable values return `""` instead
 * of throwing.
 */
export function normalizeSingleLine(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (value == null) {
    return "";
  }
  try {
    return String(value).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * Extract the suggestion strings from a Google Autocomplete / suggestqueries
 * response payload.
 *
 * The endpoint returns JSON in the form `[query, suggestions, ...]`, but the
 * shape is not typed and malformed payloads should be treated as a fetch
 * failure rather than crashing or counting as a successful lookup.
 *
 * Returns `undefined` when the payload does not contain a suggestions array at
 * index 1, or when a non-empty suggestions slot contains no extractable
 * string suggestions (payload-shape drift). Supports both common response
 * shapes:
 * - `["query", ["suggestion 1", "suggestion 2"]]`
 * - `["query", [["suggestion 1", ...], ["suggestion 2", ...]]]`
 *
 * Any members that do not expose a string suggestion are ignored; accepted
 * strings have internal whitespace collapsed, then are trimmed. Empty results
 * are dropped.
 */
export function getGoogleSuggestStrings(
  payload: unknown
): string[] | undefined {
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) {
    return undefined;
  }
  const suggestions = payload[1].flatMap((value) => {
    const suggestion =
      typeof value === "string"
        ? value
        : Array.isArray(value) && typeof value[0] === "string"
          ? value[0]
          : undefined;
    if (!suggestion) return [];
    const normalized = suggestion.replace(/\s+/g, " ").trim();
    return normalized ? [normalized] : [];
  });
  // A non-empty suggestions slot that yields zero valid strings indicates
  // payload-shape drift; treat it as malformed so callers can log/track it.
  if (payload[1].length > 0 && suggestions.length === 0) {
    return undefined;
  }
  return suggestions;
}

/**
 * Read an optional Cloudflare Worker env binding that is not declared in
 * the static `Env` type (e.g. bindings added later or only set in some
 * deploy environments). Returns the trimmed string value, or `undefined`
 * when the binding is absent, not a string, or blank after trimming.
 *
 * Prefer this over the double-cast pattern:
 *   `(agent.envBindings as unknown as Record<string, string | undefined>).KEY`
 *
 * Accepts any runtime value for `env` and safely returns `undefined` when the
 * input is nullish/non-object, or when dynamic property access throws.
 *
 * Usage:
 *   `getEnvBinding(agent.envBindings, "APIFY_TOKEN")`
 *   `getEnvBinding(env, "INDEXNOW_KEY")`
 */
export function getEnvBinding(env: unknown, key: string): string | undefined {
  if (!env || typeof env !== "object") return undefined;
  const envObj = env as Record<string, unknown>;
  let value: unknown;
  try {
    if (!Object.prototype.hasOwnProperty.call(envObj, key)) return undefined;
    value = envObj[key];
  } catch {
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Extract the first well-delimited JSON object from `text`.
 *
 * Scans from the first `{` character, tracking brace depth and quoted-string
 * state (including backslash escape sequences), and returns the substring
 * from that `{` up to and including the matching closing `}`.
 *
 * This is more robust than a simple `indexOf("{")` + `lastIndexOf("}")`
 * approach: it correctly handles braces inside double-quoted JSON strings and
 * single-quoted pseudo-JSON strings, and stops at the first *complete* object
 * rather than including any trailing text or a second JSON-like structure
 * after the closing brace.
 *
 * When the input contains no object-like `{ ... }` block, returns `null`.
 * If an object-like block starts but is never closed, returns the tail from
 * that opening `{` so callers can still pass the result to `repairJson` which
 * can append missing closing brackets.
 *
 * @example
 * extractFirstJsonObject('prefix {"a":1} trailing } text')
 * // → '{"a":1}'
 *
 * extractFirstJsonObject('{"a":"{b}"}')
 * // → '{"a":"{b}"}'   (brace inside string value is ignored)
 */
export function extractFirstJsonObject(text: string): string | null {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start === -1) return null;

    let depth = 0;
    let inDoubleString = false;
    let inSingleString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      if (inDoubleString || inSingleString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (inDoubleString && char === '"') {
          inDoubleString = false;
        } else if (inSingleString && char === "'") {
          inSingleString = false;
        }
        continue;
      }

      if (char === '"') {
        inDoubleString = true;
        continue;
      }
      if (char === "'") {
        inSingleString = true;
        continue;
      }
      if (char === "{") {
        depth++;
        continue;
      }
      if (char === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          if (looksLikeJsonObjectCandidate(candidate)) {
            return candidate;
          }
          searchFrom = start + 1;
          break;
        }
      }
    }

    // Opening brace was never closed (truncated output) — return the tail so
    // callers can pass it to repairJson which will append the missing braces.
    if (depth > 0) {
      return text.slice(start);
    }
  }
  return null;
}

function looksLikeJsonObjectCandidate(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed === "{}") {
    return true;
  }
  let depth = 0;
  let inDoubleString = false;
  let inSingleString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (inDoubleString || inSingleString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (inDoubleString && char === '"') {
        inDoubleString = false;
      } else if (inSingleString && char === "'") {
        inSingleString = false;
      }
      continue;
    }
    if (char === '"') {
      inDoubleString = true;
      continue;
    }
    if (char === "'") {
      inSingleString = true;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      continue;
    }
    if (
      char === ":" &&
      depth === 1 &&
      hasLikelyObjectKeyBeforeColon(trimmed, i)
    ) {
      return true;
    }
  }
  return false;
}

function hasLikelyObjectKeyBeforeColon(
  text: string,
  colonIndex: number
): boolean {
  for (let i = colonIndex - 1; i >= 0; i--) {
    const char = text[i];
    if (/\s/.test(char)) {
      continue;
    }
    // Accept both quote styles because model output often emits pseudo-JSON
    // keys (`{'key': ...}`) that repairJson can normalize before parsing.
    return char === '"' || char === "'" || /[a-zA-Z0-9_]/.test(char);
  }
  return false;
}

/**
 * Best-effort repair of malformed JSON strings produced by AI models.
 *
 * Applies a sequence of cheap textual fixups that recover the most common
 * truncation and formatting issues seen in Kimi / Workers AI output:
 *
 *   • Strips markdown code fences (```json … ```)
 *   • Removes C0 control characters that break `JSON.parse`
 *   • Closes truncated string literals (trailing `"…` with no closing `"`)
 *   • Removes trailing commas before `}` or `]`
 *   • Quotes bare object keys (`{ key: "v" }` → `{ "key": "v" }`)
 *   • Converts single-quoted values to double-quoted, escaping inner `"`
 *   • Appends missing closing braces / brackets
 *   • Normalizes CRLF → LF and escapes bare newlines inside string values
 *
 * The returned string is **not guaranteed** to be valid JSON — always wrap
 * the subsequent `JSON.parse` call in a try/catch. This helper is a best-
 * effort pass, not a strict parser.
 *
 * Usage:
 *   ```ts
 *   try {
 *     parsed = JSON.parse(raw);
 *   } catch {
 *     const repaired = repairJson(raw);
 *     parsed = JSON.parse(repaired); // may still throw
 *   }
 *   ```
 */
export function repairJson(raw: string): string {
  let s = raw;
  // Strip markdown fences
  s = s.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
  // Remove control characters except \n, \r, \t (do this BEFORE newline escaping)
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  // Fix truncated strings BEFORE closing brackets so the structure is valid.
  // Detect whether we ended inside an unterminated double-quoted string using
  // proper escape tracking (instead of a tail regex) so both of these cases
  // are handled correctly:
  //   - `{"key": "value"`  -> no extra quote (already closed; only `}` missing)
  //   - `{"key": "`        -> append missing closing quote
  {
    let inStr = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
      const char = s[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inStr = !inStr;
      }
    }
    if (inStr) {
      s += '"';
    }
  }
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([\]}])/g, "$1");
  // Fix unquoted and single-quoted keys:
  //   { key: "val" }   -> { "key": "val" }
  //   { 'key': "val" } -> { "key": "val" }
  s = s.replace(/([{,]\s*)'?([a-zA-Z_]\w*)'?\s*:/g, '$1"$2":');
  // Fix single quotes to double quotes for values (lookbehind).
  // Escape backslashes first, then double-quotes, so the resulting
  // double-quoted JSON string is syntactically valid:
  //   { key: '15" handle' }    → { key: "15\" handle" }
  //   { key: 'path\to\file' }  → { key: "path\\to\\file" }
  // Note: pre-existing JSON escape sequences like \n, \t in the single-
  // quoted value are re-escaped to \\n, \\t (literal two-char sequences).
  // That is the correct conservative behaviour for a best-effort repair.
  s = s.replace(/(?<=:\s*)'([^']*)'/g, (_match, inner: string) => {
    const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
  // Close unclosed brackets/braces from truncated output.
  // Walk through the string tracking open/close pairs outside of string
  // literals. The stack-based approach ensures we close in the right order
  // for nested structures — e.g. {"arr": [{"key": "val" needs }]} not }}],
  // which the old naïve count approach (always } before ]) got wrong.
  // Escape tracking uses a proper `escaped` flag so that `\\"` (an escaped
  // backslash followed by a string-closing quote) is handled correctly —
  // the preceding-backslash heuristic used previously misidentified `\\"`
  // as an escaped quote and left the string tracker in the wrong state.
  {
    const openStack: string[] = [];
    let inStr = false;
    let escaped = false;
    for (let ci = 0; ci < s.length; ci++) {
      const ch = s[ci];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (!inStr) {
        if (ch === "{" || ch === "[") openStack.push(ch);
        else if (ch === "}" && openStack[openStack.length - 1] === "{")
          openStack.pop();
        else if (ch === "]" && openStack[openStack.length - 1] === "[")
          openStack.pop();
      }
    }
    while (openStack.length > 0) {
      s += openStack.pop() === "{" ? "}" : "]";
    }
  }
  // Remove trailing commas a second time: the bracket-closing pass above may
  // have appended `}` or `]` directly after a trailing comma that was not yet
  // followed by a closing bracket at the earlier removal step (step 4). A
  // truncated object like `{"k":1,` becomes `{"k":1,}` after bracket closing
  // and requires this second sweep to produce valid JSON.
  s = s.replace(/,\s*([\]}])/g, "$1");
  // Normalize CRLF → LF so the single-pass escaping below catches it.
  s = s.replace(/\r\n/g, "\n");
  // Escape any remaining bare CR (e.g. from a lone \r in Kimi output) as \r.
  s = s.replace(/\r/g, "\\r");
  // Escape unescaped literal LF inside JSON string values.
  // Use (\\*)\n rather than (?<!\\)\n so that a literal newline preceded by
  // an escaped backslash (e.g. \\\n — two backslashes then a bare newline)
  // is also escaped. The lookbehind only checks the single character
  // immediately before the newline, so it incorrectly leaves the newline
  // untouched when that character is the *second* backslash of a `\\` pair.
  // Capturing the full run of backslashes and re-appending them keeps the
  // existing escapes intact while always escaping the trailing newline.
  s = s.replace(/(\\*)\n/g, "$1\\n");
  return s;
}

/**
 * Redact secret-shaped substrings from any diagnostic text that may be
 * persisted, mirrored, or surfaced via a public sink: the public
 * `/api/logs` activity log, Google Sheets mirror, dashboard render, KV
 * blobs feeding GitHub issue bodies. Centralised here so a single
 * source of truth covers every downstream sink — escalation issue
 * bodies, observer narratives, defect-finding evidence, the activity
 * log itself.
 *
 * Pattern set is deliberately narrow — only matches strings with
 * known shapes so legitimate debugging info passes through unchanged:
 *
 *   • `Authorization: Bearer <token>` headers
 *   • `sk-ant-…` / `sk-…` API keys (Anthropic, OpenAI)
 *   • `ck_…` Composio keys
 *   • `AKIA…` AWS access keys
 *   • GitHub tokens (`ghp_…`, `ghs_…`, `ghr_…`, `gho_…`, `ghu_…`,
 *     `github_pat_…`)
 *   • URL query-param secrets (`?api_key=`, `?token=`, `?password=`,
 *     `?secret=`, `?access_token=`, `?Signature=`, `?X-Amz-Signature=`,
 *     `?sig=`, `?signature=`)
 *   • JWT-shaped 3-segment tokens
 *   • `Cookie:` / `Set-Cookie:` header bodies
 *   • Webhook HMAC signature headers (`X-Hub-Signature(-256)?`,
 *     `X-Webhook-Signature`, `X-GitHub-Signature`)
 *   • Slack bot/app/user tokens (`xoxb-…`, `xoxa-…`, `xoxp-…`,
 *     `xoxr-…`, `xoxs-…`)
 *   • OpenAI legacy session identifiers (`sess-…`)
 *   • Stripe live/test keys (`sk_live_…`, `sk_test_…`, `pk_live_…`,
 *     `pk_test_…`, `rk_live_…`, `rk_test_…`, `whsec_…`)
 *
 * Each match becomes `[REDACTED]`. Idempotent: redacting an already-
 * redacted string is a no-op.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  // Authorization: Bearer <token>
  out = out.replace(
    /(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._\-=+/]{20,}/gi,
    "$1[REDACTED]"
  );
  // sk-ant-… (Anthropic) MUST come before sk-… so we match the longer
  // prefix first.
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
  out = out.replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
  // ck_… (Composio) keys
  out = out.replace(/\bck_[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
  // AWS access keys
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");
  // GitHub tokens
  out = out.replace(
    /\b(?:ghp|ghs|ghr|gho|ghu)_[A-Za-z0-9]{30,}\b/g,
    "[REDACTED]"
  );
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, "[REDACTED]");
  // Slack tokens (bot/app/user/refresh/legacy-shared)
  out = out.replace(/\bxox[abprso]-[A-Za-z0-9-]{10,}/g, "[REDACTED]");
  // OpenAI legacy session identifiers
  out = out.replace(/\bsess-[A-Za-z0-9]{20,}/g, "[REDACTED]");
  // Stripe keys + webhook signing secrets
  out = out.replace(
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g,
    "[REDACTED]"
  );
  out = out.replace(/\bwhsec_[A-Za-z0-9]{20,}/g, "[REDACTED]");
  // URL query-param secrets (named + signed-URL variants)
  out = out.replace(
    /([?&](?:api[_-]?key|token|password|secret|access[_-]?token|signature|sig|x-amz-signature)=)[^&\s"']+/gi,
    "$1[REDACTED]"
  );
  // Cookie / Set-Cookie header bodies — value list nuked wholesale.
  // Anchored to start-of-string or whitespace to avoid false matches in
  // prose like "the cookie expired".
  out = out.replace(
    /((?:^|\s)(?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi,
    "$1[REDACTED]"
  );
  // HMAC webhook signature headers (GitHub, generic). Match the
  // `sha\d+=` prefix when present so it survives into the redacted log
  // and operators can still see which algorithm was used.
  out = out.replace(
    /\b(X-(?:Hub-|Webhook-|GitHub-)?Signature(?:-256)?\s*:\s*(?:sha\d+=)?)[A-Fa-f0-9]{20,}/gi,
    "$1[REDACTED]"
  );
  // JWT-shaped 3-segment tokens
  out = out.replace(
    /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED]"
  );
  return out;
}

/**
 * Detect OpenRouter's "credits exhausted" error shape. The wire-level
 * error message is verbatim:
 *
 *   "This request requires more credits, or fewer max_tokens. You
 *    requested up to N tokens, but can only afford M. To increase,
 *    visit https://openrouter.ai/settings/credits and add more
 *    credits"
 *
 * Detecting this distinguishes a **billing** failure from a **content**
 * failure so the editorial agent doesn't bucket the resulting Workers
 * AI fallback rewrites (which then fail downstream gates) as
 * `seo-regression` or `rewrite-rejected` — they're actually
 * `kimi-credits-exhausted`. Same failure-mode-attribution principle as
 * #4776 / #4777: an infrastructure outage must not be representable as
 * a content-quality outcome.
 */
export function isKimiCreditsExhausted(errorMessage: string): boolean {
  if (typeof errorMessage !== "string") return false;
  return (
    /\bThis request requires more credits\b/i.test(errorMessage) ||
    /\bcan only afford\b/i.test(errorMessage)
  );
}
