-- D1 schema for seo-playground. Ported verbatim from src/lib/db.ts
-- (paulmassen/seo-playground @ 3bb182869f48a39724edfa2f9567d2b9ce9db8dd).
-- Apply with: npx wrangler d1 execute cats-seo-playground --remote --file=./migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS serp_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  location TEXT NOT NULL,
  language TEXT NOT NULL,
  device TEXT NOT NULL,
  depth INTEGER NOT NULL,
  result_count INTEGER NOT NULL,
  items TEXT NOT NULL,
  target_hits TEXT
);

CREATE TABLE IF NOT EXISTS kd_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  se TEXT NOT NULL,
  se_type TEXT NOT NULL,
  label TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  cost REAL,
  params TEXT NOT NULL,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lf_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  location TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  cost REAL,
  params TEXT NOT NULL,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS target_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kw_overview_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  keywords TEXT NOT NULL,
  location TEXT NOT NULL,
  language TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  cost REAL,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backlinks_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  cost REAL,
  result TEXT NOT NULL,
  links TEXT,
  links_total INTEGER
);

CREATE TABLE IF NOT EXISTS competitors_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  location TEXT NOT NULL,
  language TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  cost REAL,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ranked_kw_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  location TEXT NOT NULL,
  language TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  cost REAL,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onpage_tasks (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  url TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  cost REAL,
  error_message TEXT,
  result TEXT
);

CREATE TABLE IF NOT EXISTS tracked_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  domain TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'France',
  language TEXT NOT NULL DEFAULT 'fr',
  created_at INTEGER NOT NULL,
  UNIQUE(keyword, domain, location, language)
);

CREATE TABLE IF NOT EXISTS rank_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id INTEGER NOT NULL REFERENCES tracked_keywords(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  date TEXT NOT NULL,
  position INTEGER,
  url TEXT,
  title TEXT,
  cost REAL
);

CREATE TABLE IF NOT EXISTS ref_domains_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  cost REAL,
  total INTEGER,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anchors_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  cost REAL,
  total INTEGER,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hist_rank_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  location TEXT NOT NULL,
  language TEXT NOT NULL,
  cost REAL,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_intersection_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  target1 TEXT NOT NULL,
  target2 TEXT NOT NULL,
  location TEXT NOT NULL,
  language TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  cost REAL,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kw_difficulty_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  keywords TEXT NOT NULL,
  location TEXT NOT NULL,
  language TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  cost REAL,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS related_kw_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  location TEXT NOT NULL,
  language TEXT NOT NULL,
  depth INTEGER NOT NULL,
  result_count INTEGER NOT NULL,
  cost REAL,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grid_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  target TEXT NOT NULL,
  center TEXT NOT NULL,
  grid_size INTEGER NOT NULL,
  spacing_km REAL NOT NULL,
  language TEXT NOT NULL,
  cost REAL,
  results TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instant_page_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  url TEXT NOT NULL,
  cost REAL,
  result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reddit_searches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  targets TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  cost REAL,
  items TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews_tasks (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  business TEXT NOT NULL,
  location TEXT NOT NULL,
  language TEXT NOT NULL,
  depth INTEGER NOT NULL,
  sort_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  cost REAL,
  result_count INTEGER,
  result TEXT
);

CREATE INDEX IF NOT EXISTS idx_rank_checks_kw ON rank_checks(keyword_id, checked_at DESC);
