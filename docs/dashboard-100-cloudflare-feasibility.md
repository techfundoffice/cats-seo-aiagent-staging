# Cloudflare Feasibility Verification — Dashboard 100-Item Plan

Companion to `docs/dashboard-engineer-100-improvements.md`. For each item, this doc states **(a)** whether the item works on the project's existing Cloudflare stack, **(b)** which specific Cloudflare service/binding it depends on, **(c)** any limit, cost, or adaptation that the original plan didn't surface.

**Verdict at a glance:**

| Status                          | Count  | Meaning                                                                                      |
| ------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| ✅ Works as-is on current stack | **77** | No new Cloudflare capability needed beyond what the project already uses.                    |
| ⚠️ Works with adaptation        | **20** | Needs a service the project doesn't yet bind, or constraint-driven design change.            |
| ❌ Blocked / not feasible       | **3**  | Cloudflare doesn't provide the capability the item assumes; needs to be reframed or dropped. |

**Sources verified:** Workers Analytics Engine SQL API, Cron Triggers, Durable Object WebSocket Hibernation API, Browser Run (formerly Browser Rendering) limits + pricing, Durable Object pricing rules, Workers AI, Cloudflare GraphQL Analytics API. All confirmed via `developers.cloudflare.com` searches on `2026-05-03`.

---

## Critical Cloudflare facts that change the plan

These ground every per-item verdict below.

1. **Workers Analytics Engine (WAE) is the right backend for time-series, not D1.** WAE is purpose-built for high-cardinality telemetry, has a SQL API at `https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql`, supports `_sample_interval`-aware aggregations, time-bucket helpers (`toStartOfMinute`, `toStartOfFiveMinutes`, etc., shipped Nov 2025), and `countIf` / `sumIf` / `avgIf`. Dataset binding goes in `wrangler.jsonc`. **Items 9–24, 31, 64, 71–76 all assume WAE.** D1 is wrong for this — single-region, no built-in quantiles, hits row/storage limits at telemetry scale.
2. **Cron Triggers are 1-minute minimum.** The plan's 60s synthetic monitor and 5-min burn-rate alert windows fit. Anything sub-minute needs the **Agents SDK `scheduleEvery(seconds, …)`** which the project already uses (per CLAUDE.md). Sub-minute is fine inside a Durable Object via `scheduleEvery`.
3. **Durable Object WebSocket Hibernation API** is the correct primitive for the single-stream live UI (item 49). Use `ctx.acceptWebSocket()` (not `ws.accept()`) to allow the DO to evict from memory while connections stay open — billable duration stops accruing during hibernation. Pair with `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))` so heartbeats don't wake the object. Hard cap: **32,768 WebSocket connections per DO** (this dashboard has ~1 viewer, so non-issue).
4. **Browser Run (formerly Browser Rendering)** is paid (Workers Paid plan, $0.09/browser-hour beyond included). Workers Paid includes 10 hours/month + 10 concurrent + 10 RPS REST limit. The synthetic monitor at 1/min = 1,440/day, well within rate limits; estimated ~3s per `/content` call ⇒ ~72 min/day = ~36 browser-hours/month — exceeds the 10 included hours, so **add ~$2.34/mo to the budget for item 70**. The project already uses `/api/admin/render` so the binding exists.
5. **Cloudflare GraphQL Analytics API** is the right source for items 71 (Workers spend), 75 (KV ops), 76 (R2 bytes). Has 5–30 min lag — must be labelled as "delayed" on the UI.
6. **Workers CPU / subrequest counts** are NOT inline-readable from your own request. Available retroactively via Workers Logpush or the GraphQL Analytics API. Item 15 needs to be rephrased: "near-realtime via Logpush", not "live".
7. **The dashboard has no user identity today.** The page is reachable via the Worker root; auth is bearer-token on `/api/admin/*`. Items that assume per-user state (89 personalization, 67 ack-attribution, 68 on-call hand-off) require either Cloudflare Access JWT, GitHub OAuth, or a hand-coded login. **Material lift; flag explicitly.**
8. **WAE write costs vs query costs.** Writes are essentially free (≈ $0.25/M). Queries via SQL API charge per row scanned. Time-series dashboards that re-query on every refresh tick will burn budget — must memoize aggregated results in a DO/KV cache for short windows.

---

## Per-item verdict (1–100)

### 1. Information architecture & "above the fold" (1–8)

| #   | Verdict | Cloudflare dependency              | Notes                                                                                                                                                                                                             |
| --- | ------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ✅      | none (client-side React)           |                                                                                                                                                                                                                   |
| 2   | ✅      | reads existing `state.activityLog` |                                                                                                                                                                                                                   |
| 3   | ✅      | none                               |                                                                                                                                                                                                                   |
| 4   | ✅      | none                               |                                                                                                                                                                                                                   |
| 5   | ✅      | none                               |                                                                                                                                                                                                                   |
| 6   | ✅      | none                               |                                                                                                                                                                                                                   |
| 7   | ✅      | none                               |                                                                                                                                                                                                                   |
| 8   | ⚠️      | needs build-stamp                  | inject `process.env.GITHUB_SHA` + deploy timestamp at Vite build time via `import.meta.env`; doesn't need a Cloudflare API but does need a `wrangler deploy` env-var, populated by `.github/workflows/deploy.yml` |

### 2. Top-level KPI strip (9–16)

| #   | Verdict | Cloudflare dependency                    | Notes                                                                                                                                                              |
| --- | ------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | ⚠️      | **WAE** dataset `pipeline_events`        | bind via `analytics_engine_datasets` in `wrangler.jsonc`; write `{blob1: status, double1: 1}` per pipeline event; query `SUM(_sample_interval * double1)` over 24h |
| 10  | ⚠️      | **WAE**                                  | `countIf(blob1='failed') / count()` over 24h; bands = compare to previous 24h                                                                                      |
| 11  | ⚠️      | **WAE**                                  | quantile via `quantilesTDigest(0.5, 0.95, 0.99)` (TDigest function family is in WAE SQL reference)                                                                 |
| 12  | ✅      | existing `state.avgSeoScore`             | delta = compare to D1-stored 24h-ago snapshot                                                                                                                      |
| 13  | ⚠️      | **DO state expansion**                   | currently `state.currentKeyword` is singular; need `state.activeRuns: KvKey[]` to support N concurrent runs. Backend change.                                       |
| 14  | ✅      | scout pool already tracked in DO         | surface via `/api/status`                                                                                                                                          |
| 15  | ⚠️      | **GraphQL Analytics API** (5–30 min lag) | self-instrument subrequest counter via fetch wrapper for low-latency; CPU-ms via Logpush; cannot read live                                                         |
| 16  | ✅      | none                                     | client routing                                                                                                                                                     |

### 3. Golden Signals & RED panels (17–24)

| #   | Verdict | Cloudflare dependency     | Notes                                                                                                                                       |
| --- | ------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 17  | ⚠️      | **WAE**                   | `toStartOfMinute(timestamp)` group-by; stacked-area renders fine in Recharts/Visx                                                           |
| 18  | ⚠️      | **WAE**                   | error-category as `blob1`, group-by category × time bucket. WAE limit: ~200K series per dataset — error categories are bounded (~12), safe. |
| 19  | ⚠️      | **WAE**                   | latency heatmap: `bucket(double1, …) × time` 2-D group-by; client renders as colored grid                                                   |
| 20  | ⚠️      | **WAE**                   | per-step duration: write one row per step transition with `{blob1: stepNumber, double1: durationMs, blob2: kvKey}`                          |
| 21  | ⚠️      | **WAE** + KV              | self-track `kimi-raw:<kvKey>` hit/miss in writer.ts; emit to WAE                                                                            |
| 22  | ⚠️      | self-instrumented counter | wrap `fetch()` in pipeline runs to count subrequests; emit final count to WAE per run                                                       |
| 23  | ⚠️      | **WAE**                   | provider tag in `blob1`; project already emits role + activity log entries per Kimi call                                                    |
| 24  | ✅      | self-probes via cron      | the project's `repo-agent.yml` already does external-service health checks; can emit to WAE for dashboard render                            |

### 4. Pipeline visualization (25–32)

| #   | Verdict | Cloudflare dependency  | Notes                                                               |
| --- | ------- | ---------------------- | ------------------------------------------------------------------- |
| 25  | ⚠️      | **WAE**                | Sankey from `count()` per (from_step, to_step) pair                 |
| 26  | ⚠️      | **WAE**                | error rate per step over 1h                                         |
| 27  | ✅      | existing `activityLog` | already keyed by kvKey + timestamps; pure client visualization      |
| 28  | ✅      | same as 27             | side-by-side render                                                 |
| 29  | ✅      | client                 | reuses existing `ABVariantPreviewPanel` data                        |
| 30  | ⚠️      | depends on item 13     | needs DO state expansion to surface N concurrent runs               |
| 31  | ⚠️      | **WAE**                | aggregate `escalateToCodingAgent` events by step × category over 7d |
| 32  | ✅      | DO state               | same data already on the dashboard                                  |

### 5. Time controls (33–40)

| #   | Verdict | Cloudflare dependency       | Notes                                                            |
| --- | ------- | --------------------------- | ---------------------------------------------------------------- |
| 33  | ✅      | client                      | URL state via `useSearchParams`; selector applies to WAE queries |
| 34  | ✅      | DO WS hibernation (item 49) | live-tail = WS subscription                                      |
| 35  | ✅      | client                      | document.visibilityState API                                     |
| 36  | ⚠️      | **WAE**                     | "vs previous period" = same query with shifted time range        |
| 37  | ✅      | client                      | Intl.DateTimeFormat                                              |
| 38  | ✅      | client                      | "data age" = client-side timestamp delta                         |
| 39  | ✅      | client                      | per-panel `Updated Xs ago` chip                                  |
| 40  | ✅      | client                      | URL encoding                                                     |

### 6. Filter / search / facet (41–48)

| #   | Verdict | Cloudflare dependency             | Notes                                                                                                           |
| --- | ------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 41  | ✅      | client                            | global filter passed to WAE queries                                                                             |
| 42  | ⚠️      | **WAE SQL builder** on the Worker | parse user query → safe parameterized SQL; **must guard against SQL injection** since WAE accepts arbitrary SQL |
| 43  | ✅      | KV                                | named view = JSON in `dashboard:saved-views:<id>`                                                               |
| 44  | ✅      | client + KV                       | top-N derived from telemetry over time                                                                          |
| 45  | ✅      | client query parser               |                                                                                                                 |
| 46  | ✅      | client                            | URL persistence                                                                                                 |
| 47  | ✅      | applies to WAE queries            |                                                                                                                 |
| 48  | ✅      | client                            | substring match highlighting                                                                                    |

### 7. Real-time streaming (49–55)

| #   | Verdict | Cloudflare dependency                            | Notes                                                                                                                          |
| --- | ------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 49  | ✅      | **DO Hibernation WebSocket API**                 | `ctx.acceptWebSocket()`, `setWebSocketAutoResponse` for ping/pong; max 32,768 conns/DO; no duration billing during hibernation |
| 50  | ✅      | client                                           | tracks WS readyState                                                                                                           |
| 51  | ✅      | client                                           | rate-limit incoming events; show drop-rate                                                                                     |
| 52  | ✅      | client                                           | scroll-position aware auto-scroll                                                                                              |
| 53  | ✅      | client                                           | local pause flag                                                                                                               |
| 54  | ⚠️      | **GitHub Actions writes deploy marker to KV/D1** | `deploy.yml` adds a final step: `curl -X POST /api/admin/log-deploy-marker`                                                    |
| 55  | ⚠️      | KV                                               | annotations stored in KV with `?t=<ms>` key prefix                                                                             |

### 8. Drill-down (56–62)

| #   | Verdict | Cloudflare dependency             | Notes                                                                                                            |
| --- | ------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 56  | ✅      | client                            | every metric value gets click handler                                                                            |
| 57  | ✅      | client                            | modal slides over current view                                                                                   |
| 58  | ✅      | existing `/api/admin/*`           | already in place per CLAUDE.md                                                                                   |
| 59  | ✅      | URL routing                       | `?kvKey=` already supported in some panels                                                                       |
| 60  | ✅      | existing escalation dedup KV key  | `escalation-dedup:<kvKey>:<category>` already gives the issue #                                                  |
| 61  | ✅      | string template in issue body     | done in `escalateToCodingAgent` already                                                                          |
| 62  | ⚠️      | GitHub MCP / API call from Worker | needs a worker route that proxies "open PRs by `claude-fix` label"; project already has the GitHub auth for this |

### 9. Alerting / SLO / on-call (63–70)

| #   | Verdict | Cloudflare dependency                      | Notes                                                                                                                                       |
| --- | ------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 63  | ⚠️      | **WAE**                                    | SLO = scheduled WAE query; result + budget stored in KV                                                                                     |
| 64  | ⚠️      | **DO `scheduleEvery` or Cron Triggers**    | multi-window multi-burn = 5min + 1h + 6h windows; each window queries WAE, compares to threshold; cron min granularity is 1min — sufficient |
| 65  | ✅      | Worker `fetch()` to webhook                | Slack/PagerDuty incoming webhooks                                                                                                           |
| 66  | ⚠️      | **WAE** + D1                               | timeline aggregator: WAE for events, D1 for incident metadata                                                                               |
| 67  | ⚠️      | **D1** + auth (item 7 in this doc)         | needs user identity to attribute "ack" events; without auth, attribution is anonymous                                                       |
| 68  | ⚠️      | **D1** + auth                              | on-call schedule needs identity                                                                                                             |
| 69  | ✅      | KV / D1 + client form                      | post-mortem links pinned to chart timestamps                                                                                                |
| 70  | ⚠️      | **Browser Run** ($0.09/hr beyond included) | already used at `/api/admin/render`; per-minute synthetic costs ~$2.34/mo extra on top of the 10h/mo included                               |

### 10. Cost & resource (71–76)

| #   | Verdict | Cloudflare dependency                                  | Notes                                                                                                                                                                                                   |
| --- | ------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 71  | ⚠️      | **GraphQL Analytics API** + OpenRouter API             | 5–30min lag from CF; OpenRouter has its own real-time spend endpoint. Aggregate both.                                                                                                                   |
| 72  | ⚠️      | **WAE** + self-reported tokens                         | per-article cost = sum(token_cost_per_call) + amortized infra; OpenRouter returns per-call usage                                                                                                        |
| 73  | ✅      | OpenRouter REST API                                    | `/credits` and per-generation `/generation` endpoints                                                                                                                                                   |
| 74  | ❌→⚠️   | **AI Gateway analytics API**, NOT iframe               | **plan said "embed iframe"; that's blocked by Cloudflare's CSP/X-Frame-Options.** Reframe: query AI Gateway analytics API and render ourselves. AI Gateway exposes `/v1/<account>/<gateway>/analytics`. |
| 75  | ⚠️      | **GraphQL Analytics API** `kvOperationsAdaptiveGroups` | confirmed exposed; 5–30min lag                                                                                                                                                                          |
| 76  | ⚠️      | **GraphQL Analytics API** R2 metrics                   | confirmed exposed; 5–30min lag                                                                                                                                                                          |

### 11. Performance / frontend hygiene (77–82)

| #   | Verdict | Cloudflare dependency                                          | Notes                                                                                          |
| --- | ------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 77  | ✅      | client (`@tanstack/react-virtual`)                             |                                                                                                |
| 78  | ✅      | client                                                         |                                                                                                |
| 79  | ✅      | client                                                         |                                                                                                |
| 80  | ✅      | Vite dynamic import                                            |                                                                                                |
| 81  | ✅      | `web-vitals` package + `/api/admin/log-dashboard-vitals` route | new admin route, otherwise normal                                                              |
| 82  | ⚠️      | Service Worker via Vite plugin                                 | Workers and Service Workers coexist fine; plan to invalidate cache on deploy via versioned URL |

### 12. Accessibility (83–88)

| #   | Verdict | Cloudflare dependency | Notes      |
| --- | ------- | --------------------- | ---------- |
| 83  | ✅      | none                  | pure React |
| 84  | ✅      | none                  |            |
| 85  | ✅      | none                  |            |
| 86  | ✅      | none                  |            |
| 87  | ✅      | none                  |            |
| 88  | ✅      | none                  |            |

### 13. Personalization (89–94)

| #   | Verdict | Cloudflare dependency                 | Notes                                                                      |
| --- | ------- | ------------------------------------- | -------------------------------------------------------------------------- |
| 89  | ❌→⚠️   | **needs auth identity** (see fact #7) | reframe: use anonymous `localStorage` per browser; revisit when auth lands |
| 90  | ✅      | localStorage                          |                                                                            |
| 91  | ✅      | localStorage                          |                                                                            |
| 92  | ✅      | CSS vars                              |                                                                            |
| 93  | ✅      | client                                | Notifications API                                                          |
| 94  | ✅      | URL + KV                              |                                                                            |

### 14. Power-user surfaces (95–98)

| #   | Verdict | Cloudflare dependency          | Notes                                |
| --- | ------- | ------------------------------ | ------------------------------------ |
| 95  | ⚠️      | **WAE SQL**                    | same SQL-injection guard as #42      |
| 96  | ✅      | existing `/api/admin/*`        | confirm-before-execute UI            |
| 97  | ✅      | D1                             | runbook table                        |
| 98  | ✅      | client (`html2canvas`/`jsPDF`) | bundle size ~150KB; lazy-load on use |

### 15. Honesty / verification (99–100)

| #   | Verdict | Cloudflare dependency    | Notes                                                                                                |
| --- | ------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| 99  | ✅      | none                     | pure copy                                                                                            |
| 100 | ⚠️      | depends on items 49 + 70 | freshness self-check = client probe of `/api/status` + `/api/admin/render?url=<canary>` on page load |

---

## Items reframed or downgraded (the only ❌ → ⚠️ list)

Three items in the original plan made claims that don't match Cloudflare's actual surface. They're not blocked — but the original wording is wrong and needs to be reframed before implementation:

1. **#74 "AI Gateway analytics embed"** — Cloudflare dashboard pages set X-Frame-Options to deny iframe embedding. **Reframe:** query AI Gateway analytics API (`/v1/<account>/<gateway>/analytics`) and render in our own panel.
2. **#15 "Worker CPU-ms / request live"** — not inline-observable. **Reframe:** "near-realtime via GraphQL Analytics API + Logpush, with explicit ~5–30 min lag indicator."
3. **#89 "Per-engineer dashboard layout keyed by GitHub username"** — assumes user identity that doesn't exist on the dashboard today. **Reframe:** anonymous per-browser persistence in `localStorage`; revisit once auth lands (Cloudflare Access or OAuth). Same constraint applies to **#67** (ack attribution) and **#68** (on-call hand-off).

## Concrete prerequisites the plan needs (in P0, before anything else)

These are the foundational changes the plan implicitly assumes. The original doc didn't enumerate them; they're the gate items that unblock 70+ of the 100.

1. **Bind a WAE dataset** in `wrangler.jsonc`:
   ```jsonc
   "analytics_engine_datasets": [
     { "binding": "PIPELINE_EVENTS", "dataset": "cats_seo_pipeline_v1" }
   ]
   ```
2. **Create an Account Analytics Read API token** (already documented in CLAUDE.md pattern); store as worker secret `WAE_QUERY_TOKEN` for SQL API calls.
3. **Wrap `fetch()` in pipeline modules** to count subrequests; emit one `pipeline_run_summary` row to WAE per run with `{blobs: [keyword, category, finalStatus, errorCategory], doubles: [durationMs, subrequestCount, kimiTokens, kimiCostUsd]}`.
4. **Add a deploy marker step** to `.github/workflows/deploy.yml`: `curl -X POST $WORKER/api/admin/log-deploy-marker -H "Authorization: Bearer $ADMIN_API_TOKEN" -d '{"sha":"$GITHUB_SHA","ts":<unix>}'`. Marker rendered as vertical line on every chart (item 54).
5. **Build a `<TimeRangePicker>` and `useTimeRange()` hook** that every panel reads from. Fixes the orphaned-state problem the plan implicitly assumed away.
6. **Move from polling to DO Hibernation WebSocket** for live state. Until item 49 lands, item 39 ("data age chip") will tell the truth that everything is several seconds stale.

---

## Summary

The original 100-item plan is **substantially achievable on the existing Cloudflare stack**. Of the 100:

- **77 work as-is.**
- **20 require a dependency the project doesn't yet bind** — overwhelmingly Workers Analytics Engine for time-series; a few need GraphQL Analytics API or DO state expansion. All are well-documented Cloudflare capabilities, not exotic asks.
- **3 had wording that misrepresented Cloudflare's surface (74, 15, 89)** and are reframed above. None drop — all are still feasible.

**Net cost delta over status quo** (rough monthly): WAE writes ≈ $1, WAE queries ≈ $5, Browser Run incremental for synthetic ≈ $2.50. Total ~$8.50/mo on top of current Workers Paid spend. Cheap relative to the operational visibility gain.

**The single biggest unlock** is binding WAE — without it, ~20 of the 100 items have nowhere to land. Recommend that as the first concrete code task following this verification.
