/**
 * Copy the staging KV backlog into production ARTICLES_KV.
 *
 * Pages POST /api/admin/promote-backlog. That route lists article keys
 * still present, skips redirect tombstones, and calls
 * publishArticleToProduction only when article_ledger.seo_score is
 * >= PROD_PUBLISH_MIN_SCORE (default 90). It does not rescore HTML.
 *
 * Dry run is the default. --apply writes. Both need ADMIN_API_TOKEN and
 * a deployed worker that contains this route. Wrangler does not invoke
 * the Durable Object; `npx wrangler deployments status` only confirms
 * the version after the main deploy.
 *
 *   curl -sS -X POST \
 *     "https://cats-seo-aiagent-staging.webmaster-bc8.workers.dev/api/admin/promote-backlog" \
 *     -H "Authorization: Bearer $ADMIN_API_TOKEN" \
 *     -H "Content-Type: application/json" \
 *     -d '{"dryRun":true,"limit":10}'
 *
 *   npm run promote:backlog -- --dry-run
 *   npm run promote:backlog -- --apply
 */

export {};

const STAGING_HOST = "cats-seo-aiagent-staging.webmaster-bc8.workers.dev";
const WORKER_BASE = `https://${STAGING_HOST}`;

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function printHelp(): void {
  console.log(`Usage: npm run promote:backlog -- [--dry-run | --apply] [--limit N]

  --dry-run     Ask the worker to select keys and rewrite HTML. Default.
  --apply       Write eligible keys to production KV, then prune the sitemap.
  --limit N     Stop after N promoted keys (each request is clamped to 15).
  --base URL    Worker origin. Default: ${WORKER_BASE}

Requires ADMIN_API_TOKEN (Doppler project replit-n8n-catsluvus, config prd).

One batch, no writes:

curl -sS -X POST \\
  "${WORKER_BASE}/api/admin/promote-backlog" \\
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"dryRun":true,"limit":10}'

Apply is the same body with "dryRun": false. Loop on nextCursor until done.
npx wrangler deployments status confirms the deploy; it does not write KV.`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

const apply = args.includes("--apply");
const limitRaw = Number(argValue("--limit") ?? "0");
const totalLimit =
  Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;

const token = process.env.ADMIN_API_TOKEN?.trim() ?? "";
if (!token) {
  console.error(
    "ADMIN_API_TOKEN is not set. Read it with: doppler secrets get ADMIN_API_TOKEN --plain --no-read-env --project replit-n8n-catsluvus --config prd"
  );
  process.exit(1);
}

const base = (
  argValue("--base") ||
  process.env.PROMOTE_BASE_URL ||
  WORKER_BASE
).replace(/\/+$/, "");

async function api(
  pathname: string,
  body: unknown
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { ok: false, error: text.slice(0, 300) };
  }
  if (!res.ok || json.ok === false) {
    const detail =
      typeof json.error === "string" ? json.error : text.slice(0, 300);
    throw new Error(`${pathname} failed (HTTP ${res.status}): ${detail}`);
  }
  return json;
}

console.log(
  `${apply ? "Applying" : "Dry run"} via ${base}. Ledger score gate is the worker PROD_PUBLISH_MIN_SCORE.`
);

let cursor = "";
let promoted = 0;
let stalled = 0;
let stalledCursor = "";

for (;;) {
  const remaining = totalLimit > 0 ? totalLimit - promoted : 15;
  if (totalLimit > 0 && remaining <= 0) break;
  const batchLimit = Math.min(15, remaining);
  const batch = await api("/api/admin/promote-backlog", {
    dryRun: !apply,
    cursor,
    limit: batchLimit
  });
  const rows = Array.isArray(batch.promoted) ? batch.promoted.length : 0;
  promoted += rows;
  const skipped = batch.skipped as
    | {
        alreadyPromoted?: number;
        belowBar?: number;
        unscored?: number;
      }
    | undefined;
  console.log(
    `Batch +${rows} (promoted ${promoted}), skipped tombstone ${skipped?.alreadyPromoted ?? 0} below ${skipped?.belowBar ?? 0} unscored ${skipped?.unscored ?? 0}, cursor ${String(batch.nextCursor ?? "(done)")}, done=${String(batch.done)}`
  );
  const stopped = batch.stoppedOn as
    | { kvKey?: string; error?: string }
    | undefined;
  if (stopped?.kvKey) {
    const next = String(batch.nextCursor ?? "");
    if (next === stalledCursor) stalled += 1;
    else {
      stalledCursor = next;
      stalled = 1;
    }
    if (stalled >= 3) {
      console.error(`Stopped on ${stopped.kvKey}: ${stopped.error ?? ""}`);
      process.exit(1);
    }
  } else {
    stalled = 0;
  }
  if (batch.done === true) break;
  const nextCursor =
    typeof batch.nextCursor === "string" ? batch.nextCursor : "";
  if (!nextCursor || nextCursor === cursor) {
    console.error("Backlog cursor did not advance.");
    process.exit(1);
  }
  cursor = nextCursor;
}

console.log(`${apply ? "Promoted" : "Would promote"}: ${promoted}.`);
if (apply && promoted > 0) {
  const pruned = await api("/api/admin/sitemap/prune", { dryRun: false });
  console.log(`Staging sitemap prune removed ${String(pruned.removed ?? 0)}.`);
}
if (!apply) {
  console.log(
    'Dry run only. Re-run with --apply to write production KV. One batch: curl -sS -X POST "' +
      base +
      '/api/admin/promote-backlog" -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" -d \'{"dryRun":false,"limit":10}\''
  );
}
