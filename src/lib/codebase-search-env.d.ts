/**
 * Type augmentation for the three secrets the runtime codebase-search
 * module needs. Kept separate from the auto-generated `env.d.ts` at
 * the repo root so a future `wrangler types` regen doesn't drop them.
 *
 * Operator must set these on the worker via:
 *   wrangler secret put OPENAI_API_KEY
 *   wrangler secret put MILVUS_ADDRESS    (e.g. https://in03-xxx.zilliz.com)
 *   wrangler secret put MILVUS_TOKEN
 *
 * Optional:
 *   wrangler secret put MILVUS_COLLECTION (defaults to "code_chunks";
 *                                          must match the CI indexer's
 *                                          collection name)
 *
 * All four are optional in the type so the runtime can degrade
 * gracefully when any are absent.
 */
declare namespace Cloudflare {
  interface Env {
    OPENAI_API_KEY?: string;
    MILVUS_ADDRESS?: string;
    MILVUS_TOKEN?: string;
    MILVUS_COLLECTION?: string;
  }
}

export {};
