import type { SEOArticleAgent } from "../server";
import { errMsg, getEnvBinding } from "./http-utils";
import { runKimiWithPoll } from "./kimi-model";
import {
  enforceMetaSerpWindow,
  enforceTitleSerpWindow
} from "./title-meta-normalizer";
import { prodKvRestApi } from "./prod-publish";

/**
 * idle-tick.ts — productive use of the quiet minutes between article
 * generations. Fired by the 10-minute cron; hard-skips whenever the
 * pipeline is generating so it can never collide with a run.
 *
 * One task per tick, round-robin:
 *   1. gsc-sync    — refresh Search Console metrics (impressions/clicks/
 *                    position per page) into KEYWORDS_DB.
 *   2. ctr-rewrite — the highest-leverage on-page play: pick ONE
 *                    "striking distance" production page (avg position
 *                    5-15, real impressions, ~zero clicks) and rewrite
 *                    its SERP snippet — <title> + meta description ONLY,
 *                    no visible body changes — via Kimi, normalized
 *                    through the same SERP-window enforcers the pipeline
 *                    uses. The original HTML is backed up to
 *                    `ctr-backup:<kvKey>` (30-day TTL) in the production
 *                    namespace before any write, and a 14-day marker
 *                    prevents re-rewriting the same page before results
 *                    can show up in GSC.
 *
 * Disable everything with IDLE_TICK_DISABLED="on".
 */

const CTR_REWRITE_MARKER_TTL_S = 14 * 24 * 60 * 60;
const CTR_BACKUP_TTL_S = 30 * 24 * 60 * 60;

export interface IdleTickResult {
  ok: boolean;
  task: string;
  detail: string;
}

interface CtrCandidate {
  page_url: string;
  kv_key: string;
  impressions: number;
  clicks: number;
  position: number;
}

/** Extract current title + meta description from a full HTML document. */
export function extractSerpSnippet(html: string): {
  title: string;
  metaDescription: string;
} {
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "";
  const metaDescription =
    html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] ?? "";
  return { title, metaDescription };
}

/**
 * Swap the SERP snippet in place: <title>, meta description, and any
 * og:/twitter: mirrors whose content exactly equals the old values.
 * Head-only edits — the visible article body is untouched.
 */
export function applySerpSnippet(
  html: string,
  oldSnippet: { title: string; metaDescription: string },
  next: { title: string; metaDescription: string }
): string {
  let out = html.replace(
    `<title>${oldSnippet.title}</title>`,
    `<title>${next.title}</title>`
  );
  if (oldSnippet.metaDescription) {
    out = out
      .split(`content="${oldSnippet.metaDescription}"`)
      .join(`content="${next.metaDescription}"`);
  }
  if (oldSnippet.title) {
    out = out
      .split(`content="${oldSnippet.title}"`)
      .join(`content="${next.title}"`);
  }
  return out;
}

async function ctrTriageRewrite(
  agent: SEOArticleAgent
): Promise<IdleTickResult> {
  const env = agent.envBindings;
  const db = env.KEYWORDS_DB;
  if (!db) return { ok: false, task: "ctr-rewrite", detail: "no KEYWORDS_DB" };
  const api = prodKvRestApi(env);
  if (!api) {
    return { ok: false, task: "ctr-rewrite", detail: "CF API creds missing" };
  }

  const rows = await db
    .prepare(
      `SELECT page_url, kv_key, impressions, clicks, position
         FROM gsc_pages
        WHERE position >= 5 AND position <= 15
          AND impressions >= 50 AND clicks <= 1
          AND kv_key IS NOT NULL
        ORDER BY impressions DESC LIMIT 10`
    )
    .all<CtrCandidate>();
  const candidates = rows.results ?? [];
  if (candidates.length === 0) {
    return {
      ok: true,
      task: "ctr-rewrite",
      detail: "no striking-distance candidates in gsc_pages"
    };
  }

  for (const candidate of candidates) {
    const marker = await env.ARTICLES_KV.get(`ctr-rewrite:${candidate.kv_key}`);
    if (marker) continue;

    const htmlRes = await fetch(
      `${api.base}/${encodeURIComponent(candidate.kv_key)}`,
      { headers: api.headers }
    );
    if (!htmlRes.ok) continue;
    const html = await htmlRes.text();
    const current = extractSerpSnippet(html);
    if (!current.title) continue;

    const keyword = candidate.kv_key.split(":").pop()?.replace(/-/g, " ") ?? "";
    const prompt = `You are an SEO click-through-rate specialist. This page ranks on Google page 1-2 (avg position ${candidate.position.toFixed(1)}) with ${candidate.impressions} impressions in 28 days but only ${candidate.clicks} click(s) — searchers see the snippet and skip it.

Page topic: "${keyword}"
Current title: "${current.title}"
Current meta description: "${current.metaDescription}"

Write a MORE CLICKABLE replacement. Rules: title 48-60 characters, keep the main keyword near the front, add a concrete benefit or curiosity hook, no clickbait lies, no ALL CAPS, at most one number. Meta description 140-158 characters, expand the promise, end with a reason to click now. Respond with ONLY this JSON: {"title":"...","metaDescription":"..."}`;

    let raw: string;
    try {
      raw = await runKimiWithPoll(
        env as Parameters<typeof runKimiWithPoll>[0],
        {
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300
        },
        {},
        agent
      );
    } catch (err: unknown) {
      return {
        ok: false,
        task: "ctr-rewrite",
        detail: `model call failed: ${errMsg(err)}`
      };
    }
    let parsed: { title?: string; metaDescription?: string };
    try {
      parsed = JSON.parse(
        raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)
      ) as { title?: string; metaDescription?: string };
    } catch {
      return {
        ok: false,
        task: "ctr-rewrite",
        detail: `unparseable model output for ${candidate.kv_key}`
      };
    }
    if (!parsed.title || !parsed.metaDescription) {
      return {
        ok: false,
        task: "ctr-rewrite",
        detail: `incomplete model output for ${candidate.kv_key}`
      };
    }

    const nextTitle = enforceTitleSerpWindow(parsed.title, keyword).title;
    const nextMeta = enforceMetaSerpWindow(
      parsed.metaDescription,
      keyword
    ).meta;
    if (nextTitle === current.title) {
      return {
        ok: true,
        task: "ctr-rewrite",
        detail: `model produced identical title for ${candidate.kv_key} — skipped`
      };
    }

    // Backup FIRST, into the production namespace where the page lives.
    const backup = await fetch(
      `${api.base}/${encodeURIComponent(`ctr-backup:${candidate.kv_key}`)}?expiration_ttl=${CTR_BACKUP_TTL_S}`,
      {
        method: "PUT",
        headers: { ...api.headers, "Content-Type": "text/plain" },
        body: html
      }
    );
    if (!backup.ok) {
      return {
        ok: false,
        task: "ctr-rewrite",
        detail: `backup write failed for ${candidate.kv_key}`
      };
    }

    const updated = applySerpSnippet(html, current, {
      title: nextTitle,
      metaDescription: nextMeta
    });
    const put = await fetch(
      `${api.base}/${encodeURIComponent(candidate.kv_key)}`,
      {
        method: "PUT",
        headers: { ...api.headers, "Content-Type": "text/plain" },
        body: updated
      }
    );
    if (!put.ok) {
      return {
        ok: false,
        task: "ctr-rewrite",
        detail: `page write failed for ${candidate.kv_key}`
      };
    }
    await env.ARTICLES_KV.put(`ctr-rewrite:${candidate.kv_key}`, nextTitle, {
      expirationTtl: CTR_REWRITE_MARKER_TTL_S
    });

    agent.log(
      "info",
      `CTR rewrite: ${candidate.kv_key} (pos ${candidate.position.toFixed(1)}, ${candidate.impressions} impr, ${candidate.clicks} clicks) — title "${current.title}" → "${nextTitle}" (backup kept 30d)`,
      "analyst",
      { kanbanStage: "done" }
    );
    return {
      ok: true,
      task: "ctr-rewrite",
      detail: `${candidate.kv_key}: "${nextTitle}"`
    };
  }

  return {
    ok: true,
    task: "ctr-rewrite",
    detail: "all current candidates rewritten within the last 14 days"
  };
}

/** Round-robin task cursor persisted in KV. */
async function nextTask(env: {
  ARTICLES_KV: KVNamespace;
}): Promise<"gsc-sync" | "ctr-rewrite"> {
  const tasks = ["gsc-sync", "ctr-rewrite"] as const;
  const raw = await env.ARTICLES_KV.get("idle-tick:cursor");
  const cursor = Number(raw ?? "0") || 0;
  await env.ARTICLES_KV.put("idle-tick:cursor", String(cursor + 1));
  return tasks[cursor % tasks.length];
}

/** Entry point — called from the DO's /api/idle-tick internal route. */
export async function runIdleTick(
  agent: SEOArticleAgent
): Promise<IdleTickResult> {
  const env = agent.envBindings;
  const flag = (getEnvBinding(env, "IDLE_TICK_DISABLED") ?? "").toLowerCase();
  if (flag === "on" || flag === "true" || flag === "1") {
    return { ok: true, task: "none", detail: "IDLE_TICK_DISABLED" };
  }
  const status = agent.state.status;
  if (status === "generating" || status === "scouting") {
    return { ok: true, task: "none", detail: `pipeline busy (${status})` };
  }

  const task = await nextTask(env);
  if (task === "gsc-sync") {
    const db = env.KEYWORDS_DB;
    if (!db) return { ok: false, task, detail: "no KEYWORDS_DB" };
    const { runGscSync } = await import("./gsc-sync");
    const result = await runGscSync(env, db);
    const detail = result.ok
      ? `${result.rows} pages from ${result.property}; ${result.totals?.impressions} impressions / ${result.totals?.clicks} clicks (28d)`
      : (result.error ?? "failed");
    agent.log(
      result.ok ? "info" : "warning",
      `Idle tick (gsc-sync): ${detail}`,
      "analyst"
    );
    return { ok: result.ok, task, detail };
  }
  return ctrTriageRewrite(agent);
}
