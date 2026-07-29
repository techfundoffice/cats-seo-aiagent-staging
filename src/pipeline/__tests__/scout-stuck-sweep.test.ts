import { describe, expect, it } from "vitest";
import {
  sweepStuckScoutKeywords,
  summarizeScoutStuckSweep,
  DEFAULT_STALE_MINUTES,
  DEFAULT_MAX_SWEEPS
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
  it("reconciles, abandons and requeues in that order", async () => {
    const { db, seen } = fakeDb((sql) => {
      if (/SET status = 'published'/.test(sql)) {
        return [{ slug: "reconciled-one" }];
      }
      if (/SET status = 'abandoned'/.test(sql)) {
        return [{ slug: "hopeless-one" }];
      }
      return [{ slug: "stranded-one" }];
    });
    const r = await sweepStuckScoutKeywords(db);
    expect(r.error).toBeUndefined();
    expect(r.reconciled).toEqual(["reconciled-one"]);
    expect(r.abandoned).toEqual(["hopeless-one"]);
    expect(r.requeued).toEqual(["stranded-one"]);
    expect(seen).toHaveLength(3);
    // Reconcile first — the requeue would otherwise flip those rows to
    // 'pending' and the ledger lookup would find nothing to adopt.
    expect(seen[0].sql).toMatch(/SET status = 'published'/);
    // Abandon before requeue — a row at its budget must be given up on,
    // not requeued one final time.
    expect(seen[1].sql).toMatch(/SET status = 'abandoned'/);
    expect(seen[2].sql).toMatch(/SET status = 'pending'/);
  });

  it("bounds requeues by the sweep budget and increments the counter", async () => {
    const { seen, db } = fakeDb(() => []);
    await sweepStuckScoutKeywords(db);
    const requeue = seen.find((s) => /SET status = 'pending'/.test(s.sql));
    expect(requeue?.sql).toMatch(/sweep_count = sweep_count \+ 1/);
    expect(requeue?.sql).toMatch(/sweep_count < \?2/);
    expect(requeue?.binds[1]).toBe(DEFAULT_MAX_SWEEPS);
    const abandon = seen.find((s) => /SET status = 'abandoned'/.test(s.sql));
    expect(abandon?.sql).toMatch(/sweep_count >= \?2/);
    expect(abandon?.binds[1]).toBe(DEFAULT_MAX_SWEEPS);
  });

  it("never abandons a row that actually produced an article", async () => {
    const { seen, db } = fakeDb(() => []);
    await sweepStuckScoutKeywords(db);
    const abandon = seen.find((s) => /SET status = 'abandoned'/.test(s.sql));
    expect(abandon?.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM article_ledger/);
  });

  it("honours a custom sweep budget", async () => {
    const { seen, db } = fakeDb(() => []);
    await sweepStuckScoutKeywords(db, { maxSweeps: 7 });
    for (const s of seen.filter((x) => /sweep_count/.test(x.sql))) {
      expect(s.binds[1]).toBe(7);
    }
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
    expect(r.abandoned).toEqual([]);
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
    expect(r.abandoned).toEqual([]);
  });
});

describe("summarizeScoutStuckSweep", () => {
  it("is empty when nothing moved", () => {
    expect(
      summarizeScoutStuckSweep({ requeued: [], reconciled: [], abandoned: [] })
    ).toBe("");
  });

  it("names all three remedies distinctly", () => {
    const s = summarizeScoutStuckSweep({
      requeued: ["a-review"],
      reconciled: ["b-review"],
      abandoned: ["c-review"]
    });
    expect(s).toMatch(/1 requeued to 'pending'/);
    expect(s).toMatch(/1 reconciled to 'published'/);
    expect(s).toMatch(/1 abandoned after exhausting the sweep budget/);
    expect(s).toMatch(/a-review/);
    expect(s).toMatch(/b-review/);
    expect(s).toMatch(/c-review/);
  });
});
