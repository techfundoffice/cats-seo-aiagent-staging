# Upstream

Vendored from https://github.com/paulmassen/seo-playground at commit
`3bb182869f48a39724edfa2f9567d2b9ce9db8dd`.

## Local deltas vs upstream

- `src/lib/db.ts` rewritten for Cloudflare D1 (async). All exported functions
  return `Promise<T>`; `getCloudflareContext().env.DB` replaces the
  `better-sqlite3` handle.
- All 27 importers of `@/lib/db` had `await` inserted on every call site.
- `next.config.ts` calls `initOpenNextCloudflareForDev()`; the
  `serverExternalPackages: ['better-sqlite3']` entry is removed.
- `package.json` drops `better-sqlite3` / `@types/better-sqlite3`, adds
  `@opennextjs/cloudflare` and `wrangler`, replaces `start` with `preview`,
  adds `deploy` and `cf-typegen` scripts.
- `env.d.ts` declares `CloudflareEnv { DB: D1Database }` to match the
  wrangler binding.
- `open-next.config.ts` + `wrangler.jsonc` + `migrations/0001_init.sql` added
  for the Cloudflare Workers deploy.

## Syncing from upstream later

1. Diff upstream's `src/` against `seo-playground/src/` at the recorded SHA.
2. Cherry-pick non-db changes directly.
3. For any new `@/lib/db` calls upstream adds, cascade `await` through them.
4. For any new DB table upstream adds, append a new migration
   (`migrations/0002_*.sql`) — never edit `0001_init.sql` after first deploy.
5. Bump the SHA above.
