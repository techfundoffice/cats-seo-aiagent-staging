/**
 * content-quality.ts — deterministic readability metrics + process-language
 * detector for catsluvus articles.
 *
 * Ported from the MIT-licensed `every-app/sam` content agent
 * (lib/analyzers/readability.mjs + publish-readiness.mjs) and adapted from
 * markdown-draft input to this pipeline's rendered-HTML reality.
 *
 * Motivation: the writer (Kimi) periodically emits prose that exposes the
 * writing PROCESS instead of serving the reader — self-referential framing
 * ("this guide", "in this roundup"), temporal qualifiers ("at the time of
 * writing"), writer-agency statements ("we chose", "we excluded"), and
 * methodology/exclusion talk outside the dedicated "How We Picked" template
 * box. Google's helpful-content signals and plain reader trust both punish
 * copy that reads like research notes rather than a finished article.
 *
 * This module is a deterministic, dependency-free PRE-FILTER in the same
 * family as `unsourced-claims.ts` (Step 14.6) and
 * `fabricated-testing-claims.ts` (Step 14.7). It is non-blocking: findings
 * are logged, recorded to the defect loop, and fed to the Polish Agent
 * (writer.ts Step 18) which rewrites each flagged sentence around the
 * reader's problem and payoff.
 *
 * Design notes / known limits:
 *   - The site-template `<section class="wc-methodology">` box ("How We
 *     Picked" / "Our Editorial Approach") INTENTIONALLY discusses editorial
 *     process — it is the FTC-transparency disclosure. All wc-methodology
 *     sections are stripped before analysis so the detector never fires on
 *     the site's own template output. The `<nav class="toc">` block is
 *     stripped for the same reason (it echoes section headings).
 *   - Readability numbers are reported metrics, not gated thresholds —
 *     they land in the activity log and defect-finding evidence so quality
 *     trends are observable before anyone commits to a hard cutoff.
 */

import { stripHtmlToPlainText } from "./plagiarism-overlap";
import { unescapeHtml } from "./http-utils";

export type ProcessLanguageCategory =
  /** Self-referential framing: "this guide", "this article", "this roundup". */
  | "self-referential"
  /** Temporal hedge exposing the writing moment: "at the time of writing". */
  | "temporal-qualifier"
  /** Selection-threshold talk: "inclusion criteria", "selection criteria". */
  | "selection-threshold"
  /** Writer-agency statements: "we chose", "I picked", "we excluded". */
  | "writer-process"
  /** Curation framing: "curated shortlist", "curated list". */
  | "curation"
  /** Methodology talk outside the wc-methodology template box. */
  | "methodology"
  /** Exclusion talk: "exclusions", "what we left out". */
  | "exclusion"
  /** An H2/H3 that reads like an internal process note, not a reader section. */
  | "meta-heading";

export interface ProcessLanguageFinding {
  /** Which process-language bucket the trigger fell into. */
  category: ProcessLanguageCategory;
  /** Human-readable description of the pattern that matched. */
  label: string;
  /**
   * The full sentence (or heading text) containing the match,
   * whitespace-collapsed — the Polish Agent's find/replace target.
   */
  snippet: string;
}

/** Readability metrics computed over the article body text. */
export interface ReadabilityMetrics {
  words: number;
  sentenceCount: number;
  paragraphCount: number;
  /** Words per sentence, 1 decimal place. */
  averageSentenceLength: number;
  /** Sentences per paragraph, 1 decimal place. */
  averageParagraphLength: number;
  /** % of words that are ≥10 chars and not common stopwords, 1 decimal place. */
  complexWordRate: number;
  /** Count of sentences with 25+ words. */
  longSentences: number;
}

export interface ContentQualityReport {
  readability: ReadabilityMetrics;
  /** Word count of the writer-generated introduction block. */
  introWords: number;
  /** Sentence/heading-level findings for the Polish Agent to rewrite. */
  findings: ProcessLanguageFinding[];
  /** Human-readable issue strings (empty = clean). */
  issues: string[];
}

/** Maximum findings returned. Keeps the Polish prompt + defect evidence compact. */
const MAX_FINDINGS = 20;

/** Shortest sentence length (chars) we bother inspecting — skips labels/fragments. */
const MIN_SENTENCE_LEN = 25;

/** Sentences with this many words or more count as "long" for readability. */
const LONG_SENTENCE_WORDS = 25;

/** Words this long (and not stopwords) count toward the complex-word rate. */
const COMPLEX_WORD_LEN = 10;

/** Intro longer than this (words) is flagged as slow to get to the point. */
const INTRO_MAX_WORDS = 220;

/** With ANY process pattern present, an intro past this length is flagged. */
const INTRO_SOFT_MAX_WORDS = 160;

/** How many leading intro words are scanned for process patterns. */
const INTRO_SCAN_WORDS = 150;

/** Distinct body-wide process patterns at/above this count get a consolidation issue. */
const BODY_PATTERN_ISSUE_THRESHOLD = 3;

const COMMON_WORDS = new Set([
  "the",
  "be",
  "to",
  "of",
  "and",
  "a",
  "in",
  "that",
  "have",
  "it",
  "for",
  "not",
  "on",
  "with",
  "as",
  "you",
  "do",
  "at",
  "this",
  "but",
  "his",
  "by",
  "from",
  "they",
  "we",
  "say",
  "her",
  "she",
  "or",
  "an",
  "will",
  "my",
  "one",
  "all"
]);

/**
 * Process-language trigger patterns. A sentence matching ANY pattern is a
 * candidate; the first matching category wins (a sentence is reported once).
 * Adapted from sam's publish-readiness patterns: the GitHub-star thresholds
 * were dropped (irrelevant to cat products), first-person forms were widened
 * to "we" (this site writes in editorial plural), and generic selection
 * criteria replaced the star-count language.
 */
const PROCESS_PATTERNS: Array<{
  category: ProcessLanguageCategory;
  label: string;
  pattern: RegExp;
}> = [
  {
    category: "self-referential",
    label: 'self-referential phrasing like "this guide"',
    pattern: /\bthis (?:guide|article|roundup|review list)\b/i
  },
  {
    category: "temporal-qualifier",
    label: '"at the time of writing" language',
    pattern: /\b(?:at|as of) the time of (?:this )?writing\b/i
  },
  {
    category: "selection-threshold",
    label: "selection-threshold language",
    pattern: /\b(?:inclusion|selection) (?:bar|criteri(?:a|on))\b/i
  },
  {
    category: "writer-process",
    label: "writer-process language",
    pattern: /\b(?:i|we) (?:chose|picked|selected|left out|excluded)\b/i
  },
  {
    category: "curation",
    label: 'phrasing like "curated shortlist"',
    pattern: /\bcurated (?:short)?list\b/i
  },
  {
    category: "methodology",
    label: "methodology language",
    pattern: /\bmethodolog(?:y|ies|ical)\b/i
  },
  {
    category: "exclusion",
    label: "exclusion language",
    pattern: /\bexclusions?\b/i
  }
];

/**
 * H2/H3 headings matching this read like internal process notes rather than
 * reader-facing sections ("How We Chose", "Our Methodology", "What We Left
 * Out"). The template's own "How We Picked" heading lives inside the
 * wc-methodology section, which is stripped before this check runs.
 */
const META_HEADING_PATTERN =
  /(how (?:i|we) (?:chose|picked)|methodolog|inclusion criteri|why .* not in|what .* left out|exclusions?)/i;

/**
 * Remove every `<section class="wc-methodology">…</section>` block plus the
 * `<nav class="toc">…</nav>` table of contents. Both are template output —
 * the methodology box legitimately discusses editorial process, and the TOC
 * echoes headings — so neither should feed the detector or the metrics.
 */
function stripTemplateChrome(html: string): string {
  return html
    .replace(
      /<section\b[^>]*class\s*=\s*["'][^"']*\bwc-methodology\b[^"']*["'][^>]*>[\s\S]*?<\/section\s*>/gi,
      " "
    )
    .replace(
      /<nav\b[^>]*class\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>[\s\S]*?<\/nav\s*>/gi,
      " "
    );
}

function toPlainText(htmlOrText: string): string {
  return unescapeHtml(stripHtmlToPlainText(htmlOrText));
}

function getWordCount(text: string): number {
  return text.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g)?.length ?? 0;
}

function getSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstWords(text: string, count: number): string {
  return (text.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [])
    .slice(0, count)
    .join(" ");
}

function countComplexWords(text: string): number {
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  return words.filter((word) => {
    const normalized = word.toLowerCase();
    return (
      normalized.length >= COMPLEX_WORD_LEN && !COMMON_WORDS.has(normalized)
    );
  }).length;
}

/**
 * Compute readability metrics over article text. Accepts plain text;
 * paragraph count is supplied by the caller (extracted from `<p>` blocks)
 * because the HTML stripper collapses paragraph boundaries.
 */
export function analyzeReadability(
  text: string,
  paragraphCount: number
): ReadabilityMetrics {
  const words = getWordCount(text);
  const sentences = getSentences(text);
  const complexWords = countComplexWords(text);
  const longSentences = sentences.filter(
    (s) => getWordCount(s) >= LONG_SENTENCE_WORDS
  ).length;
  const paragraphs = Math.max(paragraphCount, 0);

  return {
    words,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs,
    averageSentenceLength: sentences.length
      ? Number((words / sentences.length).toFixed(1))
      : 0,
    averageParagraphLength: paragraphs
      ? Number((sentences.length / paragraphs).toFixed(1))
      : 0,
    complexWordRate: words
      ? Number(((complexWords / words) * 100).toFixed(1))
      : 0,
    longSentences
  };
}

/** Distinct pattern labels matched anywhere in `text`. */
function collectPatternLabels(text: string): string[] {
  return [
    ...new Set(
      PROCESS_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => p.label)
    )
  ];
}

/**
 * Analyze rendered article HTML for readability + process language.
 * Deterministic and throw-safe by construction (regex + string ops only);
 * the writer still wraps the call per the Step 14.x convention.
 */
export function analyzeContentQuality(html: string): ContentQualityReport {
  const cleaned = stripTemplateChrome(html);
  const bodyText = toPlainText(cleaned);

  const paragraphCount =
    cleaned.match(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi)?.length ?? 0;
  const readability = analyzeReadability(bodyText, paragraphCount);

  // Intro = the writer-generated `.introduction` div rendered by
  // html-builder.ts. Measuring the whole H1→first-H2 span would count the
  // quick-answer box and other page chrome and permanently false-positive.
  const introHtml =
    cleaned.match(
      /<div\b[^>]*class\s*=\s*["'][^"']*\bintroduction\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i
    )?.[1] ?? "";
  const introText = toPlainText(introHtml);
  const introWords = getWordCount(introText);
  const introPatternLabels = collectPatternLabels(
    firstWords(introText, INTRO_SCAN_WORDS)
  );

  // Sentence-level findings so the Polish Agent has a find/replace target.
  const findings: ProcessLanguageFinding[] = [];
  for (const sentence of getSentences(bodyText)) {
    if (findings.length >= MAX_FINDINGS) break;
    if (sentence.length < MIN_SENTENCE_LEN) continue;
    const hit = PROCESS_PATTERNS.find((p) => p.pattern.test(sentence));
    if (hit) {
      findings.push({
        category: hit.category,
        label: hit.label,
        snippet: sentence
      });
    }
  }
  const bodyPatternLabels = [...new Set(findings.map((f) => f.label))];

  // Meta headings: H2/H3s that read like process notes.
  const metaHeadings: string[] = [];
  const headingRe = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headingRe.exec(cleaned)) !== null) {
    const headingText = toPlainText(hm[2]);
    if (headingText && META_HEADING_PATTERN.test(headingText)) {
      metaHeadings.push(headingText);
      if (findings.length < MAX_FINDINGS) {
        findings.push({
          category: "meta-heading",
          label: "process-note heading",
          snippet: headingText
        });
      }
    }
  }

  const issues: string[] = [];
  if (introWords > INTRO_MAX_WORDS) {
    issues.push(
      `Intro runs ${introWords} words. Get to the answer faster (spec is 100-150).`
    );
  }
  if (
    introPatternLabels.length >= 2 ||
    (introPatternLabels.length > 0 && introWords > INTRO_SOFT_MAX_WORDS)
  ) {
    issues.push(
      `Intro leans on process language (${introPatternLabels.join(", ")}). Rewrite it around the reader's problem and payoff.`
    );
  }
  if (metaHeadings.length > 0) {
    issues.push(
      `These headings read like internal process notes rather than reader-facing sections: ${metaHeadings
        .map((h) => `"${h}"`)
        .join(", ")}.`
    );
  }
  if (bodyPatternLabels.length >= BODY_PATTERN_ISSUE_THRESHOLD) {
    issues.push(
      `Body includes repeated methodology or exclusion language (${bodyPatternLabels.join(", ")}). Keep research notes internal unless they change the recommendation.`
    );
  }

  return { readability, introWords, findings, issues };
}

/** One-line summary for the activity log, mirroring the sibling detectors. */
export function summarizeContentQuality(report: ContentQualityReport): string {
  const r = report.readability;
  return (
    `${r.words} words, ${r.sentenceCount} sentences (avg ${r.averageSentenceLength} words, ${r.longSentences} long), ` +
    `${r.paragraphCount} paragraphs, complex-word rate ${r.complexWordRate}%, intro ${report.introWords} words, ` +
    `${report.findings.length} process-language finding(s)`
  );
}
