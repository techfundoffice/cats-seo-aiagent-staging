-- Sitewide GSC page metrics — every page in the Search Analytics report,
-- not just articles present in article_ledger. Powers CTR triage and
-- striking-distance (position 5-15) optimization queries.

CREATE TABLE IF NOT EXISTS gsc_pages (
  page_url TEXT PRIMARY KEY,
  kv_key TEXT,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  ctr REAL,
  position REAL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gsc_pages_impressions ON gsc_pages(impressions DESC);
