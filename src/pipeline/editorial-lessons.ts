/**
 * editorial-lessons.ts — per-article self-improvement feedback loop.
 *
 * The Editorial Agent rewrites every published article. Each rewrite is
 * either published in place or rejected by one of the quality gates
 * (SEO regression, document-shape regression, JSON-LD regression,
 * Wirecutter-voice plagiarism, salvage failures, etc.). Without this
 * module, the *next* article's rewrite has no idea why the previous
 * one was rejected — Kimi keeps producing the same mistake over and
 * over and the gates keep rejecting it over and over. ~65 identical
 * rejections in a single day, observed 2026-05-28.
 *
 * What this module adds: a tiny KV-backed rolling "lessons learned"
 * record that:
 *
 *   1. On every rejection, captures the rejection REASON and maps it
 *      to a specific actionable instruction that, if followed, would
 *      have made the rewrite pass.
 *   2. On every NEXT rewrite (this article OR any subsequent article),
 *      prepends those instructions to the Kimi rewrite prompt as
 *      explicit constraints.
 *
 * Effect: the system converges per article, not per day. Article N+1's
 * prompt contains Article N's lesson. No Copilot PR required, no human
 * intervention, no waiting for a daily report. The feedback loop runs
 * on every new article.
 *
 * Storage: KV key `editorial-active-lessons` holds a JSON blob bounded
 * to MAX_LESSONS distinct reasons (newest wins on overflow). Each
 * lesson records the canonical reason key, the prompt-ready
 * instruction, last-seen timestamp, and a count for stable ordering.
 */

import { errMsg } from "./http-utils";
import type { SEOArticleAgent } from "../server";

/**
 * Hard cap on the number of active lessons held in KV. Prompts get
 * longer with each lesson; 5 is the sweet spot where the highest-value
 * recent lessons fit in budget without crowding out the actual
 * article-specific instructions further down the prompt.
 */
const MAX_LESSONS = 5;

const KV_KEY = "editorial-active-lessons";

/**
 * Active lesson. `instruction` is exactly the text injected into the
 * rewrite prompt; `reason` is the canonical key used by the rejection
 * recorder to dedupe and refresh.
 */
export interface EditorialLesson {
  /** Canonical reason key (e.g. "seo-regression", "document-shape-regression"). */
  reason: string;
  /** Prompt-ready instruction prepended to the rewrite system prompt. */
  instruction: string;
  /** UTC ISO; refreshed on every recurrence. */
  lastSeen: string;
  /** Total recurrence count (stable ordering tiebreaker). */
  count: number;
}

interface LessonsRecord {
  lessons: EditorialLesson[];
  updatedAt: string;
}

/**
 * Map a canonical rejection reason to the prompt-ready instruction that,
 * if Kimi follows it, would prevent the same rejection on the next
 * rewrite. Reasons not in this map get a generic instruction derived
 * from the reason string itself — better than nothing, but the
 * mapped form is more actionable.
 */
function reasonToInstruction(reason: string): string {
  switch (reason) {
    case "seo-regression":
      return "PRESERVE EVERY SEO-RELEVANT ELEMENT: keep the original <title> tag, the original <h1> exactly, every <h2>/<h3> heading text (you may reorder them but never delete or rename), every internal link, every external link, every alt attribute on every <img>, the meta description, every Open Graph and Twitter card meta tag, and every JSON-LD block byte-for-byte. The rewrite is rejected when its SEO score drops more than 5 points; the dominant cause is dropped head content.";
    case "document-shape-regression":
      return 'RETURN A COMPLETE HTML DOCUMENT. The output MUST start with `<!DOCTYPE html>` and contain the full `<html>`, `<head>`, and `<body>` elements. The original article is stored as a full HTML document and your rewrite REPLACES it — never return just an `<article>` fragment. Preserve the original <head> in full, including every <meta>, every <link>, every <script type="application/ld+json">, and every stylesheet, then improve the prose inside <body>.';
    case "jsonld-regression":
      return 'PRESERVE STRUCTURED DATA VERBATIM. Every `<script type="application/ld+json">` block in the original must appear in your rewrite with the same `@type`, same required fields, same `mainEntity`/`itemListElement` shape, and no JSON-parse-breaking edits. If you need to update a field\'s value, change the value only — never the structure.';
    case "xss-handler-or-script-url":
      return "NEVER EMIT EXECUTABLE CONTENT. Do NOT include any HTML event-handler attribute (onclick=, onerror=, onload=, onmouseover=, etc.) on any tag. Do NOT use `javascript:` or `vbscript:` in any `href`, `src`, or other URL attribute. The article ships from KV directly to the user's browser; an event handler or script-URL would execute in our origin's security context. Only the existing `<script type=\"application/ld+json\">` blocks already in the article HTML are allowed — preserve those verbatim.";
    case "rewrite-rejected":
      return "WIRECUTTER-VOICE BAN. Do NOT use any of these signature phrases anywhere: 'our pick for', 'budget pick', 'also great', 'we spent N hours', 'after testing more than N', 'the staff picks', 'we dismissed', 'we wouldn't recommend', 'if you can afford it', 'for most people'. Write in catsluvus.com voice: cat-owner-to-cat-owner, practical, affiliate-driven, our own phrasing.";
    case "live-title-orphan-modifier":
      return "TITLE SHAPE GUARD. Ensure the final <title> is 45-60 characters and ends on a complete phrase — never a dangling modifier token (for/to/top/buying/and/or/&/+). If your planned title would end with one of those tokens, rewrite the ending so the final word is a complete noun phrase.";
    case "salvage-failed":
    case "rewrite too short":
      return "RETURN VALID HTML WITH REAL BLOCK TAGS. The output must contain real `<article>`, `<section>`, `<h2>`, `<h3>`, `<p>`, `<ul>`, `<li>` elements. No markdown headings (no `#`, no `##`). No plain prose separated by blank lines. No code-fence wrappers (no ```html, no ```). The output length must be at least 80% of the original input length.";
    case "ftc-false-endorsement":
      return "FTC FALSE-ENDORSEMENT BAN. catsluvus.com does NOT physically test products. Do NOT write or imply first-person product trials anywhere in the article or author bio. Banned phrasings include: 'we tested', 'our team tested', 'we tried', 'we evaluated', 'we compared', 'we assessed', 'products we've tested', 'hands-on testing', 'field-tested', 'real-world testing', 'after N weeks/hours with the X', 'tested N times/products/units', 'in our facility', 'personally reviews', 'stands behind every recommendation', and 'every review combines hands-on'. Use editorial alternatives: 'Based on specifications and verified buyer reviews', 'Customer feedback indicates', 'According to owner reports'. The rewrite is rejected immediately when any fabricated-testing pattern is detected; the original stays live.";
    default: {
      // Generic fallback for reasons not in the map — better than no
      // instruction at all. Includes the raw reason so an operator
      // reviewing the prompt can see what's being flagged.
      //
      // SANITIZE the reason string before interpolation: this instruction
      // gets prepended to the editorial-rewrite SYSTEM prompt on every
      // future article. If a future caller passes a Kimi-derived or
      // otherwise-untrusted reason string containing prompt-injection
      // characters (newlines + "SYSTEM:" markers, quotes, instruction
      // verbs), they'd propagate at system-prompt level and compromise
      // every subsequent rewrite. Today all callers pass hardcoded
      // kebab-case literals, so the sanitization is a no-op for current
      // traffic — pure defense-in-depth for future callers.
      const safeReason = reason.replace(/[^a-z0-9-]/gi, "-").slice(0, 60);
      return `AVOID THE FAILURE MODE LABELED "${safeReason}". Previous editorial rewrites of articles on this site were rejected for this reason; whatever the previous rewrite did differently from the original article, do NOT do it.`;
    }
  }
}

async function readLessons(agent: SEOArticleAgent): Promise<LessonsRecord> {
  try {
    const raw = await agent.envBindings.ARTICLES_KV.get(KV_KEY);
    if (!raw) return { lessons: [], updatedAt: new Date(0).toISOString() };
    const parsed = JSON.parse(raw) as Partial<LessonsRecord>;
    return {
      lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString()
    };
  } catch {
    return { lessons: [], updatedAt: new Date(0).toISOString() };
  }
}

/**
 * Record a rejection's reason as a lesson for future rewrites.
 *
 * If the reason already exists in the lessons record: refresh its
 * `lastSeen` and bump its `count`. If it's new and the cap isn't hit:
 * append it. If the cap is hit: replace the oldest existing entry
 * (by `lastSeen`) so the newest rejection signal always wins.
 *
 * Errors are swallowed — lesson recording must never break the
 * editorial-agent flow.
 */
export async function recordRejectionLesson(
  agent: SEOArticleAgent,
  reason: string
): Promise<void> {
  if (!reason || typeof reason !== "string") return;
  const trimmed = reason.trim();
  if (!trimmed) return;
  try {
    const record = await readLessons(agent);
    const now = new Date().toISOString();
    const existing = record.lessons.find((l) => l.reason === trimmed);
    if (existing) {
      existing.lastSeen = now;
      existing.count = (existing.count || 0) + 1;
    } else if (record.lessons.length < MAX_LESSONS) {
      record.lessons.push({
        reason: trimmed,
        instruction: reasonToInstruction(trimmed),
        lastSeen: now,
        count: 1
      });
    } else {
      // Evict the oldest by lastSeen, append the new one.
      record.lessons.sort((a, b) => (a.lastSeen < b.lastSeen ? -1 : 1));
      record.lessons.shift();
      record.lessons.push({
        reason: trimmed,
        instruction: reasonToInstruction(trimmed),
        lastSeen: now,
        count: 1
      });
    }
    record.updatedAt = now;
    await agent.envBindings.ARTICLES_KV.put(KV_KEY, JSON.stringify(record));
  } catch (err: unknown) {
    agent.log(
      "info",
      `Editorial lessons: recordRejectionLesson(${trimmed}) failed silently: ${errMsg(err)}`,
      "editorialAgent"
    );
  }
}

/**
 * Build the prompt block that gets prepended to every rewrite system
 * prompt. Returns the empty string when there are no active lessons
 * (e.g. fresh KV), so callers can concatenate unconditionally without
 * tripping on a leading separator.
 *
 * Lessons are ordered by `lastSeen` descending so the newest signal is
 * most prominent (Kimi attends to the top of the system prompt more).
 */
export async function getActiveLessonsBlock(
  agent: SEOArticleAgent
): Promise<string> {
  const record = await readLessons(agent);
  if (record.lessons.length === 0) return "";
  const ordered = [...record.lessons].sort((a, b) =>
    a.lastSeen < b.lastSeen ? 1 : -1
  );
  const header = `LESSONS FROM PRIOR REJECTIONS (apply these BEFORE the article-specific findings below — they have prevented every rewrite on this site from shipping for the past ${record.lessons.length} distinct reason${record.lessons.length === 1 ? "" : "s"}):`;
  const body = ordered
    .map(
      (l, i) =>
        `  ${i + 1}. [seen ×${l.count}, last ${l.lastSeen}] ${l.instruction}`
    )
    .join("\n");
  return `${header}\n${body}\n`;
}

/**
 * Read-only accessor for the dashboard / debugging endpoints to inspect
 * the current lessons set.
 */
export async function getActiveLessonsForDashboard(
  agent: SEOArticleAgent
): Promise<EditorialLesson[]> {
  const record = await readLessons(agent);
  return [...record.lessons].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

// ── Test helpers ─────────────────────────────────────────────────────────────
// Exported only for unit tests. The pure `reasonToInstruction` function is
// internal to this module; this escape-hatch lets tests pin the instruction
// text for each rejection reason without requiring KV or async code.
export const __testHelpers = {
  reasonToInstruction
};
