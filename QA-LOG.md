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
