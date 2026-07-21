---
name: design-audit
description: >
  Visually audit a published article's live page using Cloudflare
  Browser Rendering + Workers AI Llava via AI Gateway. Captures desktop
  + mobile screenshots, runs vision analysis, classifies findings as
  content-addressable (fixable by rewriting copy) or not, and feeds the
  content-addressable ones into the QC + Polish agents so the article
  gets rewritten to address them. Use when adding visual QC to a
  published-article pipeline, when debugging Step 11.5 failures, or
  when extending the audit to a new vision model / new viewport.
metadata:
  author: cats-seo-aiagent
  version: "1.0"
triggers:
  - design audit
  - visual audit
  - browser rendering screenshot
  - llava vision analysis
  - step 11.5
includes:
  - src/tools/browser-rendering.ts
  - src/tools/vision-audit.ts
  - src/pipeline/design-audit.ts
---

# Design Audit — Step 11.5

Visual post-publish audit for articles on `catsluvus.com`. Runs AFTER
KV Deploy (step 10) and indexing (step 11), BEFORE QC Review (step
12.5) and Polish (step 13), so its findings can shape the rewrite.

## Flow

```
         ┌────────────────────────────┐
article ─┤ runDesignAudit(agent,       │
URL      │                url, slug)   │
         └───────────┬────────────────┘
                     │
      ┌──────────────┴──────────────┐
      ▼                             ▼
 capturePageScreenshot        capturePageScreenshot
  (desktop 1440×900)           (mobile 390×844)
      │                             │
      ├─── R2: design-audits/{slug}/desktop.jpg
      │                             ├─ R2: design-audits/{slug}/mobile.jpg
      ▼                             ▼
 analyzeScreenshotWithLlava   analyzeScreenshotWithLlava
   (via AI Gateway)             (via AI Gateway)
      │                             │
      └──────────────┬──────────────┘
                     ▼
            dedupe + classify
                     │
                     ▼
          DesignAuditReport
          { issues, contentIssues,
            analysisErrors, rawVisionResponses,
            desktopScreenshotKey, mobileScreenshotKey }
                     │
      ┌──────────────┴──────────────┐
      ▼                             ▼
  QC Agent (12.5)               Polish Agent (13)
  feeds contentIssues           appends content-addressable
  into competitor-gap           findings to failedChecks
  rewrite prompt                and regenerates copy
```

## Code Layout

| File                             | Role                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/browser-rendering.ts` | Pure `capturePageScreenshot()` + AI-SDK `screenshotPage` tool                                                                       |
| `src/tools/vision-audit.ts`      | Pure `analyzeScreenshotWithLlava()` + AI-SDK `auditScreenshot` + `auditPageDesign` tools + issue coercion + category classification |
| `src/tools/index.ts`             | `createDesignAuditTools(agent): ToolSet` — the bundle                                                                               |
| `src/pipeline/design-audit.ts`   | Deterministic `runDesignAudit()` orchestrator used by `writer.ts`                                                                   |
| `src/server.ts`                  | Registers the bundle via `agent.designAuditTools` and exposes `/api/verify-design-audit`                                            |

## Three Ways to Invoke

### 1. Deterministic (pipeline)

```ts
import { runDesignAudit } from "./pipeline/design-audit";
const report = await runDesignAudit(agent, articleUrl, slug);
```

Used by `writer.ts` at Step 11.5. Always runs both viewports, always
persists screenshots, always returns a structured report.

### 2. Agentic (`generateText({tools})`)

```ts
import { generateText, stepCountIs } from "ai";

const result = await generateText({
  model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
  tools: { ...agent.designAuditTools /* ...other tools */ },
  prompt: "Inspect https://catsluvus.com/cats/foo and tell me what's wrong.",
  stopWhen: stepCountIs(5)
});
```

Model decides which tool to call — `screenshotPage` first, or
`auditPageDesign` for one-shot, or skip if the URL is unreachable.

### 3. MCP / HTTP

- `GET/POST /api/verify-design-audit?url=<url>` — runs the full flow
  against the live bindings, returns the report as JSON. Always HTTP
  200; check the `ok` field.
- The three tools above are exposed through the Agent's MCP surface,
  so any MCP-connected client (Claude Desktop, another agent) sees
  them as callable capabilities.

## Configuration

### Secrets & bindings (Worker)

- `CLOUDFLARE_ACCOUNT_ID` — in `wrangler.jsonc` `vars`, not a secret
  (public identifier). Step 11.5 skips if missing.
- `CLOUDFLARE_API_TOKEN_SECRET` — Worker secret. Must have:
  - **Browser Rendering: Edit** (else 401 code 10000 on `/screenshot`)
  - **Workers AI: Run** (else 401 when invoking Llava)
  - **AI Gateway: Run** (else 403 on the gateway route)
- `IMAGES_R2` — R2 bucket for screenshot archive (`design-audits/{slug}/`).

### AI Gateway

Gateway id `cats-seo-aiagent` must exist on the account.
`authentication: false` is fine since the Worker uses a scoped API
token on the request itself.

### Setup via Doppler + wrangler

```sh
doppler secrets get CLOUDFLARE_API_TOKEN_SECRET --plain --no-read-env \
  | npx wrangler secret put CLOUDFLARE_API_TOKEN_SECRET --name cats-seo-aiagent
```

Create the gateway programmatically if missing (one-time):

```sh
curl -X POST \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
  -H "X-Auth-Key: $CLOUDFLARE_GLOBAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"cats-seo-aiagent","collect_logs":true,"authentication":false}' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways"
```

## Category → Content-Addressable Classification

Llava tends to claim every issue is `contentAddressable: true`. We
override in `CATEGORY_CONTENT_ADDRESSABLE` so only fixable-by-rewrite
categories flow into Polish:

| Category     | Content-Addressable | Example                                          |
| ------------ | ------------------- | ------------------------------------------------ |
| `cta`        | ✓                   | "CTA button has no text" → rewrite button copy   |
| `content`    | ✓                   | "Intro is generic" → rewrite intro               |
| `hero`       | ✓                   | "Hero headline is 'Untitled'" → rewrite headline |
| `nav`        | ✓                   | "Nav labels are unclear" → relabel               |
| `layout`     | ✗                   | CSS issue — logged only                          |
| `typography` | ✗                   | CSS — logged only                                |
| `color`      | ✗                   | CSS — logged only                                |
| `mobile`     | ✗                   | CSS/responsive — logged only                     |

## Verifying an Audit Ran

- `GET /api/logs` → look for `"Design Audit: N issues (M content-addressable)"`
  or `"Design Audit skipped: <reason>"` entries with step `11.5`.
- `GET /api/verify-design-audit?url=<articleUrl>` → full report. Inspect
  `analysisErrors` (empty = clean chain), `issues[]` (deduped findings),
  `rawVisionResponses.{desktop,mobile}` (truncated Llava output for
  debugging silent parse failures).
- R2 bucket `seo-images` → `design-audits/{slug}/{desktop,mobile}.jpg`.

## When to Customize

- **Swap vision model**: change `VISION_MODEL` in
  `src/tools/vision-audit.ts`. Llava 1.5 7B is small and generic —
  `@cf/llava-hf/llava-v1.6-mistral-7b` or Llama 3.2 Vision are likely
  upgrades when/if available on Workers AI.
- **Add viewports**: extend `DESIGN_AUDIT_VIEWPORTS` in
  `src/tools/browser-rendering.ts` and add a third capture in
  `runDesignAudit()`.
- **Change content-addressable mapping**: edit
  `CATEGORY_CONTENT_ADDRESSABLE` in `src/tools/vision-audit.ts`. Err on
  the side of false — Polish wasting AI spend is worse than missing a
  signal.
- **Disable for local dev**: leave Browser Rendering bindings unset;
  `runDesignAudit()` returns `{ skipped: true, skipReason: "Browser Rendering not configured (... unset)" }`.
