# Engineer's Dashboard — 100 Improvements (Enterprise Monitoring Best Practices)

**Target:** the live dashboard rendered by `src/app.tsx` (Cloudflare Worker, React 19), used by engineers to monitor the autonomous SEO article pipeline at `cats-seo-aiagent`.

**Audience:** the engineer staring at this dashboard during an incident, or watching pipeline health over a deploy window. **Not** marketing/content stakeholders — that's a separate concern.

**Reference frameworks:** Google SRE Golden Signals (Latency / Traffic / Errors / Saturation), RED method (Rate / Errors / Duration), USE method (Utilization / Saturation / Errors), Stephen Few's _Information Dashboard Design_, Nielsen Norman Group enterprise UX guidelines, Datadog / Grafana / Honeycomb patterns, OpenTelemetry observability pillars (metrics / logs / traces). Each item is tagged with the heuristic that justifies it.

**Today's baseline (what's already on the dashboard, grounded in the code):**

State fields read: `state.{activityLog, articlesFailed, articlesGenerated, avgSeoScore, categoriesCompleted, currentKeyword, currentStep, sheetBridgeLog, status, googleSheetUrl, recentGoogleSheets}`. Panels: `AuditPanel`, `PipelineDiagrams`, `GithubRepoAgentPanel`, `CodingAgentPanel`, `TextEditorAgentPanel`, `EditorialAgentPanel`, `N8nAgentPanel`, `ABVariantPreviewPanel`, the new `LevelLogPanel` (Errors + Warnings, commit `49aa6f6`), the main Activity Log, and the Shared Google Sheet card. Admin surface: `/api/status`, `/api/admin/{logs,recent-failures,kv/<k>,kimi-raw/<k>,render,retry}` (bearer-gated).

**Gap pattern (what's missing):** zero time-series visualization, zero rates / per-minute throughput, no SLOs, no histograms, no traces, no end-to-end latency view per article, no resource-usage / cost panel, no "what changed?" deploy markers, no synthetic / canary surface, no on-call hand-off view, no annotations, no notebooks. The dashboard today shows _current state and recent events_, not _how the system is behaving over time_.

---

## 1. Information architecture & "above the fold" (1–8)

1. **Establish a 3-tier vertical hierarchy**: row 1 = SLO health + kill-switch + status banner; row 2 = pipeline-stage strip with live counters; row 3 = drill-down panels. Today every panel is a sibling `<details>` element — the eye lands nowhere first. _[Stephen Few: visual hierarchy]_
2. **Pin the most-broken thing to the top.** When `articlesFailed > 0` in the last 5 min, hoist a red banner above everything else with the failing keyword + "Open recent failures" CTA. _[NN/g: progressive disclosure inverted for incidents]_
3. **Adopt a 12-column grid** so panels can have meaningful sizes (KPIs = 3 cols, time-series = 6, log = 12). The current full-width-stack layout wastes 1440px+ viewports. _[Stephen Few: density]_
4. **Move the Shared Google Sheet card to a "Integrations" tab** — it's reference data, not an operational surface, and currently sits between live agent panels. _[NN/g: content priority]_
5. **Replace the global page scroll with a sticky filter/time-range header + scrollable panel area.** Operators currently lose the time selector when they scroll to a panel.
6. **Right rail for ephemeral details** — when a row is clicked, open its details in a 480px slide-over rather than expanding inline. Keeps the overview stable. _[Datadog pattern]_
7. **Cap dashboard width at 1920px**, center on ultrawide. Beyond that, line lengths and chart aspect ratios stop helping comprehension. _[Refactoring UI]_
8. **Add a visible page title + version** ("cats-seo-aiagent · build `<short-sha>` · deployed `<timestamp>`"). Today the dashboard is anonymous — engineers can't tell which build they're looking at without DevTools. _[Datadog/Grafana convention]_

## 2. Top-level KPI strip ("hero" metrics) (9–16)

9. **Articles published last 24h** (large numeral, sparkline below). _[RED: Rate]_
10. **Failure rate last 24h** (% with 99% / 95% bands). Currently `articlesFailed` is a raw counter with no denominator. _[RED: Errors]_
11. **P50 / P95 / P99 end-to-end pipeline latency** for the last 1h, computed from `activityLog` step-1 → step-26 timestamps. _[RED: Duration; SRE Golden: Latency]_
12. **Current `avgSeoScore`** with delta vs 24h ago — green if up, red if down ≥ 2 points. _[Quality KPI]_
13. **Active runs right now** — count of distinct `currentKeyword`s being processed, not just one. _[SRE Golden: Traffic]_
14. **Queue depth** — pending keywords in the scout pool. Today there's no surface for "is the system catching up or falling behind?" _[USE: Saturation]_
15. **Worker CPU-ms / request** rolled up across the last 1h, and **subrequests per pipeline run** — Cloudflare's hard ceilings (50ms CPU on free, 50 subrequests) bite silently. _[USE: Utilization]_
16. **Each KPI tile is a link** to a page filtered to that metric's underlying data. No dead metrics. _[NN/g: every visual is a starting point]_

## 3. Golden Signals & RED method panels (17–24)

17. **Time-series chart of pipeline rate** (articles started / completed / published per minute) — stacked area. _[RED: Rate]_
18. **Error-rate time-series** by category (kimi-parse-error, fingerprint-mismatch, gtm-missing, post-publish-live-leak, sheets-timeout, etc.) — distinct lines, color-coded. _[RED: Errors, dimensional breakdown]_
19. **Latency distribution heatmap** — duration buckets on Y axis, time on X axis, cell color = count. Reveals bimodal / tail behavior pure averages hide. _[Honeycomb / Datadog histogram pattern]_
20. **Per-step duration breakdown** stacked bar per published article (Step 1 SERP, Step 9 Writer, Step 11 Audit, Step 14 Publish, …). Today the AuditPanel shows the _result_ but not the _time spent per stage_. _[Tracing: critical path visualization]_
21. **Cache-hit ratio panel for Kimi raw KV** — `kimi-raw:<kvKey>` 48h TTL hits vs misses on retries. _[USE]_
22. **Subrequest-budget meter** per pipeline run, plotted as a histogram so engineers see how close runs are to the 50-subrequest Workers limit. _[USE: Saturation]_
23. **Workers AI invocation count** by model (kimi-k2-5 via OpenRouter vs Workers AI fallback) with per-model error rate. Diagnoses "which provider is sad right now?" _[Multi-tier provider observability]_
24. **External-service health strip** — D1, KV, R2, Workers AI, OpenRouter, Composio, Firecrawl, DataForSEO, BrightData, Google Sheets. Each is a colored dot with last-check timestamp. _[Status-page convention]_

## 4. Pipeline visualization upgrades (25–32)

25. **Live Sankey diagram** of the 26-step pipeline showing how many articles are at each step right now and the historical drop-off rate per step. The current `PipelineDiagrams` is a static Mermaid render. _[Datadog APM service map]_
26. **Step heat-bar** along the top of the page: 26 cells colored by error-rate at that step over the last hour. One glance → "Step 14 publish is the broken stage today."
27. **Per-keyword timeline** — click any keyword in the activity log → opens a horizontal swim-lane showing every step that ran for that keyword, with timestamps and outcomes. _[Trace view; OpenTelemetry waterfall]_
28. **Compare-runs view** — pick keyword A and keyword B, get a side-by-side step-by-step diff of timings and outcomes. Diagnoses "why is this category 3x slower?" _[Datadog APM compare]_
29. **Show the variant-B (editorial) run inline with the original** rather than only via the existing AB Preview panel — the temporal relationship matters for diagnosing whether the editorial pass is slow or fast.
30. **Animated marker on the diagram showing the actively-running step** for each in-flight keyword (don't just label `state.currentStep` once — there can be N concurrent runs).
31. **Step-failure flame graph** — for each error category from `escalateToCodingAgent`, show which steps it most often fires from over the last 7d. Drives "what should we fix next?"
32. **Show pipeline depth** (running ⇒ queued ⇒ completed counts) as a vertical capacity bar — operators understand bar-meters intuitively. _[Stephen Few: bullet chart]_

## 5. Time controls (33–40)

33. **Global time-range selector** (Last 5m / 15m / 1h / 6h / 24h / 7d / 30d / custom) that every panel respects. Today every panel has its own implicit window or none. _[Datadog/Grafana convention; non-negotiable]_
34. **Live-tail toggle** in the time selector — when on, the window auto-scrolls to "now" and panels stream new data; when off, the view is frozen for analysis. _[N3: User control]_
35. **Refresh-rate selector** (off / 5s / 15s / 30s / 1m). Auto-throttle to 1m when the tab is hidden. _[Performance / battery]_
36. **Compare-against** ("vs previous period" / "vs same time last week") with a faded line overlay. Surfaces regressions that 24h-only views miss. _[Grafana convention]_
37. **Timezone toggle** UTC ↔ local — ops teams span timezones; hard-coding one breaks half of them. Persist in `localStorage`.
38. **Dim panels whose data window is older than the global selector** — operators can tell at a glance which panels haven't refreshed.
39. **Show "data age"** on every panel (chip in the top-right with `Updated 3s ago`). Stale panels masquerade as live ones today.
40. **URL-encode the time range** (`?t=15m`) so a teammate can be sent the exact view. _[Schneiderman: support locus of control]_

## 6. Filtering, search, faceting (41–48)

41. **Global filter bar** at the page top: keyword, category, role, level, kvKey, error-category. Applies to every panel. _[NN/g enterprise pattern]_
42. **Faceted search** — typing `keyword:"litter robot"` filters everything, including the pipeline diagram counts. _[Honeycomb-style query bar]_
43. **Save-as-view** — name a filter+time combo ("yesterday's failures", "n8n only") and recall from a dropdown. _[Datadog dashboards]_
44. **Quick-filter chips** for the top 5 most-clicked categories, materialized from telemetry over time.
45. **Inverted filter** (`-role:editorialAgent`) so engineers can hide noisy roles during incidents.
46. **Filter persistence in URL** so sharing a link shares the investigation context.
47. **Filter activity log AND the time-series charts simultaneously** — today filters only apply to logs. _[Cross-panel filtering]_
48. **"Why did this row appear?"** — when a substring match highlights a row, expose the matched term in a small chip beside the row.

## 7. Real-time / streaming (49–55)

49. **Single websocket / SSE source** for live state, replacing whatever polling is in use. One connection feeds every panel. _[Performance]_
50. **Connection-state ribbon** at the top — green (connected), amber (reconnecting, last ping age), red (disconnected, manual refresh required). _[NN/g visibility]_
51. **Backpressure indicator** — when the client is dropping incoming events (>20/s), show a yellow warning chip. Better an honest "you're behind" than silently stale UI.
52. **Don't auto-scroll the activity log when the user has scrolled away from the head.** Show a sticky "↓ N new entries — scroll to latest" pill instead. _[N3]_
53. **Pause / resume stream** controls so an operator can freeze the view during analysis.
54. **Last-deploy / last-restart marker** as a vertical line on every time-series panel (deploys are the single biggest source of "what changed?" answers). Source: GitHub Actions deploy.yml run timestamps. _[Datadog/Grafana annotations]_
55. **Manual annotation** — operator can drag-select a time range and write a note ("BrightData throttling started here"). Notes persist to KV, render on every chart. _[Honeycomb annotations]_

## 8. Drill-down & navigation (56–62)

56. **Every numeric value is clickable** and opens the underlying entries (Stephen Few's "every datapoint is a query"). The current dashboard has many dead-end numbers.
57. **Right-click a row → Investigate** — opens a modal trace view scoped to that keyword's run.
58. **Open KV / Open Kimi raw / Open render / Retry** buttons inline on every error row, hitting the existing `/api/admin/*` endpoints. The runbook stops being a Markdown doc and becomes one click.
59. **kvKey is a permalink** — `?kvKey=<id>` deep-links to the article's run timeline.
60. **Cross-link to the auto-generated GitHub issue** (`escalateToCodingAgent` writes a dedup key — use it). One-click jump from log row to its `claude-fix` issue.
61. **Cross-link from issues back to the dashboard** — the issue runbook should embed a `?kvKey=` URL so Copilot lands on the right view automatically.
62. **Linked PR badges** on rows whose error-category has an active fix-PR. Operators see "we know about this, fix is in flight."

## 9. Alerting, SLOs, incident response (63–70)

63. **Define explicit SLOs** and surface them: "Article success rate ≥ 95% over rolling 1h", "P95 pipeline duration ≤ 6 min", "Editorial-agent rewrite latency ≤ 2 min". Each SLO panel shows current value, error budget remaining, and burn rate. _[SRE workbook]_
64. **Burn-rate alerts** (multi-window multi-burn-rate per the SRE workbook) — fast burn fires within 5 min, slow burn within 6h. Today there's no alerting story at all.
65. **PagerDuty / Slack webhook** integration triggered by SLO breaches; show the active page on the dashboard so the on-call doesn't miss it. _[PagerDuty integration]_
66. **Incident timeline panel** — when an SLO is breached, automatically aggregate every relevant log line, deploy, secret rotation, and external-service blip into one chronological timeline.
67. **"Acknowledge" / "Snooze" / "Resolve"** buttons on alerts; record who clicked when, persist to D1.
68. **On-call hand-off card** at the top — current on-call name, contact, last 4h summary in 5 bullets. Critical for shift changes.
69. **Post-incident annotation form** — when an incident closes, prompt the operator for a 1-line cause + link to the post-mortem; pin to the timestamp on every chart for 30 days.
70. **Synthetic monitor** — `/api/admin/render?url=https://catsluvus.com/<canary-slug>` runs every 60s; show pass/fail history as a row of green/red dots. Detects "publish broke production" before users do. _[Pingdom/UptimeRobot pattern]_

## 10. Cost & resource observability (71–76)

71. **Cumulative spend today** (Workers requests, AI tokens, KV operations, R2 storage, OpenRouter spend) with a daily-budget meter. _[FinOps]_
72. **Per-article cost** (median, P95) trending — surfaces "we've gotten 3x more expensive per article this week" before the bill arrives.
73. **OpenRouter token usage** breakdown by model, per pipeline step. Identifies which step is the cost driver.
74. **Cloudflare AI Gateway analytics embed** if available, otherwise scrape the dashboard's own provider-usage events.
75. **KV read/write ops counter** with a small spark — shows hot keys, cache thrash.
76. **R2 stored bytes** trend (article HTML accumulates). Shows whether retention/cleanup jobs are needed.

## 11. Performance & frontend hygiene (77–82)

77. **Virtualize every long list** (`@tanstack/react-virtual`) — log, recent failures, sheet bridge log. Cap DOM at ~50 visible rows per panel.
78. **Memoize all panels** with `React.memo` keyed on the slice of state they read; today every panel re-renders on every state tick.
79. **Selector hooks** — `useActivityLogSlice(filter)` instead of every panel cloning `state.activityLog` and re-filtering. _[Redux toolkit pattern, applies to AgentSDK state too]_
80. **Code-split panels** that are below the fold — `<PipelineDiagrams>` ships Mermaid (~600KB); lazy-load on `<details open>`.
81. **Web-vitals telemetry on the dashboard itself** (LCP, INP, CLS) and post to `/api/admin/log-dashboard-vitals` — engineers feel the slow dashboard but no one's measuring it.
82. **Service Worker cache** for the dashboard shell so post-deploy reloads aren't ~2s of white screen.

## 12. Accessibility (WCAG 2.2 AA) (83–88)

83. **Keyboard-only navigation through every panel** — Tab between panels, arrow keys within. Today most interactive elements are reachable but no panel-level navigation exists. _[WCAG 2.1.1]_
84. **Skip-links** for "Skip to KPIs / pipeline / activity log / errors". _[WCAG 2.4.1]_
85. **Color-blind safe palettes** — never red/green alone for status; pair with shape or text. The current "red text = error" pattern fails ~8% of male users. _[WCAG 1.4.1]_
86. **Focus rings ≥ 3:1 contrast against every background**, ideally a 2px outline + 1px offset. _[WCAG 2.4.7]_
87. **Page-level landmarks** (`<main>`, `<aside>`, `<nav>`) so AT users can skip whole sections.
88. **Announce SLO breaches via a single high-priority `aria-live="assertive"` region** that speaks once per breach and not per re-render.

## 13. Personalization & state persistence (89–94)

89. **Per-engineer dashboard layout** — drag panels to rearrange, persist in `localStorage` keyed by GitHub username (read from Composio whoami).
90. **Show / hide panels** — checkbox menu so the n8n panel is hidden for engineers who don't own that integration. _[Reduce noise]_
91. **Density toggle** (compact / comfortable / spacious) global, applies to every panel.
92. **Theme** — light / dark / system. The dashboard is hardcoded to white today, painful at 2 a.m.
93. **Notification preferences** — choose which events trigger a browser-tab badge / desktop notification (deploys, errors, SLO breaches).
94. **Saved views** at the URL level (#34) PLUS at the user level — a named view = filter + time + layout + density.

## 14. Operations / power-user surfaces (95–98)

95. **In-dashboard query bar** — type `level:error AND keyword:litter` and see results across logs and time-series simultaneously. _[Honeycomb / Splunk]_
96. **Shell drawer** (Ctrl+`) that exposes safe `/api/admin/\*` operations as commands ("retry keyword X", "purge KV for kvKey Y") without leaving the page. Confirm-before-execute for destructive ops.
97. **Notebook surface** — pin a chart + a query + a markdown note as a runbook entry, persistable per incident category.
98. **Export current view as PNG / PDF** for incident reports — most enterprise dashboards lack this and SREs end up taking phone screenshots.

## 15. Honesty / verification (99–100)

99. **"What this dashboard does NOT show" footer.** Be explicit about gaps: "This dashboard tails KV-published articles only — articles still in flight in the DO queue are not represented. P95 latency is computed on completed runs only and excludes timeouts." _[Stephen Few: integrity]_
100. **End-to-end synthetic + a "freshness self-check"** that fires on every page load, hits `/api/status`, hits `/api/admin/render?url=<canary>`, and reports pass/fail at the bottom of the page. If the dashboard is showing stale or wrong data, **the dashboard itself should be the first to say so**. _[Honesty Rule, CLAUDE.md]_

---

## Suggested rollout (6 phases)

| Phase  | Theme                                     | Items                    | Why this order                                                                                                        |
| ------ | ----------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **P0** | Time-range + KPI strip + connection state | 9–16, 33, 35, 38, 39, 50 | Without a global time selector and visible freshness, every other improvement is built on sand.                       |
| **P1** | Golden signals & error breakdown          | 17–24, 63, 64, 70        | Engineers can't run the system without latency, error rate, traffic, and saturation. SLOs + synthetic close the loop. |
| **P2** | Drill-down + linked context               | 56–62, 27, 28            | Turns "I see a problem" into "I'm investigating it" without leaving the page.                                         |
| **P3** | Filtering / faceting / saved views        | 41–48, 89, 94            | Once data is rich, navigation is the bottleneck.                                                                      |
| **P4** | Cost + perf + a11y                        | 71–82, 83–88             | The dashboard becomes a tool you can leave open all day without melting your laptop or excluding teammates.           |
| **P5** | Notebooks + alerting / hand-off           | 65–69, 95–100            | Higher-order workflows. Enables on-call rotation, post-mortems, and runbook reuse.                                    |

## Heuristic coverage check

- **Google SRE Golden Signals:** items 9–24 cover Latency / Traffic / Errors / Saturation directly.
- **RED method:** items 9, 10, 11, 17, 18, 19 explicitly tagged.
- **USE method:** items 14, 15, 21, 22, 75 explicitly tagged.
- **Stephen Few:** density (3, 8), integrity (99), every-datapoint-is-a-query (56).
- **Honeycomb observability:** 19, 27, 42, 55, 95.
- **NN/g enterprise:** 1, 4, 16, 41, 50.
- **WCAG 2.2 AA:** 83–88 directly; 47, 53, 88 reinforce.
- **PagerDuty / on-call discipline:** 65, 66, 67, 68, 69.

## Out of scope (deferred)

- Multi-tenant isolation (only one operator runs catsluvus).
- Mobile-optimized engineer dashboard (operators use laptops; phone is for paging only).
- Full audit log / RBAC (single-engineer environment).
- AI-driven anomaly detection on KPIs — until histograms exist (#19), anomaly detection has nothing to consume.
