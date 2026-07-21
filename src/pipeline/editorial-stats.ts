/**
 * editorial-stats.ts — Per-day success/fail counters for the post-publish
 * Editorial Agent rewrite loop.
 *
 * Why this exists: the activity-log buffer holds only the most recent 200
 * entries. With ~10 articles/hour publishing, a day's worth of editorial
 * outcomes rotates out within minutes. There was previously no persistent
 * answer to "what fraction of rewrites succeeded today?" — making it
 * impossible to tell whether the in-place rewrite loop introduced in PR
 * #4087 is actually improving live articles, or silently failing.
 *
 * Storage shape:
 *   KV key:    `editorial-rewrite-stats:YYYY-MM-DD`
 *   KV value:  JSON { success: N, fail: N, skipped: N, reasons: { "<reason>": N, ... } }
 *   TTL:       60 days (rolling window long enough for trend analysis)
 *
 * Concurrency: KV does not support atomic counters. With ~10 publishes/hour
 * and ~2 minutes per editorial-agent run, collision probability is low; a
 * stale-read race causes at most a single missed increment per collision.
 * Stats are diagnostic, not billing — acceptable.
 *
 * Surface:
 *   - `incrementEditorialStat(env, outcome, reason?)` is called from
 *     editorial-agent.ts at every step-4 outcome (success / fail / skip).
 *   - `getEditorialStats(env, days)` powers the `/api/admin/editorial-stats`
 *     endpoint and the "EDITORIAL REWRITE LOOP" dashboard panel.
 */

import { errMsg } from "./http-utils";
import type { SEOArticleAgent } from "../server";
import { recordRejectionLesson } from "./editorial-lessons";

/**
 * Outcome categories tracked per day. Order matches the step-4 control flow
 * in `runEditorialAgent`: every published article hits exactly one of these.
 */
export type EditorialOutcome = "success" | "fail" | "skipped";

/**
 * Per-day stat record stored at `editorial-rewrite-stats:YYYY-MM-DD`.
 * `reasons` is a histogram of free-form reason strings (e.g.
 * "reference-voice phrase", "salvage failed", "seo-regression",
 * "jsonld-regression") so the operator can see WHICH gate is firing
 * most, not just the aggregate fail count.
 */
export interface EditorialStatRecord {
  date: string;
  success: number;
  fail: number;
  skipped: number;
  /**
   * Histogram of free-form failure reasons (e.g. "reference-voice
   * phrase", "salvage failed", "kimi-audit-unavailable"). Drives the
   * editorial-lessons feedback loop AND the dashboard's top-failure
   * card.
   */
  reasons: Record<string, number>;
  /**
   * Histogram of free-form skip reasons (e.g. "no-actionable-fixes",
   * "applyFix=false", "kimi-audit-partial-fail"). Lets the dashboard
   * distinguish a clean article from a degraded Kimi run that produced
   * empty findings. Optional for backward compat with KV records
   * written before this field existed; readers should default to {}.
   */
  skipReasons?: Record<string, number>;
}

/** KV-key prefix; one record per UTC day. */
const STAT_KEY_PREFIX = "editorial-rewrite-stats:";

/** 60-day TTL so the operator can spot week-over-week trends. */
const STAT_TTL_SECONDS = 60 * 24 * 60 * 60;

function utcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function statKey(date: string): string {
  return `${STAT_KEY_PREFIX}${date}`;
}

/**
 * Read the current day's record, increment the outcome counter (and the
 * reason histogram for fail outcomes), write it back. Errors are
 * swallowed — stat updates must never break the editorial-agent flow.
 *
 * `reason` is optional; recommended only for `fail` outcomes so the
 * histogram stays meaningful. Pass undefined for `success` / `skipped`.
 */
export async function incrementEditorialStat(
  agent: SEOArticleAgent,
  outcome: EditorialOutcome,
  reason?: string
): Promise<void> {
  // Normalize once so the same key drives both the KV record and the
  // in-memory DO state mirror below — avoids duplicating the trim+slice
  // logic and guarantees both writes use an identical histogram key.
  // Failure reasons go to the `reasons` histogram (drives lessons +
  // failure-pattern card); skip reasons go to `skipReasons` (lets the
  // dashboard distinguish "skipped: clean" from "skipped: kimi-partial-
  // fail" after the editorial-agent #4776 / #4779 truth-attribution work).
  const trimmedReason = reason?.trim().slice(0, 80) || undefined;
  const normalizedFailReason = outcome === "fail" ? trimmedReason : undefined;
  const normalizedSkipReason =
    outcome === "skipped" ? trimmedReason : undefined;
  try {
    const date = utcDateString();
    const key = statKey(date);
    const raw = await agent.envBindings.ARTICLES_KV.get(key);
    const record: EditorialStatRecord = raw
      ? (JSON.parse(raw) as EditorialStatRecord)
      : { date, success: 0, fail: 0, skipped: 0, reasons: {}, skipReasons: {} };
    if (!record.skipReasons) record.skipReasons = {};
    record[outcome] = (record[outcome] || 0) + 1;
    if (normalizedFailReason) {
      record.reasons[normalizedFailReason] =
        (record.reasons[normalizedFailReason] || 0) + 1;
    }
    if (normalizedSkipReason) {
      record.skipReasons[normalizedSkipReason] =
        (record.skipReasons[normalizedSkipReason] || 0) + 1;
    }
    await agent.envBindings.ARTICLES_KV.put(key, JSON.stringify(record), {
      expirationTtl: STAT_TTL_SECONDS
    });
    // Mirror into DO state so the dashboard can render the counters
    // without going through the bearer-gated /api/admin/editorial-stats
    // endpoint. Lifetime-since-DO-start view; KV is the durable
    // per-day record. Lazy-init the field for DO instances that
    // existed before this feature shipped.
    const prev = agent.state.editorialStats ?? {
      success: 0,
      fail: 0,
      skipped: 0,
      reasons: {},
      skipReasons: {},
      resetAt: new Date().toISOString()
    };
    const nextReasons = { ...prev.reasons };
    if (normalizedFailReason) {
      nextReasons[normalizedFailReason] =
        (nextReasons[normalizedFailReason] || 0) + 1;
    }
    const nextSkipReasons = { ...(prev.skipReasons ?? {}) };
    if (normalizedSkipReason) {
      nextSkipReasons[normalizedSkipReason] =
        (nextSkipReasons[normalizedSkipReason] || 0) + 1;
    }
    agent.setState({
      ...agent.state,
      editorialStats: {
        ...prev,
        [outcome]: (prev[outcome] || 0) + 1,
        reasons: nextReasons,
        skipReasons: nextSkipReasons
      }
    });
    // Self-improvement feedback: when a rewrite is rejected, append the
    // reason to the rolling editorial-lessons KV blob so the NEXT
    // rewrite prompt (this article OR any subsequent article) sees it
    // as an explicit constraint. See editorial-lessons.ts.
    if (outcome === "fail" && normalizedFailReason) {
      await recordRejectionLesson(agent, normalizedFailReason);
    }
  } catch (err: unknown) {
    // Diagnostic only — never let stat-tracking surface as an article failure.
    agent.log(
      "info",
      `Editorial stats: increment(${outcome}${trimmedReason ? `, ${trimmedReason}` : ""}) failed silently: ${errMsg(err)}`,
      "editorialAgent"
    );
  }
}

/**
 * Read the last `days` days of stat records (default 7). Returns newest
 * first. Missing days appear as zero records so the caller can render
 * a continuous time series without gaps.
 */
export async function getEditorialStats(
  agent: SEOArticleAgent,
  days = 7
): Promise<EditorialStatRecord[]> {
  const out: EditorialStatRecord[] = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const date = utcDateString(d);
    try {
      const raw = await agent.envBindings.ARTICLES_KV.get(statKey(date));
      if (raw) {
        out.push(JSON.parse(raw) as EditorialStatRecord);
        continue;
      }
    } catch (e: unknown) {
      agent.log(
        "warning",
        `Editorial stats: KV read failed for date ${date} — day zeroed (${errMsg(e)})`,
        "editorialAgent",
        { kanbanStage: "debug" }
      );
    }
    out.push({ date, success: 0, fail: 0, skipped: 0, reasons: {} });
  }
  return out;
}

/**
 * Top-N failure reasons across `records`, sorted by frequency descending.
 * Used by the dashboard panel to highlight the dominant rejection cause.
 */
export function topFailureReasons(
  records: EditorialStatRecord[],
  n = 3
): Array<{ reason: string; count: number }> {
  const merged: Record<string, number> = {};
  for (const r of records) {
    for (const [reason, count] of Object.entries(r.reasons)) {
      merged[reason] = (merged[reason] || 0) + count;
    }
  }
  return Object.entries(merged)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

/**
 * Top-N skip reasons across `records`, sorted by frequency descending.
 * Mirrors `topFailureReasons` for the `skipReasons` histogram so the
 * `/api/admin/editorial-stats` response exposes both sides of the
 * non-rewrite outcome split: hard rejections (fail) AND skips (e.g.
 * `no-actionable-fixes`, `kimi-audit-partial-fail`). Records written
 * before `skipReasons` was introduced (older DOs) are silently ignored.
 */
export function topSkipReasons(
  records: EditorialStatRecord[],
  n = 3
): Array<{ reason: string; count: number }> {
  const merged: Record<string, number> = {};
  for (const r of records) {
    for (const [reason, count] of Object.entries(r.skipReasons ?? {})) {
      merged[reason] = (merged[reason] || 0) + count;
    }
  }
  return Object.entries(merged)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}
