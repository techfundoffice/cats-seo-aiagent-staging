# Staging repo — `cats-seo-aiagent-staging`

This is an **independent** repo split out from
`techfundoffice/cats-seo-aiagent-cloudflare` (production). It deploys the
**staging** Cloudflare Worker `cats-seo-aiagent-staging`. The application
source (`src/`) is identical to production at the split point; only the
deploy configuration and the resources it binds to differ.

## What changed vs the production repo

| File                     | Change                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.jsonc`         | Now the **staging** config (was `wrangler.staging.jsonc`). Worker name `cats-seo-aiagent-staging`, staging KV/D1/R2/queue IDs, `DOMAIN=cats-seo-aiagent-staging.webmaster-bc8.workers.dev`, cron **off**, no `PETINSURANCE` service binding. |
| `wrangler.staging.jsonc` | **Removed** — redundant now that the staging config is canonical.                                                                                                                                                                            |
| `vite.staging.config.ts` | **Removed** — the default `vite.config.ts` builds against `wrangler.jsonc`, which is now staging.                                                                                                                                            |
| `package.json`           | `name` → `cats-seo-aiagent-staging`.                                                                                                                                                                                                         |

Everything else (the 24-step pipeline in `src/pipeline/`, the React dashboard,
the skills subsystem, CI workflows) is unchanged.

## Resource isolation

Every stateful binding points at a **fresh** resource, so this worker never
touches production data:

- KV `ARTICLES_KV` → `f98fb459875c40009492867275b666bf`
- D1 `SKILLS_DB` → `cats-seo-skills-staging` (`07709ff7-c593-471a-9271-4a26c01a58bc`)
- R2 `IMAGES_R2` → `seo-images-staging`
- Queue `SKILL_FETCH_QUEUE` → `skill-fetch-staging` (+ `-dlq`)

Same Cloudflare account (`bc8e15f958dc350e00c0e39d80ca6941`) and zone as
production.

## Required setup before deploy works

This repo does **not** carry secrets. To make CI (`.github/workflows/deploy.yml`)
deploy on push to `main`, set these **GitHub Actions repository secrets**:

- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — Cloudflare deploy creds
- `DOPPLER_TOKEN` — for the Doppler → `wrangler secret bulk` step

Worker runtime secrets (`OPENROUTER_API_KEY`, `ADMIN_API_TOKEN`,
`DASHBOARD_PASSWORD`, product/SERP API keys, etc.) are pushed from Doppler by
CI, or set manually per `CLAUDE.md` § Cloudflare Worker Secret Management.

**Deliberately left unset:** `GITHUB_TOKEN_SECRET`. Without it the worker's
autonomous coding-agent escalation stays dormant, so this staging repo will not
open GitHub issues or assign Copilot. Set it only if you want that loop here.

## Deploy

```bash
npm ci
npm run check          # oxfmt + oxlint + tsc + vitest
npx vite build
npx wrangler deploy    # deploys cats-seo-aiagent-staging (default wrangler.jsonc)
```

Or push to `main` and let `.github/workflows/deploy.yml` run it.

<!-- ci-trigger: verify push->Actions deploy wiring -->

## Browser Rendering (set 2026-07-22)

Worker secret `CLOUDFLARE_API_TOKEN_SECRET` is set (token
`github_cats-seo-aiagent-staging` with Account → Browser Rendering → Edit).
Enables: Design Audit (Step 15), post-publish live-leak check, content
fingerprint gate, editorial screenshot audits, and `/api/admin/render`.
Note: `/api/admin/render` only accepts `catsluvus.com` URLs (prod-domain
allowlist inherited from the shared source).
