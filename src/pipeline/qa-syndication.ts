import { errMsg } from "./http-utils";
import type { SEOArticleAgent } from "../server";
import type { ArticleData } from "./html-builder";
import type { AmazonProduct } from "./amazon";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Structured Q&A payload stored in KV and served via /api/qa/:slug.
 *
 * Designed for maximum legibility by AI answer engines (Perplexity,
 * ChatGPT Browse, Gemini, Copilot) that prefer clean JSON over HTML
 * prose when building citations. Every field is optional except the
 * three required identifiers so degraded articles still produce valid
 * payloads.
 */
export interface QAPayload {
  /** Exact keyword this article targets (e.g. "best automatic cat feeders"). */
  keyword: string;
  /** Canonical public URL of the full article. */
  url: string;
  /** ISO-8601 date the Q&A payload was last generated/updated. */
  lastUpdated: string;
  /** 1-2 sentence direct answer to the primary keyword question. */
  quickAnswer: string;
  /** 3-7 key takeaways from the article as plain-text bullets. */
  keyTakeaways: string[];
  /** All FAQ items extracted from the article. */
  faqs: Array<{ question: string; answer: string }>;
  /** Top product picks with ASIN, name and editorial reason. */
  topProducts: Array<{ asin: string; name: string; reason: string }>;
  /** Article title for context in AI-generated citations. */
  title: string;
  /** Meta description — concise summary for citation snippets. */
  metaDescription: string;
  /** Category slug (e.g. "cat-automatic-feeders"). */
  categorySlug: string;
  /** Article slug (e.g. "best-automatic-cat-feeder-for-wet-food"). */
  slug: string;
  /**
   * Approximate word count of the full article. Lets AI engines
   * signal content depth to users ("based on a 3 200-word guide …").
   */
  wordCount: number;
}

/** KV key prefix used for all Q&A payloads. */
export const QA_KV_PREFIX = "qa:";

/** KV key for the master index of all Q&A slugs. */
export const QA_INDEX_KV_KEY = "qa-index:all";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a QAPayload from the pipeline's ArticleData and product list.
 * Keeps only the fields that are safe and useful for public JSON exposure.
 */
function buildQAPayload(
  article: ArticleData,
  keyword: string,
  url: string,
  categorySlug: string,
  slug: string,
  products: AmazonProduct[]
): QAPayload {
  // Top products: use pick-reasons when available; fall back to product features
  const topProducts = products.slice(0, 5).map((p) => {
    const pickReason = article.pickReasons?.find((r) => r.asin === p.asin);
    return {
      asin: p.asin ?? "",
      name: p.name,
      reason: pickReason?.reasoning ?? p.features?.slice(0, 200) ?? ""
    };
  });

  return {
    keyword,
    url,
    lastUpdated: new Date().toISOString(),
    quickAnswer: article.quickAnswer ?? "",
    keyTakeaways: (article.keyTakeaways ?? []).slice(0, 7),
    faqs: (article.faqs ?? []).map((f) => ({
      question: f.question,
      answer: f.answer
    })),
    topProducts,
    title: article.title ?? "",
    metaDescription: article.metaDescription ?? "",
    categorySlug,
    slug,
    wordCount: article.wordCount ?? 0
  };
}

/**
 * Update the master Q&A index in KV.
 * The index is a JSON array of `{ slug, keyword, url, categorySlug }` objects
 * so AI crawlers can discover all Q&A endpoints from a single URL.
 */
async function updateQAIndex(
  agent: SEOArticleAgent,
  entry: { slug: string; keyword: string; url: string; categorySlug: string }
): Promise<void> {
  try {
    const raw = await agent.envBindings.ARTICLES_KV.get(QA_INDEX_KV_KEY);
    // Two-level guard for the stored index value:
    //   1. Invalid JSON (e.g. truncated KV write) — JSON.parse throws a
    //      SyntaxError. Previously this propagated to the outer catch and
    //      silently dropped the new entry; now we catch it here and reset
    //      to an empty array so the index self-heals on the next publish.
    //   2. Valid JSON that is not an array (e.g. "null", "{}") — handled
    //      by the Array.isArray guard below (falls back to empty array).
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr: unknown) {
        agent.log(
          "warning",
          `QA Syndication: index JSON is malformed — resetting to empty array (${errMsg(parseErr)})`
        );
      }
    }
    const index: Array<{
      slug: string;
      keyword: string;
      url: string;
      categorySlug: string;
    }> = Array.isArray(parsed) ? (parsed as typeof index) : [];

    // Skip if this exact article key is already in the index.
    // Slugs can repeat across categories, so dedup on category+slug.
    if (
      index.some(
        (e) => e.slug === entry.slug && e.categorySlug === entry.categorySlug
      )
    ) {
      agent.log(
        "info",
        `QA Syndication: ${entry.categorySlug}:${entry.slug} already in index — skipping duplicate`
      );
    } else {
      index.push(entry);
      await agent.envBindings.ARTICLES_KV.put(
        QA_INDEX_KV_KEY,
        JSON.stringify(index)
      );
    }
  } catch (err: unknown) {
    agent.log(
      "warning",
      `QA Syndication: index update failed for ${entry.categorySlug}:${entry.slug} — ${errMsg(err)}`
    );
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

export interface QASyndicationResult {
  kvKey: string;
  qaUrl: string;
  faqCount: number;
  productCount: number;
}

/**
 * Step 22/24 — QA Syndication.
 *
 * Writes a clean, machine-readable JSON Q&A payload derived from the
 * published article to KV under the key `qa:{categorySlug}:{slug}`.
 * Also maintains a master index at `qa-index:all` so AI crawlers can
 * discover all endpoints from `/api/qa/`.
 *
 * This data is served publicly (no auth) via two new HTTP endpoints:
 *   GET /api/qa/                 — master index (JSON array)
 *   GET /api/qa/:categorySlug/:slug — per-article Q&A payload (JSON)
 *
 * Non-fatal: errors are logged as warnings; the article publish result
 * is not affected.
 */
export async function runQASyndication(
  agent: SEOArticleAgent,
  article: ArticleData,
  keyword: string,
  url: string,
  categorySlug: string,
  slug: string,
  products: AmazonProduct[]
): Promise<QASyndicationResult | null> {
  try {
    const payload = buildQAPayload(
      article,
      keyword,
      url,
      categorySlug,
      slug,
      products
    );

    const kvKey = `${QA_KV_PREFIX}${categorySlug}:${slug}`;
    const domain = agent.envBindings.DOMAIN || "catsluvus.com";
    const qaUrl = `https://${domain}/api/qa/${categorySlug}/${slug}`;

    await agent.envBindings.ARTICLES_KV.put(kvKey, JSON.stringify(payload), {
      metadata: {
        keyword,
        categorySlug,
        slug,
        faqCount: String(payload.faqs.length),
        lastUpdated: payload.lastUpdated
      }
    });

    await updateQAIndex(agent, { slug, keyword, url, categorySlug });

    agent.log(
      "info",
      `QA Syndication: wrote ${payload.faqs.length} FAQs + ${payload.topProducts.length} products → ${qaUrl}`,
      "operations",
      { kanbanStage: "done" }
    );

    return {
      kvKey,
      qaUrl,
      faqCount: payload.faqs.length,
      productCount: payload.topProducts.length
    };
  } catch (err: unknown) {
    agent.log(
      "warning",
      `QA Syndication failed for ${categorySlug}:${slug} — ${errMsg(err)}`,
      "operations"
    );
    return null;
  }
}
