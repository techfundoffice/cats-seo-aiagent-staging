-- CTR measurement: keep history, and judge every snippet rewrite.
--
-- Until now `gsc_pages` was INSERT OR REPLACE per sync and article_ledger's
-- gsc_* columns were UPDATEd in place, so each sync destroyed the previous
-- reading. The idle tick rewrites the title and meta description of live,
-- ranking production pages on a rolling basis — with no retained "before",
-- a rewrite that halved CTR was indistinguishable from one that doubled it.
--
-- gsc_page_history is the append-only record those comparisons need.
-- ctr_experiments is one row per applied rewrite: the before-window metrics
-- captured at apply time, and the after-window metrics filled in once the
-- 28-day Search Console window has fully turned over.

CREATE TABLE IF NOT EXISTS gsc_page_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_url TEXT NOT NULL,
  kv_key TEXT,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  ctr REAL,
  position REAL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gsc_history_kv_time
  ON gsc_page_history(kv_key, synced_at DESC);

CREATE TABLE IF NOT EXISTS ctr_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kv_key TEXT NOT NULL,
  page_url TEXT NOT NULL DEFAULT '',

  old_title TEXT NOT NULL DEFAULT '',
  new_title TEXT NOT NULL DEFAULT '',
  old_meta TEXT NOT NULL DEFAULT '',
  new_meta TEXT NOT NULL DEFAULT '',

  -- Search Console 28-day window as it stood when the rewrite shipped.
  before_impressions INTEGER NOT NULL DEFAULT 0,
  before_clicks INTEGER NOT NULL DEFAULT 0,
  before_ctr REAL,
  before_position REAL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Filled in by the resolver once a full window has passed.
  after_impressions INTEGER,
  after_clicks INTEGER,
  after_ctr REAL,
  after_position REAL,
  ctr_delta REAL,
  -- pending | improved | regressed | inconclusive | confounded
  outcome TEXT NOT NULL DEFAULT 'pending',
  outcome_detail TEXT NOT NULL DEFAULT '',
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ctr_experiments_pending
  ON ctr_experiments(outcome, applied_at);

CREATE INDEX IF NOT EXISTS idx_ctr_experiments_kv
  ON ctr_experiments(kv_key, applied_at DESC);
