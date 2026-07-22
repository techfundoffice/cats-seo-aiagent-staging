-- Scout database + article ledger (KEYWORDS_DB).
--
-- scout_keywords: the ONLY source of keywords for the scout. Rows arrive
-- via /api/admin/keywords/import (or a future DataForSEO refill-producer);
-- the scout claims pending rows and never invents keywords. Status flow:
-- pending -> generating -> published | failed | rejected.
--
-- article_ledger: one row per published article, written at publish time.
--
-- article_rankings: DataForSEO ranked-keywords snapshots per article,
-- mirrored from the analytics tick (same shape as the DO-private table,
-- but queryable/exportable here).

CREATE TABLE IF NOT EXISTS scout_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  category_slug TEXT NOT NULL,
  category_title TEXT DEFAULT '',
  volume INTEGER,
  cpc REAL,
  difficulty INTEGER,
  source TEXT NOT NULL DEFAULT 'import',
  status TEXT NOT NULL DEFAULT 'pending',
  priority REAL NOT NULL DEFAULT 0,
  kv_key TEXT DEFAULT '',
  error TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scout_status_priority
  ON scout_keywords(status, priority DESC, volume DESC);

CREATE TABLE IF NOT EXISTS article_ledger (
  kv_key TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  keyword TEXT NOT NULL,
  category_slug TEXT NOT NULL,
  url TEXT NOT NULL,
  seo_score INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  product_count INTEGER DEFAULT 0,
  competitor_url TEXT DEFAULT '',
  keyword_volume INTEGER,
  keyword_cpc REAL,
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_category
  ON article_ledger(category_slug, published_at DESC);

CREATE TABLE IF NOT EXISTS article_rankings (
  kv_key TEXT NOT NULL,
  keyword TEXT NOT NULL,
  date TEXT NOT NULL,
  position INTEGER NOT NULL,
  search_volume INTEGER DEFAULT 0,
  est_traffic REAL DEFAULT 0,
  cpc REAL DEFAULT 0,
  serp_features TEXT DEFAULT '',
  country TEXT NOT NULL DEFAULT 'US',
  PRIMARY KEY (kv_key, keyword, date, country)
);
CREATE INDEX IF NOT EXISTS idx_d1_rank_kv_date
  ON article_rankings(kv_key, date DESC);
