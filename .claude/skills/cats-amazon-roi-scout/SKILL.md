---
name: cats-amazon-roi-scout
description: >
  Scout and rank Amazon-affiliate cat product niches and buyer-intent keywords
  for catsluvus.com using ROI proxies (commission ceiling, demand, difficulty).
  Use when improving category discovery, scout prompts, keyword lists, or
  explaining why a niche ranks higher than another.
metadata:
  version: "1.0.0"
---

# Cats Amazon ROI Scout

## North star

Maximize **expected affiliate commission per 1,000 visitors** (not raw search volume alone). In automation without Ahrefs/Amazon APIs, use **LLM-scored proxies** and label uncertainty explicitly.

## Phase A — Category (Worker: `scoutHighTicketCategory`)

Pick a **cat** product **Amazon** niche (slug like `cat-...`) that combines:

1. **Revenue ceiling** — Typical **AOV** in a band that supports meaningful commission per sale (often **$100+** mix is a strong signal for durable cat gear; adjust for true consumables).
2. **Commission band** — Amazon Associates **category rate** for the product type (luxury/durable vs consumables).
3. **Buyer-intent surface area** — Enough **distinct** high-intent keyword families (`best X for Y`, `under $Z`, `X vs Y`, reviews) without repeating the same intent.
4. **SERP / moat** — Room for independent sites (not only Amazon + megaretailers for every query); room for comparison tables, safety/fit guidance (cats: materials, escape-proofing, welfare).
5. **Ops friction** — Penalize vet/medical **claims risk**, heavy returns, or policy traps.

### Category score (tunable)

Score each axis **0–10** (decimals allowed). Default weights sum to **1**:

| Axis                | Symbol | Meaning                                    |
| ------------------- | ------ | ------------------------------------------ |
| RevenuePotential    | R      | ASP × commission intent                    |
| DemandClarity       | D      | Diversity of buyer-intent angles           |
| CompetitionPressure | C      | Easier SERP for independents scores higher |
| ContentMoat         | M      | Depth: tables, safety, sizing              |
| OpsFriction         | F      | Lower friction scores higher               |

**CategoryROI_score = 0.25×R + 0.25×D + 0.15×C + 0.20×M + 0.15×F** (defaults; tune in prompts if needed).

**Ranking:** Among valid candidates, highest **CategoryROI_score**; tie-break **R**, then **D**. Never emit a `slug` in the SQLite exclusion list as the winner—use **alternates** next.

## Phase B — Keywords (Worker: `generateKeywords`)

For each candidate keyword (human workflow uses tools; LLM simulates a shortlist):

1. **Buyer-intent patterns:** `best [product] for [use case]`, `best [product] under [price]`, `[product] review`, `[product] vs [competitor]`, `affordable [product]`, `where to buy [product]` — all **cat-relevant**, no medical guarantees.
2. **SEO viability (proxy):** favor keywords where an independent could rank (low–medium difficulty vs mega-domains only).
3. **Amazon proxies:** representative **price band**, inferred **commission %**, **demand** (reviews / velocity as proxy).
4. **Gates:** drop keywords where implied **commission per sale** is trivially low or demand looks dead.

### Commission opportunity score (keyword-level)

Let **volume** = monthly search estimate (exact or cluster note), **KD** = difficulty (≥1), **avgCommissionPerSale** = price × rate proxy, **relativeDemand** ∈ [0,1].

**CommissionOpportunityScore = (volume × avgCommissionPerSale × relativeDemand) / KD**

Sort descending. Prefer keywords that maximize **commission per 1k visitors** when combined with realistic CTR/cart assumptions.

## Tool vs LLM lanes

| Lane              | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| ToolBacked        | Ahrefs, SEMrush, Amazon SERP, Associates rate tables          |
| LLMProxy          | Model-estimated R/D/C/M/F or volume/KD/price—state confidence |
| FutureIntegration | Reserved for wiring real APIs                                 |

## Worker prompt excerpts (keep in sync with code)

### Excerpt A — `src/pipeline/scout.ts`

Embedded in `buildScoutRoiPrompt(...)` next to the `generateText` call. Must require **one** primary object plus **alternates** array, all with **unique** slugs not in `ALREADY_DONE`.

### Excerpt B — `src/pipeline/keywords.ts`

Embedded in `generateKeywords` prompt: bias toward buyer-intent, Amazon purchase readiness, and implied commission opportunity; forbid affiliate/discount jargon.

## Further reading (operators)

- Amazon Associates program category rates and policies.
- General affiliate keyword workflow resources (search volume + difficulty + commercial intent).
