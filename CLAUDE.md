# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A single Cloudflare Worker (`cats-seo-aiagent-staging`) that autonomously
researches keywords, writes SEO articles about cat products, publishes them to
KV, and then keeps auditing/rewriting what it published. It is the **staging**
split of `techfundoffice/cats-seo-aiagent-cloudflare`; `src/` is the same
application, only `wrangler.jsonc` differs (staging worker name, fresh KV/D1/R2/
queue IDs, `DOMAIN=cats-seo-aiagent-staging.webmaster-bc8.workers.dev`). See
`STAGING-REPO.md`.

Staging is not a dead end: articles scoring ≥ `PROD_PUBLISH_MIN_SCORE`
(default 90) are written straight into the **production** `ARTICLES_KV`
namespace by `src/pipeline/prod-publish.ts`, rewritten for `catsluvus.com`, and
the staging URL becomes a 301. Assume any change to the writer/QC/publish path
can reach the money site.

> **Composio is gone (removed 2026-07-22).** No `@composio/*` deps, no
> `.mcp.json`, no `COMPOSIO_API_KEY` in the runtime path. Replacements:
> Google Sheets → `src/pipeline/google-sheets-direct.ts` (service account via
> `GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON`), Doppler reads → Doppler REST API with
> `DOPPLER_TOKEN`, screenshots → Cloudflare Browser Rendering via
> `CLOUDFLARE_API_TOKEN_SECRET`, Quora posting → permanently dry-run. Older
> docs in this repo (`AGENT_CONTEXT.md`, some skills) still describe the
> Composio path — treat those parts as historical.

## Commands

```bash
npm run dev                 # vite dev (local dashboard + worker)
npm run check               # oxfmt --check . && oxlint src/ && tsc && vitest run  ← must pass before commit
npx oxfmt --write .         # format after editing (printWidth 80, no trailing commas)
npm test                    # vitest run (93 test files, node env, src/**/*.test.ts)
npm run bench               # vitest bench (src/**/*.bench.ts)
npm run types               # regenerate env.d.ts from wrangler.jsonc bindings
npm run deploy              # vite build && wrangler deploy (bypass path only — see Deploy)
npm run debug:pull-ndjson   # pull /api/debug-ndjson from the live worker
```

Single test / single case:

```bash
npx vitest run src/pipeline/__tests__/seo-score-serp-checks.test.ts
npx vitest run -t "rejects fabricated testing claims"
npx vitest watch src/pipeline/__tests__/kimi-model.test.ts
```

Note `npm run check` includes `vitest run` — a failing test blocks the same CI
gate (`check (ubuntu-24.04)`) that lint and types do. CI also runs
`npx oxfmt --write .` before `npm run check`, so format locally or the gate
fails on formatting alone.

## Architecture

### Runtime topology

`src/server.ts` (8.7k lines) is both the Worker entrypoint **and** the
`SEOArticleAgent` Durable Object class.

```
Browser dashboard (src/app.tsx, React 19 + useAgent WebSocket)
   │
   ▼
export default { fetch, scheduled, queue }        src/server.ts:8336
   ├── cookie/password wall (DASHBOARD_PASSWORD)  — machine APIs + public assets exempt
   ├── /agents/*                → routeAgentRequest() → SEOArticleAgent DO
   ├── proxyPaths + /api/admin/*, /api/n8n/*  → stub.fetch() into the DO
   ├── /:category/:slug         → article HTML from ARTICLES_KV
   └── /*                       → ./public via ASSETS
   │
   ├── scheduled() every 10 min → crawl tick + idle tick + analytics tick
   └── queue()                  → skill-fetch batch (src/skills/consumer.ts)
```

Inside the DO (`class SEOArticleAgent extends Agent<Env, SEOAgentState>`):

- `onStart()` — SQLite migrations, resets `keywords.status='generating'` → `pending`, re-arms schedules.
- `start()` / `stop()` — `@callable()` RPC that arms `scheduleEvery(300, "autonomousLoop")`.
  The 10-minute cron does **not** start article generation; generation runs from
  that loop (after `start()`) or a one-shot `POST /api/generate-one`.
- Sibling schedules: `observerTick` (15 min), `qualityProbeTick` (30 min),
  `topSellerScoutTick` (24 h).
- `@callable()` methods are the dashboard's control surface: `status`,
  `scoutNow`, `generateOne`, `editorialReview`, `setGoogleSheet`,
  `syncActivityLogSheetHeaders`, `syncScoutKeywordRoiSheet`, `useAgentTools`,
  `useCloudflareApiTool`, `processSheetActionQueue`, `verifyDesignAudit`.

### The 24-step article pipeline

`generateArticle()` in `src/pipeline/writer.ts` (5.1k lines) is the spine; each
step delegates to a module in `src/pipeline/`. Step labels in the code read
`Step N/24` — keep that numbering when adding logs.

| Step   | What                                                                                                    | Module                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0.5, 1 | DataForSEO volume hydration, KV-existence dedupe                                                        | `dataforseo.ts`, `writer.ts`                                                                       |
| 2–4    | Amazon products, SERP analysis, competitor capture                                                      | `amazon.ts`, `serp.ts`, `competitorPick.ts`                                                        |
| 5–6    | PAA/autocomplete expansion, intent gap, internal links                                                  | `autocomplete.ts`, `intent-gap.ts`                                                                 |
| 7–9    | Kimi content generation → slop removal + product-slot hydration → text editor                           | `writer.ts`, `text-editor-agent.ts`                                                                |
| 10–11  | YouTube pick, hero image (flux → R2), HTML assembly                                                     | `article-image.ts`, `html-builder.ts`, `site-chrome.ts`                                            |
| 12–13  | SEO score (100 checks / 5 pillars), KV deploy                                                           | `seo-score.ts`, `qc-gate.ts`                                                                       |
| 14.x   | Live-URL verify, JSON-LD validation, schema-leak, unsourced-YMYL, fabricated-testing, readability gates | `writer.ts`, `fabricated-testing-claims.ts`, `content-quality.ts`                                  |
| 15–16  | Design audit (Browser Rendering + vision), browser-use verify, sitemap                                  | `tools/vision-audit.ts`, `indexing.ts`                                                             |
| 17–20  | QC agent, Polish agent, live SEO optimizer, SISS sub-intent coverage                                    | `qc-agent.ts`, `polish-agent.ts`, `siss-optimizer.ts`                                              |
| 21–24  | Quora seeder (dry-run), QA syndication, reverse internal-link injection, RSS + WebSub                   | `quora-seeder.ts`, `qa-syndication.ts`, `reverse-internal-link-injector.ts`, `feed-syndication.ts` |

Most 14.x gates are non-blocking: they record a defect-loop finding and let the
publish proceed, leaving the Polish Agent to fix the text on the next pass.

Post-publish, out of band: `editorial-agent.ts` (audits the live page against a
wireframe benchmark, writes `editorial-report:<kvKey>`, and stores a rewritten
**variant B** at `<kvKey>-b` for A/B comparison — variant A stays live),
`observer-agent.ts` (narrates worker state into the activity log every 15 min),
`improvement-agent.ts` (opens a Copilot `improvement` issue per successful
publish), `escalate-to-claude.ts` (opens a `claude-fix` issue per failure).

### Data model

- **DO-local SQLite** — `categories`, `keywords` (`pending → generating → completed/failed`), `articles`, `article_rankings`, `google_sheets`.
- **KV `ARTICLES_KV`** — `<categorySlug>:<slug>` article HTML, `<kvKey>-b` variant B, `kimi-raw:<kvKey>` (48 h, raw model output for diagnosis), `editorial-report:<kvKey>`, `escalation-dedup:*`, `sitemap:flat-sitemap`.
- **D1 `KEYWORDS_DB`** (`migrations-keywords/`) — scout keyword source of truth + article ledger + GSC metrics + entity graph. The scout **consumes** keywords from here; it never invents them.
- **D1 `SKILLS_DB`** (`migrations/`) — agentskill.sh catalog crawled through `SKILL_FETCH_QUEUE` (`src/skills/`).
- **R2 `IMAGES_R2`** — generated hero/product images, public via `IMAGES_PUBLIC_BASE_URL` so URLs survive the staging→prod host rewrite.

### Activity log

Every agent action lands in a shared activity log mirrored to Google Sheets
(`activityLogSheetColumns.ts`, ~170 columns, an `AgentRole` union of 29 roles
such as `codingAgent`, `repoAgent`, `editorialAgent`, `observerAgent`,
`qualityProbe`). Roles own disjoint column ranges — don't cross-write. The
layout constant is `ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION` in
`src/server.ts` (currently **32**); **bump it on any column change** and re-run
`syncActivityLogSheetHeaders`. Verify with
`scripts/verify-activity-log-headers-vs-canonical.mts`.

## Invariants that will bite you

- **`agent.env` is protected in Durable Objects.** Always `agent.envBindings.AI` / `.ARTICLES_KV`, never `agent.env.*`.
- **AI SDK v6, not v5.** `maxOutputTokens` (not `maxTokens`), `stopWhen: stepCountIs(n)` (not `maxSteps`).
- **All Kimi calls go through `src/pipeline/kimi-model.ts`.** `getKimiModel(env)` for AI-SDK sites, `runKimiWithPoll(env, …)` for raw-binding sites. OpenRouter when `OPENROUTER_API_KEY` is set (model from `OPENROUTER_KIMI_MODEL`, default `moonshotai/kimi-k2.5:nitro`), Workers AI otherwise. Both paths **disable reasoning** — Kimi's thinking-overflow bug otherwise burns the token budget and returns empty content. On OpenRouter it must be `reasoning: { enabled: false }`; `{ exclude: true }` only hides the output. xAI models reject `enabled: false` and get `effort: "low"` instead.
- **SQLite migrations are progressive and live only in `onStart()`.** Detect with `PRAGMA table_info(...)`, then `ALTER TABLE ... ADD COLUMN`. Never drop/rename a live column, never migrate outside `onStart()`.
- **New `/api/*` routes need two edits.** Add the handler on the DO's `onRequest()` _and_ register the path in `proxyPaths`/the prefix check in the top-level `fetch` (`src/server.ts:8492`), or the Worker never forwards it. If it must work without a browser session, also add it to the `isMachineApi` exemption list.
- **Never add `routes`/`route` to `wrangler.jsonc`.** `catsluvus.com/*/*` is invalid for the Routes API (error 10022) and `catsluvus.com/*` collides with the site Worker (10020). This Worker writes KV; other Workers serve article URLs from the same KV. Production route changes belong in the Cloudflare dashboard.
- **DO state has a size budget.** Activity entries are compacted via `compactActivityLogEntryForPersistedState()` before persisting; `pipelineContext` JSON caps at 8000 chars.
- **Escalation is dormant here by design.** `GITHUB_TOKEN_SECRET` is deliberately unset in staging, so `escalate-to-claude.ts` / `improvement-agent.ts` will not open issues or assign Copilot. Set it only if you want that loop on staging.

## Deploy and secrets

**Push to `main` → `.github/workflows/deploy.yml` → Cloudflare.** That workflow
runs `npm ci`, `oxfmt --write`, `npm run check`, stamps `public/deploy-verify.txt`
with the commit SHA, `vite build`, `wrangler deploy`, pushes all Doppler secrets
via `wrangler secret bulk`, then applies D1 migrations for both databases.
`sanity-check.yml` runs the same check on PRs and provides the required
`check (ubuntu-24.04)` status.

Manual `npx vite build && npx wrangler deploy` is for bypassing CI or recovering
a failed deploy, not the normal loop. The deploy step deliberately tolerates
Cloudflare error 11004 ("queue already has a consumer") when the worker upload
itself succeeded.

Secrets live in Doppler (project `replit-n8n-catsluvus`, config `prd`):
`doppler secrets get <KEY> --plain --no-read-env`. Worker secret writes are not
exposed by any MCP tool; use the Cloudflare REST API directly:

```bash
curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/workers/scripts/cats-seo-aiagent-staging/secrets" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"<NAME>","text":"<VALUE>","type":"secret_text"}'
```

Repo Actions secrets required for CI: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `DOPPLER_TOKEN`.

### Live-state debugging (`/api/admin/*`, `Authorization: Bearer $ADMIN_API_TOKEN`)

`logs`, `recent-failures`, `kv/<kvKey>`, `kimi-raw/<kvKey>`,
`kimi-raw-prompt/<kvKey>`, `render?url=` (post-JS HTML via Browser Rendering —
prefer over `kv/` when checking whether a fix landed live), `editorial-report/`,
`editorial-stats`, `failure-breakdown`, `analytics-summary`, `gsc-sync`,
`retry` (`{ keyword, purgeKv? }`), `keywords`, `qc-gate`, `run-defect-eval`.

## Repo conventions

- Format with `npx oxfmt --write .` and get `npm run check` green **before**
  committing; commit directly to `main` unless told otherwise, and push in the
  same turn you made the change (`.cursor/rules/git-commit-push.mdc`).
- Copilot PRs auto-merge (`auto-merge-copilot.yml`, squash) once
  `check (ubuntu-24.04)` passes. Human PRs must be opened **non-draft** —
  GitHub refuses auto-merge on drafts.
- `.github/workflows/repo-agent.yml` owns post-merge health: deploy watchdog,
  `claude-fix` issue dedup, stale-PR sweep, secret-expiry scan. It intentionally
  avoids `workflow_run` on Copilot-authored workflows (self-blocking recursion)
  and never force-pushes or bypasses branch protection.
- Task-specific playbooks live in `.claude/skills/<slug>/SKILL.md` — load the
  one matching the step you're touching (design-audit, seo-optimizer,
  cats-amazon-roi-scout, durable-objects, …), not all of them. `QA-LOG.md` is
  the running ledger of article QA iterations; append to it when you run the loop.

### Honesty rules (non-negotiable)

1. Never claim something works unless you tested it. "Compiles" ≠ "works."
2. For runtime behavior you can't exercise, say "code change committed — needs
   deploy to verify," not "fixed."
3. State verification gaps upfront, not after being challenged.
4. Don't guess at system state — run the command, read the file, query the API.
5. Mark inferences as inferences; say how you verified what you verified.

### Autonomous execution policy

You are the lead engineer here. Don't stop to ask about prioritization,
implementation choices, or next-step approval unless data loss is possible,
unavailable production credentials are required, an irreversible external action
or payment is involved, or the options differ in business consequence. Otherwise
pick the highest-leverage option, implement it, commit, open the PR, continue,
and explain the reasoning afterward. Priority order: security → reliability →
tests → observability → performance → features → refactoring. Assume approval
for tests, refactors, bug fixes, CI, monitoring, and docs.
