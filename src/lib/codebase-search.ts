/**
 * Workers-runtime semantic codebase search.
 *
 * The agent runs in a Cloudflare Workers V8 isolate, which cannot
 * load `@zilliz/claude-context-core` directly: that package's
 * transitive dependencies (`@zilliz/milvus2-sdk-node` uses gRPC +
 * Node net, `faiss-node` is a native binary, `tree-sitter` is a
 * native binary, `fs-extra` is Node fs) all require a Node runtime.
 * Wrangler would refuse to bundle them.
 *
 * Workaround: the SAME Milvus collection that `claude-context-core`
 * writes to from CI (see `scripts/index-codebase.mjs`) is queried at
 * runtime via Zilliz Cloud's REST API + OpenAI's embeddings REST API
 * — both pure HTTPS, both natively available in Workers. The wire
 * format is the documented Zilliz/Milvus v1 REST contract; collection
 * shape mirrors what `claude-context-core` emits so the indexer and
 * the query path stay interop.
 *
 * Failure mode: when `OPENAI_API_KEY`, `MILVUS_ADDRESS`, or
 * `MILVUS_TOKEN` are missing the module logs once and degrades to a
 * no-op. Search calls return `{ available: false, hits: [] }` so
 * callers (the autonomous loop, the observer, the editorial agent)
 * can fall back to their existing heuristics. The worker MUST NOT
 * crash because Milvus is unreachable.
 */

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_COLLECTION = "code_chunks";
const DEFAULT_TOP_K = 8;
const REQUEST_TIMEOUT_MS = 10_000;

export interface CodebaseSearchEnv {
  OPENAI_API_KEY?: string;
  MILVUS_ADDRESS?: string;
  MILVUS_TOKEN?: string;
  /** Optional override; defaults to "code_chunks" so it matches the indexer. */
  MILVUS_COLLECTION?: string;
}

export interface CodebaseSearchHit {
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  snippet: string;
  score: number;
}

/**
 * Per-call metrics surfaced for the Infrastructure Activity Monitor.
 * Both OpenAI and Milvus blocks are populated independently so a
 * partial failure (e.g. OpenAI succeeded but Milvus 404'd) still
 * produces a record for the side that worked. `null` means the call
 * never happened (short-circuited earlier).
 */
export interface CodebaseSearchStats {
  openai: {
    model: string;
    promptTokens: number;
    latencyMs: number;
    status: "ok" | "error";
    errorReason?: string;
  } | null;
  milvus: {
    collection: string;
    hits: number;
    latencyMs: number;
    status: "ok" | "error";
    errorReason?: string;
  } | null;
}

export interface CodebaseSearchResult {
  available: boolean;
  hits: CodebaseSearchHit[];
  /** Populated when `available: false`. Operator-facing reason. */
  reason?: string;
  /** Per-API-call instrumentation for the activity monitor. */
  stats?: CodebaseSearchStats;
}

/**
 * Check which env vars are needed. Caller can use this for a startup
 * gate (decide whether to enable the agent tool) and for the
 * operator-facing readiness report on `/api/status`.
 */
export function getMissingCodebaseSearchVars(env: CodebaseSearchEnv): string[] {
  const missing: string[] = [];
  if (!env.OPENAI_API_KEY?.trim()) missing.push("OPENAI_API_KEY");
  if (!env.MILVUS_ADDRESS?.trim()) missing.push("MILVUS_ADDRESS");
  if (!env.MILVUS_TOKEN?.trim()) missing.push("MILVUS_TOKEN");
  return missing;
}

export function isCodebaseSearchEnabled(env: CodebaseSearchEnv): boolean {
  return getMissingCodebaseSearchVars(env).length === 0;
}

/**
 * Build the OpenAI embedding request payload. Pure helper, unit-tested.
 */
export function buildEmbeddingRequest(
  query: string,
  model = DEFAULT_MODEL
): { url: string; body: string } {
  return {
    url: OPENAI_EMBEDDINGS_URL,
    body: JSON.stringify({ model, input: query })
  };
}

/**
 * Build the Zilliz vector-search payload. Pure helper, unit-tested.
 * Matches the v1 `/v1/vector/search` REST contract.
 */
export function buildMilvusSearchRequest(
  address: string,
  collection: string,
  vector: number[],
  topK: number
): { url: string; body: string } {
  return {
    url: `${address.replace(/\/+$/, "")}/v1/vector/search`,
    body: JSON.stringify({
      collectionName: collection,
      vector,
      limit: topK,
      outputFields: ["filePath", "startLine", "endLine", "language", "snippet"]
    })
  };
}

/**
 * Parse Zilliz response into typed hits. Pure helper, unit-tested.
 * The REST API returns `{ data: [{ score, distance, ...fields }, …] }`.
 */
export function parseMilvusSearchResponse(json: unknown): CodebaseSearchHit[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const hits: CodebaseSearchHit[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const filePath = typeof r.filePath === "string" ? r.filePath : "";
    const snippet = typeof r.snippet === "string" ? r.snippet : "";
    if (!filePath || !snippet) continue;
    hits.push({
      filePath,
      startLine: typeof r.startLine === "number" ? r.startLine : 0,
      endLine: typeof r.endLine === "number" ? r.endLine : 0,
      language: typeof r.language === "string" ? r.language : "unknown",
      snippet,
      score:
        typeof r.score === "number"
          ? r.score
          : typeof r.distance === "number"
            ? r.distance
            : 0
    });
  }
  return hits;
}

async function embedQuery(
  env: CodebaseSearchEnv,
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<
  | { vector: number[]; promptTokens: number; latencyMs: number }
  | { error: string; latencyMs: number }
> {
  const { url, body } = buildEmbeddingRequest(query);
  const start = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err: unknown) {
    return {
      error: `OpenAI embed fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: Date.now() - start
    };
  }
  if (!res.ok) {
    const txt = (await res.text().catch(() => "")).slice(0, 200);
    return {
      error: `OpenAI embed HTTP ${res.status}: ${txt}`,
      latencyMs: Date.now() - start
    };
  }
  const json = (await res.json().catch(() => null)) as {
    data?: Array<{ embedding?: number[] }>;
    usage?: { prompt_tokens?: number };
  } | null;
  const vector = json?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    return {
      error: "OpenAI embed response missing data[0].embedding",
      latencyMs: Date.now() - start
    };
  }
  return {
    vector,
    promptTokens: json?.usage?.prompt_tokens ?? 0,
    latencyMs: Date.now() - start
  };
}

async function searchMilvus(
  env: CodebaseSearchEnv,
  vector: number[],
  topK: number,
  fetchImpl: typeof fetch = fetch
): Promise<
  | { hits: CodebaseSearchHit[]; collection: string; latencyMs: number }
  | { error: string; collection: string; latencyMs: number }
> {
  const collection = env.MILVUS_COLLECTION?.trim() || DEFAULT_COLLECTION;
  const { url, body } = buildMilvusSearchRequest(
    env.MILVUS_ADDRESS ?? "",
    collection,
    vector,
    topK
  );
  const start = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MILVUS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err: unknown) {
    return {
      error: `Milvus search fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      collection,
      latencyMs: Date.now() - start
    };
  }
  if (!res.ok) {
    const txt = (await res.text().catch(() => "")).slice(0, 200);
    return {
      error: `Milvus search HTTP ${res.status}: ${txt}`,
      collection,
      latencyMs: Date.now() - start
    };
  }
  const json = await res.json().catch(() => null);
  return {
    hits: parseMilvusSearchResponse(json),
    collection,
    latencyMs: Date.now() - start
  };
}

/**
 * Main runtime entry point — embed query, vector-search Milvus,
 * return typed hits.
 *
 * Optional `fetchImpl` lets tests inject a mock. In production the
 * caller passes nothing and the global `fetch` is used.
 */
export async function searchCodebase(
  env: CodebaseSearchEnv,
  query: string,
  topK: number = DEFAULT_TOP_K,
  fetchImpl: typeof fetch = fetch
): Promise<CodebaseSearchResult> {
  const missing = getMissingCodebaseSearchVars(env);
  if (missing.length > 0) {
    return {
      available: false,
      hits: [],
      reason: `missing ${missing.join(", ")}`
    };
  }
  if (!query?.trim()) {
    return { available: true, hits: [], reason: "empty query" };
  }
  const embed = await embedQuery(env, query.trim(), fetchImpl);
  const openaiStat: CodebaseSearchStats["openai"] =
    "error" in embed
      ? {
          model: "text-embedding-3-small",
          promptTokens: 0,
          latencyMs: embed.latencyMs,
          status: "error",
          errorReason: embed.error
        }
      : {
          model: "text-embedding-3-small",
          promptTokens: embed.promptTokens,
          latencyMs: embed.latencyMs,
          status: "ok"
        };
  if ("error" in embed) {
    return {
      available: true,
      hits: [],
      reason: embed.error,
      stats: { openai: openaiStat, milvus: null }
    };
  }
  const search = await searchMilvus(env, embed.vector, topK, fetchImpl);
  const milvusStat: CodebaseSearchStats["milvus"] =
    "error" in search
      ? {
          collection: search.collection,
          hits: 0,
          latencyMs: search.latencyMs,
          status: "error",
          errorReason: search.error
        }
      : {
          collection: search.collection,
          hits: search.hits.length,
          latencyMs: search.latencyMs,
          status: "ok"
        };
  if ("error" in search) {
    return {
      available: true,
      hits: [],
      reason: search.error,
      stats: { openai: openaiStat, milvus: milvusStat }
    };
  }
  return {
    available: true,
    hits: search.hits,
    stats: { openai: openaiStat, milvus: milvusStat }
  };
}

/**
 * Runtime indexing is intentionally NOT done in the worker — the
 * codebase indexer (`scripts/index-codebase.mjs`) runs as a GitHub
 * Action on every push to main, using `@zilliz/claude-context-core`
 * in Node. This stub exists so the runtime API surface is a
 * complete `{ searchCodebase, indexCodebase }` pair per the spec,
 * and so any caller that tried to trigger an in-worker reindex
 * (which would fail) gets a clear no-op + reason instead of a
 * runtime crash.
 *
 * If the operator wants on-demand reindexing from the worker, the
 * correct path is to dispatch the GitHub workflow via the existing
 * `GITHUB_TOKEN_SECRET` — not to bundle tree-sitter into V8.
 */
export async function indexCodebase(): Promise<{
  triggered: boolean;
  reason: string;
}> {
  return {
    triggered: false,
    reason:
      "in-worker indexing is unavailable (tree-sitter + native deps don't run in CF Workers); indexing runs in CI via scripts/index-codebase.mjs on push to main. Trigger a manual reindex by re-running the .github/workflows/index-codebase.yml workflow."
  };
}
