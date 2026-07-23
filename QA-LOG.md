# QA Loop Log

Running ledger for the /article-qa-loop iterations. One section per
article: verdicts from rendered-screenshot review, defects, fix commits,
and the deliberate improvement carried into the next iteration.

## Iteration 0 (baseline) — top-entry-cat-carrier-for-anxious-cats

- Score 96, 7808 words, product_count 1. Screenshots verified.
- DEFECT: title truncated mid-clause ("…Anxious Cats: One").
- Fix: cd50b37 (enforceTitleLength drops sheared colon-clause whole).

## Iteration 1 — premium-cat-carrier-with-wheels

- Score 92, 2181 words, product_count 1. Screenshots verified.
- Truncation fix HELD (no dangling fragment).
- NITS: title redundancy "…2026 | Best Picks 2026"; dog video thumbnail
  on a cat page; "→" arrows in the pick blurb prose. Log-health check
  deferred.
- Perf: writer switched to kimi-k2.5:nitro (c060276) after benchmarking
  (31.8 → 37.8 tok/s; kimi-k3 slower at 5.3x price; kimi-latest not a
  callable ID).

## Iteration 2 — lightweight-cat-carrier-for-elderly-owners

- Fixes shipped this iteration: title pipe-segment dedupe
  (normalizeTitle), blurb arrow → prose connectors (html-builder),
  cat-preferring YouTube pick (writer).
- Plan: generate next article (expect first Scout-DB claim once runtime
  backlog drains), full 8-point check INCLUDING log health.

- RESULT: ALL 8 CHECKS PASS. Score 97, 7832 words, product_count 1,
  0 error rows. Title fixes + cat-video fix visually confirmed.
- NITS: templated fallback blurb (model omitted pickReasons); spammy
  Amazon display name.

## Iteration 3 — best-cat-carrier-for-two-cats (Grok 4.5 trial)

- Writer switched to x-ai/grok-4.5 (54798e5 model-aware reasoning +
  worker secret). ALL 8 CHECKS PASS. Score 95, 3343 words, ~5 min.
- Title "One Clear Pick" — single-product pattern followed exactly.
- DIAGNOSED: fallback blurb root cause = model omits pickReasons key
  entirely (verified via /api/admin/kimi-raw). Affects Kimi AND Grok.
- User-merged PR #1 (content-quality analyzers) rode along cleanly.

## Iteration 4 — (pending)

- Fix shipped: data-driven fallback blurb (rating/reviews/feature
  woven in, marker sentence last; period-safety on feature clause).
- Plan: generate next article, verify blurb richness visually.

## Model gauntlet (2026-07-22, 780-820-word window test)

- sonnet-5: 783w ✅ 59 tok/s | gemini-3-flash: 979w ❌ +20% but 116 tok/s
- qwen3-max 797 ✅ 42 | grok-4.5 799 ✅ 47 | kimi:nitro 817 ✅ 32
- gpt-5-mini 750 under ⚠️ | deepseek-v4-pro 1156 ❌ | gemini-3-pro absent
- DECISION: writer -> anthropic/claude-sonnet-5 (most precise + best
  prose tier + 2x Kimi speed). Secret-only switch; revert = 1 change.

## Model decision (2026-07-23)

- User decision: writer stays moonshotai/kimi-k2.5:nitro (code default;
  OPENROUTER_KIMI_MODEL override secret deleted). Rationale: pipeline QC
  flattens model quality deltas; Kimi is the proven cheapest reliable
  option. Sonnet-5/Grok/Gemini remain one secret change away.
- Trial ledger: kimi 92/97, grok 95, sonnet-5 97 — all 8-check passes.

## Iteration — 2026-07-23 (loop restart): quiet cat carrier for skittish kittens

- URL: /cat-large-cat-travel-carrier/quiet-cat-carrier-for-skittish-kittens
- Screenshots: desktop ✅ product ✅ mobile ✅ (viewed)
- Checklist: 8/8 PASS. Ledger: score 93, 2094 words, 1 product. 3m48s claim→publish.
- Notes: first article on the parallel research fan-out (655dba1) — steps 2–6
  completed in ~6s. OpenRouter timed out mid-write; Workers AI fallback wrote it.
  Dashboard counter fix proven (2544→2545).
- Consecutive clean: 1/3.

## Iteration — 2026-07-23: cat carrier backpack for hiking

- URL: /cat-large-cat-travel-carrier/cat-carrier-backpack-for-hiking
- Screenshots: desktop ✅ product ✅ mobile ✅ (viewed)
- Checklist: FAIL on #1 (title) and #7 (content leakage). Ledger: score 94,
  2521 words, 1 product. 3m28s claim→publish.
- Defect A: "(B07KHPLFMS)" parroted into visible prose ×15 (incl. pick blurb).
  Root cause: product grounding block exposed `(ASIN: …)` next to the display
  name. Fix: ASIN removed from prompt + deterministic stripAsinParentheticals
  in cleanField and pickReasons pass.
- Defect B: live title "Best Cat Carrier Backpack for Hiking | Best Picks 2026"
  — Editorial Agent's padTitleToMin appended a double-"Best" pad that
  dedupeTitleSegments strips upstream. Fix: Best-aware pad list (uses
  "— Buying Guide <year>" when the base already leads with Best/Top).
- Improvement next: regenerate this keyword post-deploy to verify both fixes
  on the exact article that failed.
- Consecutive clean: reset to 0/3.

## Iteration — 2026-07-23: cat carrier backpack for hiking (regeneration on be90aa8)

- URL: /cat-large-cat-travel-carrier/cat-carrier-backpack-for-hiking (same slug, KV purged)
- Screenshots: desktop ✅ product ✅ mobile ✅ (viewed)
- Fix verification: PASS — 0 parenthetical ASINs in prose (was 15); title
  "Best Cat Carrier Backpack for Hiking — Buying Guide 2026" (Best-aware pad).
- Checklist: FAIL on #2 — product card rendered without an image. This run's
  Amazon tier returned the Texsens pick without imageUrl (iteration 2's tier
  included it). html-builder correctly emits button-only, but the card reads
  as a missing photo.
- Also noted: all SERP sources failed this run (dataforseo included) — article
  still scored 93; watch next run for DataForSEO recurrence.
- Fix: ASIN→image KV cache (product-image:<asin>) — writes on every sighted
  image, backfills when a tier returns the same ASIN imageless. Seeded
  B07KHPLFMS from iteration 2's captured HTML.
- Consecutive clean: 0/3.

## Iteration — 2026-07-23: cat carrier backpack for hiking (2nd regen, image cache live)

- Aborted once: fired generate-one too close to the deploy boundary — DO reset
  mid-run ("Durable Object reset because its code was updated"); a second fire
  was rejected by the single-flight guard and my /api/stop killed the
  self-recovered run. Lessons: wait ~60s after canary flip; never fire without
  status=idle pre-check.
- Clean rerun: score 94, 4756 words, 1 product, 8m38s.
- Screenshots: desktop ✅ product ✅ mobile ✅ (viewed). Pick photo restored via
  product-image KV cache (seeded URL served). All 8 checks PASS.
- Consecutive clean: 1/3.

## Iteration — 2026-07-23: ventilated cat carrier for summer travel

- Score 96, 7900 words, 1 product, ~10.5 min (HTTP 900s timeout outlived; run
  completed server-side — poll ledger next time instead of holding the socket).
- Screenshots: desktop ✅ product ✅ mobile ✅ (viewed). Image present (GAPZER,
  fresh ASIN → now cached).
- Checklist: FAIL #1 — title/H1 published sentence-case: "Best ventilated cat
  carrier for summer travel: Top Picks". Kimi returned no usable title, and the
  fallback template inserted the raw lowercase keyword.
- Fix: toTitleCase() in keyword-utils (stopword-aware) applied to the fallback
  title template. Regression tests added.
- Second thin blurb in a row (model variance) — queued as next deliberate
  improvement if it recurs.
- Consecutive clean: reset to 0/3.
