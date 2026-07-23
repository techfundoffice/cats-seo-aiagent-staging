-- Google Search Console performance metrics per article, synced by
-- POST /api/admin/gsc-sync (Search Analytics API, last-28-day window).

ALTER TABLE article_ledger ADD COLUMN gsc_impressions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE article_ledger ADD COLUMN gsc_clicks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE article_ledger ADD COLUMN gsc_ctr REAL;
ALTER TABLE article_ledger ADD COLUMN gsc_position REAL;
ALTER TABLE article_ledger ADD COLUMN gsc_last_sync TEXT;
