#!/usr/bin/env node
/**
 * Codebase indexer — runs in CI on every push to main.
 *
 * Walks the repo, chunks source files, embeds each chunk via OpenAI,
 * and upserts into the Milvus collection that the worker's runtime
 * `searchCodebase()` queries.
 *
 * NOT a Cloudflare Worker — runs in plain Node so it can use
 * `@zilliz/claude-context-core` (which depends on tree-sitter,
 * milvus2-sdk-node, and other Node-native libs that don't bundle for
 * V8 isolates).
 *
 * Env required (same names as the worker side so the operator only
 * sets each secret once at the GitHub Actions level too):
 *   OPENAI_API_KEY
 *   MILVUS_ADDRESS         (e.g. https://in03-xxx.zilliz.com)
 *   MILVUS_TOKEN
 *   MILVUS_COLLECTION      (optional; defaults to "code_chunks")
 *
 * Exit codes:
 *   0  indexing completed
 *   1  required env var missing
 *   2  index step threw
 */

const COLLECTION = process.env.MILVUS_COLLECTION?.trim() || "code_chunks";

function fail(reason, exitCode = 1) {
  console.error(`[indexer] FAIL: ${reason}`);
  process.exit(exitCode);
}

const required = ["OPENAI_API_KEY", "MILVUS_ADDRESS", "MILVUS_TOKEN"];
const missing = required.filter((k) => !process.env[k]?.trim());
if (missing.length > 0) {
  fail(`missing required env var(s): ${missing.join(", ")}`);
}

let context;
try {
  // Dynamic import so a missing devDep produces a clear error rather
  // than a top-level module-resolution crash.
  context = await import("@zilliz/claude-context-core");
} catch (err) {
  fail(
    `@zilliz/claude-context-core not installed (run \`npm i -D @zilliz/claude-context-core\`): ${err?.message ?? err}`,
    1
  );
}

const { Context, OpenAIEmbedding, MilvusVectorDatabase } = context;

if (!Context || !OpenAIEmbedding || !MilvusVectorDatabase) {
  fail(
    "@zilliz/claude-context-core exports changed; expected Context, OpenAIEmbedding, MilvusVectorDatabase",
    2
  );
}

console.log(
  `[indexer] starting — collection=${COLLECTION}, address=${process.env.MILVUS_ADDRESS}`
);

try {
  const embedding = new OpenAIEmbedding({
    apiKey: process.env.OPENAI_API_KEY,
    model: "text-embedding-3-small"
  });
  const vectorDatabase = new MilvusVectorDatabase({
    address: process.env.MILVUS_ADDRESS,
    token: process.env.MILVUS_TOKEN
  });
  const ctx = new Context({
    embedding,
    vectorDatabase,
    collectionName: COLLECTION
  });
  // Index the repo from `src/` only — node_modules, dist, .git, public
  // are excluded by claude-context's default ignore set.
  const result = await ctx.indexCodebase(process.cwd());
  console.log(
    `[indexer] complete — files=${result?.fileCount ?? "?"} chunks=${result?.chunkCount ?? "?"}`
  );
  process.exit(0);
} catch (err) {
  fail(`indexing threw: ${err?.message ?? err}\n${err?.stack ?? ""}`, 2);
}
