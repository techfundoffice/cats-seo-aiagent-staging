-- Cat A–Z catalog cursor and the ASIN attached to a scout keyword.
-- The refill tick also creates these at runtime (CREATE/ALTER are idempotent
-- there). This migration is the schema of record for KEYWORDS_DB.

ALTER TABLE scout_keywords ADD COLUMN asin TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS cat_az_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  letter TEXT NOT NULL DEFAULT 'A'
);

INSERT OR IGNORE INTO cat_az_cursor (id, letter) VALUES (1, 'A');

CREATE TABLE IF NOT EXISTS cat_az_seen_asin (
  asin TEXT PRIMARY KEY,
  letter TEXT NOT NULL,
  disposition TEXT NOT NULL
);
