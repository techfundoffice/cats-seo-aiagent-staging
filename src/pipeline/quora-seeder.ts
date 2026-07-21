import { generateText } from "ai";
import type { SEOArticleAgent } from "../server";
import { formatActivityLogModelPromptCell } from "../activityLogSheetColumns";
import { getKimiModel, getKimiProviderOptions } from "./kimi-model";
import { errMsg, getEnvBinding, normalizeSingleLine } from "./http-utils";

/**
 * Step 21/24 — Quora Answer Seeder.
 *
 * After the article is published and live-verified, this step:
 *   1. Searches Quora for questions matching the keyword and PAA questions
 *      (already collected in Step 5) via the Apify
 *      `crawlerbros/quora-scraper` actor (with a legacy direct-HTTP regex
 *      fallback when APIFY_TOKEN is unset).
 *   2. For each unanswered or low-answer thread found, uses Workers AI
 *      (Llama) to synthesise a genuine, helpful answer drawn from the
 *      article's FAQ content and quick-answer box.
 *   3. Posts the answer via Composio's Quora tool when COMPOSIO_API_KEY
 *      and QUORA_API_TOKEN are available; otherwise logs a dry-run
 *      summary so the operator can paste manually.
 *
 * Gracefully skips when:
 *   - No PAA questions were collected in Step 5.
 *   - Quora search returns no relevant threads.
 *   - COMPOSIO_API_KEY / QUORA_API_TOKEN are absent (dry-run mode).
 *
 * Never throws — failures are logged as warnings so the pipeline
 * continues to Step 22 regardless.
 */

const QUORA_SEARCH_BASE = "https://www.quora.com/search?q=";
const QUORA_USER_AGENT =
  "Mozilla/5.0 (compatible; CatsLuvUs-SEOAgent/1.0; +https://catsluvus.com)";
const MAX_ANSWER_CHARS = 1_500;
const MAX_FAQ_CHARS = 3_000;
/** Client-side timeout for the Apify run-sync call (ms).
 * Set above the `&timeout=180` server-side actor timeout so Apify's own
 * timeout fires first and returns a clean error rather than the Worker
 * fetch hanging indefinitely on a network stall.
 * Apify path disabled — see searchQuoraQuestions. */
// const APIFY_FETCH_TIMEOUT_MS = 210_000;
/** Client-side timeout for the legacy Quora HTML scrape (ms). */
const QUORA_SCRAPE_TIMEOUT_MS = 10_000;
/** Client-side timeout for the Composio answer-post call (ms). */
const COMPOSIO_POST_TIMEOUT_MS = 10_000;

export interface QuoraSeederInput {
  keyword: string;
  articleUrl: string;
  /** PAA questions collected in Step 5 (Google Autocomplete). */
  paaQuestions: string[];
  /** Article FAQ items for answer synthesis. */
  faqs: Array<{ question: string; answer: string }>;
  /** Quick-answer box text — used as the answer opener. */
  quickAnswer: string;
  /** Article title for attribution. */
  articleTitle: string;
}

export interface QuoraSeededThread {
  questionUrl: string;
  questionTitle: string;
  answerText: string;
  posted: boolean;
  skipReason?: string;
}

export interface QuoraSeederResult {
  threadsFound: number;
  threadsSeeded: number;
  dryRun: boolean;
  skipped: boolean;
  skipReason?: string;
  threads: QuoraSeededThread[];
  /** Full system+user prompt for the activity-log modelPrompt column. */
  modelPromptCell: string;
}

// ── Quora question search ─────────────────────────────────────────────────
//
// Primary path: Apify actor `crawlerbros/quora-scraper` via direct API call
// using the existing APIFY_TOKEN (same secret already used by amazon.ts).
// Actor input schema (resolved 2026-04-21 via APIFY_GET_DEFAULT_BUILD):
//   - searchQueries: string[]   (keywords; finds question URLs via DDG)
//   - maxResults:    integer    (1..5000, default 50)
//   - directUrls:    string[]   (optional; not used here)
//   - proxyConfiguration: object (residential proxy recommended)
// Output rows include `content_type` (question/answer/profile/topic/space),
// `title`, and `url`; we filter to questions only.
//
// Fallback path: legacy direct-fetch-and-regex when APIFY_TOKEN is unset
// (keeps the pipeline running locally without secrets).

// Apify path disabled — see searchQuoraQuestions.
// interface QuoraScraperItem {
//   content_type?: string;
//   title?: string;
//   url?: string;
//   question_url?: string;
//   question_title?: string;
// }

async function searchQuoraQuestions(
  agent: SEOArticleAgent,
  query: string,
  limit = 3
): Promise<Array<{ url: string; title: string }>> {
  // Apify `crawlerbros/quora-scraper` call disabled — not needed. The pipeline
  // now always uses the legacy direct-HTTP scrape path below. Kept commented
  // for reference in case the Apify path is re-enabled later.
  return legacySearchQuoraQuestions(query, limit, (msg) =>
    agent.log("warning", msg, "marketing")
  );

  /*
  const apifyToken = getEnvBinding(agent.envBindings, "APIFY_TOKEN") ?? "";

  if (!apifyToken) {
    return legacySearchQuoraQuestions(query, limit, (msg) =>
      agent.log("warning", msg, "marketing")
    );
  }

  try {
    const url =
      `https://api.apify.com/v2/acts/crawlerbros~quora-scraper` +
      `/run-sync-get-dataset-items` +
      `?token=${encodeURIComponent(apifyToken)}` +
      `&memory=1024&timeout=180`;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchQueries: [query],
        maxResults: Math.max(limit, 5),
        proxyConfiguration: {
          useApifyProxy: true,
          apifyProxyGroups: ["RESIDENTIAL"]
        }
      }),
      signal: AbortSignal.timeout(APIFY_FETCH_TIMEOUT_MS)
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const bodySnippet = normalizeSingleLine(body).slice(0, 200);
      agent.log(
        "warning",
        `Quora Seeder: Apify actor HTTP ${resp.status} — ${bodySnippet} (falling back to legacy scrape)`
      );
      return legacySearchQuoraQuestions(query, limit, (msg) =>
        agent.log("warning", msg, "marketing")
      );
    }

    const items = (await resp.json()) as QuoraScraperItem[];
    const seen = new Set<string>();
    const results: Array<{ url: string; title: string }> = [];

    for (const item of items) {
      if (results.length >= limit) break;
      const isQuestion = item.content_type === "question";
      const isAnswer = item.content_type === "answer";
      const candidateUrl = isQuestion
        ? item.url
        : isAnswer
          ? item.question_url
          : undefined;
      const candidateTitle = isQuestion
        ? item.title
        : isAnswer
          ? item.question_title
          : undefined;
      if (!candidateUrl || !candidateTitle) continue;
      if (seen.has(candidateUrl)) continue;
      seen.add(candidateUrl);
      results.push({
        url: candidateUrl,
        title: candidateTitle.trim().replace(/\s+/g, " ")
      });
    }

    agent.log(
      "info",
      `Quora Seeder: Apify actor returned ${results.length} question(s) for "${query.slice(0, 60)}"`,
      "marketing"
    );

    return results;
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Quora Seeder: Apify call error — ${errMsg(err)} (falling back to legacy scrape)`
    );
    return legacySearchQuoraQuestions(query, limit, (msg) =>
      agent.log("warning", msg, "marketing")
    );
  }
  */
}

// Legacy regex-on-HTML scrape — kept as a fallback when APIFY_TOKEN is unset.
// Quora aggressively bot-blocks datacenter IPs so this typically returns [].
async function legacySearchQuoraQuestions(
  query: string,
  limit: number,
  onWarn?: (msg: string) => void
): Promise<Array<{ url: string; title: string }>> {
  try {
    const encoded = encodeURIComponent(query);
    const resp = await fetch(`${QUORA_SEARCH_BASE}${encoded}&type=question`, {
      headers: {
        "User-Agent": QUORA_USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(QUORA_SCRAPE_TIMEOUT_MS)
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const questionResults: Array<{ url: string; title: string }> = [];
    const linkRe =
      /href="(\/[A-Za-z0-9][^"?#]{10,150})"[^>]*>([^<]{15,200})<\/a>/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((m = linkRe.exec(html)) !== null && questionResults.length < limit) {
      const path = m[1];
      const title = m[2].trim().replace(/\s+/g, " ");
      if (
        seen.has(path) ||
        !/^\/[A-Z]/.test(path) ||
        path.includes("/profile/") ||
        path.includes("/topic/") ||
        path.includes("/search") ||
        title.length < 15
      ) {
        continue;
      }
      seen.add(path);
      questionResults.push({ url: `https://www.quora.com${path}`, title });
    }

    return questionResults;
  } catch (err: unknown) {
    onWarn?.(
      `Quora Seeder: legacy scrape threw — ${errMsg(err)} (returning empty)`
    );
    return [];
  }
}

// ── Answer synthesis via Workers AI ───────────────────────────────────────

const ANSWER_SYSTEM_PROMPT = `You are a helpful cat-product expert writing a genuine, informative answer for a Quora question about cat products. Your goal is to provide real value to the person asking — not to promote a website.

Rules:
- Write in a warm, knowledgeable first-person voice ("In my experience…", "I've found that…")
- Lead with the most useful information immediately (no preamble)
- Use the FAQ content provided as the factual basis for your answer
- Keep the answer to 150–220 words
- End with ONE natural citation: "For a detailed comparison with product picks, see: [URL]"
- Do NOT keyword-stuff or write like an advertisement
- Do NOT use markdown — write plain text only`;

async function synthesiseAnswer(
  agent: SEOArticleAgent,
  questionTitle: string,
  input: QuoraSeederInput
): Promise<{ answerText: string; modelPromptCell: string }> {
  const faqBlock = input.faqs
    .slice(0, 6)
    .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
    .join("\n\n")
    .slice(0, MAX_FAQ_CHARS);

  const userPrompt = `Quora question: "${questionTitle}"

Article keyword context: ${input.keyword}
Article title: ${input.articleTitle}
Article quick answer: ${input.quickAnswer}

Relevant FAQ content from the article:
${faqBlock || "(no FAQs available — synthesise from the quick answer above)"}

Citation URL: ${input.articleUrl}

Write a genuine, helpful Quora answer (150–220 words) that answers the question directly, drawing on the FAQ content above. End with the citation URL naturally integrated.`;

  const promptCell = formatActivityLogModelPromptCell(
    ANSWER_SYSTEM_PROMPT,
    userPrompt
  );

  try {
    const { text } = await generateText({
      model: getKimiModel(agent.envBindings),
      providerOptions: getKimiProviderOptions(agent.envBindings),
      system: ANSWER_SYSTEM_PROMPT,
      prompt: userPrompt,
      maxOutputTokens: 600
    });
    const trimmed = (text ?? "").trim().slice(0, MAX_ANSWER_CHARS);
    return {
      answerText: trimmed || "Answer generation returned empty text.",
      modelPromptCell: promptCell
    };
  } catch (err: unknown) {
    return {
      answerText: `Answer synthesis failed: ${errMsg(err)}`,
      modelPromptCell: promptCell
    };
  }
}

// ── Composio Quora posting ─────────────────────────────────────────────────

/**
 * Attempts to post the answer to Quora via Composio.
 * Returns true on success, false on any failure (non-fatal).
 */
async function postAnswerViaComposio(
  agent: SEOArticleAgent,
  questionUrl: string,
  answerText: string
): Promise<boolean> {
  const composioKey =
    getEnvBinding(agent.envBindings, "COMPOSIO_API_KEY") ?? "";
  const quoraToken = getEnvBinding(agent.envBindings, "QUORA_API_TOKEN") ?? "";

  if (!composioKey || !quoraToken) return false;

  try {
    // Composio OpenAI-compatible endpoint — call the Quora answer-post tool.
    const resp = await fetch(
      "https://backend.composio.dev/api/v1/actions/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": composioKey
        },
        body: JSON.stringify({
          actionName: "QUORA_POST_ANSWER",
          input: {
            question_url: questionUrl,
            answer_text: answerText,
            access_token: quoraToken
          }
        }),
        signal: AbortSignal.timeout(COMPOSIO_POST_TIMEOUT_MS)
      }
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const bodySnippet = normalizeSingleLine(body).slice(0, 200);
      agent.log(
        "warning",
        `Quora Seeder: Composio post failed HTTP ${resp.status} for ${questionUrl} — ${bodySnippet}`
      );
      return false;
    }

    const json = (await resp.json()) as {
      successful?: boolean;
      success?: boolean;
    };
    return json.successful === true || json.success === true;
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Quora Seeder: Composio post error for ${questionUrl} — ${errMsg(err)}`
    );
    return false;
  }
}

/**
 * Runs the Quora seeding pass for one article candidate by:
 * 1) searching relevant Quora threads from keyword/PAA queries,
 * 2) generating short answers, and
 * 3) posting via Composio when credentials are present.
 *
 * Returns a structured result for activity logging and downstream pipeline
 * stages; when credentials are missing, the function safely degrades to dry-run.
 */
export async function runQuoraSeeder(
  agent: SEOArticleAgent,
  input: QuoraSeederInput
): Promise<QuoraSeederResult> {
  const emptyResult = (
    skipped: boolean,
    skipReason: string
  ): QuoraSeederResult => ({
    threadsFound: 0,
    threadsSeeded: 0,
    dryRun: false,
    skipped,
    skipReason,
    threads: [],
    modelPromptCell: ""
  });

  // ── Quora Seeder KILL SWITCH ───────────────────────────────────────────────
  // Hard-disabled: the entire Quora seeder (search/scrape + answer synthesis +
  // posting) is skipped so no Quora scraping or posting happens at all.
  // To re-enable, set the Worker env/secret QUORA_SEEDER_ENABLED="true".
  const quoraSeederEnabled =
    getEnvBinding(agent.envBindings, "QUORA_SEEDER_ENABLED")?.trim() === "true";
  if (!quoraSeederEnabled) {
    return emptyResult(
      true,
      "Quora seeder disabled (set QUORA_SEEDER_ENABLED=true to re-enable)"
    );
  }

  const normalizedKeyword = input.keyword.trim();
  const normalizedPaaQuestions = input.paaQuestions
    .map((question) => question.trim())
    .filter((question) => question.length > 0);

  // Require at least some PAA questions or the keyword itself to search with.
  if (normalizedPaaQuestions.length === 0 && !normalizedKeyword) {
    return emptyResult(true, "No PAA questions or keyword available");
  }

  // Build search queries: keyword + up to 3 PAA questions.
  const queries = [
    normalizedKeyword,
    ...normalizedPaaQuestions.slice(0, 3)
  ].filter((query) => query.length > 0);

  // Search Quora for each query (1 result per query to stay conservative).
  const seen = new Set<string>();
  const candidates: Array<{ url: string; title: string }> = [];

  for (const q of queries) {
    const results = await searchQuoraQuestions(agent, q, 2);
    for (const r of results) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        candidates.push(r);
      }
    }
    if (candidates.length >= 4) break; // cap at 4 threads per article
  }

  if (candidates.length === 0) {
    return emptyResult(
      true,
      "Quora search returned no matching question threads"
    );
  }

  // Detect dry-run mode (no credentials).
  const composioKey =
    getEnvBinding(agent.envBindings, "COMPOSIO_API_KEY") ?? "";
  const quoraToken = getEnvBinding(agent.envBindings, "QUORA_API_TOKEN") ?? "";
  const dryRun = !composioKey || !quoraToken;
  let dryRunSkipReason = "Dry-run: COMPOSIO_API_KEY or QUORA_API_TOKEN not set";

  if (dryRun && (composioKey || quoraToken)) {
    const missingBindings = [
      !composioKey ? "COMPOSIO_API_KEY" : null,
      !quoraToken ? "QUORA_API_TOKEN" : null
    ]
      .filter(Boolean)
      .join(", ");
    dryRunSkipReason = `Dry-run: missing ${missingBindings}; set both COMPOSIO_API_KEY and QUORA_API_TOKEN`;
    agent.log(
      "warning",
      `Quora Seeder dry-run: missing ${missingBindings}; set both COMPOSIO_API_KEY and QUORA_API_TOKEN to enable answer posting`,
      "marketing"
    );
  }

  const threads: QuoraSeededThread[] = [];
  let lastModelPromptCell = "";
  let seededCount = 0;

  for (const candidate of candidates.slice(0, 3)) {
    const { answerText, modelPromptCell } = await synthesiseAnswer(
      agent,
      candidate.title,
      input
    );
    lastModelPromptCell = modelPromptCell;

    let posted = false;
    let skipReason: string | undefined;

    if (dryRun) {
      skipReason = dryRunSkipReason;
    } else if (answerText.startsWith("Answer synthesis failed")) {
      skipReason = answerText;
    } else {
      posted = await postAnswerViaComposio(agent, candidate.url, answerText);
      if (!posted) {
        skipReason = "Composio post returned failure";
      }
    }

    if (posted) seededCount++;

    threads.push({
      questionUrl: candidate.url,
      questionTitle: candidate.title,
      answerText,
      posted,
      ...(skipReason ? { skipReason } : {})
    });

    agent.log(
      "info",
      `Quora Seeder: ${posted ? "✅ posted" : dryRun ? "🔶 dry-run" : "❌ failed"} — ${candidate.title.slice(0, 80)}`,
      "marketing",
      {
        kanbanStage: "done",
        modelPrompt: modelPromptCell,
        sheetPipelineStepLabel: "21/24: Quora Seeder"
      }
    );
  }

  const summary = dryRun
    ? `Quora Seeder dry-run: ${threads.length} thread(s) found, answers synthesised (set QUORA_API_TOKEN + COMPOSIO_API_KEY to post)`
    : `Quora Seeder: ${seededCount}/${threads.length} answer(s) posted`;

  agent.log("info", summary, "marketing", {
    kanbanStage: "done",
    sheetPipelineStepLabel: "21/24: Quora Seeder",
    quoraSeederSummary: summary
  });

  return {
    threadsFound: candidates.length,
    threadsSeeded: seededCount,
    dryRun,
    skipped: false,
    threads,
    modelPromptCell: lastModelPromptCell
  };
}
