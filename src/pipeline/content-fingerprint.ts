import { unescapeHtml } from "./http-utils";

export interface ContentFingerprintAttempt {
  html: string | null;
  error?: string;
}

export interface ContentFingerprintCheckOptions {
  titleFingerprint: string;
  bodyFingerprint: string;
  bodyFingerprintSource: string;
  render: () => Promise<ContentFingerprintAttempt>;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onWarning?: (message: string) => void;
}

export type ContentFingerprintCheckResult =
  | { ok: true; renderedLength: number }
  | { ok: false; skipped: true; lastRenderError?: string }
  | {
      ok: false;
      skipped: false;
      missing: string;
      renderedLength: number;
    };

/**
 * Normalize a string for substring fingerprint matching against post-JS
 * rendered HTML. Strips tags, decodes the entities `escapeHtml` emits
 * (`& < > " '` plus `&nbsp;`), lowercases, and collapses whitespace so
 * case/spacing/markup differences between the source ArticleData and the
 * live DOM do not cause false negatives in the Step 14 content gate.
 */
export function normalizeForFingerprint(s: string): string {
  return unescapeHtml(s.replace(/<[^>]+>/g, " "))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check that a freshly-published article's content is live in the rendered
 * DOM. Normalizes both the expected fingerprints and the rendered HTML via
 * `normalizeForFingerprint`, then does substring matching.
 *
 * Retries up to `maxAttempts` times (default 3) with `retryDelayMs`
 * between attempts (default 2 s) to tolerate CDN propagation lag. A custom
 * `sleep` function can be injected for tests so they run without real
 * delays.
 *
 * Return shapes:
 *   - `{ ok: true, renderedLength }` — both title and body fingerprints
 *     were found; `renderedLength` is the length of the normalized HTML.
 *   - `{ ok: false, skipped: false, missing, renderedLength }` — rendering
 *     succeeded but one or both fingerprints were absent on every attempt;
 *     `missing` is a comma-separated list of which fingerprints failed
 *     (e.g. `"title"`, `"body:intro"`, or `"title,body:intro"`).
 *   - `{ ok: false, skipped: true, lastRenderError? }` — every render
 *     attempt returned no HTML (browser rendering unavailable or network
 *     error); the gate is skipped so the publish is not blocked.
 *
 * Any warning (render failure, fingerprint mismatch per attempt) is
 * forwarded to the optional `onWarning` callback for activity-log
 * visibility.
 */
export async function checkContentFingerprint({
  titleFingerprint,
  bodyFingerprint,
  bodyFingerprintSource,
  render,
  maxAttempts = 3,
  retryDelayMs = 2_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onWarning
}: ContentFingerprintCheckOptions): Promise<ContentFingerprintCheckResult> {
  let lastRenderError: string | undefined;
  let lastMismatch: { missing: string; renderedLength: number } | undefined;

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    const rendered = await render();
    if (!rendered.html) {
      lastRenderError = rendered.error;
      onWarning?.(
        `Content fingerprint render attempt ${attempt} failed: ${rendered.error ?? "unknown"}`
      );
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
      continue;
    }

    const renderedNorm = normalizeForFingerprint(rendered.html);
    const titleOk =
      titleFingerprint.length > 0 && renderedNorm.includes(titleFingerprint);
    const bodyOk =
      bodyFingerprint.length >= 20 && renderedNorm.includes(bodyFingerprint);
    if (titleOk && bodyOk) {
      return { ok: true, renderedLength: renderedNorm.length };
    }

    const missing = [
      !titleOk ? "title" : null,
      !bodyOk ? `body:${bodyFingerprintSource}` : null
    ]
      .filter((s): s is string => s !== null)
      .join(",");
    lastMismatch = { missing, renderedLength: renderedNorm.length };
    onWarning?.(
      `Content fingerprint attempt ${attempt} rendered HTML missing [${missing}]`
    );
    if (attempt < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  if (lastMismatch) {
    return { ok: false, skipped: false, ...lastMismatch };
  }
  return { ok: false, skipped: true, lastRenderError };
}
