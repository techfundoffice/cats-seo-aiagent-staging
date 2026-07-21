/**
 * observer-agent.ts — AI agent that watches the worker's own state and
 * narrates what's happening into the activity log.
 *
 * Runs every 15 minutes on its own schedule (sibling to the autonomous
 * loop). On each tick:
 *
 *   1. Snapshots the worker: recent activity log entries, defect-finding
 *      counts per class, editorial-stats for today, scout/article
 *      counters, schedule state.
 *   2. Sends the snapshot to Kimi K2.5 with an operations-observer
 *      prompt asking what's happening, what's concerning, what's worth
 *      investigating — and crucially, what's NOT happening that should
 *      be (the loop-not-firing class of bug).
 *   3. Writes Kimi's narrative back into the activity log under role
 *      `observerAgent`, so it surfaces in the dashboard alongside every
 *      other agent's activity.
 *
 * Why this exists: the per-defect-class self-improving loop only fires
 * on PATTERNS already wired (one detector per class). When a detector
 * is too narrow or a new defect class emerges that nobody wrote a
 * detector for yet, the loop is silent — and silence looks identical
 * to "everything is fine." The observer is the meta-watcher that
 * notices the silence and complains in plain English so an operator
 * (or a follow-up Copilot pass) can act.
 *
 * Cost: one Kimi call per 15-min tick ≈ $0.01 (~$1/day) at OpenRouter
 * pricing. Cheap enough to leave running indefinitely.
 */

import { generateText } from "ai";
import { isActivityLogWarningOrErrorLevel } from "../activityLogLevels";
import type { SEOArticleAgent } from "../server";
import {
  ALL_DEFECT_CLASSES,
  type DefectClass,
  readFindings
} from "./defect-findings";
import { getEditorialStats } from "./editorial-stats";
import {
  formatBreakdownOneLine,
  summarizeFailureBreakdown
} from "./failure-breakdown";
import { errMsg } from "./http-utils";
import { getKimiModel, getKimiProviderOptions } from "./kimi-model";
import {
  formatDistributionOneLine,
  summarizeScoreDistribution
} from "./observer-score-distribution";

// Defect classes the loop currently knows about. Pulled from the single
// source of truth in `defect-findings.ts:ALL_DEFECT_CLASSES` so adding
// a class there automatically reaches the observer without a second
// edit. Previously this was a hand-maintained local copy that drifted.

/** How many recent log entries to feed Kimi per tick. Caps prompt size. */
const RECENT_LOG_ENTRIES_FOR_OBSERVER = 80;

/** How many lines of Kimi's response we mirror into the activity log. */
const MAX_OBSERVER_VERDICT_CHARS = 1800;

/**
 * Snapshot the worker state into something Kimi can reason about. Keeps
 * the payload bounded — the activity log is windowed, the findings are
 * counts not full blobs, the editorial-stats are aggregates not raw
 * rows.
 */
async function snapshotWorkerState(agent: SEOArticleAgent): Promise<{
  prompt: string;
  context: {
    recentLogCount: number;
    findingsByClass: Partial<Record<DefectClass, number>>;
    editorialStatsToday: { success: number; fail: number; skipped: number };
  };
}> {
  const state = agent.state;
  const log = Array.isArray(state.activityLog) ? state.activityLog : [];
  const recent = log.slice(-RECENT_LOG_ENTRIES_FOR_OBSERVER);

  // Findings per class. readFindings is best-effort; absent class →
  // empty array. We surface only counts to Kimi to keep the prompt small.
  // Type is `Partial<Record<DefectClass, ...>>` rather than the looser
  // `Record<string, ...>` because the keys come exclusively from the
  // statically-known `ALL_DEFECT_CLASSES`; type-checker can now catch
  // typos in any future code that reads back specific class keys.
  const findingsByClass: Partial<Record<DefectClass, number>> = {};
  for (const cls of ALL_DEFECT_CLASSES) {
    try {
      const findings = await readFindings(agent, cls);
      findingsByClass[cls] = findings.length;
    } catch {
      findingsByClass[cls] = -1; // sentinel: read failed
    }
  }

  // Editorial stats — today only is enough signal for a 15-min observer.
  let editorialStatsToday = { success: 0, fail: 0, skipped: 0 };
  try {
    const stats = await getEditorialStats(agent, 1);
    if (stats.length > 0) {
      editorialStatsToday = {
        success: stats[0].success,
        fail: stats[0].fail,
        skipped: stats[0].skipped
      };
    }
  } catch (e: unknown) {
    agent.log(
      "warning",
      `Observer: getEditorialStats failed — editorial counts zeroed in this tick (${errMsg(e)})`,
      "observerAgent",
      { kanbanStage: "debug" }
    );
  }

  // Render the snapshot as a compact prompt body Kimi can read.
  const findingsLines = Object.entries(findingsByClass)
    .map(([cls, n]) => `  - ${cls}: ${n === -1 ? "READ-FAILED" : n}`)
    .join("\n");
  const recentLogLines = recent
    .map((e) => {
      const ts = `${e.timeDate ?? ""} ${e.timeTime ?? ""}`.trim();
      const role = (e as { role?: string }).role ?? "—";
      const lvl = (e.level || "info").toUpperCase();
      const msg = (e.msg || "").slice(0, 240);
      return `[${ts}] ${lvl} ${role}: ${msg}`;
    })
    .join("\n");

  const prompt = `WORKER SNAPSHOT (UTC ${new Date().toISOString()}):

Status: ${state.status ?? "unknown"}
Articles generated: ${state.articlesGenerated ?? "?"}
Articles failed: ${state.articlesFailed ?? "?"}
Avg SEO score: ${state.avgSeoScore ?? "?"}
Last activity timestamp: ${state.lastActivity ?? "?"}
Categories in DB: ${(state as { dbCategories?: number }).dbCategories ?? "?"}
Pending keywords: ${(state as { dbPendingKeywords?: number }).dbPendingKeywords ?? "?"}

Editorial agent stats today (UTC):
  success=${editorialStatsToday.success}  fail=${editorialStatsToday.fail}  skipped=${editorialStatsToday.skipped}

Defect findings (rolling 24h, per class — pattern trigger fires at 5):
${findingsLines}

Recent activity log (newest last, ${recent.length} entries):
${recentLogLines || "(none)"}

`;

  // Defensive: strip null bytes from the prompt body. They've been seen
  // sneaking in via upstream log entries (corrupted/truncated upstream
  // payloads) and some model providers reject prompts containing them.
  // Safe to drop — they have no semantic value in a status snapshot.
  const NULL_BYTE = String.fromCharCode(0);
  const sanitizedPrompt = prompt.split(NULL_BYTE).join("");

  return {
    prompt: sanitizedPrompt,
    context: {
      recentLogCount: recent.length,
      findingsByClass,
      editorialStatsToday
    }
  };
}

/**
 * The observer's system prompt. Asks Kimi to be a tight, plain-English
 * ops observer — short, actionable, calling out the silence cases that
 * a counter-only monitor would miss.
 */
const OBSERVER_SYSTEM_PROMPT = `You are the operations observer for a Cloudflare Worker that autonomously generates SEO articles for catsluvus.com. You run every 15 minutes. Your job is to read the worker's recent activity log and state snapshot, then write ONE short status report (max ~250 words) for the human operator.

What to include in EVERY report:
  - One sentence on overall health (green/yellow/red and why).
  - Whether the article pipeline is producing or stuck (and why).
  - Whether the per-defect-class self-improving loop has fired in this window — and if any defect class is approaching the 5-in-24h trigger.
  - Anything anomalous: error spikes, new error fingerprints, credit/quota exhaustion, scout exhaustion, deploy failures.
  - CRITICAL: silence cases. If a defect class has ZERO findings over many ticks while editorial quality is dropping or unrelated bugs are shipping, flag that the DETECTOR may be too narrow — not that the code is perfect.

Style:
  - Plain English. No jargon dump.
  - Lead with the headline. End with a recommended action if any.
  - Be honest about what you can and cannot tell from the snapshot.

Output format:
  HEADLINE: <one line>
  STATUS: <green|yellow|red>
  WHAT'S HAPPENING: <2-4 sentences>
  WHAT'S NOT HAPPENING (but should be): <1-2 sentences, or "nothing flagged">
  RECOMMENDED ACTION: <one sentence, or "none — keep watching">`;

/**
 * Entry point. Called from the agent's scheduled `observerTick()` every
 * 15 minutes. Fire-and-forget: errors are swallowed and logged at info
 * level so the observer can't take down the worker.
 *
 * Reasoning is delegated to Kimi via OpenRouter (or Workers AI). One
 * call per tick, ~$0.01.
 */
/**
 * Build a deterministic narrative when Kimi is unavailable (OpenRouter
 * credits exhausted, Workers AI quota, transient network error). The
 * shape mirrors the Kimi-generated format so the dashboard
 * `ObserverAgentPanel` parser can render it identically — no special
 * fallback rendering path needed.
 *
 * Status is computed deterministically from the snapshot:
 *   - red:    article pipeline stuck AND no recent activity
 *   - yellow: any defect-class within 1 of trigger, OR Kimi-failure
 *             being the reason we're in this branch
 *   - green:  otherwise
 */
/**
 * The pattern trigger fires at this count (mirrors
 * `PATTERN_TRIGGER_COUNT` in `defect-findings.ts`). Hoisted here so
 * the fallback-narrative text uses the same threshold and stays in
 * sync; tests pin this constant.
 */
export const OBSERVER_NARRATIVE_TRIGGER_COUNT = 5;

/**
 * Describe one defect-finding class for the narrative, distinguishing
 * "near trigger" from "already triggered (in cooldown)". Previously the
 * narrative said "one more finding fires the loop" for any class with
 * ≥4 findings — but classes at ≥5 have already fired the trigger and
 * are in a 24h KV `inflight-lock`. Telling the operator "one more fires
 * it" while the loop is actually in cooldown was misleading and led
 * users to report the bug observed at `missing-why-we-like-blurb:14/5`.
 */
export function describeFindingClassForNarrative(
  cls: string,
  count: number,
  triggerCount = OBSERVER_NARRATIVE_TRIGGER_COUNT
): string {
  if (count >= triggerCount) {
    return `${cls}:${count}/${triggerCount} — loop already triggered (24h cooldown; auto-clears when window count drops below ${Math.floor(triggerCount / 2) + 1})`;
  }
  const remaining = triggerCount - count;
  return `${cls}:${count}/${triggerCount} — ${remaining} more finding${remaining === 1 ? "" : "s"} will fire the loop`;
}

/**
 * Build the structured "WHAT'S NOT HAPPENING (but should be)" section
 * of the fallback narrative. Pure derivation from the finding counts;
 * unit-tested in src/pipeline/__tests__/observer-narrative.test.ts.
 */
export function buildObserverWhatsNot(
  findingsByClass: Partial<Record<DefectClass, number>>,
  triggerCount = OBSERVER_NARRATIVE_TRIGGER_COUNT
): string {
  const entries = Object.entries(findingsByClass);
  const readFailedClasses = entries
    .filter(([, n]) => n < 0)
    .map(([cls]) => cls);
  const findings = entries.filter(([, n]) => n > 0);
  // Anything ≥ half the trigger is operationally interesting — either
  // approaching the wall or already through it.
  const halfTrigger = Math.ceil(triggerCount / 2);
  const interesting = findings.filter(([, n]) => n >= halfTrigger);
  const readFailuresSummary =
    readFailedClasses.length > 0
      ? ` Defect finding reads failed for: ${readFailedClasses.join(", ")}.`
      : "";
  if (interesting.length === 0) {
    return `No AI narrative available this tick — only counters. Top up OpenRouter credits or check kimi-model.ts for the failure detail above.${readFailuresSummary}`;
  }
  const phrases = interesting.map(([cls, n]) =>
    describeFindingClassForNarrative(cls, n, triggerCount)
  );
  return `Defect classes worth attention: ${phrases.join("; ")}.${readFailuresSummary}`;
}

function buildFallbackNarrative(
  ctx: {
    recentLogCount: number;
    findingsByClass: Partial<Record<DefectClass, number>>;
    editorialStatsToday: { success: number; fail: number; skipped: number };
  },
  kimiErr: string
): string {
  const findings = Object.entries(ctx.findingsByClass).filter(([, n]) => n > 0);
  // Fallback narratives are always yellow — the LLM is unreachable, so
  // we can't form a green or red opinion from a static counter snapshot.
  const status = "yellow";
  const findingsSummary =
    findings.length === 0
      ? "no defect findings in the rolling window"
      : findings
          .map(([cls, n]) => `${cls}:${n}/${OBSERVER_NARRATIVE_TRIGGER_COUNT}`)
          .join(", ");
  const headline = `Observer fallback — Kimi unavailable (${kimiErr.slice(0, 80)})`;
  const whatsHappening = `Snapshot only: ${ctx.recentLogCount} recent log entries; editorial today success=${ctx.editorialStatsToday.success} fail=${ctx.editorialStatsToday.fail} skipped=${ctx.editorialStatsToday.skipped}; findings=${findingsSummary}.`;
  const whatsNot = buildObserverWhatsNot(ctx.findingsByClass);
  const recommendedAction =
    "Top up OpenRouter credits (https://openrouter.ai/settings/credits) so the next tick produces a real Kimi narrative.";
  return [
    `HEADLINE: ${headline}`,
    `STATUS: ${status}`,
    `WHAT'S HAPPENING: ${whatsHappening}`,
    `WHAT'S NOT HAPPENING (but should be): ${whatsNot}`,
    `RECOMMENDED ACTION: ${recommendedAction}`
  ].join("\n");
}

/**
 * Periodic observer tick — called by the autonomous loop every cycle.
 *
 * Snapshots current worker state (recent activity-log entries, defect-finding
 * counts, and today's editorial stats), then asks Kimi to produce a
 * structured 5-line verdict in the format the dashboard panel parser expects:
 * HEADLINE / STATUS / WHAT'S HAPPENING / WHAT'S NOT HAPPENING / RECOMMENDED ACTION.
 *
 * When Kimi is unreachable or returns empty (e.g. exhausted credits),
 * `buildFallbackNarrative` synthesises a deterministic verdict from the same
 * snapshot so the dashboard always shows *something* — never a blank panel.
 *
 * Never throws: snapshot errors abort silently (logged at `info`); LLM
 * errors are caught and handled via the fallback path. The final verdict is
 * collapsed to a single line and emitted as one `info` activity-log entry.
 */
export async function runObserverTick(agent: SEOArticleAgent): Promise<void> {
  // Snapshot first so we have context for both the Kimi path AND the
  // fallback path. snapshotWorkerState only fails on KV errors which
  // would also break the fallback — let any such error propagate to the
  // outer catch.
  let snapshot: Awaited<ReturnType<typeof snapshotWorkerState>>;
  try {
    snapshot = await snapshotWorkerState(agent);
  } catch (snapErr: unknown) {
    agent.log(
      "info",
      `Observer: snapshot failed — ${errMsg(snapErr)}`,
      "observerAgent",
      { kanbanStage: "debug" }
    );
    return;
  }
  const { prompt, context } = snapshot;

  let verdict = "";
  try {
    // maxOutputTokens tuned to fit within an exhausted-credits ceiling
    // observed in prod (~301 tokens). The ~250-word system-prompt budget
    // fits comfortably inside 280 tokens for the structured 5-line
    // format the panel parses. If credits are healthy this just runs
    // cheaper; if they're not, the call still succeeds.
    const { text } = await generateText({
      model: getKimiModel(agent.envBindings),
      providerOptions: getKimiProviderOptions(agent.envBindings),
      system: OBSERVER_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: 280
    });
    verdict = (text ?? "").trim().slice(0, MAX_OBSERVER_VERDICT_CHARS);
  } catch (err: unknown) {
    // Kimi unavailable — synthesise a deterministic narrative in the
    // exact same format the panel parser expects so the dashboard
    // ALWAYS shows something, even when the LLM is down.
    verdict = buildFallbackNarrative(context, errMsg(err));
    agent.log(
      "warning",
      `Observer: Kimi call failed, using fallback narrative — ${errMsg(err)}`,
      "observerAgent",
      { kanbanStage: "debug" }
    );
  }

  if (!verdict) {
    // Kimi returned empty — also use the fallback so the panel never
    // goes blank just because the model produced no tokens.
    verdict = buildFallbackNarrative(context, "Kimi returned empty narrative");
  }

  // Compact the verdict to a single log entry so it surfaces cleanly
  // in the dashboard. Multi-line Kimi response collapsed into a
  // bullet-style summary with newline → " | " separators.
  const oneLineVerdict = verdict.replace(/\s*\n+\s*/g, " | ");
  agent.log("info", `Observer (Kimi): ${oneLineVerdict}`, "observerAgent", {
    kanbanStage: "debug"
  });

  // Persist the tick to KV so the dashboard panel can render history even
  // after the in-memory `state.observerLog` ring (40 entries) evicts
  // older ticks during a long pipeline burst. The panel fetches from
  // `/api/observer-history`. 7-day TTL is plenty for "what did the
  // observer say recently?" and keeps KV storage bounded.
  try {
    const tickRecord = {
      ts: new Date().toISOString(),
      narrative: oneLineVerdict,
      context: {
        recentLogCount: context.recentLogCount,
        editorialStatsToday: context.editorialStatsToday,
        findingsByClass: context.findingsByClass
      }
    };
    await agent.envBindings.ARTICLES_KV.put(
      `observer-tick:${tickRecord.ts}`,
      JSON.stringify(tickRecord),
      { expirationTtl: 7 * 24 * 60 * 60 }
    );
  } catch (kvErr: unknown) {
    agent.log(
      "info",
      `Observer: KV persist skipped — ${errMsg(kvErr)}`,
      "observerAgent",
      { kanbanStage: "debug" }
    );
  }

  // Score-distribution one-liner. Emit AFTER the Kimi narrative so a
  // failed Kimi call doesn't prevent the operator-readable
  // distribution from landing in the activity log. Pulls the last 50
  // completed articles' `seo_score` values out of the SQL `articles`
  // table; surfaces median / P25 / P75 / min / max / stddev + the
  // count of articles below the 50-point publish floor.
  //
  // Wrapped in try/catch so a malformed SQL row (pre-migration DO)
  // can't crash the observer tick — the distribution is a
  // diagnostic, not a gate.
  try {
    type ScoreRow = { seo_score: number | null };
    const rows = [
      ...agent.sql<ScoreRow>`
        SELECT seo_score
        FROM articles
        WHERE seo_score IS NOT NULL
        ORDER BY ROWID DESC
        LIMIT 50
      `
    ];
    const scores = rows
      .map((r) => r.seo_score)
      .filter((s): s is number => typeof s === "number");
    const distribution = summarizeScoreDistribution(scores);
    agent.log(
      "info",
      `Observer: ${formatDistributionOneLine(distribution)}`,
      "observerAgent",
      { kanbanStage: "debug" }
    );
  } catch (distErr: unknown) {
    agent.log(
      "info",
      `Observer: score distribution skipped — ${errMsg(distErr)}`,
      "observerAgent",
      { kanbanStage: "debug" }
    );
  }

  // Failure-breakdown one-liner. Uses the same 200-entry window as the
  // /api/admin/failure-breakdown endpoint so the observer log matches
  // what the admin panel shows. Lets operators see credential vs content
  // failure split in the dashboard without polling the admin endpoint.
  try {
    const log = Array.isArray(agent.state.activityLog)
      ? agent.state.activityLog
      : [];
    const messages = log
      .slice(-200)
      .filter((e) => isActivityLogWarningOrErrorLevel(e.level))
      .map((e) => `${e.msg ?? ""} ${e.errorMessage ?? ""}`.trim())
      .filter((m) => m.length > 0);
    const breakdown = summarizeFailureBreakdown(messages);
    agent.log(
      "info",
      `Observer: ${formatBreakdownOneLine(breakdown)}`,
      "observerAgent",
      { kanbanStage: "debug" }
    );
  } catch (breakdownErr: unknown) {
    agent.log(
      "info",
      `Observer: failure breakdown skipped — ${errMsg(breakdownErr)}`,
      "observerAgent",
      { kanbanStage: "debug" }
    );
  }
}
