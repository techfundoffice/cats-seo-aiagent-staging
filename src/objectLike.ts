import { repairJson } from "./pipeline/http-utils";

/**
 * Upper bounds for JSON candidate extraction from one string input across
 * object-like parsing helpers. Keeps best-effort parsing bounded for unusually
 * large or adversarial payloads.
 */
const MAX_FENCED_JSON_PARSE_CANDIDATES = 8;
export const MAX_JSON_PARSE_CANDIDATES = 24;

function tryParseJsonCandidate(candidate: string): unknown | undefined {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    try {
      return JSON.parse(repairJson(candidate)) as unknown;
    } catch {
      return undefined;
    }
  }
}

/**
 * Build the ordered candidate list for JSON-string parsing.
 *
 * Strategy (shared between `parseJsonStringValue` and `parseObjectLike`):
 *  1. The trimmed input itself.
 *  2. Any markdown-fenced `` ```json … ``` `` / `` ``` … ``` `` blocks
 *     (up to MAX_FENCED_JSON_PARSE_CANDIDATES).
 *  3. Balanced JSON object / array snippets embedded inside each of the
 *     direct/fenced candidates (but NOT recursively inside embedded ones).
 *
 * Candidate extraction is capped by `MAX_JSON_PARSE_CANDIDATES` to prevent
 * expensive parse loops on adversarial strings that contain many brace-like
 * fragments.
 *
 * Duplicates (case-sensitive exact match after trimming) are silently dropped
 * so each candidate is attempted at most once.
 */
function buildJsonCandidates(trimmed: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined): void => {
    const normalized = candidate?.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  add(trimmed);
  let fencedCount = 0;
  for (const fencedMatch of trimmed.matchAll(
    /```(?:[a-z0-9_-]+)?\s*([\s\S]*?)\s*```/gi
  )) {
    if (fencedCount >= MAX_FENCED_JSON_PARSE_CANDIDATES) break;
    fencedCount += 1;
    add(fencedMatch[1]);
  }
  // Scan only the direct/fenced candidates for embedded JSON snippets so
  // extracted slices are not recursively rescanned.
  const initialCount = candidates.length;
  for (let i = 0; i < initialCount; i++) {
    const remaining = MAX_JSON_PARSE_CANDIDATES - candidates.length;
    if (remaining <= 0) break;
    for (const embedded of extractEmbeddedJsonCandidates(
      candidates[i],
      remaining
    )) {
      add(embedded);
    }
    if (candidates.length >= MAX_JSON_PARSE_CANDIDATES) break;
  }
  return candidates;
}

/**
 * Best-effort JSON parse for string inputs.
 * Returns `undefined` for non-strings, blank strings, and parse failures so
 * callers can probe optional JSON-ish envelope fields without try/catch noise.
 * When direct `JSON.parse` fails, retries after `repairJson` normalisation —
 * mirrors the fallback behaviour of `parseObjectLike`.
 */
export function parseJsonStringValue(value: unknown): unknown | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  for (const candidate of buildJsonCandidates(trimmed)) {
    const parsed = tryParseJsonCandidate(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Returns the common raw/parsed envelope values seen in Composio toolkit
 * responses, preserving probe order for callers that want to scan for data
 * across `data`, `response_data`, `responseData`, and nested `response`
 * wrappers (including JSON-stringified variants).
 */
export function getComposioEnvelopeCandidates(raw: unknown): unknown[] {
  const envelope = parseObjectLike(raw);
  const response = parseObjectLike(envelope?.response);
  return [
    raw,
    parseJsonStringValue(raw),
    envelope,
    parseJsonStringValue(envelope?.data),
    envelope?.data,
    parseJsonStringValue(envelope?.response_data),
    envelope?.response_data,
    parseJsonStringValue(envelope?.responseData),
    envelope?.responseData,
    response,
    parseJsonStringValue(response?.response_data),
    response?.response_data,
    parseJsonStringValue(response?.responseData),
    response?.responseData,
    parseJsonStringValue(response?.data),
    response?.data
  ];
}

/**
 * Parses unknown input into an object-like record.
 * Accepts plain objects, single-item arrays wrapping plain objects, and JSON
 * strings that decode to either shape.
 * Markdown code fences (`` ```json `` / `` ``` ``) are stripped from
 * string inputs before parsing, and prose-wrapped strings are scanned
 * for embedded balanced JSON snippets. This mirrors the
 * fence-stripping in `repairJson` so LLM outputs wrapped in fences or
 * commentary are handled consistently across the pipeline. If direct
 * parsing fails, a second parse attempt runs after `repairJson`
 * best-effort normalization.
 */
export function parseObjectLike(
  value: unknown
): Record<string, unknown> | null {
  if (!value) return null;
  const parseStringCandidate = (
    stringValue: string
  ): Record<string, unknown> | null => {
    const trimmed = stringValue.trim();
    if (!trimmed) return null;
    for (const candidate of buildJsonCandidates(trimmed)) {
      const parsed = tryParseJsonCandidate(candidate);
      if (parsed === undefined) continue;
      const objectLike = isPlainRecord(unwrapSingleItemArray(parsed));
      if (objectLike) return objectLike;
    }
    return null;
  };
  if (typeof value === "string") {
    return parseStringCandidate(value);
  }
  const unwrapped = unwrapSingleItemArray(value);
  if (typeof unwrapped === "string") {
    return parseStringCandidate(unwrapped);
  }
  return isPlainRecord(unwrapped);
}

/**
 * Recursively unwrap single-element arrays until the innermost non-array
 * value (or a multi-element array) is reached.
 *
 * Exported so other pipeline modules can share the same behaviour rather
 * than maintaining a local copy (e.g. `editorial-agent.ts`).
 */
export function unwrapSingleItemArray(value: unknown): unknown {
  let current = value;
  while (Array.isArray(current) && current.length === 1) {
    current = current[0];
  }
  return current;
}

/**
 * Filters unknown input down to its object-like array rows.
 * Returns an empty array for non-arrays and skips null/array primitives inside
 * the array so callers can safely iterate persisted JSON-ish state.
 */
export function filterObjectArrayEntries<T extends object>(
  value: unknown
): T[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is T =>
          !!entry && typeof entry === "object" && !Array.isArray(entry)
      )
    : [];
}

/**
 * Extracts top-level balanced JSON object/array snippets from a prose string.
 *
 * Walks the input character by character tracking bracket depth and string
 * boundaries (both double and single quotes — single quotes are honoured only
 * when already inside a container to avoid suppressing brace tracking in
 * natural prose like "Here's the data: {...}"). Each time the depth returns to
 * zero a candidate snippet is pushed to the output array.
 *
 * Used by `buildJsonCandidates` (for `parseObjectLike`/`parseJsonStringValue`)
 * and by `activity-log-error-remediation.ts` when scanning model outputs for
 * embedded JSON contract payloads.
 */
export function extractEmbeddedJsonCandidates(
  value: string,
  maxCandidates = Number.POSITIVE_INFINITY
): string[] {
  if (maxCandidates <= 0) return [];
  const out: string[] = [];
  let start = -1;
  const stack: Array<"{" | "["> = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    // Treat apostrophes as string delimiters only after an object starts so
    // prose like "Here's the payload: {...}" does not suppress brace tracking.
    if (char === '"' || (char === "'" && stack.length > 0)) {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") {
      if (stack.length === 0) start = i;
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    if (stack.length === 0) continue;
    const open = stack[stack.length - 1];
    const isMatch =
      (open === "{" && char === "}") || (open === "[" && char === "]");
    if (!isMatch) {
      stack.length = 0;
      start = -1;
      continue;
    }
    stack.pop();
    if (stack.length === 0 && start >= 0) {
      out.push(value.slice(start, i + 1));
      if (out.length >= maxCandidates) break;
      start = -1;
    }
  }

  return out;
}

function isPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  return value as Record<string, unknown>;
}
