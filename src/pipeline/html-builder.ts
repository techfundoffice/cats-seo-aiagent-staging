import type { AmazonProduct } from "./amazon";
import { escXml as escapeHtml, unescapeHtml } from "./http-utils";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Editorial reasoning for a single product pick — 2-3 sentences explaining
 * why it's on the list. Paired to a product by ASIN at render time;
 * unpaired entries are dropped silently.
 */
export interface PickReasoning {
  asin: string;
  /** Short label above the reasoning (e.g. "Best overall", "Budget pick"). */
  label?: string;
  /** 2-3 sentence explanation in plain text or minimal inline HTML. */
  reasoning: string;
}

/**
 * The canonical "Why we like this pick:" sentence-3 marker every
 * editorial reasoning is supposed to end with — see the writer's
 * product-blurb prompt in `src/pipeline/writer.ts` (sentence-3 spec).
 *
 * When Kimi is healthy this marker arrives in every blurb. When Kimi
 * is degraded (OpenRouter credit wall, see `kimiProviderHealth.ts`)
 * sentence-3 frequently goes missing, which the Step 14.5 detector
 * in `writer.ts:2169` picks up as a `missing-why-we-like-blurb`
 * defect-finding. The detector logs + records but does NOT block
 * publish, so the live article ends up missing its closing editorial
 * endorsement on every product pick.
 *
 * This helper closes that gap at render time. Given a Kimi-generated
 * `reasoning` string + a fallback label/product context, return a
 * reasoning string guaranteed to contain the marker. Real Kimi-
 * generated markers (when present) pass through unchanged; only
 * Kimi-omitted ones get the templated fallback appended.
 *
 * Unit-tested in src/pipeline/__tests__/why-we-like-marker.test.ts.
 */
const WHY_WE_LIKE_MARKER = "Why we like this pick:";
const WHY_WE_LIKE_REGEX = /Why\s+we\s+like\s+this\s+pick\s*:/i;

export function ensureWhyWeLikeMarker(
  reasoning: string,
  context: {
    label?: string;
    productName?: string;
    keyword: string;
    ratingValue?: number;
    reviewCount?: number;
    features?: string;
  }
): string {
  const text = reasoning.trim();
  if (WHY_WE_LIKE_REGEX.test(text)) return text;
  // Build a single-sentence templated closing line. Prefer the label
  // (e.g. "Best overall") when present, otherwise fall back to the
  // keyword phrase so the marker reads naturally for the article topic.
  const label = (context.label ?? "").trim();
  const keyword = (context.keyword ?? "").trim().toLowerCase();
  // Differentiate per product: when 5 picks all fell back at once
  // (pickReasons generation down), the identical "fits the brief for
  // <keyword>." line shipped 5x on 2026-06-11 — and the keyword-thinning
  // pass then mangled the repeats into "fits the brief for it." /
  // "…for one.". Leading with the product name makes each line distinct
  // and survives thinning grammatically.
  const productLead = (context.productName ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
  const subject = productLead ? `the ${productLead}` : "this pick";
  const closingLine = label
    ? `${WHY_WE_LIKE_MARKER} ${subject} is a strong ${label.toLowerCase()} for ${keyword || "this category"}.`
    : `${WHY_WE_LIKE_MARKER} ${subject} covers what buyers look for in ${keyword || "this category"}.`;
  // Data-driven enrichment: when the model omitted pickReasons entirely
  // (observed with both Kimi and Grok), a bare one-liner reads thin next
  // to the product card. Real rating/review/feature data makes the
  // fallback editorial instead of templated. The marker sentence stays
  // LAST — the blurb convention is that the final sentence begins with
  // "Why we like this pick:".
  const extras: string[] = [];
  if (
    typeof context.ratingValue === "number" &&
    context.ratingValue > 0 &&
    typeof context.reviewCount === "number" &&
    context.reviewCount > 0
  ) {
    extras.push(
      `Rated ${context.ratingValue}/5 across ${context.reviewCount.toLocaleString("en-US")} buyer reviews, it's a proven choice rather than a gamble.`
    );
  }
  const firstFeature = (context.features ?? "").split(/[|;•\n]/)[0]?.trim();
  if (firstFeature && firstFeature.length >= 20) {
    const clipped = `${firstFeature.slice(0, 140)}${firstFeature.length > 140 ? "…" : ""}`;
    extras.push(
      /[.!?…]$/.test(clipped)
        ? `Standout detail: ${clipped}`
        : `Standout detail: ${clipped}.`
    );
  }
  const parts = [text, ...extras, closingLine].filter(Boolean);
  return parts.join(" ");
}

/**
 * Structured article content produced by the Kimi writing step and consumed
 * by `buildArticleHtml`. Every field maps directly to a rendered section in
 * the output HTML; the serialised form is also persisted to
 * `article_data` KV keys so the Editorial Agent can re-render without
 * re-running the full pipeline.
 *
 * Required string fields (`title`, `metaDescription`, etc.) are guaranteed
 * non-empty by `parseArticleJson` / `normalizePickReasons` before the
 * object reaches the HTML builder. Optional arrays default to `[]` when
 * the model omits them.
 */
export interface ArticleData {
  title: string;
  metaDescription: string;
  quickAnswer: string;
  keyTakeaways: string[];
  introduction: string;
  sections: Array<{ heading: string; content: string }>;
  whyTrustUs: string;
  faqs: Array<{ question: string; answer: string }>;
  conclusion: string;
  wordCount?: number;
  /**
   * Per-pick editorial reasoning. Generated by the writer at Step 5 when
   * real product data is available. One entry per product in the Top
   * Picks section, matched by ASIN.
   */
  pickReasons?: PickReasoning[];
}

/**
 * Options accepted by `buildArticleHtml`.
 *
 * The `article`, `slug`, `keyword`, `categorySlug`, `categoryName`,
 * `domain`, `tag`, and `products` fields are always required; every other
 * field is optional and adds progressive enrichment (hero image, YouTube
 * embed, internal/external link sections).
 */
export interface BuildHtmlOpts {
  article: ArticleData;
  slug: string;
  keyword: string;
  categorySlug: string;
  categoryName: string;
  domain: string;
  /**
   * Amazon Associates affiliate tracking tag appended to every product URL
   * as `?tag=<value>`. Required for commission tracking; every
   * `amazon.com/dp/<ASIN>` and `amazon.com/s?k=<term>` link in the output
   * HTML carries this tag.
   */
  tag: string;
  products: AmazonProduct[];
  /**
   * URL of the article hero/OG image shown at the top of the page. When
   * absent but `videoId` is set, the YouTube thumbnail is used as the
   * fallback hero.
   */
  heroImageUrl?: string;
  /**
   * YouTube video ID embedded below the hero image (e.g. `"dQw4w9WgXcQ"`).
   * Also used as the thumbnail source when `heroImageUrl` is omitted.
   */
  videoId?: string;
  /**
   * Video title for the Schema.org `VideoObject` structured-data block.
   * Falls back to `keyword` when absent.
   */
  videoTitle?: string;
  /** YouTube channel name for the Schema.org `VideoObject` structured-data block. */
  videoChannel?: string;
  /**
   * Same-site article links rendered as a "More Guides in This Category"
   * section (up to 6 shown). Populated by `fetchSemanticInternalLinks`
   * (Step 4).
   */
  internalLinks?: Array<{ url: string; text: string }>;
  /**
   * Trusted-sources reference list rendered at the bottom of the article
   * (up to 5 shown). Falls back to universal cat-health references when
   * absent.
   */
  externalLinks?: Array<{ url: string; text: string }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function stripHtmlTags(text: string): string {
  return text
    .replace(/<\/?p>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Detect step-by-step / how-to keywords. Conservative — only fires
 * when the keyword starts with an unambiguous instructional phrase
 * so we don't emit HowTo schema for product round-ups that happen
 * to mention "how to" mid-keyword.
 */
const HOWTO_KEYWORD_RE = /^\s*how\s+(?:to|do|can|should|long)\b/i;

export function isHowToKeyword(keyword: string): boolean {
  if (!keyword) return false;
  return HOWTO_KEYWORD_RE.test(keyword.trim());
}

/**
 * Build a Schema.org HowTo JSON-LD object from an article when the
 * keyword indicates a step-by-step intent. Returns null when the
 * keyword isn't how-to OR when there aren't enough sections to make
 * a credible HowTo (Google's minimum is 2 steps).
 *
 * Step text is the first complete sentence of each section's content
 * (HTML stripped), capped at 320 chars per Google's HowTo guidance.
 *
 * Each step gets a stable URL anchor (#section-1, #section-2, …)
 * mirroring the html-builder's section-id emission so the rich
 * result deep-links into the actual section.
 */
interface ArticleSectionLike {
  heading: string;
  content: string;
}

const HOWTO_MAX_STEPS = 12;
const HOWTO_STEP_TEXT_MAX = 320;

/**
 * Headings that are excluded from the sections rendered inside the
 * `<main>` body — used by both `buildHowToSchema` and `buildArticleHtml`
 * so the two paths stay provably in lockstep. If a section is absent from
 * the rendered DOM its `#section-N` anchor does not exist, so emitting it
 * in HowTo schema would produce a broken deep link.
 */
function isExcludedFromRenderedSections(heading: string): boolean {
  const h = (heading ?? "").trim().toLowerCase();
  return h === "top picks" || h === "our top picks";
}

export function buildHowToSchema(
  article: { sections: ArticleSectionLike[]; title: string },
  keyword: string,
  canonicalUrl: string
): object | null {
  if (!isHowToKeyword(keyword)) return null;
  // Apply the same render-time filter so step URLs (#section-N) line
  // up with the actual rendered section IDs. Without this the HowTo
  // schema's deep-link anchors break when a "Top Picks" / "Our Top
  // Picks" section appears in the source article.
  const renderedSections = (article.sections || []).filter(
    (section) => !isExcludedFromRenderedSections(section.heading)
  );
  const sections = renderedSections.slice(0, HOWTO_MAX_STEPS);
  if (sections.length < 2) return null;
  const steps = sections.map((section, idx) => {
    const plain = stripHtmlTags(section.content || "");
    const sentenceMatch = plain.match(/^[\s\S]*?[.!?](?=\s|$)/);
    const firstSentence = sentenceMatch ? sentenceMatch[0].trim() : plain;
    const text =
      firstSentence.length > HOWTO_STEP_TEXT_MAX
        ? firstSentence.slice(0, HOWTO_STEP_TEXT_MAX).trim()
        : firstSentence;
    // Strip HTML from the heading too — Schema.org expects plain text
    // and embedded markup in HowToStep.name breaks rich-result parsing.
    const cleanHeading = stripHtmlTags(section.heading || "");
    return {
      "@type": "HowToStep",
      position: idx + 1,
      name: cleanHeading || section.heading,
      text: text || cleanHeading || section.heading,
      url: `${canonicalUrl}#section-${idx + 1}`
    };
  });
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: article.title,
    step: steps
  };
}

/**
 * Canonical price-pattern set used by both `extractKeywordPriceTokens` and
 * `stripPricesFromHtml`. Keeping them in one place ensures both functions
 * always agree on what constitutes a "price" token — if a new pattern is
 * added here (e.g. "€19") it is automatically applied to both the keyword
 * whitelist extraction and the article-HTML stripping pass.
 *
 * Matches: `$19`, `$19.99`, `$1500`, `$1,499`, `$ 19`, "19 dollars", "USD 19",
 *          "US$19", "US$ 19".
 */
/**
 * Pixel size of the product-pick image rendered next to each "Our Top
 * Picks" entry. Must stay in lockstep between the HTML width/height
 * attributes (line ~644) and the .pick-image CSS rule (line ~1071) so
 * the layout doesn't shift between server-render and CSS-paint.
 */
const PICK_IMAGE_SIZE_PX = 120;

/**
 * "Cats Luv Us Best Pick" award seal for the #1 pick's product image.
 * Deterministic inline SVG — never AI-generated (diffusion models mangle
 * written text) — in site colors: navy seal, pink ring, gold award line.
 * Deliberately year-free so the badge never goes stale. Rendered inside
 * the affiliate anchor, so clicking the seal is also a purchase link.
 */
export const PICK_AWARD_BADGE_SVG =
  `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cats Luv Us Best Pick award">` +
  `<circle cx="32" cy="32" r="30" fill="#1d2a5e" stroke="#e91e8c" stroke-width="3"/>` +
  `<circle cx="32" cy="32" r="25" fill="none" stroke="#ffffff" stroke-width="1" stroke-dasharray="2.5 2.5" opacity="0.55"/>` +
  `<text x="32" y="25" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="7" font-weight="700" fill="#ffffff" letter-spacing="0.6">CATS LUV US</text>` +
  `<text x="32" y="38" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="10.5" font-weight="800" fill="#ffd166">BEST</text>` +
  `<text x="32" y="49" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="10.5" font-weight="800" fill="#ffd166">PICK</text>` +
  `</svg>`;

const PRICE_PATTERNS: readonly RegExp[] = [
  // $19, $19.99, $1500, $1,499, $ 19
  /\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?\b/g,
  // "19 dollars" / "19 bucks"
  /\b\d{1,4}(?:\.\d{1,2})?\s+(?:dollars?|bucks?|USD)\b/gi,
  // "USD 19" / "US$19"
  /\b(?:USD|US\$)\s?\d{1,4}(?:\.\d{2})?\b/gi
];

/**
 * Extract the price-tier tokens from a keyword (e.g. "best cat tree under
 * $200" → ["$200"], "best cat litter mat under 25 dollars" →
 * ["25 dollars"]). Used by callers of stripPricesFromHtml() to whitelist
 * their own keyword's price tier so it isn't ripped out of titles/H1/meta
 * as if it were a leaked Amazon product price.
 */
export function extractKeywordPriceTokens(keyword: string): string[] {
  const tokens: string[] = [];
  for (const re of PRICE_PATTERNS) {
    for (const m of keyword.matchAll(re)) tokens.push(m[0]);
  }
  return tokens;
}

/**
 * Strip price mentions from published article HTML. Amazon Associates
 * compliance: we never display prices (scraped/stale prices violate
 * the Operating Agreement; real prices live at the affiliate link).
 * Runs defensively just before every KV write so even if Kimi hallucinates
 * a price past the prompt rules, it can't reach production.
 *
 * Matches: `$19`, `$19.99`, `$1,499`, `$ 19`, "19 dollars", "USD 19".
 * Returns `{ cleaned, stripped }` where `stripped[]` is the removed text
 * so the caller can log a warning for visibility without failing the write.
 *
 * `preservePrices` is an optional whitelist (typically the keyword's own
 * price tier from `extractKeywordPriceTokens`) — matches that exactly equal
 * a whitelisted token are left in place. Stops "best ... under $200"
 * keywords from having `$200` ripped out of their title/H1/meta.
 */
export function stripPricesFromHtml(
  html: string,
  preservePrices: string[] = []
): {
  cleaned: string;
  stripped: string[];
} {
  const preserveSet = new Set(
    preservePrices.map((s) => s.trim().toLowerCase())
  );
  const stripped: string[] = [];
  let cleaned = html;
  for (const re of PRICE_PATTERNS) {
    cleaned = cleaned.replace(re, (match) => {
      if (preserveSet.has(match.trim().toLowerCase())) return match;
      stripped.push(match);
      return "";
    });
  }
  // Clean up orphan punctuation/whitespace left behind (e.g. "costs  ,"
  // or "ranges from  to  ").
  if (stripped.length > 0) {
    cleaned = cleaned
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;:])/g, "$1")
      .replace(/\(\s*\)/g, "")
      .replace(
        /(?:ranges? (?:from|between)|typically (?:costs?|runs?|priced at))\s*(?:to\s*)?[,.]?/gi,
        ""
      )
      .replace(/\s{2,}/g, " ");
  }
  return { cleaned, stripped };
}

/**
 * JSON field-name tokens that should never appear verbatim in rendered page
 * text. Used both here (publish-gate) and in writer.ts (pre-publish sanitizer)
 * so that both checks always agree on the same set of markers.
 *
 * Covers every top-level `ArticleData` prose field so that a partial schema
 * leak (e.g. Kimi truncates mid-JSON and only `"title":"…` and
 * `"introduction":"…` escape into rendered text) is still caught even when
 * none of the other markers are present.
 */
export const SCHEMA_FIELD_MARKERS = [
  '"title":"',
  '"quickAnswer":"',
  '"metaDescription":"',
  '"introduction":"',
  '"conclusion":"',
  '"keyTakeaways":[',
  '"sections":[{',
  '"faqs":[{',
  '"pickReasons":[{',
  '"whyTrustUs":"'
] as const;

/**
 * Whitespace-tolerant regex form of `SCHEMA_FIELD_MARKERS`. The literal
 * markers only match Kimi's compact JSON (`"quickAnswer":"…`); on
 * 2026-06-11 a leak shipped to production in pretty-printed form
 * (`"quickAnswer": "A natural cat…`, space after the colon) and slipped
 * past BOTH the per-field sanitizer and the Step 14 publish gate because
 * both matched the compact literals only. These patterns allow optional
 * whitespace (including newlines) around the colon and before the
 * opening quote/bracket.
 */
export const SCHEMA_FIELD_MARKER_PATTERNS: readonly RegExp[] =
  SCHEMA_FIELD_MARKERS.map((marker) => {
    const m = marker.match(/^"([A-Za-z]+)":(.*)$/);
    // marker is one of the literals above, so the match always succeeds;
    // the fallback keeps TypeScript happy without a non-null assertion.
    const field = m ? m[1] : marker;
    const tail = m ? m[2] : "";
    const tailPattern =
      tail === '"' ? '\\s*"' : tail === "[" ? "\\s*\\[" : "\\s*\\[\\s*\\{"; // "[{"
    return new RegExp(`"${field}"\\s*:${tailPattern}`);
  });

/**
 * Detects when the Kimi K2.5 JSON schema has leaked into the visible body.
 *
 * Background: the writer expects structured JSON and renders fields into
 * prose. When the model occasionally emits a stringified copy of the whole
 * payload into a `sections[].content` value (or truncates mid-object into
 * `quickAnswer`), that raw string is embedded directly in the HTML (without
 * HTML-escaping) — so the rendered page contains visible `{"key":"value"}`.
 *
 * Strategy: strip `<script>` blocks first (legitimate JSON-LD lives there
 * and must not trip the check), strip `<style>` blocks (the large inline
 * stylesheet generated by `buildArticleHtml` must not contribute text to
 * the scan), strip all remaining HTML tags, then scan the visible text for
 * characteristic schema-field markers. Two or more matches is unambiguous —
 * these exact tokens don't occur in clean prose.
 */
export function detectJsonSchemaLeak(html: string): {
  leaked: boolean;
  markers: string[];
} {
  const withoutNonBody = html
    .replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  // Strip HTML tags to get visible text, then decode any HTML entities so
  // that markers such as `"quickAnswer":"` are detected even if the content
  // was HTML-escaped before being embedded (e.g. FAQ answers rendered via
  // escapeHtml). The primary leak paths (section.content, quickAnswer, etc.)
  // are embedded verbatim without escaping, so both cases are handled.
  const visible = unescapeHtml(stripHtmlTags(withoutNonBody));
  // Whitespace-tolerant matching — see SCHEMA_FIELD_MARKER_PATTERNS for
  // the 2026-06-11 pretty-printed-leak incident this guards against.
  const markers: string[] = [];
  for (const re of SCHEMA_FIELD_MARKER_PATTERNS) {
    const m = visible.match(re);
    if (m) markers.push(m[0]);
  }
  return { leaked: markers.length >= 2, markers };
}

// ── Main HTML Builder ──────────────────────────────────────────────────────────

/**
 * Assemble a complete, publication-ready HTML string for a cat-product article.
 *
 * Generates the full `<!DOCTYPE html>` document that is written verbatim to
 * Cloudflare KV and served to readers. Includes:
 *   - `<head>` with title, meta description, canonical URL, Open Graph tags,
 *     Twitter card tags, and `<link rel="preconnect">` hints.
 *   - JSON-LD structured data: `Article`, `FAQPage` (when FAQs present),
 *     and `BreadcrumbList`.
 *   - Hero image (from the first product's image when no explicit
 *     `heroImageUrl` is provided) and an optional YouTube embed.
 *   - Amazon product cards with affiliate tag baked into every ASIN link.
 *   - Internal and external contextual links woven into the body.
 *   - Inline CSS for the full article layout (no external stylesheet dependency).
 *
 * **Caller responsibilities** — this function does NOT:
 *   - Strip Amazon prices from the generated HTML. Call
 *     `stripPricesFromHtml(html, keywordPriceTokens)` on the result before
 *     writing to KV (see `writer.ts` Step 11 publish gate).
 *   - Detect structured-data leaks. Call `detectJsonSchemaLeak(html)` on
 *     the result before publishing (see `writer.ts` Step 11 publish gate).
 *
 * @returns Complete `<!DOCTYPE html>` string, UTF-8, no trailing newline.
 */
export function buildArticleHtml(opts: BuildHtmlOpts): string {
  const {
    article,
    slug,
    keyword,
    categorySlug,
    categoryName,
    domain,
    tag,
    products,
    heroImageUrl,
    videoId,
    videoTitle,
    videoChannel,
    internalLinks,
    externalLinks
  } = opts;

  const dateNow = new Date().toISOString().split("T")[0];
  const dateFormatted = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const currentYear = new Date().getFullYear();
  const basePath = `/${categorySlug}`;
  const canonicalUrl = `https://${domain}${basePath}/${slug}`;

  const trimmedHeroImageUrl = heroImageUrl?.trim() ?? "";
  const firstProductOgImageUrl =
    products
      .find((p) => {
        const u = p.imageUrl?.trim();
        return Boolean(u && /^https?:\/\//i.test(u));
      })
      ?.imageUrl?.trim() ?? null;
  // YouTube thumbnails are last-resort only. They render with the giant
  // red play-button overlay in social previews, which looks like spam —
  // a product photo is always a better social card. Order: editor-picked
  // hero → first product image → YouTube fallback → site logo.
  const youtubeSocialThumbUrl =
    videoId && !trimmedHeroImageUrl && !firstProductOgImageUrl
      ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
      : null;
  const openGraphImageUrl =
    trimmedHeroImageUrl ||
    firstProductOgImageUrl ||
    youtubeSocialThumbUrl ||
    `https://${domain}/logo.png`;
  // Open Graph image dimensions: Facebook + X both recommend 1200×630
  // (1.91:1) for `summary_large_image` cards. YouTube hqdefault thumbs
  // are physically 480×360 and we ship their real size so cards don't
  // render letterboxed. For every other source (hero, product, logo) we
  // claim 1200×630 — most pre-prepared OG images, hero crops, and the
  // logo target this aspect; real product photos will be re-cropped by
  // the social crawler. Wrong dimensions would tank card rendering.
  const isYoutubeOgImage =
    !!youtubeSocialThumbUrl && openGraphImageUrl === youtubeSocialThumbUrl;
  const ogImageWidth = isYoutubeOgImage ? "480" : "1200";
  const ogImageHeight = isYoutubeOgImage ? "360" : "630";
  // og:image:alt and twitter:image:alt: required by Twitter Card validator
  // for accessibility; Facebook honors it as a fallback caption. Article
  // title is the most descriptive, keyword-rich text available here.
  const ogImageAlt = article.title;

  // ── JSON-LD Schemas ────────────────────────────────────────────────────────

  const faqSchema =
    article.faqs && article.faqs.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: article.faqs.slice(0, 10).map((faq) => ({
            "@type": "Question",
            name: faq.question,
            acceptedAnswer: {
              "@type": "Answer",
              text: stripHtmlTags(faq.answer)
            }
          }))
        }
      : null;

  // FIX B: Author entity with sameAs links for E-E-A-T Knowledge Graph verification.
  // Google cross-references these URLs to confirm the author is a real expert.
  const authorEntity = {
    "@type": "Person",
    "@id": "https://catsluvus.com/author/amelia-hartwell#author",
    name: "Amelia Hartwell",
    url: "https://catsluvus.com/author/amelia-hartwell/",
    jobTitle: "Cat Care Specialist",
    description:
      "Certified Feline Behavior Consultant with 15+ years at Cats Luv Us Boarding Hotel",
    image: "https://catsluvus.com/img/authors/amelia-hartwell.webp",
    // sameAs lets Google link the author entity to authoritative third-party profiles
    sameAs: [
      "https://www.linkedin.com/in/amelia-hartwell-catsluvus/",
      "https://www.yelp.com/biz/cats-luv-us-boarding-hotel-laguna-niguel",
      "https://www.google.com/maps/place/Cats+Luv+Us+Boarding+Hotel",
      "https://catsluvus.com/author/amelia-hartwell/"
    ],
    knowsAbout: [
      "Cat Care",
      "Feline Behavior",
      "Cat Nutrition",
      "Pet Boarding",
      "Cat Grooming"
    ],
    worksFor: {
      "@type": "Organization",
      name: "Cats Luv Us Boarding Hotel & Grooming",
      address: {
        "@type": "PostalAddress",
        streetAddress: "27601 Forbes Rd #25",
        addressLocality: "Laguna Niguel",
        addressRegion: "CA",
        postalCode: "92677"
      }
    }
  };

  // FIX A: Article schema with wordCount, inLanguage, and speakableSpecification.
  // speakable tells Google which page sections are suitable for voice/AI Overview responses.
  //
  // wordCount is COMPUTED from the assembled prose fields, never trusted
  // from the model: article.wordCount is Kimi's self-reported number from
  // before section expansion, and shipped ~900 words low (2584 vs ~3490)
  // in the schema on 2026-06-11.
  const computedSchemaWordCount = [
    article.introduction,
    article.quickAnswer,
    ...(article.keyTakeaways ?? []),
    ...(article.sections ?? []).flatMap((s) => [s.heading, s.content]),
    article.whyTrustUs,
    ...(article.faqs ?? []).flatMap((f) => [f.question, f.answer]),
    article.conclusion
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.metaDescription,
    datePublished: dateNow,
    dateModified: dateNow,
    inLanguage: "en-US",
    ...(computedSchemaWordCount > 0
      ? { wordCount: computedSchemaWordCount }
      : {}),
    image: openGraphImageUrl,
    // mainEntityOfPage = pointer to the page this Article describes
    // (the URL string). ALWAYS emit it — earlier code only emitted it
    // when no FAQs were present, leaving FAQ-bearing articles without
    // the URL pointer.
    mainEntityOfPage: canonicalUrl,
    // mainEntity links Article → FAQPage when FAQs exist; this is
    // Google's documented rich-result stacking pattern.
    ...(article.faqs && article.faqs.length > 0
      ? {
          mainEntity: {
            "@type": "FAQPage",
            mainEntity: article.faqs.map((faq) => ({
              "@type": "Question",
              name: faq.question,
              acceptedAnswer: {
                "@type": "Answer",
                text: faq.answer
              }
            }))
          }
        }
      : {}),
    // FIX A: Speakable — points Google at the quick-answer and faq sections
    speakable: {
      "@type": "SpeakableSpecification",
      cssSelector: ["#quick-answer", "#faq-section"]
    },
    author: authorEntity,
    publisher: {
      "@type": "Organization",
      name: "CatsLuvUs",
      url: `https://${domain}`,
      sameAs: [
        "https://www.facebook.com/catsluvus",
        "https://www.instagram.com/catsluvus/",
        "https://www.yelp.com/biz/cats-luv-us-boarding-hotel-laguna-niguel"
      ],
      logo: {
        "@type": "ImageObject",
        url: `https://${domain}/logo.png`
      }
    }
  };

  // HowTo schema — emitted only when the keyword is step-by-step
  // (starts with "how to", "how do", "how can", "how should", "how
  // long"). Direct Google rich-result win: the SERP card expands to
  // include numbered step previews, identical SERP real-estate lever
  // as FAQPage (PR #4978).
  const howToSchema = buildHowToSchema(article, keyword, canonicalUrl);

  const videoSchema =
    videoId && videoTitle
      ? {
          "@context": "https://schema.org",
          "@type": "VideoObject",
          name: videoTitle,
          description: `Video about ${keyword}`,
          thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          uploadDate: dateNow,
          contentUrl: `https://www.youtube.com/watch?v=${videoId}`,
          embedUrl: `https://www.youtube.com/embed/${videoId}`
        }
      : null;

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: `https://${domain}`
      },
      {
        "@type": "ListItem",
        position: 2,
        name: categoryName,
        item: `https://${domain}${basePath}`
      },
      {
        "@type": "ListItem",
        position: 3,
        name: article.title,
        item: canonicalUrl
      }
    ]
  };

  const localBusinessSchema = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: "Cats Luv Us Boarding Hotel & Grooming",
    telephone: "+1-949-582-1732",
    url: "https://catsluvus.com",
    image: "https://catsluvus.com/logo.png",
    priceRange: "$$",
    address: {
      "@type": "PostalAddress",
      streetAddress: "27601 Forbes Rd #25",
      addressLocality: "Laguna Niguel",
      addressRegion: "CA",
      postalCode: "92677",
      addressCountry: "US"
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: 33.5225,
      longitude: -117.7058
    },
    openingHoursSpecification: [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        opens: "08:00",
        closes: "18:00"
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Saturday", "Sunday"],
        opens: "08:00",
        closes: "17:00"
      }
    ]
  };

  // Product schema from real Amazon data
  let productSchema: object | null = null;
  if (products.length > 0) {
    // Strip a leading "best " from the keyword before prepending "Best " so we
    // don't emit "Best best cat window hammocks..." into JSON-LD ItemList.name
    // — Schema.org markup is crawler-visible and a doubled "Best best" is a
    // rich-results red flag. The user-facing title/H1 already handles this via
    // title-casing; this brings the structured-data label into line.
    const itemListKeyword = keyword.replace(/^best\s+/i, "");
    productSchema = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: `Best ${itemListKeyword} Comparison`,
      description: `Comparison of top ${itemListKeyword} products with real Amazon prices and ratings`,
      itemListElement: products.slice(0, 5).map((p, idx) => ({
        "@type": "ListItem",
        position: idx + 1,
        item: {
          "@type": "Product",
          name: p.name,
          ...(p.rating
            ? {
                aggregateRating: {
                  "@type": "AggregateRating",
                  ratingValue: p.rating,
                  bestRating: 5
                }
              }
            : {}),
          // No `offers` block — Amazon Associates compliance forbids
          // displayed prices, and emitting a stripped/stale price into
          // schema.org markup is worse than emitting nothing.
          ...(p.asin
            ? {
                url: `https://www.amazon.com/dp/${p.asin}?tag=${tag}`
              }
            : {})
        }
      }))
    };
  }

  // ── Comparison Table (Our Top Picks) ───────────────────────────────────────

  // Index reasoning by ASIN for O(1) lookup during the pick render loop.
  const reasoningByAsin = new Map<string, PickReasoning>();
  for (const r of article.pickReasons || []) {
    if (r.asin) reasoningByAsin.set(r.asin, r);
  }

  let comparisonTableHtml = "";
  if (products.length > 0) {
    const pickItems = products
      .slice(0, 5)
      .map((product, idx) => {
        let productName = product.name;
        if (productName.length > 80) {
          const byIdx = productName.indexOf(" by ");
          productName =
            byIdx > 20
              ? productName.substring(0, byIdx)
              : productName.substring(0, 80).replace(/\s+\S*$/, "...");
        }

        const ratingNum = Math.min(parseFloat(product.rating || "0") || 0, 5);
        const fullStars = Math.floor(ratingNum);
        const hasHalfStar = ratingNum % 1 >= 0.5;
        const emptyStars = Math.max(0, 5 - fullStars - (hasHalfStar ? 1 : 0));
        const starsHtml =
          "\u2605".repeat(fullStars) +
          (hasHalfStar ? "\u00BD" : "") +
          "\u2606".repeat(emptyStars);

        const ratingHtml =
          ratingNum > 0
            ? `<span class="pick-rating"><span class="stars">${starsHtml}</span> ${product.rating}</span>`
            : "";

        // Prices are intentionally NOT rendered. Amazon Associates policy:
        // scraped / stale prices violate the Operating Agreement, and our
        // editorial stance is "let Amazon show the current price at the
        // affiliate link." Product data still carries price internally
        // for pick-ordering, but nothing reaches the reader.
        const priceHtml = "";

        let amazonUrl: string;
        if (product.asin) {
          amazonUrl = `https://www.amazon.com/dp/${product.asin}?tag=${tag}`;
        } else {
          const searchTerm = encodeURIComponent(
            product.name
              .replace(/[^a-zA-Z0-9\s]/g, "")
              .split(" ")
              .slice(0, 5)
              .join(" ")
          );
          amazonUrl = `https://www.amazon.com/s?k=${searchTerm}&tag=${tag}`;
        }
        const amazonBtnHtml = `<a href="${amazonUrl}" target="_blank" rel="nofollow sponsored" class="amazon-btn">View on Amazon</a>`;

        // When an Amazon image URL is available, stack a clickable
        // image above the button in a CTA column. Both anchors share
        // `amazonUrl` so the affiliate tag cannot drift between them.
        // Missing imageUrl → emit the button alone, byte-identical to
        // the prior render. The #1 pick's image additionally carries the
        // "Cats Luv Us Best Pick" award seal (deliberately year-free) —
        // it lives INSIDE the anchor, so the award itself is a purchase
        // link like the rest of the card.
        let ctaHtml: string;
        if (product.imageUrl) {
          const safeAlt = escapeHtml(productName);
          const awardHtml =
            idx === 0
              ? `<span class="pick-award" aria-hidden="true">${PICK_AWARD_BADGE_SVG}</span>`
              : "";
          const imageLinkHtml =
            `<a href="${amazonUrl}" target="_blank" rel="nofollow sponsored" ` +
            `class="pick-image-link" aria-label="View ${safeAlt} on Amazon" tabindex="-1">` +
            `<img class="pick-image" src="${escapeHtml(product.imageUrl)}" alt="${safeAlt}" ` +
            `width="${PICK_IMAGE_SIZE_PX}" height="${PICK_IMAGE_SIZE_PX}" loading="lazy" decoding="async">` +
            awardHtml +
            `</a>`;
          ctaHtml = `<div class="pick-cta">${imageLinkHtml}${amazonBtnHtml}</div>`;
        } else {
          ctaHtml = amazonBtnHtml;
        }

        // Editorial reasoning — the 2-3 sentence "Why we picked this"
        // block that turns a product listing into editorial content.
        // Matched to the product by ASIN; absent entries use a fallback.
        const reasoning = product.asin
          ? reasoningByAsin.get(product.asin)
          : undefined;
        // Always guarantee the canonical "Why we like this pick:" marker
        // is present — Kimi-degraded responses frequently omit sentence 3
        // OR return pickReasons with non-matching ASINs so `reasoning` is
        // undefined here. In both cases ensureWhyWeLikeMarker returns a
        // single-sentence templated fallback. When the marker is already
        // present it is a pure no-op. This closes the `missing-why-we-
        // like-blurb` defect class at render time regardless of whether
        // Kimi's upstream response contained pickReasons entries.
        // See helper docstring + Step 14.5 detector in writer.ts:2169.
        // Kimi's pickReasons sometimes chain clauses with "→" arrows,
        // which reads as machine output in editorial prose. Convert to
        // natural connectors before rendering.
        const proseReasoning = (reasoning?.reasoning ?? "")
          .replace(/\s*(?:→|-{1,2}>)\s*/g, ", ")
          .replace(/,\s*,/g, ", ");
        const completedReasoning = ensureWhyWeLikeMarker(proseReasoning, {
          label: reasoning?.label,
          productName: product.displayName,
          keyword
        });
        const reasoningHtml =
          `<div class="pick-reasoning">` +
          (reasoning?.label
            ? `<span class="pick-label">${escapeHtml(reasoning.label)}</span> `
            : "") +
          `<span class="pick-reasoning-text">${escapeHtml(completedReasoning)}</span>` +
          `</div>`;

        return (
          `<li class="top-pick-item">` +
          `<span class="pick-rank">${idx + 1}</span>` +
          `<div class="pick-info">` +
          `<p class="pick-name">${escapeHtml(productName)}</p>` +
          `<div class="pick-meta">${ratingHtml}${priceHtml}</div>` +
          reasoningHtml +
          `</div>` +
          ctaHtml +
          `</li>`
        );
      })
      .join("");

    comparisonTableHtml =
      `<div class="top-picks">` +
      `<div class="top-picks-header">` +
      `<span class="picks-icon">\uD83C\uDFC6</span>` +
      `<h2 class="top-picks-title">Our Top Picks</h2>` +
      `</div>` +
      `<ul class="top-picks-list">${pickItems}</ul>` +
      `</div>`;
  }

  // ── Image Hero ─────────────────────────────────────────────────────────────
  // Rendered above the video block when a generated hero exists. Square
  // source (Workers AI flux) is displayed as a wide editorial crop via
  // object-fit. fetchpriority=high: it's the LCP candidate above the fold.

  let imageHeroHtml = "";
  if (trimmedHeroImageUrl) {
    imageHeroHtml = `
      <figure class="article-hero">
        <img src="${escapeHtml(trimmedHeroImageUrl)}" alt="${escapeHtml(article.title)}" width="1024" height="1024" fetchpriority="high" decoding="async">
      </figure>
    `;
  }
  const imageHeroStyle = trimmedHeroImageUrl
    ? `<style>.article-hero{margin:1.25rem 0}.article-hero img{width:100%;height:auto;max-height:430px;object-fit:cover;border-radius:12px;display:block}</style>`
    : "";

  // ── Video Hero ─────────────────────────────────────────────────────────────

  let videoHeroHtml = "";
  if (videoId) {
    const safeTitle = escapeHtml(videoTitle || keyword);
    const safeChannel = escapeHtml(videoChannel || "");
    videoHeroHtml = `
      <section class="video-hero" id="video">
        <div class="video-hero-title">Watch: Expert Guide on ${escapeHtml(keyword)}</div>
        <div class="video-container">
          <lite-youtube videoid="${videoId}" style="background-image: url('https://img.youtube.com/vi/${videoId}/hqdefault.jpg');" title="${safeTitle}"></lite-youtube>
        </div>
        ${safeChannel ? `<div class="video-hero-meta"><strong>${safeChannel}</strong></div>` : ""}
        <div class="video-hero-cta">Continue reading below for our complete written guide with pricing, comparisons, and FAQs.</div>
      </section>
    `;
  }

  // ── Lite YouTube CSS + JS ──────────────────────────────────────────────────

  const liteYoutubeStyle = videoId
    ? `<style>lite-youtube{display:block;position:relative;width:100%;padding-bottom:56.25%;background-size:cover;background-position:center;cursor:pointer;border-radius:8px}lite-youtube::before{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:68px;height:48px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 68 48'%3E%3Cpath fill='%23f00' d='M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z'/%3E%3Cpath fill='%23fff' d='M45 24L27 14v20z'/%3E%3C/svg%3E") center/contain no-repeat}lite-youtube:hover::before{filter:brightness(1.1)}</style>`
    : "";
  const liteYoutubeScript = videoId
    ? `<script>window.addEventListener('load',function(){document.addEventListener('click',function(e){var t=e.target.closest('lite-youtube');if(t){var v=t.getAttribute('videoid');t.outerHTML='<div style="position:relative;padding-bottom:56.25%;height:0"><iframe src="https://www.youtube.com/embed/'+v+'?autoplay=1&rel=0" frameborder="0" allow="autoplay;encrypted-media;picture-in-picture" allowfullscreen title="YouTube video player" style="position:absolute;top:0;left:0;width:100%;height:100%;border-radius:8px"></iframe></div>'}})});</script>`
    : "";

  // ── Why Trust Us ───────────────────────────────────────────────────────────

  const whyTrustUsHtml = article.whyTrustUs
    ? `
    <section class="wc-trust-box">
      <div class="wc-trust-icon">&#128300;</div>
      <div class="wc-trust-content">
        <h2>Why You Should Trust Us</h2>
        <p>${article.whyTrustUs}</p>
      </div>
    </section>
  `
    : "";

  // ── How We Picked / Our Editorial Approach — honest methodology ─────────────
  // Wirecutter guides always name their methodology. We don't physically
  // test products, so the section says exactly what we DO do: compare
  // manufacturer specs, synthesize customer review signal, score on a
  // fixed rubric. Two variants:
  //   - WITH products: "How We Picked" — criteria used to rank specific
  //     products shown in Top Picks above.
  //   - WITHOUT products: "Our Editorial Approach" — same honesty about
  //     the editorial process, without implying we ranked products we
  //     don't actually have data for.
  // Either way the section prevents the "personal anecdotes" SEO check
  // from tricking the writer into fabricating hands-on claims.
  const howWeTestedHtml =
    products.length > 0
      ? `
    <section class="wc-methodology" style="margin:32px 0;padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:8px">
      <h2 style="margin:0 0 12px;font-size:22px">How We Picked</h2>
      <p style="margin:0 0 12px;color:#374151">
        We compared ${products.length} ${keyword}${/s$/i.test(keyword) ? "" : " products"} sold on Amazon. For each pick we weighed:
      </p>
      <ul style="margin:0 0 12px 20px;color:#374151;line-height:1.6">
        <li><strong>Manufacturer specifications</strong> — dimensions, materials, and stated durability from the listing page.</li>
        <li><strong>Customer review signal</strong> — average rating, review count, and patterns in recent 1-star and 5-star reviews.</li>
        <li><strong>Value</strong> — price relative to comparable products with similar specs and review quality.</li>
        <li><strong>Use case fit</strong> — whether the product genuinely solves the scenario in the article's title (travel, apartment living, multi-cat households, etc.).</li>
      </ul>
      <p style="margin:0;color:#6b7280;font-size:14px;font-style:italic">
        Picks are synthesized from public product data and review aggregates, cross-referenced with the Cats Luv Us team's experience caring for boarding cats at our Laguna Niguel facility. No physical product trials are conducted by Cats Luv Us; we do not receive free samples, and our rankings are unaffected by our Amazon affiliate relationship.
      </p>
    </section>
  `
      : `
    <section class="wc-methodology" style="margin:32px 0;padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:8px">
      <h2 style="margin:0 0 12px;font-size:22px">Our Editorial Approach</h2>
      <p style="margin:0 0 12px;color:#374151">
        This guide is a decision framework, not a ranked product list. We didn't find a large-enough pool of well-reviewed products matching "${escapeHtml(keyword)}" to rank specific picks without stretching the data. Instead, we wrote what we'd tell a friend asking the same question:
      </p>
      <ul style="margin:0 0 12px 20px;color:#374151;line-height:1.6">
        <li><strong>What to actually look for</strong> — the three or four criteria that matter once you filter out marketing fluff.</li>
        <li><strong>Where cheap options fail</strong> — the failure modes we see most often at our Laguna Niguel facility.</li>
        <li><strong>When to spend more</strong> — the upgrade thresholds worth paying for, and the ones that aren't.</li>
      </ul>
      <p style="margin:0;color:#6b7280;font-size:14px;font-style:italic">
        When we have enough vetted product data to rank specific picks we add a "Top Picks" section at the top of the guide. This one doesn't have that section on purpose — we don't rank products we haven't verified. If you want a recommendation, email the Cats Luv Us team directly.
      </p>
    </section>
  `;

  // ── Table of Contents ──────────────────────────────────────────────────────

  let tocHtml = "";
  if (article.sections && article.sections.length > 1) {
    const tocItems = article.sections
      .map(
        (section, index) =>
          `<li><a href="#section-${index + 1}">${escapeHtml(section.heading)}</a></li>`
      )
      .join("");
    tocHtml = `
      <nav class="toc" aria-label="Table of Contents">
        <strong>In This Article</strong>
        <ol>
          ${tocItems}
          ${article.faqs && article.faqs.length > 0 ? '<li><a href="#faq-section">Frequently Asked Questions</a></li>' : ""}
        </ol>
      </nav>
    `;
  }

  // ── Sections HTML ──────────────────────────────────────────────────────────

  let sectionsHtml = "";
  if (article.sections && Array.isArray(article.sections)) {
    // Drop any Kimi-generated section whose heading collides with the
    // canonical `Our Top Picks` block rendered separately above (line
    // 682). Without this filter the article ships with two H2s — the
    // template's "Our Top Picks" + a Kimi "Top Picks" — which the
    // `duplicate-top-picks-headings` detector catches at publish time.
    // Fixing it here at the source eliminates the defect for new
    // articles; the detector remains as a regression guard.
    const filteredSections = article.sections.filter(
      (section) => !isExcludedFromRenderedSections(section.heading)
    );
    sectionsHtml = filteredSections
      .map(
        (section, index) => `
        <section id="section-${index + 1}">
          <h2>${escapeHtml(section.heading)}</h2>
          ${section.content}
        </section>
      `
      )
      .join("");
  }

  // ── FAQ HTML ───────────────────────────────────────────────────────────────

  let faqHtml = "";
  if (article.faqs && article.faqs.length > 0) {
    faqHtml = `
      <section class="faqs" id="faq-section">
        <h2>Frequently Asked Questions About ${escapeHtml(keyword)}</h2>
        ${article.faqs
          .map(
            (faq) => `
          <div class="faq-item">
            <h3>${escapeHtml(faq.question)}</h3>
            <p>${escapeHtml(stripHtmlTags(faq.answer))}</p>
          </div>
        `
          )
          .join("")}
      </section>
    `;
  }

  // Hero image removed — Our Top Picks above the fold is better UX
  const heroImageHtml = "";

  // ── Trusted Sources ────────────────────────────────────────────────────────

  const universalLinks = [
    {
      url: "https://www.aspca.org/pet-care/cat-care",
      text: "ASPCA Cat Care Guide"
    },
    {
      url: "https://www.vet.cornell.edu/departments-centers-and-institutes/cornell-feline-health-center",
      text: "Cornell Feline Health Center"
    },
    { url: "https://icatcare.org/", text: "International Cat Care" }
  ];

  const sourceLinks =
    externalLinks && externalLinks.length > 0 ? externalLinks : universalLinks;
  const trustedSourcesHtml = `
    <section class="trusted-sources">
      <h2>Trusted Sources &amp; References</h2>
      <ul>
        ${sourceLinks
          .slice(0, 5)
          .map(
            (link) =>
              `<li><a href="${link.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.text)}</a></li>`
          )
          .join("\n        ")}
      </ul>
    </section>
  `;

  // ── Related Articles (Internal Links) ──────────────────────────────────────

  let relatedArticlesHtml = "";
  if (internalLinks && internalLinks.length > 0) {
    const relatedItems = internalLinks
      .slice(0, 6)
      .map((link) => {
        const fullUrl = link.url.startsWith("http")
          ? link.url
          : `https://${domain}${link.url.startsWith("/") ? "" : "/"}${link.url}`;
        return `<li><a href="${fullUrl}">${escapeHtml(link.text)}</a></li>`;
      })
      .join("\n");

    if (relatedItems) {
      // Heading is "More Guides in This Category" (not "You Might Also
      // Like") because the catsluvus.com front-end injects its own
      // dynamic "You Might Also Like" loader lower on the page.
      // Using the same H2 twice produces duplicate headings that
      // Llava design-audit correctly flags as structural noise.
      relatedArticlesHtml = `
        <section class="related-guides" style="margin:32px 0;padding:20px 24px;background:#f8f9fa;border-radius:8px;border-top:3px solid var(--wc-color-primary,#0277BD)">
          <h2 style="font-size:16px;margin:0 0 12px;color:#333">More Guides in This Category</h2>
          <ul style="list-style:none;padding:0;margin:0;display:grid;gap:8px">${relatedItems}</ul>
        </section>`;
    }
  }

  // ── Full HTML Document ─────────────────────────────────────────────────────

  const assembledHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(article.title)}</title>
<meta name="description" content="${escapeHtml(article.metaDescription)}">
<link rel="canonical" href="${canonicalUrl}">
<meta name="robots" content="index, follow">
<link rel="preconnect" href="https://pub.catsluvus.com" crossorigin>
<link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://www.youtube.com" crossorigin>
<link rel="dns-prefetch" href="https://www.amazon.com">
<link rel="icon" href="https://${domain}/favicon.ico" type="image/x-icon">
<link rel="icon" type="image/png" sizes="192x192" href="https://${domain}/android-chrome-192x192.png">
<link rel="icon" type="image/png" sizes="512x512" href="https://${domain}/android-chrome-512x512.png">
<link rel="apple-touch-icon" sizes="180x180" href="https://${domain}/apple-touch-icon.png">
<link rel="manifest" href="https://${domain}/site.webmanifest">
<link rel="alternate" type="application/rss+xml" title="CatsLuvUs Cat Guides" href="https://${domain}/feed.rss">
<meta property="og:title" content="${escapeHtml(article.title)}">
<meta property="og:description" content="${escapeHtml(article.metaDescription)}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:type" content="article">
<meta property="og:image" content="${openGraphImageUrl}">
<meta property="og:image:width" content="${ogImageWidth}">
<meta property="og:image:height" content="${ogImageHeight}">
<meta property="og:image:alt" content="${escapeHtml(ogImageAlt)}">
<meta property="og:site_name" content="CatsLuvUs">
<meta property="article:published_time" content="${dateNow}">
<meta property="article:modified_time" content="${dateNow}">
<meta property="article:author" content="https://catsluvus.com/author/amelia-hartwell/">
<meta property="article:section" content="${escapeHtml(categoryName)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(article.title)}">
<meta name="twitter:description" content="${escapeHtml(article.metaDescription)}">
<meta name="twitter:image" content="${openGraphImageUrl}">
<meta name="twitter:image:alt" content="${escapeHtml(ogImageAlt)}">
<meta name="twitter:site" content="@catsluvus">
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      articleSchema,
      breadcrumbSchema,
      ...(howToSchema ? [howToSchema] : []),
      ...(faqSchema ? [faqSchema] : []),
      ...(videoSchema ? [videoSchema] : []),
      ...(productSchema ? [productSchema] : []),
      localBusinessSchema
    ]
  })}</script>
${imageHeroStyle}
${liteYoutubeStyle}
<style>
/* CSS Custom Properties */
:root {
  --wc-color-primary: #326891;
  --wc-color-primary-dark: #265073;
  --wc-color-text: #121212;
  --wc-color-text-secondary: #555555;
  --wc-color-border: #e2e2e2;
  --wc-color-bg: #ffffff;
  --wc-color-bg-hover: #f8f8f8;
  --wc-transition-speed: 300ms;
}

/* Reset & Base */
*{box-sizing:border-box;margin:0;padding:0}
html,body{overflow-x:hidden;width:100%;max-width:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.8;color:var(--wc-color-text);background:var(--wc-color-bg)}

/* Skip Link for Accessibility */
.skip-link{position:absolute;top:-40px;left:0;background:#333;color:#fff;padding:8px 16px;text-decoration:none;border-radius:0 0 4px 0;z-index:99999}
.skip-link:focus{top:0}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* Main Content */
main{padding-top:0;overflow-x:hidden}
.container{max-width:720px;margin:0 auto;padding:40px 24px;overflow-wrap:break-word;word-wrap:break-word;overflow-x:hidden}

/* Wirecutter-style Trust Box */
.wc-trust-box{display:flex;gap:16px;background:#f0f7ff;border:1px solid #cce0ff;border-radius:8px;padding:20px 24px;margin:32px 0}
.wc-trust-icon{font-size:2rem;flex-shrink:0}
.wc-trust-content h2{font-size:1.1rem;margin:0 0 8px;border:none;padding:0;color:#1a56db}
.wc-trust-content p{margin:0;font-size:0.95rem;line-height:1.6;color:#333}

/* Typography */
body{font-size:18px;line-height:1.75;letter-spacing:-0.01em}
article{font-size:18px;line-height:1.8;color:#1a1a1a;overflow-wrap:break-word;word-wrap:break-word}
article p{margin-bottom:1.5em;text-align:left;word-spacing:0.05em;overflow-wrap:break-word;hyphens:auto;-webkit-hyphens:auto}
h1{font-size:2rem;margin-bottom:20px;color:var(--wc-color-primary);line-height:1.3;letter-spacing:-0.02em}
h2{font-size:1.4rem;margin:48px 0 24px;border-bottom:2px solid var(--wc-color-border);padding-bottom:12px;line-height:1.4}
h3{font-size:1.15rem;margin:32px 0 16px;line-height:1.4}
p{margin-bottom:1.25em;overflow-wrap:break-word;hyphens:auto;-webkit-hyphens:auto}
ul,ol{margin:1.25em 0 1.5em 1.5em;line-height:1.7}
li{margin-bottom:0.5em;overflow-wrap:break-word}
a{color:var(--wc-color-primary)}

/* Prevent content overflow */
article img,article video,article iframe,article embed,article object{max-width:100%;height:auto;display:block}
article pre,article code{overflow-x:auto;max-width:100%;white-space:pre-wrap;word-wrap:break-word}
a{overflow-wrap:break-word;word-break:break-word}
article *{max-width:100%}

/* Breadcrumb */
.breadcrumb{font-size:14px;margin-bottom:20px;padding-top:4px}
.breadcrumb a{color:#0277BD;text-decoration:none}

/* Article Images */
.article-image{margin:30px 0;text-align:center;position:relative}
.article-image img{max-width:100%;height:auto;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
.article-image figcaption{font-size:14px;color:#666;margin-top:10px;font-style:italic}

/* Author Box */
.author-box{display:flex;gap:12px;padding:14px;background:#f8f9fa;border-radius:8px;margin:24px 0;border-left:4px solid var(--wc-color-primary)}
.author-box img{width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0}
.author-name{margin:0 0 2px;color:var(--wc-color-primary);font-size:11px;font-weight:600}
.author-info .written-by{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#595959;margin:0 0 1px}
.author-info .credentials{font-size:10px;color:#555;margin-bottom:4px}
.author-info .author-bio{font-size:10px;color:#666;line-height:1.4;margin:0}
.author-info .bio{font-size:15px;line-height:1.6}
.author-info .date-info{font-size:13px;color:#595959;margin-top:6px}
.trusted-sources{margin:40px 0;padding:24px;background:#f0f7f4;border-radius:8px;border-left:4px solid #2d6a4f}
.trusted-sources h2{color:#2d6a4f;font-size:20px;margin-bottom:12px;border:none;padding:0}
.trusted-sources ul{list-style:none;padding:0;margin:0}
.trusted-sources li{padding:6px 0}
.trusted-sources a{color:#2d6a4f;text-decoration:underline;font-weight:500}

/* Quick Answer Box */
.quick-answer{background:#fff3cd;border:2px solid #ffc107;border-radius:8px;padding:20px 25px;margin:20px 0 30px 0;font-size:1.1em;line-height:1.7}
.quick-answer strong{color:#856404;display:block;margin-bottom:8px;font-size:0.95em;text-transform:uppercase;letter-spacing:0.5px}

/* Key Takeaways */
.key-takeaways{background:linear-gradient(135deg,#e8f4f8 0%,#d4e8ed 100%);border-left:4px solid var(--wc-color-primary);padding:20px 25px;border-radius:0 8px 8px 0;margin:30px 0}
.key-takeaways h2,.key-takeaways strong{font-size:1.2rem;margin:0 0 15px 0;color:var(--wc-color-primary)}
.key-takeaways ul{margin:0;padding-left:20px}
.key-takeaways li{margin:8px 0;line-height:1.6}

/* Our Top Picks - Wirecutter Style */
.top-picks{margin:32px 0;border:2px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff}
.top-picks-header{background:linear-gradient(135deg,#1a365d 0%,#2d3748 100%);padding:16px 24px;display:flex;align-items:center;gap:10px}
.top-picks-header h2.top-picks-title,.top-picks-header h3{margin:0;color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.3px;border:none;padding:0}
.top-picks-header .picks-icon{font-size:22px}
.top-picks-list{padding:0;margin:0;list-style:none}
.top-pick-item{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid #e2e8f0;gap:16px;transition:background 0.2s ease}
.top-pick-item:last-child{border-bottom:none}
.top-pick-item:hover{background:#f7fafc}
.pick-rank{flex-shrink:0;width:32px;height:32px;background:#edf2f7;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#2d3748}
.pick-info{flex:1;min-width:0}
.pick-name{font-weight:700;font-size:15px;color:#1a202c;margin:0 0 4px 0;line-height:1.3;overflow-wrap:break-word;word-break:break-word}
.pick-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.pick-reasoning{margin:8px 0 0;font-size:14px;color:#374151;line-height:1.5}
.pick-label{display:inline-block;padding:2px 8px;margin-right:6px;background:#f0c040;color:#111;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.3px}
.pick-reasoning-text{color:#4a5568}
.pick-rating{display:inline-flex;align-items:center;gap:4px;font-size:13px;color:#92400e;font-weight:600}
.pick-rating .stars{color:#92400e}
.pick-features{font-size:13px;color:#4a5568}
.amazon-btn{display:inline-flex;align-items:center;padding:8px 16px;background:#f0c040;color:#111;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px;white-space:nowrap;word-break:normal;overflow-wrap:normal;flex-shrink:0;transition:background 0.2s}
.amazon-btn:hover{background:#e6b020}
.pick-cta{flex-shrink:0;display:flex;flex-direction:column;align-items:stretch;gap:10px;max-width:140px}
.pick-image-link{display:block;line-height:0;border-radius:6px;position:relative}
.pick-award{position:absolute;top:-10px;left:-10px;width:54px;height:54px;line-height:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3));pointer-events:none}
.pick-award svg{width:100%;height:100%;display:block}
.pick-image{width:${PICK_IMAGE_SIZE_PX}px;height:${PICK_IMAGE_SIZE_PX}px;object-fit:contain;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:4px;display:block}
.pick-image-link:hover .pick-image{border-color:#cbd5e0}

/* FAQ Section */
.faqs{background:#f8f8f8;padding:24px;border-radius:8px;margin:40px 0}
.faqs h2{border:none;padding:0;margin:0 0 16px}
.faq-item{margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--wc-color-border)}
.faq-item:last-child{margin-bottom:0;padding-bottom:0;border-bottom:none}
.faq-item h3{color:var(--wc-color-primary);margin-bottom:8px;margin-top:0}

/* Video Hero Section */
.video-hero{background:#f8f9fa;padding:20px;border-radius:12px;margin:16px 0 24px;box-shadow:0 2px 8px rgba(0,0,0,0.08);border:1px solid #e5e7eb}
.video-hero-title{color:#1a1a2e;font-size:1.1rem;margin:0 0 12px;font-weight:600;display:flex;align-items:center;gap:8px}
.video-hero .video-container{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;margin-bottom:8px;box-shadow:0 4px 20px rgba(0,0,0,0.3)}
.video-hero .video-container iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:none;border-radius:8px}
.video-hero-meta{color:#6b7280;font-size:14px;margin:0;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.video-hero-meta strong{color:#1f2937}
.video-hero-cta{color:#6b7280;font-size:13px;margin:8px 0 0;font-style:italic}

/* Video Container (fallback) */
.video-container{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:8px;margin-bottom:12px}
.video-container iframe{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:8px}

/* Conclusion */
.conclusion{background:linear-gradient(135deg,#326891,#265073);color:#fff;padding:24px;border-radius:8px;margin:40px 0}
.conclusion h2{color:#fff;border-bottom-color:rgba(255,255,255,0.3)}

/* Affiliate Disclosure */
.affiliate-disclosure{font-size:0.85rem;color:#6b7280;margin:12px 0;padding:10px 14px;background:#f9fafb;border-radius:6px;border:1px solid #e5e7eb}

/* Accessibility Contrast Overrides */
.written-by,.date-info,.date-info time{color:#595959 !important}
.pick-rating,.stars{color:#92400E !important}
.breadcrumb a{color:#0277BD !important}
.pick-features{color:#4A5568 !important}

/* Table of Contents */
.toc{background:#f8f9fa;border:1px solid #e2e8f0;border-radius:8px;padding:20px 24px;margin:24px 0}
.toc strong{display:block;font-size:1.1em;margin-bottom:12px;color:var(--wc-color-primary-dark)}
.toc ol{margin:0;padding-left:20px}
.toc li{margin-bottom:6px;line-height:1.5}
.toc a{color:var(--wc-color-primary);text-decoration:none;border-bottom:1px dotted var(--wc-color-primary)}
.toc a:hover{color:var(--wc-color-primary-dark);border-bottom-style:solid}

/* Accessibility: placeholder contrast fix (WCAG AA 4.5:1 minimum) */
::placeholder{color:#767676 !important}
input::placeholder{color:#767676 !important}

/* Responsive */
@media (max-width:768px){
  body{font-size:17px}
  article{font-size:17px;line-height:1.75}
  h1{font-size:1.6rem}
  h2{font-size:1.25rem;margin:36px 0 18px}
  h3{font-size:1.1rem}
  .container{padding:32px 20px}
  .author-box{flex-direction:column;text-align:center}
  .author-box img{margin:0 auto;width:40px;height:40px}
}
@media (max-width:640px){
  .top-pick-item{flex-wrap:wrap;gap:12px;padding:14px 16px}
  .pick-rank{width:28px;height:28px;font-size:12px}
  .pick-cta{max-width:100px;gap:8px}
  .pick-image{width:90px;height:90px}
  .wc-trust-box{flex-direction:column;gap:8px;padding:16px}
}
@media (max-width:480px){
  body{font-size:16px}
  article{font-size:16px;line-height:1.7}
  h1{font-size:1.4rem}
  .container{padding:24px 16px}
  .key-takeaways{padding:16px 18px}
  .faqs{padding:18px}
  .conclusion{padding:18px}
  .pick-image{width:72px;height:72px}
}

/* Reduced Motion */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:0.01ms !important;transition-duration:0.01ms !important}
}

/* Print */
@media print{
  .hamburger-menu,.nav-menu,.universal-footer,.skip-link{display:none !important}
  body{padding-top:0}
}
</style>
</head>
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>

<main id="main-content">
<div class="container">
<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="https://${domain}">Home</a> &rsaquo;
  <a href="https://${domain}${basePath}">${escapeHtml(categoryName)}</a> &rsaquo;
  ${escapeHtml(article.title)}
</nav>

<article itemscope itemtype="https://schema.org/Article">
  <h1 itemprop="headline">${escapeHtml(article.title)}</h1>

  ${imageHeroHtml}
  ${videoHeroHtml}

  <div class="author-box" itemprop="author" itemscope itemtype="https://schema.org/Person">
    <img src="https://catsluvus.com/img/authors/amelia-hartwell.webp" alt="Amelia Hartwell, Cat Care Specialist" itemprop="image" width="100" height="100" fetchpriority="high" loading="eager">
    <div class="author-info">
      <p class="written-by">Written by Amelia Hartwell &amp; CatGPT</p>
      <p class="credentials" itemprop="jobTitle">Cat Care Specialist | Certified Feline Behavior Consultant</p>
      <p class="bio">With over 15 years caring for cats at Cats Luv Us Boarding Hotel &amp; Grooming in Laguna Niguel, CA, Amelia draws on daily boarding-floor experience with thousands of cats. Product picks in these guides are synthesized from public manufacturer specs and customer review aggregates — no physical product trials are conducted by Cats Luv Us.</p>
      <p class="date-info">Last Updated: <time itemprop="dateModified" datetime="${dateNow}">${dateFormatted}</time></p>
    </div>
  </div>

  <!-- affiliate disclosure injected by Worker HTMLRewriter -->

  ${
    article.quickAnswer
      ? `
    <div id="quick-answer" class="quick-answer" itemprop="description">
      <strong>Quick Answer:</strong> ${article.quickAnswer}
    </div>
  `
      : ""
  }

  ${comparisonTableHtml}

  ${
    article.keyTakeaways && article.keyTakeaways.length > 0
      ? `
    <div class="key-takeaways">
      <strong>Key Takeaways:</strong>
      <ul>
        ${article.keyTakeaways.map((t) => `<li>${t}</li>`).join("")}
      </ul>
    </div>
  `
      : ""
  }

  ${heroImageHtml}

  ${whyTrustUsHtml}

  ${howWeTestedHtml}

  ${tocHtml}

  <div class="introduction" itemprop="articleBody">
    ${article.introduction || ""}
  </div>

  ${sectionsHtml}

  ${faqHtml}

  <section class="conclusion">
    <h2>Conclusion</h2>
    ${article.conclusion || ""}
  </section>

  ${trustedSourcesHtml}

  ${relatedArticlesHtml}
</article>
</div>
</main>
${liteYoutubeScript}
<style id="a11y-overrides">
body .clu-search-form input::placeholder{color:#767676 !important}
body .clu-search-form button svg{fill:#767676 !important}
body .clu-mobile-search input::placeholder{color:#767676 !important}
body .related-articles-error{color:#595959 !important}
body .footer-bottom,body .footer-bottom *{color:#9CA3AF !important}
body .footer-bottom a{color:#9CA3AF !important}
body .clu-infobar-contact a{color:#0277BD !important}
body .footer-section a{color:#b0b0b0 !important}
body .footer-section p{color:#b0b0b0 !important}
body input::placeholder{color:#767676 !important}
body .clu-mobile-menu-header h3{font-size:1.1rem;margin:0}
</style>
<footer style="margin-top:3rem;padding:24px;border-top:2px solid #e5e7eb;text-align:center;font-size:0.85rem;color:#6b7280">
  <p>&copy; ${currentYear} Cats Luv Us Boarding Hotel &amp; Grooming. All rights reserved.</p>
  <p>27601 Forbes Rd #25, Laguna Niguel, CA 92677 | (949) 582-1732</p>
</footer>
</body>
</html>`;

  // Patch the schema wordCount with the FINAL rendered body count. The
  // prose-field sum computed earlier misses ~1,100 words of template
  // content (top-picks blurbs, methodology section, takeaways chrome) —
  // the 2026-06-11 post-deploy audit still measured 2,873 declared vs
  // 4,036 actual. Count what the page actually renders.
  const renderedWordCount = assembledHtml
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return renderedWordCount > 0
    ? assembledHtml.replace(
        /"wordCount":\s*\d+/,
        `"wordCount":${renderedWordCount}`
      )
    : assembledHtml;
}
