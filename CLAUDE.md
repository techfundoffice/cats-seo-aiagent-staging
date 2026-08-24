# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Cloudflare Worker that autonomously researches, writes, QCs, publishes, and
distributes SEO articles for `catsluvus.com`. One Durable Object
(`SEOArticleAgent`) owns the whole lifecycle; a React dashboard (`src/app.tsx`)
drives it over Agents-SDK RPC.

**This is the STAGING repo** (`cats-seo-aiagent-staging`), split from
`techfundoffice/cats-seo-aiagent-cloudflare`. `src/` matches production at the
split point; only deploy config and the resources it binds differ. Every
stateful binding (KV / D1 / R2 / queue) points at a **fresh** staging resource,
so this Worker never reads or writes production data. See `STAGING-REPO.md` for
the binding IDs and the required GitHub Actions secrets.

Two staging-specific differences worth knowing before you debug something that
"should" work:

- No `PETINSURANCE` service binding (`env.d.ts` types it optional). The Step 14
  live-URL probe falls back to a public fetch.
- `GITHUB_TOKEN_SECRET` is deliberately unset, so the autonomous coding-agent
  escalation (§ Autonomous Coding Agent Loop) stays dormant here — no issues
  opened, no Copilot assigned.

`README.md` is leftover from the `cloudflare/agents-starter` template and does
**not** describe this project. Ignore it. `AGENT_CONTEXT.md` and
`CODEBASE_ANALYSIS.md` are longer prose references carried over from the prod
repo; parts (Composio, "15-step pipeline") are stale — this file wins.

## Commands

```bash
npm run dev        # vite dev — local Worker + dashboard
npm run check      # oxfmt --check . && oxlint src/ && tsc && vitest run  ← run before EVERY commit
npm run format     # oxfmt --write .   (printWidth 80, trailingComma none)
npm run lint       # oxlint src/
npm test           # vitest run
npm run bench      # vitest bench --run
npm run types      # regenerate env.d.ts from wrangler.jsonc bindings
npm run deploy     # vite build && wrangler deploy  (manual — see § Deploy)
```

Single test / filtered runs:

```bash
npx vitest run src/pipeline/__tests__/seo-score.test.ts
npx vitest run -t "rejects degenerate keywords"     # by test name
npx vitest src/pipeline/__tests__/traffic-sources.test.ts   # watch mode
```

Vitest is `environment: "node"`, `include: ["src/**/*.test.ts"]` — no jsdom, no
`@cloudflare/vitest-pool-workers`. Tests target **pure helpers only**; anything
that needs the Workers runtime or a DO is not unit-testable here, so extract the
logic into a pure function and test that.

Formatting/lint are enforced in CI (`sanity-check.yml` runs `npx oxfmt --write .`
then `npm run check` on every push and PR to `main`), so a formatting miss fails
the required `check (ubuntu-24.04)` status.

## Deploy

- **Push to `main` → `.github/workflows/deploy.yml`** (`npm ci` → `npm run check`
  → `npx vite build` → `npx wrangler deploy`, plus a Doppler →
  `wrangler secret bulk` step). This is the only supported release path.
  Nothing is verified until it deploys, so do not leave work sitting on an
  unmerged branch.
- **Manual `npx vite build && npx wrangler deploy`** is for bypassing CI or
  recovering a failed deploy only — never the default loop.
- **Never add a `routes`/`route` array to `wrangler.jsonc`.** `catsluvus.com/*/*`
  is invalid for the Routes API (error 10022 — wildcards only at hostname start
  or path end), and `catsluvus.com/*` collides with the consumer Worker on the
  zone (10020). This Worker _writes_ KV; other Workers serve article URLs from
  the same KV. Production `.txt`/IndexNow routes belong in the Cloudflare
  dashboard. (`.cursor/rules/wrangler-no-zone-routes.mdc`)

## Secrets: every token lives in Doppler

**There is no other source of truth.** `ADMIN_API_TOKEN`, `PAGESPEED_API_KEY`,
`CLOUDFLARE_API_TOKEN`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN_SECRET` — all of
them. Never ask the user to paste a token, never assume a credential doesn't
exist because it's absent from the environment, never hardcode one.

**Project `replit-n8n-catsluvus`, config `prd`** — the only project, the only
config.

```bash
doppler secrets get <KEY> --plain --no-read-env \
  --project replit-n8n-catsluvus --config prd
```

A sandbox session usually **cannot** reach Doppler: no `doppler` CLI, no
`DOPPLER_TOKEN`. Check first — `which doppler; env | grep -i doppler`. If it's
unreachable, say so plainly and name the specific secret that is blocking you;
that's a one-step fix for the user, not a reason to call the task impossible or
invent a workaround. With a `DOPPLER_TOKEN` present, prefer the CLI; the REST
API (`https://api.doppler.com/v3/configs/config/secret`) is the fallback — the
Worker already uses it in `SEOArticleAgent.rotateOpenRouterKeyFromDoppler()`
(`src/server.ts`), triggered from `src/pipeline/kimi-model.ts` on a 401.

**Composio was removed from this repo on 2026-07-22.** No `@composio/*` deps, no
`.mcp.json`, no `COMPOSIO_API_KEY`. Anything you find referencing
`composio tool run doppler …` or Rube MCP is dead prod-repo history. Direct
replacements: Google Sheets mirror → `src/pipeline/google-sheets-direct.ts`
(service account via `GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON`); Doppler reads → REST
API via the `DOPPLER_TOKEN` Worker secret; screenshots → Cloudflare Browser
Rendering via `CLOUDFLARE_API_TOKEN_SECRET`; Quora posting → permanently
dry-run (no public API).

### Cloudflare Worker secret writes

No MCP tool exposes Worker secret writes. The pattern (Worker must already be
deployed):

```bash
curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/workers/scripts/cats-seo-aiagent-staging/secrets" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"<NAME>","text":"<VALUE>","type":"secret_text"}'
```

## Architecture

### Runtime topology

```
Browser ──WebSocket/RPC──┐
                         ├─► Worker fetch handler (src/server.ts, default export)
Cron (*/10 * * * *) ─────┤     • serves ./public assets + SPA
Queue (skill-fetch) ─────┘     • serves /feed.rss, /sitemap.xml from KV
                               • proxies /api/* → the single DO instance
                                 idFromName("default")
                                      │
                            SEOArticleAgent (Durable Object, extends Agent<Env, SEOAgentState>)
                              • DO-local SQLite (categories, keywords, articles,
                                article_rankings, wireframe_*, pipeline_secrets, …)
                              • synced state → dashboard (activity log, status)
                              • orchestrates src/pipeline/* (the 24-step pipeline)
```

Bindings: `ARTICLES_KV`, `SKILLS_DB` + `KEYWORDS_DB` (D1), `IMAGES_R2`,
`SKILL_FETCH_QUEUE`, `AI` (Workers AI), `ASSETS`.

### Request routing (`src/server.ts`, default export ~line 9342)

The top-level `fetch` forwards to the DO via `stub.fetch()` for: an exact-match
`proxyPaths` list (`/api/status`, `/api/start`, `/api/generate-one`,
`/api/traffic-sources`, …) plus prefix matches for `/api/qa/*`,
`/api/admin/*`, `/api/dashboard/*`, `/api/preview|/api/screenshot`, and
`/api/n8n/*`. **A new `/api/…` route that isn't in that list falls through to the
assets binding's SPA fallback and silently returns `index.html`** — this is the
single most common "my endpoint returns HTML" bug. Auth lives _inside_ the DO
(`ADMIN_API_TOKEN` bearer for `/api/admin/*`, `N8N_WEBHOOK_SECRET` for
`/api/n8n/*`, cookie wall for dashboard feeds).

`scheduled()` (every 10 min) fans out four `ctx.waitUntil` jobs: crawl tick,
idle tick (`/api/idle-tick` — skips itself while generating), traffic-source
fill (`/api/traffic-sources/fill` — deliberately does _not_ skip while busy),
and analytics tick (`/api/analytics-tick`). Cron never starts article
generation; that's manual via `POST /api/generate-one`.

`queue()` → `handleSkillFetchBatch` (`src/skills/consumer.ts`).

### The 24-step pipeline

`generateArticle(agent, keyword, slug, categorySlug)` in
`src/pipeline/writer.ts` (~5.4k lines) is the spine. Steps are marked with
`// Step N/24:` banner comments — grep those to navigate. Shape:

1–6 research (KV existence check, DataForSEO volume, competitor capture, SERP
intent gap, PAA/autocomplete, internal links) → 7 AI generation of structured
JSON → 9–11 enhancement, text editor, hero image (Workers AI flux → R2),
YouTube, HTML assembly (`html-builder.ts`) → 12 SEO score (`seo-score.ts`) →
13 **KV deploy** → 14 live-URL verification → 14.5–14.8 post-write detectors
(JSON-LD validity, unsourced YMYL claims, fabricated testing claims,
readability/process language) → 15 design audit (Browser Rendering + vision) →
16–20 sitemap, QC agent, polish agent, live SEO pass, SISS optimizer → 21–24
Quora seeding, QA syndication, reverse internal-link injection, RSS/WebSub.

Rules that hold across it:

- `generateArticle` **never throws** — it returns `ArticleResult`. The one
  exception is a Durable Object reset (mid-deploy eviction), rethrown so
  `autonomousLoop` leaves the keyword alone and `onStart()` resets
  `generating → pending` for automatic retry.
- Every `failResult({ success: false })` site escalates via
  `escalateToCodingAgent` before returning.
- Detectors after Step 13 are **non-blocking by design**: they record a
  defect-loop finding and let the publish stand; the Polish Agent (Step 18)
  fixes the content on the next pass.

### Model provider selection

All model calls go through `src/pipeline/kimi-model.ts` — never instantiate a
provider inline.

- `getKimiModel(env)` returns a `LanguageModel` for AI SDK
  `generateText()`/`generateObject()` sites. `getScoutModel` / `getFreeModel`
  are the cheaper variants.
- `runKimiWithPoll(env, params)` is the raw-binding call site helper (writer,
  siss-optimizer) and is the only path with real try-then-fall-back behavior.

Staging is **Claude-first**: each call tries the Claude Code subscription
(`claude-code-subscription.ts`), then falls through to Kimi K2.5 via OpenRouter
when `OPENROUTER_API_KEY` is set, then Workers AI. Claude is skipped on no
subscription token, an active 429 cooldown, or a call failure. Unlike prod, the
Kimi fallback is live code — do not delete it.

Kimi thinking mode must stay disabled or the model burns `max_tokens` on
reasoning and returns `content: null`: Workers AI uses
`chat_template_kwargs: { enable_thinking: false, … }` (inside
`aiGenerateWithPoll`); OpenRouter needs `reasoning: { enabled: false }` —
`{ exclude: true }` only _hides_ reasoning and does not fix the bug.

### Data model

**DO-local SQLite** (`this.sql`, created in `onStart()`): `categories`,
`keywords`, `articles`, `pipeline_secrets`, `google_sheets`, `bestseller_nodes`,
`agent_debug_ndjson`, `wireframe_documents`, `wireframe_chunks`,
`article_rankings`. Migrations are hand-rolled: `CREATE TABLE IF NOT EXISTS`
plus `PRAGMA table_info(<table>)` to detect and `ALTER TABLE` in missing
columns. There is no migration framework here — follow the existing pattern.

**D1** — `KEYWORDS_DB` (`migrations-keywords/`) is the scout source of truth:
`scout_keywords` (status `pending → generating → published|failed|rejected`;
the scout _claims_ rows and never invents keywords), `article_ledger`,
`article_rankings`, `scout_products`, GSC metrics, entity graph. `SKILLS_DB`
(`migrations/`) backs the skills catalog + FTS.

**KV (`ARTICLES_KV`)** — the published article lives at `<categorySlug>:<slug>`
(this is the `kvKey` threaded through every pipeline function and admin route).
Sidecar keys follow `<purpose>:<kvKey>`: `kimi-raw:` (48h, raw model output for
diagnosis), `kimi-raw-prompt:`, `editorial-report:`, `traffic-sources:` (ledger)
and `traffic-source:<id>:`, `defect-findings:`, `escalation-dedup:` (60 min),
`ctr-rewrite:`, `qa:`, plus singletons `feed:rss`, `idle-tick:cursor`.

**R2 (`IMAGES_R2`)** — hero images (public base URL is a var so URLs survive the
staging → production host rewrite) and screenshots.

### Dashboard ↔ DO

`src/app.tsx` calls `@callable()` methods on the agent stub (~25 of them in
`src/server.ts`) rather than REST wherever possible. State pushed to the client
is `SEOAgentState`; note it carries **three** ring buffers — `activityLog` (200
rows, rolling), `activityLogErrors`, and `observerLog` — because errors and
15-minute observer ticks would otherwise be evicted within minutes during a
generation burst. Keep the DO state size budget in mind when adding fields.

### Activity log

`agent.log(level, msg, role?, ctx?)` is the single entry point (`src/server.ts`
~7607). It runs `redactSecrets(msg)` there so every downstream sink (`/api/logs`,
the Google Sheets mirror, dashboard render, defect quoting) inherits the
protection — never bypass it by writing to `state.activityLog` directly. `role`
is the `AgentRole` union in `src/activityLogSheetColumns.ts` (`orchestrator`,
`contentCreator`, `qaReviewer`, `marketing`, `codingAgent`, `repoAgent`,
`editorialAgent`, …) and maps to dashboard grouping + a Google Sheet column.
Sheet columns are canonical and order-sensitive — see
`activityLogSheetLayout.ts` and `.cursor/plans/activity-log-google-sheet-header-sync-spec.md`
before adding one.

## Conventions and gotchas

- **`DurableObject.env` is protected.** Pipeline functions take the agent and
  read `agent.envBindings` (the public getter). Passing `env` around directly
  will not typecheck.
- **AI SDK v6** (`ai` package): `maxOutputTokens` not `maxTokens`;
  `stopWhen: stepCountIs(n)` not `maxSteps`.
- **oxlint has `no-explicit-any: error`.** Use `unknown` + narrowing;
  `catch (err: unknown)` with `errMsg(err)` / `errStack(err)` from
  `src/pipeline/http-utils.ts` is the house style.
- Unused bindings must be `_`-prefixed to pass lint.
- New pure helpers belong in their own module with a test in
  `src/pipeline/__tests__/` — that's the only layer with real coverage.
- Run `npx oxfmt --write .` after editing TS/TSX.

## Autonomous Coding Agent Loop

`escalateToCodingAgent(agent, { kvKey, keyword, categorySlug, errorCategory,
errorMessage, metadata? })` in `src/pipeline/escalate-to-claude.ts` does two
fire-and-forget things: opens a GitHub issue labeled `claude-fix` with a
diagnostic runbook (bearer-auth curl commands for `/api/admin/*`), then assigns
`Copilot` so GitHub Copilot Coding Agent picks it up and opens a draft PR.
Deduped by `escalation-dedup:<kvKey>:<category>` (60 min TTL) so retry storms
don't spam issues; every escalation logs under role `codingAgent`. Called from
every `failResult` site in `writer.ts`, the top-level catch, the
`/api/generate-one` boundary, and automatically for parser-error patterns via
`maybeEscalateParserError`. **Dormant in this repo** — `GITHUB_TOKEN_SECRET` is
unset (§ What this repo is). Do not add polling that runs outside these
triggers; sessions are not daemons.

The admin surface it drives (bearer `ADMIN_API_TOKEN`, all under
`/api/admin/*`): `GET logs?limit=`, `GET recent-failures?limit=`,
`GET kv/<kvKey>`, `GET kimi-raw/<kvKey>`, `GET render?url=` (live post-JS HTML
via Browser Rendering — prefer over `kv/` when verifying a fix actually landed;
only accepts `catsluvus.com` URLs), `POST retry {keyword, purgeKv?}`,
`GET traffic-sources`, `POST traffic-sources/fill`, `GET
traffic-source/<sourceId>/<kvKey>`, `POST promote`.

`.github/workflows/repo-agent.yml` owns the gap between "PR merged" and "fix is
live, no regression": `workflow_run: Deploy` (post-deploy watchdog on success;
classified deploy-failure issue on failure), a 15-min housekeeping sweep
(cross-issue dedup, stale Copilot PR sweep, secret-expiry scan), and
`issues.opened` real-time dedup. It intentionally does **not** use
`workflow_run` on Copilot-authored workflows — GitHub inherits the triggering
actor, so such runs land in `conclusion: action_required` and self-block.

## Traffic source distribution

`src/pipeline/traffic-sources.ts` fills 13 channels per published article during
the minutes the writer spends on the next one. Machine channels do real work and
are re-verified every pass (`sitemap`, `indexnow`, `rss`, `websub`, `qa-json`);
copy channels are Kimi-generated artifacts stored ready-to-paste (`pinterest`,
`x`, `facebook`, `reddit`, `quora`, `youtube-short`, `newsletter`, `medium`).
**Nothing auto-posts.** A source retries until `filled`/`skipped` or
`MAX_ATTEMPTS` (5). Two drivers — the fire-and-forget backfill kicked off by
`generateArticle` (excluding the in-flight kvKey) and the 10-min cron — share a
60s KV lock (`traffic-sources:lock`).

## Working agreement

### Honesty

1. Never claim something works unless you tested it. "Compiles" ≠ "works". Say
   exactly what you verified and what you didn't.
2. For runtime behavior you can't test, say "code change committed — needs
   deploy to verify", not "fixed".
3. State a verification gap upfront, not after being called out.
4. Don't guess at system state — run the command, read the file, query the API.
   If you can't check: "I don't know — I can't verify that from here."
5. Mark inference as inference ("based on the code") and verification as
   verification ("I confirmed by running X").

### Autonomous execution

You are the lead engineer here. Don't stop for prioritization, implementation
choices, tradeoffs, or next-step approval unless: data loss is possible;
production credentials are needed and Doppler is unreachable; a payment or
irreversible external action is required; or options have materially different
business consequences. Otherwise pick the highest-leverage option, implement it,
commit, and continue — explain the reasoning after the work, not before.

Priority when multiple tasks exist: security → reliability → tests →
observability → performance → features → refactoring. Assume approval for test
creation, refactoring, bug fixes, CI/monitoring improvements, and docs.

### Git

**Push straight to `main` by default** — features, fixes, refactors, docs alike.
`npm run check` must pass first. A feature branch that sits unmerged is work
that never deployed and was never verified. Use a branch + PR only when the user
(or the session harness) explicitly asks for one. Before finishing a turn where
you edited files, run `git status` and commit + push in that same turn. Never
force-push unless asked.

When a PR _is_ the requested flow:

- **Never open human-authored PRs as draft** — GitHub blocks auto-merge on
  drafts. Open ready-for-review (`draft: false`).
- Copilot PRs are the exception: `.github/workflows/auto-merge-copilot.yml`
  flips draft → ready and enables `SQUASH` auto-merge; the required
  `check (ubuntu-24.04)` status still gates it.
- "Auto-merge is not available" almost always means: PR is draft, no pending
  required check, targets a branch other than `main`, or it's already fully
  mergeable (use the plain merge endpoint).
- A PR carrying a previously-failed required check needs a new head commit
  before auto-merge will engage.
