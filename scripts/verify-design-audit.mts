/**
 * Verify the Step 11.5 "Design Audit" pipeline against real Cloudflare APIs.
 *
 * Runs four checks against your actual account:
 *   1. Account/token sanity (Workers list).
 *   2. Browser Rendering `/screenshot` captures a known public URL.
 *   3. Workers AI Llava 1.5 7B accepts the image byte-array payload.
 *   4. AI Gateway (id from `AI_GATEWAY_ID`) routes Llava and returns JSON.
 *
 * Exits nonzero on the first failure so this can gate a deploy.
 *
 * Run:
 *   doppler run -- npx tsx scripts/verify-design-audit.mts
 *   doppler run -- npx tsx scripts/verify-design-audit.mts https://catsluvus.com
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID     (required)
 *   CLOUDFLARE_API_TOKEN      (required; needs Workers AI:Run,
 *                              Browser Rendering:Edit, AI Gateway:Run)
 *   AI_GATEWAY_ID             (optional; default "cats-seo-aiagent")
 */
import { writeFileSync } from "node:fs";

const DEFAULT_GATEWAY_ID = "cats-seo-aiagent";
const DEFAULT_TEST_URL = "https://example.com";
const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const apiToken = (
  process.env.CLOUDFLARE_API_TOKEN ||
  process.env.CLOUDFLARE_API_TOKEN_SECRET ||
  ""
).trim();
const gatewayId = (process.env.AI_GATEWAY_ID || DEFAULT_GATEWAY_ID).trim();
const testUrl = process.argv[2] || DEFAULT_TEST_URL;

function fail(step: string, detail: string): never {
  console.error(`✗ ${step}`);
  console.error(`  ${detail}`);
  process.exit(1);
}

function pass(step: string, detail = "") {
  console.log(`✓ ${step}${detail ? `  (${detail})` : ""}`);
}

if (!accountId) {
  fail("env check", "CLOUDFLARE_ACCOUNT_ID missing (use: doppler run -- ...)");
}
if (!apiToken) {
  fail(
    "env check",
    "CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_TOKEN_SECRET) missing"
  );
}
pass("env loaded", `account ${accountId.slice(0, 8)}… gateway ${gatewayId}`);

// ── 1. Token sanity via Workers list ───────────────────────────────────────────
{
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
    { headers: { Authorization: `Bearer ${apiToken}` } }
  );
  if (!resp.ok) {
    fail(
      "token sanity",
      `GET /workers/scripts → HTTP ${resp.status} ${resp.statusText} (token missing Workers:Read?)`
    );
  }
  const json = (await resp.json()) as {
    success?: boolean;
    result?: unknown[];
  };
  if (!json.success) {
    fail("token sanity", `success=false: ${JSON.stringify(json)}`);
  }
  pass(
    "token sanity",
    `${Array.isArray(json.result) ? json.result.length : "?"} workers`
  );
}

// ── 2. Browser Rendering screenshot ────────────────────────────────────────────
let screenshotBytes: Uint8Array;
{
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        url: testUrl,
        viewport: { width: 1440, height: 900 },
        screenshotOptions: { type: "jpeg", quality: 70 },
        gotoOptions: { waitUntil: "networkidle0", timeout: 20_000 }
      })
    }
  );
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    fail(
      "Browser Rendering screenshot",
      `HTTP ${resp.status} ${resp.statusText} ${bodyText.slice(0, 200)}`
    );
  }
  const buf = await resp.arrayBuffer();
  screenshotBytes = new Uint8Array(buf);
  if (screenshotBytes.byteLength < 1024) {
    fail(
      "Browser Rendering screenshot",
      `tiny response (${screenshotBytes.byteLength} bytes) — likely not a real image`
    );
  }
  const debugPath = "/tmp/verify-design-audit-screenshot.jpg";
  writeFileSync(debugPath, screenshotBytes);
  pass(
    "Browser Rendering screenshot",
    `${screenshotBytes.byteLength} bytes → ${debugPath}`
  );
}

// ── 3. Workers AI Llava direct (no gateway) ────────────────────────────────────
{
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${VISION_MODEL}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        prompt: "Describe this image in one sentence.",
        image: Array.from(screenshotBytes),
        max_tokens: 128
      })
    }
  );
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    fail(
      "Workers AI Llava (direct)",
      `HTTP ${resp.status} ${resp.statusText} ${bodyText.slice(0, 300)}`
    );
  }
  const json = (await resp.json()) as {
    success?: boolean;
    result?: { description?: string; response?: string };
  };
  const text = json.result?.description ?? json.result?.response ?? "";
  if (!json.success || !text) {
    fail(
      "Workers AI Llava (direct)",
      `success=${json.success} text="${text.slice(0, 120)}"`
    );
  }
  pass(
    "Workers AI Llava (direct)",
    `"${text.slice(0, 80).replace(/\s+/g, " ")}…"`
  );
}

// ── 4. Same call through AI Gateway ───────────────────────────────────────────
{
  const resp = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/${VISION_MODEL}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        prompt: "Describe this image in one sentence.",
        image: Array.from(screenshotBytes),
        max_tokens: 128
      })
    }
  );
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    fail(
      `AI Gateway route (${gatewayId})`,
      `HTTP ${resp.status} ${resp.statusText} ${bodyText.slice(0, 300)} — create the gateway or fix AI_GATEWAY_ID`
    );
  }
  const json = (await resp.json()) as {
    success?: boolean;
    result?: { description?: string; response?: string };
  };
  const text = json.result?.description ?? json.result?.response ?? "";
  if (!json.success || !text) {
    fail(
      `AI Gateway route (${gatewayId})`,
      `success=${json.success} text="${text.slice(0, 120)}"`
    );
  }
  pass(
    `AI Gateway route (${gatewayId})`,
    `"${text.slice(0, 80).replace(/\s+/g, " ")}…"`
  );
}

console.log("\nAll checks passed. Step 11.5 runtime chain is wired correctly.");
