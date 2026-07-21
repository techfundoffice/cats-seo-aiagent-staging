import { errMsg, repairJson, extractFirstJsonObject } from "./http-utils";
import { runKimiWithPoll } from "./kimi-model";
import type { SEOArticleAgent } from "../server";
import type { ArticleData } from "./html-builder";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Rough word-count estimate for an ArticleData object. */
function estimateWordCount(article: ArticleData): number {
  const text = [
    article.title,
    article.metaDescription,
    article.quickAnswer,
    ...article.keyTakeaways,
    article.introduction,
    ...article.sections.map((s) => `${s.heading} ${s.content}`),
    article.whyTrustUs,
    ...article.faqs.map((f) => `${f.question} ${f.answer}`),
    article.conclusion
  ].join(" ");
  return text.split(/\s+/).filter(Boolean).length;
}

/** Count total characters across every text field of ArticleData. */
function totalChars(article: ArticleData): number {
  return [
    article.title,
    article.metaDescription,
    article.quickAnswer,
    ...article.keyTakeaways,
    article.introduction,
    ...article.sections.map((s) => `${s.heading}${s.content}`),
    article.whyTrustUs,
    ...article.faqs.map((f) => `${f.question}${f.answer}`),
    article.conclusion
  ].join("").length;
}

/** Characters changed between two ArticleData values. */
function diffChars(before: ArticleData, after: ArticleData): number {
  return Math.abs(totalChars(after) - totalChars(before));
}

/**
 * Detect common text-quality issues in an ArticleData object.
 * Returns a human-readable list of issue strings (empty = clean).
 */
function detectIssues(article: ArticleData): string[] {
  const issues: string[] = [];

  // Truncated field — ends with an incomplete word/sentence marker
  const TRUNCATION_RE = /[\w,]\.{3}$|…$/;
  const hasTrailingTruncation = (value: string): boolean =>
    TRUNCATION_RE.test(value.trimEnd());
  if (hasTrailingTruncation(article.title)) issues.push("truncation: title");
  if (hasTrailingTruncation(article.metaDescription))
    issues.push("truncation: metaDescription");
  if (hasTrailingTruncation(article.introduction))
    issues.push("truncation: introduction");
  if (hasTrailingTruncation(article.conclusion))
    issues.push("truncation: conclusion");
  if (hasTrailingTruncation(article.quickAnswer))
    issues.push("truncation: quickAnswer");
  if (hasTrailingTruncation(article.whyTrustUs))
    issues.push("truncation: whyTrustUs");
  article.keyTakeaways.forEach((kt, i) => {
    if (hasTrailingTruncation(kt))
      issues.push(`truncation: keyTakeaways[${i}]`);
  });
  article.sections.forEach((s, i) => {
    if (hasTrailingTruncation(s.heading))
      issues.push(`truncation: sections[${i}].heading`);
    if (hasTrailingTruncation(s.content))
      issues.push(`truncation: sections[${i}].content`);
  });
  article.faqs.forEach((f, i) => {
    if (hasTrailingTruncation(f.question))
      issues.push(`truncation: faqs[${i}].question`);
    if (hasTrailingTruncation(f.answer))
      issues.push(`truncation: faqs[${i}].answer`);
  });

  // Empty sections
  article.sections.forEach((s, i) => {
    if (!s.content || s.content.trim().length < 30)
      issues.push(`empty-section: sections[${i}] "${s.heading}"`);
  });

  // Leaked model tokens / schema markers.
  // Match markdown code fences with any language tag (or none), not
  // only ```json, while also preserving explicit bare closing-fence
  // detection at end-of-line.
  const TOKEN_RE =
    /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|```(?:[a-z0-9_-]+)?|```\s*$/im;
  const allText = [
    article.introduction,
    article.conclusion,
    article.quickAnswer,
    article.whyTrustUs,
    ...article.keyTakeaways,
    ...article.sections.flatMap((s) => [s.heading, s.content]),
    ...article.faqs.map((f) => `${f.question} ${f.answer}`)
  ].join("\n");
  if (TOKEN_RE.test(allText))
    issues.push("token-leak: model artifacts in text");

  // Exact duplicate sections
  const seen = new Set<string>();
  article.sections.forEach((s, i) => {
    const key = s.content.trim().slice(0, 120);
    if (key.length > 10 && seen.has(key))
      issues.push(`duplicate: sections[${i}] matches an earlier section`);
    seen.add(key);
  });

  return issues;
}

/**
 * Extract the first balanced JSON object substring from a model response.
 * Braces inside quoted strings are ignored. If the object is truncated, return
 * everything from the first `{` onward so `repairJson` can try to close it.
 */
// ── Safeguards ─────────────────────────────────────────────────────────────────

/** Max characters shown in the before/after title diff logged on rejection. */
const TITLE_PREVIEW_LENGTH = 40;

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isSectionArray(value: unknown): value is ArticleData["sections"] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof entry.heading === "string" &&
        typeof entry.content === "string"
    )
  );
}

function isFaqArray(value: unknown): value is ArticleData["faqs"] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof entry.question === "string" &&
        typeof entry.answer === "string"
    )
  );
}

function isPickReasonArray(
  value: unknown
): value is NonNullable<ArticleData["pickReasons"]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof entry.asin === "string" &&
        (entry.label === undefined || typeof entry.label === "string") &&
        typeof entry.reasoning === "string"
    )
  );
}

/** Returns a rejection reason string, or null if the candidate passes. */
function validateCandidate(
  original: ArticleData,
  candidate: unknown
): string | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return "candidate is not an object";
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record.title !== "string") {
    return "title missing or invalid";
  }
  if (typeof record.metaDescription !== "string") {
    return "metaDescription missing or invalid";
  }
  if (typeof record.quickAnswer !== "string") {
    return "quickAnswer missing or invalid";
  }
  if (!isStringArray(record.keyTakeaways)) {
    return "keyTakeaways missing or invalid";
  }
  if (typeof record.introduction !== "string") {
    return "introduction missing or invalid";
  }
  if (!isSectionArray(record.sections)) {
    return "sections missing or invalid";
  }
  if (typeof record.whyTrustUs !== "string") {
    return "whyTrustUs missing or invalid";
  }
  if (!isFaqArray(record.faqs)) {
    return "faqs missing or invalid";
  }
  if (typeof record.conclusion !== "string") {
    return "conclusion missing or invalid";
  }
  const articleCandidate: ArticleData = {
    title: record.title,
    metaDescription: record.metaDescription,
    quickAnswer: record.quickAnswer,
    keyTakeaways: record.keyTakeaways,
    introduction: record.introduction,
    sections: record.sections,
    whyTrustUs: record.whyTrustUs,
    faqs: record.faqs,
    conclusion: record.conclusion,
    wordCount:
      typeof record.wordCount === "number" ? record.wordCount : undefined,
    pickReasons: isPickReasonArray(record.pickReasons)
      ? record.pickReasons
      : undefined
  };

  if (articleCandidate.title !== original.title) {
    const orig = original.title.slice(0, TITLE_PREVIEW_LENGTH);
    const cand = articleCandidate.title.slice(0, TITLE_PREVIEW_LENGTH);
    return `title changed ("${orig}" → "${cand}")`;
  }
  if (articleCandidate.metaDescription !== original.metaDescription) {
    return "metaDescription changed";
  }
  if (articleCandidate.sections.length !== original.sections.length) {
    return `section count changed (${original.sections.length} → ${articleCandidate.sections.length})`;
  }
  if (articleCandidate.faqs.length !== original.faqs.length) {
    return `FAQ count changed (${original.faqs.length} → ${articleCandidate.faqs.length})`;
  }
  if (articleCandidate.keyTakeaways.length !== original.keyTakeaways.length) {
    return `keyTakeaways count changed (${original.keyTakeaways.length} → ${articleCandidate.keyTakeaways.length})`;
  }
  return null;
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a copy-editor for a cat-product review site.
Your ONLY task is to fix mechanical text-quality issues in an article JSON object.

ALLOWED fixes (minimal, surgical):
1. Complete truncated sentences that end with "..." or "…"
2. Remove leaked model tokens: [INST], [/INST], \`\`\`json, <|im_start|>, etc.
3. Fill empty section.content fields (< 30 chars) with a short placeholder sentence
4. Remove exact-duplicate section content (keep first occurrence, replace later with a 1-sentence summary)

FORBIDDEN:
- Do NOT change the article title, metaDescription, slug, or keyword targeting
- Do NOT reorder sections or FAQs
- Do NOT add or remove sections or FAQs
- Do NOT add or remove keyTakeaways entries
- Do NOT change product ASINs or affiliate links
- Do NOT rewrite passages that are already complete and clean
- Do NOT change tone, style, or SEO density

Return ONLY the corrected JSON object in exactly the same schema as the input.
No explanation, no markdown fences, no commentary — just the raw JSON.`;

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Text Editor Agent — step 9.5 in the pipeline.
 *
 * Scans the in-memory ArticleData for mechanical text-quality issues
 * (truncation, empty sections, model-token leaks, duplicate content)
 * and asks Kimi K2.5 to produce a minimal corrected version.
 *
 * All diagnostic output is emitted under role `textEditorAgent` so it
 * routes exclusively to the "Published Article Text Editor" dashboard panel.
 *
 * Non-fatal: any error or safeguard rejection returns the original article
 * unchanged.
 */
export async function runTextEditorAgent(
  agent: SEOArticleAgent,
  article: ArticleData,
  keyword: string
): Promise<ArticleData> {
  const role = "textEditorAgent" as const;

  const wc = estimateWordCount(article);
  const sectionCount = article.sections.length;
  const faqCount = article.faqs.length;
  agent.log(
    "info",
    `[start] keyword="${keyword}" wordCount≈${wc} sections=${sectionCount} faqs=${faqCount}`,
    role
  );

  // ── 1. Scan ────────────────────────────────────────────────────────────────
  const issues = detectIssues(article);
  if (issues.length === 0) {
    agent.log("info", "[scan] no issues detected — skipping rewrite", role);
    agent.log(
      "info",
      `[done] fields touched=0 chars changed=0 result=clean`,
      role
    );
    return article;
  }
  agent.log(
    "info",
    `[scan] ${issues.length} issue(s): ${issues.join("; ")}`,
    role
  );

  // ── 2. Kimi rewrite ────────────────────────────────────────────────────────
  let rawResponse: string;
  try {
    rawResponse = await runKimiWithPoll(
      agent.envBindings,
      {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Fix the following article JSON (keyword: "${keyword}").\n\n${JSON.stringify(article)}`
          }
        ],
        max_tokens: 8192
      },
      {},
      agent
    );
  } catch (err: unknown) {
    const msg = errMsg(err);
    agent.log(
      "warning",
      `[done] keyword="${keyword}" Kimi call failed — returning original (${msg})`,
      role
    );
    return article;
  }

  // ── 3. Parse ───────────────────────────────────────────────────────────────
  let candidate: unknown;
  try {
    // Strip optional markdown fences the model sometimes emits despite instructions.
    // Trim first so a leading newline before the opening fence doesn't prevent
    // the ^-anchored regex from matching (same order used in writer.ts).
    const cleaned = rawResponse
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    // Try raw parse first; if it fails, attempt repairJson (handles trailing
    // commas, bare newlines inside strings, control chars). Last resort:
    // extract the outermost {…} block so stray prose around the JSON object
    // does not force us to discard an otherwise usable rewrite.
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      try {
        parsed = JSON.parse(repairJson(cleaned));
      } catch {
        const extracted = extractFirstJsonObject(cleaned) ?? cleaned;
        parsed = JSON.parse(repairJson(extracted));
      }
    }
    candidate = parsed as ArticleData;
  } catch (err: unknown) {
    const msg = errMsg(err);
    agent.log(
      "warning",
      `[done] keyword="${keyword}" JSON parse failed — returning original (${msg})`,
      role
    );
    return article;
  }

  // ── 4. Safeguards ──────────────────────────────────────────────────────────
  const rejection = validateCandidate(article, candidate);
  if (rejection) {
    agent.log(
      "warning",
      `[done] keyword="${keyword}" safeguard rejection — returning original (${rejection})`,
      role
    );
    return article;
  }
  const acceptedCandidate = candidate as ArticleData;

  // ── 5. Diff + large-change warning ────────────────────────────────────────
  const changed = diffChars(article, acceptedCandidate);
  const LARGE_CHANGE_THRESHOLD = 500;

  // Count fields that actually changed
  const fieldsChanged: string[] = [];
  if (acceptedCandidate.title !== article.title) fieldsChanged.push("title");
  if (acceptedCandidate.metaDescription !== article.metaDescription)
    fieldsChanged.push("metaDescription");
  if (acceptedCandidate.introduction !== article.introduction)
    fieldsChanged.push("introduction");
  if (acceptedCandidate.conclusion !== article.conclusion)
    fieldsChanged.push("conclusion");
  if (acceptedCandidate.quickAnswer !== article.quickAnswer)
    fieldsChanged.push("quickAnswer");
  if (acceptedCandidate.whyTrustUs !== article.whyTrustUs)
    fieldsChanged.push("whyTrustUs");
  acceptedCandidate.keyTakeaways.forEach((kt, i) => {
    if (i < article.keyTakeaways.length && kt !== article.keyTakeaways[i])
      fieldsChanged.push(`keyTakeaways[${i}]`);
  });
  acceptedCandidate.sections.forEach((s, i) => {
    const orig = article.sections[i];
    if (orig && (s.content !== orig.content || s.heading !== orig.heading)) {
      fieldsChanged.push(`sections[${i}]`);
    }
  });
  acceptedCandidate.faqs.forEach((f, i) => {
    const orig = article.faqs[i];
    if (orig && (f.question !== orig.question || f.answer !== orig.answer)) {
      fieldsChanged.push(`faqs[${i}]`);
    }
  });

  for (const field of fieldsChanged) {
    agent.log("info", `[fix] ${field} updated`, role);
  }

  if (changed > LARGE_CHANGE_THRESHOLD) {
    agent.log(
      "warning",
      `[large-change warning] keyword="${keyword}" ${changed} chars changed across ${fieldsChanged.length} field(s): ${fieldsChanged.join(", ")}`,
      role
    );
  }

  agent.log(
    "info",
    `[done] fields touched=${fieldsChanged.length} chars changed=${changed} result=accepted`,
    role
  );

  return acceptedCandidate;
}
