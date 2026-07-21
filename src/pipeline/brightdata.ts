/**
 * BrightData Web Unlocker proxy helper.
 *
 * Routes an HTTP GET through BrightData's residential-IP proxy so the
 * request originates from a consumer ISP instead of a Cloudflare Worker
 * egress IP that common bot-detection systems (Amazon, Google, Bing,
 * DuckDuckGo, Forbes) will typically block or CAPTCHA.
 *
 * Usage: reach for this when a direct `fetch()` returns a status in
 * TRANSIENT_HTTP_STATUSES (403, 429, 502, 503, 504) from a source we
 * know is IP-gating Cloudflare.
 */

import { clampAbortTimeoutMs } from "./http-utils";

export interface BrightDataOptions {
  /** BrightData account API key — passed as `Bearer` in the Authorization header. */
  apiKey: string;
  /**
   * BrightData zone name. Defaults to `"web_unlocker1"` when omitted or blank.
   * Change only when you need a specific zone (e.g. a dedicated datacenter zone
   * for lower latency on a non-bot-protected source).
   */
  zone?: string;
  /**
   * Per-request timeout in milliseconds, applied via `AbortSignal.timeout`.
   * Non-finite values and values ≤ 0 are ignored — the fetch runs without
   * a timeout. Values above the AbortSignal uint32 max are clamped.
   */
  timeoutMs?: number;
}

/**
 * Route an HTTP GET through BrightData's Web Unlocker residential-IP proxy.
 *
 * **Error semantics**: throws on network failures (same as `fetch`). A
 * non-2xx HTTP response from BrightData is **returned**, not thrown — callers
 * must check `response.ok` or `response.status` and handle bad statuses
 * themselves.
 *
 * Typical call sites wrap this in a try/catch and fall through to a
 * skip/null when both the direct fetch and the BrightData retry fail:
 * ```ts
 * try {
 *   const resp = await fetchViaBrightData(url, { apiKey, timeoutMs: 15_000 });
 *   if (!resp.ok) { ... return null; }
 *   ...
 * } catch (err: unknown) {
 *   agent.log("warning", `BrightData fetch failed: ${errMsg(err)}`);
 *   return null;
 * }
 * ```
 */
export async function fetchViaBrightData(
  url: string,
  opts: BrightDataOptions
): Promise<Response> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) {
    throw new Error("BrightData apiKey is required");
  }
  const zone = opts.zone?.trim() || "web_unlocker1";
  const timeoutMs = clampAbortTimeoutMs(opts.timeoutMs);
  return fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      zone,
      url,
      format: "raw"
    }),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
  });
}
