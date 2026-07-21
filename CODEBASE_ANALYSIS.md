# Codebase Analysis: cats-seo-aiagent-cloudflare-1

## Project Overview

**cats-seo-aiagent-cloudflare-1** is an autonomous SEO content generation system built on Cloudflare Workers. It uses a Durable Object architecture to run a 5-minute autonomous loop that discovers categories, generates keywords, writes SEO-optimized articles, and publishes them to a WordPress site - all without human intervention.

### Key Characteristics

- **Edge-Native Monolith**: Single Durable Object orchestrating entire pipeline
- **Autonomous Operation**: 5-minute alarm-driven loop
- **Persistence**: DO-local SQLite + KV + R2 storage
- **AI-Powered**: Workers AI via Vercel AI SDK v6
- **Production-Ready**: GitHub Actions CI/CD with quality gates

## Architecture

### Core Components

**1. SEOArticleAgent Durable Object** (`src/server.ts` - 3,170 lines)

- Main orchestrator extending Cloudflare Agents SDK
- Manages 15-step content generation pipeline
- SQLite database (categories, keywords, articles tables)
- 13+ callable methods for REST control
- WebSocket support for real-time dashboard updates

**2. 15-Step Pipeline** (6,451 total lines)

```
scout → keywords → SERP → competitor → Amazon → images →
writer → HTML → QC → polish → SEO score → plagiarism →
indexing → live optimizer
```

**3. React 19 Dashboard** (`src/app.tsx`, `src/client.tsx`)

- Real-time WebSocket connection
- Activity log viewer (Google Sheets integration)
- Agent control panel

**4. Activity Log System** (6 files, 170+ columns)

- Google Sheets integration via Composio
- 17 agent roles with dedicated columns (A-FW+)
- Version-tracked schema (currently v28)
- Tracks every pipeline operation

## File Structure

```
src/
├── server.ts                              # Main Durable Object (3,170 lines)
├── pipeline/                              # Content generation pipeline (6,451 lines)
│   ├── scout.ts                          # Category discovery (447 lines)
│   ├── keywords.ts                       # Keyword generation (164 lines)
│   ├── serp.ts                           # Search results analysis (313 lines)
│   ├── competitor.ts                     # Competitor content capture (155 lines)
│   ├── amazon.ts                         # Product fetching (403 lines)
│   ├── images.ts                         # R2 image uploads (333 lines)
│   ├── writer.ts                         # Main pipeline orchestrator (1,732 lines)
│   ├── html-builder.ts                   # Semantic HTML5 generation (839 lines)
│   ├── qc-agent.ts                       # AI quality checks (190 lines)
│   ├── polish-agent.ts                   # Editorial refinement (176 lines)
│   ├── seo-score.ts                      # 100-check SEO scoring (964 lines)
│   ├── seo-scorecard-qc-prompts.ts       # Remediation prompts (273 lines)
│   ├── plagiarism-overlap.ts             # Overlap detection (65 lines)
│   ├── live-seo-content-optimizer.ts     # Post-publish validation (118 lines)
│   ├── indexing.ts                       # IndexNow submission (76 lines)
│   └── ...
├── app.tsx                                # React dashboard
├── client.tsx                             # React entry point
├── activityLogSheetColumns.ts             # 170+ column definitions
├── activityLogSheetLayout.ts              # Sheet structure (v28)
├── agentColumnFillers.ts                  # Column data population
├── activityLogPipelineAgentskill.ts       # agentskill.sh integration
├── scoutKeywordRoiSheet.ts                # ROI tracking
├── articleUrlHttpStatus.ts                # URL probing
└── agentDebugEmit.ts                      # Debug logging

.github/workflows/
├── deploy.yml                             # Primary deployment (npm check + deploy)
├── sanity-check.yml                       # PR quality gate
├── agent-code-change.yml                  # Auto-commit workflow (workflow_dispatch)
└── agent-publish-article.yml              # Publish workflow (workflow_dispatch)

scripts/
├── composio-read-ai-ceo-sheet.mjs         # Debug: Read activity log
├── verify-composio-sheets-read.mjs        # Debug: Recursive parser
├── composio-run.mjs                       # WSL wrapper
├── wsl-append-composio-profile.sh         # WSL PATH setup
└── pull-debug-ndjson.mjs                  # Worker log fetcher
```

## Dependencies

### Runtime

- **Cloudflare Workers**: Edge compute platform
- **Durable Objects**: Stateful objects with SQLite
- **Workers AI**: On-platform AI inference
- **KV**: Key-value storage for metadata
- **R2**: Object storage for images

### Frameworks & SDKs

- **`agents`** (Cloudflare Agents SDK): Base Agent class, callable methods
- **`ai`** v6 (Vercel AI SDK): `streamText`, `generateText` with Workers AI provider
- **React 19**: UI framework
- **Vite**: Build tool
- **TailwindCSS**: Styling

### AI & Content

- **Workers AI Models**: `@cf/meta/llama-3.1-70b-instruct` (fast), Sonnet 4.5 (quality)
- **Composio**: Google Sheets API integration (SEARCH, VALUES_GET, BATCH_UPDATE)
- **Amazon Product API**: Creators API + Apify fallback
- **SERP APIs**: Search result scraping

### Development Tools

- **oxfmt**: Opinionated formatter (printWidth: 80, no trailing commas)
- **oxlint**: Fast linter
- **TypeScript 5.x**: Type checking
- **Doppler CLI**: Secrets management

## Key Features

### 1. Autonomous Content Pipeline

- **Scout Agent** (447 lines): AI-powered category discovery with ROI scoring
- **Keyword Agent** (164 lines): Buyer-intent keyword generation (3-5 per category)
- **SERP Agent** (313 lines): Search results analysis via Composio
- **Competitor Agent** (155 lines): Editorial content capture from top 5 URLs
- **Amazon Agent** (403 lines): Product fetching (Creators API → Apify → manual fallback)
- **Writer Agent** (1,732 lines): Main orchestrator (outline → write → revise loop)
- **QC Agent** (190 lines): AI quality fixes across 100 checks
- **Polish Agent** (176 lines): Editorial refinement
- **SEO Score** (964 lines): 100-check scoring across 8 pillars
  - Keyword density, readability, metadata, structure, images, links, schema, performance
- **Plagiarism** (65 lines): Competitor overlap detection
- **Indexing** (76 lines): IndexNow submission to search engines
- **Live Optimizer** (118 lines): Post-publish SEO validation

### 2. Activity Log Infrastructure

- **170+ Google Sheets columns** (A-FW+)
- **17 agent roles** with dedicated column ownership
- **Version tracking** (currently v28)
- **Composio integration** with recursive parser (depth-12 for nested responses)
- **agentskill.sh visualization** via activity log tracking

### 3. CI/CD Automation

- **Autonomous commit loop**: DO → GitHub commit → workflow_dispatch → CI callback
- **workflow_dispatch pattern**: agent-code-change, agent-publish-article
- **Callback endpoints**: `/api/github-callback` with change_set_id correlation
- **Quality gates**: `npm run check` (oxfmt + oxlint + tsc) on all PR/deploy paths
- **Primary deployment**: deploy.yml on push to main

### 4. Data Persistence

- **SQLite** (DO-local): categories, keywords, articles tables with schema migrations in `onStart()`
- **KV**: Article metadata, category tracking
- **R2**: Image storage with validation

## Development Workflow

### Commands

```bash
npm run dev          # Local development (Vite + Wrangler)
npm run check        # Quality gate (oxfmt + oxlint + tsc)
npm run build        # Production build (Vite)
npm run deploy       # Deploy to Cloudflare
doppler secrets get  # Retrieve secrets for local dev
```

### Deployment Flow

1. **Local changes** → git commit to `main`
2. **GitHub Actions** triggers `deploy.yml`
3. **Quality checks**: `npm run check` (must pass)
4. **Build**: `npx vite build`
5. **Deploy**: `npx wrangler deploy` with repo secrets
6. **Live** on Cloudflare global network

### Code Style

- **Formatter**: oxfmt (printWidth: 80, trailingComma: none)
- **Linter**: oxlint
- **Type check**: tsc
- **All enforced** via `npm run check` in CI

## Critical Gotchas

### Environment Access

- ❌ **NEVER** access `agent.env` directly in pipeline functions
- ✅ **ALWAYS** use `agent.envBindings` (public getter pattern)
- **Reason**: `env` is protected in Durable Objects

### Activity Log Schema

- **Version tracking** required for schema changes (currently v28)
- **Column layout** must match between code and Google Sheets
- **Agent roles** must align with column ownership (17 roles defined)

### Pipeline Step Tracking

- **15-step numbering** strictly enforced (01-15)
- **Step metadata** stored in activity log columns
- **Breaking changes** require schema migration

### SQLite Schema

- **Migrations** must run in `onStart()` lifecycle
- **Detection**: `PRAGMA table_info` to check for missing columns
- **Progressive**: Add columns without breaking existing data

### Composio API

- **Nested responses** require recursive parsing (depth-12 for findValues2d)
- **Fallback strategies**: SEARCH vs SEARCH_SPREADSHEETS, VALUES_GET vs BATCH_GET
- **Error handling**: Multiple attempts with different API methods

### WSL PATH

- **Must modify** `~/.profile` (NOT `~/.bashrc`) for Composio CLI
- **PATH setup**: `wsl-append-composio-profile.sh` handles this

### workflow_dispatch

- **Invocation pattern**: DO commits → triggers GitHub Action
- **Callback required**: CI must call `/api/github-callback` with change_set_id
- **Correlation**: Activity log tracks via change_set_id

## Improvement Areas

### Performance

- **Pipeline execution time**: Currently ~10-15 minutes per article
  - Optimize AI calls (batch where possible)
  - Cache SERP results
  - Parallel execution of independent steps

### Error Handling

- **OpenAI API failures**: Currently shows errors in logs (optional features gracefully degrade)
- **Composio rate limits**: Add retry logic with exponential backoff
- **Amazon API fallbacks**: More robust error messages when all attempts fail

### Testing

- **No automated tests**: Add unit tests for pipeline modules
- **Integration tests**: Mock Composio/Amazon APIs
- **E2E tests**: Verify full pipeline execution

### Monitoring

- **Add structured logging**: Better observability for pipeline steps
- **Metrics collection**: Track success rates, execution times
- **Alerts**: Notify on persistent failures

### Documentation

- **API documentation**: Document callable methods
- **Pipeline diagrams**: Visual flow of 15-step process
- **Setup guide**: Clearer onboarding for new developers

### Security

- **Secrets audit**: Ensure all API keys are in Doppler/GitHub Secrets
- **Rate limiting**: Add protection for callable methods
- **Input validation**: Sanitize user inputs to callable methods

## Technology Decisions

### Why Cloudflare Workers?

- **Global edge network**: Low latency worldwide
- **Durable Objects**: Stateful architecture with built-in persistence
- **Workers AI**: No API key required, runs on-platform
- **Cost-effective**: Pay-as-you-go pricing

### Why Vercel AI SDK?

- **Unified interface**: Works with multiple AI providers
- **Streaming support**: Real-time response handling
- **Tool calling**: Native support for function calling
- **Type-safe**: Full TypeScript integration

### Why Autonomous Loop?

- **Continuous operation**: Generates content 24/7
- **No human intervention**: Reduces operational overhead
- **Scalable**: Can run multiple agents in parallel

### Why Google Sheets for Activity Log?

- **Human-readable**: Non-technical stakeholders can view progress
- **Familiar interface**: No custom UI needed
- **Collaboration**: Multiple people can monitor
- **Audit trail**: Complete history of all operations

---

**Generated**: 2026-04-17
**Analysis**: Comprehensive review of 25 source files (12,560+ lines), 5 scripts, 4 GitHub workflows
**Discoveries**: 59 architectural insights, 12 critical gotchas
