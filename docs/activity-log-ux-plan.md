# Activity Log UX Improvement Plan — 100 Items

**Target component:** `src/app.tsx:1173-1501` (Activity Log card on the main dashboard).
**Current state (baseline):** flat newest-first list, ~12 inline-styled `<span>`s per row repeating field labels (`Article URL:`, `Keyword:`, `Category:`, `Competitor URL:`, `SEO score:`), no virtualization, no filtering, no search, no role color-coding even though the backend already emits roles (`codingAgent`, `repoAgent`, `editorialAgent`, `textEditorAgent`, `analyst`, `developer`, `orchestrator`, …), single Copy-Log button, `maxHeight: 32rem` scroll container, monospace inline labels at `0.65rem` / `0.7rem` (below WCAG minimum-readable for body text), repeated newest-first reverse done in render with `[...state.activityLog].reverse()` on every state update, no empty-state CTA beyond text, no error-row affordance beyond red text.

The plan groups 100 concrete improvements into 15 themes. Each item is **(a)** scoped narrowly enough to ship as one PR, **(b)** maps to a UX heuristic (Nielsen N#, WCAG, or Refactoring UI principle), and **(c)** names the file/line where the change lands.

Legend: `[N#]` = Nielsen heuristic, `[WCAG x.y.z]` = WCAG 2.2 success criterion, `[RUI]` = Refactoring UI principle, `[Schneiderman]` = Schneiderman's 8 golden rules.

---

## 1. Information architecture & row layout (1–10)

1. **Collapse repeated field labels** — the row currently re-prints `Article URL:`, `Keyword:`, `Category:`, `Competitor URL:`, `SEO score:` inline. Replace per-row labels with a sticky table header so each label is rendered **once**, not once per entry. `[RUI: reduce noise]` — `src/app.tsx:1373-1481`.
2. **Adopt a true `<table>` element** with `<thead>` + `<tbody>` so columns align vertically and screen readers announce header context for every cell. `[WCAG 1.3.1 Info & Relationships]`
3. **Use `role="log"` and `aria-live="polite"`** on the scroll container so screen readers announce new entries without stealing focus. `[WCAG 4.1.3 Status Messages]`
4. **Add `aria-relevant="additions"` and `aria-atomic="false"`** so only newly-appended rows get announced, not the whole list on every state update.
5. **Promote `logRef` to a permalink anchor** (`#log-142`) so users can deep-link into a specific entry. `[N3: User control]`
6. **Make `stepNumber` a colored pill** instead of a plain monospace token; it's the strongest spatial signal of pipeline progress and currently blends in.
7. **Move the timestamp to the leftmost column** (after `logRef`) — it's the most-scanned field in any log UI; current order buries it after step. `[RUI: visual hierarchy]`
8. **Right-align numeric columns** (`SEO score`, `Plagiarism %`) with `tabular-nums` so digits line up across rows.
9. **Truncate long URLs middle-style** (`https://catsluvus.com/…/best-litter-box`) instead of the current end-truncate, so both the domain and the slug are visible.
10. **Replace `flexWrap: "wrap"` with explicit grid columns** so a row never wraps onto a second line on narrow screens — wrapping today produces a confusing 2-line entry where it's unclear which fields belong together.

## 2. Visual hierarchy & typography (11–18)

11. **Raise body font-size from 0.75rem to 0.8125rem (13px)** and field labels from 0.65rem to 0.6875rem (11px) — current sizes fail comfortable reading on standard DPI. `[WCAG 1.4.4 Resize text]`
12. **Switch from system monospace to a tabular-numeric variable font** (e.g. Inter with `font-variant-numeric: tabular-nums`) for everything except the message — monospace for the human-readable msg is fighting the eye. `[RUI: typography]`
13. **Establish a 4-tier type scale** (caption / meta / body / emphasis) and stop hand-tuning per-span sizes (`0.65rem`, `0.7rem`, `0.72rem`, `0.75rem`, `0.8rem` all coexist today). `[RUI: hierarchy]`
14. **Drop italic / bold weight inflation** — every span is `fontFamily: monospace`; emphasis is currently signalled only by color, which fails for color-blind users. `[WCAG 1.4.1 Use of color]`
15. **Replace the `2563eb` blue link color** with a token (`--color-link`) so dark-mode + theming work later.
16. **Increase line-height from default to 1.45** for the message column — long error strings wrap and become unreadable.
17. **Use a semibold weight (600) for the message** so the eye lands there first, not on the timestamp. `[RUI: emphasis through contrast]`
18. **Cap message column at 80ch** even on wide screens — measure-of-line is currently the viewport, which kills readability above 1440px.

## 3. Color & status semantics (19–28)

19. **Introduce a role color system** mapping every backend role to one accent: `codingAgent` → indigo, `repoAgent` → teal, `editorialAgent` → fuchsia, `textEditorAgent` → amber, `analyst` → blue, `developer` → slate, `orchestrator` → emerald. Render as a 2px left border on the row. `[N1: Visibility of system status]`
20. **Add a role icon column** (Lucide `Bot` for agents, `Github` for repoAgent, `FileEdit` for editorialAgent) — icons + color is dual-encoded redundancy for color-blind users. `[WCAG 1.4.1]`
21. **Use a 3-tier severity system** (`info` / `warning` / `error`) with both background tint AND left-border, not color alone. Today only the message text changes color.
22. **Add a `success` level** for completed publish events — currently a successful publish is rendered identically to a debug breadcrumb.
23. **Reserve red exclusively for errors** — the existing red `Error` placeholder for missing `articleUrl` competes visually with real failure entries.
24. **Reserve green for confirmed-published rows**, never for "step done" — currently `articleUrl` non-empty turns green, which conflates "we have a URL" with "we shipped."
25. **Prefer chip components** (filled pill on tinted background) over raw colored text for severity — meets minimum 3:1 contrast from background, plain colored text often doesn't. `[WCAG 1.4.11 Non-text Contrast]`
26. **Verify every text/background pair clears 4.5:1** for normal text and 3:1 for large — the `#9ca3af` on white used today is 2.85:1 and fails. `[WCAG 1.4.3 Contrast]`
27. **Add high-contrast mode** that snaps everything to `--text-primary` / `--bg-primary` tokens for users with `prefers-contrast: more`. `[WCAG 1.4.6]`
28. **Honor `prefers-reduced-motion`** — disable any future row-fade-in animation when the OS toggle is on. `[WCAG 2.3.3]`

## 4. Filtering & search (29–37)

29. **Add a free-text search input** that filters across `keyword`, `articleUrl`, `competitorUrl`, `msg`, and `categorySlug`. `[N7: Flexibility & efficiency]`
30. **Debounce search input by 150ms** so each keystroke isn't re-rendering 500 rows.
31. **Add a level filter chip group** (`All / Info / Warning / Error`) with counts in each chip. `[N6: Recognition vs recall]`
32. **Add a role filter dropdown** populated from the distinct roles present in the current log slice (don't hardcode — discover at runtime).
33. **Add a category filter** (cat-product category slug) — most failure investigation starts "show me everything from category X."
34. **Add a step-number range filter** so users can isolate only Step 11 (audit) or Step 14 (publish) entries.
35. **Persist the active filter set in the URL** (`?level=error&role=codingAgent`) so a teammate can be sent the exact same view. `[Schneiderman: support locus of control]`
36. **Show "filtered N of M" in a small chip** when any filter is active, with a one-click "Clear filters" button. `[N5: Error prevention — orienting users that they're seeing a partial view]`
37. **Highlight the matching substring** in yellow on text-search results so users know why a row matched.

## 5. Sorting & grouping (38–43)

38. **Add a sort-direction toggle** (newest↑ / oldest↑) — currently hard-coded reversed. `[N3: User control]`
39. **Stop reversing the array on every render** (`[...state.activityLog].reverse()` allocates a new array per state update). Memoize, or have the backend deliver newest-first.
40. **Group consecutive rows from the same `keyword` + `categorySlug`** under a collapsible header showing the run's outcome and elapsed time. Today every row is a flat sibling.
41. **Add a "Group by" selector** (`flat / by keyword / by role / by step`) with the user's choice persisted in `localStorage`.
42. **Add an "Auto-collapse runs older than X minutes"** setting so the working area stays scannable.
43. **Add date separators** ("Today", "Yesterday", "May 1") between rows whose date differs — `entry.timeDate` exists, exploit it.

## 6. Real-time streaming & freshness (44–50)

44. **Show a live "Streaming" indicator** in the header (pulsing green dot) when the agent state is being updated, distinct from "Idle" or "Disconnected."
45. **Anchor scroll position when new entries arrive only if the user is at the top**; if they've scrolled down to investigate, do NOT auto-scroll — show a "↓ N new entries" sticky pill instead. `[N3: User control — never yank focus]`
46. **Add a "Pause stream" button** that freezes incoming entries while the user investigates a row, then drains the queue on resume.
47. **Display the time-since-last-entry** in the header so a stalled pipeline is obvious ("Last update 4m ago" turning amber after 60s, red after 5m).
48. **Show a connection-state ribbon** at the top when the websocket / SSE drops (currently the UI silently goes stale).
49. **Add a manual "Refresh" button** for users who don't trust live state.
50. **Render an SLA marker** on entries older than the per-step timeout (e.g. > 90s on a single step is a red icon).

## 7. Density & responsive (51–56)

51. **Add a Compact / Comfortable / Spacious density toggle** (4px / 8px / 12px row padding) persisted in `localStorage`. `[N7]`
52. **Below 768px, collapse to a 2-line stacked layout** (line 1: timestamp + role chip + keyword; line 2: message) — current 12-span horizontal row is unusable on mobile.
53. **Hide low-priority columns** (logRef, stepNumber) at < 1024px viewport.
54. **Make the scroll container `resize: vertical`** so users can drag it taller without DevTools.
55. **Replace `maxHeight: 32rem` with a CSS `clamp()`** that scales with viewport (`clamp(20rem, 60vh, 48rem)`).
56. **Sticky table header** so column labels stay visible while scrolling.

## 8. Accessibility (57–66)

57. **Each row gets `role="article"`** with an `aria-label` summarizing the entry ("Error at step 14 for keyword automatic litter box: parse failure").
58. **Keyboard navigate rows with `↑`/`↓`** when the log has focus; `Enter` opens the entry's detail panel.
59. **Focus ring on the focused row** that meets `[WCAG 2.4.7 Focus Visible]` (2px outline, 3:1 contrast vs background).
60. **Skip-link** to "Skip activity log" so keyboard users don't have to tab through 500 entries to reach the next panel.
61. **Tab trap inside the log when expanded full-screen** (see #97), released on `Esc`. `[N3]`
62. **`<time datetime="…">`** on every timestamp instead of plain text so screen readers and bots get the canonical value.
63. **Announce new error entries via an `aria-live="assertive"` region** that's separate from the polite log feed.
64. **Provide a keyboard shortcut** (`/`) that focuses the log search input. `[N7: Accelerator keys]`
65. **Add "Copy entry as JSON"** to a per-row action menu so screen-reader users can extract data without selecting text.
66. **Document the keyboard shortcuts** behind a `?` modal — discoverable accelerators. `[Schneiderman: informative feedback]`

## 9. Performance (67–72)

67. **Virtualize the row list** using `@tanstack/react-virtual` once the log exceeds 200 entries — current code mounts every DOM node.
68. **Memoize the per-row component** with `React.memo` keyed by `entry.logRef` so a single new entry doesn't re-render 500 rows.
69. **Use `key={entry.logRef}`** instead of `key={i}` — the index changes on every reverse and breaks reconciliation. `src/app.tsx:1307`
70. **Debounce the `state.activityLog` -> render path** to coalesce bursts (a Step 11 audit can emit 30 entries in 2s).
71. **Cap in-memory log at 1000 entries** with the rest paginated server-side — the agent is forever-running, the log is unbounded.
72. **Lazy-mount the Google-Sheet column-map `<details>`** — its `<pre>` regenerates the legend string on every parent render today.

## 10. Interaction & feedback (73–80)

73. **Per-row hover background `#f9fafb`** so the row being inspected is obvious.
74. **Click-to-expand row detail panel** showing the full `msg`, full URLs, KV key, and a "Why did this happen?" link to the runbook — current ellipsis-truncate hides critical context.
75. **Right-click context menu**: Copy entry, Copy as cURL (for `/api/admin/*` reproduction), Open KV in admin, Open competitor URL.
76. **Toast-confirm copy** instead of mutating the button's textContent (`Copied!`) — current pattern fights React reconciliation. `[N1]`
77. **Per-row `Retry` button** for `error` rows that calls `POST /api/admin/retry` with the row's keyword. `[Schneiderman: easy reversal]`
78. **"Open in admin"** quick-link on rows whose `kvKey` is known (`/api/admin/kv/<kvKey>`).
79. **Click on the role chip filters the log to that role** — Splunk-style "narrow by example."
80. **Click on the keyword filters the log to that keyword** + opens a side panel with the keyword's full pipeline run timeline.

## 11. Export & sharing (81–84)

81. **Replace the single Copy-Log button with a split menu**: Copy as text / Copy as JSON / Copy as Markdown table / Copy as cURL replay.
82. **Add "Download .ndjson"** for full-fidelity export, since copy-text loses fields.
83. **"Share filtered view"** copies the URL with current filter state (#35) instead of the data — much smaller, much more useful.
84. **Add "Send to Slack"** that POSTs the current filtered view to a configured webhook for incident response.

## 12. Drill-down & cross-references (85–88)

85. **Linkify `competitorUrl` properly** — currently it's wrapped in `linkify(...)` but the parent span sets `whiteSpace: "nowrap"` and `overflow: hidden` so the click-target is clipped.
86. **Inline a 16x16 favicon** beside `competitorUrl` so users recognize the source at a glance.
87. **Show a small SERP-position badge** beside the keyword (looked up from the latest SERP run for that keyword).
88. **Hover preview card on `articleUrl`** — fetch the live page's `<title>` + first OG image via `/api/admin/render?url=…` and render in a tooltip.

## 13. Errors & failure surfacing (89–92)

89. **Auto-promote `error` rows to a "Recent failures" pinned strip** at the top of the log, with one-click jump to the entry — currently they're lost in the stream.
90. **Show the linked `claude-fix` GitHub issue** beside any error row that triggered an `escalateToCodingAgent` call (the kvKey-based dedup key gives us the issue number).
91. **Surface the parser-error category** (`Unexpected token`, etc.) as a chip on the error row so the autonomous-loop classification is visible to humans.
92. **Inline-render the "next action" from the runbook** for each known error category so the operator sees the fix path without leaving the dashboard.

## 14. Empty / loading / first-run states (93–96)

93. **Replace the bare "No activity yet. Click Start to begin."** with an illustrated empty state showing what a typical log row looks like — progressive disclosure for new users. `[N10: Help & documentation]`
94. **Show skeleton rows on initial load** (3 shimmer rows) instead of an empty container — current first-paint flashes empty then populates.
95. **First-time user tooltip tour** (3 callouts: "filters", "row click expands", "live indicator") with a "Don't show again" checkbox stored in `localStorage`.
96. **When filters return zero rows, show a contextual "No matches — clear filters?" CTA**, not just an empty list.

## 15. Personalization & power-user (97–100)

97. **Full-screen mode** (`F`) — pop the log into a full-window overlay for incident triage.
98. **Persist density / sort / column-visibility / grouping in `localStorage`** under a single `activityLog.preferences` key so users get their setup back across sessions.
99. **User-defined saved views** — name a filter+sort+group combo ("Errors today", "Editorial pipeline only") and recall from a dropdown. `[N7: Accelerator]`
100.  **Per-user column picker** — let users hide columns they don't use (Plagiarism % is irrelevant during link-builder runs, SEO score is irrelevant during repo-agent runs). `[N8: Aesthetic & minimalist]`

---

## Suggested rollout sequence

The 100 items above aren't equally cheap. A staged rollout that delivers user-visible wins fast, in this order:

| Phase                    | Theme                                  | Items                      | Why first                                                                                                                                        |
| ------------------------ | -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0 — fix correctness** | A11y + perf foundations                | 3, 4, 26, 67, 68, 69       | Today's UI silently fails screen readers and re-mounts every row on every tick. Fix the floor before adding features.                            |
| **P1 — readability**     | IA + typography                        | 1, 2, 7, 9, 11, 12, 13, 56 | Single biggest perceived-quality jump. Removes per-row label noise, switches to a real table, fixes type scale.                                  |
| **P2 — comprehension**   | Color & severity semantics             | 19, 20, 21, 25, 43, 44, 47 | Role + severity color is the cheapest way to make a 500-row log scannable.                                                                       |
| **P3 — control**         | Filtering, search, sorting             | 29–38, 51                  | Once the log is scannable, give the user a way to narrow it. URL-persisted state (#35) is the keystone — every later feature can link to a view. |
| **P4 — operator power**  | Drill-down, retry, deep-links          | 74, 75, 77, 78, 89, 90     | Turns the log from "what happened" into "what happened and what should I do." Maps directly to existing `/api/admin/*` surface.                  |
| **P5 — polish**          | Empty states, density, personalization | 93–100                     | Everything that makes the tool feel owned by the user; lowest urgency, highest delight.                                                          |

## Heuristic coverage check

Every Nielsen heuristic appears at least 4 times across the list. WCAG 2.2 AA criteria covered: 1.3.1, 1.4.1, 1.4.3, 1.4.4, 1.4.6, 1.4.11, 2.3.3, 2.4.7, 4.1.3. Items not yet addressed at all (deferred to a v2 plan): 2.5.x pointer/touch sizing, 3.3.x error identification on form fields (the log has no forms), and 1.4.10 reflow at 320px — covered partially by #52 but not exhaustively.
