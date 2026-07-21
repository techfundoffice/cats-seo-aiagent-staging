# Software specification: Activity log Google Sheet header sync and verification

**Document type:** Implementation and verification spec (pre-execution).  
**Status:** Draft — **operator decisions (§14)** + **second AI remediation pass (§16)**. No production or sheet changes are implied by this file alone.  
**Authoring context:** Written from repository source at `cats-seo-aiagent-cloudflare`; live sheet state was previously observed via Composio MCP read (row 1 ended at `FW`, 179 visible header cells, no `#n QC AI prompt` columns).

**Architecture decision (2026-04-17):** Adopt **Option C** — **append** all `#n QC AI prompt` headers **after** the 100 score headers (block layout), instead of interleaving score/prompt pairs. This matches the “only add new headers / don’t rearrange score header positions” constraint **without** inserting 100 physical columns.

---

## 1. Purpose

### 1.1 Problem

The **activity log mirror** tab row 1 must match the **canonical header list** computed in TypeScript so that:

1. **Data rows** written by the Worker can be **permuted** correctly from logical column order to physical column order using row 1 titles ([`resolveActivityLogColumnPermutation`](src/activityLogSheetLayout.ts)).
2. **SEO tail (Option C — operator-selected)** adds **200 trailing columns** for SEO: **100** score headers (check `name`), then **100** headers `#1 QC AI prompt` … `#100 QC AI prompt` (see §14).

If row 1 remains on the **older** layout (~179 columns through `FW`), the sheet **does not** expose the new `#id QC AI prompt` headers even when application code already implements the prompt column **block** (after code is updated per §15).

### 1.2 Goals

| ID  | Goal                                                                                                                                                            | Measurable                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Row 1 of tab `cats-seo-aiagent-cloudflare` lists **exactly** `buildActivityLogSheetCanonicalHeaderTitles().length` headers in **canonical order**               | `GOOGLESHEETS_BATCH_GET` / `VALUES_GET` returns one row whose string sequence **byte-for-byte equals** canonical array (trim rules below)             |
| G2  | **SEO tail layout (Option C):** after **`MCP Tool`**, **100 contiguous score headers**, then **100 contiguous `#n QC AI prompt` headers** (`n = 1..100`)        | Row 1 substring matches `getSeoScorecardCheckNames()` block then `#1`…`#100` prompt block in order                                                    |
| G3  | **No silent partial writes**: if API returns truncated range or fewer cells than canonical length, treat as **failure**                                         | Automated check compares `live.length` to `canonical.length`                                                                                          |
| G4  | **Reversibility / audit**: operator can restore prior row 1 from backup (see §7)                                                                                | Backup artifact exists before write                                                                                                                   |
| G5  | **Second AI remediation pass** may read **`#n QC AI prompt` cells** (or in-memory equivalents) and feed them to `generateText` as the **full** formatted prompt | End-to-end test: failing check yields a non-empty cell containing `SYSTEM:` + `USER:`; second pass logs distinct `sheetPipelineStepLabel` (see §16.5) |
| G6  | **Per-check sheet cells** store the **assembled** remediation prompt (QC hint + metadata + bounded HTML), not hints alone                                       | Parser or golden test asserts `formatActivityLogModelPromptCell` shape for ≥1 failed check                                                            |

### 1.3 Non-goals

- **Backfilling** historical sheet rows with QC hint text where the first pass never ran (optional batch job; out of scope unless added to §16).
- Changing **Composio** or **Google OAuth** configuration.
- **Re-deriving** remediation context from scratch when the sheet cell already contains the **full** formatted prompt (optional duplicate work; assembly is implemented in code today).
- Modifying **Worker** business logic beyond what §15 (layout) and §16 (remediation pass) describe.

---

## 2. Definitions

### 2.1 Systems

| Term                  | Definition                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker**            | Cloudflare Worker + Durable Object [`SEOArticleAgent`](src/server.ts) that mirrors logs via Composio `execute(...)`.                                  |
| **Canonical headers** | Output of [`buildActivityLogSheetCanonicalHeaderTitles()`](src/activityLogSheetColumns.ts): `string[]` in logical column order.                       |
| **Logical column**    | Index `0 .. ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT - 1` used in code (`buildSheetLogRow`).                                                           |
| **Physical column**   | Google Sheet column `A`, `B`, … after optional permutation against row 1.                                                                             |
| **MCP (operator)**    | Cursor **user-composio** Composio MCP tools (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, etc.) using the user’s connected Google account. |

### 2.2 Target spreadsheet (observed; confirm before write)

| Field                 | Value                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Spreadsheet title** | `AI CEO OF CATS LUV US` (as returned by Drive search; **confirm in UI before destructive steps**)          |
| **spreadsheet_id**    | `1kTh9-ppWnp-drjgdpA7sOO1qGNrSwL8KMMUTqMJHEjw`                                                             |
| **webViewLink**       | `https://docs.google.com/spreadsheets/d/1kTh9-ppWnp-drjgdpA7sOO1qGNrSwL8KMMUTqMJHEjw/edit`                 |
| **Worksheet tab**     | `cats-seo-aiagent-cloudflare` (must match [`ACTIVITY_LOG_SHEET_TAB_NAME`](src/activityLogSheetColumns.ts)) |

**Critical:** If the production mirror points at a **different** `googleSheetUrl` in the Durable Object, updates to this file are **wrong target**. Operator must confirm the URL configured in the dashboard / DO state matches this spreadsheet.

### 2.3 Constants (source of truth)

From [`src/activityLogSheetColumns.ts`](src/activityLogSheetColumns.ts):

- `ACTIVITY_LOG_SEO_CHECK_COUNT = 100`
- `formatSeoScorecardQcAiPromptHeader(id) => \`#${id} QC AI prompt\``
- `ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT = ACTIVITY_LOG_SEO_CHECK_BASE_LOGICAL_INDEX + 2 * ACTIVITY_LOG_SEO_CHECK_COUNT`

**Derived (current layout math in repo):**

- Prefix **A–R**: 18 columns (`ACTIVITY_LOG_SHEET_COLUMN_LABELS_A_TO_PREFIX`)
- Middle: Kanban 8 + Article 4 + AE–AF 2 + Agent block 18 + GitHub block 18 + **8 reserved blanks** = 58 → cumulative 76 before status block (see `buildActivityLogSheetHeaderMiddleRow`)
- Status block **BU_BV**: 3 columns (`Agent status`, `Dashboard URL`, `MCP Tool`)
- **SEO block (Option C — block layout):** 200 columns = **100 score names** from `getSeoScorecardCheckNames()` **then** **100** headers `#1 QC AI prompt` … `#100 QC AI prompt` (via `formatSeoScorecardQcAiPromptHeader`)

**Logical column count:**  
`18 + 58 + 3 + 200 = 279` → last **1-based** column index **279**.

**A1 notation for full header range:**  
`'cats-seo-aiagent-cloudflare'!A1:` + `sheetColumnIndex1BasedToA1Letters(279)` + `1`  
For `279`, [`sheetColumnIndex1BasedToA1Letters`](src/activityLogSheetColumns.ts) yields **`JS`**.  
So full range = **`'cats-seo-aiagent-cloudflare'!A1:JS1`**.

> **Note:** [`src/server.ts`](src/server.ts) line ~130 comment still says `A:FW`; that comment is **stale** relative to layout v28 and should be updated in a separate doc-only change after this workstream settles.

### 2.4 Layout version (Worker state)

[`ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION = 28`](src/server.ts) — when `SEOAgentState.activityLogSheetHeaderLayoutVersion` is lower, [`ensureActivityLogSheetHeaders`](src/server.ts) calls [`writeActivityLogSheetHeaders`](src/server.ts) with `matchLiveHeaderOrder: false`, which writes **canonical physical order** (identity permutation) for the full `activityLogSheetHeaderFullRowRange()`.

**Implication:** If someone **manually** fixes row 1 via MCP, the DO might still think headers are “current” (version 28) and **skip** rewriting until the constant bumps again. That is acceptable if row 1 is correct; otherwise reset version in DO or bump constant (out of scope unless required).

---

## 3. Functional requirements

### 3.1 Canonical header generation (FR-1)

**FR-1.1** The canonical array MUST be produced by calling `buildActivityLogSheetCanonicalHeaderTitles()` from the same commit that is deployed (or intended to be deployed) for mirroring. **After Option C implementation**, that function MUST emit the **block** SEO tail (scores then prompts), not interleaved pairs.

**FR-1.2** The function MUST throw if:

- `getSeoScorecardCheckNames().length !== 100`, or
- Duplicate score header titles, or
- Duplicate `#n QC AI prompt` titles.

**FR-1.3** Serialization for tools:

- Each cell is a **string** (empty string allowed where defined in builder; trailing empties may be omitted by Google APIs—see §5.2).
- No HTML. No RichText. Plain string values only for `USER_ENTERED` updates.

### 3.2 Sheet write (FR-2) — optional paths

Two **allowed** implementation paths; pick **one** per run (never both concurrently):

| Path    | Actor                 | Mechanism                                                                                                                                                          | When to use                                                  |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **P-A** | Worker / DO           | `writeActivityLogSheetHeaders` via Composio `GOOGLESHEETS_VALUES_UPDATE` as in [`server.ts`](src/server.ts)                                                        | Production-normal; requires mirror write + version skew      |
| **P-B** | Operator / automation | Composio MCP `GOOGLESHEETS_VALUES_UPDATE` with identical `range`, `values`, `value_input_option: USER_ENTERED`, `major_dimension: ROWS`, `auto_expand_sheet: true` | Emergency alignment, CI dry-run, or when DO will not refresh |

**FR-2.1** Update range MUST be exactly:

```text
'cats-seo-aiagent-cloudflare'!A1:{LAST_A1}1
```

where `{LAST_A1} = sheetColumnIndex1BasedToA1Letters(ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT)` (currently `JS`).

**FR-2.2** `values` MUST be a single row: `[physicalRow]` where `physicalRow.length === canonical.length` before API call (pad trailing empty strings if needed so API receives explicit empties through the SEO tail).

**FR-2.3** `auto_expand_sheet` MUST be `true` so the grid grows if the spreadsheet’s column count is smaller than required.

### 3.3 Verification (FR-3)

**FR-3.1 Read-back (MCP or Worker)**  
After any write, issue `GOOGLESHEETS_BATCH_GET` with:

```text
ranges: ["'cats-seo-aiagent-cloudflare'!A1:JS1"]
```

(or the computed last column for the commit).

**FR-3.2 Length check**  
Let `live` be `valueRanges[0].values[0]` after normalization (pad ragged row to `canonical.length` with `""`).

**Pass if** `live.length === canonical.length`.

**FR-3.3 Content check**  
**Strict equality** per index `i`: `canonical[i] === live[i]` **after** defining normalization:

- **N1:** If Google omits trailing empty cells, **pad** `live` with `""` until length `canonical.length`.
- **N2:** No trimming of internal spaces in titles (titles are exact).
- **N3:** If Google returns fewer than `canonical.length` cells **after padding is impossible** (missing interior cells), **fail**.

**FR-3.4 Spot checks (human + automated)**

| Check                   | Expected                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Column after `MCP Tool` | First SEO score name (check id 1 name from `getSeoScorecardCheckNames()[0]`)                                                                                               |
| Next column             | `#1 QC AI prompt`                                                                                                                                                          |
| Two columns before end  | `#99 QC AI prompt`, `#100 QC AI prompt` paired with their score headers (order: …, score99, prompt99, score100, prompt100) — verify last four strings match canonical tail |

**FR-3.5 Local verifier script**  
Run [`scripts/verify-activity-log-headers-vs-canonical.mts`](scripts/verify-activity-log-headers-vs-canonical.mts) with a JSON file containing **only** the string array for row 1:

```bash
npx tsx scripts/verify-activity-log-headers-vs-canonical.mts path/to/live-row1.json
```

**Exit code 0** required. Any mismatch prints `mismatch index …` to stderr.

---

## 4. Interfaces

### 4.1 Composio (MCP) — read

| Tool slug                      | Inputs                                     | Output path                     |
| ------------------------------ | ------------------------------------------ | ------------------------------- |
| `GOOGLESHEETS_GET_SHEET_NAMES` | `spreadsheet_id`                           | Confirms tab exists             |
| `GOOGLESHEETS_BATCH_GET`       | `spreadsheet_id`, `ranges: ['tab!A1:JS1']` | `data.valueRanges[0].values[0]` |

### 4.2 Composio (MCP) — write

| Tool slug                    | Inputs                                                                                            | Notes                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GOOGLESHEETS_VALUES_UPDATE` | `spreadsheet_id`, `range`, `values`, `value_input_option`, `major_dimension`, `auto_expand_sheet` | Must match Worker payload shape in [`writeActivityLogSheetHeaders`](src/server.ts) |

**Session handling:** Composio MCP requires `session_id` from `COMPOSIO_SEARCH_TOOLS` responses; follow Composio’s instructions for the active session.

### 4.3 Operator script (recommended helper)

| Artifact                                                                        | Responsibility                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `scripts/dump-activity-log-canonical-headers.mts` (optional; may already exist) | Writes `headers` + `range` JSON to a temp file for inspection **before** upload |
| `scripts/tmp-canonical-headers.json`                                            | **Gitignored** local artifact; never commit secrets; may be large               |

---

## 5. Edge cases and API behavior

### 5.1 Tab quoting

Tab name `cats-seo-aiagent-cloudflare` has **no spaces**; A1 may use `cats-seo-aiagent-cloudflare!A1:JS1` **or** quoted `'cats-seo-aiagent-cloudflare'!A1:JS1`. Prefer **quoted** form for consistency with [`server.ts`](src/server.ts) `activityLogSheetTabQuoted()` behavior.

### 5.2 Ragged rows

Google Sheets APIs often return **ragged** rows (trailing empty cells omitted). Verification **must pad** (§3.3).

### 5.3 Column grid limits

If `GOOGLESHEETS_VALUES_UPDATE` returns an error that the range exceeds grid limits, **stop**. Remediation: widen spreadsheet columns in UI or use `auto_expand_sheet` (already required). If still failing, document `gridProperties.columnCount` from `GOOGLESHEETS_GET_SPREADSHEET_INFO`.

### 5.4 Rate limits

Composio documents strict Sheets quotas. Verification should use **one** read after **one** write in the same minute where possible.

---

## 6. Security and permissions

- **Principle of least privilege:** Use the same Google account already connected to Composio for this project (`techfundoffice@gmail.com` was shown in MCP metadata previously; **verify** current connection).
- **No secrets in repo:** Do not commit service account JSON, refresh tokens, or Composio API keys into `tmp-*.json` or specs.
- **Spreadsheet ACL:** Writer role required for `VALUES_UPDATE`; reader sufficient for verification reads.

---

## 7. Risk assessment and mitigation

| Risk                                                   | Severity     | Mitigation                                                                                                   |
| ------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------ |
| Wrong `spreadsheet_id`                                 | **Critical** | Human confirms URL against dashboard `googleSheetUrl` before write                                           |
| Overwrites customized row 1 labels                     | **High**     | Backup row 1 to JSON/file **before** write (MCP `BATCH_GET`); store in secure location                       |
| Permutation logic misaligns if row 1 partially updated | **High**     | Write **full** `A1:JS1` in one call; verify full length after                                                |
| Concurrent Worker write races                          | **Medium**   | Pause autonomous loop / avoid mirroring during maintenance window; or accept last-writer-wins with re-verify |
| Stale `server.ts` comment `A:FW` misleads operators    | **Low**      | Fix comment after layout stable                                                                              |

---

## 8. Rollback procedure

1. Restore row 1 from **backup JSON** captured in §7 using `GOOGLESHEETS_VALUES_UPDATE` with the **exact** previous `values` array and the same `range` width as backup (may be `A1:FW1` for legacy).
2. Re-run §3.3 verification against **legacy** expected array (store legacy array alongside backup when taking snapshot).
3. If DO layout version needs to match operational policy, adjust state per runbook (out of scope here—document in ops runbook).

---

## 9. Test plan (acceptance)

| Step | Action                                                     | Pass criterion                                                                                                                             |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| T0   | Confirm `googleSheetUrl` in app points at §2.2 spreadsheet | URL `/d/{id}/` matches                                                                                                                     |
| T1   | `GET_SHEET_NAMES`                                          | Tab `cats-seo-aiagent-cloudflare` exists                                                                                                   |
| T2   | `BATCH_GET` `A1:JS1` **before** change                     | Save `before.json`; record `live.length` and tail columns                                                                                  |
| T3   | Compare `before` tail to canonical                         | Expect mismatches in SEO tail if sheet outdated                                                                                            |
| T4   | `VALUES_UPDATE` canonical row                              | HTTP/tool success object                                                                                                                   |
| T5   | `BATCH_GET` `A1:JS1` **after** change                      | `verify-activity-log-headers-vs-canonical.mts` exits 0                                                                                     |
| T6   | Spot-check `#1 QC AI prompt`                               | Present at index `ACTIVITY_LOG_SEO_CHECK_BASE_LOGICAL_INDEX + 100` (first prompt column after score block) when physical order is identity |

---

## 10. Observability

- **Worker:** [`pushSheetBridgeLog`](src/server.ts) entries for header refresh / missing titles (when using Worker path).
- **MCP:** Retain Composio `log_id` from tool responses for support tickets.

---

## 11. Documentation debt (post-verify)

1. Update stale `A:FW` comment in [`src/server.ts`](src/server.ts) to dynamic `A1:${SHEET_LAST_COLUMN_A1}1` or “see `ACTIVITY_LOG_SHEET_LOGICAL_COLUMN_COUNT`”.
2. Optionally add ops section to root `CLAUDE.md`: “How to re-sync activity log row 1” with link to this spec.

---

## 12. Open questions (require human answers before execution)

1. **Spreadsheet target** — **RESOLVED (operator):** `1kTh9-ppWnp-drjgdpA7sOO1qGNrSwL8KMMUTqMJHEjw` is the correct production mirror.
2. **Header change policy** — **UPDATED (operator constraint):** “Never delete any headers; only add new headers in the header row.”

---

## 13. Constraint: “additive-only” vs interleaved layout (must read)

### 13.1 What the code on `main` did **before** Option C (historical)

[`buildActivityLogSheetCanonicalHeaderTitles()`](src/activityLogSheetColumns.ts) (pre-Option-C) built the **SEO tail** as **interleaved** pairs:

`scoreName1`, `#1 QC AI prompt`, `scoreName2`, `#2 QC AI prompt`, …

**After Option C is implemented (§15)**, the canonical builder MUST emit the **block** order instead (scores then prompts).

### 13.2 What the live sheet had when inspected

Row 1 ended with **100 contiguous score headers** (no `#n QC AI prompt` columns between them). Call that the **legacy contiguous** SEO tail.

### 13.3 Why “only append 100 new columns at the far right” did NOT match the app **before** Option C

If we **only add** headers **after** the 100 existing score columns (legacy order), the physical order becomes:

`score1 … score100`, then `#1 QC … #100 QC`.

That **used to** disagree with the shipped interleaved implementation (scores/prompts alternating). **After Option C (§15)**, the repository **will** match this append order; the sheet can then be extended without inserting columns between score headers.

### 13.4 What “overwrite row 1 with full canonical” actually does to existing score **titles**

For the **100 score name** cells, a full canonical `VALUES_UPDATE` typically **writes the same strings again** (they come from the same `getSeoScorecardCheckNames()` source). That is not “deleting headers” in the sense of removing check names; it is **refreshing** those cells and **inserting new title cells between them** only if the **sheet gains new physical columns** in the right places.

**However:** moving from **legacy contiguous scores-only** layout to **interleaved** layout **did** change the **meaning of physical columns** for **existing data rows (row 2+)** unless data was migrated. **Option C avoids interleaving** and preserves the **first 100 SEO columns** as scores, so historical score cells remain aligned with score headers; new prompt columns start empty until new mirroring fills them.

### 13.5 Operator-safe interpretations of “never delete headers”

| Interpretation                                                                                                                                             | Feasible with current repo layout?                                                                | Notes                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A) Do not remove the **100 score header strings**; only add `#n QC AI prompt` **between** them                                                             | **Requires column insertions** (or full-sheet migration), not a single `A1:JS1` value write alone | Insert 100 columns (right-to-left) so each prompt column sits next to its score; **high risk** to formulas and row data; needs a dedicated migration spec                                                                           |
| B) Accept a **single-row** `VALUES_UPDATE` that **re-writes** row 1 from `A1` through `JS1` with canonical strings (score names unchanged where identical) | **Yes**, matches Worker behavior                                                                  | Does **not** remove score **names**, but **does replace the entire header row’s cell contents** in that range and may **extend** the grid; **historical body columns** may still be misaligned until rows are rewritten or migrated |
| C) Change **application layout** to “100 scores then 100 prompts” (append-only headers)                                                                    | **Requires code change**                                                                          | Canonical builder, `buildSheetLogRow`, and possibly permutation tests must be updated to match                                                                                                                                      |

**Decision (2026-04-17):** Operator selected **Option C** (see §14). Execution of sheet verification MUST wait until §15 code changes are merged and `ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION` is bumped.

---

## 14. Decision log

| Date (UTC) | Decision                       | Rationale                                                                                                                                                                         |
| ---------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-17 | **Spreadsheet target**         | Operator confirmed `1kTh9-ppWnp-drjgdpA7sOO1qGNrSwL8KMMUTqMJHEjw` is the production mirror.                                                                                       |
| 2026-04-17 | **Header policy**              | Operator: avoid deleting existing headers; prefer additive change.                                                                                                                |
| 2026-04-17 | **Layout strategy = Option C** | Append **100** `#n QC AI prompt` headers **after** the **100** score headers (block layout). Requires repository changes (§15) before sheet and Worker are consistent.            |
| TBD        | **Second AI remediation pass** | Operator: add a **second** Workers AI run **driven from** the new `#n QC AI prompt` columns / same hint strings — spec §16 (assembly required; cells are hints not full prompts). |

---

## 15. Implementation delta for Option C (repository)

**Goal:** Align TypeScript canonical headers + `buildSheetLogRow` + legend/docs with **block** SEO tail (scores then prompts).

**Dependency:** §16 (sheet-driven remediation) assumes row 1 titles and `buildSheetLogRow` physical mapping match **Option C**; implement §15 before relying on fixed A1 offsets for hint columns.

### 15.1 Files / symbols to change

| Area              | File                                                                                   | Change                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical headers | [`src/activityLogSheetColumns.ts`](src/activityLogSheetColumns.ts)                     | `buildActivityLogSheetCanonicalHeaderTitles()`: append **all** `seoNames` in order, then for `id = 1..100` append `formatSeoScorecardQcAiPromptHeader(id)`. Update duplicate-detection to treat uniqueness across the **combined** 200 tail cells. |
| Legend            | [`src/activityLogSheetColumns.ts`](src/activityLogSheetColumns.ts)                     | `getActivityLogSheetColumnLegendLines()`: replace “paired / interleaved” wording with **scores block then prompts block**.                                                                                                                         |
| Sheet row builder | [`src/server.ts`](src/server.ts)                                                       | `buildSheetLogRow`: map score `i` to `base + i`, prompt `i` to `base + ACTIVITY_LOG_SEO_CHECK_COUNT + i` for `i ∈ [0,99]` (verify all former `base + 2*i` / `base + 2*i + 1` sites).                                                               |
| Layout version    | [`src/server.ts`](src/server.ts)                                                       | Bump `ACTIVITY_LOG_SHEET_HEADER_LAYOUT_VERSION` so DOs refresh row 1 on next mirror after deploy.                                                                                                                                                  |
| Comments          | [`src/server.ts`](src/server.ts)                                                       | Remove stale `A:FW` examples; reference `SHEET_LAST_COLUMN_A1`.                                                                                                                                                                                    |
| QC prompts        | [`src/pipeline/seo-scorecard-qc-prompts.ts`](src/pipeline/seo-scorecard-qc-prompts.ts) | Array stays length **100**; confirm no assumptions about interleaved **sheet** columns (prompt index `i` maps to sheet logical index `base + 100 + i`).                                                                                            |
| Tests / scripts   | repo-wide search                                                                       | Search for “interleaved”, “2\*i”, “paired”, layout v28 narrative; update any assertions on header order.                                                                                                                                           |

### 15.2 Verification gates (post-merge)

1. `npm run check`
2. Deploy to production **or** run Worker locally with Composio against a **copy** tab first (recommended for paranoid runs).
3. `GOOGLESHEETS_BATCH_GET` on `'cats-seo-aiagent-cloudflare'!A1:JS1'` — confirm contiguous score block then `#1 QC AI prompt` … `#100 QC AI prompt`.
4. `npx tsx scripts/verify-activity-log-headers-vs-canonical.mts live-row1.json` → exit code **0**.

### 15.3 Sheet write note (additive-friendly)

If live row 1 already contains the **100 score headers** in the correct order, an operator **may** `VALUES_UPDATE` **only** the new range for the prompt block (compute A1 letters for columns `base+100` through `base+199` inclusive, 1-based) **provided** the grid already has / can expand to those columns. **Simpler / safer:** write full `A1:JS1` once after code deploy (still leaves score title strings identical if names unchanged).

---

## 16. Second AI run (“remediation pass”) driven from `#n QC AI prompt` columns

**Operator intent:** Add a **second** Workers AI pass that is **driven from** the new per-check columns (i.e. the same **fix-hint strings** that land in `#1 QC AI prompt` … `#100 QC AI prompt` on failing checks).

This section is **additive** to §15 (layout). §15 must ship first so column titles and `buildSheetLogRow` alignment match **Option C** before any sheet-driven reader assumes stable physical positions.

### 16.1 What the sheet cells are (full remediation prompt)

Per [`generateSeoScorecardQcPromptCells`](src/pipeline/seo-scorecard-qc-prompts.ts) and [`buildSheetLogRow`](src/server.ts):

- Each non-empty `#n QC AI prompt` cell (when the paired score is `0`) holds a **full `modelPrompt`-style string**: `formatActivityLogModelPromptCell(system, user)` where **system** is the remediation model contract and **user** bundles keyword/title/meta, the failing check metadata, the batched QC **hint** text, and a **bounded slice of article HTML** so a follow-up `generateText` can run **without** re-assembling context from other columns.
- Cells are still **truncated** to [`ACTIVITY_LOG_SHEET_PROMPT_MAX_CHARS`](src/activityLogSheetColumns.ts) when persisting to Sheets (HTML budget shrinks first so the string stays under the cap where possible).

**Ready-made?** **Yes for a second `generateText` call** (split system/user exactly as in the cell, or pass the combined string per your Workers AI wrapper). Downstream code **may** parse `SYSTEM:` / `USER:` blocks or call the same helper conventions the dashboard uses.

### 16.2 Functional requirements

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R16-1 | **Source of hints:** Implementation MUST support at least one path: **(A)** in-DO `lastSeoScorecardQcPromptCells` + `lastSeoScorecard` immediately after first pass; **(B)** read hints from the **mirrored sheet row** for a given `logRef` / article URL (Composio `GOOGLESHEETS_*`). Path **B** matches “driven off columns” literally; path **A** is simpler and avoids stale-row hazards. Product MAY ship **A** first, then **B**. |
| R16-2 | **Eligibility:** Only checks with **score `0`** and **non-empty `#n QC AI prompt` cell** participate in a sheet-driven remediation read (same as today’s mirror write rules).                                                                                                                                                                                                                                                            |
| R16-3 | **Assembly (sheet cells):** Implemented in [`generateSeoScorecardQcPromptCells`](src/pipeline/seo-scorecard-qc-prompts.ts) (remediation `SYSTEM` + `USER`, embedded batched QC hint, bounded HTML). The **second** `generateText` may treat the cell as the **full** prompt payload without re-assembly, subject to model API input conventions.                                                                                         |
| R16-4 | **Truncation:** Sheet persistence uses [`ACTIVITY_LOG_SHEET_PROMPT_MAX_CHARS`](src/activityLogSheetColumns.ts); HTML slice shrinks until the formatted cell fits (see `shrinkHtmlUntilFitsFormattedBudget` in the same module).                                                                                                                                                                                                          |
| R16-5 | **Persistence:** Define where output goes: e.g. new activity-log message, new KV draft, new sheet column family, or email — **not** left only in ephemeral RAM.                                                                                                                                                                                                                                                                          |
| R16-6 | **Observability:** Log via `agent.log(..., "qaReviewer", { modelPrompt, sheetPipelineStepLabel })` with a **distinct** `sheetPipelineStepLabel` (e.g. `10/15: SEO remediation AI`) so sheet/dashboard mirrors show the second pass distinctly.                                                                                                                                                                                           |

### 16.3 Suggested implementation phases

1. **Phase 1 — Same-process full prompts (path A):** After `generateSeoScorecardQcPromptCells` returns in [`generateArticle`](src/pipeline/writer.ts), optionally invoke `runSeoRemediationPass(agent, { checks, qcPromptCells, … })` **before** publish or **after** publish per product choice. `qcPromptCells[i]` is already the **full** formatted remediation prompt for failed checks. No sheet read required.
2. **Phase 2 — Sheet-driven (path B):** Callable method (e.g. `@callable()` on [`SEOArticleAgent`](src/server.ts)) that accepts `logRef` or article URL, uses Composio to `BATCH_GET` the activity row, resolves column indices via row 1 permutation ([`resolveActivityLogColumnPermutation`](src/activityLogSheetLayout.ts)), extracts hint cells + score cells, then runs the same assembler as Phase 1.
3. **Phase 3 — Operator UX:** Dashboard button or sheet action column to trigger Phase 2 without redeploying (optional).

### 16.4 Risks specific to sheet-driven path (B)

| Risk                                   | Mitigation                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong row selected (`logRef` drift)    | Require **Reference Number** column match + article URL match before running                                                                                           |
| Prompt truncated in sheet vs in-memory | Document max cell length vs `ACTIVITY_LOG_SHEET_PROMPT_MAX_CHARS` and `PER_HINT_CHAR_CAP` in [`seo-scorecard-qc-prompts.ts`](src/pipeline/seo-scorecard-qc-prompts.ts) |
| Stale hints after manual sheet edits   | Treat sheet as source of truth only after explicit operator trigger; log raw extracted hints hash                                                                      |

### 16.5 Verification (remediation pass)

| Step               | Pass criterion                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V16-1              | With **synthetic** failing checks, `generateSeoScorecardQcPromptCells` yields a cell string containing `SYSTEM:`, `USER:`, the check **id**, and embedded QC hint text |
| V16-2              | `generateText` completes or surfaces structured error; **no** silent empty success                                                                                     |
| V16-3              | Activity log / sheet shows **second** `qaReviewer` entry with distinct `sheetPipelineStepLabel`                                                                        |
| V16-4 (optional B) | `BATCH_GET` round-trip: prompt cells read from sheet equal in-memory `lastSeoScorecardQcPromptCells` for the same run (modulo truncation)                              |

### 16.6 Files likely touched (initial estimate)

| File                                                                                              | Role                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| New e.g. [`src/pipeline/seo-scorecard-remediation.ts`](src/pipeline/seo-scorecard-remediation.ts) | Assembler + `generateText` call(s)                                                                                           |
| [`src/pipeline/writer.ts`](src/pipeline/writer.ts)                                                | Wire Phase 1 trigger + pass results into `ArticleResult` if needed                                                           |
| [`src/server.ts`](src/server.ts)                                                                  | Optional `@callable()` Phase 2 + Composio read helpers; extend `ArticleResult` / state only if persisting remediation output |
| Tests under `src/` or `tests/`                                                                    | Assembler + golden-string tests for prompt shape                                                                             |

_(Exact filenames are suggestions; follow existing repo conventions.)_

---

## Appendix A — Worker reference (read-only)

Header write call shape from [`writeActivityLogSheetHeaders`](src/server.ts):

```ts
exec("GOOGLESHEETS_VALUES_UPDATE", {
  spreadsheet_id: spreadsheetId,
  range: activityLogSheetHeaderFullRowRange(), // 'tab'!A1:{LAST}1
  values: [physical],
  value_input_option: "USER_ENTERED",
  major_dimension: "ROWS",
  auto_expand_sheet: true
});
```

`physical` equals `canonical` when `matchLiveHeaderOrder` is false and permutation is identity.

---

**End of specification.**
