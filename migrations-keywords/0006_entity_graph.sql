-- Entity graph: cross-article memory for the SEO pipeline.
--
-- Motivation (measured 2026-07-26): 153 articles published from the
-- product catalog produced 23 keyword pairs with >=50% token overlap.
-- Three near-identical "soft cat carrier" articles went live in the same
-- category, all competing for one query. Nothing in the pipeline could
-- detect that, because every article is generated in isolation.
--
-- `keyword_ownership` is the fix: one (entity, intent) pair may have at
-- most one live owning article. The claim path consults it BEFORE
-- generating, so a duplicate is never written in the first place.
--
-- entities/aliases/edges/claims ship now so the later phases (fact reuse
-- in the writer prompt, graph-driven internal linking) need no further
-- migration. Only entities, entity_aliases and keyword_ownership are
-- read by the pipeline today.
--
-- HARD RULE: no Amazon prices in any table here. Amazon Associates
-- forbids storing or displaying them; `claim_key` must never be a price.

CREATE TABLE IF NOT EXISTS entities (
  -- Stable, human-readable, deterministic: "product:B07XYZ",
  -- "brand:petlibro", "category:cat-carriers-strollers".
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- product|brand|category|attribute|topic
  canonical_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  asin TEXT,
  attrs TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities (type);
CREATE INDEX IF NOT EXISTS idx_entities_asin ON entities (asin);
CREATE INDEX IF NOT EXISTS idx_entities_slug ON entities (slug);

-- Collapses size/colour variants and renames onto one canonical entity.
-- This is what the 137 product variants dropped at catalog import needed.
CREATE TABLE IF NOT EXISTS entity_aliases (
  alias_slug TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  alias_kind TEXT NOT NULL DEFAULT 'variant',
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity
  ON entity_aliases (entity_id);

CREATE TABLE IF NOT EXISTS entity_edges (
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL, -- variant_of|made_by|belongs_to|complements|competes_with|supersedes
  object_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'backfill',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subject_id, predicate, object_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_edges_object
  ON entity_edges (object_id, predicate);

-- Reusable verified facts. NEVER prices.
CREATE TABLE IF NOT EXISTS entity_claims (
  entity_id TEXT NOT NULL,
  claim_key TEXT NOT NULL,
  claim_value TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_verified TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity_id, claim_key)
);

CREATE INDEX IF NOT EXISTS idx_entity_claims_entity
  ON entity_claims (entity_id);

-- The cannibalization guard.
CREATE TABLE IF NOT EXISTS keyword_ownership (
  keyword_slug TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  intent TEXT NOT NULL, -- review|comparison|howto|buying-guide
  owning_kv_key TEXT NOT NULL DEFAULT '',
  owning_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'owned', -- owned|superseded|contested
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- At most ONE live owner per (entity, intent). Partial unique index:
-- superseded/contested rows are exempt so history is retained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_ownership_live
  ON keyword_ownership (entity_id, intent)
  WHERE status = 'owned';

CREATE INDEX IF NOT EXISTS idx_keyword_ownership_kv
  ON keyword_ownership (owning_kv_key);
