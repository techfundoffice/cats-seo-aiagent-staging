/**
 * defect-findings.ts — Stage 1 + 2 of the per-defect-class self-improving
 * loop modelled on the OpenAI/Thrive Tax-AI piece.
 *
 * Why this exists (the missing observation layer):
 *
 *   The Editorial Agent's existing `editorial-stats.reasons[]` counters
 *   carry only a label: "this rewrite was rejected for `seo-regression`".
 *   That signal isn't actionable — Copilot can't tell from a label which
 *   piece of writer/agent code produced the bad output. The OpenAI piece
 *   spells out the missing pieces directly:
 *
 *     "Tax AI's output is compared with the filed return to produce
 *      field-level review rows that capture the expected value,
 *      predicted value, and whether the difference appears actionable."
 *
 *   This module captures the same shape per editorial rejection: the
 *   structured (expected, predicted, evidence, suspected-code-path) row
 *   that a downstream eval-builder can group into a finding, and a
 *   downstream Copilot task can investigate against.
 *
 * Stage 1: `recordFinding(agent, finding)` — append per-rejection signal
 * to KV `defect-findings:<defectClass>` (rolling 25 newest entries).
 *
 * Stage 2: after every append, evaluate the pattern trigger — if the
 * defect class has 5+ findings in the last 24h AND no in-flight task
 * lock exists, log a structured "trigger fired" message. The actual
 * eval-builder + escalation paths (Stages 3-4) are not in this PR.
 *
 * Scoped intentionally to ONE defect class first
 * (`rewrite-fragment-not-document` — i.e. document-shape-regression
 * rejections). Once the loop closes end-to-end for that class, the
 * same shape generalises to the others without re-architecting.
 */

import { errMsg } from "./http-utils";
import type { SEOArticleAgent } from "../server";

/**
 * Canonical defect class identifiers. Each maps 1:1 to a rejection
 * reason that today increments `editorial-stats.reasons`. Findings
 * carry the same key so the eval-builder + escalation can fan out
 * per-class.
 *
 * Only one is wired in this PR; the rest are reserved so the file
 * doesn't churn when subsequent defect classes get the same
 * treatment.
 */
/**
 * Single source of truth for every wired defect class. Anywhere code
 * needs to enumerate the full set (the observer's per-class counters,
 * dashboard panels listing them, future detector-health monitors)
 * MUST import `ALL_DEFECT_CLASSES` from here rather than redeclaring
 * the list — otherwise adding a class becomes a multi-file edit and
 * silent drift is guaranteed.
 *
 * The `DefectClass` union is derived from the array so the type-system
 * and the runtime list stay in lockstep automatically.
 */
export const ALL_DEFECT_CLASSES = [
  "rewrite-fragment-not-document",
  "rewrite-seo-regression",
  "rewrite-jsonld-regression",
  "rewrite-wirecutter-voice",
  "rewrite-salvage-failed",
  "itemlist-doubled-best",
  "product-name-truncation",
  "missing-why-we-like-blurb",
  "faq-near-duplicate-questions",
  "duplicate-top-picks-headings",
  // Pre-publish JSON-LD severe failure: parse failure, missing @type,
  // or missing required field on Article / FAQPage / BreadcrumbList.
  // Recorded by writer.ts Step 14.5 (`classifyJsonLdSeverity` in
  // qc-gate.ts). Fires the auto-fix loop at 5 occurrences in 24h so
  // the html-builder generator gets repaired rather than the
  // individual articles getting patched post-publish.
  "prepub-jsonld-severe",
  // Live-published article has a title that ends in an orphan
  // trailing modifier ("Top" from "Top Picks", "Buying" from
  // "Buying Guide", "Best" from "Best [X]"). Recorded by the
  // in-worker live quality probe scanning shipped KV HTML.
  "live-title-orphan-modifier",
  // Live-published article has fewer than 4 <h2> section headings.
  // Indicates an under-structured article that likely under-ranks.
  "live-thin-h2-count",
  // Live-published article has zero question-style <h2> headings
  // AND no FAQPage schema. Indicates lost rich-result eligibility.
  "live-missing-faq-coverage",
  // Editorial-agent rewrite output contained an event-handler
  // attribute (`onerror=`, `onclick=`, etc.) or `javascript:` /
  // `vbscript:` URL — XSS vector. The rewrite is rejected and the
  // original stays live, but recurring instances indicate prompt
  // drift (Kimi being asked to expand HTML and inserting markup
  // it shouldn't). 5 hits in 24h fires the auto-fix loop so the
  // rewrite prompt gets tightened rather than the worker silently
  // dropping every rewrite for that defect class.
  "post-rewrite-xss-detected",
  // Pre-publish body text asserts a YMYL claim (benefit eligibility,
  // regulatory/certification compliance, quantified research, or named
  // endorsement) with no citation/attribution marker. Detected by
  // writer.ts Step 14.5 (`detectUnsourcedClaims` in unsourced-claims.ts)
  // and fed to the Polish Agent for qualification. Recurring instances
  // (5 in 24h) fire the auto-fix loop so the writer prompt gets tightened
  // to stop fabricating authority claims rather than patching articles
  // one at a time.
  "unsourced-ymyl-claim",
  // Pre-publish body text claims a first-person product trial that did
  // not happen ("we tested", "hands-on testing", "field-tested", "after
  // N weeks with the X", "tested 200 times", "in our facility we tried").
  // Catsluvus.com does not physically test products — these phrases are
  // FTC 16 CFR Part 255 false-endorsement risks. Detected by writer.ts
  // Step 14.7 (`detectFabricatedTestingClaims` in
  // fabricated-testing-claims.ts) and fed to the Polish Agent for
  // rewriting before publish.
  "prepub-fabricated-testing-claim",
  // Live-published article (already in KV / on catsluvus.com) contains a
  // fabricated testing claim that slipped past pre-publish gates or was
  // shipped before the gates existed. Detected by live-quality-probe.ts
  // on each tick. 5 hits in 24h fires the auto-fix loop so the
  // contaminated batch gets rewritten by Copilot rather than left
  // shipping false claims.
  "live-false-testing-claim",
  // Editorial Agent's Kimi rewrite step produced output containing
  // fabricated testing-claim language (bio reverted to pre-fix
  // "tested hundreds of products in real boarding facility
  // conditions", or body re-wrote in "we tested" / "personally
  // reviews" phrasings) despite the prompt's rules 7 + 8 banning
  // both. Detected by `editorial-agent.ts:runRewriteAttempt` post-
  // rewrite FTC gate, mirroring the existing XSS gate. The rewrite
  // is rejected (original stays live); 5 hits in 24h fires the auto-
  // fix loop so the prompt + model conditioning get tightened rather
  // than the worker silently dropping every rewrite for the class.
  "editorial-rewrite-ftc-violation",
  // Live-published article (already in KV / on catsluvus.com) contains an
  // unsourced YMYL claim (benefit-eligibility, regulatory/certification,
  // quantified-research, or named-endorsement) that slipped past the
  // pre-publish Polish-Agent rewrite (Step 18) or was shipped before
  // `unsourced-ymyl-claim` detection existed. Detected by
  // live-quality-probe.ts on each tick via `detectUnsourcedClaims`.
  // 5 hits in 24h fires the auto-fix loop so the writer prompt gets
  // tightened rather than the live corpus accumulating false authority
  // claims that Google's YMYL / E-E-A-T systems penalise.
  "live-unsourced-ymyl-claim"
] as const;

export type DefectClass = (typeof ALL_DEFECT_CLASSES)[number];

/**
 * Per-rejection structured evidence. The shape mirrors what Copilot
 * needs to investigate a failure without a Slack thread:
 *   - `kvKey` identifies the article so the production trace
 *     (`kimi-raw:<kvKey>`, `editorial-report:<kvKey>`, the pre-editorial
 *     snapshot, the live KV body) is reachable via the existing
 *     `/api/admin/*` surface.
 *   - `evidence` is the smoking-gun diff between original and rewrite.
 *   - `suspectedCodePath` is the file:function coordinate that produced
 *     the bad output. Lets Copilot work on a bounded surface instead of
 *     the whole repo.
 */
export interface DefectFinding {
  defectClass: DefectClass;
  kvKey: string;
  /** UTC ISO. */
  timestamp: string;
  /** Structured diff between original and rejected rewrite. */
  evidence: Record<string, unknown>;
  /**
   * File:function coordinate — where the bad output came from.
   * Example: `"src/pipeline/editorial-agent.ts:runRewriteAttempt:OUTPUT_FORMAT_block"`.
   * Read-only hint for Copilot; not enforced anywhere in code.
   */
  suspectedCodePath: string;
}

/**
 * Storage cap per defect class. 25 newest is enough for the
 * eval-builder to sample 3-5 representative cases without
 * cherry-picking, while keeping the KV blob small (<32KB).
 */
const MAX_FINDINGS_PER_CLASS = 25;

/**
 * Pattern trigger threshold. The OpenAI piece is explicit:
 *
 *   "Only after repeated differences have been reviewed and grouped
 *    into an actionable finding does the system turn them into a
 *    bounded task with a clear success condition."
 *
 * 5 within 24h is the trigger. Single failures are noise; this is the
 * "actionable finding" threshold.
 */
const PATTERN_TRIGGER_COUNT = 5;
const PATTERN_TRIGGER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** TTL on the in-flight lock so a single stuck task can't permanently silence the trigger. */
const INFLIGHT_LOCK_TTL_SECONDS = 24 * 60 * 60;

function findingsKey(defectClass: DefectClass): string {
  return `defect-findings:${defectClass}`;
}

function inflightLockKey(defectClass: DefectClass): string {
  return `defect-task-inflight:${defectClass}`;
}

/**
 * Best-effort release of the in-flight escalation lock. Called when an
 * escalation attempt fails to open its issue, so the next finding can
 * retry immediately instead of waiting out the 24h lock TTL. Swallows
 * errors — a failed lock delete just falls back to TTL expiry.
 */
async function releaseInflightLock(
  agent: SEOArticleAgent,
  defectClass: DefectClass
): Promise<void> {
  try {
    await agent.envBindings.ARTICLES_KV.delete(inflightLockKey(defectClass));
  } catch {
    /* best-effort; falls through to the 24h TTL */
  }
}

/**
 * Append a finding to the rolling per-class blob. Caps at the newest
 * MAX_FINDINGS_PER_CLASS entries. Errors are swallowed — finding
 * capture must never break the editorial-agent flow.
 *
 * Returns the appended record's array length so callers can log
 * "this is finding N for this class today" if useful. After the
 * append, the pattern trigger is evaluated and a structured "fired"
 * log line is emitted if the threshold + no-lock conditions hit. The
 * actual escalation (eval build, Copilot issue) is not in this PR;
 * the log line is the observable signal Stage 1+2 produces.
 */
/**
 * Per-finding hard cap on serialized `evidence` size. KV blobs are
 * limited to 25 MB but ours is meant to stay tiny (~32 KB max across
 * 25 entries). If a noisy detector passed an unbounded blob the entire
 * rolling buffer could blow past that ceiling and KV.put would fail —
 * silently from the caller's perspective. 4 KB per finding × 25 caps
 * the worst case at ~100 KB, well under any sane KV value limit.
 */
const MAX_EVIDENCE_SERIALIZED_BYTES = 4096;

/**
 * Defensively clamp the evidence object so any single field's serialized
 * size stays bounded. We keep all keys but truncate string/JSON values
 * over the per-field budget — Copilot's runbook reads only the first
 * few hundred chars per field anyway, so truncation is information-loss
 * free at the consumer.
 */
function clampEvidence(
  evidence: Record<string, unknown>
): Record<string, unknown> {
  const serialized = JSON.stringify(evidence);
  if (serialized.length <= MAX_EVIDENCE_SERIALIZED_BYTES) return evidence;
  // Over budget — rebuild with string-valued fields truncated.
  const perField = Math.floor(
    MAX_EVIDENCE_SERIALIZED_BYTES / Math.max(1, Object.keys(evidence).length)
  );
  const clamped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(evidence)) {
    if (typeof v === "string" && v.length > perField) {
      clamped[k] = `${v.slice(0, perField - 20)}…[truncated]`;
    } else if (typeof v === "object" && v !== null) {
      const s = JSON.stringify(v);
      clamped[k] =
        s.length > perField ? `${s.slice(0, perField - 20)}…[truncated]` : v;
    } else {
      clamped[k] = v;
    }
  }
  return clamped;
}

export async function recordFinding(
  agent: SEOArticleAgent,
  finding: DefectFinding
): Promise<void> {
  try {
    const key = findingsKey(finding.defectClass);
    const raw = await agent.envBindings.ARTICLES_KV.get(key);
    const all: DefectFinding[] = raw
      ? (JSON.parse(raw) as DefectFinding[])
      : [];
    // Defensively clamp evidence so a noisy detector with an unbounded
    // string can't blow the rolling KV blob past KV's per-value cap.
    const safeFinding: DefectFinding = {
      ...finding,
      evidence: clampEvidence(finding.evidence)
    };
    all.push(safeFinding);
    // Trim to newest N. ISO timestamp sorts lexicographically.
    all.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    const trimmed = all.slice(-MAX_FINDINGS_PER_CLASS);
    try {
      await agent.envBindings.ARTICLES_KV.put(key, JSON.stringify(trimmed));
    } catch (putErr: unknown) {
      // Surface KV.put failures so observers can spot blob size or auth
      // issues. Previously a put failure was indistinguishable from a
      // successful one because we never read back.
      agent.log(
        "warning",
        `Defect findings: KV.put(${key}) failed — ${errMsg(putErr)}. Finding silently discarded.`,
        "editorialAgent",
        { kanbanStage: "debug" }
      );
      return;
    }

    // Stage 2: pattern trigger. Count entries within the 24h window
    // ending at `finding.timestamp`. If we hit threshold AND no
    // in-flight lock is set, fire the trigger.
    const cutoff = new Date(
      new Date(finding.timestamp).getTime() - PATTERN_TRIGGER_WINDOW_MS
    ).toISOString();
    const recentCount = trimmed.filter((f) => f.timestamp >= cutoff).length;
    // Auto-clear the in-flight lock when the window count drops below
    // half the trigger threshold (≤ 2 in the last 24h). Lets the loop
    // re-arm naturally once a fix has clearly worked — operator no
    // longer has to wait for the 24h TTL to expire if findings stop.
    if (recentCount <= Math.floor(PATTERN_TRIGGER_COUNT / 2)) {
      try {
        const lockKey = inflightLockKey(finding.defectClass);
        if (await agent.envBindings.ARTICLES_KV.get(lockKey)) {
          await agent.envBindings.ARTICLES_KV.delete(lockKey);
          agent.log(
            "info",
            `Defect findings: cleared inflight lock for ${finding.defectClass} — window count dropped to ${recentCount} (≤ ${Math.floor(PATTERN_TRIGGER_COUNT / 2)}).`,
            "editorialAgent",
            { kanbanStage: "debug" }
          );
        }
      } catch {
        /* lock clear is best-effort; falls through to 24h TTL */
      }
    }
    if (recentCount < PATTERN_TRIGGER_COUNT) return;

    const lockKey = inflightLockKey(finding.defectClass);
    const lockHeld = await agent.envBindings.ARTICLES_KV.get(lockKey);
    if (lockHeld) return;

    // Acquire the lock so duplicate triggers within the window
    // don't fire concurrently. The lock auto-expires; a follow-up
    // PR's escalation path is responsible for clearing it when the
    // finding count drops.
    await agent.envBindings.ARTICLES_KV.put(lockKey, finding.timestamp, {
      expirationTtl: INFLIGHT_LOCK_TTL_SECONDS
    });

    agent.log(
      "warning",
      `Defect trigger fired: defectClass=${finding.defectClass} count=${recentCount} window=24h sampleKvKey=${finding.kvKey} suspectedCodePath=${finding.suspectedCodePath}. Firing Stage 4 escalation (eval-set + claude-fix-with-eval issue).`,
      "editorialAgent",
      { kanbanStage: "debug" }
    );

    // Stage 4: open a scoped claude-fix-with-eval issue. Dynamic import
    // intentionally: defect-escalate.ts depends on readFindings + DefectClass
    // from this module; a static import edge would be circular. The dynamic
    // form is hoisted by the bundler once, so the runtime cost is one-time.
    // Failure here is non-fatal — the lock is already set and will auto-expire
    // in 24h, at which point the next finding can retry the escalation.
    try {
      const { escalateDefectClassToCopilot } =
        await import("./defect-escalate");
      const runId = await escalateDefectClassToCopilot(
        agent,
        finding.defectClass,
        {
          triggerCount: recentCount,
          sampleKvKey: finding.kvKey
        }
      );
      if (!runId) {
        // Escalation returned null — it never opened the issue (eval-set
        // build failed, createIssueDirect failed, or the issue POST threw).
        // Release the lock so the NEXT finding retries the escalation
        // instead of the whole defect class staying silently suppressed
        // for the 24h lock TTL. That suppression is the "loop stuck: N
        // occurrences in 24h, trigger at 5, yet no fix deployed" failure
        // mode — one failed escalation attempt must not muzzle the trigger
        // for a full day.
        await releaseInflightLock(agent, finding.defectClass);
      }
    } catch (escErr: unknown) {
      agent.log(
        "warning",
        `Defect findings: Stage 4 escalation threw for ${finding.defectClass}: ${errMsg(escErr)}. Releasing lock so the next finding retries.`,
        "editorialAgent",
        { kanbanStage: "debug" }
      );
      // Same rationale as the null-return path: a thrown escalation must
      // not hold the lock for 24h. Release so the loop can re-arm.
      await releaseInflightLock(agent, finding.defectClass);
    }
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Defect findings: recordFinding(${finding.defectClass}) failed — finding dropped: ${errMsg(err)}`,
      "editorialAgent"
    );
  }
}

/**
 * Read all findings for a class, oldest first. Used by the
 * dashboard / debugging endpoint to surface what's currently driving
 * the rejection rate.
 */
export async function readFindings(
  agent: SEOArticleAgent,
  defectClass: DefectClass
): Promise<DefectFinding[]> {
  try {
    const raw = await agent.envBindings.ARTICLES_KV.get(
      findingsKey(defectClass)
    );
    return raw ? (JSON.parse(raw) as DefectFinding[]) : [];
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Defect findings: readFindings(${defectClass}) KV read/parse failed — returning empty (${errMsg(err)})`,
      "editorialAgent"
    );
    return [];
  }
}
