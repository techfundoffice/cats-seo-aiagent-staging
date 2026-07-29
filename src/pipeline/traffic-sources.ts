import { generateText } from "ai";
import type { SEOArticleAgent } from "../server";
import { errMsg, extractFirstJsonObject, repairJson } from "./http-utils";
import { getKimiModel, getKimiProviderOptions } from "./kimi-model";

/**
 * traffic-sources.ts — fill in EVERY traffic source for a published
 * article, using the minutes the pipeline spends generating the next one.
 *
 * The publish path already fires the machine channels once (sitemap,
 * IndexNow, RSS, WebSub, answer-engine Q&A JSON). What it never did is
 * (a) prove each one actually landed and (b) produce the human channels
 * at all — the article shipped and nothing was ever posted to Pinterest,
 * Reddit, X, Facebook, YouTube, the newsletter, Medium or Quora.
 *
 * This module closes both gaps with a per-article ledger in KV:
 *
 *   traffic-sources:<kvKey>          → ledger { sources: { <id>: entry } }
 *   traffic-source:<id>:<kvKey>      → the artifact for one source
 *
 * Every source is filled independently and retried (up to MAX_ATTEMPTS)
 * on later ticks, so a transient IndexNow 403 or a truncated model
 * response never leaves a channel permanently empty. An article is
 * "complete" only when every source in TRAFFIC_SOURCES has an entry that
 * is `filled` or `skipped`.
 *
 * Two entry points, both non-throwing:
 *   - runTrafficSourceFill(agent, opts) — fill one article's pending
 *     sources. Cron-driven (/api/traffic-sources/fill) and admin-driven.
 *   - backfillTrafficSourcesInBackground(agent, opts) — fire-and-forget
 *     variant kicked off by generateArticle() so the fill runs *while*
 *     the next article is being written.
 *
 * Nothing here auto-posts to a social network: none of these platforms
 * gives this project a posting API, so the artifacts are ready-to-paste
 * copy stored in KV and surfaced over /api/admin/traffic-sources. The
 * machine channels (sitemap/IndexNow/RSS/WebSub/Q&A JSON) DO perform
 * real network + KV work.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type TrafficSourceKind =
  | "search"
  | "answer-engine"
  | "syndication"
  | "social"
  | "community"
  | "owned";

export type TrafficSourceStatus = "filled" | "failed" | "skipped";

export interface TrafficSourceEntry {
  status: TrafficSourceStatus;
  detail: string;
  /** ISO-8601 timestamp of the last attempt. */
  at: string;
  /** Attempt count — retries stop at MAX_ATTEMPTS. */
  attempts: number;
  /** KV key holding the generated artifact, when the source produces one. */
  artifactKey?: string;
}

export interface TrafficSourceLedger {
  kvKey: string;
  url: string;
  keyword: string;
  updatedAt: string;
  sources: Record<string, TrafficSourceEntry>;
}

/** Ready-to-use payload for one human channel. */
export interface TrafficSourceArtifact {
  id: string;
  label: string;
  kind: TrafficSourceKind;
  kvKey: string;
  keyword: string;
  url: string;
  generatedAt: string;
  /** Structured per-channel fields (title, body, tags, …). */
  fields: Record<string, string | string[]>;
  /** The same content flattened into one paste-ready block. */
  postText: string;
}

/** Article content the copy generators draw on. */
export interface ArticleFacts {
  title: string;
  metaDescription: string;
  ogImage: string;
  quickAnswer: string;
  takeaways: string[];
  faqs: Array<{ question: string; answer: string }>;
  products: string[];
}

export interface TrafficSourceFillResult {
  ok: boolean;
  kvKey: string | null;
  filled: number;
  failed: number;
  skipped: number;
  /** Sources still pending on this article after the run. */
  remaining: number;
  detail: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const TRAFFIC_SOURCE_LEDGER_PREFIX = "traffic-sources:";
export const TRAFFIC_SOURCE_ARTIFACT_PREFIX = "traffic-source:";

/** Give up retrying a source after this many attempts. */
export const MAX_ATTEMPTS = 5;

/** Articles inspected per invocation when looking for pending work. */
const CANDIDATE_LIMIT = 12;

const LOCK_KEY = "traffic-sources:lock";
/** KV's minimum expirationTtl is 60s — also a sane single-run bound. */
const LOCK_TTL_S = 60;

const MAX_POST_CHARS = 4_000;

// ── Article facts ──────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Every FAQ pair carried in the page's FAQPage JSON-LD. */
function faqsFromJsonLd(html: string): Array<{
  question: string;
  answer: string;
}> {
  const out: Array<{ question: string; answer: string }> = [];
  const blockRe =
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const stack: unknown[] = [parsed];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      if (!node || typeof node !== "object") continue;
      const rec = node as Record<string, unknown>;
      if (rec["@type"] === "FAQPage" && Array.isArray(rec.mainEntity)) {
        for (const item of rec.mainEntity) {
          if (!item || typeof item !== "object") continue;
          const q = (item as Record<string, unknown>).name;
          const a = (item as Record<string, unknown>).acceptedAnswer;
          const text =
            a && typeof a === "object"
              ? (a as Record<string, unknown>).text
              : undefined;
          if (typeof q === "string" && typeof text === "string") {
            out.push({ question: stripTags(q), answer: stripTags(text) });
          }
        }
      }
      for (const value of Object.values(rec)) {
        if (value && typeof value === "object") stack.push(value);
      }
    }
  }
  // De-dupe: the page nests FAQPage under Article @graph as well, so the
  // same pairs are reachable through two paths.
  const seen = new Set<string>();
  return out.filter((f) => {
    if (seen.has(f.question)) return false;
    seen.add(f.question);
    return true;
  });
}

/**
 * Pull the facts the copy generators need straight out of published HTML.
 * Pure + exported so the extraction rules are unit-testable without KV.
 */
export function extractArticleFacts(html: string): ArticleFacts {
  const title = stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const metaDescription = decodeEntities(
    html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] ?? ""
  );
  const ogImage =
    html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i)?.[1] ?? "";

  const quickAnswer = stripTags(
    html.match(
      /<strong>Quick Answer:<\/strong>([\s\S]*?)<\/(?:p|div|section)>/i
    )?.[1] ?? ""
  );

  const takeawayBlock = html.match(
    /<div class="key-takeaways">([\s\S]*?)<\/div>/i
  )?.[1];
  const takeaways = takeawayBlock
    ? [...takeawayBlock.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((m) => stripTags(m[1]))
        .filter(Boolean)
    : [];

  const products = [
    ...html.matchAll(
      /<(p|h3)[^>]*class="[^"]*\bpick-name\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi
    )
  ]
    .map((m) => stripTags(m[2]))
    .filter(Boolean);

  return {
    title,
    metaDescription,
    ogImage,
    quickAnswer,
    takeaways,
    faqs: faqsFromJsonLd(html),
    products
  };
}

interface QaPayloadShape {
  quickAnswer?: unknown;
  keyTakeaways?: unknown;
  faqs?: unknown;
  topProducts?: unknown;
  title?: unknown;
  metaDescription?: unknown;
}

/**
 * Merge the machine-readable Q&A payload (written by Step 22) over the
 * HTML-derived facts. The payload is the richer source when it exists;
 * the HTML is the fallback for articles published before Step 22 or when
 * the payload write failed.
 */
export function mergeQaPayloadIntoFacts(
  facts: ArticleFacts,
  raw: string | null
): ArticleFacts {
  if (!raw) return facts;
  let parsed: QaPayloadShape;
  try {
    parsed = JSON.parse(raw) as QaPayloadShape;
  } catch {
    return facts;
  }
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const faqs = Array.isArray(parsed.faqs)
    ? parsed.faqs.flatMap((f) => {
        if (!f || typeof f !== "object") return [];
        const q = (f as Record<string, unknown>).question;
        const a = (f as Record<string, unknown>).answer;
        return typeof q === "string" && typeof a === "string"
          ? [{ question: q, answer: a }]
          : [];
      })
    : [];

  const products = Array.isArray(parsed.topProducts)
    ? parsed.topProducts.flatMap((p) => {
        if (!p || typeof p !== "object") return [];
        const name = (p as Record<string, unknown>).name;
        return typeof name === "string" && name.trim() ? [name.trim()] : [];
      })
    : [];

  return {
    title:
      typeof parsed.title === "string" && parsed.title
        ? parsed.title
        : facts.title,
    metaDescription:
      typeof parsed.metaDescription === "string" && parsed.metaDescription
        ? parsed.metaDescription
        : facts.metaDescription,
    ogImage: facts.ogImage,
    quickAnswer:
      typeof parsed.quickAnswer === "string" && parsed.quickAnswer.trim()
        ? parsed.quickAnswer.trim()
        : facts.quickAnswer,
    takeaways:
      strArray(parsed.keyTakeaways).length > 0
        ? strArray(parsed.keyTakeaways)
        : facts.takeaways,
    faqs: faqs.length > 0 ? faqs : facts.faqs,
    products: products.length > 0 ? products : facts.products
  };
}

// ── Value coercion helpers ─────────────────────────────────────────────────────

function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const cleaned = v.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max).trimEnd() : cleaned;
}

/** Same as str() but keeps paragraph breaks (multi-line post bodies). */
function block(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const cleaned = v
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max).trimEnd() : cleaned;
}

function list(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => str(item, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

// ── Copy channels (model-generated) ────────────────────────────────────────────

export interface CopyChannel {
  id: string;
  label: string;
  kind: TrafficSourceKind;
  /** Key this channel occupies in the model's JSON response. */
  field: string;
  /** Batch this channel is generated in. */
  batch: "social" | "longform";
  /** Shape instruction rendered into the prompt. */
  schema: string;
  /** Editorial guidance rendered into the prompt. */
  guidance: string;
  /** Validate the model's raw value; null when unusable. */
  build(
    raw: Record<string, unknown>,
    facts: ArticleFacts,
    url: string
  ): { fields: Record<string, string | string[]>; postText: string } | null;
}

export const COPY_CHANNELS: CopyChannel[] = [
  {
    id: "pinterest",
    label: "Pinterest",
    kind: "social",
    field: "pinterest",
    batch: "social",
    schema: `"pinterest":{"pinTitle":"","pinDescription":"","board":"","altText":""}`,
    guidance:
      "Pinterest: pinTitle <= 100 chars and benefit-led, pinDescription 150-500 chars written for search (natural keyword use, no hashtag spam, max 3 hashtags at the end), board = the board name this pin belongs on, altText = plain description of the pin image for accessibility.",
    build(raw, facts, url) {
      const pinTitle = str(raw.pinTitle, 100);
      const pinDescription = block(raw.pinDescription, 500);
      if (!pinTitle || pinDescription.length < 60) return null;
      const board = str(raw.board, 80) || "Cat Gear & Reviews";
      const altText = str(raw.altText, 200) || pinTitle;
      return {
        fields: {
          pinTitle,
          pinDescription,
          board,
          altText,
          imageUrl: facts.ogImage,
          destinationUrl: url
        },
        postText: `${pinTitle}\n\n${pinDescription}\n\n${url}`
      };
    }
  },
  {
    id: "x",
    label: "X (Twitter)",
    kind: "social",
    field: "x",
    batch: "social",
    schema: `"x":{"thread":["",""]}`,
    guidance:
      "X: thread = 3 to 5 posts, each <= 260 characters. Post 1 is a concrete hook with a specific fact — no 'thread 🧵' filler. Middle posts each carry one useful takeaway. The final post links the article.",
    build(raw, _facts, url) {
      const thread = list(raw.thread, 5, 260);
      if (thread.length < 3) return null;
      const withLink = thread.some((t) => t.includes(url))
        ? thread
        : [
            ...thread.slice(0, -1),
            `${thread[thread.length - 1]} ${url}`.trim()
          ];
      return {
        fields: { thread: withLink },
        postText: withLink.map((t, i) => `${i + 1}/ ${t}`).join("\n\n")
      };
    }
  },
  {
    id: "facebook",
    label: "Facebook Groups",
    kind: "social",
    field: "facebook",
    batch: "social",
    schema: `"facebook":{"groups":["",""],"post":""}`,
    guidance:
      "Facebook: groups = 3 to 5 real cat-owner Facebook group themes to post in (describe the group type, do not invent URLs). post = 80-150 words, first person, opens with the problem a cat owner actually has, ends with the link as a helper not an ad.",
    build(raw, _facts, url) {
      const groups = list(raw.groups, 5, 90);
      const post = block(raw.post, 1_500);
      if (!post || post.length < 120) return null;
      const body = post.includes(url) ? post : `${post}\n\n${url}`;
      return {
        fields: { groups, post: body },
        postText: body
      };
    }
  },
  {
    id: "reddit",
    label: "Reddit",
    kind: "community",
    field: "reddit",
    batch: "social",
    schema: `"reddit":{"subreddits":["",""],"title":"","body":""}`,
    guidance:
      "Reddit: subreddits = 3 to 5 subreddit names (with the r/ prefix) where cat owners discuss this. title <= 300 chars, phrased as a genuine question or experience report, never as a headline. body = 120-200 words that answer the question in full ON reddit; the link appears once at the end as a source, because a link-only post gets removed.",
    build(raw, _facts, url) {
      const subreddits = list(raw.subreddits, 5, 40).map((s) =>
        s.startsWith("r/") ? s : `r/${s.replace(/^\/?r\//, "")}`
      );
      const title = str(raw.title, 300);
      const body = block(raw.body, 2_000);
      if (!title || body.length < 150) return null;
      const withSource = body.includes(url)
        ? body
        : `${body}\n\nFull writeup with the picks: ${url}`;
      return {
        fields: { subreddits, title, body: withSource },
        postText: `${title}\n\n${withSource}`
      };
    }
  },
  {
    id: "quora",
    label: "Quora",
    kind: "community",
    field: "quora",
    batch: "longform",
    schema: `"quora":{"questions":["",""],"answer":""}`,
    guidance:
      "Quora: questions = 3 to 5 question titles real people ask on Quora that this article answers. answer = 150-220 words, warm first-person, answers the first question completely, single citation to the article at the end.",
    build(raw, _facts, url) {
      const questions = list(raw.questions, 5, 200);
      const answer = block(raw.answer, 2_000);
      if (questions.length < 2 || answer.length < 300) return null;
      const cited = answer.includes(url)
        ? answer
        : `${answer}\n\nFor a detailed comparison with product picks, see: ${url}`;
      return {
        fields: { questions, answer: cited },
        postText: `${questions[0]}\n\n${cited}`
      };
    }
  },
  {
    id: "youtube-short",
    label: "YouTube Short",
    kind: "social",
    field: "youtubeShort",
    batch: "longform",
    schema: `"youtubeShort":{"hook":"","script":"","description":"","tags":["",""]}`,
    guidance:
      "YouTube Short: hook <= 90 chars spoken in the first 2 seconds. script = a 45-second voiceover (110-140 words) in short spoken sentences, no stage directions. description = 2-3 sentences plus the article link. tags = 5 to 8 lowercase search tags.",
    build(raw, _facts, url) {
      const hook = str(raw.hook, 90);
      const script = block(raw.script, 1_500);
      const description = block(raw.description, 800);
      const tags = list(raw.tags, 8, 30);
      if (!hook || script.length < 250) return null;
      const desc = description.includes(url)
        ? description
        : `${description}\n\n${url}`.trim();
      return {
        fields: { hook, script, description: desc, tags },
        postText: `HOOK: ${hook}\n\nSCRIPT:\n${script}\n\nDESCRIPTION:\n${desc}\n\nTAGS: ${tags.join(", ")}`
      };
    }
  },
  {
    id: "newsletter",
    label: "Email Newsletter",
    kind: "owned",
    field: "newsletter",
    batch: "longform",
    schema: `"newsletter":{"subject":"","preheader":"","body":""}`,
    guidance:
      "Newsletter: subject <= 60 chars, curiosity plus specificity, no emoji. preheader <= 100 chars that extends the subject rather than repeating it. body = 120-180 words, one clear takeaway, one call to action linking the article.",
    build(raw, _facts, url) {
      const subject = str(raw.subject, 60);
      const preheader = str(raw.preheader, 100);
      const body = block(raw.body, 2_000);
      if (!subject || body.length < 250) return null;
      const withCta = body.includes(url)
        ? body
        : `${body}\n\nRead the guide → ${url}`;
      return {
        fields: { subject, preheader, body: withCta },
        postText: `Subject: ${subject}\nPreheader: ${preheader}\n\n${withCta}`
      };
    }
  },
  {
    id: "medium",
    label: "Medium / Substack repost",
    kind: "syndication",
    field: "medium",
    batch: "longform",
    schema: `"medium":{"title":"","standfirst":"","intro":""}`,
    guidance:
      "Medium repost: title <= 70 chars and distinct from the article's own title. standfirst = one sentence subtitle. intro = 150-200 words that stand alone as the opening of a canonical-tagged repost and end by pointing at the full guide.",
    build(raw, _facts, url) {
      const title = str(raw.title, 70);
      const standfirst = str(raw.standfirst, 160);
      const intro = block(raw.intro, 2_000);
      if (!title || intro.length < 300) return null;
      const withCanonical = intro.includes(url)
        ? intro
        : `${intro}\n\nOriginally published at ${url}`;
      return {
        fields: {
          title,
          standfirst,
          intro: withCanonical,
          canonicalUrl: url
        },
        postText: `${title}\n${standfirst}\n\n${withCanonical}\n\nSet canonical URL to: ${url}`
      };
    }
  }
];

// ── Prompting ──────────────────────────────────────────────────────────────────

const COPY_SYSTEM_PROMPT = `You are the distribution editor for catsluvus.com, a cat-product review site. You turn a published article into channel-native copy that a real cat owner would find useful, not promotional filler.

Hard rules:
- Every factual claim must come from the article material supplied. Never invent product names, prices, test results, or personal anecdotes about using a product.
- Never claim the writer personally tested, measured, or observed a product.
- No markdown, no emoji spam, no ALL CAPS, no "click here".
- Respond with ONE JSON object and nothing else. No prose before or after.`;

function factsBlock(facts: ArticleFacts, keyword: string, url: string): string {
  const faqLines = facts.faqs
    .slice(0, 6)
    .map((f) => `- ${f.question} — ${f.answer.slice(0, 300)}`)
    .join("\n");
  return [
    `Target keyword: ${keyword}`,
    `Article title: ${facts.title}`,
    `Article URL: ${url}`,
    `Meta description: ${facts.metaDescription}`,
    facts.quickAnswer ? `Quick answer: ${facts.quickAnswer}` : "",
    facts.takeaways.length > 0
      ? `Key takeaways:\n${facts.takeaways.map((t) => `- ${t}`).join("\n")}`
      : "",
    facts.products.length > 0
      ? `Top picks: ${facts.products.slice(0, 5).join("; ")}`
      : "",
    faqLines ? `FAQ material:\n${faqLines}` : ""
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 6_000);
}

function buildCopyPrompt(
  channels: CopyChannel[],
  facts: ArticleFacts,
  keyword: string,
  url: string
): string {
  return `${factsBlock(facts, keyword, url)}

Write the distribution copy for these channels:

${channels.map((c) => `- ${c.guidance}`).join("\n")}

Return ONLY this JSON object (same keys, same nesting):
{${channels.map((c) => c.schema).join(",")}}`;
}

/**
 * Parse a batched copy response. Exported for tests: the tolerance rules
 * here (fenced JSON, trailing prose, per-channel validation) are what
 * stop one malformed channel from voiding the whole batch.
 */
export function parseCopyResponse(
  rawText: string,
  channels: CopyChannel[],
  facts: ArticleFacts,
  url: string
): Record<
  string,
  { fields: Record<string, string | string[]>; postText: string }
> {
  const json =
    extractFirstJsonObject(rawText) ??
    extractFirstJsonObject(repairJson(rawText));
  if (!json) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    try {
      parsed = JSON.parse(repairJson(json)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const out: Record<
    string,
    { fields: Record<string, string | string[]>; postText: string }
  > = {};
  for (const channel of channels) {
    const value = parsed[channel.field];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const built = channel.build(value as Record<string, unknown>, facts, url);
    if (!built) continue;
    built.postText = built.postText.slice(0, MAX_POST_CHARS);
    out[channel.id] = built;
  }
  return out;
}

// ── Source registry ────────────────────────────────────────────────────────────

export interface TrafficSourceDefinition {
  id: string;
  label: string;
  kind: TrafficSourceKind;
  /** Machine channels do real network/KV work; copy channels call Kimi. */
  copyBatch?: "social" | "longform";
}

/** Every traffic source an article is expected to be pushed into. */
export const TRAFFIC_SOURCES: TrafficSourceDefinition[] = [
  { id: "sitemap", label: "XML Sitemap", kind: "search" },
  { id: "indexnow", label: "IndexNow", kind: "search" },
  { id: "rss", label: "RSS Feed", kind: "syndication" },
  { id: "websub", label: "WebSub Hubs", kind: "syndication" },
  { id: "qa-json", label: "Answer-Engine Q&A", kind: "answer-engine" },
  ...COPY_CHANNELS.map((c) => ({
    id: c.id,
    label: c.label,
    kind: c.kind,
    copyBatch: c.batch
  }))
];

export const TRAFFIC_SOURCE_IDS = TRAFFIC_SOURCES.map((s) => s.id);

// ── Ledger ─────────────────────────────────────────────────────────────────────

export function ledgerKey(kvKey: string): string {
  return `${TRAFFIC_SOURCE_LEDGER_PREFIX}${kvKey}`;
}

export function artifactKey(sourceId: string, kvKey: string): string {
  return `${TRAFFIC_SOURCE_ARTIFACT_PREFIX}${sourceId}:${kvKey}`;
}

/** Source ids still worth attempting: never filled/skipped, attempts left. */
export function pendingSourceIds(ledger: TrafficSourceLedger): string[] {
  return TRAFFIC_SOURCE_IDS.filter((id) => {
    const entry = ledger.sources[id];
    if (!entry) return true;
    if (entry.status === "filled" || entry.status === "skipped") return false;
    return entry.attempts < MAX_ATTEMPTS;
  });
}

/** True once every source has a terminal outcome. */
export function isLedgerComplete(ledger: TrafficSourceLedger): boolean {
  return TRAFFIC_SOURCE_IDS.every((id) => {
    const entry = ledger.sources[id];
    if (!entry) return false;
    return (
      entry.status === "filled" ||
      entry.status === "skipped" ||
      entry.attempts >= MAX_ATTEMPTS
    );
  });
}

function emptyLedger(
  kvKey: string,
  url: string,
  keyword: string
): TrafficSourceLedger {
  return {
    kvKey,
    url,
    keyword,
    updatedAt: new Date().toISOString(),
    sources: {}
  };
}

export async function readLedger(
  agent: SEOArticleAgent,
  kvKey: string,
  url: string,
  keyword: string
): Promise<TrafficSourceLedger> {
  const raw = await agent.envBindings.ARTICLES_KV.get(ledgerKey(kvKey));
  if (!raw) return emptyLedger(kvKey, url, keyword);
  try {
    const parsed = JSON.parse(raw) as Partial<TrafficSourceLedger>;
    return {
      kvKey,
      url: parsed.url || url,
      keyword: parsed.keyword || keyword,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      sources:
        parsed.sources && typeof parsed.sources === "object"
          ? (parsed.sources as Record<string, TrafficSourceEntry>)
          : {}
    };
  } catch {
    // Malformed ledger self-heals rather than stranding the article.
    return emptyLedger(kvKey, url, keyword);
  }
}

async function writeLedger(
  agent: SEOArticleAgent,
  ledger: TrafficSourceLedger
): Promise<void> {
  ledger.updatedAt = new Date().toISOString();
  await agent.envBindings.ARTICLES_KV.put(
    ledgerKey(ledger.kvKey),
    JSON.stringify(ledger)
  );
}

function record(
  ledger: TrafficSourceLedger,
  id: string,
  status: TrafficSourceStatus,
  detail: string,
  artifact?: string
): void {
  const prior = ledger.sources[id];
  ledger.sources[id] = {
    status,
    detail: detail.slice(0, 300),
    at: new Date().toISOString(),
    attempts: (prior?.attempts ?? 0) + 1,
    ...(artifact ? { artifactKey: artifact } : {})
  };
}

// ── Machine channels ───────────────────────────────────────────────────────────

interface MachineOutcome {
  status: TrafficSourceStatus;
  detail: string;
}

async function fillSitemap(
  agent: SEOArticleAgent,
  url: string
): Promise<MachineOutcome> {
  const { updateSitemap } = await import("./indexing");
  await updateSitemap(agent, url);
  const sitemap =
    (await agent.envBindings.ARTICLES_KV.get("sitemap:flat-sitemap")) ?? "";
  return sitemap.includes(url)
    ? { status: "filled", detail: "URL present in sitemap:flat-sitemap" }
    : { status: "failed", detail: "URL missing from sitemap after update" };
}

async function fillIndexNow(
  agent: SEOArticleAgent,
  url: string
): Promise<MachineOutcome> {
  const { notifyIndexNow } = await import("./indexing");
  const ok = await notifyIndexNow(agent, url);
  return ok
    ? { status: "filled", detail: "submitted to IndexNow" }
    : {
        status: "failed",
        detail: "IndexNow rejected the URL — queued in indexnow-pending-queue"
      };
}

async function fillRss(
  agent: SEOArticleAgent,
  facts: ArticleFacts,
  url: string,
  categorySlug: string
): Promise<MachineOutcome> {
  const { updateRssFeed } = await import("./feed-syndication");
  const result = await updateRssFeed(agent, {
    title: facts.title,
    metaDescription: facts.metaDescription,
    canonicalUrl: url,
    categorySlug,
    pubDateIso: new Date().toISOString()
  });
  return {
    status: "filled",
    detail: `${result.itemCount} item(s) in ${result.feedUrl}`
  };
}

async function fillWebSub(agent: SEOArticleAgent): Promise<MachineOutcome> {
  const { notifyWebSubHubs } = await import("./feed-syndication");
  const domain = agent.envBindings.DOMAIN || "catsluvus.com";
  const feedUrl = `https://${domain}/feed.rss`;
  // notifyWebSubHubs never throws — hub failures are logged as warnings.
  await notifyWebSubHubs(agent, feedUrl);
  return { status: "filled", detail: `hubs pinged for ${feedUrl}` };
}

/**
 * Answer-engine Q&A JSON. Step 22 writes it at publish time; this rebuilds
 * it from the published page when that write never happened, so the
 * `/api/qa/*` surface is never missing an article.
 */
async function fillQaJson(
  agent: SEOArticleAgent,
  facts: ArticleFacts,
  kvKey: string,
  keyword: string,
  url: string,
  categorySlug: string,
  slug: string
): Promise<MachineOutcome> {
  const qaKey = `qa:${categorySlug}:${slug}`;
  const existing = await agent.envBindings.ARTICLES_KV.get(qaKey);
  if (existing) {
    return { status: "filled", detail: `${qaKey} already present` };
  }
  if (facts.faqs.length === 0 && !facts.quickAnswer) {
    return {
      status: "skipped",
      detail: `no FAQ or quick-answer content in ${kvKey} to build a payload from`
    };
  }
  const payload = {
    keyword,
    url,
    lastUpdated: new Date().toISOString(),
    quickAnswer: facts.quickAnswer,
    keyTakeaways: facts.takeaways.slice(0, 7),
    faqs: facts.faqs,
    topProducts: facts.products
      .slice(0, 5)
      .map((name) => ({ asin: "", name, reason: "" })),
    title: facts.title,
    metaDescription: facts.metaDescription,
    categorySlug,
    slug,
    wordCount: 0
  };
  await agent.envBindings.ARTICLES_KV.put(qaKey, JSON.stringify(payload), {
    metadata: {
      keyword,
      categorySlug,
      slug,
      faqCount: String(facts.faqs.length),
      lastUpdated: payload.lastUpdated,
      rebuiltBy: "traffic-sources"
    }
  });
  return {
    status: "filled",
    detail: `rebuilt ${qaKey} from published HTML (${facts.faqs.length} FAQs)`
  };
}

// ── Fill one article ───────────────────────────────────────────────────────────

interface ArticleRow {
  kv_key: string;
  url: string;
  keyword: string;
  slug: string;
  category_slug: string;
}

async function runCopyBatch(
  agent: SEOArticleAgent,
  batch: "social" | "longform",
  channels: CopyChannel[],
  facts: ArticleFacts,
  keyword: string,
  url: string
): Promise<
  Record<
    string,
    { fields: Record<string, string | string[]>; postText: string }
  >
> {
  const prompt = buildCopyPrompt(channels, facts, keyword, url);
  const { text } = await generateText({
    model: getKimiModel(agent.envBindings),
    providerOptions: getKimiProviderOptions(agent.envBindings),
    system: COPY_SYSTEM_PROMPT,
    prompt,
    maxOutputTokens: batch === "social" ? 1_800 : 2_400
  });
  return parseCopyResponse(text ?? "", channels, facts, url);
}

/**
 * Fill every pending source for one article. Never throws — each source
 * records its own outcome so one failure can't block the others.
 */
export async function fillArticleTrafficSources(
  agent: SEOArticleAgent,
  row: ArticleRow
): Promise<TrafficSourceFillResult> {
  const kvKey = row.kv_key;
  const domain = agent.envBindings.DOMAIN || "catsluvus.com";
  const url = row.url || `https://${domain}/${row.category_slug}/${row.slug}`;
  const ledger = await readLedger(agent, kvKey, url, row.keyword);
  const pending = pendingSourceIds(ledger);
  if (pending.length === 0) {
    return {
      ok: true,
      kvKey,
      filled: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
      detail: "all traffic sources already filled"
    };
  }

  const html = await agent.envBindings.ARTICLES_KV.get(kvKey);
  if (!html) {
    return {
      ok: false,
      kvKey,
      filled: 0,
      failed: 0,
      skipped: 0,
      remaining: pending.length,
      detail: `no published HTML in KV for ${kvKey}`
    };
  }
  const facts = mergeQaPayloadIntoFacts(
    extractArticleFacts(html),
    await agent.envBindings.ARTICLES_KV.get(
      `qa:${row.category_slug}:${row.slug}`
    )
  );

  let filled = 0;
  let failed = 0;
  let skipped = 0;
  const tally = (outcome: MachineOutcome) => {
    if (outcome.status === "filled") filled++;
    else if (outcome.status === "skipped") skipped++;
    else failed++;
  };

  // ── Machine channels ───────────────────────────────────────────────────
  for (const id of pending) {
    if (COPY_CHANNELS.some((c) => c.id === id)) continue;
    let outcome: MachineOutcome;
    try {
      if (id === "sitemap") outcome = await fillSitemap(agent, url);
      else if (id === "indexnow") outcome = await fillIndexNow(agent, url);
      else if (id === "rss") {
        outcome = await fillRss(agent, facts, url, row.category_slug);
      } else if (id === "websub") outcome = await fillWebSub(agent);
      else if (id === "qa-json") {
        outcome = await fillQaJson(
          agent,
          facts,
          kvKey,
          row.keyword,
          url,
          row.category_slug,
          row.slug
        );
      } else continue;
    } catch (err: unknown) {
      outcome = { status: "failed", detail: errMsg(err) };
    }
    record(ledger, id, outcome.status, outcome.detail);
    tally(outcome);
    agent.log(
      outcome.status === "failed" ? "warning" : "info",
      `Traffic source ${outcome.status === "filled" ? "✅" : outcome.status === "skipped" ? "⏭️" : "⚠️"} ${id} — ${kvKey}: ${outcome.detail}`,
      "marketing",
      { kanbanStage: outcome.status === "filled" ? "done" : "queue" }
    );
  }

  // ── Copy channels, one model call per batch ────────────────────────────
  for (const batch of ["social", "longform"] as const) {
    const channels = COPY_CHANNELS.filter(
      (c) => c.batch === batch && pending.includes(c.id)
    );
    if (channels.length === 0) continue;

    let generated: Record<
      string,
      { fields: Record<string, string | string[]>; postText: string }
    > = {};
    let batchError = "";
    try {
      generated = await runCopyBatch(
        agent,
        batch,
        channels,
        facts,
        row.keyword,
        url
      );
    } catch (err: unknown) {
      batchError = errMsg(err);
    }

    for (const channel of channels) {
      const built = generated[channel.id];
      if (!built) {
        const detail = batchError
          ? `model call failed: ${batchError}`
          : "model response missing or failed validation for this channel";
        record(ledger, channel.id, "failed", detail);
        failed++;
        agent.log(
          "warning",
          `Traffic source ⚠️ ${channel.id} — ${kvKey}: ${detail}`,
          "marketing",
          { kanbanStage: "queue" }
        );
        continue;
      }
      const key = artifactKey(channel.id, kvKey);
      const artifact: TrafficSourceArtifact = {
        id: channel.id,
        label: channel.label,
        kind: channel.kind,
        kvKey,
        keyword: row.keyword,
        url,
        generatedAt: new Date().toISOString(),
        fields: built.fields,
        postText: built.postText
      };
      try {
        await agent.envBindings.ARTICLES_KV.put(key, JSON.stringify(artifact));
      } catch (err: unknown) {
        record(ledger, channel.id, "failed", `KV write failed: ${errMsg(err)}`);
        failed++;
        continue;
      }
      record(
        ledger,
        channel.id,
        "filled",
        `${built.postText.length} chars of ${channel.label} copy`,
        key
      );
      filled++;
      agent.log(
        "info",
        `Traffic source ✅ ${channel.id} — ${kvKey}: ${channel.label} copy ready (${key})`,
        "marketing",
        { kanbanStage: "done" }
      );
    }
  }

  await writeLedger(agent, ledger);
  const remaining = pendingSourceIds(ledger).length;
  return {
    ok: failed === 0,
    kvKey,
    filled,
    failed,
    skipped,
    remaining,
    detail: `${filled} filled, ${failed} failed, ${skipped} skipped, ${remaining} still pending`
  };
}

// ── Entry points ───────────────────────────────────────────────────────────────

function candidateRows(agent: SEOArticleAgent, kvKey?: string): ArticleRow[] {
  if (kvKey) {
    return [
      ...agent.sql<ArticleRow>`
        SELECT kv_key, url, keyword, slug, category_slug
          FROM articles
         WHERE kv_key = ${kvKey}
         LIMIT 1`
    ];
  }
  return [
    ...agent.sql<ArticleRow>`
      SELECT kv_key, url, keyword, slug, category_slug
        FROM articles
       WHERE kv_key != ''
       ORDER BY created_at DESC
       LIMIT ${CANDIDATE_LIMIT}`
  ];
}

export interface TrafficSourceFillOptions {
  /** Fill this article specifically instead of scanning for pending work. */
  kvKey?: string;
  /** Never touch this article (the one currently being generated). */
  excludeKvKey?: string;
  /** Re-run sources already marked filled (admin force-refresh). */
  force?: boolean;
}

/**
 * Fill the next article that still has pending traffic sources.
 *
 * Deliberately does NOT skip while the pipeline is generating — using the
 * generation wait is the entire point. Collisions are prevented by a KV
 * lock plus the excludeKvKey guard rather than by idling.
 */
export async function runTrafficSourceFill(
  agent: SEOArticleAgent,
  opts: TrafficSourceFillOptions = {}
): Promise<TrafficSourceFillResult> {
  const kv = agent.envBindings.ARTICLES_KV;
  const held = await kv.get(LOCK_KEY);
  if (held) {
    return {
      ok: true,
      kvKey: null,
      filled: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
      detail: "another traffic-source fill is in flight"
    };
  }
  await kv.put(LOCK_KEY, new Date().toISOString(), {
    expirationTtl: LOCK_TTL_S
  });

  try {
    const rows = candidateRows(agent, opts.kvKey).filter(
      (r) => r.kv_key && r.kv_key !== opts.excludeKvKey
    );
    if (rows.length === 0) {
      return {
        ok: true,
        kvKey: null,
        filled: 0,
        failed: 0,
        skipped: 0,
        remaining: 0,
        detail: "no published articles to distribute"
      };
    }

    for (const row of rows) {
      if (opts.force) {
        await kv.delete(ledgerKey(row.kv_key));
      } else {
        const ledger = await readLedger(
          agent,
          row.kv_key,
          row.url,
          row.keyword
        );
        if (pendingSourceIds(ledger).length === 0) continue;
      }
      const result = await fillArticleTrafficSources(agent, row);
      agent.log(
        result.failed > 0 ? "warning" : "info",
        `Traffic sources: ${row.kv_key} — ${result.detail}`,
        "marketing",
        { kanbanStage: result.remaining === 0 ? "done" : "queue" }
      );
      return result;
    }

    return {
      ok: true,
      kvKey: null,
      filled: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
      detail: `every traffic source filled for the ${rows.length} most recent article(s)`
    };
  } catch (err: unknown) {
    return {
      ok: false,
      kvKey: null,
      filled: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
      detail: `traffic-source fill threw: ${errMsg(err)}`
    };
  } finally {
    await kv.delete(LOCK_KEY).catch(() => undefined);
  }
}

/**
 * Fire-and-forget wrapper used by generateArticle(): the previous
 * article's traffic sources fill in while the next one is being written.
 * Swallows everything — distribution must never affect generation.
 */
export function backfillTrafficSourcesInBackground(
  agent: SEOArticleAgent,
  opts: TrafficSourceFillOptions = {}
): void {
  agent.waitUntil(
    (async () => {
      try {
        await runTrafficSourceFill(agent, opts);
      } catch (err: unknown) {
        agent.log(
          "warning",
          `Traffic-source backfill failed (non-fatal): ${errMsg(err)}`,
          "marketing"
        );
      }
    })()
  );
}
