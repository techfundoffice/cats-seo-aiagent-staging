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

## Iteration 2 — (pending)

- Fixes shipped this iteration: title pipe-segment dedupe
  (normalizeTitle), blurb arrow → prose connectors (html-builder),
  cat-preferring YouTube pick (writer).
- Plan: generate next article (expect first Scout-DB claim once runtime
  backlog drains), full 8-point check INCLUDING log health.
