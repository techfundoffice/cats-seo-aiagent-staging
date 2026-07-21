/**
 * Live-article quality probe.
 *
 * Runs on a schedule inside the Durable Object (every 30 min by
 * default via `scheduleEvery(1800, "qualityProbeTick")` registered
 * in onStart). Samples the most recently published articles from
 * the local SQL index, fetches their stored HTML from KV, and
 * inspects each one for defects that the upstream gates didn't
 * catch.
 *
 * Each defect → `recordFinding(agent, { defectClass, ... })`. The
 * existing escalation loop in defect-findings.ts fires a
 * `claude-fix-with-eval` issue + Copilot assignment at the
 * 5-in-24h threshold, which means a real autonomous fix lands on
 * `main` without human intervention.
 *
 * Closes the gap surfaced by the 2026-05-30 manual audit
 * (orphan-title bug across 3 of 4 sampled articles, thin H2
 * count on 1 of 4, zero question-H2s on most) — those issues
 * shouldn't have required a human to grep through curl output.
 */

import type { SEOArticleAgent } from "../server";
import { recordFinding } from "./defect-findings";
import {
  detectFabricatedTestingClaims,
  stripCompliantMethodologySections,
  summarizeFabricatedTestingClaims
} from "./fabricated-testing-claims";
import { unescapeHtml } from "./http-utils";
import { stripHtmlToPlainText } from "./plagiarism-overlap";
import {
  detectUnsourcedClaims,
  summarizeUnsourcedClaims
} from "./unsourced-claims";
import {
  TITLE_MAX_CHARS,
  TITLE_TRAILING_ORPHAN_MODIFIERS,
  TITLE_TRAILING_ORPHAN_PUNCTUATION_RE
} from "./title-meta-normalizer";

const TITLE_RE = /<title>([^<]+)<\/title>/i;
const H2_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
const JSONLD_RE =
  /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

interface ProbeRow {
  kv_key: string;
  slug: string;
  keyword: string;
}

function decodeHtmlEntitiesShallow(s: string): string {
  return unescapeHtml(s).replace(/&hellip;/gi, "…");
}

function endsWithOrphanModifier(title: string): boolean {
  // Numeric ampersand entities are not decoded by `unescapeHtml` on purpose
  // (to avoid over-decoding sequences like `&#38;amp;`). Treat a trailing
  // numeric-encoded ampersand as an orphan directly.
  if (/(?:&#x26;|&#38;)\s*$/i.test(title.trim())) return true;
  // Decode entities first — live audit 2026-05-31 found titles ending
  // in `&amp;` (encoded `&`) and `&apos;`, which the split-on-whitespace
  // check missed because the last token was literally `&amp;`, not in
  // the orphan set. Decoding maps `&amp;` → `&` and a bare trailing `&`
  // is itself a broken-shape orphan.
  const decoded = decodeHtmlEntitiesShallow(title)
    .trim()
    .replace(TITLE_TRAILING_ORPHAN_PUNCTUATION_RE, "")
    .trim();
  // A trailing bare conjunction symbol/character is an orphan in its
  // own right (cut mid-conjunction by SERP-window truncation).
  if (/[&+]$/.test(decoded)) return true;
  const last = decoded.split(/\s+/).pop()?.toLowerCase() ?? "";
  return TITLE_TRAILING_ORPHAN_MODIFIERS.has(last);
}

/**
 * Independent of orphan-modifier shape — a title over the SERP-window
 * max (`TITLE_MAX_CHARS` chars after HTML-entity decode) gets truncated
 * by Google in the SERP, which the SEO-score gate cares about but the
 * live probe historically didn't surface. Returns the decoded-length so
 * the finding can carry the actual visible length, not the HTML-encoded
 * length.
 */
function isOverSerpWindow(title: string): {
  over: boolean;
  decodedLength: number;
} {
  const decoded = decodeHtmlEntitiesShallow(title).trim();
  return {
    over: decoded.length > TITLE_MAX_CHARS,
    decodedLength: decoded.length
  };
}

function countH2s(html: string): { total: number; questionStyle: number } {
  const matches = [...html.matchAll(H2_RE)];
  let questionStyle = 0;
  for (const m of matches) {
    const text = stripHtmlToPlainText(m[1]).trim();
    if (text.endsWith("?")) questionStyle++;
  }
  return { total: matches.length, questionStyle };
}

function hasSchemaType(
  value: unknown,
  expectedType: string
): value is string | string[] {
  return typeof value === "string"
    ? value === expectedType
    : Array.isArray(value) && value.some((entry) => entry === expectedType);
}

function hasFaqPageSchema(html: string): boolean {
  const blocks = [...html.matchAll(JSONLD_RE)];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]);
      const stack: unknown[] = [parsed];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (Array.isArray(cur)) {
          for (const x of cur) stack.push(x);
          continue;
        }
        if (!cur || typeof cur !== "object") continue;
        const obj = cur as Record<string, unknown>;
        if (hasSchemaType(obj["@type"], "FAQPage")) {
          const me = obj.mainEntity;
          if (Array.isArray(me) && me.length > 0) return true;
        }
        if (Array.isArray(obj["@graph"])) {
          for (const x of obj["@graph"] as unknown[]) stack.push(x);
        }
        if (Array.isArray(obj.mainEntity)) {
          for (const x of obj.mainEntity as unknown[]) stack.push(x);
        } else if (obj.mainEntity && typeof obj.mainEntity === "object") {
          stack.push(obj.mainEntity);
        }
      }
    } catch {
      // ignore parse failures; pre-publish gate catches those
    }
  }
  return false;
}

export async function runLiveQualityProbe(
  agent: SEOArticleAgent,
  sampleSize = 10
): Promise<{ scanned: number; findings: number }> {
  let scanned = 0;
  let findings = 0;
  let rows: ProbeRow[];
  try {
    rows = [
      ...agent.sql<ProbeRow>`
        SELECT kv_key, slug, keyword
        FROM articles
        WHERE kv_key != ''
        ORDER BY ROWID DESC
        LIMIT ${sampleSize}
      `
    ];
  } catch {
    // articles table may not exist yet in fresh DOs — that's fine.
    return { scanned: 0, findings: 0 };
  }
  const timestamp = new Date().toISOString();
  for (const row of rows) {
    let html: string | null;
    try {
      html = await agent.envBindings.ARTICLES_KV.get(row.kv_key);
    } catch {
      continue;
    }
    if (!html) continue;
    scanned++;

    // ── Check 1: title is broken-shape ─────────────────────────────────
    // Two sub-checks under the same defect class because the fix
    // surface is identical (the title-builder/normalizer code path):
    //   1a. ends in an orphan trailing modifier (Top, Buying, &, +, …)
    //   1b. exceeds the 60-char SERP window after HTML-entity decode
    // Either signal flags the article. Both fire together when a title
    // is over-long AND ends mid-conjunction (e.g. `… Top Picks &amp;`
    // at 64 chars seen live 2026-05-31).
    const titleM = html.match(TITLE_RE);
    const title = titleM ? titleM[1].trim() : "";
    if (title) {
      const orphan = endsWithOrphanModifier(title);
      const window = isOverSerpWindow(title);
      if (orphan || window.over) {
        const lastWord = title.trim().split(/\s+/).pop();
        await recordFinding(agent, {
          defectClass: "live-title-orphan-modifier",
          kvKey: row.kv_key,
          timestamp,
          evidence: {
            title,
            titleLength: title.length,
            decodedLength: window.decodedLength,
            orphanWord: lastWord,
            orphanShape: orphan,
            overSerpWindow: window.over,
            slug: row.slug,
            keyword: row.keyword
          },
          suspectedCodePath:
            "src/pipeline/title-meta-normalizer.ts:enforceTitleSerpWindow — truncation should keep title ≤60 chars AND never leave an orphan trailing modifier (incl. HTML-encoded `&amp;`/conjunction tokens); needs orphan-detection + length-check pass"
        });
        findings++;
      }
    }

    // ── Check 2: thin H2 count ─────────────────────────────────────────
    const h2 = countH2s(html);
    if (h2.total > 0 && h2.total < 4) {
      // Skip when no H2s at all — that's a separate (more severe) defect
      // class for the rendered-shape gate to catch.
      await recordFinding(agent, {
        defectClass: "live-thin-h2-count",
        kvKey: row.kv_key,
        timestamp,
        evidence: {
          h2Count: h2.total,
          slug: row.slug,
          keyword: row.keyword
        },
        suspectedCodePath:
          "src/pipeline/writer.ts:buildArticle:sectionPrompt — Kimi delivered too few sections; expand pass should generate more"
      });
      findings++;
    }

    // ── Check 3: zero question-H2s AND no FAQPage schema ───────────────
    // Guard on h2.total > 0 mirrors Check 2: articles with no H2s at all
    // are a more severe structural defect handled by the rendered-shape
    // gate — flagging them here as missing FAQ coverage would be noise.
    if (h2.total > 0 && h2.questionStyle === 0 && !hasFaqPageSchema(html)) {
      await recordFinding(agent, {
        defectClass: "live-missing-faq-coverage",
        kvKey: row.kv_key,
        timestamp,
        evidence: {
          h2Count: h2.total,
          questionH2Count: 0,
          hasFaqSchema: false,
          slug: row.slug,
          keyword: row.keyword
        },
        suspectedCodePath:
          "src/pipeline/html-builder.ts:faqSchema — FAQPage emitter sources from article.faqs only; consider promoting question-style H2s OR ensuring faqs array is non-empty"
      });
      findings++;
    }

    // ── Check 4: fabricated product-testing claim ──────────────────────
    // Catsluvus.com does not physically test products (see html-builder
    // "How We Picked" methodology). Articles that say "we tested",
    // "hands-on testing", "tested 200 times", "in our facility", etc.
    // are FTC 16 CFR Part 255 false-endorsement risks. Pre-publish
    // gate is writer.ts Step 14.7; this is the live safety-net for
    // articles shipped before the gate existed (~4,213 in KV as of
    // 2026-06).
    // FTC proximity exception — see `stripCompliantMethodologySections`.
    // Comparative claims in the template-emitted `<section class="wc-
    // methodology">` block carry proximate substantiation and must not
    // generate findings against the live corpus.
    const plainBody = stripHtmlToPlainText(
      stripCompliantMethodologySections(html)
    );
    const testingClaims = detectFabricatedTestingClaims(plainBody);
    if (testingClaims.length > 0) {
      const summary = summarizeFabricatedTestingClaims(testingClaims);
      await recordFinding(agent, {
        defectClass: "live-false-testing-claim",
        kvKey: row.kv_key,
        timestamp,
        evidence: {
          summary,
          occurrenceCount: testingClaims.length,
          matchedPhrases: testingClaims
            .slice(0, 5)
            .map((c) => c.trigger)
            .join(", "),
          sampleSentence: testingClaims[0].sentence.slice(0, 240),
          slug: row.slug,
          keyword: row.keyword
        },
        suspectedCodePath:
          "src/pipeline/html-builder.ts (hard-coded templates — author bio + How We Picked) + src/pipeline/writer.ts (pre-publish gate Step 14.7 should catch new ones)"
      });
      findings++;
    }

    // ── Check 5: unsourced YMYL claims ────────────────────────────────────
    // Articles may contain benefit-eligibility, regulatory/certification,
    // quantified-research, or named-endorsement claims that slipped past
    // the pre-publish Polish-Agent rewrite (Step 18) or were published
    // before `unsourced-ymyl-claim` detection existed. This live-corpus
    // safety-net mirrors Check 4 — both use the same plainBody so no
    // extra HTML parse is needed.
    const ymylClaims = detectUnsourcedClaims(plainBody);
    if (ymylClaims.length > 0) {
      const ymylSummary = summarizeUnsourcedClaims(ymylClaims);
      await recordFinding(agent, {
        defectClass: "live-unsourced-ymyl-claim",
        kvKey: row.kv_key,
        timestamp,
        evidence: {
          summary: ymylSummary,
          occurrenceCount: ymylClaims.length,
          matchedPhrases: ymylClaims
            .slice(0, 5)
            .map((c) => c.trigger)
            .join(", "),
          sampleSentence: ymylClaims[0].sentence.slice(0, 240),
          slug: row.slug,
          keyword: row.keyword
        },
        suspectedCodePath:
          "src/pipeline/writer.ts Step 14.5 (detectUnsourcedClaims) + src/pipeline/polish-agent.ts Step 18 (should rewrite or drop these claims; recurring findings mean the polish pass is not resolving them)"
      });
      findings++;
    }
  }

  agent.log(
    "info",
    `Live quality probe: scanned ${scanned} article(s), recorded ${findings} finding(s)`,
    "qualityProbe"
  );
  return { scanned, findings };
}

// Re-exports for unit-test convenience without exposing private regex state.
export const __testHelpers = {
  endsWithOrphanModifier,
  isOverSerpWindow,
  countH2s,
  hasFaqPageSchema
};
