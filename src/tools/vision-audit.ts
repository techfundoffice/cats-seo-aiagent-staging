/**
 * Vision-audit tool — Llava 1.5 7B via Workers AI, routed through the
 * `cats-seo-aiagent` AI Gateway. Takes a JPEG screenshot and returns
 * structured design issues with content-addressable classification.
 *
 * Two shapes:
 *   - `analyzeScreenshotWithLlava()` — plain async function used by
 *     Step 11.5's deterministic orchestrator.
 *   - `createAuditScreenshotTool(agent)` — AI-SDK v6 `tool()` wrapper so
 *     agentic callers (QC/Polish loops, external MCP clients) can ask
 *     the vision model for design findings on an arbitrary URL.
 */
import { errMsg, getEnvBinding, repairJson } from "../pipeline/http-utils";
import { tool } from "ai";
import { z } from "zod";
import type { SEOArticleAgent } from "../server";
import { extractEmbeddedJsonCandidates } from "../objectLike";
import {
  capturePageScreenshot,
  DESIGN_AUDIT_VIEWPORTS,
  getMissingBrowserRenderingBindings
} from "./browser-rendering";

/**
 * Registered name of the `auditScreenshot` AI-SDK tool created by
 * `createAuditScreenshotTool`. Export so callers can match incoming
 * tool-call names in agentic loops without hard-coding the string literal.
 */
export const AUDIT_SCREENSHOT_TOOL_NAME = "auditScreenshot";
/**
 * Registered name of the `auditPageDesign` AI-SDK tool created by
 * `createAuditPageDesignTool`. Export so callers can match incoming
 * tool-call names in agentic loops without hard-coding the string literal.
 */
export const AUDIT_URL_TOOL_NAME = "auditPageDesign";
const VISION_JSON_CANDIDATE_LIMIT = 8;

// Llava 1.5 7B is vision-capable and takes `image` as a byte array.
const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const AI_GATEWAY_ID = "cats-seo-aiagent";
const MAX_VISION_RESPONSE_TEXT_DEPTH = 3;
const VISION_RESPONSE_DIRECT_TEXT_FIELDS = [
  "description",
  "response",
  "result",
  "text"
] as const;
const VISION_RESPONSE_NESTED_FIELDS = ["data", "output", "payload"] as const;

// ── Issue shape and classification ─────────────────────────────────────────────

/** Triage level for a single design-audit finding. */
export type DesignAuditSeverity = "critical" | "major" | "minor";
/**
 * Visual/UX category of a design-audit finding.
 * `"cta"` = call-to-action elements; all others are self-describing.
 */
export type DesignAuditCategory =
  | "layout"
  | "typography"
  | "color"
  | "mobile"
  | "cta"
  | "nav"
  | "hero"
  | "content";

/**
 * A single design-audit issue surfaced by Llava vision analysis.
 *
 * `contentAddressable` flags whether the Polish Agent can fix the issue
 * by rewriting copy (headings, CTA text, hero caption, intro paragraph,
 * nav labels).  Issues that require CSS or theme changes — spacing,
 * fonts, colors, mobile scaling — set this to `false` and are silently
 * skipped by the Polish Agent because the text-based pipeline has no way
 * to fix them.  The override table in `CATEGORY_CONTENT_ADDRESSABLE`
 * controls the defaults per category.
 */
export interface DesignAuditIssue {
  severity: DesignAuditSeverity;
  category: DesignAuditCategory;
  description: string;
  /** `true` when the Polish Agent can fix this issue by rewriting copy. */
  contentAddressable: boolean;
  suggestion: string;
}

export const SEVERITIES: readonly DesignAuditSeverity[] = [
  "critical",
  "major",
  "minor"
] as const;
export const CATEGORIES: readonly DesignAuditCategory[] = [
  "layout",
  "typography",
  "color",
  "mobile",
  "cta",
  "nav",
  "hero",
  "content"
] as const;

/**
 * Category → default content-addressability. Llava routinely claims every
 * issue is content-addressable; we override based on category so Polish
 * only sees things it can fix by rewriting copy (CTA text, hero headline,
 * intro, nav labels), not CSS/theme issues (spacing, fonts, colors,
 * mobile scaling).
 */
export const CATEGORY_CONTENT_ADDRESSABLE: Record<
  DesignAuditCategory,
  boolean
> = {
  content: true,
  cta: true,
  hero: true,
  nav: true,
  layout: false,
  typography: false,
  color: false,
  mobile: false
};

/**
 * Build the strict JSON-only prompt used for screenshot design audits.
 */
export function buildVisionPrompt(url: string, viewportLabel: string): string {
  return `You are a senior web-design auditor. Inspect this ${viewportLabel} screenshot of ${url} and return STRICT JSON only (no prose, no markdown fences, no commentary):

{"issues":[{"severity":"critical|major|minor","category":"layout|typography|color|mobile|cta|nav|hero|content","description":"...","contentAddressable":true|false,"suggestion":"..."}]}

Rules:
- Max 6 issues, ordered by severity (critical first).
- EVERY issue MUST include all five fields: severity, category, description, contentAddressable, suggestion. Do not omit "suggestion".
- "contentAddressable": true ONLY for issues fixable by rewriting article COPY — missing CTA text, weak hero headline, thin FAQ, generic intro, unclear section headings. Set false for CSS/theme issues (spacing, fonts, colors, mobile scaling).
- "description" ≤ 140 chars, concrete ("hero headline 'Untitled' is generic" not "text needs work").
- "suggestion" ≤ 140 chars, actionable ("Replace with 'Best Disposable Litter Boxes for Cat Travel, Reviewed'" not "improve it").
- If the page looks clean and well-designed, return exactly {"issues":[]}.`;
}

function coerceIssue(raw: unknown): DesignAuditIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const description =
    typeof r.description === "string" ? r.description.trim() : "";
  if (!description) return null;
  const severity: DesignAuditSeverity = SEVERITIES.includes(
    r.severity as DesignAuditSeverity
  )
    ? (r.severity as DesignAuditSeverity)
    : "minor";
  const category: DesignAuditCategory = CATEGORIES.includes(
    r.category as DesignAuditCategory
  )
    ? (r.category as DesignAuditCategory)
    : "content";
  const claimed = r.contentAddressable === true;
  const defaultFromCategory = CATEGORY_CONTENT_ADDRESSABLE[category];
  const contentAddressable = defaultFromCategory && claimed;
  const suggestion =
    typeof r.suggestion === "string" && r.suggestion.trim()
      ? r.suggestion.trim()
      : `Review and address: ${description}`;
  return {
    severity,
    category,
    description: description.slice(0, 200),
    contentAddressable,
    suggestion: suggestion.slice(0, 200)
  };
}

/**
 * Parses Llava output into normalized design-audit issues.
 * Accepts a top-level JSON array, `{ issues: [...] }` object, or prose-wrapped
 * responses containing balanced JSON object/array snippets. Retries each
 * candidate after `repairJson()` so fenced or mildly malformed model output
 * does not silently collapse to `[]`.
 */
export function parseVisionJson(text: string): DesignAuditIssue[] {
  const parseIssuesFromPayload = (
    parsed: unknown
  ): DesignAuditIssue[] | null => {
    if (Array.isArray(parsed)) {
      return parsed
        .map(coerceIssue)
        .filter((i): i is DesignAuditIssue => i !== null)
        .slice(0, 6);
    }
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as { issues?: unknown };
    if (!Array.isArray(p.issues)) return null;
    return p.issues
      .map(coerceIssue)
      .filter((i): i is DesignAuditIssue => i !== null)
      .slice(0, 6);
  };

  const trimmed = text.trim();
  const candidates = [
    trimmed,
    ...extractEmbeddedJsonCandidates(
      trimmed,
      VISION_JSON_CANDIDATE_LIMIT
    ).filter((candidate) => candidate !== trimmed)
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    let parsed: unknown;
    try {
      try {
        parsed = JSON.parse(candidate);
      } catch {
        parsed = JSON.parse(repairJson(candidate));
      }
    } catch {
      // try the next parse candidate
      continue;
    }
    const issues = parseIssuesFromPayload(parsed);
    if (issues !== null) {
      return issues;
    }
  }
  return [];
}

// ── Core vision call ──────────────────────────────────────────────────────────

/**
 * Return value of `runVisionAnalysis`. When the Llava model call succeeds
 * `issues` is the parsed list of `DesignAuditIssue` objects (may be empty
 * if no problems were found). On failure `error` carries the reason and
 * `issues` is an empty array. `rawText` preserves the raw model response for
 * debugging.
 */
export interface VisionAnalysisResult {
  issues: DesignAuditIssue[];
  error?: string;
  rawText?: string;
}

interface VisionRunInput {
  prompt: string;
  image: number[];
  max_tokens: number;
}

interface VisionRunOptions {
  gateway: {
    id: string;
  };
}

function extractVisionResponseText(value: unknown, depth = 0): string {
  if (
    depth > MAX_VISION_RESPONSE_TEXT_DEPTH ||
    value === null ||
    value === undefined
  ) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedText = extractVisionResponseText(item, depth + 1);
      if (nestedText) {
        return nestedText;
      }
    }
    return "";
  }
  if (typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const field of VISION_RESPONSE_DIRECT_TEXT_FIELDS) {
    const fieldValue = record[field];
    if (typeof fieldValue === "string" && fieldValue.length > 0) {
      return fieldValue;
    }
  }
  for (const field of VISION_RESPONSE_NESTED_FIELDS) {
    const nestedText = extractVisionResponseText(record[field], depth + 1);
    if (nestedText) {
      return nestedText;
    }
  }
  return "";
}

/**
 * Send an image to Llava via AI Gateway. Returns parsed issues, a raw-text
 * tail for debugging, and an error field when the model emitted text but
 * the parser extracted nothing (distinguishes "clean page" from "malformed
 * model output" — both previously returned []).
 */
export async function analyzeScreenshotWithLlava(
  agent: SEOArticleAgent,
  imageBytes: Uint8Array,
  url: string,
  viewportLabel: string
): Promise<VisionAnalysisResult> {
  try {
    const runVision = agent.envBindings.AI.run as (
      model: string,
      input: VisionRunInput,
      options: VisionRunOptions
    ) => Promise<unknown>;
    const result = await runVision(
      VISION_MODEL,
      {
        prompt: buildVisionPrompt(url, viewportLabel),
        image: Array.from(imageBytes),
        max_tokens: 1024
      },
      { gateway: { id: AI_GATEWAY_ID } }
    );
    const text = extractVisionResponseText(result).trim();
    if (!text) {
      return {
        issues: [],
        error: `${viewportLabel}: empty Llava response`
      };
    }
    const issues = parseVisionJson(text);
    const error =
      issues.length === 0 && !/"issues"\s*:\s*\[\s*\]/.test(text)
        ? `${viewportLabel}: emitted ${text.length} chars but no parseable issues`
        : undefined;
    return {
      issues,
      error,
      rawText: text.slice(0, 1200)
    };
  } catch (err: unknown) {
    return {
      issues: [],
      error: `${viewportLabel}: ${errMsg(err)}`
    };
  }
}

// ── AI-SDK tool wrappers ──────────────────────────────────────────────────────

/**
 * Given raw image bytes (base64), run Llava and return findings. Useful
 * when a caller already has a screenshot (from a previous screenshotPage
 * tool call, or from R2) and only needs the analysis.
 */
export function createAuditScreenshotTool(agent: SEOArticleAgent) {
  return tool({
    description:
      "Analyze a screenshot image with Llava vision model via AI Gateway. Returns design issues (severity, category, description, suggestion) with content-addressability classification. Use when you already have an image and want a visual critique.",
    inputSchema: z.object({
      imageBase64: z.string().describe("Base64-encoded JPEG/PNG image bytes."),
      url: z
        .string()
        .describe("The URL the screenshot was taken from, for prompt context."),
      viewportLabel: z
        .enum(["desktop", "mobile"])
        .default("desktop")
        .describe("Viewport label for the prompt.")
    }),
    execute: async ({ imageBase64, url, viewportLabel }) => {
      let bytes: Uint8Array;
      try {
        // base64 → Uint8Array (Workers-safe, no Buffer)
        const binary = atob(imageBase64);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
      } catch (err: unknown) {
        return {
          ok: false,
          issues: [],
          error: `invalid imageBase64: ${errMsg(err)}`
        };
      }
      const result = await analyzeScreenshotWithLlava(
        agent,
        bytes,
        url,
        viewportLabel
      );
      return {
        ok: result.error === undefined,
        issues: result.issues,
        error: result.error,
        rawText: result.rawText
      };
    }
  });
}

/**
 * One-shot tool: given a URL, captures BOTH viewports and runs Llava on
 * each. This is what an agentic caller would pick when it wants the whole
 * design-audit flow in one tool call.
 */
export function createAuditPageDesignTool(agent: SEOArticleAgent) {
  return tool({
    description:
      "Run the full design-audit flow for a URL: capture desktop + mobile screenshots via Browser Rendering, analyze each with Llava via AI Gateway, and return deduplicated content-addressable findings. Use when you want 'what's wrong with this page's design?' answered end-to-end.",
    inputSchema: z.object({
      url: z.string().url().describe("Absolute URL of the page to audit.")
    }),
    execute: async ({ url }) => {
      const accountId = getEnvBinding(
        agent.envBindings,
        "CLOUDFLARE_ACCOUNT_ID"
      );
      const apiToken = getEnvBinding(
        agent.envBindings,
        "CLOUDFLARE_API_TOKEN_SECRET"
      );
      if (!accountId || !apiToken) {
        const missingBindings = getMissingBrowserRenderingBindings(
          accountId,
          apiToken
        );
        return {
          ok: false,
          error: `missing ${missingBindings.join(", ")}; set both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN_SECRET to run page design audits`
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
      const captureErrors: string[] = [];
      if (!desktopCap.bytes) {
        captureErrors.push(
          `desktop: ${desktopCap.error || "screenshot capture returned no bytes"}`
        );
      }
      if (!mobileCap.bytes) {
        captureErrors.push(
          `mobile: ${mobileCap.error || "screenshot capture returned no bytes"}`
        );
      }
      if (!desktopCap.bytes && !mobileCap.bytes) {
        return {
          ok: false,
          error: `screenshot capture failed — ${captureErrors.join(" | ")}`
        };
      }
      const [desktopAnalysis, mobileAnalysis] = await Promise.all([
        desktopCap.bytes
          ? analyzeScreenshotWithLlava(agent, desktopCap.bytes, url, "desktop")
          : Promise.resolve<VisionAnalysisResult>({ issues: [] }),
        mobileCap.bytes
          ? analyzeScreenshotWithLlava(agent, mobileCap.bytes, url, "mobile")
          : Promise.resolve<VisionAnalysisResult>({ issues: [] })
      ]);
      const deduped = new Map<string, DesignAuditIssue>();
      const analysisErrors: string[] = [...captureErrors];
      for (const bucket of [desktopAnalysis, mobileAnalysis]) {
        if (bucket.error) analysisErrors.push(bucket.error);
        for (const issue of bucket.issues) {
          const k = `${issue.category}:${issue.description.slice(0, 60)}`;
          if (!deduped.has(k)) deduped.set(k, issue);
        }
      }
      const issues = Array.from(deduped.values()).slice(0, 12);
      return {
        ok: analysisErrors.length === 0,
        url,
        issues,
        contentIssues: issues.filter((i) => i.contentAddressable),
        analysisErrors,
        desktopCaptured: !!desktopCap.bytes,
        mobileCaptured: !!mobileCap.bytes
      };
    }
  });
}
