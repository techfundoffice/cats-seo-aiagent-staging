-- Product database: live Amazon bestsellers per cat browse node.
-- Populated by the Top Seller sweep / admin imports. Keywords in
-- scout_keywords reference category_slug; products carry the real
-- per-ASIN data an article's single featured product is chosen from.
CREATE TABLE IF NOT EXISTS scout_products (
  asin TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  category_slug TEXT NOT NULL,
  category_name TEXT DEFAULT '',
  browse_node_id TEXT DEFAULT '',
  bestseller_rank INTEGER,
  rating REAL,
  review_count INTEGER,
  source TEXT NOT NULL DEFAULT 'apify-bestsellers',
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_category
  ON scout_products(category_slug, bestseller_rank ASC);
