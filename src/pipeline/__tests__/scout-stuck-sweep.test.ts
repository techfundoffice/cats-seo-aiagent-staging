import { describe, expect, it } from "vitest";
import {
  sweepStuckScoutKeywords,
  summarizeScoutStuckSweep,
  DEFAULT_STALE_MINUTES
} from "../scout-stuck-sweep";

/** Minimal D1 stub recording the SQL it is handed. */
function fakeDb(
  responder: (sql: string, binds: unknown[]) => { slug: string }[]
) {
  const seen: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all<T>() {
              seen.push({ sql, binds });
              return { results: responder(sql, binds) as T[] };
            }
          };
        }
      };
    }
  } as unknown as D1Database;
  return { db, seen };
}

describe("sweepStuckScoutKeywords", () => {
  it("requeues a stranded row and reconciles a lost write-back", async () => {
    const { db, seen } = fakeDb((sql) =>
      /SET status = 'published'/.test(sql)
        ? [{ slug: "reconciled-one" }]
        : [{ slug: "stranded-one" }]
    );
    const r = await sweepStuckScoutKeywords(db);
    expect(r.error).toBeUndefined();
    expect(r.reconciled).toEqual(["reconciled-one"]);
    expect(r.requeued).toEqual(["stranded-one"]);
    expect(seen).toHaveLength(2);
    // Reconcile must run first — the requeue would otherwise flip those
    // rows to 'pending' and the ledger lookup would find nothing.
    expect(seen[0].sql).toMatch(/SET status = 'published'/);
    expect(seen[1].sql).toMatch(/SET status = 'pending'/);
  });

  it("requeues only rows with NO ledger entry", async () => {
    const { seen, db } = fakeDb(() => []);
    await sweepStuckScoutKeywords(db);
    const requeue = seen.find((s) => /SET status = 'pending'/.test(s.sql));
    expect(requeue?.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM article_ledger/);
  });

  it("reconciles only rows that DO have a ledger entry", async () => {
    const { seen, db } = fakeDb(() => []);
    await sweepStuckScoutKeywords(db);
    const rec = seen.find((s) => /SET status = 'published'/.test(s.sql));
    expect(rec?.sql).toMatch(/AND EXISTS \(SELECT 1 FROM article_ledger/);
    expect(rec?.sql).toMatch(/kv_key = \(SELECT kv_key FROM article_ledger/);
  });

  it("leaves rows younger than the stale window alone", async () => {
    const { seen, db } = fakeDb(() => []);
    await sweepStuckScoutKeywords(db);
    for (const s of seen) {
      expect(s.sql).toMatch(/claimed_at <= datetime\('now', \?1\)/);
      expect(s.binds[0]).toBe(`-${DEFAULT_STALE_MINUTES} minutes`);
    }
  });

  it("honours a custom stale window", async () => {
    const { seen, db } = fakeDb(() => []);
    await sweepStuckScoutKeywords(db, { staleMinutes: 90 });
    expect(seen[0].binds[0]).toBe("-90 minutes");
  });

  it("never sweeps a row with a null claimed_at", async () => {
    const { seen, db } = fakeDb(() => []);
    await sweepStuckScoutKeywords(db);
    for (const s of seen) expect(s.sql).toMatch(/claimed_at IS NOT NULL/);
  });

  it("reports a missing binding instead of throwing", async () => {
    const r = await sweepStuckScoutKeywords(undefined);
    expect(r.error).toMatch(/KEYWORDS_DB/);
    expect(r.requeued).toEqual([]);
  });

  it("swallows a D1 error and reports it", async () => {
    const db = {
      prepare() {
        throw new Error("D1_ERROR: no such table");
      }
    } as unknown as D1Database;
    const r = await sweepStuckScoutKeywords(db);
    expect(r.error).toMatch(/no such table/);
    expect(r.requeued).toEqual([]);
    expect(r.reconciled).toEqual([]);
  });
});

describe("summarizeScoutStuckSweep", () => {
  it("is empty when nothing moved", () => {
    expect(summarizeScoutStuckSweep({ requeued: [], reconciled: [] })).toBe("");
  });

  it("names both remedies distinctly", () => {
    const s = summarizeScoutStuckSweep({
      requeued: ["a-review"],
      reconciled: ["b-review"]
    });
    expect(s).toMatch(/1 requeued to 'pending'/);
    expect(s).toMatch(/1 reconciled to 'published'/);
    expect(s).toMatch(/a-review/);
    expect(s).toMatch(/b-review/);
  });
});
