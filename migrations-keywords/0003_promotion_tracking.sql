-- Promotion-funnel tracking for the staging → production incubation
-- strategy. Serve-time counters incremented by the Worker fetch handler;
-- promotion state written by POST /api/admin/promote.

ALTER TABLE article_ledger ADD COLUMN googlebot_hits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE article_ledger ADD COLUMN human_views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE article_ledger ADD COLUMN last_crawled_at TEXT;
ALTER TABLE article_ledger ADD COLUMN promotion_status TEXT NOT NULL DEFAULT 'incubating';
ALTER TABLE article_ledger ADD COLUMN promoted_at TEXT;
ALTER TABLE article_ledger ADD COLUMN prod_url TEXT;
