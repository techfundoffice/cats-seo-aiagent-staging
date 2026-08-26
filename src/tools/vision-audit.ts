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
import { generateText, tool } from "ai";
import {
  getClaudeCodeLanguageModel,
  getClaudeRateLimitCooldownRemainingMs
} from "../pipeline/claude-code-subscription";
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
 * Build the strict JSON-only prompt used for screenshot audits.
 *
 * This asks a conversion question, not a design-critique question. The page
 * exists to move a reader to an affiliate link, so what matters is what is
 * reachable without scrolling — and the answers come back as booleans and a
 * fraction that can be tracked across the corpus, rather than prose that
 * can only be read once and forgotten.
 *
 * The screenshot is the first viewport only, so every question is scoped to
 * it; nothing here asks the model to guess at what lies below.
 */
export function buildVisionPrompt(url: string, viewportLabel: string): string {
  const dims =
    viewportLabel === "mobile"
      ? `${DESIGN_AUDIT_VIEWPORTS.mobile.width}x${DESIGN_AUDIT_VIEWPORTS.mobile.height}`
      : `${DESIGN_AUDIT_VIEWPORTS.desktop.width}x${DESIGN_AUDIT_VIEWPORTS.desktop.height}`;

  return `You are auditing whether a product-review page earns affiliate clicks. This is a ${viewportLabel} screenshot (${dims}) of ${url}, showing ONLY the first viewport — what a reader sees before scrolling.

Return STRICT JSON only (no prose, no markdown fences, no commentary):

{"signals":{"ctaAboveFold":true|false,"productVisibleAboveFold":true|false,"contentStartsAboveFold":true|false,"heroFraction":0.0},"issues":[{"severity":"critical|major|minor","category":"layout|typography|color|mobile|cta|nav|hero|content","description":"...","contentAddressable":true|false,"suggestion":"..."}]}

Signals — answer ONLY from what is visible in this screenshot:
- "ctaAboveFold": is a buy/affiliate control visible ("Check price on Amazon", "View on Amazon", a price button)? Site navigation and newsletter signups do NOT count.
- "productVisibleAboveFold": is an actual product — a pick card, product photo, or named product with a link — visible?
- "contentStartsAboveFold": has the article's body copy begun, or is the viewport still all header, hero image, and title?
- "heroFraction": share of this viewport's height taken by site header + hero image + title before any body content, as a decimal 0.0-1.0. Estimate to one decimal.

Issues — max 4, ordered by severity, and ONLY ones that plausibly cost clicks:
- EVERY issue MUST include all five fields. Do not omit "suggestion".
- "contentAddressable": true ONLY for issues fixable by rewriting article COPY — weak CTA wording, a generic hero headline, an unclear section heading. Set false for anything needing CSS or layout changes (spacing, image height, button size, mobile scaling).
- "description" and "suggestion" each 140 chars max, concrete and specific to what you can see.
- Ignore purely aesthetic preferences. A plain page that puts a product and a buy button in front of the reader is a GOOD page.
- If nothing plausibly costs a click, return "issues":[].`;
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
/**
 * Measurable above-the-fold facts about a published article, as read off a
 * screenshot.
 *
 * These exist because prose findings ("the CTA could be more prominent")
 * cannot be tracked across a corpus or compared before and after a change,
 * and affiliate clicks are the thing a screenshot is genuinely qualified to
 * predict.
 *
 * Scope note: `capturePageScreenshot` captures the **viewport only** — no
 * `fullPage` — so every signal here is a first-fold fact. How far down the
 * page a CTA sits when it is *not* above the fold is deliberately absent
 * rather than guessed; measuring that needs a full-page capture, which
 * would multiply image size and vision cost.
 *
 * `null` means the model did not answer for that field, which is different
 * from `false`.
 */
export interface ConversionSignals {
  /** An affiliate / "check price" control is visible in the first viewport. */
  ctaAboveFold: boolean | null;
  /** A product pick or card is visible in the first viewport. */
  productVisibleAboveFold: boolean | null;
  /** Article body copy (not just title/hero) begins in the first viewport. */
  contentStartsAboveFold: boolean | null;
  /** Share of the first viewport taken by hero/header before body content. */
  heroFraction: number | null;
}

export const EMPTY_CONVERSION_SIGNALS: ConversionSignals = {
  ctaAboveFold: null,
  productVisibleAboveFold: null,
  contentStartsAboveFold: null,
  heroFraction: null
};

function coerceSignalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "yes") return true;
    if (v === "false" || v === "no") return false;
  }
  return null;
}

/**
 * Read the `signals` object out of a vision response.
 *
 * Tolerant by design: vision models return booleans as strings, fractions
 * as percentages, and sometimes omit the object entirely. An unreadable
 * field becomes `null` — never a default that would be logged as a real
 * measurement.
 */
export function parseConversionSignals(raw: unknown): ConversionSignals {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CONVERSION_SIGNALS };
  const source = raw as Record<string, unknown>;
  const nested =
    source.signals && typeof source.signals === "object"
      ? (source.signals as Record<string, unknown>)
      : source;

  let heroFraction: number | null = null;
  const rawHero = nested.heroFraction;
  const heroNumber =
    typeof rawHero === "number"
      ? rawHero
      : typeof rawHero === "string"
        ? parseFloat(rawHero.replace("%", ""))
        : NaN;
  if (Number.isFinite(heroNumber)) {
    // Accept a percentage as readily as a fraction.
    const asFraction = heroNumber > 1 ? heroNumber / 100 : heroNumber;
    heroFraction = Math.min(1, Math.max(0, asFraction));
  }

  return {
    ctaAboveFold: coerceSignalBoolean(nested.ctaAboveFold),
    productVisibleAboveFold: coerceSignalBoolean(
      nested.productVisibleAboveFold
    ),
    contentStartsAboveFold: coerceSignalBoolean(nested.contentStartsAboveFold),
    heroFraction
  };
}

/** One-line log form; omits fields the model did not answer. */
export function summarizeConversionSignals(signals: ConversionSignals): string {
  const parts: string[] = [];
  if (signals.ctaAboveFold !== null) {
    parts.push(`CTA above fold: ${signals.ctaAboveFold ? "yes" : "NO"}`);
  }
  if (signals.productVisibleAboveFold !== null) {
    parts.push(
      `product above fold: ${signals.productVisibleAboveFold ? "yes" : "NO"}`
    );
  }
  if (signals.contentStartsAboveFold !== null) {
    parts.push(
      `body copy above fold: ${signals.contentStartsAboveFold ? "yes" : "NO"}`
    );
  }
  if (signals.heroFraction !== null) {
    parts.push(`hero takes ${Math.round(signals.heroFraction * 100)}% of fold`);
  }
  return parts.length > 0 ? parts.join(", ") : "no signals returned";
}

export interface VisionAnalysisResult {
  issues: DesignAuditIssue[];
  /** Above-the-fold measurements; all-null when the model returned none. */
  signals: ConversionSignals;
  /** Which model produced this result, for log attribution. */
  model?: string;
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
/** Shared response handling for both vision backends. */
function buildVisionResult(
  text: string,
  viewportLabel: string,
  model: string
): VisionAnalysisResult {
  const issues = parseVisionJson(text);
  let signals = { ...EMPTY_CONVERSION_SIGNALS };
  for (const candidate of [
    text.trim(),
    ...extractEmbeddedJsonCandidates(text.trim(), VISION_JSON_CANDIDATE_LIMIT)
  ]) {
    try {
      const parsed = JSON.parse(repairJson(candidate)) as unknown;
      const found = parseConversionSignals(parsed);
      const answered = Object.values(found).some((v) => v !== null);
      if (answered) {
        signals = found;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }

  const returnedNothing =
    issues.length === 0 &&
    Object.values(signals).every((v) => v === null) &&
    !/"issues"\s*:\s*\[\s*\]/.test(text);

  return {
    issues,
    signals,
    model,
    error: returnedNothing
      ? `${viewportLabel}: ${model} emitted ${text.length} chars but nothing parseable`
      : undefined,
    rawText: text.slice(0, 1200)
  };
}

/**
 * Ask Claude to read the screenshot. Returns null when no Claude Code
 * subscription is configured, so the caller falls through to Workers AI.
 *
 * Claude is tried first for the same reason `kimi-model.ts` tries it first
 * everywhere else: it is the primary provider for this Worker. It also
 * matters more here than elsewhere — the questions in `buildVisionPrompt`
 * ("has body copy started, or is this still all hero?") are exactly the
 * kind of judgement a 7B captioning model answers unreliably.
 */
async function analyzeScreenshotWithClaude(
  agent: SEOArticleAgent,
  imageBytes: Uint8Array,
  url: string,
  viewportLabel: string
): Promise<VisionAnalysisResult | null> {
  const model = getClaudeCodeLanguageModel(
    agent.envBindings as Parameters<typeof getClaudeCodeLanguageModel>[0]
  );
  if (!model) return null;
  if (getClaudeRateLimitCooldownRemainingMs() > 0) return null;

  try {
    const { text } = await generateText({
      model,
      maxOutputTokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildVisionPrompt(url, viewportLabel) },
            { type: "image", image: imageBytes, mediaType: "image/jpeg" }
          ]
        }
      ]
    });
    const trimmed = (text ?? "").trim();
    if (!trimmed) return null;
    return buildVisionResult(trimmed, viewportLabel, "claude");
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Vision audit: Claude call failed (${errMsg(err)}); falling back to ${VISION_MODEL}`,
      "qaReviewer"
    );
    return null;
  }
}

/**
 * Analyze one screenshot for conversion signals and click-costing issues.
 *
 * Claude first, Workers AI Llava as the fallback — the same order and the
 * same "skip Claude on no subscription / active cooldown / call failure"
 * rule the rest of the pipeline uses.
 */
export async function analyzeScreenshotWithVision(
  agent: SEOArticleAgent,
  imageBytes: Uint8Array,
  url: string,
  viewportLabel: string
): Promise<VisionAnalysisResult> {
  const viaClaude = await analyzeScreenshotWithClaude(
    agent,
    imageBytes,
    url,
    viewportLabel
  );
  if (viaClaude) return viaClaude;

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
        signals: { ...EMPTY_CONVERSION_SIGNALS },
        model: "llava",
        error: `${viewportLabel}: empty Llava response`
      };
    }
    return buildVisionResult(text, viewportLabel, "llava");
  } catch (err: unknown) {
    return {
      issues: [],
      signals: { ...EMPTY_CONVERSION_SIGNALS },
      model: "llava",
      error: `${viewportLabel}: ${errMsg(err)}`
    };
  }
}

/**
 * @deprecated Kept so existing call sites keep compiling; the routing is no
 * longer Llava-only. Use `analyzeScreenshotWithVision`.
 */
export const analyzeScreenshotWithLlava = analyzeScreenshotWithVision;

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
          : Promise.resolve<VisionAnalysisResult>({
              issues: [],
              signals: { ...EMPTY_CONVERSION_SIGNALS }
            }),
        mobileCap.bytes
          ? analyzeScreenshotWithLlava(agent, mobileCap.bytes, url, "mobile")
          : Promise.resolve<VisionAnalysisResult>({
              issues: [],
              signals: { ...EMPTY_CONVERSION_SIGNALS }
            })
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
