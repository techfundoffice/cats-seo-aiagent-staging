#!/usr/bin/env node
/**
 * Promote staging sitemap articles that already clear the production bar
 * into the production ARTICLES_KV namespace.
 *
 * The worker (POST /api/admin/promote-backlog) reads each article from
 * staging KV, keeps the existing PROD_PUBLISH_MIN_SCORE gate (default 90),
 * rewrites the staging host to PROMOTION_TARGET_DOMAIN, inserts `/reviews`
 * on two-segment article paths, and PUTs `category:slug` into production KV.
 * A ledger score is authoritative. Articles with no usable ledger score are
 * rescored with calculateSEOScore. Scores under the bar stay staging-only.
 *
 * `--allow-unscored-completed` publishes completed staging HTML only when a
 * score cannot be computed. It does not publish articles that scored under
 * the bar.
 *
 * Run after this revision is deployed (push to main → GitHub Actions →
 * Cloudflare). Credentials stay in Doppler; this script only needs the
 * admin bearer the worker already checks.
 *
 *   export ADMIN_API_TOKEN="$(doppler secrets get ADMIN_API_TOKEN --plain \
 *     --no-read-env --project replit-n8n-catsluvus --config prd)"
 *   npm run promote:prod -- --dry-run
 *   npm run promote:prod -- --apply
 *
 * Optional:
 *   --base URL          default: staging workers.dev host
 *   --limit N           articles fetched per request (1–15, default 5)
 *   --allow-unscored-completed
 *   PROMOTE_BASE_URL, PROMOTE_BATCH_LIMIT
 */

const DEFAULT_BASE =
  "https://cats-seo-aiagent-staging.webmaster-bc8.workers.dev";

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function printHelp() {
  console.log(`Usage: npm run promote:prod -- [--dry-run | --apply] [options]

  --dry-run                     Count and preview. Default when --apply is omitted.
  --apply                       Write eligible articles to production KV, then prune
                                the staging sitemap of redirecting URLs.
  --allow-unscored-completed    Also ship staging HTML when no score can be computed.
                                Does not lower PROD_PUBLISH_MIN_SCORE.
  --base URL                    Worker origin. Or set PROMOTE_BASE_URL.
  --limit N                     Batch size 1–15 (default 5).

Env: ADMIN_API_TOKEN (required).`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

const apply = args.includes("--apply");
const token = process.env.ADMIN_API_TOKEN?.trim() ?? "";
const base = (
  argValue("--base") ||
  process.env.PROMOTE_BASE_URL ||
  DEFAULT_BASE
).replace(/\/+$/, "");
const limitRaw = argValue("--limit") || process.env.PROMOTE_BATCH_LIMIT;
const limit = limitRaw ? Number(limitRaw) : undefined;
const allowUnscoredCompleted = args.includes("--allow-unscored-completed");

if (!token) {
  console.error(
    "ADMIN_API_TOKEN is not set. Read it from Doppler (project replit-n8n-catsluvus, config prd) and export it. This script does not write production KV itself; the deployed worker does."
  );
  process.exit(1);
}

async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: text.slice(0, 300) };
  }
  if (!res.ok || json.ok === false) {
    const detail =
      typeof json.error === "string" ? json.error : text.slice(0, 300);
    throw new Error(
      `${method} ${pathname} failed (HTTP ${res.status}): ${detail}`
    );
  }
  return json;
}

function addSkipped(total, skipped) {
  if (!skipped) return;
  for (const key of Object.keys(total)) {
    total[key] += Number(skipped[key] ?? 0);
  }
}

const skipped = {
  alreadyPromoted: 0,
  belowBar: 0,
  unscored: 0,
  missingHtml: 0,
  invalidKey: 0,
  publishFailed: 0
};
let promoted = 0;
let batches = 0;
let cursor = "";
let stalledCursor = "";
let stalledRepeats = 0;

console.log(
  `${apply ? "Applying" : "Dry run"} against ${base} (min score is the worker's PROD_PUBLISH_MIN_SCORE; requests cannot lower it).`
);

const summary = await api("/api/admin/promotion-candidates");
console.log(
  `Sitemap articles: ${summary.sitemapArticles}. Ledger ≥ ${summary.minScore}: ${summary.eligibleByLedger}. Below bar: ${summary.belowBar}. Unscored (rescore during the walk): ${summary.unscored}. Already tombstoned: ${summary.alreadyPromoted}.`
);

for (;;) {
  const batch = await api("/api/admin/promote-backlog", {
    method: "POST",
    body: {
      dryRun: !apply,
      cursor,
      ...(Number.isFinite(limit) ? { limit } : {}),
      allowUnscoredCompleted
    }
  });
  batches++;
  promoted += Array.isArray(batch.promoted) ? batch.promoted.length : 0;
  addSkipped(skipped, batch.skipped);
  const stopped = batch.stoppedOn?.kvKey
    ? ` stopped on ${batch.stoppedOn.kvKey}: ${batch.stoppedOn.error}`
    : "";
  console.log(
    `Batch ${batches}: +${batch.promoted?.length ?? 0} eligible, cursor ${batch.nextCursor ?? "(done)"}, minScore ${batch.minScore}.${stopped}`
  );
  if (batch.stoppedOn?.kvKey) {
    if (batch.nextCursor === stalledCursor) stalledRepeats++;
    else {
      stalledCursor = batch.nextCursor ?? "";
      stalledRepeats = 1;
    }
    if (stalledRepeats >= 3) {
      console.error(
        "The same article failed production KV write 3 times. Stopping so the rest of the backlog is not skipped. Fix the error above and re-run; completed keys stay tombstoned and will be skipped."
      );
      process.exit(1);
    }
  } else {
    stalledRepeats = 0;
    stalledCursor = "";
  }
  if (batch.done) break;
  cursor = typeof batch.nextCursor === "string" ? batch.nextCursor : cursor;
  if (!batch.stoppedOn && cursor === "" && !batch.done) {
    console.error("Backlog batch returned an empty cursor before finishing.");
    process.exit(1);
  }
}

console.log(
  `Done in ${batches} batch(es). ${apply ? "Promoted" : "Would promote"}: ${promoted}. Skipped below bar: ${skipped.belowBar}. Unscored: ${skipped.unscored}. Missing HTML: ${skipped.missingHtml}. Already promoted: ${skipped.alreadyPromoted}. Publish failures: ${skipped.publishFailed}.`
);

if (apply) {
  const pruned = await api("/api/admin/sitemap/prune", {
    method: "POST",
    body: { dryRun: false }
  });
  console.log(
    `Staging sitemap prune: removed ${pruned.removed ?? 0} redirecting entr${pruned.removed === 1 ? "y" : "ies"} (${pruned.before ?? "?"} → ${pruned.after ?? "?"}).`
  );
  console.log(
    "Production URLs are https://catsluvus.com/reviews/{category}/{slug}. Confirm a promoted URL returns 200 before treating the backlog as live."
  );
} else {
  console.log("Dry run only. Re-run with --apply to write production KV.");
}
