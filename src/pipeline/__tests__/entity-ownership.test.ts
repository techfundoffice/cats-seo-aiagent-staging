import { describe, expect, it } from "vitest";
import {
  checkKeywordOwnership,
  recordKeywordOwnership
} from "../entity-ownership";

/**
 * Fake D1 with just enough behaviour to exercise the guard: a single
 * `keyword_ownership` table backed by a Map, honouring the live-owner
 * uniqueness on (entity_id, intent).
 */
function makeDb(opts: { throwOnSelect?: boolean } = {}) {
  const rows = new Map<
    string,
    {
      keyword_slug: string;
      entity_id: string;
      intent: string;
      owning_kv_key: string;
      owning_url: string;
      status: string;
    }
  >();
  const db = {
    rows,
    prepare(sql: string) {
      const binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds.push(...args);
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (opts.throwOnSelect) throw new Error("no such table");
          const [entityId, intent] = binds as [string, string];
          for (const r of rows.values()) {
            if (
              r.entity_id === entityId &&
              r.intent === intent &&
              r.status === "owned"
            ) {
              return r as unknown as T;
            }
          }
          return null;
        },
        async run() {
          if (sql.includes("SET status = 'superseded'")) {
            const [kvKey, entityId] = binds as [string, string];
            for (const r of rows.values()) {
              if (
                r.owning_kv_key === kvKey &&
                r.status === "owned" &&
                r.entity_id !== entityId
              ) {
                r.status = "superseded";
              }
            }
            return { success: true };
          }
          const [keywordSlug, entityId, intent, kvKey, url] = binds as [
            string,
            string,
            string,
            string,
            string
          ];
          // Enforce the partial unique index.
          for (const r of rows.values()) {
            if (
              r.entity_id === entityId &&
              r.intent === intent &&
              r.status === "owned" &&
              r.keyword_slug !== keywordSlug
            ) {
              throw new Error("UNIQUE constraint failed");
            }
          }
          rows.set(keywordSlug, {
            keyword_slug: keywordSlug,
            entity_id: entityId,
            intent,
            owning_kv_key: kvKey,
            owning_url: url,
            status: "owned"
          });
          return { success: true };
        }
      };
      return stmt;
    }
  };
  return db as unknown as D1Database & { rows: typeof rows };
}

describe("checkKeywordOwnership", () => {
  it("reports no duplicate against an empty table", async () => {
    const db = makeDb();
    const v = await checkKeywordOwnership(db, "petlibro fountain review");
    expect(v.duplicate).toBe(false);
    expect(v.entityId).toContain("topic:");
  });

  it("detects the live soft-carrier collision", async () => {
    const db = makeDb();
    await recordKeywordOwnership(db, {
      keyword: "cat carrier soft for pets up review",
      keywordSlug: "cat-carrier-soft-for-pets-up-review",
      kvKey: "cat-carriers-strollers:cat-carrier-soft-for-pets-up-review",
      url: "https://catsluvus.com/cat-carriers-strollers/cat-carrier-soft-for-pets-up-review"
    });
    // The permuted phrasing that actually shipped as a second article.
    const v = await checkKeywordOwnership(
      db,
      "soft cat carrier for pets up review"
    );
    expect(v.duplicate).toBe(true);
    expect(v.ownerKvKey).toContain("cat-carrier-soft-for-pets-up-review");
  });

  it("does NOT block a distinct SKU in the same family", async () => {
    const db = makeDb();
    await recordKeywordOwnership(db, {
      keyword: "hartz ultraguard pro flea & tick collar review",
      keywordSlug: "hartz-pro",
      kvKey: "cat-flea-tick-control:hartz-pro",
      url: "https://catsluvus.com/x/hartz-pro"
    });
    const v = await checkKeywordOwnership(
      db,
      "hartz ultraguard promax flea & tick collar review"
    );
    expect(v.duplicate).toBe(false);
  });

  it("does NOT block the same entity at a different intent", async () => {
    const db = makeDb();
    await recordKeywordOwnership(db, {
      keyword: "automatic litter box review",
      keywordSlug: "alb-review",
      kvKey: "cat-litter:alb-review",
      url: "https://catsluvus.com/cat-litter/alb-review"
    });
    const v = await checkKeywordOwnership(db, "best automatic litter box");
    expect(v.duplicate).toBe(false);
    expect(v.intent).toBe("buying-guide");
  });

  it("fails OPEN when the table is missing (pre-migration)", async () => {
    const db = makeDb({ throwOnSelect: true });
    const v = await checkKeywordOwnership(db, "anything review");
    expect(v.duplicate).toBe(false);
  });

  it("fails OPEN when no database is bound", async () => {
    const v = await checkKeywordOwnership(undefined, "anything review");
    expect(v.duplicate).toBe(false);
  });
});

describe("recordKeywordOwnership", () => {
  it("is idempotent for the same article", async () => {
    const db = makeDb();
    const args = {
      keyword: "petlibro fountain review",
      keywordSlug: "petlibro-fountain-review",
      kvKey: "cat-feeding:petlibro-fountain-review",
      url: "https://catsluvus.com/cat-feeding/petlibro-fountain-review"
    };
    const first = await recordKeywordOwnership(db, args);
    const second = await recordKeywordOwnership(db, args);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(db.rows.size).toBe(1);
  });

  it("loses the race gracefully rather than throwing", async () => {
    const db = makeDb();
    await recordKeywordOwnership(db, {
      keyword: "cat carrier soft review",
      keywordSlug: "winner",
      kvKey: "cat-carriers:winner",
      url: "https://catsluvus.com/cat-carriers/winner"
    });
    const loser = await recordKeywordOwnership(db, {
      keyword: "soft cat carrier review",
      keywordSlug: "loser",
      kvKey: "cat-carriers:loser",
      url: "https://catsluvus.com/cat-carriers/loser"
    });
    expect(loser.ok).toBe(false);
    expect(loser.error).toContain("UNIQUE");
  });

  it("reports failure (never throws) with no database", async () => {
    const r = await recordKeywordOwnership(undefined, {
      keyword: "x review",
      keywordSlug: "x",
      kvKey: "c:x",
      url: "https://example.com/x"
    });
    expect(r.ok).toBe(false);
  });
});

/**
 * Namespace symmetry. The claim-time guard runs before products are
 * fetched, so it can only produce `topic:<tokens>`. If the recorder keyed
 * ownership off the ASIN instead, the guard could never see it — measured
 * live on 2026-07-28: 230 `product:` rows vs 193 `topic:` rows, with the
 * guard matching only the backfilled `topic:` ones.
 */
describe("guard/recorder entity-namespace symmetry", () => {
  it("records under the SAME entity the guard will look up, even with an ASIN", async () => {
    const db = makeDb();
    const rec = await recordKeywordOwnership(db, {
      keyword: "petlibro granary stainless cat feeder review",
      keywordSlug: "petlibro-granary-stainless-cat-feeder-review",
      kvKey: "cat-feeding:petlibro-granary",
      url: "https://catsluvus.com/cat-feeding/petlibro-granary",
      asin: "B07KHPLFMS" // present at publish time, absent at claim time
    });
    expect(rec.ok).toBe(true);
    expect(rec.entityId.startsWith("topic:")).toBe(true);
    expect(rec.entityId).not.toContain("B07KHPLFMS");

    // The guard (which never has an ASIN) must now find it.
    const verdict = await checkKeywordOwnership(
      db,
      "stainless petlibro granary cat feeder review"
    );
    expect(verdict.duplicate).toBe(true);
    expect(verdict.ownerKvKey).toBe("cat-feeding:petlibro-granary");
  });

  it("never emits a product: namespace ownership row", async () => {
    const db = makeDb();
    await recordKeywordOwnership(db, {
      keyword: "some cat toy review",
      keywordSlug: "some-cat-toy-review",
      kvKey: "cat-toys:some",
      url: "https://catsluvus.com/cat-toys/some",
      asin: "B000ABCDEF"
    });
    for (const row of db.rows.values()) {
      expect(row.entity_id.startsWith("product:")).toBe(false);
    }
  });
});
