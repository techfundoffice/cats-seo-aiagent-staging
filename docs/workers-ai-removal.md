# Workers AI removal (staging)

The `ai` binding is gone from `cats-seo-aiagent-staging` and must stay gone.
It bills Cloudflare Regular Twitch Neurons. Production removed the same
binding; this staging worker follows that pattern. See the production note
in `techfundoffice/cats-seo-aiagent-cloudflare` (`docs/workers-ai-removal.md`)
for the invoice that prompted the removal.

## What calls a model now

| Former Workers AI path            | Now                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Category scout                    | Claude via `runScoutChat`                                                                                                                                 |
| Design-audit vision               | Claude via `analyzeScreenshotWithVision`                                                                                                                  |
| Article / QC / polish / SISS text | Claude via `getKimiModel` / `runKimiWithPoll`                                                                                                             |
| FLUX hero and product images      | Nothing. Claude cannot generate images. `generateAndStoreHeroImage` returns null. `og:image` falls through product photo → YouTube thumbnail → site logo. |

`scripts/verify-design-audit.mts` checks Browser Rendering only. It does not
call the Workers AI REST API.

`scripts/doppler-to-wrangler-bulk.py` skips `CLOUDFLARE_WORKERS_AI_TOKEN`, so
a deploy does not install that secret on the worker.

## What must not come back

- An `ai` binding in any `wrangler.jsonc` / `wrangler.toml` in this repo
- `AI: Ai` on `Cloudflare.Env` in `env.d.ts` (do not "fix" a missing binding
  by re-running `npm run types` after putting the binding back in wrangler —
  that file is hand-augmented)
- `env.AI`, `envBindings.AI`, `/ai/run`, `@cf/` models, or `createWorkersAI`
  under `src/` or `scripts/`

`src/pipeline/__tests__/workers-ai-removed.test.ts` fails `npm run check` if
any of those return. The historical log label `credential-workers-ai-rate`
stays: it classifies old activity-log lines and does not call a model.

OpenAI embeddings stay. They are not Workers AI.
