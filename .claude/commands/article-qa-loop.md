# Article QA Loop — generate → screenshot-verify → fix → improve

## GOAL

Raise real article quality one article at a time. Each iteration produces
exactly ONE published article, proves its quality with **rendered
screenshots that you actually look at** (never HTML greps alone), fixes
any defect found in code, and carries the lesson into the next iteration.
The loop is done when **3 consecutive articles pass every check with zero
defects**.

## HARD RULES

1. The autonomous generator stays **paused** (`POST /api/stop` if it
   isn't). Articles are produced only via `POST /api/generate-one` —
   one per iteration, never concurrently.
2. **Screenshot proof is mandatory.** A check "passed" only if you
   rendered the live page and visually inspected the image with your own
   eyes (Read tool on the PNG). HTML-source checks are supplementary.
3. Honesty rules apply: report what you saw, attach the screenshots to
   your report (SendUserFile), and never claim a fix works until the
   NEXT article visually proves it.
4. Every code fix goes through the full gate (`oxfmt --check`, `oxlint`,
   `tsc`, `vitest run`) before push; push to `main` auto-deploys; confirm
   the deploy landed via `GET /deploy-verify.txt` (canary = pushed SHA)
   BEFORE generating the next article.

## SETUP (once per session)

- Worker base: `https://cats-seo-aiagent-staging.webmaster-bc8.workers.dev`
- Secrets (never print values): fetch `ADMIN_API_TOKEN` from Doppler
  (`replit-n8n-catsluvus/prd`) for `/api/admin/*`; use the Cloudflare
  API token with Browser Rendering permission for screenshots.
- Screenshots via Cloudflare Browser Rendering REST
  (`POST /accounts/<acct>/browser-rendering/screenshot`); local Chromium
  cannot reach the site through the sandbox proxy.

## LOOP (repeat until stop condition)

### 1. Generate one article

`POST {base}/api/generate-one`. Poll `GET /api/status` every ~2 min until
the article publishes (watch `articlesGenerated` increment and the new
row appear in the D1 `article_ledger`).

### 2. Verify — data layer

Query the KEYWORDS_DB D1 `article_ledger` for the new row. Record:
`seo_score`, `word_count`, `product_count` (MUST be 1), `kv_key`, `url`.
Also confirm the claimed keyword's `scout_keywords` row flipped to
`published` (once the runtime backlog is drained, every article must
come from a Scout-DB claim).

### 3. Verify — screenshot proof (all three, every article)

Capture with Browser Rendering and **view each image**:

- Desktop above-the-fold (1280×900)
- Product block only (`selector: ".top-picks"`)
- Mobile fold (390×844, isMobile)

### 4. Grade against the checklist

| #   | Check          | Pass criteria                                                                                                                                          |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Title/H1       | No truncation artifacts (no dangling words like ": One"), keyword present, reads naturally                                                             |
| 2   | Single product | Exactly 1 product card, 1 unique ASIN, image loads (not broken), "Why we like this pick:" present                                                      |
| 3   | CTA            | "View on Amazon" visible with `tag=catsluvus03-20`                                                                                                     |
| 4   | Layout         | No overlapping/clipped elements desktop or mobile, hero video box intact, breadcrumbs correct                                                          |
| 5   | H1 count       | Exactly 1                                                                                                                                              |
| 6   | SEO score      | ≥ 90 (from ledger)                                                                                                                                     |
| 7   | Content        | Intro visible above fold or immediately after hero; no raw JSON/template leakage anywhere in the screenshots                                           |
| 8   | Log health     | No new `[error]` rows in `/api/status` activityLog for this article; post-publish gates (design audit, live-leak, fingerprint) ran rather than skipped |

### 5. Fix every failure

For each failed check: find the root cause in `src/`, fix it, run the
full gate, commit with a message naming the defect, push, wait for the
canary to flip. If a failure repeats twice with the same cause, stop and
report instead of thrashing.

### 6. Improve the next article

Keep a running `QA-LOG.md` in the repo (append one section per
iteration): article URL, screenshot verdicts, defects found, fix commit
SHA, and one deliberate improvement to attempt next (e.g. tighter title
pattern, better blurb, image alt coverage). Apply that improvement
before the next generation when it's a code/prompt change.

### 7. Report

After each iteration, send the user: the article URL, the three
screenshots, the checklist table with pass/fail, what was fixed, and
what the next iteration will improve. Then continue the loop.

## STOP CONDITIONS

- **Success:** 3 consecutive articles with all 8 checks passing → final
  report and stop.
- **Blocked:** same defect twice despite a fix, scout queue empty, or a
  deploy failure you cannot resolve → report exactly where it stopped.
- The user says stop.
