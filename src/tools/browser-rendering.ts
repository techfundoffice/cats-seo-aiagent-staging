/**
 * Browser Rendering tool — thin wrapper around the Cloudflare Browser
 * Rendering REST API `/accounts/{id}/browser-rendering/screenshot`.
 *
 * Exposes TWO shapes of the same capability:
 *   - `capturePageScreenshot()` — plain async function used by deterministic
 *     pipeline code (Step 11.5 orchestrator).
 *   - `createScreenshotPageTool(agent)` — AI-SDK v6 `tool()` wrapper that
 *     registers on an Agent's ToolSet so a `generateText({tools})` loop, or
 *     any MCP client connected to the Agent, can call the same capability.
 *
 * The tool does NOT persist the screenshot — that's a side-effect owned by
 * the caller (e.g. the design-audit orchestrator writes to R2). Keeping
 * this tool pure makes it reusable for PDF extraction, visual regression,
 * competitor captures, etc.
 */
import {
  errMsg,
  getEnvBinding,
  normalizeSingleLine
} from "../pipeline/http-utils";
import { tool } from "ai";
import { z } from "zod";
import type { SEOArticleAgent } from "../server";

/**
 * Registered name of the `screenshotPage` AI-SDK tool created by
 * `createScreenshotPageTool`. Export this constant (rather than the bare
 * string literal) so callers can match incoming tool-call names in agentic
 * loops without risking silent drift if the name ever changes.
 */
export const SCREENSHOT_TOOL_NAME = "screenshotPage";

export interface ScreenshotViewport {
  width: number;
  height: number;
}

export interface ScreenshotResult {
  bytes: Uint8Array | null;
  error?: string;
}

export type BrowserRenderingBindingName =
  | "CLOUDFLARE_ACCOUNT_ID"
  | "CLOUDFLARE_API_TOKEN_SECRET";

interface RenderResult {
  html: string | null;
  error?: string;
}

function asNonEmptyHtml(value: string): string | null {
  // Keep original HTML bytes (including leading/trailing whitespace) for
  // downstream consumers; only use trim() to detect empty payloads.
  return value.trim() === "" ? null : value;
}

/**
 * Returns the Browser Rendering credential bindings that are currently missing.
 *
 * Inputs are trimmed before the presence check so callers can pass raw env
 * values directly; blank strings still count as missing. The narrow union
 * return type keeps downstream warning/skip messaging aligned with the only two
 * binding names this helper can emit.
 */
export function getMissingBrowserRenderingBindings(
  accountId?: string,
  apiToken?: string
): BrowserRenderingBindingName[] {
  const normalizedAccountId = accountId?.trim();
  const normalizedApiToken = apiToken?.trim();
  return [
    !normalizedAccountId ? "CLOUDFLARE_ACCOUNT_ID" : null,
    !normalizedApiToken ? "CLOUDFLARE_API_TOKEN_SECRET" : null
  ].filter((binding): binding is BrowserRenderingBindingName =>
    Boolean(binding)
  );
}

function isHtmlResponse(contentType: string, body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const normalizedContentType = contentType.toLowerCase();
  return (
    normalizedContentType.includes("text/html") ||
    normalizedContentType.includes("application/xhtml+xml") ||
    /^<!doctype html\b/i.test(trimmed) ||
    /^<html\b/i.test(trimmed)
  );
}

function formatBrowserRenderingErrorDetail(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const structured = normalizeSingleLine(errMsg(value));
  if (
    structured !== "" &&
    structured !== "Unknown error" &&
    structured !== "[object Object]"
  ) {
    return structured.slice(0, 200);
  }

  const seen = new WeakSet<object>();
  let json = "";
  try {
    json = normalizeSingleLine(
      JSON.stringify(value, (_key, nestedValue: unknown) => {
        if (typeof nestedValue === "bigint") {
          return nestedValue.toString();
        }
        if (typeof nestedValue === "object" && nestedValue !== null) {
          if (seen.has(nestedValue)) {
            return "[Circular]";
          }
          seen.add(nestedValue);
        }
        return nestedValue;
      })
    );
  } catch {
    json = "";
  }
  if (json && json !== "{}" && json !== "[]") {
    return json.slice(0, 200);
  }

  return "";
}

/** Default viewports used by the Step 11.5 design-audit flow. */
export const DESIGN_AUDIT_VIEWPORTS = {
  desktop: { width: 1440, height: 900 } as const,
  mobile: { width: 390, height: 844 } as const
};

/**
 * Capture a single screenshot. Returns {bytes, error?} — never throws.
 * `error` contains HTTP status + response body when the API rejects the
 * request (most common: 401/403 = token missing Browser Rendering:Edit).
 */
export async function capturePageScreenshot(
  accountId: string,
  apiToken: string,
  url: string,
  viewport: ScreenshotViewport,
  navTimeoutMs = 45_000
): Promise<ScreenshotResult> {
  accountId = accountId.trim();
  apiToken = apiToken.trim();
  if (!accountId || !apiToken) {
    const missingBindings = getMissingBrowserRenderingBindings(
      accountId,
      apiToken
    );
    return {
      bytes: null,
      error: `missing ${missingBindings.join(", ")}`
    };
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot`;
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        url,
        viewport,
        screenshotOptions: { type: "jpeg", quality: 70 },
        waitForTimeout: 2000,
        gotoOptions: {
          waitUntil: "networkidle0",
          timeout: navTimeoutMs
        }
      }),
      signal: AbortSignal.timeout(navTimeoutMs + 15_000)
    });
  } catch (err: unknown) {
    return {
      bytes: null,
      error: `fetch threw: ${errMsg(err)}`
    };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return {
      bytes: null,
      error: `HTTP ${resp.status} ${resp.statusText} ${body.slice(0, 240).replace(/\s+/g, " ")}`
    };
  }
  const buf = await resp.arrayBuffer();
  return { bytes: new Uint8Array(buf) };
}

/**
 * Fetch the fully-rendered post-JS HTML of a URL via the Cloudflare Browser
 * Rendering `/content` endpoint. Returns {html, error?} — never throws.
 *
 * Use cases:
 *   • Post-publish leak safety net — re-run `detectJsonSchemaLeak()` on the
 *     LIVE page, not the in-memory HTML the pre-publish gate sees.
 *   • Autonomous Coding Agent verifying a fix actually landed on the live
 *     site (via `/api/admin/render` proxy, so it gets post-JS HTML rather
 *     than whatever is sitting in KV).
 */
export async function renderPage(
  accountId: string,
  apiToken: string,
  url: string,
  navTimeoutMs = 45_000
): Promise<RenderResult> {
  accountId = accountId.trim();
  apiToken = apiToken.trim();
  if (!accountId || !apiToken) {
    const missingBindings = getMissingBrowserRenderingBindings(
      accountId,
      apiToken
    );
    return {
      html: null,
      error: `missing ${missingBindings.join(", ")}`
    };
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content`;
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        url,
        gotoOptions: {
          waitUntil: "networkidle0",
          timeout: navTimeoutMs
        }
      }),
      signal: AbortSignal.timeout(navTimeoutMs + 15_000)
    });
  } catch (err: unknown) {
    return {
      html: null,
      error: `fetch threw: ${errMsg(err)}`
    };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return {
      html: null,
      error: `HTTP ${resp.status} ${resp.statusText} ${body.slice(0, 240).replace(/\s+/g, " ")}`
    };
  }
  const contentType = resp.headers.get("content-type")?.toLowerCase() ?? "";
  let body: string;
  try {
    body = await resp.text();
  } catch (error: unknown) {
    return {
      html: null,
      error: `/content response body could not be read: ${errMsg(error)}`
    };
  }
  const data = (() => {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  })();
  if (data === null) {
    if (isHtmlResponse(contentType, body)) {
      return { html: body };
    }
    const compactBodySnippet = body.slice(0, 240).replace(/\s+/g, " ").trim();
    const snippetDetail = compactBodySnippet
      ? ` body_snippet=${JSON.stringify(compactBodySnippet)}`
      : "";
    return {
      html: null,
      error: `/content response body is not valid JSON (content-type=${contentType || "unknown"})${snippetDetail}`
    };
  }
  if (typeof data === "string") {
    const html = asNonEmptyHtml(data);
    if (html === null) {
      return {
        html: null,
        error: "/content direct response returned empty HTML"
      };
    }
    return { html };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      html: null,
      error: `/content response JSON has unsupported shape (${Array.isArray(data) ? "array" : typeof data})`
    };
  }
  const payload = data as {
    success?: boolean;
    result?: string;
    errors?: unknown;
  };
  if (payload.success === false) {
    const detail = formatBrowserRenderingErrorDetail(payload.errors);
    const apiErr = detail === "" ? "" : `: ${detail}`;
    return {
      html: null,
      error: `/content API returned success=false${apiErr}`
    };
  }
  if (typeof payload.result !== "string") {
    return { html: null, error: "/content response missing result string" };
  }
  const html = asNonEmptyHtml(payload.result);
  if (html === null) {
    return {
      html: null,
      error: "/content object response returned empty HTML"
    };
  }
  return { html };
}

/**
 * AI-SDK tool wrapper. Makes `screenshotPage` callable by any agentic loop
 * `generateText({tools})` — e.g. a QC agent that decides to inspect the
 * live page before proposing rewrites. Returns a base64-encoded JPEG plus
 * size, so the tool result fits cleanly into the model's context window.
 */
export function createScreenshotPageTool(agent: SEOArticleAgent) {
  return tool({
    description:
      "Capture a JPEG screenshot of a public URL at a given viewport via Cloudflare Browser Rendering. Returns a base64-encoded image. Use when you need to inspect what a page looks like visually — layout issues, missing CTA, broken rendering. Does NOT persist the image anywhere.",
    inputSchema: z.object({
      url: z.string().url().describe("Absolute URL of the page to capture."),
      viewport: z
        .enum(["desktop", "mobile"])
        .default("desktop")
        .describe("Named viewport preset. desktop=1440x900, mobile=390x844.")
    }),
    execute: async ({ url, viewport }) => {
      const accountId = getEnvBinding(
        agent.envBindings,
        "CLOUDFLARE_ACCOUNT_ID"
      );
      const apiToken = getEnvBinding(
        agent.envBindings,
        "CLOUDFLARE_API_TOKEN_SECRET"
      );
      if (!accountId || !apiToken) {
        const missingBindings = getMissingBrowserRenderingBindings(
          accountId,
          apiToken
        );
        return {
          ok: false,
          error: `missing ${missingBindings.join(", ")}; set both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN_SECRET on the Worker to capture screenshots`
        };
      }
      const vp = DESIGN_AUDIT_VIEWPORTS[viewport];
      const { bytes, error } = await capturePageScreenshot(
        accountId,
        apiToken,
        url,
        vp
      );
      if (!bytes) return { ok: false, error };
      // btoa-compatible base64 for Worker runtime (no Buffer in Workers)
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return {
        ok: true,
        viewport,
        widthPx: vp.width,
        heightPx: vp.height,
        byteLength: bytes.byteLength,
        base64: btoa(binary)
      };
    }
  });
}
