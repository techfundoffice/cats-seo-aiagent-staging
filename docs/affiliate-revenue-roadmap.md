# Affiliate revenue roadmap — closing the loop from traffic to commissions

## The core problem

Every optimization target in this codebase is a **proxy for traffic**, and
nothing anywhere measures **money**.

- `seo-score.ts` scores 100 checks across 5 pillars → a predicted-quality number.
- `article_rankings` stores position, `est_traffic`, `cpc` → predicted traffic.
- `gsc_pages` stores impressions, clicks, CTR, position → actual traffic.
- `scout.ts:1140` sets the north star as "maximize expected commission per 1,000
  visitors" and ranks niches on **proxies**: commission band × demand ×
  difficulty (`SCOUT_KEYWORD_ROI_FORMULA_COMMISSION_POTENTIAL`).

There is no table, column, or endpoint anywhere in the repo holding clicks-out,
orders, or earnings. So the system can tell you an article ranks #6 for a
50k-volume keyword, and cannot tell you whether it has ever earned a cent. Every
ROI decision — which niche to scout, which page to rewrite, which product to put
in slot 1 — is made on a guess that is never corrected by an outcome.

Ranking better is only half the machine. This roadmap builds the other half.

## Current instrumentation (verified in-repo)

| Signal                                              | Source                                                                                                       | Where it lands                                | Status                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------- |
| Impressions / clicks / CTR / position, **per page** | GSC Search Analytics, 28-day window, service-account JWT                                                     | `gsc_pages`, `article_ledger.gsc_*`           | Working (`gsc-sync.ts`)                                              |
| Ranked keywords, est. traffic                       | DataForSEO Labs, analytics tick                                                                              | `article_rankings`                            | Working                                                              |
| CTR triage rewrite                                  | Striking-distance query on `gsc_pages` (pos 5–15, impr ≥50, clicks ≤1) → Kimi rewrites `<title>` + meta only | Production KV, backup at `ctr-backup:<kvKey>` | Working (`idle-tick.ts`)                                             |
| Per-query performance                               | —                                                                                                            | —                                             | **Missing** — `gsc-sync.ts:164` requests `dimensions: ["page"]` only |
| On-site behavior                                    | —                                                                                                            | —                                             | **Missing** — no GA property, no tag in generated HTML               |
| Outbound affiliate clicks                           | —                                                                                                            | —                                             | **Missing** — links are bare `?tag=`                                 |
| Orders / earnings / EPC                             | —                                                                                                            | —                                             | **Missing** — no ingest, no schema                                   |
| Non-search traffic (Pinterest, Reddit, X, …)        | `traffic-sources.ts` generates the copy; posting is manual                                                   | `traffic-source:<id>:<kvKey>` artifacts       | **Unattributed** — the URLs in that copy carry no UTM                |

Two caveats worth knowing before trusting any existing number:

- `article_ledger.human_views` / `googlebot_hits` increment only in this Worker's
  fetch handler (`server.ts:8578-8584`). Promoted articles are served from
  production KV by a _different_ Worker, so these counters stay near-zero for
  exactly the pages that earn. They are not a traffic metric.
- GSC's 28-day window means every feedback loop below has a **~2–4 week latency
  floor**. Design for it: the CTR rewrite already uses a 14-day re-touch marker.

---

## Phase 0 — Attribution (do this first; everything else depends on it)

Without per-page attribution, earnings data is a single sitewide number and can't
steer anything.

### 0.1 `ascsubtag` on every Amazon link — highest leverage change in the repo

Amazon Associates passes an arbitrary `ascsubtag` value through to the Orders
report, so each commission can be traced to the page and slot that produced it.
Today links are built as `https://www.amazon.com/dp/${asin}?tag=${tag}` in nine
places: `html-builder.ts:826,879,888`, `amazon.ts:328,574,761,958`,
`top-seller-scout.ts:270`, `writer.ts:619`.

Extract one helper — `buildAmazonUrl({ asin, tag, kvKey, slot })` — emitting
`?tag=<tag>&ascsubtag=<kvKey>__<slot>`, and route all nine call sites through it.
Add a `seo-score.ts` check asserting every outbound Amazon link carries a subtag,
so the QC gate keeps it from regressing.

Cost: one small module plus mechanical call-site edits. Payoff: every downstream
phase becomes possible.

### 0.2 GA4 tag in the generated chrome

Generated pages contain no analytics script (verified — `site-chrome.ts:1543`
emits only the chrome JS). Add a `GA4_MEASUREMENT_ID` var and emit `gtag` from
the same chrome builder, plus a delegated click listener that fires an
`affiliate_click` event carrying `{ kvKey, asin, slot }`.

This gives the one thing GSC structurally cannot: **on-page behavior between
landing and click-out** — which product block gets engagement, where readers
stop scrolling, whether the picks block above the fold outperforms mid-article.

It also covers the channels GSC never sees at all. `traffic-sources.ts` now
generates ready-to-paste copy for eight social/community/owned channels, and the
article URLs inside that copy are bare — add a `?utm_source=<sourceId>` when the
artifact is built, so a Pinterest pin and a Reddit comment are distinguishable in
GA4 rather than collapsing into "direct".

### 0.3 Query-dimension GSC sync

`gsc-sync.ts` requests `dimensions: ["page"]`. Add a second Search Analytics call
with `["page", "query"]` into a new `gsc_queries` table (next free migration in
`migrations-keywords/` — `0007` is taken by `scout_sweep_count`).

Unlocks three things page-level data can't:

- CTR rewrites that use the **actual winning query wording** instead of guessing.
- Query-gap detection — queries a page gets impressions for but doesn't cover in
  its body; feed those to the SISS optimizer (step 20) and Polish agent.
- Real difficulty calibration for the scout: which query shapes this site
  actually wins, versus what DataForSEO predicted.

---

## Phase 1 — Ingest the money

### 1.1 Earnings ingest

**Constraint, stated honestly:** Amazon Associates has no public earnings API.
PA-API returns catalog data, not commissions. Earnings come from the CSV reports
in Associates Central.

So: `POST /api/admin/associates-import`, accepting the Orders/Earnings CSV export,
parsing the subtag column set up in 0.1, and writing an `article_revenue` table
(`kv_key, date, clicks_out, ordered_items, shipped_items, earnings, epc`) plus
`product_revenue` keyed by ASIN. Remember both edits from CLAUDE.md: the DO
`onRequest()` handler _and_ `proxyPaths`.

Start with a monthly manual upload — it's ten seconds of work and unblocks every
Phase 2 loop. Automating the download (headless Associates Central via the
existing Browser Rendering binding) is a Phase 3 nicety, not a blocker, and is
fragile against login changes.

### 1.2 GA4 Data API pull

The GA4 Data API authenticates with the **same service account already in use**
for Sheets and GSC — `getGscAccessToken()` in `gsc-sync.ts` generalizes to any
scope with a one-line change (`analytics.readonly`). Grant the SA viewer access
on the property, then pull sessions, engagement, and `affiliate_click` counts per
page into a `ga_pages` table on the idle tick's round-robin.

### 1.3 The metric that matters

With 1.1 + 1.2 you can finally compute, per article:

```
EPC       = earnings / clicks_out          -- how well the page monetizes a click
RPM       = earnings / sessions × 1000     -- how well it monetizes traffic
click_rate= clicks_out / sessions          -- how well the layout converts a reader
```

These three separate the failure modes that are indistinguishable today: good
traffic + bad picks (low EPC), good picks + bad layout (low click rate), good
page + no traffic (an SEO problem, not a revenue one).

---

## Phase 2 — Spend the pipeline's effort where the money is

Each item here is a **re-ranking of work the system already does**, not new
machinery.

### 2.1 Revenue-weighted CTR triage

`idle-tick.ts` currently orders striking-distance candidates by
`impressions DESC`. Impressions are free; commissions are not. Re-rank by
`impressions × category_epc` so the one rewrite per tick goes to the page whose
extra clicks are worth the most. A page ranking #7 in a 3%-commission category
with proven EPC outranks a #6 page in a category that has never converted.

### 2.2 Scout ranks on measured EPC, not predicted commission

`scout.ts` ranks niches on a commission-band proxy. Once `article_revenue` has
history, replace the proxy with measured category EPC and let the proxy be the
cold-start prior only. This is the single change that compounds: the scout stops
buying keywords in categories that look lucrative and demonstrably aren't.

### 2.3 Product-slot selection by earnings

`product_revenue` tells you which ASINs actually convert for _this_ audience.
Feed proven earners into slot 1 during step 2 product selection, and let the
top-seller scout demote ASINs with clicks but no orders — a strong signal of
price/availability/review mismatch that no catalog API exposes.

### 2.4 Judge variant B on revenue, not SEO score

The editorial agent already writes a rewritten variant B to `<kvKey>-b` and
leaves A live pending "a downstream split-tester." Build that split-tester on RPM
rather than SEO score — the thing you're actually optimizing. With GSC's latency
floor, plan a 4-week evaluation window and require a minimum click-out volume
before calling a winner, or you'll be promoting noise.

### 2.5 Kill / consolidate decisions

Articles with sustained impressions and zero click-outs are the ones to rewrite
or merge — currently invisible, since a page can hold a 95 SEO score and earn
nothing. Add them to the defect loop as a new finding class.

---

## Phase 3 — Compounding

- **Internal-link routing toward earners.** The reverse internal-link injector
  (step 23) already edits published articles. Bias its target selection toward
  high-EPC pages so sitewide authority and reader flow both point at the pages
  that convert.
- **Feed revenue outcomes back into the writer prompt.** Once you know which
  article _shapes_ earn (comparison table vs single-pick vs listicle) per
  category, that's a prompt input for step 7, not a static template choice.
- **Seasonality.** `article_revenue` keyed by date makes category seasonality
  visible, which should drive scout timing — publish the seasonal niche 8–12
  weeks before its peak, given indexing lag.
- **Automated Associates report pull**, if the manual upload becomes the
  bottleneck. Deliberately last: fragile, and worth nothing until the loops that
  consume the data exist.

---

## Sequencing and why

| Order | Item                    | Why here                                                                                   |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------ |
| 1     | 0.1 `ascsubtag`         | Nothing downstream works without per-page attribution. Small, mechanical, no runtime risk. |
| 2     | 0.3 GSC query dimension | Cheap (one extra API call + one table), improves the CTR loop that already runs.           |
| 3     | 0.2 GA4 tag             | Must ship before data accumulates — a tag added in month 3 has no month-1 history.         |
| 4     | 1.1 Earnings ingest     | Needs 0.1's subtags to be in the wild and generating orders first.                         |
| 5     | 1.2 GA4 pull            | Needs 0.2 to have been live long enough to hold useful data.                               |
| 6     | 2.1 → 2.5               | Each needs real revenue history; ordered by leverage.                                      |
| 7     | Phase 3                 | Compounding plays that need several months of history.                                     |

Phases 0 and 1 are instrumentation — they change no pipeline behavior and can
ship while articles keep publishing. Phase 2 changes what the pipeline
prioritizes, so ship those one at a time with a measurable before/after.

## Open question: `seo.catsluvus.com`

That hostname appears **nowhere** in this repo — not in `wrangler.jsonc` vars,
not in any source file, not in any doc. The configured hosts are
`cats-seo-aiagent-staging.webmaster-bc8.workers.dev` (`DOMAIN`) and
`catsluvus.com` (`PROMOTION_TARGET_DOMAIN`).

So it's outside this Worker's world, and what to do about it depends on what it
is — a separate content property, a dashboard, or a staging mirror. If it serves
indexable content on a subdomain of the money site, the first questions are
whether it's in the same GSC property (a `sc-domain:` property covers subdomains;
a URL-prefix property does not — see the `GSC_PROPERTY` handling in
`gsc-sync.ts`), and whether it's competing with `catsluvus.com` for the same
queries. Tell me what it is and I'll fold it in.
