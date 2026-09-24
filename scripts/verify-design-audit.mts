/**
 * Verify Browser Rendering against the Cloudflare API.
 *
 * Design-audit vision runs on Claude inside the worker
 * (`analyzeScreenshotWithVision`). This script must not call Workers AI.
 * The binding was removed; see docs/workers-ai-removal.md.
 *
 * Runs two checks:
 *   1. Account/token sanity (Workers list).
 *   2. Browser Rendering `/screenshot` captures a known public URL.
 *
 * Exits nonzero on the first failure so this can gate a deploy.
 *
 * Run:
 *   doppler run -- npx tsx scripts/verify-design-audit.mts
 *   doppler run -- npx tsx scripts/verify-design-audit.mts https://catsluvus.com
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID     (required)
 *   CLOUDFLARE_API_TOKEN      (required; needs Browser Rendering:Edit)
 */
import { writeFileSync } from "node:fs";

const DEFAULT_TEST_URL = "https://example.com";

const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const apiToken = (
  process.env.CLOUDFLARE_API_TOKEN ||
  process.env.CLOUDFLARE_API_TOKEN_SECRET ||
  ""
).trim();
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
pass("env loaded", `account ${accountId.slice(0, 8)}…`);

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
  const screenshotBytes = new Uint8Array(await resp.arrayBuffer());
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

console.log(
  "\nBrowser Rendering checks passed. Vision analysis runs on Claude in the worker."
);
