/**
 * Copy staging-completed articles into production ARTICLES_KV.
 *
 * Dry run (default) needs no credentials. It reads the public staging
 * sitemap, scores each live HTML page with calculateSEOScore, and counts
 * how many already clear PROD_PUBLISH_MIN_SCORE (default 90).
 *
 * `--apply` writes those pages to production KV (host rewrite + `/reviews`),
 * tombstones the staging key, and updates the production indexes. It needs
 * CLOUDFLARE_API_TOKEN. This runs from a checkout of this branch; it does
 * not wait for the worker admin route to be deployed.
 *
 * `--via-worker` calls the deployed POST /api/admin/promote-backlog instead.
 * That path needs ADMIN_API_TOKEN and a worker that already contains this
 * revision.
 *
 *   npm run promote:prod -- --dry-run
 *   npm run promote:prod -- --apply
 *   npm run promote:prod -- --via-worker --apply
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  articleEntriesFromSitemap,
  assessStagingArticleForPromotion,
  clampProdPublishMinScore,
  DEFAULT_PROD_ARTICLES_KV_NAMESPACE_ID,
  deleteProdKvValue,
  extractArticleTitleForIndex,
  prepareProductionArticle,
  putProdKvValue,
  registerProdIndexBatch,
  resolveProdPublishMinScore,
  type ProdIndexWrite,
  type ProdKvAuth
} from "../src/pipeline/prod-publish";

const STAGING_HOST = "cats-seo-aiagent-staging.webmaster-bc8.workers.dev";
const PROD_HOST = "catsluvus.com";
const STAGING_KV_NAMESPACE_ID = "f98fb459875c40009492867275b666bf";
const DEFAULT_ACCOUNT_ID = "bc8e15f958dc350e00c0e39d80ca6941";
const WORKER_BASE = `https://${STAGING_HOST}`;
const CURSOR_FILE = ".promote-prod-cursor";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function printHelp(): void {
  console.log(`Usage: npm run promote:prod -- [--dry-run | --apply] [options]

  --dry-run          Score the public staging sitemap. Default.
  --apply            Write eligible HTML to production KV.
  --via-worker       Use the deployed admin API (needs ADMIN_API_TOKEN).
  --limit N          Stop after N sitemap articles (0 = all).
  --min-score N      Stricter than PROD_PUBLISH_MIN_SCORE. Cannot go below it.
  --concurrency N    Dry-run fetch parallelism (default 8).

Apply env: CLOUDFLARE_API_TOKEN (required), CLOUDFLARE_ACCOUNT_ID (optional).
Worker env: ADMIN_API_TOKEN.`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

const apply = args.includes("--apply");
const viaWorker = args.includes("--via-worker");
const allowUnscoredCompleted = args.includes("--allow-unscored-completed");
const limitRaw = Number(
  argValue("--limit") ?? process.env.PROMOTE_BATCH_LIMIT ?? "0"
);
const limit =
  Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;
const concurrency = Math.max(
  1,
  Math.min(16, Number(argValue("--concurrency") ?? "8") || 8)
);
const minScore = clampProdPublishMinScore(
  resolveProdPublishMinScore(process.env.PROD_PUBLISH_MIN_SCORE),
  argValue("--min-score") == null ? undefined : Number(argValue("--min-score"))
);

async function mapPool<T>(
  items: readonly T[],
  workers: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) await fn(item, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, () => run())
  );
}

async function runViaWorker(): Promise<void> {
  const token = process.env.ADMIN_API_TOKEN?.trim() ?? "";
  if (!token) {
    console.error(
      "ADMIN_API_TOKEN is not set. Use the default local dry run, or export the admin bearer for --via-worker."
    );
    process.exit(1);
  }
  const base = (
    argValue("--base") ||
    process.env.PROMOTE_BASE_URL ||
    WORKER_BASE
  ).replace(/\/+$/, "");
  const api = async (
    pathname: string,
    body?: unknown
  ): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
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
  };
  console.log(
    `${apply ? "Applying" : "Dry run"} via ${base} at score >= ${minScore}.`
  );
  let cursor = "";
  let promoted = 0;
  let stalled = 0;
  let stalledCursor = "";
  for (;;) {
    const batch = await api("/api/admin/promote-backlog", {
      dryRun: !apply,
      cursor,
      minScore,
      allowUnscoredCompleted,
      ...(limit > 0 ? { limit: Math.min(limit, 15) } : {})
    });
    const rows = Array.isArray(batch.promoted) ? batch.promoted.length : 0;
    promoted += rows;
    console.log(
      `Batch +${rows}, cursor ${String(batch.nextCursor ?? "(done)")}, done=${String(batch.done)}`
    );
    const stopped = batch.stoppedOn as
      | { kvKey?: string; error?: string }
      | undefined;
    if (stopped?.kvKey) {
      if (String(batch.nextCursor ?? "") === stalledCursor) stalled += 1;
      else {
        stalledCursor = String(batch.nextCursor ?? "");
        stalled = 1;
      }
      if (stalled >= 3) {
        console.error(`Stopped on ${stopped.kvKey}: ${stopped.error ?? ""}`);
        process.exit(1);
      }
    }
    if (batch.done === true) break;
    cursor = typeof batch.nextCursor === "string" ? batch.nextCursor : cursor;
  }
  console.log(`${apply ? "Promoted" : "Would promote"}: ${promoted}.`);
  if (apply) {
    const pruned = await api("/api/admin/sitemap/prune", { dryRun: false });
    console.log(
      `Staging sitemap prune removed ${String(pruned.removed ?? 0)}.`
    );
  }
}

async function runLocal(): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  if (apply && !token) {
    console.error(
      "CLOUDFLARE_API_TOKEN is not set, so production KV cannot be written. Dry run works without it. Read the token from Doppler project replit-n8n-catsluvus config prd."
    );
    process.exit(1);
  }
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || DEFAULT_ACCOUNT_ID;
  const prodAuth: ProdKvAuth | null = token
    ? {
        accountId,
        apiToken: token,
        namespaceId:
          process.env.PROD_ARTICLES_KV_NAMESPACE_ID?.trim() ||
          DEFAULT_PROD_ARTICLES_KV_NAMESPACE_ID
      }
    : null;
  const stagingAuth: ProdKvAuth | null = prodAuth
    ? {
        ...prodAuth,
        namespaceId:
          process.env.STAGING_ARTICLES_KV_NAMESPACE_ID?.trim() ||
          STAGING_KV_NAMESPACE_ID
      }
    : null;

  console.log(`Fetching sitemap https://${STAGING_HOST}/sitemap.xml`);
  const sitemapRes = await fetch(`https://${STAGING_HOST}/sitemap.xml`);
  if (!sitemapRes.ok) {
    throw new Error(`sitemap fetch failed: HTTP ${sitemapRes.status}`);
  }
  let entries = articleEntriesFromSitemap(await sitemapRes.text());
  let cursor = "";
  if (apply) {
    try {
      cursor = readFileSync(CURSOR_FILE, "utf8").trim();
    } catch {
      cursor = "";
    }
  }
  if (cursor) entries = entries.filter((entry) => entry.kvKey > cursor);
  if (limit > 0) entries = entries.slice(0, limit);
  console.log(
    `${apply ? "Applying" : "Dry run"} ${entries.length} staging article(s) at score >= ${minScore}. A live HTML rescore is the gate.`
  );

  let promoted = 0;
  let below = 0;
  let missing = 0;
  let failed = 0;
  let seen = 0;
  const indexEntries: ProdIndexWrite[] = [];

  const flushIndexes = async (): Promise<void> => {
    if (!apply || !prodAuth || indexEntries.length === 0) return;
    const batch = indexEntries.splice(0, indexEntries.length);
    const registered = await registerProdIndexBatch(
      {
        CLOUDFLARE_ACCOUNT_ID: prodAuth.accountId,
        CLOUDFLARE_API_TOKEN: prodAuth.apiToken,
        PROD_ARTICLES_KV_NAMESPACE_ID: prodAuth.namespaceId
      },
      batch
    );
    if (registered.error) {
      console.error(`Index update warning: ${registered.error}`);
    }
  };

  const consider = async (entry: {
    kvKey: string;
    url: string;
  }): Promise<void> => {
    const res = await fetch(entry.url);
    seen += 1;
    if (!res.ok) {
      missing += 1;
      return;
    }
    const html = await res.text();
    const decision = assessStagingArticleForPromotion({
      kvKey: entry.kvKey,
      html,
      minScore,
      ledgerScore: null,
      ledgerKeyword: null,
      hasRedirectTombstone: false,
      allowUnscoredCompleted
    });
    if (!decision.promote) {
      below += 1;
      return;
    }
    if (!apply || !prodAuth || !stagingAuth) {
      promoted += 1;
      return;
    }
    const url = new URL(entry.url);
    const prepared = prepareProductionArticle({
      kvKey: entry.kvKey,
      html,
      fromHost: url.hostname,
      toHost: PROD_HOST
    });
    if (!prepared.ok) {
      failed += 1;
      throw new Error(`${entry.kvKey}: ${prepared.error}`);
    }
    const put = await putProdKvValue(
      prodAuth,
      entry.kvKey,
      prepared.rewritten,
      "text/plain; charset=UTF-8"
    );
    if (!put.ok) {
      failed += 1;
      throw new Error(`${entry.kvKey}: ${put.error}`);
    }
    const tombstone = await putProdKvValue(
      stagingAuth,
      `redirect:${entry.kvKey}`,
      prepared.prodUrl,
      "text/plain; charset=UTF-8"
    );
    if (!tombstone.ok) {
      console.error(
        `Staging tombstone warning for ${entry.kvKey}: ${tombstone.error}`
      );
    }
    await deleteProdKvValue(stagingAuth, entry.kvKey);
    indexEntries.push({
      categorySlug: prepared.categorySlug,
      slug: prepared.slug,
      title: extractArticleTitleForIndex(prepared.rewritten, prepared.slug)
    });
    promoted += 1;
    writeFileSync(CURSOR_FILE, entry.kvKey);
    if (indexEntries.length >= 20) await flushIndexes();
  };

  if (apply) {
    for (const entry of entries) {
      try {
        await consider(entry);
      } catch (err: unknown) {
        await flushIndexes();
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        console.error(
          `Stopped after ${promoted} write(s). Re-run --apply to resume from ${CURSOR_FILE}.`
        );
        process.exit(1);
      }
      if (seen % 25 === 0) {
        console.log(
          `Progress ${seen}/${entries.length}: promote ${promoted}, below bar ${below}, missing ${missing}`
        );
      }
    }
    await flushIndexes();
  } else {
    await mapPool(entries, concurrency, async (entry, index) => {
      await consider(entry);
      if ((index + 1) % 50 === 0) {
        console.log(
          `Progress ${index + 1}/${entries.length}: would promote ${promoted}, below bar ${below}, missing ${missing}`
        );
      }
    });
  }

  console.log(
    `Done. ${apply ? "Promoted" : "Would promote"}: ${promoted}. Below bar: ${below}. Missing HTML: ${missing}. Write failures: ${failed}.`
  );
  if (!apply) {
    console.log(
      "Dry run only. Re-run with --apply and CLOUDFLARE_API_TOKEN to write production KV. URLs will be https://catsluvus.com/reviews/{category}/{slug}."
    );
  }
}

if (viaWorker) {
  await runViaWorker();
} else {
  await runLocal();
}
