/**
 * Step 15/24 — Design Audit orchestrator.
 *
 * The raw capabilities (capture screenshot, analyze with Llava) live in
 * `src/tools/` as AI-SDK tools so they're also callable from agentic
 * loops and MCP clients. This module is the deterministic wrapper the
 * article pipeline uses: it captures both viewports, persists them to
 * R2, analyzes each, and returns a single `DesignAuditReport` consumed
 * by QC (Step 17/24) and Polish (Step 18/24).
 *
 * See `.claude/skills/design-audit/SKILL.md` for the flow overview.
 *
 * Skips gracefully (`skipped: true`) when `CLOUDFLARE_ACCOUNT_ID` or
 * `CLOUDFLARE_API_TOKEN_SECRET` are missing so local dev without Browser
 * Rendering access doesn't break the pipeline.
 */
import type { SEOArticleAgent } from "../server";
import {
  analyzeScreenshotWithLlava,
  capturePageScreenshot,
  DESIGN_AUDIT_VIEWPORTS,
  getMissingBrowserRenderingBindings,
  type DesignAuditIssue,
  type VisionAnalysisResult
} from "../tools";
import { errMsg } from "./http-utils";

// Re-export issue types so existing imports from "./design-audit" keep working.
export type {
  DesignAuditIssue,
  DesignAuditSeverity,
  DesignAuditCategory
} from "../tools";

export interface DesignAuditReport {
  auditedUrl: string;
  timestamp: number;
  /** R2 key under `IMAGES_R2`; null when capture failed or was skipped. */
  desktopScreenshotKey: string | null;
  mobileScreenshotKey: string | null;
  issues: DesignAuditIssue[];
  /** Subset of `issues` where `contentAddressable === true`. */
  contentIssues: DesignAuditIssue[];
  /**
   * Errors from the vision-analysis phase (one per viewport). Empty on
   * success. An empty `issues` array with non-empty `analysisErrors` means
   * the vision call failed — it does NOT mean the page is clean.
   */
  analysisErrors: string[];
  /**
   * Raw model text per viewport, truncated. Useful to distinguish "page
   * is clean" from "Llava emitted malformed JSON" when `issues` is empty.
   */
  rawVisionResponses?: { desktop?: string; mobile?: string };
  skipped: boolean;
  skipReason?: string;
}

/**
 * Step 15/24 — Run the Design Audit for a just-published article.
 *
 * Captures desktop (1440×900) and mobile (390×844) screenshots of `url`
 * via Cloudflare Browser Rendering, stores the JPEG frames in R2 under
 * `design-audits/<slug>/{desktop,mobile}.jpg`, then runs each frame through
 * Llava vision analysis (`analyzeScreenshotWithLlava`) and merges the
 * per-viewport issue lists into a deduplicated `DesignAuditReport`.
 *
 * Skips gracefully (returns `{ skipped: true }`) when either
 * `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN_SECRET` is unset — this
 * keeps local dev and staging environments that lack Browser Rendering
 * credentials from blocking the pipeline.
 *
 * @param agent  The `SEOArticleAgent` Durable Object instance providing env
 *               bindings (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN_SECRET`,
 *               `IMAGES_R2`, `AI`) and the activity-log sink.
 * @param url    Fully-qualified public URL of the article to audit (e.g.
 *               `https://catsluvus.com/cat-beds/best-cat-beds`).
 * @param slug   Article slug used to build deterministic R2 keys for the
 *               stored screenshot frames.
 */
export async function runDesignAudit(
  agent: SEOArticleAgent,
  url: string,
  slug: string
): Promise<DesignAuditReport> {
  const base: DesignAuditReport = {
    auditedUrl: url,
    timestamp: Date.now(),
    desktopScreenshotKey: null,
    mobileScreenshotKey: null,
    issues: [],
    contentIssues: [],
    analysisErrors: [],
    skipped: false
  };

  const accountId = agent.envBindings.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = agent.envBindings.CLOUDFLARE_API_TOKEN_SECRET?.trim();
  if (!accountId || !apiToken) {
    const bothBindingsMissing = !accountId && !apiToken;
    const missingBindings = getMissingBrowserRenderingBindings(
      accountId,
      apiToken
    );
    const skipReason = bothBindingsMissing
      ? "Browser Rendering not configured (CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN_SECRET unset)"
      : `Browser Rendering not configured (missing ${missingBindings.join(", ")})`;
    // Warn when only one of the pair is set — likely a misconfiguration.
    // Silently skip when neither is set (expected in local dev / staging).
    if (missingBindings.length === 1) {
      agent.log(
        "warning",
        `Design Audit skipped: missing ${missingBindings.join(", ")}; set both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN_SECRET to enable Browser Rendering`
      );
    }
    return {
      ...base,
      skipped: true,
      skipReason
    };
  }

  const [desktopCap, mobileCap] = await Promise.all([
    capturePageScreenshot(
      accountId,
      apiToken,
      url,
      DESIGN_AUDIT_VIEWPORTS.desktop
    ),
    capturePageScreenshot(
      accountId,
      apiToken,
      url,
      DESIGN_AUDIT_VIEWPORTS.mobile
    )
  ]);
  const desktopPng = desktopCap.bytes;
  const mobilePng = mobileCap.bytes;

  if (desktopPng) {
    const key = `design-audits/${slug}/desktop.jpg`;
    try {
      await agent.envBindings.IMAGES_R2.put(key, desktopPng, {
        httpMetadata: { contentType: "image/jpeg" }
      });
      base.desktopScreenshotKey = key;
    } catch (err: unknown) {
      agent.log(
        "warning",
        `Design Audit: failed to persist desktop screenshot to R2 (${key}): ${errMsg(err)}`
      );
    }
  }
  if (mobilePng) {
    const key = `design-audits/${slug}/mobile.jpg`;
    try {
      await agent.envBindings.IMAGES_R2.put(key, mobilePng, {
        httpMetadata: { contentType: "image/jpeg" }
      });
      base.mobileScreenshotKey = key;
    } catch (err: unknown) {
      agent.log(
        "warning",
        `Design Audit: failed to persist mobile screenshot to R2 (${key}): ${errMsg(err)}`
      );
    }
  }

  if (!desktopPng && !mobilePng) {
    const reasons = [
      desktopCap.error && `desktop: ${desktopCap.error}`,
      mobileCap.error && `mobile: ${mobileCap.error}`
    ]
      .filter(Boolean)
      .join(" | ");
    return {
      ...base,
      skipped: true,
      skipReason: reasons
        ? `screenshot capture failed — ${reasons}`
        : "screenshot capture failed for both viewports"
    };
  }

  const emptyAnalysis: VisionAnalysisResult = { issues: [] };
  const [desktopAnalysis, mobileAnalysis] = await Promise.all([
    desktopPng
      ? analyzeScreenshotWithLlava(agent, desktopPng, url, "desktop")
      : Promise.resolve(emptyAnalysis),
    mobilePng
      ? analyzeScreenshotWithLlava(agent, mobilePng, url, "mobile")
      : Promise.resolve(emptyAnalysis)
  ]);

  const deduped = new Map<string, DesignAuditIssue>();
  const analysisErrors: string[] = [];
  // Surface any single-viewport capture failure even when the OTHER
  // viewport succeeded.
  if (!desktopPng && desktopCap.error) {
    analysisErrors.push(`desktop capture: ${desktopCap.error}`);
  }
  if (!mobilePng && mobileCap.error) {
    analysisErrors.push(`mobile capture: ${mobileCap.error}`);
  }
  for (const bucket of [desktopAnalysis, mobileAnalysis]) {
    if (bucket.error) analysisErrors.push(bucket.error);
    for (const issue of bucket.issues) {
      const k = `${issue.category}:${issue.description.slice(0, 60)}`;
      if (!deduped.has(k)) deduped.set(k, issue);
    }
  }
  const issues = Array.from(deduped.values()).slice(0, 12);

  return {
    ...base,
    issues,
    contentIssues: issues.filter((i) => i.contentAddressable),
    analysisErrors,
    rawVisionResponses: {
      desktop: desktopAnalysis.rawText,
      mobile: mobileAnalysis.rawText
    }
  };
}
