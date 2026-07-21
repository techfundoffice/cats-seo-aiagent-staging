import type { SkillRow } from "./schema";

export interface SearchHit {
  id: string;
  name: string;
  description: string | null;
  owner: string;
  slug: string;
  source_url: string | null;
  score: number;
  snippet: string;
  skill_md: string | null;
}

export interface SearchResult {
  hits: SearchHit[];
  totalMatches: number;
  k: number;
  offset: number;
  hasMore: boolean;
}

type SearchCountValue = number | string | null | undefined;

export interface SearchOptions {
  /** Page size. Default 25, max 100. */
  k?: number;
  /** How many matches to skip before returning the page. Default 0. */
  offset?: number;
  /** Optional owner filter (e.g. "anthropic"). */
  owner?: string;
  /**
   * If true, include the full skill_md body for each hit (large).
   * Default true. Set false to get a skinny list for cheap browsing.
   */
  includeBody?: boolean;
}

/**
 * Paged BM25 search over the cats-seo-skills D1 catalog.
 *
 * Returns the page of hits + the *total* number of matches across the
 * entire FTS5 index, so the dashboard can render "Showing 1–25 of 312"
 * and offer pagination instead of capping users at the first k hits.
 */
export async function searchSkills(
  env: Env,
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult> {
  const kInput = opts.k;
  const k =
    typeof kInput === "number" && Number.isFinite(kInput)
      ? Math.min(Math.max(Math.trunc(kInput), 1), 100)
      : 25;
  const offsetInput = opts.offset;
  const offset =
    typeof offsetInput === "number" && Number.isFinite(offsetInput)
      ? Math.max(Math.trunc(offsetInput), 0)
      : 0;
  const includeBody = opts.includeBody ?? true;
  const owner = opts.owner?.trim();
  const cleaned = sanitizeQuery(query);
  if (!cleaned) {
    return { hits: [], totalMatches: 0, k, offset, hasMore: false };
  }

  // Apply the owner filter inside the FTS-ranked CTE, not after `LIMIT k`.
  // If we filtered after, a page could come back with fewer than k hits
  // whenever the top-k FTS matches don't all belong to the requested owner,
  // and the count query below would over-report total_matches.
  const useOwner = !!owner;
  const ownerJoin = useOwner ? `JOIN skills s ON s.id = f.skill_id` : ``;
  const ownerWhere = useOwner ? `AND s.owner = ?` : ``;
  const bodyExpr = includeBody
    ? `(SELECT skill_md FROM skill_versions WHERE skill_id = s.id ORDER BY fetched_at DESC LIMIT 1)`
    : `NULL`;
  const pageSql = `
        WITH ranked AS (
            SELECT
                f.skill_id AS id,
                bm25(skills_fts) AS bm,
                snippet(skills_fts, 3, '<mark>', '</mark>', '…', 24) AS snip
            FROM skills_fts f
            ${ownerJoin}
            WHERE skills_fts MATCH ?
            ${ownerWhere}
            ORDER BY bm
            LIMIT ? OFFSET ?
        )
        SELECT
            r.id, r.bm, r.snip,
            s.name, s.description, s.owner, s.slug, s.source_url,
            ${bodyExpr} AS skill_md
        FROM ranked r
        JOIN skills s ON s.id = r.id
        ORDER BY r.bm
    `;
  const pageParams: (string | number)[] = [cleaned];
  if (useOwner) pageParams.push(owner!);
  pageParams.push(k, offset);

  // Total-count query — same owner filter so the badge matches reality.
  const countSql = useOwner
    ? `SELECT COUNT(*) AS c
       FROM skills_fts f
       JOIN skills s ON s.id = f.skill_id
       WHERE skills_fts MATCH ? AND s.owner = ?`
    : `SELECT COUNT(*) AS c FROM skills_fts WHERE skills_fts MATCH ?`;
  const countParams: string[] = useOwner ? [cleaned, owner!] : [cleaned];

  const [pageRes, countRes] = await env.SKILLS_DB.batch([
    env.SKILLS_DB.prepare(pageSql).bind(...pageParams),
    env.SKILLS_DB.prepare(countSql).bind(...countParams)
  ]);

  const rows = (pageRes.results ?? []) as {
    id: string;
    bm: number;
    snip: string;
    name: string;
    description: string | null;
    owner: string;
    slug: string;
    source_url: string | null;
    skill_md: string | null;
  }[];
  const totalMatches = normalizeTotalMatches(
    (countRes.results?.[0] as { c?: SearchCountValue } | undefined)?.c
  );

  const hits = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    owner: r.owner,
    slug: r.slug,
    source_url: r.source_url,
    score: -r.bm,
    snippet: r.snip,
    skill_md: r.skill_md
  }));

  return {
    hits,
    totalMatches,
    k,
    offset,
    hasMore: offset + hits.length < totalMatches
  };
}

function normalizeTotalMatches(value: SearchCountValue): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 0;
  return parsed;
}

/**
 * Fetch one skill row plus its newest markdown body.
 *
 * Uses a correlated subquery so the latest `skill_versions` row is
 * resolved via indexed lookup for this one skill, avoiding the
 * memory-heavy window-function plan used by earlier implementations.
 */
export async function getSkillFull(
  env: Env,
  id: string
): Promise<(SkillRow & { skill_md: string | null }) | null> {
  // Correlated subquery for the body — single-row outer set means
  // the inner lookup hits the (skill_id, content_sha) PK index once.
  // Avoids ROW_NUMBER over the full skill_versions table, which OOMs.
  const sql = `
        SELECT s.*,
               (SELECT skill_md
                FROM skill_versions
                WHERE skill_id = s.id
                ORDER BY fetched_at DESC
                LIMIT 1) AS skill_md
        FROM skills s
        WHERE s.id = ?
    `;
  return await env.SKILLS_DB.prepare(sql).bind(id).first();
}

/**
 * FTS5 MATCH expects a query string with safe operators. Drop everything
 * that could break the parser (quotes, parens, colons, MATCH operators)
 * and turn the rest into a tokenized AND query so multi-word queries
 * behave like users expect.
 */
function sanitizeQuery(q: string): string {
  const trimmed = (q ?? "").trim();
  if (!trimmed) return "";
  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 64);
  if (!tokens.length) return "";
  // Wrap each token in double quotes so FTS5 treats it as a literal,
  // not a phrase or prefix operator. Trailing star = prefix match,
  // which is what most users actually want.
  return tokens.map((t) => `"${t}"*`).join(" ");
}
