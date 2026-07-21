---
description: Ongoing pipeline health + per-article analysis for the catsluvus SEO Worker. Hits /api/status, parses the live activity log, picks the most recent published kvKey, fetches its HTML + Editorial report + variant-B if present, and reports fixes/improvements. Designed to be run on an interval via `/loop 15m /watch-pipeline`.
---

# /watch-pipeline — Recurring pipeline health + per-article analysis

You are monitoring the `cats-seo-aiagent` Cloudflare Worker live. Every invocation does a full health sweep + deep-dive on the latest article. Report in a tight, scannable format — no hedging, data only.

## Scope of one invocation

### 1. Worker liveness + status header

Call `/api/status` (unauth'd):

```bash
curl -sS --max-time 30 "https://cats-seo-aiagent.webmaster-bc8.workers.dev/api/status" > /tmp/status.json
```

Parse with `jq`. Report:

- `status`, `currentStep`, `currentKeyword` (if set)
- `articlesGenerated`, `articlesFailed`, failure rate %
- `avgSeoScore`
- `lastActivity` (LA timezone — convert to UTC + minutes-since-now)
- If `status !== "generating"` and `lastActivity` is > 30 min old, flag as **pipeline idle/stalled**.

### 2. Activity-log health rollup (most recent ~200 entries)

From `activityLog[]` in the status payload:

- Count by `level`: `info` / `warning` / `error`. If error count jumped vs previous invocation → escalate in the report.
- Top 5 warning message prefixes (normalize: strip keyword, kvKey, UUIDs, timestamps). Show count + example.
- Top 5 error message prefixes.
- Count per `activeRole` — who's doing the most work right now?
- New-in-this-window surprises:
  - any `Expand miss:` / `Expand threw:` from content-gate loop (commit `5b2c8db`)
  - any `rewrite generation failed` from Editorial Agent (commit `782a4d9`)
  - any `variant B written as` success messages
  - any `stripped N price mention(s)` (commit `3c1af0d`) — if count climbing, Kimi is being more aggressive about prices, prompt may need tightening
  - any `Wireframe: cached hit` / `Wireframe: ingested` (commit `c5a2c82`)

### 3. Deep-dive on the most recent published article

Find the newest activity-log entry with message starting `Published:` (role `operations`). Extract its `kvKey` from `pipelineContext.kvKey` or parse the URL.

Fetch it via the unauth'd preview endpoint:

```bash
curl -sS "https://cats-seo-aiagent.webmaster-bc8.workers.dev/api/preview/${kvKey}" > /tmp/article-a.html
```

Report on the article:

- Byte size, approx word count (strip tags, split on whitespace)
- Section count (`<h2` match count)
- FAQ count (`faq-item` match count)
- Schema types present (grep `"@type":"..."` inside the single `@graph` script)
- Compliance check:
  - zero `$\d` price matches (Amazon Associates rule)
  - `rel="canonical"` present
  - no stray `{"quickAnswer":"` or `"sections":[{` (Kimi JSON schema leak detector in `detectJsonSchemaLeak`)
- Transition-phrase count for readability check #78: count `for example`, `such as`, `in other words`, `simply put`, `think of it`
- `<script>` tag count (must be ≤ 5 for SEO check #97)

### 4. Check for variant B (Editorial Agent A/B split)

```bash
curl -sS -o /dev/null -w "%{http_code}" \
  "https://cats-seo-aiagent.webmaster-bc8.workers.dev/api/preview/${kvKey}-b"
```

If 200 → variant B exists. Fetch both, compare:

- Word-count delta (B vs A)
- Script-count delta
- Price presence in either (both should be zero)
- Wireframe-pattern coverage improved? (grep for H2s matching `who this is for|how we picked|how we tested`)

If 404 → note "no variant B yet (Editorial Agent hasn't run or rewrite was rejected)". Don't flag as error — Editorial Agent is async, may still be mid-flight.

### 5. GitHub issue pressure

Call `mcp__github__list_issues` on `techfundoffice/cats-seo-aiagent-cloudflare`:

- labels=["claude-fix"], state=OPEN, perPage=30
- Count total + breakdown by category
- Flag any category > 3 open — recurring failure pattern the Repo Agent should have deduped

### 6. Actionable output

End with a ranked 3-5 item list titled **"What to fix next"**:

- Each item: one-line finding + evidence + one-line suggested fix
- If everything looks clean, state that explicitly: "Pipeline healthy — no action needed this cycle"
- If something regressed vs last invocation, call it out at the top with a ⚠️

## Constraints

- Under **500 words** total output. If an article's deep-dive is missing, note why in one sentence — don't pad.
- Never propose destructive actions (purging KV, closing issues, rotating secrets) without asking first. Observation + suggestion only.
- Use direct quotes from the activity log for surprising signals — paraphrasing loses the diagnostic value.
- Do NOT attempt to fix the code. This is a monitoring skill; code fixes happen in a separate session. But if you spot a critical regression (pipeline stuck, zero articles in 30 min, error count spiking), say so clearly at the top so a human can intervene.

## Commits this skill is calibrated against (known-good state)

- `5b2c8db` — content-gate floor 80% + expand failure logging
- `57a12cc` — Editorial Agent CF Browser Rendering fallback
- `77030b2` — terminal failures reclassified to level=error
- `2e33e92` — 3 SEO checks (#78 #89 #97) unblocked
- `782a4d9` — Editorial rewrite error surfacing + retry
- `3c1af0d` — A/B variants + no-prices enforcement
- `c5a2c82` — wireframe ingestion system
- `f6b3c3a` — Kimi reasoning fix

If behavior diverges from what these commits established, that's a regression — lead the report with it.
