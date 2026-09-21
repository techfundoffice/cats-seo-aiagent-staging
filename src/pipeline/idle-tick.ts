import type { SEOArticleAgent } from "../server";
import { errMsg, getEnvBinding } from "./http-utils";
import { runKimiWithPoll } from "./kimi-model";
import {
  enforceMetaSerpWindow,
  enforceTitleSerpWindow
} from "./title-meta-normalizer";
import { prodKvRestApi } from "./prod-publish";
import {
  classifyCtrExperiment,
  shouldRollbackSnippet
} from "./ctr-experiments";

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

/** One pending experiment joined to its current Search Console row. */
interface ResolvableExperiment {
  id: number;
  kv_key: string;
  new_title: string;
  old_title: string;
  old_meta: string;
  before_impressions: number;
  before_clicks: number;
  before_ctr: number | null;
  before_position: number | null;
  after_impressions: number | null;
  after_clicks: number | null;
  after_ctr: number | null;
  after_position: number | null;
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

    // Record the before-window so this rewrite can be judged later. Without
    // this row the change is unfalsifiable: gsc_pages is overwritten on the
    // next sync and the old numbers are gone.
    try {
      await db
        .prepare(
          `INSERT INTO ctr_experiments
             (kv_key, page_url, old_title, new_title, old_meta, new_meta,
              before_impressions, before_clicks, before_ctr, before_position)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
        )
        .bind(
          candidate.kv_key,
          candidate.page_url ?? "",
          current.title,
          nextTitle,
          current.metaDescription ?? "",
          nextMeta,
          candidate.impressions,
          candidate.clicks,
          candidate.impressions > 0
            ? candidate.clicks / candidate.impressions
            : 0,
          candidate.position
        )
        .run();
    } catch (err: unknown) {
      agent.log(
        "warning",
        `CTR rewrite: applied to ${candidate.kv_key} but the experiment row failed to write (${errMsg(err)}) — this rewrite will not be measurable`,
        "analyst"
      );
    }

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

/**
 * Put a losing snippet back.
 *
 * Restores ONLY the title and meta description, from the values recorded on
 * the experiment row — not the full-HTML `ctr-backup:` snapshot the rewrite
 * also saves. In the 28 days between apply and resolve the Editorial Agent,
 * QC Agent and Polish Agent may all have rewritten the body; replaying a
 * month-old snapshot to undo a title change would throw all of that away.
 *
 * Best-effort by design: a page that has since been deleted, redirected, or
 * had its title edited by something else is left alone and reported, never
 * forced.
 */
async function rollbackCtrRewrite(
  agent: SEOArticleAgent,
  row: ResolvableExperiment
): Promise<{ ok: boolean; detail: string }> {
  const env = agent.envBindings;
  const api = prodKvRestApi(env);
  if (!api) {
    return { ok: false, detail: "rollback skipped — CF API creds missing" };
  }
  try {
    const res = await fetch(`${api.base}/${encodeURIComponent(row.kv_key)}`, {
      headers: api.headers
    });
    if (!res.ok) {
      return {
        ok: false,
        detail: `rollback skipped — page fetch ${res.status}`
      };
    }
    const html = await res.text();
    const live = extractSerpSnippet(html);

    const decision = shouldRollbackSnippet({
      liveTitle: live.title,
      appliedTitle: row.new_title,
      originalTitle: row.old_title
    });
    if (!decision.rollback) {
      return { ok: false, detail: `rollback skipped — ${decision.reason}` };
    }

    const restored = applySerpSnippet(html, live, {
      title: row.old_title,
      metaDescription: row.old_meta || live.metaDescription
    });
    if (restored === html) {
      return {
        ok: false,
        detail: "rollback skipped — snippet unchanged"
      };
    }

    const put = await fetch(`${api.base}/${encodeURIComponent(row.kv_key)}`, {
      method: "PUT",
      headers: { ...api.headers, "Content-Type": "text/plain" },
      body: restored
    });
    if (!put.ok) {
      return { ok: false, detail: `rollback write failed — ${put.status}` };
    }

    // Clear the 14-day marker so the page is eligible for a fresh attempt
    // rather than staying locked out by the rewrite that just lost.
    try {
      await env.ARTICLES_KV.delete(`ctr-rewrite:${row.kv_key}`);
    } catch {
      /* the marker expires on its own; not worth failing the rollback */
    }

    return {
      ok: true,
      detail: `rolled back to "${row.old_title.slice(0, 60)}"`
    };
  } catch (err: unknown) {
    return { ok: false, detail: `rollback threw — ${errMsg(err)}` };
  }
}

/**
 * Resolve CTR experiments whose after-window has fully turned over.
 *
 * Search Console reports a trailing 28-day window, so an experiment is only
 * readable once 28 days of post-rewrite data have accumulated — before that
 * the window still contains pre-rewrite days and the comparison is a blend
 * of both snippets.
 */
async function resolveCtrExperiments(
  agent: SEOArticleAgent
): Promise<IdleTickResult> {
  const env = agent.envBindings;
  const db = env.KEYWORDS_DB;
  if (!db) return { ok: false, task: "ctr-resolve", detail: "no KEYWORDS_DB" };

  const due = await db
    .prepare(
      `SELECT e.id, e.kv_key, e.new_title, e.old_title, e.old_meta,
              e.before_impressions, e.before_clicks, e.before_ctr,
              e.before_position,
              p.impressions AS after_impressions, p.clicks AS after_clicks,
              p.ctr AS after_ctr, p.position AS after_position
         FROM ctr_experiments e
         LEFT JOIN gsc_pages p ON p.kv_key = e.kv_key
        WHERE e.outcome = 'pending'
          AND e.applied_at <= datetime('now', '-28 day')
        ORDER BY e.applied_at ASC
        LIMIT 10`
    )
    .all<ResolvableExperiment>();

  const rows = due.results ?? [];
  if (rows.length === 0) {
    return {
      ok: true,
      task: "ctr-resolve",
      detail: "no experiments past their 28-day window"
    };
  }

  const tally: Record<string, number> = {};
  for (const row of rows) {
    if (row.after_impressions == null) {
      // The page dropped out of Search Console entirely — no after-window.
      await db
        .prepare(
          `UPDATE ctr_experiments
              SET outcome = 'inconclusive',
                  outcome_detail = 'page absent from Search Console at resolve time',
                  resolved_at = datetime('now')
            WHERE id = ?1`
        )
        .bind(row.id)
        .run();
      tally.inconclusive = (tally.inconclusive ?? 0) + 1;
      continue;
    }

    const verdict = classifyCtrExperiment(
      {
        impressions: row.before_impressions,
        clicks: row.before_clicks,
        ctr: row.before_ctr,
        position: row.before_position
      },
      {
        impressions: row.after_impressions,
        clicks: row.after_clicks ?? 0,
        ctr: row.after_ctr,
        position: row.after_position
      }
    );

    await db
      .prepare(
        `UPDATE ctr_experiments
            SET after_impressions = ?1, after_clicks = ?2, after_ctr = ?3,
                after_position = ?4, ctr_delta = ?5, outcome = ?6,
                outcome_detail = ?7, resolved_at = datetime('now')
          WHERE id = ?8`
      )
      .bind(
        row.after_impressions,
        row.after_clicks ?? 0,
        verdict.afterCtr,
        row.after_position,
        verdict.ctrDelta,
        verdict.outcome,
        verdict.detail,
        row.id
      )
      .run();

    tally[verdict.outcome] = (tally[verdict.outcome] ?? 0) + 1;

    agent.log(
      verdict.outcome === "regressed" ? "warning" : "info",
      `CTR experiment ${verdict.outcome}: ${row.kv_key} — ${verdict.detail} (title "${row.new_title}")`,
      "analyst",
      { kanbanStage: "done" }
    );

    // A rewrite that measurably lost clicks keeps losing them until it is
    // undone, so the verdict is acted on rather than just recorded.
    if (verdict.outcome === "regressed") {
      const rollback = await rollbackCtrRewrite(agent, row);
      await db
        .prepare(
          `UPDATE ctr_experiments
              SET outcome_detail = outcome_detail || ' | ' || ?1
            WHERE id = ?2`
        )
        .bind(rollback.detail, row.id)
        .run();
      agent.log(
        rollback.ok ? "info" : "warning",
        `CTR rollback for ${row.kv_key}: ${rollback.detail}`,
        "analyst",
        { kanbanStage: "done" }
      );
    }
  }

  const summary = Object.entries(tally)
    .map(([outcome, n]) => `${n} ${outcome}`)
    .join(", ");
  return {
    ok: true,
    task: "ctr-resolve",
    detail: `resolved ${rows.length} experiment(s): ${summary}`
  };
}

/** Round-robin task cursor persisted in KV. */
async function nextTask(env: {
  ARTICLES_KV: KVNamespace;
}): Promise<"gsc-sync" | "ctr-rewrite" | "ctr-resolve"> {
  const tasks = ["gsc-sync", "ctr-rewrite", "ctr-resolve"] as const;
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
      ? `${result.rows} pages from ${result.property}; ${result.totals?.impressions} impressions / ${result.totals?.clicks} clicks (28d); ${result.historyRows ?? 0} history rows`
      : (result.error ?? "failed");
    agent.log(
      result.ok ? "info" : "warning",
      `Idle tick (gsc-sync): ${detail}`,
      "analyst"
    );
    return { ok: result.ok, task, detail };
  }
  if (task === "ctr-resolve") {
    const result = await resolveCtrExperiments(agent);
    agent.log(
      result.ok ? "info" : "warning",
      `Idle tick (ctr-resolve): ${result.detail}`,
      "analyst"
    );
    return result;
  }
  return ctrTriageRewrite(agent);
}
