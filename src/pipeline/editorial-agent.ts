/**
 * Published Article Editorial Agent.
 *
 * 4-step audit + candidate-rewrite loop for a published article:
 *   1. Read the stored HTML from KV, extract visible body text, Kimi-audit
 *      against an ingested wireframe (abstract pattern types from a
 *      reference URL like NYT Wirecutter — see wireframe-ingest.ts).
 *   2. Drive Cloudflare Browser Rendering to open the live page,
 *      screenshot above-the-fold + full-page, gather rendered text.
 *   3. Kimi-vision-audit the screenshots (layout, hierarchy, density,
 *      CTA placement) and merge with the text audit into a single report
 *      stored at KV `editorial-report:<kvKey>`.
 *   4. Rewrite the article to address every actionable finding and write
 *      the revised HTML to KV as `${kvKey}-b` — the "variant B" candidate.
 *      Variant A (the original `kvKey`) stays live. A downstream
 *      split-tester agent compares A vs B on SEO/quality/traffic metrics
 *      and decides which one wins the live slot.
 *
 * Surface: logged to the activity feed under role `editorialAgent` so the
 * dashboard panel can stream progress. Triggered via
 * `POST /api/admin/editorial-review` with `{ kvKey, referenceUrl? }`.
 */

import { parseObjectLike } from "../objectLike";
import type { SEOArticleAgent } from "../server";
import { DEFAULT_PROMOTION_TARGET_DOMAIN, prodKvRestApi } from "./prod-publish";
import { extractKeywordPriceTokens, stripPricesFromHtml } from "./html-builder";
import { runKimiWithPoll } from "./kimi-model";
import {
  capturePageScreenshot,
  renderPage,
  DESIGN_AUDIT_VIEWPORTS,
  getMissingBrowserRenderingBindings
} from "../tools/browser-rendering";
import {
  loadOrIngestWireframe,
  type WireframeSummary
} from "./wireframe-ingest";
import {
  errMsg,
  escXml,
  getEnvBinding,
  isKimiCreditsExhausted,
  keywordToSlug,
  unescapeHtml
} from "./http-utils";
import { incrementEditorialStat } from "./editorial-stats";
import { classifyEditorialOutcome } from "./editorial-outcome";
import { isKimiCurrentlyDegraded } from "../kimiProviderHealth";
import { calculateSEOScore } from "./seo-score";
import {
  enforceMetaSerpWindow,
  enforceTitleSerpWindow,
  trimTrailingTitleOrphanModifiers,
  TITLE_TRAILING_ORPHAN_MODIFIERS
} from "./title-meta-normalizer";
import { validateJsonLd } from "./qc-gate";
import { getActiveLessonsBlock } from "./editorial-lessons";
import { recordFinding } from "./defect-findings";
import {
  detectFabricatedTestingClaims,
  stripCompliantMethodologySections,
  summarizeFabricatedTestingClaims
} from "./fabricated-testing-claims";
import { stripHtmlToPlainText } from "./plagiarism-overlap";

/**
 * KV TTL for pre-editorial snapshot blobs (`<kvKey>-pre-editorial:<ISO>`)
 * and the related audit-bookkeeping keys. 14 days covers a generous
 * post-publish rewrite cycle window without burning KV storage on
 * stale rollback candidates.
 */
const EDITORIAL_SNAPSHOT_TTL_SECONDS = 60 * 60 * 24 * 14;

/**
 * SEO-score regression guard threshold. The rewrite is rejected when its
 * computed SEO score is more than this many points lower than the original.
 * 5 points of cushion absorbs noise from minor heading-order or
 * keyword-density jitter introduced by the rewrite without letting
 * substantive regressions (lost schema, broken hierarchy) ship.
 */
const SEO_REGRESSION_CUSHION = 5;

const DEFAULT_REFERENCE_URL =
  "https://www.nytimes.com/wirecutter/reviews/best-automatic-cat-litter-box/";

export {
  TITLE_TRAILING_ORPHAN_MODIFIERS,
  trimTrailingTitleOrphanModifiers
} from "./title-meta-normalizer";

/**
 * Shared anti-plagiarism instruction injected into every Kimi prompt that
 * sees the reference URL. Kimi may have NYT/Wirecutter content in
 * training data, so we need both a prompt-level ban AND the post-generation
 * `detectReferenceBorrowing` check below. The reference is STRUCTURAL
 * inspiration only — sections, hierarchy, comprehensiveness — never a
 * source of phrasing or product selection.
 */
const ANTI_PLAGIARISM_RULE = [
  "ANTI-PLAGIARISM — HARD RULE:",
  "The reference URL is a structural benchmark, not a content source. You must NOT copy any sentence, any product description, any tagline, any quote, any caption, any testing methodology phrase, or any phrase longer than 4 consecutive words from the reference URL or from any other NYT / Wirecutter / Condé Nast source you may remember from training.",
  "Use the reference to answer: what sections exist? what comprehensiveness bar is set? what reader questions are answered? Then write entirely in our own voice from our own knowledge and research.",
  "Violation = copyright infringement + Google duplicate-content SEO penalty + reputational risk."
].join(" ");

/**
 * Serialize a `WireframeSummary` into a prompt-safe block that conveys
 * abstract structural shape only — no titles, product names, prose, or
 * prices reach the prompt (those fields never enter `WireframeSummary`
 * in the first place; see `abstractifyWireframe` in wireframe-ingest.ts).
 */
function buildWireframePromptBlock(wireframe: WireframeSummary): string {
  const lines: string[] = [];
  lines.push(
    `Wireframe (abstract structural patterns — DO NOT copy content, voice, products, titles, or prices from the source URL ${wireframe.sourceUrl}):`
  );
  lines.push(
    `  - section pattern types (order matters): ${wireframe.sections.join(" → ")}`
  );
  if (wireframe.pickArchetypes.length > 0) {
    lines.push(
      `  - pick archetypes present: ${wireframe.pickArchetypes.map((a) => a.role).join(", ")} (each with a tradeoff block)`
    );
  }
  if (wireframe.trustSignals.length > 0) {
    lines.push(`  - trust signal types: ${wireframe.trustSignals.join(", ")}`);
  }
  if (wireframe.evaluationCriteria.length > 0) {
    lines.push(
      `  - evaluation criteria categories: ${wireframe.evaluationCriteria.join(", ")}`
    );
  }
  const m = wireframe.methodologyShape;
  if (m.considered || m.tested || m.subjects) {
    lines.push(
      `  - methodology shape: considered=${m.considered ?? "?"}, tested=${m.tested ?? "?"}, subjects=${m.subjects ?? "?"}, duration=${m.durationPattern ?? "unspecified"}`
    );
  }
  const f = wireframe.features;
  lines.push(
    `  - structural presence flags: at_a_glance_table=${f.hasAtAGlanceTable}, tradeoff_block_per_pick=${f.hasTradeoffBlockPerPick}, who_this_is_for=${f.hasWhoThisIsFor}, who_should_skip=${f.hasWhoShouldSkip}, how_we_picked=${f.hasHowWePicked}, how_we_tested=${f.hasHowWeTested}, competition_section=${f.hasCompetitionSection}`
  );
  lines.push(
    `Apply these patterns to OUR topic/products. Do not import any product, price, or prose from the source.`
  );
  return lines.join("\n");
}

/**
 * Post-generation plagiarism sanity check. Scans the revised HTML for
 * phrases likely borrowed from the reference (8+ consecutive distinctive
 * words). This is a best-effort check without fetching the reference —
 * we match against a small seed list of Wirecutter-signature phrases
 * Kimi is most likely to regurgitate from training. Returns `true` when
 * the output looks clean, `false` when a likely borrow is detected.
 */
function passesPlagiarismCheck(revised: string): {
  passed: boolean;
  matched: string | null;
} {
  // Signature phrases from NYT Wirecutter editorial voice that we never
  // want to see in our output. This is not exhaustive — it's a
  // regression net for the most obvious verbatim borrows.
  const wirecutterSignatures = [
    "we spent \\d+ hours",
    "after testing more than \\d+",
    "our pick for",
    "also great",
    "budget pick",
    "the staff picks",
    "we dismissed",
    "we wouldn't recommend",
    "if you can afford it",
    "for most people"
  ];
  const pattern = new RegExp(`\\b(${wirecutterSignatures.join("|")})\\b`, "i");
  const m = revised.match(pattern);
  if (m) return { passed: false, matched: m[0] };

  // Amazon Associates compliance — we never publish prices in product
  // blocks. If the rewriter hallucinates one (e.g. from wireframe
  // training data), reject and keep the original article.
  const priceMatch = revised.match(/\$\s?\d{1,4}(?:\.\d{2})?/);
  if (priceMatch) {
    return { passed: false, matched: `price "${priceMatch[0]}"` };
  }
  return { passed: true, matched: null };
}

export interface EditorialReport {
  kvKey: string;
  /**
   * KV key of the revised "variant B" article if the rewrite step ran.
   * Original `kvKey` (variant A) stays live; the downstream split-tester
   * compares both and picks the winner before any live swap happens.
   * Absent when applyFix=false, no actionable fixes, or rewrite rejected
   * by the plagiarism/price check.
   */
  variantBKey?: string;
  referenceUrl: string;
  textAudit: {
    wordCount: number;
    missingSections: string[];
    weaknessesVsReference: string[];
    factualRisks: string[];
    toneIssues: string[];
  };
  visualAudit: {
    screenshotUrls: string[];
    layoutIssues: string[];
    densityIssues: string[];
    ctaIssues: string[];
  };
  actionableFixes: string[];
  summary: string;
  generatedAt: string;
}

/**
 * Runs the post-publish Editorial Agent flow for one article.
 *
 * Reads the article HTML from KV, performs text + visual audits against a
 * category benchmark, persists an `editorial-report:<kvKey>` payload, and
 * optionally writes a rewritten variant to `${kvKey}-b` when actionable fixes
 * are found. Returns `{ success: false, error }` on hard failures while keeping
 * the original article untouched.
 */
export async function runEditorialAgent(
  agent: SEOArticleAgent,
  params: {
    kvKey: string;
    referenceUrl?: string;
    applyFix?: boolean;
  }
): Promise<{ success: boolean; report?: EditorialReport; error?: string }> {
  const { kvKey } = params;
  const referenceUrl = params.referenceUrl ?? DEFAULT_REFERENCE_URL;
  const applyFix = params.applyFix !== false;

  agent.log(
    "info",
    `Editorial Agent: starting review for kvKey=${kvKey} vs wireframe ${referenceUrl}`,
    "editorialAgent"
  );

  // ── Step 0a: Kimi-degraded precheck ───────────────────────────────────────
  // When OpenRouter credits are exhausted, every audit call falls
  // through to the Workers AI fallback, every rewrite scores worse on
  // SEO than the original, every gate rejects, and the only outcome is
  // wasted compute + log noise (observed live: 41/62 of all editorial
  // fails were `seo-regression` from degraded-mode rewrites). Short-
  // circuit BEFORE the wireframe load + Kimi audits even start, so the
  // original article (which we know already cleared the pre-publish
  // pipeline) stays live cleanly and the stat row tells the operator
  // exactly why we skipped.
  if (isKimiCurrentlyDegraded(agent.state.activityLog ?? [])) {
    agent.log(
      "warning",
      `Editorial Agent: Kimi is currently degraded (≥3 credit-exhausted hits in live log) — skipping audit + rewrite. Top up OpenRouter credits to re-enable. Original article stays live at kvKey=${kvKey}.`,
      "editorialAgent"
    );
    await incrementEditorialStat(
      agent,
      "skipped",
      "kimi-credits-exhausted-precheck"
    );
    return { success: true };
  }

  // ── Step 0: load wireframe (lazy ingest if not cached) ────────────────────
  // The wireframe is an ABSTRACT skeleton — pattern types, methodology
  // shape, trust-signal types. Never raw prose from the reference.
  const wireframe = await loadOrIngestWireframe(agent, referenceUrl);

  // ── Step 1: read + text audit ─────────────────────────────────────────────
  // Articles that cleared the ≥90 gate are moved to the PRODUCTION KV
  // namespace (served from catsluvus.com) and the staging copy is
  // replaced with a `redirect:<kvKey>` tombstone. On a staging miss,
  // follow the tombstone and read the live prod copy via REST.
  let html = await agent.envBindings.ARTICLES_KV.get(kvKey);
  let prodPublished = false;
  if (!html) {
    const tombstone = await agent.envBindings.ARTICLES_KV.get(
      `redirect:${kvKey}`
    );
    const prodApi = tombstone ? prodKvRestApi(agent.envBindings) : null;
    if (prodApi) {
      const prodRes = await fetch(
        `${prodApi.base}/${encodeURIComponent(kvKey)}`,
        { headers: prodApi.headers }
      );
      if (prodRes.ok) {
        html = await prodRes.text();
        prodPublished = true;
        agent.log(
          "info",
          `Editorial Agent: ${kvKey} was published to production — auditing the live catsluvus.com copy`,
          "editorialAgent"
        );
      }
    }
  }
  if (!html) {
    agent.log(
      "error",
      `Editorial Agent: kvKey ${kvKey} not found in ARTICLES_KV (and no production copy behind its redirect tombstone)`,
      "editorialAgent"
    );
    return { success: false, error: "article not found in KV" };
  }
  const bodyText = extractBodyText(html);
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
  agent.log(
    "info",
    `Editorial Agent [step 1/4]: loaded ${wordCount} words from KV — auditing vs wireframe (${wireframe ? `${wireframe.sections.length} patterns` : "URL-only fallback"})`,
    "editorialAgent"
  );

  const textAudit = await auditTextAgainstReference(
    agent,
    bodyText,
    referenceUrl,
    wireframe
  );
  agent.log(
    "info",
    `Editorial Agent [step 1/4]: text audit found ${textAudit.missingSections.length} missing sections, ${textAudit.weaknessesVsReference.length} weaknesses vs reference`,
    "editorialAgent"
  );

  // ── Step 2: browser screenshots ───────────────────────────────────────────
  const publicUrl = prodPublished
    ? kvKeyToPublicUrl(
        agent,
        kvKey,
        getEnvBinding(agent.envBindings, "PROMOTION_TARGET_DOMAIN") ??
          DEFAULT_PROMOTION_TARGET_DOMAIN
      )
    : kvKeyToPublicUrl(agent, kvKey);
  agent.log(
    "info",
    `Editorial Agent [step 2/4]: dispatching Browser Rendering to screenshot ${publicUrl}`,
    "editorialAgent"
  );
  const screenshots = await collectScreenshots(agent, publicUrl);
  agent.log(
    "info",
    `Editorial Agent [step 2/4]: captured ${screenshots.urls.length} screenshots, extracted ${screenshots.extractedText.length} chars of rendered text`,
    "editorialAgent"
  );

  // ── Step 3: visual audit + merged report ──────────────────────────────────
  agent.log(
    "info",
    `Editorial Agent [step 3/4]: vision-auditing screenshots + writing report`,
    "editorialAgent"
  );
  const visualAudit = await auditScreenshots(
    agent,
    screenshots.urls,
    referenceUrl,
    wireframe
  );

  // Strip the internal kimiFailed signal before persisting — the
  // EditorialReport interface is part of the cross-agent contract and
  // shouldn't carry implementation details. The flag is consumed locally
  // below.
  const { kimiFailed: _textKimiFailed, ...textAuditForReport } = textAudit;
  const { kimiFailed: _visualKimiFailed, ...visualAuditForReport } =
    visualAudit;
  const report: EditorialReport = {
    kvKey,
    referenceUrl,
    textAudit: { ...textAuditForReport, wordCount },
    visualAudit: { ...visualAuditForReport, screenshotUrls: screenshots.urls },
    actionableFixes: [
      ...textAudit.missingSections.map((s) => `Add section: ${s}`),
      ...textAudit.weaknessesVsReference.map(
        (w) => `Strengthen vs reference: ${w}`
      ),
      ...textAudit.factualRisks.map((f) => `Verify/correct fact: ${f}`),
      ...textAudit.toneIssues.map((t) => `Tone fix: ${t}`),
      ...visualAudit.layoutIssues.map((l) => `Layout: ${l}`),
      ...visualAudit.densityIssues.map((d) => `Density: ${d}`),
      ...visualAudit.ctaIssues.map((c) => `CTA: ${c}`)
    ],
    summary: `Audited ${wordCount}-word article vs ${referenceUrl}. ${textAudit.missingSections.length} missing sections, ${textAudit.weaknessesVsReference.length} reference gaps, ${visualAudit.layoutIssues.length} layout issues.`,
    generatedAt: new Date().toISOString()
  };
  await agent.envBindings.ARTICLES_KV.put(
    `editorial-report:${kvKey}`,
    JSON.stringify(report),
    { expirationTtl: EDITORIAL_SNAPSHOT_TTL_SECONDS } // 14d
  );
  agent.log(
    "info",
    `Editorial Agent [step 3/4]: report saved — ${report.actionableFixes.length} actionable fixes identified`,
    "editorialAgent"
  );

  // ── Step 4: apply fixes + republish ───────────────────────────────────────
  // Decision table lives in classifyEditorialOutcome (editorial-outcome.ts)
  // so the 2×2×2 truth table for {applyFix, textKimiFailed, visualKimiFailed,
  // fixesCount} is tested in isolation. See PR #4776 — this protects the
  // historical bug where a Kimi infrastructure failure was silently
  // converted into "no findings, article is fine".
  const decision = classifyEditorialOutcome({
    applyFix,
    fixesCount: report.actionableFixes.length,
    textKimiFailed: textAudit.kimiFailed,
    visualKimiFailed: visualAudit.kimiFailed
  });
  if (decision.kind !== "rewrite") {
    agent.log(
      decision.logLevel,
      `Editorial Agent [step 4/4]: ${decision.logMessage}`,
      "editorialAgent"
    );
    await incrementEditorialStat(agent, decision.kind, decision.reason);
    if (decision.kind === "fail") {
      return {
        success: false,
        error: `editorial-${decision.reason}`,
        report
      };
    }
    return { success: true, report };
  }

  agent.log(
    "info",
    `Editorial Agent [step 4/4]: rewriting article to address ${report.actionableFixes.length} fixes`,
    "editorialAgent"
  );
  const firstAttempt = await rewriteArticleWithFixes(
    agent,
    html,
    report,
    wireframe
  );
  let revised: string | null = firstAttempt.html;
  // Carry the last rejection reason forward so the final increment
  // attributes "kimi-credits-exhausted" rather than blurring it into
  // the generic "rewrite-rejected" bucket. Same attribution discipline
  // as #4776 / #4777.
  let lastRejectionReason: "kimi-credits-exhausted" | "rewrite-rejected" =
    firstAttempt.html === null
      ? firstAttempt.rejectionReason
      : "rewrite-rejected";
  if (!revised) {
    // Full N-fix rewrite was rejected by a quality gate. Goal: every
    // audited article gets AT LEAST ONE improvement applied — not
    // zero. Fall back to a single-fix rewrite addressing only
    // `actionableFixes[0]`. Smaller prose delta → much less likely to
    // trip plagiarism / SEO regression / JSON-LD regression gates.
    //
    // The 1-fix attempt has the same retry-on-plagiarism logic as the
    // N-fix attempt (commit 4 of PR #4336), so we still get up to 2
    // shots. If the 1-fix rewrite ALSO fails every gate, that's a
    // genuine "nothing improved this round" — log and accept it.
    //
    // Skip the single-fix fallback when the first attempt failed due to
    // credit exhaustion — the failure is account-level, not prompt-level,
    // so a second attempt will hit the same wall and just burn another
    // Workers AI call.
    if (
      report.actionableFixes.length > 0 &&
      lastRejectionReason !== "kimi-credits-exhausted"
    ) {
      agent.log(
        "info",
        `Editorial Agent [step 4/4]: full N-fix rewrite rejected — falling back to single-fix attempt addressing only the first item: ${JSON.stringify(report.actionableFixes[0])}`,
        "editorialAgent"
      );
      const singleFixReport: EditorialReport = {
        ...report,
        actionableFixes: [report.actionableFixes[0]]
      };
      const singleFixOutcome = await rewriteArticleWithFixes(
        agent,
        html,
        singleFixReport,
        wireframe
      );
      revised = singleFixOutcome.html;
      if (singleFixOutcome.html === null) {
        lastRejectionReason = singleFixOutcome.rejectionReason;
      }
      if (revised) {
        agent.log(
          "info",
          `Editorial Agent [step 4/4]: single-fix fallback produced a viable rewrite. The remaining ${report.actionableFixes.length - 1} fix(es) are left for the next editorial pass on this article.`,
          "editorialAgent"
        );
      }
    }
  }
  if (!revised) {
    // Both N-fix and 1-fix attempts were rejected. Genuinely zero
    // improvement this round. The per-attempt rejection reasons are
    // already logged inside `rewriteArticleWithFixes`; this is the
    // final-state summary.
    agent.log(
      "warning",
      `Editorial Agent [step 4/4]: rewrite rejected by quality gates (reason=${lastRejectionReason}) — original stays live at kvKey=${kvKey}. See editorial-report:${kvKey} in KV for the audit findings the rewrite was meant to address.`,
      "editorialAgent"
    );
    await incrementEditorialStat(agent, "fail", lastRejectionReason);
    return {
      success: false,
      report,
      error: `rewrite failed (${lastRejectionReason})`
    };
  }
  // Apply the rewrite IN PLACE — overwrite the live `kvKey` so the
  // improvement actually reaches readers. The prior "variant B"
  // approach (write to `${kvKey}-b` and wait for a split-test) was
  // killed 2026-05-09 because the split-tester never shipped, leaving
  // every editorial rewrite to sit unused in KV while the original
  // (with the defects the audit just identified) stayed live. Now the
  // rewrite goes live the moment it's produced.
  //
  // Safety: `rewriteArticleWithFixes` returns `null` when the rewrite
  // fails the plagiarism check, salvage logic, or any other internal
  // quality gate — we already returned above (line 316) in that case.
  // What lands here has passed every gate the original article passed.
  //
  // Audit trail: the prior version is snapshotted to
  // `${kvKey}-pre-editorial:<ISO>` with a 14-day TTL so an operator
  // can rollback if the live rewrite is somehow worse than the
  // original, and so the activity log + dashboard can diff before/after.
  // Defensive price strip before the rewrite goes to KV. The rewrite
  // prompt + passesPlagiarismCheck already reject obvious prices, but
  // this is the last line of defense for edge cases.
  // Look up the article's original keyword so we can whitelist its own
  // price token (e.g. "$50" in "best cat fountain under $50"). Without
  // the whitelist the keyword price would be stripped from the title/H1
  // of the rewrite, producing mangled text like "best cat fountain under".
  let articleKeyword = "";
  let keywordPriceTokens: string[] = [];
  try {
    const kw = agent.sql<{ keyword: string }>`
      SELECT keyword FROM articles WHERE kv_key = ${kvKey} LIMIT 1
    `;
    if (kw.length > 0 && kw[0].keyword) {
      articleKeyword = kw[0].keyword;
      keywordPriceTokens = extractKeywordPriceTokens(articleKeyword);
    } else {
      // Zero rows isn't a SQL error — the try/catch below never fires for
      // it — but it silently disables the whole SEO-regression gate further
      // down (gated on `if (articleKeyword)`). Log so a skipped gate is
      // visible in the activity feed instead of indistinguishable from "gate
      // ran and passed."
      agent.log(
        "warning",
        `Editorial Agent [step 4/4]: no articles row found for kv_key ${kvKey} — SEO-regression gate will be skipped (keyword unknown)`,
        "editorialAgent"
      );
    }
  } catch (sqlErr: unknown) {
    // Non-fatal: fall back to no whitelist, but log so the activity feed
    // shows the failure rather than silently producing unwhitelisted output.
    agent.log(
      "warning",
      `Editorial Agent [step 4/4]: keyword price-whitelist SQL lookup failed (no whitelist applied): ${errMsg(sqlErr)}`,
      "editorialAgent"
    );
  }
  const cleanedRewrite = stripPricesFromHtml(revised, keywordPriceTokens);
  if (cleanedRewrite.stripped.length > 0) {
    agent.log(
      "warning",
      `Editorial Agent [step 4/4]: stripped ${cleanedRewrite.stripped.length} price mention(s) from rewrite before publish — ${cleanedRewrite.stripped.slice(0, 3).join(", ")}`,
      "editorialAgent"
    );
  }
  // Post-rewrite SERP-window repair: even with the explicit prompt
  // constraint above, Kimi sometimes returns a <title> outside the
  // 45-60 window or a meta description outside 140-160. Repair in
  // place using the same enforce-window helpers the writer step
  // uses. Same belt-and-braces pattern as #4792 (why-we-like
  // marker) and #4953 (writer-step title/meta normalization).
  const titleM = cleanedRewrite.cleaned.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleM) {
    const noOrphanTail = trimTrailingTitleOrphanModifiers(titleM[1]);
    const keywordContext = articleKeyword || noOrphanTail;
    const firstPass = enforceTitleSerpWindow(noOrphanTail, keywordContext);
    const noOrphanAfterWindow = trimTrailingTitleOrphanModifiers(
      firstPass.title
    );
    const preWindowOrphanTrimmed = noOrphanTail !== titleM[1];
    const secondPassOrphanTrimmed = noOrphanAfterWindow !== firstPass.title;
    const repaired =
      noOrphanAfterWindow === firstPass.title
        ? firstPass
        : enforceTitleSerpWindow(noOrphanAfterWindow, keywordContext);
    const orphanTrimmed = preWindowOrphanTrimmed || secondPassOrphanTrimmed;
    const serpAdjusted =
      firstPass.title !== noOrphanTail ||
      repaired.title !== noOrphanAfterWindow;
    if (orphanTrimmed || serpAdjusted) {
      const reasonParts: string[] = [];
      if (orphanTrimmed) reasonParts.push("removed trailing orphan modifier");
      if (firstPass.reason && secondPassOrphanTrimmed) {
        reasonParts.push(firstPass.reason);
      }
      if (repaired.reason) reasonParts.push(repaired.reason);
      const reason = reasonParts.join("; ") || "normalized title";
      agent.log(
        "info",
        `Editorial Agent: post-rewrite title repair (${reason})`,
        "editorialAgent"
      );
      cleanedRewrite.cleaned = cleanedRewrite.cleaned.replace(
        /<title>[\s\S]*?<\/title>/i,
        `<title>${repaired.title}</title>`
      );
    }
  }
  if (articleKeyword) {
    const metaM = cleanedRewrite.cleaned.match(
      /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i
    );
    if (metaM) {
      const repaired = enforceMetaSerpWindow(metaM[1], articleKeyword);
      if (repaired.changed) {
        agent.log(
          "info",
          `Editorial Agent: post-rewrite meta SERP-window repair (${repaired.reason})`,
          "editorialAgent"
        );
        cleanedRewrite.cleaned = cleanedRewrite.cleaned.replace(
          /(<meta\s+name=["']description["']\s+content=["'])([^"']*)(["'])/i,
          (_, p1, _p2, p3) => `${p1}${repaired.meta}${p3}`
        );
      }
    }
  }
  // JSON-LD verbatim preservation. Schemas (Article, BreadcrumbList,
  // FAQPage, ItemList, Product, VideoObject) are deterministic given
  // keyword/title/products — they should NEVER differ between the
  // original and a rewrite. The rewrite prompt asks Kimi to preserve
  // them verbatim, but it still occasionally truncates a JSON value,
  // drops a `@type`, or omits a block entirely. Splice every original
  // `<script type="application/ld+json">` block back into the rewrite
  // unconditionally, replacing any rewrite blocks. Skipped when the
  // rewrite has no `<head>` — that's a document-shape regression caught
  // below.
  const rewriteHeadForLd = /<head\b[^>]*>/i.test(cleanedRewrite.cleaned);
  if (rewriteHeadForLd) {
    const ldRe =
      /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi;
    const originalLdBlocks = html.match(ldRe) ?? [];
    if (originalLdBlocks.length > 0) {
      const rewriteLdBlocks = cleanedRewrite.cleaned.match(ldRe) ?? [];
      const stripped = cleanedRewrite.cleaned.replace(ldRe, "");
      const injection = originalLdBlocks.join("\n");
      cleanedRewrite.cleaned = stripped.replace(
        /<\/head\s*>/i,
        `${injection}\n</head>`
      );
      if (
        rewriteLdBlocks.length !== originalLdBlocks.length ||
        rewriteLdBlocks.join("") !== originalLdBlocks.join("")
      ) {
        agent.log(
          "info",
          `Editorial Agent: post-rewrite JSON-LD preservation — replaced ${rewriteLdBlocks.length} rewrite block(s) with ${originalLdBlocks.length} verbatim original block(s)`,
          "editorialAgent"
        );
      }
    }
  }
  // Hard H1-count guard. "Exactly one H1" (seo-score.ts check #103) is a
  // structural invariant, not a scorable-and-offsettable quality signal —
  // a duplicated article body (two full sections, two H1s) can still net a
  // passing SEO-regression delta because doubling the content inflates
  // several volume-based checks (word count, keyword density, internal
  // link count, heading-count minimums) enough to offset the one lost
  // point from this check. Enforce it unconditionally, independent of the
  // `articleKeyword` guard above, so it can't be silently bypassed by a
  // failed/empty keyword lookup either. (Observed live 2026-07:
  // anti-slip-bathtub-mat-for-senior-cats published with two complete
  // article bodies concatenated, two <h1> tags, ~2x expected size — the
  // net-score gate below didn't catch it because of exactly this gap.)
  const rewriteH1Count = (cleanedRewrite.cleaned.match(/<h1\b/gi) || []).length;
  if (rewriteH1Count !== 1) {
    agent.log(
      "warning",
      `Editorial Agent [step 4/4]: rewrite rejected — H1 count regression (rewrite has ${rewriteH1Count} <h1> tags, expected exactly 1). Original stays live at ${kvKey}.`,
      "editorialAgent"
    );
    await incrementEditorialStat(agent, "fail", "h1-count-regression");
    return { success: false, report, error: "h1 count regression" };
  }
  // SEO regression guard. A rewrite that passes plagiarism + price +
  // salvage checks could still SCORE WORSE than the original on the
  // 100-point SEO scorecard — e.g. lost keyword density, broken
  // heading hierarchy, removed JSON-LD blocks, missing alt text. We
  // would rather keep the original (which we know ranks) than
  // publish a more-readable-but-worse-ranking rewrite.
  //
  // Skipped when we couldn't recover the article's keyword from
  // SQL (no keyword = no score = can't compare). That's logged
  // above as a separate warning.
  if (articleKeyword) {
    const oldScore = calculateSEOScore(html, articleKeyword, "", "");
    const newScore = calculateSEOScore(
      cleanedRewrite.cleaned,
      articleKeyword,
      "",
      ""
    );
    const delta = newScore.score - oldScore.score;
    if (delta < -SEO_REGRESSION_CUSHION) {
      // Per-check attribution: list the specific scorecard checks
      // that flipped pass → fail in the rewrite. Without this,
      // operators see only the aggregate delta ("old=99 new=92")
      // and can't tell whether the regression is a Kimi quirk
      // (title length, heading hierarchy, intro keyword) or a
      // generator-side issue (canonical, schema, internal links).
      // The 0.75% editorial pass rate observed 2026-05-30 with
      // 97/133 fails on seo-regression made this visibility the
      // single highest-leverage diagnostic improvement.
      const oldFailed = new Set(
        oldScore.checks.filter((c) => !c.passed).map((c) => c.id)
      );
      const newRegressed = newScore.checks.filter(
        (c) => !c.passed && !oldFailed.has(c.id)
      );
      const regressedSummary = newRegressed
        .slice(0, 6)
        .map((c) => `#${c.id} ${c.name}`)
        .join(" | ");
      const regressedTail =
        newRegressed.length > 6 ? ` … +${newRegressed.length - 6} more` : "";
      agent.log(
        "warning",
        `Editorial Agent [step 4/4]: rewrite rejected — SEO regression (old=${oldScore.score}, new=${newScore.score}, delta=${delta}, cushion=${SEO_REGRESSION_CUSHION}). Regressed checks: ${regressedSummary}${regressedTail}. Original stays live at ${kvKey}.`,
        "editorialAgent"
      );
      await incrementEditorialStat(agent, "fail", "seo-regression");
      return { success: false, report, error: "seo regression" };
    }
    agent.log(
      "info",
      `Editorial Agent [step 4/4]: SEO score check passed (old=${oldScore.score}, new=${newScore.score}, delta=${delta >= 0 ? "+" : ""}${delta}). Proceeding with publish.`,
      "editorialAgent"
    );
  }
  // Document-shape regression guard. The article HTML stored in KV is
  // a FULL HTML document — `<!DOCTYPE html><html><head>...</head><body>...`
  // — but the rewrite prompt only asks Kimi for "the article", which
  // it often interprets as just the `<article>` body fragment. Writing
  // such a fragment in place strips every page's `<head>`, JSON-LD,
  // og:image meta, stylesheet, breadcrumb — Google sees broken pages,
  // users see unstyled content. (Observed 2026-05-28: 7 articles
  // shipped this regression before the guard existed, all restored
  // from the `${kvKey}-pre-editorial:<ISO>` snapshots.)
  //
  // Reject when the original had `<head>`/`<html>` and the rewrite
  // doesn't. Keep the original live.
  const originalHasHead = /<head\b[^>]*>/i.test(html);
  const originalHasHtml = /<html\b[^>]*>/i.test(html);
  const rewriteHasHead = /<head\b[^>]*>/i.test(cleanedRewrite.cleaned);
  const rewriteHasHtml = /<html\b[^>]*>/i.test(cleanedRewrite.cleaned);
  if (
    (originalHasHead && !rewriteHasHead) ||
    (originalHasHtml && !rewriteHasHtml)
  ) {
    agent.log(
      "warning",
      `Editorial Agent [step 4/4]: rewrite rejected — document-shape regression (original had <head>=${originalHasHead} <html>=${originalHasHtml}; rewrite has <head>=${rewriteHasHead} <html>=${rewriteHasHtml}). Original stays live at ${kvKey}.`,
      "editorialAgent"
    );
    await incrementEditorialStat(agent, "fail", "document-shape-regression");
    // Stage 1 of the per-defect-class loop: capture structured evidence
    // (not just a label) so a downstream eval-builder can group related
    // failures into a finding with attached success criterion, and a
    // downstream Copilot task can investigate against a bounded code
    // surface. See `src/pipeline/defect-findings.ts` for the loop
    // architecture; this is the first wire-in point.
    await recordFinding(agent, {
      defectClass: "rewrite-fragment-not-document",
      kvKey,
      timestamp: new Date().toISOString(),
      evidence: {
        originalFirst80Chars: html.slice(0, 80),
        rewriteFirst80Chars: cleanedRewrite.cleaned.slice(0, 80),
        originalHadHead: originalHasHead,
        rewriteHadHead: rewriteHasHead,
        originalHadHtml: originalHasHtml,
        rewriteHadHtml: rewriteHasHtml,
        originalHadDoctype: /^\s*<!DOCTYPE\s+html/i.test(html),
        rewriteHadDoctype: /^\s*<!DOCTYPE\s+html/i.test(cleanedRewrite.cleaned),
        originalLength: html.length,
        rewriteLength: cleanedRewrite.cleaned.length
      },
      // Pointer for Copilot — the suspected code area. The OUTPUT
      // FORMAT block in the rewrite system prompt is the most likely
      // culprit: it currently says "Return RAW HTML only" without
      // specifying the document shape. Copilot is free to disprove
      // this and route the case back if the evidence points elsewhere.
      suspectedCodePath:
        "src/pipeline/editorial-agent.ts:runRewriteAttempt:system_prompt_OUTPUT_FORMAT_block"
    });
    return { success: false, report, error: "document shape regression" };
  }
  // JSON-LD regression guard. The original article shipped through the
  // writer pipeline's Step 14.5 validator and is the baseline. If the
  // rewrite BROKE valid JSON-LD that the original had (e.g. corrupted
  // a JSON string value, dropped a required field, dropped an entire
  // block), reject — even though plagiarism/price/SEO-score all
  // passed. Schema-corruption is invisible in body text but kills the
  // Rich Results eligibility we paid generation cost for.
  try {
    const oldJsonLd = validateJsonLd(html);
    const newJsonLd = validateJsonLd(cleanedRewrite.cleaned);
    // Only fail when the rewrite REGRESSED — if the original was already
    // broken, we're not making things worse and shouldn't block the
    // rewrite from shipping its other improvements.
    if (oldJsonLd.valid && !newJsonLd.valid) {
      const errSnippets = newJsonLd.blocks
        .flatMap((b) => b.errors)
        .slice(0, 3)
        .join(" | ");
      agent.log(
        "warning",
        `Editorial Agent [step 4/4]: rewrite rejected — JSON-LD regression (old: ${oldJsonLd.blockCount} valid blocks; new: ${errSnippets}). Original stays live at ${kvKey}.`,
        "editorialAgent"
      );
      await incrementEditorialStat(agent, "fail", "jsonld-regression");
      return { success: false, report, error: "jsonld regression" };
    }
    // Block-count regression: validateJsonLd reports `valid: true` for
    // zero-block rewrites (no parse errors = valid). Same bug pattern
    // shipped in siss-optimizer #4719 — a rewrite that DROPS JSON-LD
    // blocks slips past the parse-error gate while losing every Rich
    // Results signal we paid generation cost for. Reject when the
    // rewrite has strictly fewer JSON-LD blocks than the original.
    if (
      oldJsonLd.blockCount > 0 &&
      newJsonLd.blockCount < oldJsonLd.blockCount
    ) {
      agent.log(
        "warning",
        `Editorial Agent [step 4/4]: rewrite rejected — JSON-LD block-count regression (original had ${oldJsonLd.blockCount} block(s); rewrite has ${newJsonLd.blockCount}). Original stays live at ${kvKey}.`,
        "editorialAgent"
      );
      await incrementEditorialStat(agent, "fail", "jsonld-regression");
      return { success: false, report, error: "jsonld regression" };
    }
  } catch (jsonLdErr: unknown) {
    // Validator-internal error shouldn't block the rewrite — log info
    // and continue. The validator is stateless; an error here is
    // unexpected and worth surfacing but not actionable enough to
    // hold the rewrite.
    agent.log(
      "info",
      `Editorial Agent [step 4/4]: JSON-LD validator threw on rewrite check (${errMsg(jsonLdErr)}); proceeding`,
      "editorialAgent"
    );
  }
  // FTC false-endorsement gate: reject the rewrite if Kimi reverted
  // the bio (or any prose) to fabricated product-testing language
  // despite rules 7 + 8 in the system prompt. Empirically (live audit
  // 2026-06-05, article `hooded-cat-steps-with-storage` published at
  // 10:29:16) Kimi ignored the "preserve bio verbatim" instruction and
  // regenerated the pre-fix bio "Amelia has cared for thousands of
  // cats and tested hundreds of products in real boarding facility
  // conditions" — a 16 CFR Part 255 false-endorsement claim. A HARD
  // BAN in the prompt is insufficient; this is the deterministic
  // post-rewrite gate that REJECTS the rewrite + keeps the (clean)
  // original live when Kimi drifts. Mirrors the XSS gate shape so
  // the defect-finding loop catches recurring violations.
  // Apply the FTC proximity exception before scanning: comparative
  // claims inside the template-emitted `<section class="wc-
  // methodology">` block carry their own proximate disclosure and
  // must not trip the gate. See `stripCompliantMethodologySections`
  // doc-block for the exact scope.
  const ftcRewriteText = stripHtmlToPlainText(
    stripCompliantMethodologySections(cleanedRewrite.cleaned)
  );
  const ftcFindings = detectFabricatedTestingClaims(ftcRewriteText);
  if (ftcFindings.length > 0) {
    const ftcSummary = summarizeFabricatedTestingClaims(ftcFindings);
    agent.log(
      "warning",
      `Editorial Agent [step 4/4]: rewrite rejected — FTC gate: ${ftcSummary}. Original stays live at ${kvKey}. Sample: "${ftcFindings[0].sentence.slice(0, 160)}"`,
      "editorialAgent"
    );
    await incrementEditorialStat(agent, "fail", "ftc-false-endorsement");
    await recordFinding(agent, {
      defectClass: "editorial-rewrite-ftc-violation",
      kvKey,
      timestamp: new Date().toISOString(),
      evidence: {
        summary: ftcSummary,
        occurrenceCount: ftcFindings.length,
        matchedPhrases: ftcFindings
          .slice(0, 5)
          .map((f) => f.trigger)
          .join(", "),
        sampleSentence: ftcFindings[0].sentence.slice(0, 240),
        rewriteLength: cleanedRewrite.cleaned.length
      },
      suspectedCodePath:
        "src/pipeline/editorial-agent.ts:runRewriteAttempt:system_prompt — Kimi ignored rules 7 (bio immutability) + 8 (FTC ban) and reverted bio to pre-fix false-endorsement claims; prompt phrasing or model conditioning need stronger constraints"
    });
    return { success: false, report, error: "ftc gate" };
  }
  // XSS gate: reject the rewrite if it contains script-injection
  // patterns that NEVER legitimately appear in a generated article.
  // Event handler attributes (`on*="…"`) and `javascript:` /
  // `vbscript:` URLs are not produced by html-builder.ts or any other
  // template path, so any occurrence in a Kimi-rewritten body is a
  // prompt-injection signal. Bare `<script>` is NOT gated here because
  // legitimate JSON-LD blocks use `<script type="application/ld+json">`.
  // Mirrors the gate shipped in siss-optimizer.ts (#4718) since the
  // editorial-agent rewrite path has the same threat shape: untrusted
  // upstream text (audit findings, plagiarism-matched phrases) feeds
  // into Kimi → output ships to live KV → user browser.
  const handlerOrJsUrlRe = /(?:\bon[a-z]+\s*=|\b(?:javascript|vbscript)\s*:)/i;
  const xssMatch = cleanedRewrite.cleaned.match(handlerOrJsUrlRe);
  if (xssMatch) {
    agent.log(
      "warning",
      `Editorial Agent [step 4/4]: rewrite rejected — XSS gate: event-handler or javascript:/vbscript: URL detected in rewrite output. Original stays live at ${kvKey}.`,
      "editorialAgent"
    );
    await incrementEditorialStat(agent, "fail", "xss-handler-or-script-url");
    // Feed the defect-finding loop so recurring Kimi XSS drift
    // (prompt regression) actually escalates to Copilot at 5-in-24h
    // instead of every rewrite getting silently dropped.
    const matchIdx = cleanedRewrite.cleaned.indexOf(xssMatch[0]);
    const snippet = cleanedRewrite.cleaned.slice(
      Math.max(0, matchIdx - 60),
      matchIdx + xssMatch[0].length + 60
    );
    await recordFinding(agent, {
      defectClass: "post-rewrite-xss-detected",
      kvKey,
      timestamp: new Date().toISOString(),
      evidence: {
        matchedPattern: xssMatch[0],
        snippet,
        rewriteLength: cleanedRewrite.cleaned.length
      },
      suspectedCodePath:
        "src/pipeline/editorial-agent.ts:runRewriteAttempt:system_prompt — rewrite prompt allowed Kimi to insert event-handler attribute or javascript:/vbscript: URL; prompt needs an explicit XSS-disallow clause"
    });
    return { success: false, report, error: "xss gate" };
  }
  // Snapshot the pre-rewrite HTML for rollback / diff. 14-day TTL keeps
  // KV from growing unboundedly. Skipped silently on error since the
  // rewrite publish is the deliverable, not the audit trail.
  try {
    const snapshotKey = `${kvKey}-pre-editorial:${new Date().toISOString()}`;
    await agent.envBindings.ARTICLES_KV.put(snapshotKey, html, {
      expirationTtl: EDITORIAL_SNAPSHOT_TTL_SECONDS
    });
  } catch {
    /* ignore — snapshot is best-effort */
  }
  // Overwrite the live article. `kvKey` is the canonical published URL
  // backing the page on catsluvus.com — the next request after this
  // write serves the improved version. Prod-published articles live in
  // the production namespace, reachable only via REST.
  if (prodPublished) {
    const prodApi = prodKvRestApi(agent.envBindings);
    const putRes = prodApi
      ? await fetch(`${prodApi.base}/${encodeURIComponent(kvKey)}`, {
          method: "PUT",
          headers: {
            ...prodApi.headers,
            "Content-Type": "text/plain; charset=UTF-8"
          },
          body: cleanedRewrite.cleaned
        })
      : null;
    if (!putRes?.ok) {
      agent.log(
        "error",
        `Editorial Agent [step 4/4]: prod KV write failed for ${kvKey} (HTTP ${putRes?.status ?? "no creds"}) — live article unchanged`,
        "editorialAgent"
      );
      await incrementEditorialStat(agent, "fail", "prod-kv-write-failed");
      return { success: false, report, error: "prod KV write failed" };
    }
  } else {
    await agent.envBindings.ARTICLES_KV.put(kvKey, cleanedRewrite.cleaned);
  }
  // Persist updated report. `variantBKey` is intentionally left unset
  // because there is no variant B anymore — the rewrite IS the live
  // article. Kept in the type as optional for backwards compatibility
  // with older `editorial-report:*` records still in KV.
  await agent.envBindings.ARTICLES_KV.put(
    `editorial-report:${kvKey}`,
    JSON.stringify(report),
    { expirationTtl: EDITORIAL_SNAPSHOT_TTL_SECONDS }
  );
  agent.log(
    "info",
    `Editorial Agent [step 4/4]: rewrite published in place — ${kvKey} now ${cleanedRewrite.cleaned.length} bytes, live at ${publicUrl}. Pre-rewrite snapshot saved with 14d TTL for rollback.`,
    "editorialAgent"
  );
  await incrementEditorialStat(agent, "success");
  return { success: true, report };
}

function extractBodyText(html: string): string {
  return unescapeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function kvKeyToPublicUrl(
  agent: SEOArticleAgent,
  kvKey: string,
  domainOverride?: string
): string {
  const domain = domainOverride || agent.envBindings.DOMAIN || "catsluvus.com";
  // KV key format varies; if it's `<category>:<slug>` map to
  // https://<domain>/<category>/<slug>. For additional `:` segments in the
  // slug part, preserve them as `-` so we still build a valid article URL.
  const parts = kvKey
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length >= 2) {
    return `https://${domain}/${keywordToSlug(parts[0])}/${keywordToSlug(parts.slice(1).join("-"))}`;
  }
  return `https://${domain}/${keywordToSlug(kvKey)}`;
}

/**
 * Internal return shape from Kimi-backed audits. `kimiFailed` lets the
 * caller distinguish "audit ran, found nothing" from "audit never ran
 * because the model was unavailable" — both used to produce identical
 * empty arrays and got bucketed as `skipped: no-actionable-fixes`,
 * silently masking OpenRouter token-budget exhaustion / quota errors.
 */
type TextAuditResult = Omit<EditorialReport["textAudit"], "wordCount"> & {
  kimiFailed: boolean;
};

async function auditTextAgainstReference(
  agent: SEOArticleAgent,
  bodyText: string,
  referenceUrl: string,
  wireframe: WireframeSummary | null
): Promise<TextAuditResult> {
  const system = `You are a senior editorial auditor. You assess whether a published article covers the STRUCTURAL PATTERNS a top commerce review has — trust blocks, audience qualification, selection criteria, methodology, pick archetypes, tradeoff blocks. You do NOT compare the ARTICLE'S CONTENT to any other article; our topic, title, products, and voice stand alone.

${ANTI_PLAGIARISM_RULE}

Return strict JSON with keys: missingSections (array), weaknessesVsReference (array), factualRisks (array), toneIssues (array). No markdown, no prose, just JSON. Every finding must describe a STRUCTURAL or COMPREHENSIVENESS gap ("our article lacks a who-this-is-for section for OUR topic") — never a verbatim phrase to copy ("add the phrase 'the quietest box we tested'"). If you catch yourself quoting the wireframe, rewrite that finding into a generic structural note.`;
  const wireframeBlock = wireframe ? buildWireframePromptBlock(wireframe) : "";
  const prompt = `Our published article (first 6000 chars):\n${bodyText.slice(0, 6000)}\n\n${wireframeBlock || `Wireframe URL (we could not ingest it structurally — fall back to general commerce-review best-practice knowledge, never copy wording from it): ${referenceUrl}`}\n\nList at most 6 items per category. Each finding must be actionable for OUR topic, not a copy of the wireframe's content. If a category has none, return [].`;
  try {
    const text = await runKimiWithPoll(
      agent.envBindings,
      {
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        max_tokens: 2048
      },
      { syncTimeoutMs: 90_000 },
      agent
    );
    const parsed = extractJsonObject(text);
    return {
      missingSections: sanitizeStringArray(parsed?.missingSections),
      weaknessesVsReference: sanitizeStringArray(parsed?.weaknessesVsReference),
      factualRisks: sanitizeStringArray(parsed?.factualRisks),
      toneIssues: sanitizeStringArray(parsed?.toneIssues),
      kimiFailed: false
    };
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Editorial Agent: text audit generation failed: ${errMsg(err)}`,
      "editorialAgent"
    );
    return {
      missingSections: [],
      weaknessesVsReference: [],
      factualRisks: [],
      toneIssues: [],
      kimiFailed: true
    };
  }
}

/**
 * Captures the live page (rendered text + screenshots) via Cloudflare
 * Browser Rendering — the only browser backend.
 */
async function collectScreenshots(
  agent: SEOArticleAgent,
  url: string
): Promise<{ urls: string[]; extractedText: string }> {
  return await collectScreenshotsViaCloudflare(agent, url);
}

/**
 * Cloudflare Browser Rendering API. We own the endpoint and bindings so
 * this is the reliable browser backend. Uses `renderPage` (HTML content)
 * + a desktop `capturePageScreenshot` (JPEG bytes → R2 → worker-served
 * URL so the audit + the dashboard A/B panel can reach the image).
 */
async function collectScreenshotsViaCloudflare(
  agent: SEOArticleAgent,
  url: string,
  prefillText = ""
): Promise<{ urls: string[]; extractedText: string }> {
  const accountId = agent.envBindings.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = agent.envBindings.CLOUDFLARE_API_TOKEN_SECRET?.trim();
  if (!accountId || !apiToken) {
    const missingBindings = getMissingBrowserRenderingBindings(
      accountId,
      apiToken
    );
    if (missingBindings.length === 1) {
      agent.log(
        "warning",
        `Editorial Agent: Cloudflare Browser Rendering skipped: missing ${missingBindings.join(", ")}; set both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN_SECRET`,
        "editorialAgent"
      );
    } else {
      agent.log(
        "info",
        "Editorial Agent: Cloudflare Browser Rendering fallback unavailable (CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN_SECRET unset)",
        "editorialAgent"
      );
    }
    return { urls: [], extractedText: prefillText };
  }

  const slug = url
    .replace(/^https?:\/\//, "")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 120);
  const urls: string[] = [];
  let extractedText = prefillText;

  // Text via /browser-rendering/content.
  try {
    const { html, error } = await renderPage(accountId, apiToken, url);
    if (error) {
      agent.log(
        "warning",
        `Editorial Agent: CF renderPage error — ${error}`,
        "editorialAgent"
      );
    } else if (html) {
      extractedText = extractBodyText(html).slice(0, 8000);
    }
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Editorial Agent: CF renderPage threw — ${errMsg(err)}`,
      "editorialAgent"
    );
  }

  // Screenshot via /browser-rendering/screenshot → R2 → worker URL.
  try {
    const { bytes, error } = await capturePageScreenshot(
      accountId,
      apiToken,
      url,
      DESIGN_AUDIT_VIEWPORTS.desktop
    );
    if (error) {
      agent.log(
        "warning",
        `Editorial Agent: CF capturePageScreenshot error — ${error}`,
        "editorialAgent"
      );
    } else if (bytes && bytes.byteLength > 0) {
      const r2Key = `editorial-screenshots/${slug}/desktop.jpg`;
      await agent.envBindings.IMAGES_R2.put(r2Key, bytes, {
        httpMetadata: { contentType: "image/jpeg" }
      });
      // Path-only URL. Dashboard iframes are same-origin so `/api/...`
      // resolves correctly. Out-of-worker consumers (external crawlers)
      // prepend the worker host before fetching.
      const workerUrl = `/api/screenshot?key=${encodeURIComponent(slug + "/desktop.jpg")}`;
      urls.push(workerUrl);
      agent.log(
        "info",
        `Editorial Agent: CF screenshot captured (${bytes.byteLength} bytes) → ${r2Key}`,
        "editorialAgent"
      );
    }
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Editorial Agent: CF screenshot threw — ${errMsg(err)}`,
      "editorialAgent"
    );
  }

  return { urls, extractedText };
}

type VisualAuditResult = Omit<
  EditorialReport["visualAudit"],
  "screenshotUrls"
> & { kimiFailed: boolean };

async function auditScreenshots(
  agent: SEOArticleAgent,
  screenshotUrls: string[],
  referenceUrl: string,
  wireframe: WireframeSummary | null
): Promise<VisualAuditResult> {
  if (screenshotUrls.length === 0) {
    return {
      layoutIssues: [],
      densityIssues: [],
      ctaIssues: [],
      kimiFailed: false
    };
  }
  const system = `You are a visual/UX auditor. Given the list of screenshot URLs and a list of abstract LAYOUT PATTERNS a strong commerce review has, return strict JSON with keys: layoutIssues (array), densityIssues (array), ctaIssues (array). Focus on what a reader sees above the fold and whether OUR article's hierarchy implements the abstract patterns.

${ANTI_PLAGIARISM_RULE}

Findings must describe VISUAL/LAYOUT gaps ("our above-the-fold lacks a comparison-at-a-glance table for OUR products"), never copy tables, headlines, captions, or microcopy from any other article.`;
  const patternsLine = wireframe
    ? `Abstract layout patterns to check for (structural only, not content):\n- feature.has_at_a_glance_table: ${wireframe.features.hasAtAGlanceTable}\n- feature.has_tradeoff_block_per_pick: ${wireframe.features.hasTradeoffBlockPerPick}\n- feature.has_who_this_is_for: ${wireframe.features.hasWhoThisIsFor}\n- feature.has_how_we_picked: ${wireframe.features.hasHowWePicked}\n- feature.has_how_we_tested: ${wireframe.features.hasHowWeTested}`
    : `Wireframe not ingested — use general commerce-review layout best-practices; do NOT copy wording from: ${referenceUrl}`;
  const prompt = `Our article screenshots:\n${screenshotUrls.join("\n")}\n\n${patternsLine}\n\nReturn at most 4 items per category. Be specific about LAYOUT not CONTENT. Empty arrays allowed.`;
  try {
    const text = await runKimiWithPoll(
      agent.envBindings,
      {
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        max_tokens: 1024
      },
      { syncTimeoutMs: 90_000 },
      agent
    );
    const parsed = extractJsonObject(text);
    return {
      layoutIssues: sanitizeStringArray(parsed?.layoutIssues),
      densityIssues: sanitizeStringArray(parsed?.densityIssues),
      ctaIssues: sanitizeStringArray(parsed?.ctaIssues),
      kimiFailed: false
    };
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Editorial Agent: screenshot visual audit failed — ${errMsg(err)}`,
      "editorialAgent"
    );
    return {
      layoutIssues: [],
      densityIssues: [],
      ctaIssues: [],
      kimiFailed: true
    };
  }
}

/**
 * Per-attempt result from `runRewriteAttempt`. The outer
 * `rewriteArticleWithFixes` uses this to decide whether to retry
 * (plagiarism rejection only) or give up (other failure modes —
 * empty/short/salvage-failed/Kimi-error). Non-plagiarism failures
 * won't benefit from a phrase ban.
 */
type RewriteAttemptResult =
  | { ok: true; html: string }
  | { ok: false; rejection: "plagiarism"; matched: string }
  | { ok: false; rejection: "kimi-credits-exhausted" }
  | { ok: false; rejection: "other" };

/**
 * Outcome of `rewriteArticleWithFixes`. `html` is the new article when
 * the rewrite passed every gate, otherwise `null`. When `html` is null,
 * `rejectionReason` carries the specific cause so the caller can
 * attribute the stat correctly — distinguishing the OpenRouter
 * credits-exhaustion case (operational) from generic
 * `rewrite-rejected` (content-level).
 */
export type RewriteOutcome =
  | { html: string }
  | {
      html: null;
      rejectionReason: "kimi-credits-exhausted" | "rewrite-rejected";
    };

/**
 * Rewrites a published article using actionable findings from the
 * editorial report while preserving affiliate links and product blocks.
 * Returns `{ html }` when the rewrite passes safety gates; otherwise
 * `{ html: null, rejectionReason }` so the caller keeps the original
 * variant untouched AND records the right failure category.
 */
async function rewriteArticleWithFixes(
  agent: SEOArticleAgent,
  originalHtml: string,
  report: EditorialReport,
  wireframe: WireframeSummary | null
): Promise<RewriteOutcome> {
  // Up to 2 attempts total: the first goes in with the standard prompt,
  // and on plagiarism rejection we retry once with the matched phrase
  // explicitly added to the ban list so Kimi's second attempt can't
  // reuse it. Price hallucinations and non-plagiarism failures (empty,
  // too-short, salvage-failed, Kimi error) don't retry — those are
  // different failure modes that a phrase ban won't fix.
  const MAX_PLAGIARISM_RETRIES = 1;
  const bannedPhrases: string[] = [];

  for (let attempt = 0; attempt <= MAX_PLAGIARISM_RETRIES; attempt++) {
    if (attempt > 0) {
      agent.log(
        "info",
        `Editorial Agent: retrying rewrite (attempt ${attempt + 1}/${MAX_PLAGIARISM_RETRIES + 1}) with ${bannedPhrases.length} banned phrase(s) added to the prompt`,
        "editorialAgent"
      );
    }
    const result = await runRewriteAttempt(
      agent,
      originalHtml,
      report,
      wireframe,
      bannedPhrases
    );
    if (result.ok) {
      return { html: result.html };
    }
    if (result.rejection === "plagiarism" && attempt < MAX_PLAGIARISM_RETRIES) {
      bannedPhrases.push(result.matched);
      continue;
    }
    if (result.rejection === "kimi-credits-exhausted") {
      return { html: null, rejectionReason: "kimi-credits-exhausted" };
    }
    return { html: null, rejectionReason: "rewrite-rejected" };
  }
  return { html: null, rejectionReason: "rewrite-rejected" };
}

async function runRewriteAttempt(
  agent: SEOArticleAgent,
  originalHtml: string,
  report: EditorialReport,
  wireframe: WireframeSummary | null,
  bannedPhrases: string[]
): Promise<RewriteAttemptResult> {
  const fixList = report.actionableFixes.map((f) => `- ${f}`).join("\n");
  // Banned-phrase block: only present on retry attempts (when the prior
  // attempt's plagiarism check flagged a specific phrase). Lists the
  // exact phrases Kimi must NOT include this time.
  const banBlock =
    bannedPhrases.length > 0
      ? `\n\nEXPLICIT BAN LIST (these phrases triggered rejection on a prior attempt of this same article — do NOT use any of them anywhere in the output):\n${bannedPhrases.map((p) => `  - ${JSON.stringify(p)}`).join("\n")}`
      : "";
  // Per-article self-improvement: prepend whatever lessons the previous
  // article's rewrite (or any earlier rewrite) left in KV. This is what
  // makes the loop converge over the course of N articles instead of
  // failing the same way 65 times in a row. See editorial-lessons.ts.
  const lessonsBlock = await getActiveLessonsBlock(agent);
  const lessonsPrefix = lessonsBlock ? `${lessonsBlock}\n` : "";
  const system = `${lessonsPrefix}You are an expert SEO editor for catsluvus.com. You rewrite published articles to address specific editorial findings without changing voice, product picks, or affiliate links. Preserve all <a> tags, all <img> tags, and Top Picks blocks verbatim.

OUTPUT FORMAT — HARD REQUIREMENT:
- Your response MUST start with the character "<" and end with ">".
- Return RAW HTML only. No markdown code fences (no \`\`\`html, no \`\`\`). No commentary, no prose preamble, no "Here's the revised article:" line.
- The output must contain real HTML block tags: <article>, <section>, <div>, <p>, <h2>, <h3>, <ul>, <li>. Not markdown headings (#, ##). Not plain paragraphs separated by blank lines.
- If you cannot produce valid HTML, return the original HTML unchanged rather than markdown or plain text.

SERP & STRUCTURAL INVARIANTS — DO NOT REGRESS:
The published article is ranking on these signals. Your rewrite MUST preserve them or it will be REJECTED by the seo-regression gate (currently rejecting ~73% of rewrites because of these exact regressions):
- <title> tag: keep length between 45 and 60 characters. Truncated titles lose SERP CTR.
- <title> must never end with a dangling orphan modifier token (for, to, top, buying, and, or, &, +, etc.). Always end on a complete phrase.
- <meta name="description"> content: keep length between 140 and 160 characters.
- Exactly ONE <h1> tag — never zero, never two. The <h1> is the canonical page topic.
- Heading hierarchy: never skip a level (no H1 → H3 jumps with no H2 between).
- At least 3 internal links (href="https://catsluvus.com/..." or href="/..."). Preserve every existing internal link verbatim.
- Every <img> tag must keep its alt attribute. Don't strip alt="...".
- All JSON-LD <script type="application/ld+json"> blocks must remain valid and complete. Don't truncate or comment them out.
- <link rel="canonical" href="..."> tag: preserve verbatim.

${ANTI_PLAGIARISM_RULE}

Anti-plagiarism hard rules for this rewrite:
  1. Do NOT copy any sentence, phrase longer than 4 consecutive words, product description, testing methodology, caption, or headline from the reference URL or from any NYT/Wirecutter/Condé Nast source you may have in training data.
  2. The wireframe is an ABSTRACT SKELETON — pattern types and structural shapes, not a content or topic source. Our article keeps its own title, topic, products, and voice. Apply the patterns to OUR content.
  3. Our voice is catsluvus.com — cat-owner-to-cat-owner, practical, affiliate-driven. Wirecutter's voice is not our voice; do not imitate their cadence, review vocabulary, or their specific testing vocabulary (e.g. don't write "we spent 60 hours testing" — we didn't).
  4. Every added paragraph must be original prose written from scratch. If a finding says "add a testing methodology section," describe OUR methodology (Amazon review volume, keyword research, affiliate commission bands) — NOT a rehash of Wirecutter's.
  5. Product picks and affiliate links are immutable — never swap an Amazon product for a different one even if the wireframe recommends something else. Never add products that are not already in the original HTML.
  6. NO PRICES — Amazon Associates compliance. Never write any dollar amount, price, or price range in product blocks or anywhere else in the article. Current pricing lives on Amazon; our affiliate link takes the reader there. If a wireframe pattern mentions prices, ignore that part of the pattern and keep our block price-free.
  7. AUTHOR BIO — IMMUTABLE. Preserve the <p class="bio">…</p> paragraph inside the author block VERBATIM from the original HTML. Do NOT rewrite, expand, or "improve" it. The bio is the canonical FTC-compliant author description; any Kimi-authored variant has shipped false-endorsement claims in the past ("Amelia personally reviews and stands behind every product recommendation", "hands-on facility testing") and is a 16 CFR Part 255 risk. If the original bio is missing or malformed, emit it verbatim as:
     <p class="bio">With over 15 years caring for cats at Cats Luv Us Boarding Hotel &amp; Grooming in Laguna Niguel, CA, Amelia draws on daily boarding-floor experience with thousands of cats. Product picks in these guides are synthesized from public manufacturer specs and customer review aggregates — products are not physically tested by Cats Luv Us.</p>
  8. FTC FALSE-ENDORSEMENT BAN — anywhere in the rewrite (bio, body, intro, conclusion, FAQs, methodology section): never claim Cats Luv Us, Amelia, or "our team" personally tested, tried, reviewed, vetted, evaluated, verified, or "stands behind" any product. Never write "hands-on facility testing", "real-world knowledge of the Cats Luv Us team", "every review combines hands-on", "we tested N products", "after N weeks of use", or any equivalent first-person product-trial assertion. Editorial claims must attribute basis to public manufacturer specs, customer review aggregates, or general cat-care experience — never to a trial that did not happen.${banBlock}`;
  const wireframeBlock = wireframe
    ? buildWireframePromptBlock(wireframe)
    : `Wireframe URL (not ingested — use general commerce-review best-practice knowledge; do NOT copy wording from it): ${report.referenceUrl}`;

  // Budgets sized for Kimi K2.5 via OpenRouter. Previous config (40k input
  // + 16k output) routinely overflowed the provider's output cap on Novita/
  // Inceptron/Cloudflare routes, triggering OpenRouter's "Failed to process
  // successful response" (truncated body). 24k input + 8k output hits the
  // sweet spot while still covering every published article.
  const MAX_INPUT_CHARS = 24000;
  const MAX_OUTPUT_TOKENS = 8000;

  // Retry input budget — the retry deliberately rewrites a SMALLER slice
  // (and fewer output tokens) so the request finishes within its timeout
  // instead of re-timing-out on the identical 24k/180s config. Re-sending
  // the same full input after a timeout just burns another 180s and fails
  // the same way ("rewrite retry also failed: aborted due to timeout" was
  // the dominant editorial-agent error class on 2026-05-30).
  const RETRY_INPUT_CHARS = 14000;
  const RETRY_OUTPUT_TOKENS = 6000;

  const inputHtml = originalHtml.slice(0, MAX_INPUT_CHARS);

  const buildPrompt = (slice: string, chars: number): string =>
    `Original published HTML (first ${chars} chars):\n${slice}\n\nEditorial findings to address:\n${fixList}\n\n${wireframeBlock}\n\nReturn the revised HTML. Must be equal or longer than original. Must preserve every affiliate link and product block verbatim. Must address at least 80% of the listed fixes. All new/rewritten prose must be 100% original — zero verbatim borrowing. Absolutely no prices anywhere.`;

  // Tracks the length of the input slice actually rewritten so the
  // post-rewrite "too short" checks compare against the right baseline —
  // the retry rewrites a shorter slice and would otherwise be rejected
  // against the full 24k length.
  let usedInputLen = inputHtml.length;

  const runRewrite = async (
    inputChars: number,
    outputTokens: number,
    timeoutMs: number
  ): Promise<string> => {
    const slice = originalHtml.slice(0, inputChars);
    usedInputLen = slice.length;
    return await runKimiWithPoll(
      agent.envBindings,
      {
        messages: [
          { role: "system", content: system },
          { role: "user", content: buildPrompt(slice, inputChars) }
        ],
        max_tokens: outputTokens
      },
      {
        // 180s budget for the rewrite. Kimi K2.5 routinely takes
        // 60-120s for a full-article rewrite at 8000 max_tokens; the
        // prior 90s cap was timing out on long articles (observed
        // 2026-05-28 on cat-wall-mounted-shelves articles where both
        // the N-fix and single-fix fallback paths timed out, leaving
        // the article with zero improvements applied).
        syncTimeoutMs: timeoutMs,
        // The rewrite is a background task, so give the async batch
        // queue the ~5 minutes Cloudflare documents as typical. The 90s
        // default meant every sync timeout under capacity pressure
        // became a hard rewrite failure (100 of them on 6/10-6/11).
        asyncMaxWaitMs: 300_000
      },
      agent
    );
  };

  let rewritten = "";
  try {
    rewritten = await runRewrite(MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS, 180_000);
  } catch (err: unknown) {
    // Surface the real root cause — AI SDK wraps the provider error and the
    // cause chain is where the actual signal lives ("Unexpected end of JSON",
    // Zod validation, upstream 5xx, etc). Previously we only logged the
    // outer "Failed to process successful response" string and stashed the
    // real failure.
    const errMessage = errMsg(err);
    agent.log(
      "error",
      `Editorial Agent: rewrite generation failed: ${errMessage}`,
      "editorialAgent"
    );
    // Early-exit when the failure is an OpenRouter credits-exhaustion —
    // retrying with a smaller budget can't help (the budget is the
    // *user's account*, not the request), and Workers AI fallback
    // produces weaker output that gets rejected by the SEO regression
    // gate downstream. Attributing this correctly stops the spiral
    // where a billing outage manifests as 100% seo-regression failures.
    if (isKimiCreditsExhausted(errMessage)) {
      return { ok: false, rejection: "kimi-credits-exhausted" };
    }
    // One retry with a tighter budget — helps when the first failure was a
    // max-tokens overflow rather than a content issue.
    try {
      agent.log(
        "info",
        `Editorial Agent: retrying rewrite with reduced input (${RETRY_INPUT_CHARS} chars) + output budget (${RETRY_OUTPUT_TOKENS} tokens)`,
        "editorialAgent"
      );
      // Smaller input + output + a tighter 150s timeout so the retry
      // actually completes instead of re-timing-out on the same config.
      rewritten = await runRewrite(
        RETRY_INPUT_CHARS,
        RETRY_OUTPUT_TOKENS,
        150_000
      );
    } catch (retryErr: unknown) {
      const retryMessage = errMsg(retryErr);
      agent.log(
        "error",
        `Editorial Agent: rewrite retry also failed: ${retryMessage}`,
        "editorialAgent"
      );
      if (isKimiCreditsExhausted(retryMessage)) {
        return { ok: false, rejection: "kimi-credits-exhausted" };
      }
      return { ok: false, rejection: "other" };
    }
  }

  const cleaned = rewritten.trim();
  if (!cleaned) {
    agent.log(
      "warning",
      "Editorial Agent: rewrite returned empty text — leaving original in place",
      "editorialAgent"
    );
    return { ok: false, rejection: "other" };
  }
  // Size check against the TRUNCATED input length (not full original) — we
  // only asked Kimi to rewrite the truncated slice, so comparing against
  // the full article would reject valid rewrites of long articles.
  if (cleaned.length < usedInputLen * 0.8) {
    agent.log(
      "warning",
      `Editorial Agent: rewrite too short (${cleaned.length} vs ${usedInputLen} input chars) — leaving original`,
      "editorialAgent"
    );
    await incrementEditorialStat(agent, "fail", "rewrite too short");
    return { ok: false, rejection: "other" };
  }
  if (!/<\/?(article|section|div|p|h[1-6])/i.test(cleaned)) {
    // Log the first 300 chars of what Kimi actually returned — without
    // this, the log just says "no HTML block tags" and we can't see
    // whether Kimi returned markdown, plain prose, JSON, or something
    // else. Visibility is the fix's prerequisite.
    agent.log(
      "warning",
      `Editorial Agent: rewrite output has no HTML block tags — Kimi returned: ${cleaned.slice(0, 300).replace(/\s+/g, " ")}${cleaned.length > 300 ? "..." : ""}`,
      "editorialAgent"
    );
    // Salvage path — if the content is substantial prose (Kimi
    // ignored the "return HTML" instruction and returned markdown or
    // plain paragraphs), wrap it in a minimal article+paragraph shell
    // so we can still ship a variant B instead of silently dropping
    // everything Kimi produced. Split on blank lines into paragraphs.
    const stripped = cleaned
      .replace(/^```(?:html)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    if (stripped.length >= usedInputLen * 0.8) {
      const paragraphs = stripped
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => `<p>${escXml(p)}</p>`)
        .join("\n");
      const wrapped = `<article>\n${paragraphs}\n</article>`;
      agent.log(
        "info",
        `Editorial Agent: wrapped tagless rewrite output in <article>/<p> shell (${wrapped.length} bytes) — salvaged rewrite`,
        "editorialAgent"
      );
      // Salvaged output skips the plagiarism check because the wrap
      // path means Kimi returned freeform prose rather than structured
      // HTML — there's nothing structural to check against the
      // reference voice that wouldn't already be in the prose. Same
      // behavior as before the retry refactor.
      return { ok: true, html: wrapped };
    }
    // Salvage failed: even after stripping code fences, the cleaned
    // text is too short to be a viable rewrite. This was previously a
    // silent null return — the operator had no signal beyond the
    // generic "rewrite failed" downstream. Log the size delta so the
    // failure is debuggable.
    agent.log(
      "warning",
      `Editorial Agent: rewrite salvage failed — stripped text was ${stripped.length} chars vs ${usedInputLen} input chars (need >= 80%). Leaving original in place.`,
      "editorialAgent"
    );
    await incrementEditorialStat(agent, "fail", "salvage-failed");
    return { ok: false, rejection: "other" };
  }
  const plagiarismCheck = passesPlagiarismCheck(cleaned);
  if (!plagiarismCheck.passed) {
    // `matched` is either a Wirecutter signature phrase (e.g. "our pick
    // for") or a price token wrapped in the form `price "$50"`. The
    // outer retry loop uses the rejection kind to decide whether
    // retrying with a phrase ban will help — only reference-voice
    // phrases benefit (price hallucinations are a different problem;
    // the no-prices prompt rule is already explicit).
    const isPriceHit = plagiarismCheck.matched?.startsWith("price ") ?? false;
    const reasonKind = isPriceHit
      ? "price hallucination"
      : "reference-voice phrase";
    agent.log(
      "warning",
      `Editorial Agent: rewrite rejected — ${reasonKind} ${JSON.stringify(plagiarismCheck.matched)}.`,
      "editorialAgent"
    );
    if (!isPriceHit && plagiarismCheck.matched) {
      return {
        ok: false,
        rejection: "plagiarism",
        matched: plagiarismCheck.matched
      };
    }
    return { ok: false, rejection: "other" };
  }
  return { ok: true, html: cleaned };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function extractJsonObject(text: string): Record<string, unknown> | null {
  const parseJsonObjectCandidate = (
    candidate: string
  ): Record<string, unknown> | null => {
    const objectLike = parseObjectLike(candidate);
    if (objectLike) {
      return objectLike;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const singleItemObject =
        Array.isArray(parsed) && parsed.length === 1
          ? parseObjectLike(parsed[0])
          : null;
      if (singleItemObject) {
        return singleItemObject;
      }
    } catch {
      // fall through to caller
    }
    return null;
  };

  const trimmed = text.trim();
  const fencedBlocks = Array.from(
    trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi),
    (match) => match[1].trim()
  );
  const candidates = [trimmed, ...fencedBlocks];
  for (const candidate of candidates) {
    const parsed = parseJsonObjectCandidate(candidate);
    if (parsed) return parsed;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  for (let end = trimmed.length - 1; end > start; end--) {
    if (trimmed[end] !== "}") continue;
    const candidate = trimmed.slice(start, end + 1);
    const parsed = parseJsonObjectCandidate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, 6);
}
