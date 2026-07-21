import { errMsg } from "./http-utils";
import type { SEOArticleAgent } from "../server";
import { loggedFetch } from "./api-logger";

/**
 * Canonical payload for the outbound n8n `publish.success` webhook.
 *
 * Mirrors the article metadata assembled in `writer.ts` immediately after
 * the final IndexNow ping so downstream n8n steps can trust the shape of
 * the publish event without re-deriving fields from `kvKey`.
 */
export interface N8nPublishSuccessPayload {
  kvKey: string;
  keyword: string;
  categorySlug: string;
  slug: string;
  articleUrl: string;
  seoScore: number;
  title: string;
  metaDescription: string;
}

/**
 * Build a safe URL summary for warning logs.
 *
 * Returns `origin + pathname` for parseable URLs (never query/hash), and
 * falls back to a query/hash-stripped raw string for malformed inputs.
 */
function summarizeWebhookUrlForLog(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === "") return "[empty]";
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const redacted = trimmed.replace(/[?#].*$/, "");
    return redacted === "" ? "[invalid]" : redacted;
  }
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * POST the publish-success event to the configured n8n workflow.
 *
 * Signs the JSON body with `N8N_WEBHOOK_SECRET`, routes the request through
 * `loggedFetch()` for dashboard/API-activity visibility, and treats every
 * failure mode as non-fatal so article publication can complete even when
 * the automation bridge is offline or misconfigured.
 */
export async function notifyN8nPublishSuccess(
  agent: SEOArticleAgent,
  payload: N8nPublishSuccessPayload
): Promise<void> {
  const url = agent.envBindings.N8N_WEBHOOK_URL?.trim();
  const secret = agent.envBindings.N8N_WEBHOOK_SECRET?.trim();

  if (!url || !secret) {
    if (url || secret) {
      const missingBindings = [
        !url ? "N8N_WEBHOOK_URL" : null,
        !secret ? "N8N_WEBHOOK_SECRET" : null
      ]
        .filter((v): v is string => Boolean(v))
        .join(", ");
      agent.log(
        "warning",
        `n8n webhook skipped: missing ${missingBindings}; set both N8N_WEBHOOK_URL and N8N_WEBHOOK_SECRET to enable publish notifications`,
        "n8n"
      );
    } else {
      agent.log(
        "info",
        "n8n webhook not configured (N8N_WEBHOOK_URL/N8N_WEBHOOK_SECRET unset) — skipping",
        "n8n"
      );
    }
    return;
  }

  try {
    // Validate early so misconfigured URLs are surfaced as a config warning
    // rather than a generic fetch failure on every publish event.
    new URL(url);
  } catch {
    const urlSummary = summarizeWebhookUrlForLog(url);
    agent.log(
      "warning",
      `n8n webhook skipped: invalid N8N_WEBHOOK_URL (${urlSummary})`,
      "n8n"
    );
    return;
  }

  const body = JSON.stringify({
    event: "publish.success",
    publishedAt: new Date().toISOString(),
    ...payload
  });

  try {
    const signature = await hmacSha256Hex(secret, body);
    const resp = await loggedFetch(
      agent,
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-N8N-Signature": `sha256=${signature}`
        },
        body,
        signal: AbortSignal.timeout(5000)
      },
      { api: "n8n", op: "publish.success" }
    );
    if (resp.ok) {
      agent.log("info", `n8n notified: ${payload.kvKey}`, "n8n");
    } else {
      const responseBody = await resp.text().catch(() => "");
      const responseSummary = responseBody
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 240);
      agent.log(
        "warning",
        `n8n webhook returned HTTP ${resp.status} for ${payload.kvKey}${responseSummary ? ` — ${responseSummary}` : ""} (non-fatal)`,
        "n8n"
      );
    }
  } catch (err: unknown) {
    agent.log(
      "warning",
      `n8n webhook failed for ${payload.kvKey} (non-fatal): ${errMsg(err)}`,
      "n8n"
    );
  }
}
