# cats-seo-aiagent-cloudflare Architecture

## Purpose

This system is an autonomous SEO publishing platform for `catsluvus.com` built on Cloudflare Workers. It continuously discovers high-ticket cat-product categories, generates affiliate-oriented articles, evaluates quality/SEO, publishes article HTML to KV, stores generated images in R2, and surfaces live operational state in a realtime dashboard.

## Architectural Style

- Edge-native monolith deployed as a single Worker entrypoint.
- Stateful orchestration through one Durable Object (`SEOArticleAgent`) acting as the control plane.
- Pipeline modules in `src/pipeline` encapsulate each generation step.
- Realtime UI uses the Agents SDK state sync (`useAgent`) instead of polling for primary control.
- Mixed persistence model:
  - DO-local SQLite for workflow and metadata.
  - KV for published article/sitemap payloads.
  - R2 for generated image binaries.

## Runtime Topology

### Entrypoint and Routing

- Worker entrypoint: `src/server.ts`.
- `fetch()` delegates:
  - `/api/logs` -> DO `onRequest()` passthrough.
  - `/api/status` -> DO `onRequest()` passthrough.
  - `/agents/*` and agent transport -> `routeAgentRequest(...)`.
  - Static assets served from `public` via Wrangler assets config.

### Durable Object: `SEOArticleAgent`

`SEOArticleAgent` is the core orchestrator and single source of truth for:

- Lifecycle state (`idle`, `scouting`, `generating`, `paused`).
- Progress (`currentCategory`, `currentKeyword`, `currentStep`).
- Counters (`articlesGenerated`, `articlesFailed`, `avgSeoScore`, etc.).
- Operator log stream (`activityLog`) and Google Sheet settings.
- Recovery behaviors on startup (schema migration, stuck keyword reset, schedule restore).

The agent exposes typed RPC controls via `@callable()` and runs a recurring autonomous loop through `scheduleEvery(300, "autonomousLoop")`.

## Core Data Model

## SQLite (inside Durable Object)

Tables initialized in `onStart()`:

- `categories`: discovered niches and completion progress.
- `keywords`: per-keyword queue with status (`pending`, `generating`, `completed`, `failed`).
- `articles`: publish results and quality metadata.
- `google_sheets`: recent operator-provided sheet URLs.

Indexes:

- `idx_kw_cat` on `keywords(category_slug, status)`.
- `idx_art_cat` on `articles(category_slug)`.

## KV (`ARTICLES_KV`)

- Stores rendered article HTML keyed by `categorySlug:slug`.
- Stores sitemap XML at `sitemap:flat-sitemap`.
- Also used for idempotency (skip generation when key exists).

## R2 (`IMAGES_R2`)

- Stores generated hero/product/section images.
- Referenced by public URLs inserted into generated HTML.

## AI and External Integrations

- **Workers AI (primary LLM/runtime):**
  - Category scouting and article generation.
  - SEO/QC/polish agent passes.
  - Image generation models (Flux variants).
- **Composio (optional tool bridge):**
  - Lazy-initialized session from `COMPOSIO_API_KEY`.
  - Used for tool-augmented operations (`useComposioTool`) and some data acquisition paths.
- **Amazon product data strategy:**
  - Tiered fallback: Creators API -> Apify -> SerpAPI/composio-assisted -> synthetic fallback products.
- **Indexing:**
  - IndexNow notification + sitemap mutation post-publication.

## End-to-End Autonomous Flow

1. **Loop trigger** (`autonomousLoop`) runs immediately on `start()` and every 5 minutes thereafter.
2. **Queue check**:
   - If pending keywords exist, process one.
   - If none exist, scout a new high-ticket category and generate keywords.
3. **Generation pipeline** (`generateArticle` in `writer.ts`):
   - KV dedupe check.
   - Product data retrieval.
   - SERP analysis + competitor capture.
   - PAA expansion and internal link collection.
   - AI content generation into structured article data.
   - Optional polish/QC passes and SEO scoring.
   - HTML build with schema metadata.
   - Image generation/upload.
   - KV write + sitemap update + IndexNow notify.
4. **Persistence updates**:
   - Keyword status transitions.
   - Article row insert when produced.
   - Category completion tracking.
   - Aggregate score recalculation.
5. **State/log updates**:
   - Dashboard receives realtime state via agent state sync.

## Public and Control Interfaces

### Callable Methods (dashboard controls)

- `start()`: begin autonomous schedule + immediate loop run.
- `stop()`: cancel schedules and pause.
- `status()`: state plus DB counters.
- `scoutNow()`: on-demand category scouting.
- `generateOne(keyword, category)`: single manual generation.
- `setGoogleSheet(...)`, `useRecentGoogleSheet(...)`, `removeRecentGoogleSheet(...)`.
- `useComposioTool(prompt)`: run prompt against discovered composio tools.

### HTTP Endpoints

- `GET /api/status`: machine-readable state and counters.
- `GET /api/logs`: plain-text operational log plus recent DB snapshots.

### Frontend (`src/app.tsx`)

- React dashboard backed by `useAgent<SEOArticleAgent, SEOAgentState>()`.
- Operator actions call agent stubs directly (start/stop/scout/sheet management).
- Main observability surfaces:
  - Current lifecycle/step.
  - Generation counters and average SEO score.
  - Reversed activity log feed.
  - Embedded shared Google Sheet.

## Configuration and Bindings

Defined in `wrangler.jsonc`:

- AI binding: `AI` (remote Workers AI).
- Durable Object binding: `SEOArticleAgent`.
- KV namespace: `ARTICLES_KV`.
- R2 bucket: `IMAGES_R2`.
- Runtime vars: `AMAZON_AFFILIATE_TAG`, `DOMAIN`, `CLOUDFLARE_ZONE_ID`.

Additional runtime secrets/vars expected by code paths:

- `COMPOSIO_API_KEY`
- `AMAZON_CREDENTIAL_ID`
- `AMAZON_API_SECRET`
- `APIFY_TOKEN`
- `INDEXNOW_KEY`

## Failure Handling and Recovery

- `onStart()` performs schema safety migrations (`PRAGMA table_info` checks).
- Any `keywords.status='generating'` rows are reset to `pending` after restart.
- Schedule restoration occurs automatically when prior state indicates active work.
- Loop body has broad error trapping and transitions to safe `idle`.
- Module-level fallbacks prevent hard stops (product and image generation both degrade gracefully).

## Operational Workflows

- Local development: `npm run dev`.
- Required quality gate before commit: `npm run check`.
- Deploy contract (project rule): `npx vite build && npx wrangler deploy`.
- Formatting standard: `npx oxfmt --write .`.

## Architectural Boundaries and Extension Points

- Add/replace generation stages by extending modules in `src/pipeline` and wiring in `writer.ts`.
- Add new operator controls by adding `@callable()` methods on `SEOArticleAgent`.
- Add new observability endpoints in DO `onRequest()`.
- Swap/tune model choices per stage without changing orchestration contract.
- Integrate new external systems through composio tools or dedicated pipeline adapters.

## Known Constraints

- Single-DO orchestration is simple and consistent, but limits horizontal workflow parallelism.
- AI and external API variability can affect quality and latency; fallbacks reduce but do not remove nondeterminism.
- Current scheduler cadence is fixed (5 minutes) and not load-adaptive.
- Starter README still describes the original chat template; this architecture document is the canonical reference for the current SEO agent system.
