/**
 * scout-stuck-sweep.ts — self-heal Scout DB rows abandoned mid-generation.
 *
 * `onStart()` already resets rows stuck in `generating` — but only in the
 * Durable Object's LOCAL SQLite `keywords` table. The D1 `scout_keywords`
 * table, which is where the autonomous loop actually claims work from,
 * was never swept. A keyword claimed from D1 and then killed by a deploy
 * restart therefore stayed `generating` FOREVER: nothing reset it, and
 * `claimNextScoutKeyword` only selects `status='pending'`, so the row
 * silently left the queue.
 *
 * Observed 2026-07-29: `shake-away-coyote-fox-urine-granules-review` was
 * claimed at 13:24:54, four seconds before a deploy pause. Its DO-local
 * row was reset on restart; its D1 row was still `generating` 128
 * minutes later with no article, no ledger entry and no KV object. With
 * a deploy every couple of hours, this leaks keywords out of the queue
 * steadily.
 *
 * Two failure modes, two remedies, both keyed off the same staleness
 * window:
 *
 *   1. Work never completed (no `article_ledger` row) → back to
 *      `pending` so the loop picks it up again.
 *   2. Work DID complete but the write-back was lost (a ledger row
 *      exists) → mark `published` and adopt the ledger's kv_key, rather
 *      than requeueing and generating a duplicate article.
 *
 * The ledger check is what makes requeueing safe. Without it a lost
 * write-back would look identical to a killed run, and the sweep would
 * cheerfully regenerate an already-published keyword.
 */

/** Rows younger than this are assumed to be legitimately in flight. */
export const DEFAULT_STALE_MINUTES = 30;

/**
 * How many times a row may be swept back to 'pending' before it is
 * abandoned instead.
 *
 * Requeueing without a bound is an unbounded retry: a keyword whose
 * generation dies deterministically gets requeued, re-claimed, dies and
 * is requeued again forever, burning a full ~12-minute generation cycle
 * every round. The DO-local `keywords` table has always had this guard
 * (retry_count + MAX_KEYWORD_RETRIES -> 'abandoned'); the D1 table it
 * claims from did not, because until 2026-07-29 nothing swept it at all.
 */
export const DEFAULT_MAX_SWEEPS = 3;

export interface ScoutStuckSweepResult {
  /** Rows returned to `pending` because no article was ever produced. */
  requeued: string[];
  /** Rows marked `published` from an existing ledger entry. */
  reconciled: string[];
  /** Rows that exhausted their sweep budget and were given up on. */
  abandoned: string[];
  /** Set when the sweep could not run; the caller logs and moves on. */
  error?: string;
}

/**
 * Sweep `scout_keywords` rows stranded in `generating`.
 *
 * Never throws — a sweep failure must not take down `onStart()`. Safe to
 * run on every restart: rows claimed within `staleMinutes` are untouched,
 * and the generation pipeline takes roughly 12 minutes, so the default
 * window leaves a wide margin over a run that is merely slow.
 */
export async function sweepStuckScoutKeywords(
  db: D1Database | undefined,
  options: { staleMinutes?: number; maxSweeps?: number } = {}
): Promise<ScoutStuckSweepResult> {
  const empty: ScoutStuckSweepResult = {
    requeued: [],
    reconciled: [],
    abandoned: []
  };
  if (!db) return { ...empty, error: "KEYWORDS_DB binding missing" };
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const maxSweeps = options.maxSweeps ?? DEFAULT_MAX_SWEEPS;
  const cutoff = `-${Math.max(1, Math.floor(staleMinutes))} minutes`;

  try {
    // Reconcile FIRST. Doing it after the requeue would race against
    // itself: the requeue would have already flipped these rows to
    // `pending` and the ledger lookup would find nothing to adopt.
    const reconciled = await db
      .prepare(
        `UPDATE scout_keywords
            SET status = 'published',
                finished_at = datetime('now'),
                kv_key = (SELECT kv_key FROM article_ledger
                           WHERE article_ledger.slug = scout_keywords.slug)
          WHERE status = 'generating'
            AND claimed_at IS NOT NULL
            AND claimed_at <= datetime('now', ?1)
            AND EXISTS (SELECT 1 FROM article_ledger
                         WHERE article_ledger.slug = scout_keywords.slug)
          RETURNING slug`
      )
      .bind(cutoff)
      .all<{ slug: string }>();

    // Abandon BEFORE requeueing, so a row at its budget is given up on
    // rather than requeued one last time by the statement below.
    const abandoned = await db
      .prepare(
        `UPDATE scout_keywords
            SET status = 'abandoned',
                finished_at = datetime('now'),
                error = 'stranded in generating; abandoned after ' ||
                        sweep_count || ' sweep(s)'
          WHERE status = 'generating'
            AND claimed_at IS NOT NULL
            AND claimed_at <= datetime('now', ?1)
            AND sweep_count >= ?2
            AND NOT EXISTS (SELECT 1 FROM article_ledger
                             WHERE article_ledger.slug = scout_keywords.slug)
          RETURNING slug`
      )
      .bind(cutoff, maxSweeps)
      .all<{ slug: string }>();

    const requeued = await db
      .prepare(
        `UPDATE scout_keywords
            SET status = 'pending',
                claimed_at = NULL,
                sweep_count = sweep_count + 1
          WHERE status = 'generating'
            AND claimed_at IS NOT NULL
            AND claimed_at <= datetime('now', ?1)
            AND sweep_count < ?2
            AND NOT EXISTS (SELECT 1 FROM article_ledger
                             WHERE article_ledger.slug = scout_keywords.slug)
          RETURNING slug`
      )
      .bind(cutoff, maxSweeps)
      .all<{ slug: string }>();

    return {
      requeued: (requeued.results ?? []).map((r) => r.slug),
      reconciled: (reconciled.results ?? []).map((r) => r.slug),
      abandoned: (abandoned.results ?? []).map((r) => r.slug)
    };
  } catch (err: unknown) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/** One-line summary for the activity log. Empty string when nothing moved. */
export function summarizeScoutStuckSweep(
  result: ScoutStuckSweepResult
): string {
  const parts: string[] = [];
  if (result.requeued.length > 0) {
    parts.push(
      `${result.requeued.length} requeued to 'pending' (no article was produced): ${result.requeued.slice(0, 5).join(", ")}`
    );
  }
  if (result.reconciled.length > 0) {
    parts.push(
      `${result.reconciled.length} reconciled to 'published' from the ledger (write-back was lost): ${result.reconciled.slice(0, 5).join(", ")}`
    );
  }
  if (result.abandoned.length > 0) {
    parts.push(
      `${result.abandoned.length} abandoned after exhausting the sweep budget (generation keeps dying): ${result.abandoned.slice(0, 5).join(", ")}`
    );
  }
  return parts.join(" | ");
}
