# AGENT_CONTEXT.md

# cats-seo-aiagent-cloudflare — AI Agent Master Reference

> This is the single always-load context file for any AI agent working on this
> repo. Read this before touching any code. All rules, architecture facts, and
> critical gotchas live here. Load step-specific skill files
> (`.claude/skills/{slug}/SKILL.md`) on top of this for the task at hand.

---

## 1. Honesty Rules (Non-Negotiable)

1. **Never claim something works unless you tested it.** "Code compiles" ≠ "it
   works." State exactly what you verified and what you didn't.
2. **Never say "fixed" for runtime behavior you can't test.** Say "code change
   committed — needs deploy to verify."
3. **If you can't test something, say so immediately.** State the gap upfront,
   not after being called out.
4. **Don't guess at system state.** Run the command, read the file, query the
   API. If you can't check: "I don't know — I can't verify that from here."
5. **Don't present assumptions as facts.** If inferring: say "I believe" or
   "based on the code." If verified: say "I confirmed by running X."

---

## 2. Development Rules

### Deploy Flow

- **Production deploys go through GitHub Actions only.** Push to `main` →
  `.github/workflows/deploy.yml` runs `npm ci → npm run check → npx vite build
→ npx wrangler deploy` using repo secrets.
- **Manual Wrangler** (`npx vite build && npx wrangler deploy`) is only for
  bypassing CI or recovering a failed deploy. Never the default loop.
- **Secrets via Doppler.** `doppler secrets get <KEY> --plain --no-read-env`.
  Never hardcode secrets.

### Before Every Commit

1. `npx oxfmt --write .` — format (printWidth: 80, no trailing commas)
2. `npm run check` — runs `oxfmt --check . && oxlint src/ && tsc`. All three
   must pass.
3. Commit directly to `main` unless told otherwise.

### CI Workflows

| File                        | Trigger             | What it does                                           |
| --------------------------- | ------------------- | ------------------------------------------------------ |
| `deploy.yml`                | push to `main`      | check → build → wrangler deploy                        |
| `sanity-check.yml`          | PR / push to `main` | lint + types only                                      |
| `agent-code-change.yml`     | `workflow_dispatch` | lint/verify-build + callback to `/api/github-callback` |
| `agent-publish-article.yml` | `workflow_dispatch` | verify-build + callback                                |

---

## 3. Project Stack (Exact Versions Matter)

| Layer           | What                                                  | Notes                                                                        |
| --------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Runtime         | Cloudflare Workers + Durable Objects                  | Single DO = `SEOArticleAgent`                                                |
| Storage         | DO-local SQLite, KV (`ARTICLES_KV`), R2 (`IMAGES_R2`) | See §5                                                                       |
| Agent framework | `agents` (Cloudflare Agents SDK)                      | `Agent<Env, SEOAgentState>` base                                             |
| AI SDK          | `ai` v6 (Vercel AI SDK)                               | `maxOutputTokens` not `maxTokens`; `stopWhen: stepCountIs(n)` not `maxSteps` |
| UI              | React 19 + TailwindCSS                                | `useAgent` hook, not polling                                                 |
| Build           | Vite + `@cloudflare/vite-plugin` + Wrangler           |                                                                              |
| Formatter       | oxfmt                                                 | `.oxfmtrc.json` — printWidth 80, trailingComma none                          |
| Linter          | oxlint                                                | `.oxlintrc.json`                                                             |
| Types           | TypeScript 6                                          | `tsc` must pass                                                              |
| Secrets         | Doppler CLI                                           | Never in source                                                              |

---

## 4. Architecture: Runtime Topology

```
Browser/Dashboard
    │  WebSocket (useAgent)
    ▼
Cloudflare Worker — src/server.ts  (single entrypoint)
    │
    ├── /agents/*  ──────────────────► routeAgentRequest()
    │                                        │
    │                                        ▼
    │                              SEOArticleAgent (Durable Object)
    │                              ┌─────────────────────────────┐
    │                              │  onStart()  — migrations    │
    │                              │  autonomousLoop() — every 5m│
    │                              │  @callable() RPC methods    │
    │                              │  onRequest() — HTTP pass    │
    │                              │                             │
    │                              │  SQLite (DO-local)          │
    │                              │  State (agent state sync)   │
    │                              └─────────────────────────────┘
    │
    ├── /api/logs   ──────────────► DO onRequest() passthrough
    ├── /api/status ──────────────► DO onRequest() passthrough
    └── /* (static) ──────────────► public/ assets (Wrangler assets config)
```

---

## 5. Data Model

### SQLite (inside Durable Object — `onStart()` initializes)

| Table           | Key columns                                                      | Purpose                                                           |
| --------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `categories`    | `id, slug, parent_id`                                            | Discovered niches                                                 |
| `keywords`      | `id, category_slug, keyword, slug, status, seo_score`            | Pipeline queue; status: `pending → generating → completed/failed` |
| `articles`      | `slug, category_slug, keyword, kv_key, url, seo_score, qc_score` | Publish results                                                   |
| `google_sheets` | `url, updated_at`                                                | Recent operator-provided sheet URLs                               |

Indexes: `idx_kw_cat` on `keywords(category_slug, status)`, `idx_art_cat` on
`articles(category_slug)`.

**Any `keywords.status='generating'` rows are reset to `pending` on `onStart()`.**

### KV (`ARTICLES_KV`)

- Article HTML keyed by `categorySlug:slug`
- Sitemap XML at `sitemap:flat-sitemap`
- Idempotency check — skip generation when key already exists

### R2 (`IMAGES_R2`)

- Generated hero / product / section images
- Public URLs embedded into article HTML

---

## 6. The 15-Step Autonomous Pipeline

`autonomousLoop()` fires immediately on `start()` and every 5 minutes via
`scheduleEvery(300, "autonomousLoop")`.

| Step | Label                 | File                                     | Model                                                          |
| ---- | --------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| 0    | KV dedupe check       | `writer.ts`                              | —                                                              |
| 1    | Amazon products       | `pipeline/amazon.ts`                     | Tiers: Creators API → Apify → SerpAPI → synthetic              |
| 2    | SERP analysis         | `pipeline/serp.ts`                       | Composio                                                       |
| 2.5  | Competitor capture    | `pipeline/competitor.ts`                 | Composio → direct fetch                                        |
| 3    | PAA expansion         | `writer.ts` (step 3 helper)              | Google autocomplete                                            |
| 4    | Internal links        | `writer.ts` (step 4 helper)              | SQLite                                                         |
| 5    | AI content generation | `writer.ts`                              | `@cf/moonshotai/kimi-k2.5` + `llama-3.3-70b-instruct-fp8-fast` |
| 6    | Content enhancement   | `writer.ts`                              | `llama-3.3-70b-instruct-fp8-fast`                              |
| 7    | YouTube video search  | `writer.ts`                              | HTML scrape                                                    |
| 9    | HTML assembly         | `pipeline/html-builder.ts`               | —                                                              |
| 9.5  | SEO score             | `pipeline/seo-score.ts`                  | 100 checks, 5 pillars                                          |
| 10   | Deploy to KV          | `writer.ts`                              | —                                                              |
| 11   | Live URL verify       | `writer.ts`                              | HEAD/GET probe                                                 |
| 11.5 | Design audit          | `pipeline/design-audit.ts`               | Cloudflare Browser Rendering + Llava                           |
| 12   | Sitemap update        | `pipeline/indexing.ts`                   | —                                                              |
| 12.5 | QC agent              | `pipeline/qc-agent.ts`                   | `llama-3.3-70b-instruct-fp8-fast`                              |
| 13   | Polish agent          | `pipeline/polish-agent.ts`               | `llama-3.3-70b-instruct-fp8-fast`                              |
| 15   | Live SEO optimizer    | `pipeline/live-seo-content-optimizer.ts` | `llama-3.3-70b-instruct-fp8-fast`                              |

**Image generation** (within step 6/9 path):

- Blog/hero: `@cf/black-forest-labs/flux-2-klein-4b`
- Product: `@cf/black-forest-labs/flux-2-dev`
- Fallback: `@cf/black-forest-labs/flux-1-schnell`

**Scout + Keywords** (pre-pipeline, when queue empty):

- `pipeline/scout.ts` → `llama-3.3-70b-instruct-fp8-fast`
- `pipeline/keywords.ts` → `@cf/moonshotai/kimi-k2.5`

---

## 7. Step → Skill File Routing

Each pipeline step maps to a `.claude/skills/{slug}/SKILL.md`. Load the
relevant one before working on that step.

| Trigger keyword                              | Skill slug                            | File                                                          |
| -------------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| scout, category, roi                         | `cats-amazon-roi-scout`               | `.claude/skills/cats-amazon-roi-scout/SKILL.md`               |
| keywords, kimi                               | `ai-sdk-agents`                       | `.claude/skills/ai-sdk-agents/SKILL.md`                       |
| seo score, review, scorecard                 | `review-skill`                        | `.claude/skills/review-skill/SKILL.md`                        |
| design audit, browser rendering, screenshot  | `design-audit`                        | `.claude/skills/design-audit/SKILL.md`                        |
| polish, prompt engineer                      | `prompt-engineer`                     | `.claude/skills/prompt-engineer/SKILL.md`                     |
| qc review, seo-optimizer, live seo, indexnow | `seo-optimizer`                       | `.claude/skills/seo-optimizer/SKILL.md`                       |
| kv deploy, cloudflare worker, durable object | `cloudflare-worker-dev`               | `.claude/skills/cloudflare-worker-dev/SKILL.md`               |
| deploy, wrangler, ci                         | `cloudflare-worker-deployment`        | `.claude/skills/cloudflare-worker-deployment/SKILL.md`        |
| durable object, sqlite, alarm, websocket     | `durable-objects`                     | `.claude/skills/durable-objects/SKILL.md`                     |
| agent, agents sdk, cloudflare agent          | `building-ai-agent-on-cloudflare`     | `.claude/skills/building-ai-agent-on-cloudflare/SKILL.md`     |
| html, template, schema markup                | `web-html`                            | `.claude/skills/web-html/SKILL.md`                            |
| before any PR or completion claim            | `obra/verification-before-completion` | `.agents/skills/obra-verification-before-completion/SKILL.md` |

---

## 8. Critical Gotchas — Read Before Touching Any Code

### 8.1 Environment Access (most common mistake)

```ts
// ❌ NEVER — env is protected in Durable Objects
agent.env.AI;

// ✅ ALWAYS — use the public getter
agent.envBindings.AI;
```

### 8.2 AI SDK v6 API (breaking differences from v5)

```ts
// ❌ WRONG (v5 API — will type-error)
generateText({ maxTokens: 1200, maxSteps: 3 });

// ✅ CORRECT (v6 API)
generateText({ maxOutputTokens: 1200, stopWhen: stepCountIs(3) });
```

### 8.3 Workers AI Instantiation

```ts
// ✅ Only valid pattern — always from agent.envBindings
const workersai = createWorkersAI({ binding: agent.envBindings.AI });
```

### 8.4 Activity Log Schema

- Current version: **v28** (`ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION`)
- **Bump the version constant** on every schema change
- **170+ columns** (A–JS); column layout must stay in sync with Google Sheets
- **17 agent roles** each own specific column ranges — don't cross-write
- Step numbers strictly `01`–`15` in log entries

### 8.5 SQLite Migrations

```ts
// ✅ Always in onStart(), always use PRAGMA detection
const cols = this.sql`PRAGMA table_info(articles)`;
const hasQcScore = cols.some((c) => c.name === "qc_score");
if (!hasQcScore) {
  this.sql`ALTER TABLE articles ADD COLUMN qc_score INTEGER`;
}
```

- **Progressive only** — add columns, never drop or rename live columns
- **Never** run schema changes outside `onStart()`

### 8.6 Composio API

- Responses are deeply nested — use `findValues2d()` with `depth: 12`
- Fallback order: `SEARCH` → `SEARCH_SPREADSHEETS`, `VALUES_GET` → `BATCH_GET`
- Always wrap in try/catch with multiple method attempts

### 8.7 workflow_dispatch Pattern

- DO triggers GitHub Action via `workflow_dispatch`
- CI **must** call back to `/api/github-callback` with `change_set_id`
- Activity log correlates via `change_set_id` field

### 8.8 DO State Size Budget

- `activityLog` entries are compacted via `compactActivityLogEntryForPersistedState()`
  before persisting — never store raw full entries in DO state
- `pipelineContext` JSON is capped at `PIPELINE_CONTEXT_JSON_MAX = 8000` chars
- Error remediation cells capped at `ACTIVITY_LOG_STATE_MAX_ERROR_REMEDIATION_CHARS = 8000`

### 8.9 WSL / Composio CLI

- Modify `~/.profile` (NOT `~/.bashrc`) for Composio PATH
- Use `scripts/wsl-append-composio-profile.sh` to set up

---

## 9. Callable Methods (Dashboard → DO RPC)

| Method                           | What it does                                                      |
| -------------------------------- | ----------------------------------------------------------------- |
| `start()`                        | Begin `scheduleEvery(300, "autonomousLoop")` + immediate loop run |
| `stop()`                         | Cancel schedules, set status `paused`                             |
| `status()`                       | Returns state + DB counters                                       |
| `scoutNow()`                     | On-demand category scouting                                       |
| `generateOne(keyword, category)` | Single manual article generation                                  |
| `setGoogleSheet(url)`            | Set active Google Sheet URL                                       |
| `useRecentGoogleSheet(url)`      | Switch to a recent sheet                                          |
| `removeRecentGoogleSheet(url)`   | Remove from recents list                                          |
| `useComposioTool(prompt)`        | Run prompt against Composio tools                                 |

HTTP endpoints (no auth): `GET /api/status`, `GET /api/logs`

---

## 10. Extension Points (How to Add Things)

| Want to add               | Where to do it                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------ |
| New pipeline stage        | New file in `src/pipeline/`, wire into `writer.ts`                                   |
| New dashboard control     | Add `@callable()` method on `SEOArticleAgent`                                        |
| New HTTP endpoint         | Add to `onRequest()` in `src/server.ts`                                              |
| New AI model for a step   | Change model string in that step's file only                                         |
| New external system       | Composio tool or new pipeline adapter in `src/pipeline/`                             |
| New Google Sheets columns | Add to `activityLogSheetColumns.ts`, bump `ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION` |

---

## 11. Secrets / Bindings Reference

### `wrangler.jsonc` (non-secret vars)

| Binding                 | Value                              |
| ----------------------- | ---------------------------------- |
| `AI`                    | Workers AI remote binding          |
| `ARTICLES_KV`           | KV namespace                       |
| `IMAGES_R2`             | R2 bucket `seo-images`             |
| `SEOArticleAgent`       | Durable Object class               |
| `AMAZON_AFFILIATE_TAG`  | `catsluvus03-20`                   |
| `DOMAIN`                | `catsluvus.com`                    |
| `CLOUDFLARE_ZONE_ID`    | `646da2c86dbbe1dff196c155381b0704` |
| `CLOUDFLARE_ACCOUNT_ID` | `bc8e15f958dc350e00c0e39d80ca6941` |

### Secrets (Doppler → Wrangler, never in source)

`COMPOSIO_API_KEY`, `AMAZON_ACCESS_KEY`, `AMAZON_SECRET_KEY`, `APIFY_TOKEN`,
`BRIGHTDATA_API_KEY`, `SERPER_API_KEY`, `INDEXNOW_KEY`,
`CLOUDFLARE_API_TOKEN_SECRET`, `GITHUB_TOKEN_SECRET`

---

## 12. Load Order for Any Task

```
1. This file (AGENT_CONTEXT.md)            ← always, first
2. .claude/skills/{relevant}/SKILL.md      ← for the specific step/task
3. .cursor/plans/*.md                      ← only if spec exists for this task
4. .cursor/rules/cloudflare-deploy.mdc     ← only for deploy tasks
5. .agents/skills/obra-verification-before-completion/SKILL.md  ← before any PR
```

Never load all skill files at once. Resolve the slug with
`resolveAgentskillSlugForPipelineStepLabel(stepLabel)` in
`src/activityLogPipelineAgentskill.ts` and load only that one.
