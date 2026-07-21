-- Skills catalog mirror of agentskill.sh.
-- Filled by:
--   1. POST /api/skills/seed-local  → seeds the 15 .claude/skills/<name>/SKILL.md
--      files shipped with this repo under owner = "local".
--   2. Cron-triggered producer + Queue consumer (src/skills/producer.ts,
--      src/skills/consumer.ts) that crawls all 107k+ rows from
--      https://agentskill.sh/api/skills.

CREATE TABLE skills (
  id            TEXT PRIMARY KEY,
  owner         TEXT NOT NULL,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT,
  source_url    TEXT,
  github_owner  TEXT,
  github_repo   TEXT,
  github_branch TEXT,
  github_path   TEXT,
  latest_sha    TEXT,
  metadata_json TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(owner, slug)
);

CREATE TABLE skill_versions (
  skill_id    TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  content_sha TEXT NOT NULL,
  skill_md    TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (skill_id, content_sha)
);

CREATE TABLE crawl_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE crawl_errors (
  skill_id    TEXT,
  page        INTEGER,
  error       TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX idx_skills_category ON skills(category);
CREATE INDEX idx_skills_owner    ON skills(owner);
CREATE INDEX idx_skill_versions_sha ON skill_versions(content_sha);
