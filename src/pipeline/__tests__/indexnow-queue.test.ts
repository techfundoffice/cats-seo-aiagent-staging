import { describe, expect, it } from "vitest";
import type { SEOArticleAgent } from "../../server";
import { drainIndexNowPending, enqueueIndexNowPending } from "../indexing";

// IndexNow backfill queue. When IndexNow is degraded (site-verification
// 403, key-not-found 422, transient network failure), the publish-time
// notify enqueues the URL into a KV-backed pending queue. On the next
// successful notify the queue drains opportunistically. The end-to-end
// invariant: NO URL is lost during an outage, and recovery is
// automatic (no manual reprocess).

type KvStore = Map<string, string>;

function makeFakeAgent(
  kv: KvStore,
  fetchImpl?: typeof fetch
): { agent: SEOArticleAgent; logs: string[] } {
  const logs: string[] = [];
  const agent = {
    envBindings: {
      ARTICLES_KV: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => {
          kv.set(k, v);
        }
      },
      DOMAIN: "catsluvus.com",
      INDEXNOW_KEY: "test-key"
    },
    log: (level: string, msg: string) => {
      logs.push(`${level}|${msg}`);
    }
  };
  // Wire the supplied fetch impl onto globalThis so notifyIndexNow's
  // bare `fetch` call hits our mock. Tests that only exercise the
  // queue helpers (enqueue/drain pure path) don't need this.
  if (fetchImpl) {
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl;
  }
  // Cast through unknown: the production SEOArticleAgent type has
  // 200+ fields the helpers don't touch. The helpers only access
  // `agent.envBindings.ARTICLES_KV.{get,put}` and `agent.log`.
  return { agent: agent as unknown as SEOArticleAgent, logs };
}

describe("enqueueIndexNowPending", () => {
  it("seeds an empty queue with the first URL", async () => {
    const kv: KvStore = new Map();
    const { agent } = makeFakeAgent(kv);
    await enqueueIndexNowPending(agent, "https://catsluvus.com/a");
    const raw = kv.get("indexnow-pending-queue");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe("https://catsluvus.com/a");
    expect(typeof parsed[0].queuedAt).toBe("string");
  });

  it("dedupes — same URL twice produces ONE queue entry", async () => {
    const kv: KvStore = new Map();
    const { agent } = makeFakeAgent(kv);
    await enqueueIndexNowPending(agent, "https://catsluvus.com/a");
    await enqueueIndexNowPending(agent, "https://catsluvus.com/a");
    await enqueueIndexNowPending(agent, "https://catsluvus.com/a");
    const parsed = JSON.parse(kv.get("indexnow-pending-queue") as string);
    expect(parsed).toHaveLength(1);
  });

  it("preserves insertion order across multiple URLs", async () => {
    const kv: KvStore = new Map();
    const { agent } = makeFakeAgent(kv);
    await enqueueIndexNowPending(agent, "https://catsluvus.com/a");
    await enqueueIndexNowPending(agent, "https://catsluvus.com/b");
    await enqueueIndexNowPending(agent, "https://catsluvus.com/c");
    const parsed = JSON.parse(kv.get("indexnow-pending-queue") as string);
    expect(parsed.map((e: { url: string }) => e.url)).toEqual([
      "https://catsluvus.com/a",
      "https://catsluvus.com/b",
      "https://catsluvus.com/c"
    ]);
  });

  it("survives a corrupted/non-array KV value by re-seeding the queue", async () => {
    const kv: KvStore = new Map([["indexnow-pending-queue", "not json {"]]);
    const { agent } = makeFakeAgent(kv);
    await enqueueIndexNowPending(agent, "https://catsluvus.com/recover");
    const parsed = JSON.parse(kv.get("indexnow-pending-queue") as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe("https://catsluvus.com/recover");
  });
});

describe("drainIndexNowPending", () => {
  it("empty queue → no-op (0 attempted / 0 succeeded / 0 remaining)", async () => {
    const kv: KvStore = new Map();
    // Provide a fetch that would 200 if invoked — proves the drain
    // exits before making any network call when the queue is empty.
    let fetchInvocations = 0;
    const { agent } = makeFakeAgent(kv, async () => {
      fetchInvocations++;
      return new Response("ok", { status: 200 });
    });
    const r = await drainIndexNowPending(agent);
    expect(r).toEqual({ attempted: 0, succeeded: 0, remaining: 0 });
    expect(fetchInvocations).toBe(0);
  });

  it("drains up to `max` URLs; succeeded ones disappear, failed ones stay", async () => {
    const kv: KvStore = new Map();
    // Pre-populate the queue with 5 URLs.
    kv.set(
      "indexnow-pending-queue",
      JSON.stringify(
        [1, 2, 3, 4, 5].map((i) => ({
          url: `https://catsluvus.com/${i}`,
          queuedAt: "2026-05-30T00:00:00.000Z"
        }))
      )
    );
    // Fetch impl: succeed on urls ending /1, /2, /3, fail on /4, /5.
    // The production call is fetch(url, { body: JSON.stringify(...) }),
    // so we read urlList from the second-arg `init.body`.
    const { agent } = makeFakeAgent(
      kv,
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const u: string = body.urlList?.[0] ?? "";
        const ok = /\/(1|2|3)$/.test(u);
        return new Response(ok ? "ok" : "fail", { status: ok ? 200 : 503 });
      }
    );
    const r = await drainIndexNowPending(agent, 5);
    expect(r.attempted).toBe(5);
    expect(r.succeeded).toBe(3);
    expect(r.remaining).toBe(2);
    // Failed URLs are still in the queue.
    const parsed = JSON.parse(kv.get("indexnow-pending-queue") as string);
    const remainingUrls = parsed.map((e: { url: string }) => e.url);
    expect(remainingUrls).toContain("https://catsluvus.com/4");
    expect(remainingUrls).toContain("https://catsluvus.com/5");
    expect(remainingUrls).not.toContain("https://catsluvus.com/1");
  });

  it("respects the batch cap (default 3) — only 3 URLs attempted even if 10 queued", async () => {
    const kv: KvStore = new Map();
    kv.set(
      "indexnow-pending-queue",
      JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({
          url: `https://catsluvus.com/${i}`,
          queuedAt: "2026-05-30T00:00:00.000Z"
        }))
      )
    );
    let fetchInvocations = 0;
    const { agent } = makeFakeAgent(kv, async () => {
      fetchInvocations++;
      return new Response("ok", { status: 200 });
    });
    const r = await drainIndexNowPending(agent);
    expect(r.attempted).toBe(3);
    expect(r.succeeded).toBe(3);
    expect(r.remaining).toBe(7);
    expect(fetchInvocations).toBe(3);
  });
});

describe("queue invariant — no URL lost across a degraded → recovered cycle", () => {
  it("URLs enqueued during outage all surface to fetch when IndexNow recovers", async () => {
    const kv: KvStore = new Map();
    // Phase 1: outage — enqueue 7 URLs without ever fetching.
    const { agent } = makeFakeAgent(kv);
    for (let i = 0; i < 7; i++) {
      await enqueueIndexNowPending(agent, `https://catsluvus.com/${i}`);
    }
    expect(JSON.parse(kv.get("indexnow-pending-queue") as string)).toHaveLength(
      7
    );

    // Phase 2: recovery — drain repeatedly with a fetch that always
    // succeeds. After enough cycles, the queue must be empty AND
    // every URL must have been seen by fetch exactly once.
    const seen = new Set<string>();
    (globalThis as { fetch: typeof fetch }).fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const u: string = body.urlList?.[0] ?? "";
      seen.add(u);
      return new Response("ok", { status: 200 });
    };
    // Drain repeatedly until empty.
    for (let i = 0; i < 10; i++) {
      const r = await drainIndexNowPending(agent);
      if (r.remaining === 0 && r.attempted === 0) break;
    }
    expect(seen.size).toBe(7);
    for (let i = 0; i < 7; i++) {
      expect(seen.has(`https://catsluvus.com/${i}`)).toBe(true);
    }
  });
});
