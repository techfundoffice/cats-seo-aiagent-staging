/**
 * Live URL checks for article publish verification and sheet mirror "Page HTTP status".
 */

import { clampAbortTimeoutMs, errMsg } from "./pipeline/http-utils";

const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * HTTP probe result used for article publish verification and the sheet mirror
 * "Page HTTP status" cell.
 */
export type UrlHttpStatusResult = {
  /** Response status, or 0 when no HTTP response (network/abort). */
  status: number;
  /** Value for sheet cells: status code, or `err:…` on failure. */
  sheetCell: string;
};

function trimUrl(raw: string): string {
  return String(raw ?? "").trim();
}

function normalizeTimeoutMs(timeoutMs: number): number {
  return clampAbortTimeoutMs(timeoutMs) ?? DEFAULT_TIMEOUT_MS;
}

function toFetcherRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): Request {
  return input instanceof Request && init === undefined
    ? input
    : new Request(input, init);
}

/**
 * HEAD first (cheap); on 403/405/501 retry GET with a tiny Range body.
 * Some hosts/WAFs block HEAD while allowing GET, so this avoids false 4xx
 * negatives for otherwise healthy live article URLs.
 * Redirects are followed. Non-https and sentinel URLs return empty `sheetCell`.
 *
 * When `fetcher` is set (e.g. `PETINSURANCE` service binding), requests use
 * `fetcher.fetch()` so probes hit the bound Worker directly instead of the
 * public edge (no zone DNS/WAF/bot challenges for same-origin article URLs).
 */
export async function probeUrlHttpStatus(
  rawUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetcher?: Fetcher
): Promise<UrlHttpStatusResult> {
  const url = trimUrl(rawUrl);
  if (!url || /^error$/i.test(url)) {
    return { status: 0, sheetCell: "" };
  }
  if (!/^https:\/\//i.test(url)) {
    return { status: 0, sheetCell: "" };
  }

  const httpFetch: typeof fetch = fetcher
    ? (input, init) => fetcher.fetch(toFetcherRequest(input, init))
    : fetch;

  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  try {
    let resp = await httpFetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(normalizedTimeoutMs)
    });
    if (resp.status === 403 || resp.status === 405 || resp.status === 501) {
      resp = await httpFetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(normalizedTimeoutMs),
        headers: { Range: "bytes=0-0" }
      });
    }
    return { status: resp.status, sheetCell: String(resp.status) };
  } catch (e: unknown) {
    const msg = errMsg(e);
    const short = msg.length > 48 ? msg.slice(0, 45) + "…" : msg;
    return { status: 0, sheetCell: `err:${short}` };
  }
}
