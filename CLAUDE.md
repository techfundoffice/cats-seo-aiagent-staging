# CLAUDE.md — Development Rules

> **⚠️ STAGING REPO — COMPOSIO REMOVED (2026-07-22).** This repo no longer
> uses Composio anywhere: no `@composio/*` deps, no `.mcp.json`, no
> `COMPOSIO_API_KEY`. Direct integrations replace it:
> - **Google Sheets mirror** → `src/pipeline/google-sheets-direct.ts`
>   (service account via `GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON`)
> - **Doppler reads** (OpenRouter key self-heal) → Doppler REST API via
>   `DOPPLER_TOKEN` worker secret
> - **Editorial screenshots** → Cloudflare Browser Rendering via
>   `CLOUDFLARE_API_TOKEN_SECRET`
> - **Quora posting** → permanently dry-run (no public Quora API)
> Sections below that mention Composio/Rube bootstrap are legacy prod-repo
> context — do not follow them in this repo.

## Sandbox Bootstrap

**Every new Claude session running in this repo auto-connects to Composio via `.mcp.json` at the repo root.** That file maps to `https://connect.composio.dev/mcp` with `x-consumer-api-key: ${COMPOSIO_API_KEY}` — this is the official post-Rube endpoint, protocol version `2024-11-05`. After the bootstrap below, Composio tools are available in-session without any CLI.

```bash
source .claude/secrets.env                                    # loads COMPOSIO_API_KEY (gitignored file)
# MCP server at https://connect.composio.dev/mcp is now live for this
# session via .mcp.json env-var interpolation. No `composio` CLI needed.
```

**Verification.** A single JSON-RPC `initialize` call confirms the MCP endpoint is alive and your key is valid:

```bash
curl -sS -X POST \
  -H "x-consumer-api-key: $COMPOSIO_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.1"}}}' \
  "https://connect.composio.dev/mcp"
# 200 + `event: message` / `"serverInfo":{"name":"mcp-typescript server on vercel"}` = good
# 401 = key dead, ask user for a fresh one; do NOT silently continue.
```

The secrets file `.claude/secrets.env` is gitignored and must be created by pasting a valid `COMPOSIO_API_KEY` (format: `ck_...`). Doppler-via-Composio is the source of truth for every other secret.

**Optional (post-Rube Doppler CLI path):**

```bash
curl -Ls https://cli.doppler.com/install.sh | sudo sh    # no-op if already installed
```

Doppler CLI is only needed if a script wants `doppler run --` style subprocess env injection. For one-off secret fetches, call the Composio Doppler tools directly (the MCP auto-loads them).

### Pulling any Doppler secret

Project: `replit-n8n-catsluvus`. Only config: `prd`. Bash one-liner sessions reuse:

```bash
composio tool run doppler DOPPLER_SECRETS_GET --project replit-n8n-catsluvus --config prd --name <KEY>
# or, equivalent via Rube MCP in-session:
#   RUBE_MULTI_EXECUTE_TOOL → DOPPLER_SECRETS_GET { project, config, name }
```

## Connected Composio Toolkits

Inventory verified on 2026-04-22. Active toolkits can be used immediately with no further auth.

| Toolkit              | Status                                 | Useful tools                                                                                                                                                                                                                     | Notes                                                                                                                                                                                             |
| -------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doppler`            | ✅ ACTIVE (workplace `techfundoffice`) | `DOPPLER_AUTH_ME`, `DOPPLER_PROJECTS_LIST`, `DOPPLER_CONFIGS_LIST`, `DOPPLER_SECRETS_NAMES`, `DOPPLER_SECRETS_GET`, `DOPPLER_SECRETS_LIST`                                                                                       | All project secrets live here. Only project: `replit-n8n-catsluvus`, only config: `prd`.                                                                                                          |
| `github`             | ✅ ACTIVE (user `techfundoffice`)      | `GITHUB_CREATE_OR_UPDATE_A_REPOSITORY_SECRET` (requires libsodium sealed-box encrypt — `npm i --no-save libsodium-wrappers`), `GITHUB_GET_A_REPOSITORY_PUBLIC_KEY`, `GITHUB_LIST_REPOSITORY_SECRETS`, plus PR/issue/commit tools | Use for repo-secret management; don't rely on `gh` CLI (not installed).                                                                                                                           |
| `firecrawl`          | ✅ ACTIVE (~999k credits)              | `FIRECRAWL_SCRAPE`                                                                                                                                                                                                               | Connected but currently unused. Live `catsluvus.com/<slug>` rendering is done via `GET /api/admin/render` (Cloudflare Browser Rendering `/content`). Keep for future off-site competitor scrapes. |
| `apify`              | ✅ ACTIVE                              | `APIFY_*`                                                                                                                                                                                                                        | Apify actor runs + their own KV stores (not Cloudflare KV).                                                                                                                                       |
| `cloudflare`         | ❌ NOT CONNECTED                       | zone/DNS/WAF only                                                                                                                                                                                                                | Even when connected, does NOT expose worker secret writes. For CF worker secrets use the pattern in § Cloudflare Worker Secret Management below.                                                  |
| `cloudflare_api_key` | ❌ NOT CONNECTED                       | DNSSEC/rulesets only                                                                                                                                                                                                             | Same limitation.                                                                                                                                                                                  |

**Native (non-Composio) Cloudflare MCP in-sandbox** (`mcp__8fea7797*`): read-only on Workers (`workers_list`, `workers_get_worker`, `workers_get_worker_code`), full CRUD on D1/KV/R2/Hyperdrive, **no secret writes**.

**Rube MCP sunset: 2026-05-15.** Already migrated — the checked-in `.mcp.json` points every session at `https://connect.composio.dev/mcp` (official Composio MCP) authenticated with `${COMPOSIO_API_KEY}` from `.claude/secrets.env`. Same toolkits, different entrypoint. The `mcp__1ef630dd-*__RUBE_*` tools still work in current sessions but will disappear after the sunset; prefer the Composio-branded tools when both are available.

## Cloudflare Worker Secret Management

No MCP tool exposes worker secret writes. The pattern sessions use:

```bash
# Pull CF creds from Doppler-via-Composio (drop to RUBE_MULTI_EXECUTE_TOOL if composio CLI is unavailable)
CF_ACCOUNT=$(composio tool run doppler DOPPLER_SECRETS_GET --project replit-n8n-catsluvus --config prd --name CLOUDFLARE_ACCOUNT_ID --json | jq -r .data.value.raw)
CF_TOKEN=$(composio tool run doppler DOPPLER_SECRETS_GET --project replit-n8n-catsluvus --config prd --name CLOUDFLARE_API_TOKEN --json | jq -r .data.value.raw)

# PUT the secret (worker must already be deployed)
curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/workers/scripts/cats-seo-aiagent/secrets" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"<NAME>","text":"<VALUE>","type":"secret_text"}'
```

Success response: `{"result":{"name":"<NAME>","type":"secret_text"},"success":true,...}`. Used once in commit `0bb6a5d`-follow-up to push `ADMIN_API_TOKEN` to the live worker.

## Autonomous Execution Policy

You are the lead engineer for this repository.

Do NOT stop to ask for prioritization decisions, implementation choices, tradeoff decisions, or next-step approval unless:

1. Data loss is possible.
2. Production credentials are required and not already available via the documented Doppler-via-Composio path.
3. A payment or irreversible external action is required.
4. Multiple options have materially different business consequences.

Otherwise:

- Select the highest-leverage option yourself.
- Implement it.
- Commit it.
- Open the PR (non-draft, auto-merge enabled).
- Continue to the next logical task.
- Explain your reasoning after the work is completed, not before.

When multiple tasks exist, priority order:

1. Security
2. Reliability
3. Tests
4. Observability
5. Performance
6. Features
7. Refactoring

Assume approval for:

- Test creation
- Refactoring
- Bug fixes
- CI improvements
- Monitoring improvements
- Documentation updates

Do NOT ask:

- "Which option should I choose?"
- "Should I proceed?"
- "What would you like next?"

Instead make the decision and continue. The user redirects when they disagree; silence is consent within the scope above.

## Honesty Rules

1. **Never claim something works unless you tested it.** "Code compiles" is not "it works." Say exactly what you verified and what you didn't.
2. **Never say "fixed" for runtime behavior you can't test.** Say "code change committed — needs deploy to verify."
3. **If you can't test something, say so immediately.** Don't wait to be called out. State the gap upfront.
4. **Don't guess at system state.** Check before answering. Run the command, read the file, query the API. If you can't check, say "I don't know — I can't verify that from here."
5. **Don't present assumptions as facts.** If you're inferring, say "I believe" or "based on the code." If you verified, say "I confirmed by running X."

## Development Rules

- **Ship to production via GitHub Actions, not ad-hoc Wrangler.** Pushing to **`main`** runs `.github/workflows/deploy.yml` (`npm ci`, `npm run check`, `npx vite build`, `npx wrangler deploy` with repo secrets). After a code change, **merge to `main` and push** so CI deploys to Cloudflare—do not treat manual deploy as the default loop.
- **Manual Wrangler (optional):** Only for **bypassing CI** or **recovering from a failed deploy**, run `npx vite build && npx wrangler deploy` with your own Cloudflare credentials (often from Doppler locally). Same flow if you need to prove a build before CI picks it up.
- **Doppler for secrets.** Use `doppler secrets get <KEY> --plain --no-read-env` to retrieve credentials for local Wrangler or tooling. Never hardcode secrets.
- **Article HTML → GitHub backup:** set Worker secret `GITHUB_TOKEN_SECRET` (repo + `actions:write` if you use workflow dispatch). Optional `GITHUB_ARTICLE_BACKUP_REPOSITORY` as `owner/repo` (default `techfundoffice/catsluvus-cloudflare-kv-backup`). Cloudflare: `wrangler secret put GITHUB_TOKEN_SECRET` (and optional backup repo string) or Doppler → Wrangler.
- **Always run `npm run check` before committing.** This runs `oxfmt --check . && oxlint src/ && tsc`. All three must pass.
- **Commit directly to main** unless told otherwise.
- **Format after editing.** Run `npx oxfmt --write .` after making changes. The config is in `.oxfmtrc.json` (printWidth: 80, trailingComma: none).

## Project Stack

- **Runtime:** Cloudflare Workers (Durable Objects + KV + R2 + Workers AI)
- **Agent Framework:** `agents` package (Cloudflare Agents SDK)
- **AI SDK:** `ai` package v6 (Vercel AI SDK) — uses `maxOutputTokens` not `maxTokens`, `stopWhen: stepCountIs(n)` not `maxSteps`
- **UI:** React 19 + TailwindCSS + inline styles
- **Build:** Vite + Wrangler
- **Secrets:** Doppler CLI
- **CI:** GitHub Actions — `sanity-check.yml` (lint/types on PRs), `deploy.yml` (build + deploy on push to main)

## Architecture Notes

- `SEOArticleAgent` extends `Agent<Env, SEOAgentState>` as a Durable Object
- `DurableObject.env` is protected — pipeline functions use `agent.envBindings` (public getter)
- SQLite is Durable Object-local — migrations run in `onStart()` using `PRAGMA table_info` to detect missing columns
- All `generateText()` calls use Kimi K2.5 via `getKimiModel(env)` from `src/pipeline/kimi-model.ts` — OpenRouter when `OPENROUTER_API_KEY` is set, Workers AI otherwise. Both paths pass `chat_template_kwargs: { thinking: false, enable_thinking: false, clear_thinking: true }` (or the OpenRouter equivalent) to kill Kimi's thinking-overflow empty-response bug. Raw-binding sites use `runKimiWithPoll(env, ...)` from the same file.

## Autonomous Coding Agent Loop

This repo has a **GitHub Copilot Coding Agent**-powered auto-heal loop that runs without human copy-paste. **Do not break it.** Components:

1. **`src/pipeline/escalate-to-claude.ts`** — `escalateToCodingAgent(agent, { kvKey, keyword, categorySlug, errorCategory, errorMessage, metadata? })`. Two fire-and-forget side effects:
   1. Opens a GitHub issue labeled `claude-fix` via the worker's `GITHUB_TOKEN_SECRET` binding, with a pre-populated diagnostic runbook in the body (bearer-auth curl commands for `/api/admin/*`).
   2. Immediately calls `POST /repos/:o/:r/issues/:n/assignees` with `["Copilot"]`, which delegates the issue to GitHub Copilot Coding Agent. Copilot reads the runbook, hits the admin API, opens a draft PR titled `[WIP] Fix …` linked to the issue.

   Called from `writer.ts` at every `failResult({ success: false })` site + top-level try/catch + `/api/generate-one` boundary (low-quality-publish threshold). Also auto-fired for parser-error patterns (`Unexpected token`, etc.) from the shared `agent.log()` method via `maybeEscalateParserError`.

   Dedup via KV key `escalation-dedup:<kvKey>:<category>` with 60-min TTL so retry storms don't spam issues. All escalations log to the activity feed under role `codingAgent` ("Coding Agent" in the dashboard).

   **Auth:** uses the user's existing GitHub Copilot subscription — **no Anthropic OAuth token to expire**. Previous `anthropics/claude-code-action@v1` flow was decommissioned because `sk-ant-oat01-…` tokens kept expiring. Historical claude.yml was deleted in the same commit that shipped Copilot delegation.

2. **`/api/admin/*`** — bearer-token-protected surface on the live Worker for Claude to read production state and trigger retries. Auth: `Authorization: Bearer <ADMIN_API_TOKEN>`. Must be listed in `proxyPaths`/prefix check at `src/server.ts:4362` so the top-level fetch handler forwards it to the SEOArticleAgent DO (where the bearer check lives).
   - `GET  /api/admin/logs?limit=N` — last N activity-log entries as JSON.
   - `GET  /api/admin/recent-failures?limit=N` — keywords with status='failed' with their raw Kimi output + published HTML snippets.
   - `GET  /api/admin/kv/<kvKey>` — raw published HTML for a kvKey.
   - `GET  /api/admin/kimi-raw/<kvKey>` — raw Kimi JSON that produced that article (48h TTL).
   - `GET  /api/admin/render?url=<url>` — live post-JS HTML for a `catsluvus.com` page via Cloudflare Browser Rendering `/content`. Use over `/api/admin/kv` when verifying a fix actually landed on the live site.
   - `POST /api/admin/retry` body `{ keyword, purgeKv? }` — reset keyword to pending + optionally purge its KV.

3. **Raw-Kimi capture** — `src/pipeline/writer.ts` writes every Kimi response to KV key `kimi-raw:<kvKey>` with a 48h TTL before parsing, so autonomous diagnoses can see exactly what the model emitted.

4. **Public-page inspection** — Copilot uses `GET /api/admin/render?url=<url>` (bearer-gated, backed by Cloudflare Browser Rendering `/content`) to fetch live post-JS HTML from `https://catsluvus.com/<category>/<slug>` and verify publish output. The pipeline's Step 14 also runs `detectJsonSchemaLeak` against the same live-rendered HTML as a post-publish safety net; a divergence (pre-publish clean, live page leaked) opens a `post-publish-live-leak` escalation.

Trigger autonomous work automatically — the worker opens a `claude-fix` issue AND assigns Copilot whenever an article fails. Humans can also trigger by opening an issue containing `@claude`, labeling an issue `claude-fix`, or manually assigning Copilot to any issue. Do not add polling logic that runs outside these triggers — sessions are not daemons.

## Autonomous Repo Agent

Lives at `.github/workflows/repo-agent.yml`. Owns the gap between "Copilot PR merged to `main`" and "fix is running in production, no regression, branches clean." Same Copilot backend as the Coding Agent — different responsibilities.

Four triggers. **The Repo Agent intentionally does NOT use `workflow_run` for Copilot-authored workflows (Sanity Check / Auto-merge Copilot PRs / Claude).** GitHub inherits the triggering actor into downstream `workflow_run` runs, so a Copilot-triggered Repo Agent run ends up in `conclusion: action_required` itself — self-blocking recursion. Stuck Copilot CI is handled by the 15-min scheduled sweep instead, which runs from `main` and never inherits Copilot authorship.

1. **`workflow_run: Deploy completed`** — the primary trigger. Safe because `Deploy` only runs on `push: main` (repo-owner-authored).
   - On **success**: posts `Deploy ok <sha>` to the dashboard, then runs a 10-minute post-deploy watchdog (samples `/api/admin/recent-failures` every 2 min, flags spikes as possible regressions by opening a `claude-fix` issue with label `regression`).
   - On **failure**: fetches the job log, classifies into one of `deploy-route-limit | deploy-route-conflict | deploy-missing-secret | deploy-bundle-too-large | deploy-wrangler-invalid | deploy-unknown`, opens a `claude-fix` issue with a deploy-specific runbook, assigns Copilot.

2. **`schedule: */15 * * * *`** — housekeeping sweep:
   - **Cross-issue dedup:** groups open `claude-fix` issues by `[auto] <category>:` prefix. If > 3 of the same category are open in the last 2 hours, keeps the oldest and closes the rest as duplicates.
   - **Stale PR sweep:** Copilot PRs with no update in > 3 days get a comment pinging for rebase or confirming supersession.
   - **Secret expiry scan:** greps `/api/admin/logs` for `401 Invalid authentication credentials`. On match, opens a `secret-rotation` issue (deduped by day). Rotation pattern documented in § Cloudflare Worker Secret Management above.

3. **`issues.opened` (label=claude-fix)** — real-time dedup on hot-spot categories. If the new issue's `[auto] <category>:` already has > 3 open from the last hour, closes the new one as `Duplicate of #<oldest>`.

4. **`workflow_dispatch`** — manual kick for debugging.

Every action posts to `POST /api/admin/log-repo-agent` (bearer `ADMIN_API_TOKEN`) so runs appear in the dashboard's "GitHub Repo Agent" panel under role `repoAgent`.

Branch protection on `main` requires `check (ubuntu-24.04)` — the Repo Agent's "direct-push for infra-only fixes" (answered `yes` during v1 design) is in practice "open a tight Copilot PR with auto-merge enabled, merges in <60s when sanity-check goes green." The Repo Agent does NOT force-push or bypass protection. Ever.

## Pull Request Rules

- **Copilot Coding Agent PRs auto-merge.** The `.github/workflows/auto-merge-copilot.yml` workflow fires on `pull_request.opened / ready_for_review / reopened` from the Copilot bot (`Copilot` / `copilot-swe-agent` / `copilot-swe-agent[bot]`). It marks the PR ready (if draft) and calls `enablePullRequestAutoMerge` with `SQUASH`. The required `check (ubuntu-24.04)` status from `sanity-check.yml` still gates the merge — CI failure blocks merge.
- **Never open PRs as draft for human-authored work.** GitHub does not allow auto-merge on draft PRs. Open in "ready for review" state (GraphQL `createPullRequest` with `draft: false`, or REST `POST /repos/:o/:r/pulls` with `"draft": false`). Copilot PRs are an exception — the workflow above flips draft → ready automatically.
- **Manual auto-merge flow** (when needed outside the Copilot path): (1) ensure PR is non-draft, (2) ensure at least one required check is pending, (3) call `enablePullRequestAutoMerge` with `mergeMethod: SQUASH`. If the PR is still draft, first call `markPullRequestReadyForReview(pullRequestId: $id)`.
- **If `enable_auto_merge` returns "Auto-merge is not available"**, the cause is almost always: PR is draft, PR has no pending required checks, PR targets a branch other than `main`, or the PR is already fully mergeable (use the regular merge endpoint instead). Check with `pull_request_read method=get_check_runs`.
- **Existing failed-check PRs don't auto-merge.** A PR with a previously-failed required check (e.g. a `claude` check from the deleted `claude.yml`) needs the branch updated with a new head commit before auto-merge will engage. Either rebase or push a small commit to the PR branch.
