# Scorecard Staging — Findings & Software Roadmap

**Date:** 2026-07-17  
**Author role:** Scorecard / eval systems expert  
**Scope:** Staging only (`cats-seo-aiagent-staging`) + Scorecard project **1356**  
**Out of scope:** Production worker deploy, live catsluvus.com content

**Primary UI:** [app.scorecard.io/projects/1356](https://app.scorecard.io/projects/1356)  
**API base:** `https://api2.scorecard.io/api/v2`  
**OTLP:** `https://tracing.scorecard.io/otel/v1/traces`  
**Worker:** `https://cats-seo-aiagent-staging.webmaster-bc8.workers.dev`

---

## 1. Executive summary

Staging Scorecard is **wired and partially healthy**:

| Layer                            | Status                     | Evidence                                                                                               |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| OTLP tracing                     | **Green**                  | Export HTTP 200; Records show `article.generate` with `cats.trigger=eval`, `scorecard.project_id=1356` |
| Worker `/api/eval` dry-run       | **Green when it finishes** | Probe `2f248e71-…`: seo **99**, pass **94%**, **5** ASINs, Our Top Picks, ~3.2 min                     |
| Scorecard AI metrics (3408–3411) | **Yellow**                 | Metrics defined; runs often stuck with **1/6** records and `running_execution`                         |
| Full 6-case gate                 | **Red**                    | No completed run with 6 scored commercial cases end-to-end                                             |
| Amazon product tiers             | **Yellow**                 | Creators/PA invalid; **Apify fallback works** and can fill Top Picks                                   |
| Eval job hygiene                 | **Red**                    | 13 KV `eval-job:*` keys; **~8 stuck `running` forever** (orphaned DO work)                             |

**Bottom line:** Scorecard can already **see** staging generations and **score** articles when generation succeeds. The product gap is not “Scorecard missing”; it is **reliability of the judge loop**, **orphaned evals**, **shallow traces**, and **incomplete commercial coverage**.

---

## 2. Scorecard project inventory (live API)

### 2.1 Project & environment

| Field                                  | Value                                                            |
| -------------------------------------- | ---------------------------------------------------------------- |
| Project ID                             | `1356`                                                           |
| Staging secret `SCORECARD_ENVIRONMENT` | `staging` (set 2026-07-17)                                       |
| Trace `service.name`                   | `cats-seo-aiagent-cloudflare`                                    |
| Testset                                | `14992` — **Cat SEO article scenarios**                          |
| Dashboard runs                         | [project 1356 runs](https://app.scorecard.io/projects/1356/runs) |

### 2.2 Metrics (IDs 3408–3411)

All four are **AI metrics** (`evalType: ai`, model **gpt-4o-mini**, temp 0)—not hard-coded heuristics—despite some “SEO structure” naming.

| ID       | Name                                      | Output  | Pass rule (as configured)                             |
| -------- | ----------------------------------------- | ------- | ----------------------------------------------------- |
| **3408** | Hallucination / fabricated testing claims | boolean | `true` = avoids fake trials / invented medical claims |
| **3409** | Affiliate / commercial usefulness         | int 1–5 | threshold **≥ 4**                                     |
| **3410** | Brand tone / editorial quality            | int 1–5 | threshold **≥ 4**                                     |
| **3411** | SEO structure compliance                  | boolean | one H1, sensible H2s, adequate length, on-topic       |

**Expert note:** Treating SEO structure as an LLM boolean duplicates the worker’s real 105-check scorecard (`seoScore` / `passRate` already returned by `/api/eval`). Prefer **deterministic Scorecard metrics** (or pass/fail gates in CI) for SEO, and reserve AI for tone, usefulness, and hallucination.

### 2.3 Testset 14992 (6 cases)

Matches `evals/testset.json`:

1. best automatic cat litter box → `cat-litter-boxes`
2. best cat water fountain → `cat-water-fountains`
3. best cat scratching post → `cat-scratching-posts`
4. best cat carrier for travel → `cat-carriers`
5. best wet cat food for indoor cats → `cat-food` (YMYL-adjacent)
6. best flea treatment for cats → `cat-flea-and-tick` (YMYL)

Schema maps **inputs:** `keyword`, `category`; **metadata:** `notes`, `seoScore`, `articleText`.

### 2.4 Recent Scorecard runs (API snapshot)

| Run ID                 | Status               | Records | Expected | Scores | Notes                                  |
| ---------------------- | -------------------- | ------- | -------- | ------ | -------------------------------------- |
| 384556                 | `running_execution`  | 1       | 6        | 4      | litter box only (seo 92, 3490w)        |
| 384322                 | `running_execution`  | 1       | 6        | 4      | water fountain (seo 95, 1855w)         |
| 384310                 | `awaiting_execution` | 0       | 6        | 0      | empty shell run                        |
| 384331, 384329, 384312 | `completed`          | 1       | —        | 0      | **trace-only** records (no AI metrics) |

**Pattern:** Judge jobs create a run for 6 cases, submit **one** article record, then stall. Expected six never filled. Trace-only runs complete but show `cats.seo_score=0` / `cats.word_count=0` with **no child spans**.

---

## 3. Staging worker scorecard (eval jobs)

### 3.1 KV inventory (`eval-job:*`, n=13)

| Status            | Count | Implications                                               |
| ----------------- | ----- | ---------------------------------------------------------- |
| `done`            | 3–4   | Usable for Scorecard records                               |
| `failed`          | 1     | Bug: `verified is not defined`                             |
| `running` (stale) | ~8    | Never finalized; pollers hang; Scorecard harness times out |

### 3.2 Done jobs (deterministic quality)

| Keyword                                 | SEO    | Pass rate | Words | Products | Top Picks        | Duration            |
| --------------------------------------- | ------ | --------- | ----- | -------- | ---------------- | ------------------- |
| scorecard probe only                    | **99** | **94%**   | 2684  | **5**    | yes (real ASINs) | ~194s               |
| best automatic cat litter box           | **92** | **88%**   | 3490  | **0**    | yes\*            | ~153s               |
| best automatic cat litter box (earlier) | 0      | 0         | 0     | —        | —                | ~66s (empty finish) |

\* `hasOurTopPicks=true` with `productCount=0` usually means the honesty empty strip still contains the words “Our Top Picks”—**Scorecard commercial metric can false-positive** if it only greps the phrase.

### 3.3 Product path (observed on staging activity log)

```
Creators API → invalid_client / disabled
PA-API v5    → UnrecognizedClient 401
Apify        → junglee~amazon-crawler → real ASINs (when reached)
```

Cascade order is correct (Amazon first, Apify fallback). Production has `AMAZON_*_FALLBACK` PA keys; staging still does not (values not in Doppler).

### 3.4 Trace quality gaps

Completed OTLP records show:

- Single span `article.generate` (`SpansCount: 1`) — **no scout/writer/qc/publish children**
- Early failures still `StatusCode: Ok` with **seo_score 0**
- Group id present (`scorecard.tracing_group_id=eval-…`) — good for batching

This undercuts the original design in `docs/scorecard-setup.md` §2–3 (phase children + accurate root status).

---

## 4. Architecture (as-is)

```
┌─────────────────────────────────────────────────────────────┐
│ Scorecard project 1356                                      │
│  • Testset 14992 (6 keywords)                               │
│  • AI metrics 3408–3411 (gpt-4o-mini)                       │
│  • Runs + Records + Traces                                  │
└──────────────▲──────────────────────────▲───────────────────┘
               │ OTLP (Bearer ak_…)       │ REST api2 runs/records
               │                          │ (scorecard-judge.mjs)
┌──────────────┴──────────────────────────┴───────────────────┐
│ Staging Worker                                              │
│  POST /api/eval (SCORECARD_EVAL_TOKEN)                      │
│  dryRun generateArticle → seoScore, passRate, html, ASINs   │
│  eval-job:{uuid} in ARTICLES_KV (24h TTL)                   │
│  product cascade: Creators → PA-API → Apify                 │
└─────────────────────────────────────────────────────────────┘
               ▲
               │ scripts/scorecard-eval.mjs  (deterministic gate)
               │ scripts/scorecard-judge.mjs (AI metrics run)
```

---

## 5. Root-cause findings (prioritized)

| P   | Finding                                                                    | Impact                                                              |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P0  | Orphaned `eval-job` stuck in `running` when DO is hijacked/redeployed/stop | Scorecard harness and humans cannot trust poll → “always running”   |
| P0  | Judge runs submit 1/6 records then hang in `running_execution`             | No full Scorecard pass/fail board for the official testset          |
| P1  | Trace tree is flat (root only); root Ok with zero words                    | Cannot debug which phase failed inside Scorecard UI                 |
| P1  | `hasOurTopPicks` true without ASINs                                        | Commercial AI metric can pass empty product pages                   |
| P1  | PA/Creators secrets invalid on staging                                     | Extra latency + dependency on Apify; Top Seller Scout noise in logs |
| P2  | SEO metric is LLM-boolean, not the 105-check                               | Drift between worker gate and Scorecard metric                      |
| P2  | Stuck Scorecard runs never cleaned up                                      | Dashboard clutter; confusing historical status                      |
| P3  | Full suite wall-clock (6 × up to 20 min, single-flight DO)                 | CI `run-evals` impractical without batching/queue                   |

---

## 6. Software roadmap

### Phase 0 — Stabilize eval truth (1–2 days)

**Goal:** Every `/api/eval` ends in `done` or `failed` with honest fields.

| #   | Work item                                                                              | Acceptance                                           |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 0.1 | On DO stop / alarm cancel / exception: finalize open `eval-job` as `failed` with error | No job stays `running` > N minutes without heartbeat |
| 0.2 | Heartbeat / `updatedAt` on eval jobs; sweeper marks stale after e.g. 25 min            | KV list of `running` ≈ 0 in idle                     |
| 0.3 | Fix `verified is not defined` pipeline exception                                       | Keyword `x` (or repro) does not crash with Uncaught  |
| 0.4 | `hasOurTopPicks` = real block with ≥1 `/dp/{ASIN}` (not honesty empty)                 | Probe with 0 products → `hasOurTopPicks=false`       |

**Exit:** Re-run probe + one testset case; both terminal; fields match HTML.

### Phase 1 — Scorecard as the quality control plane (3–5 days)

**Goal:** One green 6-case Scorecard run with AI metrics + deterministic gates.

| #   | Work item                                                                                                                    | Acceptance                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1.1 | Harden `scorecard-judge.mjs`: for each of 6 cases generate → POST record → only then complete run; cancel/abandon empty runs | Run shows `numRecords=6`, status `completed`          |
| 1.2 | Persist `productCount`, `productAsins`, `hasOurTopPicks` into Scorecard record outputs                                       | Records filterable by commercial success              |
| 1.3 | Map worker `seoScore`/`passRate` into Scorecard metadata + CI gate (`scorecard-eval.mjs`)                                    | CI fails if seo&lt;90 or pass&lt;0.85 or words&lt;600 |
| 1.4 | Add **deterministic** Scorecard metric or harness check: “≥1 amazon.com/dp + tag=catsluvus03-20”                             | Commercial cases fail without affiliate links         |
| 1.5 | Dashboard runbook link in report: open run URL after judge                                                                   | Operator can click through without hunting            |

**Exit:** [app.scorecard.io](https://app.scorecard.io) run for testset 14992 with 6 scored records; table published in CI artifact.

### Phase 2 — Deep traces for debugging (3–5 days)

**Goal:** Scorecard Records match the design in `scorecard-setup.md`.

| #   | Work item                                                                      | Acceptance                              |
| --- | ------------------------------------------------------------------------------ | --------------------------------------- |
| 2.1 | Emit child spans: scout, amazon-products, serp, writer, qc, polish, publish    | Trace tree depth ≥ 3 on successful eval |
| 2.2 | Root span ERROR when generation fails or empty article                         | `cats.seo_score=0` not Status Ok        |
| 2.3 | Stamp `deployment.environment.name` from worker secret (`staging` already set) | Filter staging vs prod in UI            |
| 2.4 | Optional: `scorecard.otel_link_id` from harness → link Run record ↔ trace      | Click-through from Run to full tree     |

**Exit:** Failed Apify-timeout or OpenRouter-empty shows ERROR root + phase child with message.

### Phase 3 — Product reliability for commercial metrics (2–4 days)

**Goal:** Affiliate/commercial Scorecard metric reflects real catalog quality.

| #   | Work item                                                                       | Acceptance                                      |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------- |
| 3.1 | Keep cascade: Creators → PA-API → Apify; log “Apify fallback only if Amazon 0”  | Already shipped; keep regression tests          |
| 3.2 | When PA FALLBACK values available: put on **staging only**                      | Staging log shows PA products without Apify     |
| 3.3 | Soft-fail commercial keywords still if all tiers 0                              | No empty commercial “done” with fake usefulness |
| 3.4 | Add testset cases: washable perch / multi-cat (production reference page shape) | Aligns with catsluvus commercial SEO            |

**Exit:** 3 consecutive fountain/litter commercial evals: `productCount≥1`, ASINs in HTML.

### Phase 4 — Metric redesign & continuous eval (1–2 weeks)

**Goal:** Scorecard metrics match business risk, not only vibes.

| #   | Work item                                                                                                       | Acceptance                          |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 4.1 | Split metrics: heuristic (SEO structure, banned phrases, affiliate URL) vs AI (tone, hallucination, usefulness) | Heuristics run without gpt-4o-mini  |
| 4.2 | Raise YMYL weight for flea/food cases (3408)                                                                    | Failures block merge on those ids   |
| 4.3 | Nightly staging job: `scorecard-judge.mjs` on testset 14992                                                     | Slack/email or artifact on fail     |
| 4.4 | Trend dashboard: weekly pass rate on 3409/3410/3411                                                             | Chart or Scorecard saved view       |
| 4.5 | Optional second project “Cats SEO Production” if eval noise drowns prod traces                                  | Document filter strategy either way |

### Phase 5 — Scale & CI productization (ongoing)

| #   | Work item                                                                 | Acceptance                        |
| --- | ------------------------------------------------------------------------- | --------------------------------- |
| 5.1 | Parallel eval DO or queue so 6 cases don’t serialize 2h                   | Full suite &lt; 25 min wall clock |
| 5.2 | GitHub `run-evals` label → staging only                                   | PR comment with Scorecard run URL |
| 5.3 | Budget/alerts: OpenRouter credits, Apify spend, DataForSEO 402            | Alert before silent quality drop  |
| 5.4 | Archive/delete stuck Scorecard runs (`awaiting_execution` with 0 records) | Clean project homepage            |

---

## 7. Recommended near-term sequence (next 7 days)

```
Day 1–2  Phase 0 (orphan evals, hasOurTopPicks truth, verified bug)
Day 3–4  Phase 1.1–1.3 (full 6-case judge + CI gates)
Day 5    Phase 2.1–2.2 (child spans + root ERROR)
Day 6–7  Phase 3.3–3.4 (commercial soft-fail + testset expansion)
```

Do **not** block on Amazon FALLBACK keys: Apify already unblocks commercial Top Picks for Scorecard. Add PA FALLBACK when convenient (Phase 3.2).

---

## 8. Operator playbook (staging)

```bash
# Deterministic gate (worker scores only)
export EVAL_WORKER_BASE_URL=https://cats-seo-aiagent-staging.webmaster-bc8.workers.dev
export EVAL_BEARER_TOKEN=<SCORECARD_EVAL_TOKEN>
node scripts/scorecard-eval.mjs

# AI judge → Scorecard Run (project 1356)
export SCORECARD_API_KEY=ak_…
export SCORECARD_PROJECT_ID=1356
export SCORECARD_METRIC_IDS=3408,3409,3410,3411
export SCORECARD_TESTSET_ID=14992
export JUDGE_MAX_CASES=2   # smoke first
node scripts/scorecard-judge.mjs evals/testset.json
```

In UI: **Projects → 1356 → Runs** filter incomplete; **Records** filter `cats.trigger=eval` and `deployment.environment.name=staging`.

---

## 9. Success metrics for this roadmap

| Metric                           | Now (2026-07-17) | Target (30 days)         |
| -------------------------------- | ---------------- | ------------------------ |
| Orphan `eval-job` running        | ~8               | 0                        |
| Completed 6/6 Scorecard runs     | 0                | ≥1 per week              |
| Commercial eval productCount≥1   | intermittent     | ≥95% of commercial cases |
| Trace child span coverage        | ~0%              | ≥90% of done evals       |
| Probe seoScore (smoke)           | 99               | keep ≥90                 |
| `hasOurTopPicks` false positives | yes (0 ASINs)    | 0                        |

---

## 10. References

- `docs/scorecard-setup.md` — original wiring plan
- `docs/scorecard-eval-endpoint.md` — `/api/eval` contract
- `docs/otel-scorecard-tracing-investigation.md` — OTLP choice
- `scripts/scorecard-eval.mjs` — deterministic harness
- `scripts/scorecard-judge.mjs` — AI metrics run loop
- `evals/testset.json` — local mirror of testset 14992
- Live sample: eval `2f248e71-41db-4f7f-b8e5-de74f11ca1bf` (seo 99, 5 products)

---

_This roadmap is derived from live Scorecard API data (project 1356), staging worker status/logs, and staging KV eval jobs as of 2026-07-17. Production worker was not modified._
