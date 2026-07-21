/**
 * Derive Kimi provider health from the in-memory activity log. Surfaces
 * the aggregate operational state ("are OpenRouter credits dry right
 * now?") as a single tier the dashboard can render in a top-of-page
 * banner — without adding a new state field, endpoint, or persisted
 * counter.
 *
 * Why this exists: PRs #4776 / #4779 made individual editorial failures
 * carry the right attribution string. But operators still had to scan
 * the activity log to recognize the systemic pattern when OpenRouter
 * credits are exhausted across writer / editorial / observer / intent-gap
 * — every Kimi-using subsystem degrades simultaneously, but the only
 * signal was per-row log lines. This helper aggregates them into one
 * tier the banner can show at the top of the dashboard.
 *
 * Source: the canonical log shape emitted by `src/pipeline/kimi-model.ts`
 * at the OpenRouter→Workers-AI fallback boundary:
 *
 *   "[kimi-model] OpenRouter call failed (<msg>); falling back to
 *    Workers AI"
 *
 * When `<msg>` is the credit-exhaustion shape (detected by
 * `isKimiCreditsExhausted` in http-utils.ts), we count it separately so
 * the banner can distinguish "transient errors" from "billing dry".
 */

import { isKimiCreditsExhausted } from "./pipeline/http-utils";
import { OPENROUTER_CALL_FAILED_LOG_PREFIX } from "./pipeline/kimi-model";

export type KimiProviderHealthTier = "ok" | "degraded" | "exhausted";

export interface KimiProviderHealth {
  tier: KimiProviderHealthTier;
  /** Total `[kimi-model] OpenRouter call failed` log entries in the window. */
  openrouterFailures: number;
  /** Subset of `openrouterFailures` whose message matches credit-exhaustion. */
  creditsExhaustedHits: number;
}

/**
 * Threshold at/above which we flip from "degraded" (some failures) to
 * "exhausted" (billing wall). Five credit-exhausted hits in the
 * activity-log window (~200 entries ≈ 25 min during bursts) is a strong
 * signal — at the publish cadence of ~10/hr it represents the wall
 * being hit in roughly half of all attempts.
 */
const EXHAUSTED_TIER_THRESHOLD = 5;

/**
 * Threshold for "Kimi is currently degraded enough that further calls
 * are wasted compute." Used by upstream callers (e.g. editorial-agent)
 * to short-circuit work that depends on a good Kimi response. Lower
 * than `EXHAUSTED_TIER_THRESHOLD` because we want to skip BEFORE the
 * banner trips red — three recent credit-exhausted hits is already
 * strong evidence the next call will also fail.
 */
const DEGRADED_PRECHECK_THRESHOLD = 3;

/**
 * Aggregate recent activity-log entries into a single Kimi provider-health
 * snapshot for dashboard and precheck consumers.
 *
 * @param activityLog Recent activity log entries to analyze for provider state.
 * @returns Health snapshot containing tier plus failure/exhaustion counts.
 */
export function computeKimiProviderHealth(
  activityLog: ReadonlyArray<{ msg?: string }>
): KimiProviderHealth {
  let openrouterFailures = 0;
  let creditsExhaustedHits = 0;
  for (const entry of activityLog) {
    const msg = entry.msg ?? "";
    if (!msg.includes(OPENROUTER_CALL_FAILED_LOG_PREFIX)) continue;
    openrouterFailures++;
    if (isKimiCreditsExhausted(msg)) creditsExhaustedHits++;
  }
  let tier: KimiProviderHealthTier = "ok";
  if (creditsExhaustedHits >= EXHAUSTED_TIER_THRESHOLD) {
    tier = "exhausted";
  } else if (openrouterFailures > 0) {
    tier = "degraded";
  }
  return { tier, openrouterFailures, creditsExhaustedHits };
}

/**
 * True when recent Kimi credit-exhaustion failures in the activity log
 * exceed the precheck threshold. Callers (notably
 * `runEditorialAgent`) use this to short-circuit Kimi-dependent work
 * BEFORE attempting the call — saves Workers AI compute that would
 * just produce degraded output and get rejected by downstream gates.
 *
 * Returns false on empty/missing log so brand-new DO instances aren't
 * blocked from attempting their first call.
 */
export function isKimiCurrentlyDegraded(
  activityLog: ReadonlyArray<{ msg?: string }>
): boolean {
  return (
    computeKimiProviderHealth(activityLog).creditsExhaustedHits >=
    DEGRADED_PRECHECK_THRESHOLD
  );
}
