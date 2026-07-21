---
name: editorial-agent
description: >
  Published Article Editorial Agent — fires autonomously after every
  successful publish from the SEOArticleAgent pipeline. Reads the KV
  HTML, drives Composio's BROWSER_TOOL to load + scroll + screenshot
  the live catsluvus.com page, Kimi-audits body text AND screenshots
  vs a per-category editorial benchmark (default: NYT Wirecutter's
  best-automatic-cat-litter-box roundup), writes an EditorialReport
  JSON to `editorial-report:<kvKey>` KV key, and when actionable
  findings exist rewrites the HTML (preserving all affiliate links
  and product-pick blocks) + writes back to KV — catsluvus.com reads
  KV so this is a republish. No human trigger — the skill is wired
  into the publish success block and runs via `ctx.waitUntil` so it
  does not block the next-keyword loop.
metadata:
  author: cats-seo-aiagent
  version: "2.0"
triggers:
  - editorial audit
  - published article review
  - post-publish audit
  - wireframe comparison
  - editorial-agent
  - rewrite-and-republish
includes:
  - src/pipeline/editorial-agent.ts
  - src/pipeline/wireframe-ingest.ts
  - src/server.ts
---

# Changelog

- v2.1: A/B split-test ready. The rewrite step now writes to `${kvKey}-b` (variant B) instead of overwriting the original. Variant A (the original `kvKey`) stays live at catsluvus.com. A separate downstream split-tester agent compares A vs B on SEO/quality/traffic metrics and swaps the winner into the live slot — the Editorial Agent never touches the live article directly. `EditorialReport.variantBKey` exposes the B-variant KV key for the split-tester.
- v2.0: Reference URL is now ingested as an abstract WIREFRAME (pattern types, methodology shape, evaluation criteria, structural presence flags) via `FIRECRAWL_EXTRACT` + DataForSEO on-page summary. Raw HTML/markdown persist in R2 for provenance only; prompts never see source prose. Enforces no-prices Amazon Associates compliance (regex reject + hard prompt rule). Cached 7d in KV, indexed in DO SQLite `wireframe_documents` / `wireframe_chunks`.
- v1.0: Initial URL-as-string prompt injection.

---

# Published Article Editorial Agent

Autonomous post-publish editorial loop. Runs AFTER a keyword lands on
`status='completed'` and the `Published:` log line fires (see
`src/server.ts`, inside the `result.success` block right after
`articlesGenerated++`). Uses the Cloudflare Agents SDK `ctx.waitUntil`
to keep the pipeline loop unblocked while the 4-step audit runs
~1–3 min per article.

## 4 steps

1. **Read + text audit.** `envBindings.ARTICLES_KV.get(kvKey)` → strip
   HTML → Kimi JSON-audit the body vs the reference URL. Returns
   `missingSections`, `weaknessesVsReference`, `factualRisks`,
   `toneIssues` arrays.

2. **Browser screenshots.** Calls `executeComposioTool(
"BROWSER_TOOL_CREATE_TASK", { startUrl, task })` asking the agent
   to load, scroll, full-page screenshot, return rendered text. Polls
   `BROWSER_TOOL_WATCH_TASK` every 5 s up to 3 min. Extracts
   screenshot URLs from the nested output.

3. **Visual audit + merged report.** Kimi JSON-audits screenshot URLs
   plus the reference URL → `layoutIssues`, `densityIssues`,
   `ctaIssues`. Merges with step-1 into `EditorialReport`, writes to
   KV `editorial-report:<kvKey>` with 14-day TTL.

4. **Apply fixes + republish.** If `applyFix=true` (default) and
   `actionableFixes > 0`, Kimi rewrites the article HTML preserving
   every `<a>`, `<img>`, and top-pick block; length gate at 80% of
   original; writes revised HTML back to `ARTICLES_KV[kvKey]` →
   live on catsluvus.com via the existing KV-backed render path.

## Per-category reference URLs

`pickEditorialReferenceUrl(categorySlug)` in `src/server.ts` maps
category slugs to NYT Wirecutter URLs (`litter-boxes`,
`water-fountains`). Fallback default:
`https://www.nytimes.com/wirecutter/reviews/best-automatic-cat-litter-box/`.

Add a new category → reference URL mapping by editing the
`EDITORIAL_REFERENCE_URLS` object in `src/server.ts`.

## Activity surface

Every step logs to the activity feed under role `editorialAgent`
(offset 20 in `activityLogSheetColumns.ts`, column AV on the Google
Sheet mirror). The dashboard's `EditorialAgentPanel` (a scrollable
360 px `<details>` block in `src/app.tsx`) streams these live and
mirrors the Repo Agent / Coding Agent panel layout.

## Admin debug endpoints

`POST /api/admin/editorial-review` with `{ kvKey, referenceUrl?,
applyFix? }` forces a run against any already-published kvKey —
used for debugging or re-auditing without waiting for a fresh
publish. `GET /api/admin/editorial-report/<kvKey>` returns the
latest persisted `EditorialReport` JSON.

## Guardrails

- The rewrite step refuses output shorter than 80% of the original
  (prevents truncation regressions).
- Rewrite also must contain at least one of `<article|<section|<div|<p|<h[1-6]` to survive an HTML sanity check.
- On any step failure the original KV value is left untouched.
- Dedup/retry lives upstream: the publish block only fires the
  Editorial Agent when `result.kvKey` is defined, so skipped-publish
  (`seoScore=0 && wordCount=0`) rows never trigger.

## Related skills

- `design-audit` — visual QC run BEFORE publish (Step 11.5), uses
  Cloudflare Browser Rendering + Workers AI Llava. The Editorial
  Agent is its post-publish counterpart: broader scope (text +
  visuals + rewrite + republish) with longer wall-clock budget.
- `cloudflare-browser-rendering` — alternative screenshot path we
  use inside the Worker; Editorial Agent delegates to Composio
  instead so the browser session gets a residential IP + proper
  JS-heavy rendering that our first-party Browser Rendering
  occasionally can't complete within DO CPU limits.
