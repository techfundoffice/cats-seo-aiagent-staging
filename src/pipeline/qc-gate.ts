import { errMsg } from "./http-utils";

/** Fetch timeout for the live URL audit in `runQcGate` (ms). */
const QC_GATE_FETCH_TIMEOUT_MS = 15_000;

/**
 * qc-gate.ts — Post-publish QC gate for catsluvus articles.
 *
 * v1 ships a worker-side Schema.org JSON-LD validator only — the
 * single highest-value mechanical check given the defects observed on
 * `catsluvus.com/cat-products-1779377567/best-interactive-cat-toy-for-indoor-cats`
 * (whitespace normalizer corrupting JSON string values, schema leaks
 * embedded in `<script type="application/ld+json">` blocks).
 *
 * Layer 1 of the 3-layer QC plan: JSON-LD structural validation only.
 * Layers 2–3 (Lighthouse performance audit + Pa11y accessibility check)
 * land in a follow-up PR once a Cloudflare Containers service binding
 * (`QC_CONTAINER`) is provisioned and the container image is built.
 *
 * Designed to be called both:
 *   - Out-of-band by an operator via `POST /api/admin/qc-gate { url }`
 *     (this PR — manual, no pipeline integration yet).
 *   - In-pipeline as Step 14.5 of the writer (follow-up PR once
 *     thresholds are tuned against the existing corpus).
 *
 * Returns a structured `JsonLdReport` so callers can render the result
 * directly in the dashboard or attach it to a `claude-fix` issue body.
 */

/**
 * Result of validating every `<script type="application/ld+json">` block
 * on a page.
 *
 * `valid` is the simple bool the publish gate keys off of. `blocks`
 * carries per-block detail for the dashboard / runbook — each entry's
 * `errors[]` lists the structural problems caught by `validateSchema`.
 * A block with `errors.length === 0` validated cleanly.
 */
export interface JsonLdReport {
  valid: boolean;
  /** Total `<script type="application/ld+json">` blocks found. */
  blockCount: number;
  /** Per-block parse/validation detail. */
  blocks: Array<{
    /** 1-based index in document order. */
    index: number;
    /** `@type` of the top-level object, or `null` if the block didn't parse. */
    type: string | null;
    /** Structural errors. Empty array means the block validated. */
    errors: string[];
  }>;
}

/**
 * Top-level result of `runQcGate(url)`. Currently only includes the
 * JSON-LD report; extends with `lighthouse`, `pa11y`, etc. as those
 * layers ship.
 */
export interface QcGateReport {
  /** Composite pass/fail across every check that ran. */
  ok: boolean;
  /** Live URL that was audited. */
  url: string;
  /** Wall-clock duration of the audit, in milliseconds. */
  durationMs: number;
  /** JSON-LD structured-data validation. */
  jsonLd: JsonLdReport;
}

/**
 * Recognized Schema.org `@type` values and the fields each requires.
 * Required for the validator to flag a missing-field error;
 * recommended fields are not enforced (yet) but the set is here so a
 * follow-up can graduate them to warnings.
 *
 * The set is deliberately scoped to the types that `html-builder.ts`
 * actually emits — adding a new type to the renderer means adding it
 * here too. Anything outside this set is reported as
 * `unrecognized @type` (validator-friendly default — Schema.org has
 * hundreds of types and we only emit a handful).
 */
const SCHEMA_TYPE_RULES: Record<
  string,
  { required: string[]; recommended: string[] }
> = {
  Article: {
    required: ["headline", "author", "datePublished"],
    recommended: ["image", "publisher", "dateModified", "mainEntityOfPage"]
  },
  NewsArticle: {
    required: ["headline", "author", "datePublished"],
    recommended: ["image", "publisher", "dateModified"]
  },
  BlogPosting: {
    required: ["headline", "author", "datePublished"],
    recommended: ["image", "publisher", "dateModified"]
  },
  FAQPage: {
    required: ["mainEntity"],
    recommended: []
  },
  BreadcrumbList: {
    required: ["itemListElement"],
    recommended: []
  },
  Product: {
    required: ["name"],
    recommended: ["image", "description", "brand"]
  },
  ItemList: {
    required: ["itemListElement"],
    recommended: ["numberOfItems"]
  },
  VideoObject: {
    required: ["name", "thumbnailUrl", "uploadDate"],
    recommended: ["description", "contentUrl", "embedUrl", "duration"]
  },
  LocalBusiness: {
    required: ["name"],
    recommended: ["address", "telephone", "url"]
  },
  Organization: {
    required: ["name"],
    recommended: ["url", "logo"]
  },
  WebSite: {
    required: ["name", "url"],
    recommended: ["potentialAction"]
  },
  WebPage: {
    required: [],
    recommended: ["name", "url"]
  }
};

/**
 * Extract every `<script type="application/ld+json">` block's raw text
 * from an HTML document. Tolerates extra attributes, mixed-case
 * `Type`, and whitespace inside the open tag.
 *
 * Internal helper; callers should use `validateJsonLd` instead.
 */
function extractJsonLdBlocks(html: string): string[] {
  if (!html) return [];
  const out: string[] = [];
  const re =
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/**
 * Validate the structural shape of a parsed JSON-LD object against
 * `SCHEMA_TYPE_RULES`. Handles `@graph` arrays by validating each
 * member individually and concatenating errors.
 *
 * Returns a flat string[] of human-readable errors. Empty array means
 * the object validated; non-empty means at least one issue (each
 * string is one issue suitable for showing directly in a runbook).
 */
function validateSchema(
  obj: unknown,
  context = "$"
): { type: string | null; errors: string[] } {
  if (!obj || typeof obj !== "object") {
    return { type: null, errors: [`${context}: not an object`] };
  }
  const o = obj as Record<string, unknown>;
  // Non-schema.org @context values (e.g. Dublin Core, FOAF mixins) are not
  // validated — Schema.org validators don't reject unrecognised vocabularies.

  // `@graph` — root container holding multiple typed objects.
  if (Array.isArray(o["@graph"])) {
    const graph = o["@graph"] as unknown[];
    const allErrors: string[] = [];
    const types: string[] = [];
    for (let i = 0; i < graph.length; i++) {
      const sub = validateSchema(graph[i], `${context}.@graph[${i}]`);
      if (sub.type) types.push(sub.type);
      allErrors.push(...sub.errors);
    }
    return { type: types.join(",") || null, errors: allErrors };
  }

  const type = typeof o["@type"] === "string" ? (o["@type"] as string) : null;
  if (!type) {
    return { type: null, errors: [`${context}: missing @type`] };
  }

  const rule = SCHEMA_TYPE_RULES[type];
  if (!rule) {
    // Unknown type — return type but no errors. Validators don't
    // reject types they don't recognize; they just skip them.
    return { type, errors: [] };
  }

  const errors: string[] = [];
  for (const field of rule.required) {
    if (
      o[field] === undefined ||
      o[field] === null ||
      (typeof o[field] === "string" && (o[field] as string).trim() === "") ||
      (Array.isArray(o[field]) && (o[field] as unknown[]).length === 0)
    ) {
      errors.push(`${context} (${type}): missing required field "${field}"`);
    }
  }

  // FAQPage gets a deeper structural check — every Question must have
  // a non-empty `name` and an `acceptedAnswer.text`. This catches the
  // exact shape Google's Rich Results validator rejects.
  if (type === "FAQPage" && Array.isArray(o.mainEntity)) {
    const me = o.mainEntity as unknown[];
    if (me.length === 0) {
      errors.push(`${context} (FAQPage): mainEntity is empty`);
    }
    for (let i = 0; i < me.length; i++) {
      const q = me[i] as Record<string, unknown> | null;
      if (!q || typeof q !== "object") {
        errors.push(`${context} (FAQPage): mainEntity[${i}] not an object`);
        continue;
      }
      if (q["@type"] !== "Question") {
        errors.push(
          `${context} (FAQPage): mainEntity[${i}].@type expected "Question", got ${JSON.stringify(q["@type"])}`
        );
      }
      const name = typeof q.name === "string" ? q.name.trim() : "";
      if (!name) {
        errors.push(`${context} (FAQPage): mainEntity[${i}].name is empty`);
      }
      const ans = q.acceptedAnswer as Record<string, unknown> | undefined;
      if (!ans || typeof ans !== "object") {
        errors.push(
          `${context} (FAQPage): mainEntity[${i}].acceptedAnswer missing`
        );
      } else {
        if (ans["@type"] !== "Answer") {
          errors.push(
            `${context} (FAQPage): mainEntity[${i}].acceptedAnswer.@type expected "Answer", got ${JSON.stringify(ans["@type"])}`
          );
        }
        const t = typeof ans.text === "string" ? ans.text.trim() : "";
        if (!t) {
          errors.push(
            `${context} (FAQPage): mainEntity[${i}].acceptedAnswer.text is empty`
          );
        }
      }
    }
  }

  // BreadcrumbList: every itemListElement must have position + name + item.
  // Google requires `item` (URL or @id object) for all items except the last.
  if (type === "BreadcrumbList" && Array.isArray(o.itemListElement)) {
    const items = o.itemListElement as unknown[];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as Record<string, unknown> | null;
      if (!it || typeof it !== "object") {
        errors.push(
          `${context} (BreadcrumbList): itemListElement[${i}] not an object`
        );
        continue;
      }
      if (typeof it.position !== "number") {
        errors.push(
          `${context} (BreadcrumbList): itemListElement[${i}].position must be a number`
        );
      }
      if (!it.name || (typeof it.name === "string" && !it.name.trim())) {
        errors.push(
          `${context} (BreadcrumbList): itemListElement[${i}].name is empty`
        );
      }
      // `item` (URL) is required for every breadcrumb except the final one.
      if (i < items.length - 1) {
        const itemProp = it.item;
        // `item` may be a plain URL string or a Thing object with `@id`.
        const itemId =
          itemProp !== null &&
          typeof itemProp === "object" &&
          typeof (itemProp as Record<string, unknown>)["@id"] === "string"
            ? (itemProp as Record<string, unknown>)["@id"]
            : itemProp;
        if (!itemId || (typeof itemId === "string" && !itemId.trim())) {
          errors.push(
            `${context} (BreadcrumbList): itemListElement[${i}].item is missing (required for non-final breadcrumbs)`
          );
        }
      }
    }
  }

  return { type, errors };
}

/**
 * Extract + parse + validate every JSON-LD block in `html`. The
 * primary check Layer 1 uses; if `valid === false`, the article fails
 * the gate.
 *
 * Catches:
 *   - Malformed JSON (parser threw)
 *   - Missing `@type`
 *   - Missing required Schema.org fields per type
 *   - FAQPage with empty/malformed Questions
 *   - BreadcrumbList with malformed items
 *
 * This is the check that would have flagged the
 * `normalizeHtmlWhitespace` bug: when "..." inside a `text` field was
 * converted to "…" the JSON was still structurally valid, but if it
 * happened mid-key or mid-quote the parse fails — caught here.
 */
export function validateJsonLd(html: string): JsonLdReport {
  const raw = extractJsonLdBlocks(html);
  const blocks: JsonLdReport["blocks"] = [];
  let allValid = true;

  for (let i = 0; i < raw.length; i++) {
    const text = raw[i].trim();
    if (!text) {
      blocks.push({
        index: i + 1,
        type: null,
        errors: [`block ${i + 1}: empty`]
      });
      allValid = false;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      blocks.push({
        index: i + 1,
        type: null,
        errors: [`block ${i + 1}: JSON parse failed — ${errMsg(err)}`]
      });
      allValid = false;
      continue;
    }
    const sub = validateSchema(parsed, `block ${i + 1}`);
    if (sub.errors.length > 0) allValid = false;
    blocks.push({
      index: i + 1,
      type: sub.type,
      errors: sub.errors
    });
  }

  return {
    valid: allValid,
    blockCount: raw.length,
    blocks
  };
}

export type JsonLdSeverity = "ok" | "minor" | "severe";

// Types whose missing required fields are treated as SEVERE. Product is
// emitted as part of every commerce-review article's ItemList — a Product
// missing `name` fails Google's Rich Results Test. VideoObject is emitted
// whenever a YouTube embed is present — missing name / thumbnailUrl /
// uploadDate forfeits Google Video rich-result eligibility.
const SEVERE_REQUIRED_FIELDS_TYPES = new Set([
  "Article",
  "FAQPage",
  "BreadcrumbList",
  "ItemList",
  "Product",
  "VideoObject"
]);

/**
 * Classify a `JsonLdReport` into "severe" vs "minor" failure modes
 * so the writer can decide whether to record a defect-loop finding
 * (severe → finding → loop fires the html-builder generator fix) or
 * just log (minor → soft warning).
 *
 * Severe failure modes:
 *   - Zero JSON-LD blocks present (every article must emit at least
 *     Article + BreadcrumbList; absence = generator regression)
 *   - Block-level JSON parse failure
 *   - Missing @type on any block
 *   - Missing required field on Article / FAQPage / BreadcrumbList /
 *     ItemList / Product / VideoObject (the six schema.org types
 *     Google consumes for rich-result eligibility on this site)
 *
 * Returns:
 *   - `severity`: "ok" | "minor" | "severe"
 *   - `severeReasons`: short strings ready for log + defect-finding
 *     evidence. Empty for non-severe.
 */
export function classifyJsonLdSeverity(report: JsonLdReport): {
  severity: JsonLdSeverity;
  severeReasons: string[];
} {
  // Zero JSON-LD blocks is a SEVERE generator regression — every
  // published article should emit at least Article + BreadcrumbList.
  // An empty block list means html-builder.ts stopped emitting schema
  // entirely, which Google treats as no rich-result eligibility.
  if (report.blockCount === 0) {
    return {
      severity: "severe",
      severeReasons: ["no JSON-LD blocks present"]
    };
  }
  if (report.valid) return { severity: "ok", severeReasons: [] };
  const severeReasons: string[] = [];
  for (const block of report.blocks) {
    for (const err of block.errors) {
      // Parse failure on any block — Google can't read the schema at
      // all. Severe.
      if (/JSON parse failed/i.test(err)) {
        severeReasons.push(`block ${block.index}: parse failure`);
        continue;
      }
      // Missing @type — block contributes nothing to rich-result
      // eligibility. Severe.
      if (/missing @type/i.test(err)) {
        severeReasons.push(`block ${block.index}: missing @type`);
        continue;
      }
      // Missing required field on a rich-result type.
      const reqMatch = err.match(
        /\(([A-Za-z]+)\): missing required field "([^"]+)"/
      );
      if (reqMatch) {
        const [, schemaType, field] = reqMatch;
        if (SEVERE_REQUIRED_FIELDS_TYPES.has(schemaType)) {
          severeReasons.push(`${schemaType}.${field} missing`);
          continue;
        }
      }
    }
  }
  if (severeReasons.length > 0) {
    // Dedupe — repeated "block N: parse failure" entries collapse so
    // the defect-finding evidence stays compact.
    const uniq = Array.from(new Set(severeReasons));
    return { severity: "severe", severeReasons: uniq };
  }
  return { severity: "minor", severeReasons: [] };
}

/**
 * Fetch the live URL, validate its JSON-LD, return a composite report.
 *
 * Uses plain `fetch` with a desktop UA — Cloudflare's bot mitigation
 * on catsluvus.com 403s the default Worker UA. We don't go through
 * Cloudflare Browser Rendering here because JSON-LD is server-side
 * rendered and parseable from the static HTML; the rendering overhead
 * isn't worth it for this check.
 */
export async function runQcGate(url: string): Promise<QcGateReport> {
  const start = Date.now();
  let html = "";
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(QC_GATE_FETCH_TIMEOUT_MS)
    });
    if (!res.ok) {
      return {
        ok: false,
        url,
        durationMs: Date.now() - start,
        jsonLd: {
          valid: false,
          blockCount: 0,
          blocks: [
            {
              index: 0,
              type: null,
              errors: [`fetch failed — HTTP ${res.status}`]
            }
          ]
        }
      };
    }
    html = await res.text();
  } catch (err: unknown) {
    return {
      ok: false,
      url,
      durationMs: Date.now() - start,
      jsonLd: {
        valid: false,
        blockCount: 0,
        blocks: [
          { index: 0, type: null, errors: [`fetch threw — ${errMsg(err)}`] }
        ]
      }
    };
  }

  const jsonLd = validateJsonLd(html);
  return {
    ok: jsonLd.valid,
    url,
    durationMs: Date.now() - start,
    jsonLd
  };
}
