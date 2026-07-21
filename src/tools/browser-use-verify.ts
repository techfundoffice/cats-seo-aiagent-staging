/**
 * browser-use Cloud API verification.
 *
 * Sends the published article URL to browser-use's Cloud API to get
 * automated screenshots and console-error checks. Falls back gracefully
 * when BROWSER_USE_API_KEY is not configured.
 *
 * Docs: https://docs.browser-use.com/cloud/quickstart
 */
import type { SEOArticleAgent } from "../server";
import { parseObjectLike } from "../objectLike";
import { errMsg, getEnvBinding } from "../pipeline/http-utils";

export interface BrowserUseResult {
  passed: boolean;
  loaded?: boolean;
  contentVisible?: boolean;
  desktopScreenshotUrl?: string;
  mobileScreenshotUrl?: string;
  consoleErrors: string[];
  loadTimeMs: number;
  skipped: boolean;
  skipReason?: string;
}

const BROWSER_USE_API = "https://api.browser-use.com/api/v1/run-task";
const BROWSER_USE_WARNING_KEYS_LIMIT = 8;
const BROWSER_USE_WARNING_PREVIEW_CHAR_LIMIT = 200;
const BROWSER_USE_API_TIMEOUT_MS = 60_000;
const BROWSER_USE_OUTPUT_KEYS = [
  "output",
  "result",
  "data",
  "response",
  "response_data",
  "responseData",
  "text",
  "content",
  "message"
] as const;
const BROWSER_USE_LOADED_KEYS = ["loaded", "isLoaded"] as const;
const BROWSER_USE_CONTENT_VISIBLE_KEYS = [
  "contentVisible",
  "content_visible"
] as const;
const BROWSER_USE_CONSOLE_ERRORS_KEYS = [
  "consoleErrors",
  "console_errors"
] as const;

function coerceBrowserUseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
    return fallback;
  }
  if (typeof value !== "string") return fallback;
  const normalized = value
    .trim()
    .replace(/^[\s"'`([{]+|[\s"'`)\]}.,!?;:]+$/g, "")
    .toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  return fallback;
}

function coerceBrowserUseString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function pickBrowserUseString(
  parsed: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const normalized = coerceBrowserUseString(parsed[key]);
    if (normalized) return normalized;
  }
  return undefined;
}

function pickBrowserUseValue(
  parsed: Record<string, unknown>,
  keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (!(key in parsed)) continue;
    const value = parsed[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseBrowserUseOutput(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  const queue: unknown[] = [raw];
  const seen = new Set<object>();

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (candidate == null) continue;

    if (typeof candidate === "string") {
      // parseObjectLike already scans for embedded JSON objects internally
      // (via extractEmbeddedJsonCandidates in objectLike.ts), so a single
      // call handles both direct-parse and prose-wrapped embedded-object cases.
      const direct = parseObjectLike(candidate.trim());
      if (direct) return direct;
      continue;
    }

    if (Array.isArray(candidate)) {
      queue.push(...candidate);
      continue;
    }

    if (typeof candidate !== "object") {
      continue;
    }

    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    const payload = candidate as Record<string, unknown>;
    if (
      BROWSER_USE_LOADED_KEYS.some((key) => key in payload) ||
      BROWSER_USE_CONTENT_VISIBLE_KEYS.some((key) => key in payload) ||
      BROWSER_USE_CONSOLE_ERRORS_KEYS.some((key) => key in payload)
    ) {
      return payload;
    }

    let pushedKnownWrapper = false;
    for (const key of BROWSER_USE_OUTPUT_KEYS) {
      const value = payload[key];
      if (value != null) {
        queue.push(value);
        pushedKnownWrapper = true;
      }
    }
    if (!pushedKnownWrapper) {
      for (const value of Object.values(payload)) {
        if (value != null) queue.push(value);
      }
    }
  }

  return null;
}

function summarizeBrowserUsePayload(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === "string") {
    const normalized = value.trim().replace(/\s+/g, " ");
    return normalized.slice(0, BROWSER_USE_WARNING_PREVIEW_CHAR_LIMIT);
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized) {
      return serialized
        .replace(/\s+/g, " ")
        .slice(0, BROWSER_USE_WARNING_PREVIEW_CHAR_LIMIT);
    }
  } catch {
    // Fall through to a type-only summary.
  }
  return `(unserializable ${typeof value})`;
}

function isBrowserUseTimeoutError(err: unknown, message: string): boolean {
  if (err instanceof DOMException) {
    return err.name === "TimeoutError" || err.name === "AbortError";
  }
  return /\b(?:timed?\s*out|abort(?:ed|ing)?)\b/i.test(message);
}

function coerceBrowserUseConsoleError(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }

  const structured = errMsg(value).trim();
  if (
    structured !== "" &&
    structured !== "[object Object]" &&
    structured !== "Unknown error"
  ) {
    return structured;
  }

  if (value && typeof value === "object") {
    const summary = summarizeBrowserUsePayload(value);
    if (
      summary !== "" &&
      summary !== "{}" &&
      summary !== "[]" &&
      !summary.startsWith("(unserializable ")
    ) {
      return summary;
    }
  }

  return undefined;
}

/**
 * Verifies a published article with browser-use's hosted browser task.
 *
 * This helper is intentionally fail-open for the publish pipeline:
 * missing credentials, transport/API failures, or unparsable responses
 * all return `{ passed: true, skipped: true }` with a `skipReason`
 * instead of blocking the article on an external dependency.
 */
export async function verifyWithBrowserUse(
  agent: SEOArticleAgent,
  articleUrl: string
): Promise<BrowserUseResult> {
  const apiKey = getEnvBinding(agent.envBindings, "BROWSER_USE_API_KEY");
  const startedAt = Date.now();

  if (!apiKey) {
    return {
      passed: true,
      consoleErrors: [],
      loadTimeMs: 0,
      skipped: true,
      skipReason: `BROWSER_USE_API_KEY not set (${articleUrl})`
    };
  }

  try {
    const resp = await fetch(BROWSER_USE_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        task: `Navigate to ${articleUrl}. Wait for the page to fully load. Report: 1) whether the page loaded successfully (HTTP 200), 2) any JavaScript console errors, 3) whether the main article content is visible. Return a JSON object with keys: loaded (boolean), consoleErrors (string array), contentVisible (boolean).`,
        save_browser_data: false
      }),
      signal: AbortSignal.timeout(BROWSER_USE_API_TIMEOUT_MS)
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const bodySummary = body.trim().replace(/\s+/g, " ").slice(0, 200);
      const responseSummary = bodySummary
        ? `${resp.status}: ${bodySummary}`
        : String(resp.status);
      const reason = `API returned ${responseSummary} (${articleUrl})`;
      agent.log("warning", `browser-use API verification skipped: ${reason}`);
      return {
        passed: true,
        consoleErrors: [],
        loadTimeMs: Date.now() - startedAt,
        skipped: true,
        skipReason: reason
      };
    }

    const responseBody = await resp.text().catch(() => "");
    let data: unknown;
    try {
      data = JSON.parse(responseBody) as unknown;
    } catch {
      const bodySummary = responseBody
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, BROWSER_USE_WARNING_PREVIEW_CHAR_LIMIT);
      const contentType = resp.headers.get("content-type") || "unknown";
      const reason = `browser-use API returned non-JSON success response (content-type=${contentType}; body=${bodySummary || "(empty)"}) (${articleUrl})`;
      agent.log("warning", `${reason}; skipping verification`);
      return {
        passed: true,
        consoleErrors: [],
        loadTimeMs: Date.now() - startedAt,
        skipped: true,
        skipReason: reason
      };
    }
    const parsed = parseBrowserUseOutput(data);
    if (!parsed) {
      const keys =
        data && typeof data === "object" && !Array.isArray(data)
          ? (() => {
              const responseKeys = Object.keys(data);
              return responseKeys.length > 0
                ? responseKeys
                    .slice(0, BROWSER_USE_WARNING_KEYS_LIMIT)
                    .join(", ")
                : "(none)";
            })()
          : `(non-object ${typeof data})`;
      const preview = summarizeBrowserUsePayload(data);
      const reason = `browser-use API returned no parseable output object (skipping verification) (${articleUrl})`;
      agent.log(
        "warning",
        `${reason}; response keys: ${keys}; response preview: ${preview}`
      );
      return {
        passed: true,
        consoleErrors: [],
        loadTimeMs: Date.now() - startedAt,
        skipped: true,
        skipReason: reason
      };
    }
    const consoleErrors: string[] = [];
    const loaded = coerceBrowserUseBoolean(
      pickBrowserUseValue(parsed, BROWSER_USE_LOADED_KEYS),
      true
    );
    const contentVisible = coerceBrowserUseBoolean(
      pickBrowserUseValue(parsed, BROWSER_USE_CONTENT_VISIBLE_KEYS),
      true
    );
    const screenshotData =
      parsed.screenshots && typeof parsed.screenshots === "object"
        ? (parsed.screenshots as Record<string, unknown>)
        : null;
    const desktopScreenshotUrl =
      pickBrowserUseString(parsed, [
        "desktopScreenshotUrl",
        "desktop_screenshot_url",
        "desktopScreenshot"
      ]) ||
      (screenshotData
        ? pickBrowserUseString(screenshotData, [
            "desktop",
            "desktopUrl",
            "desktop_url"
          ])
        : undefined);
    const mobileScreenshotUrl =
      pickBrowserUseString(parsed, [
        "mobileScreenshotUrl",
        "mobile_screenshot_url",
        "mobileScreenshot"
      ]) ||
      (screenshotData
        ? pickBrowserUseString(screenshotData, [
            "mobile",
            "mobileUrl",
            "mobile_url"
          ])
        : undefined);
    const rawConsoleErrors = pickBrowserUseValue(
      parsed,
      BROWSER_USE_CONSOLE_ERRORS_KEYS
    );
    if (Array.isArray(rawConsoleErrors)) {
      for (const e of rawConsoleErrors) {
        const normalized = coerceBrowserUseConsoleError(e);
        if (normalized) consoleErrors.push(normalized);
      }
    } else {
      const normalized = coerceBrowserUseConsoleError(rawConsoleErrors);
      if (normalized) consoleErrors.push(normalized);
    }

    return {
      passed: loaded && contentVisible && consoleErrors.length === 0,
      loaded,
      contentVisible,
      desktopScreenshotUrl,
      mobileScreenshotUrl,
      consoleErrors,
      loadTimeMs: Date.now() - startedAt,
      skipped: false
    };
  } catch (err: unknown) {
    const msg = errMsg(err);
    const timeoutMsg = `browser-use verify timed out after ${Math.round(
      BROWSER_USE_API_TIMEOUT_MS / 1000
    )}s (${articleUrl})`;
    const isTimeout = isBrowserUseTimeoutError(err, msg);
    agent.log(
      "warning",
      isTimeout
        ? timeoutMsg
        : `browser-use verify failed (${articleUrl}): ${msg}`
    );
    return {
      passed: true,
      consoleErrors: [],
      loadTimeMs: Date.now() - startedAt,
      skipped: true,
      skipReason: isTimeout ? timeoutMsg : `${msg} (${articleUrl})`
    };
  }
}
