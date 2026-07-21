import type { SkillRow, SkillVersionRow } from "./schema";

/** Column values written to the `skills` D1 table on insert or update. */
export interface UpsertSkillInput {
  id: string;
  owner: string;
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  sourceUrl?: string | null;
  githubOwner?: string | null;
  githubRepo?: string | null;
  githubBranch?: string | null;
  githubPath?: string | null;
  latestSha?: string | null;
  metadataJson?: string | null;
}

/**
 * Insert or update a skill row in D1.
 *
 * Uses `INSERT … ON CONFLICT(id) DO UPDATE` so the call is idempotent —
 * re-crawling the same skill after a SKILL.md change simply overwrites the
 * mutable fields (`name`, `description`, `latest_sha`, etc.) while
 * preserving `created_at`.
 */
export async function upsertSkill(
  db: D1Database,
  input: UpsertSkillInput
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO skills (
                id, owner, slug, name, description, category, source_url,
                github_owner, github_repo, github_branch, github_path,
                latest_sha, metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                category = excluded.category,
                source_url = excluded.source_url,
                github_owner = excluded.github_owner,
                github_repo = excluded.github_repo,
                github_branch = excluded.github_branch,
                github_path = excluded.github_path,
                latest_sha = excluded.latest_sha,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at`
    )
    .bind(
      input.id,
      input.owner,
      input.slug,
      input.name,
      input.description ?? null,
      input.category ?? null,
      input.sourceUrl ?? null,
      input.githubOwner ?? null,
      input.githubRepo ?? null,
      input.githubBranch ?? null,
      input.githubPath ?? null,
      input.latestSha ?? null,
      input.metadataJson ?? null,
      now,
      now
    )
    .run();
}

/**
 * Record a new SKILL.md snapshot for `skillId` in `skill_versions`.
 *
 * Uses `INSERT OR IGNORE` so inserting the same `(skill_id, content_sha)`
 * pair a second time (e.g. on a re-crawl that found no changes) is a
 * no-op — the existing row is preserved and no duplicate is written.
 */
export async function recordVersion(
  db: D1Database,
  skillId: string,
  contentSha: string,
  skillMd: string
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO skill_versions (skill_id, content_sha, skill_md, fetched_at)
             VALUES (?, ?, ?, ?)`
    )
    .bind(skillId, contentSha, skillMd, Date.now())
    .run();
}

/**
 * Read a named crawl-state key from `crawl_state`.
 *
 * Returns the stored string value, or `null` when the key does not exist.
 * Used by `runCrawlTick` to read `next_page` (the next catalog page to
 * fetch) and `paused` (whether the crawler is administratively paused).
 */
export async function readCursor(
  db: D1Database,
  key: string
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM crawl_state WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Persist or overwrite a named crawl-state key in `crawl_state`.
 *
 * Uses `INSERT … ON CONFLICT(key) DO UPDATE` so the call is idempotent —
 * writing the same key twice simply replaces the previous value and bumps
 * `updated_at`.
 */
export async function writeCursor(
  db: D1Database,
  key: string,
  value: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO crawl_state (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, Date.now())
    .run();
}

/**
 * Append a crawl error to the `crawl_errors` audit table.
 *
 * `skillId` and `page` may be `null` when the error occurred outside a
 * per-skill or per-page context (e.g. a corrupt `next_page` cursor).
 * `error` is truncated to 500 characters before insert.
 */
export async function recordCrawlError(
  db: D1Database,
  skillId: string | null,
  page: number | null,
  error: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO crawl_errors (skill_id, page, error, occurred_at) VALUES (?, ?, ?, ?)`
    )
    .bind(skillId, page, error.slice(0, 500), Date.now())
    .run();
}

/**
 * Fetch a single skill row by its composite ID (`"<owner>/<slug>"`).
 *
 * Returns `null` when no matching row exists — callers should treat
 * `null` as "not yet crawled" rather than "does not exist in the catalog."
 */
export async function getSkillById(
  db: D1Database,
  id: string
): Promise<SkillRow | null> {
  return await db
    .prepare(`SELECT * FROM skills WHERE id = ?`)
    .bind(id)
    .first<SkillRow>();
}

/**
 * Fetch the most recently stored SKILL.md version for `skillId`.
 *
 * Orders by `fetched_at DESC` and returns only the newest row.
 * Returns `null` when no version has been fetched yet (e.g. the skill was
 * just upserted but its fetch job hasn't been processed from the queue).
 */
export async function getLatestVersion(
  db: D1Database,
  skillId: string
): Promise<SkillVersionRow | null> {
  return await db
    .prepare(
      `SELECT * FROM skill_versions
             WHERE skill_id = ?
             ORDER BY fetched_at DESC
             LIMIT 1`
    )
    .bind(skillId)
    .first<SkillVersionRow>();
}
