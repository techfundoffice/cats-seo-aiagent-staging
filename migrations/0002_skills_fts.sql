-- FTS5 search over skills + their SKILL.md bodies.
--
-- One-shot migration. The virtual table is rebuilt from scratch each
-- time it runs (DROP + CREATE) so the migration is idempotent. We
-- keep it in sync going forward via UPSERT calls in the consumer +
-- /api/skills/install code paths (see src/skills/db.ts: indexFts()).
--
-- We only index the first 4096 chars of each SKILL.md body. That's
-- enough to capture the YAML frontmatter (name/description/triggers)
-- + the lead paragraphs, and keeps the FTS index from ballooning past
-- D1's per-database storage tier.

DROP TABLE IF EXISTS skills_fts;
CREATE VIRTUAL TABLE skills_fts USING fts5(
    skill_id UNINDEXED,
    name,
    description,
    body,
    tokenize = 'porter unicode61 remove_diacritics 1'
);

-- Populate from the existing skills + skill_versions tables. We pick
-- the most recently fetched version per skill via the JOIN with
-- skill_versions_latest (a CTE-style subquery).
INSERT INTO skills_fts (skill_id, name, description, body)
SELECT
    s.id,
    COALESCE(s.name, ''),
    COALESCE(s.description, ''),
    SUBSTR(COALESCE(sv.skill_md, ''), 1, 4096)
FROM skills s
LEFT JOIN (
    SELECT skill_id, skill_md,
           ROW_NUMBER() OVER (PARTITION BY skill_id ORDER BY fetched_at DESC) AS rn
    FROM skill_versions
) sv ON sv.skill_id = s.id AND sv.rn = 1;
