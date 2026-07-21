// D1-backed rewrite of the upstream better-sqlite3 lib/db.ts.
// All functions are now async because D1 is async. Callers must `await`.
// Backing store is env.DB, provided by the OpenNext Cloudflare adapter.
import { getCloudflareContext } from '@opennextjs/cloudflare';

function getDb(): D1Database {
  return getCloudflareContext().env.DB;
}

// --- Settings ---

export async function getSetting(key: string): Promise<string | null> {
  const row = await getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .bind(key, value)
    .run();
}

export async function deleteSetting(key: string): Promise<void> {
  await getDb().prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

// --- Credentials ---

export async function getCredentials(): Promise<{ login: string; pass: string } | null> {
  const login = await getSetting('dfs-login');
  const pass = await getSetting('dfs-pass');
  if (!login || !pass) return null;
  return { login, pass };
}

export async function saveCredentials(login: string, pass: string): Promise<void> {
  await setSetting('dfs-login', login);
  await setSetting('dfs-pass', pass);
}

export async function clearCredentials(): Promise<void> {
  await deleteSetting('dfs-login');
  await deleteSetting('dfs-pass');
}

// --- Target domains ---

export async function getTargetDomains(): Promise<string[]> {
  const { results } = await getDb()
    .prepare('SELECT domain FROM target_domains ORDER BY created_at DESC')
    .all<{ domain: string }>();
  return results.map((r) => r.domain);
}

export async function addTargetDomain(domain: string): Promise<void> {
  const clean = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  await getDb()
    .prepare('INSERT OR IGNORE INTO target_domains (domain, created_at) VALUES (?, ?)')
    .bind(clean, Date.now())
    .run();
}

export async function removeTargetDomain(domain: string): Promise<void> {
  await getDb().prepare('DELETE FROM target_domains WHERE domain = ?').bind(domain).run();
}

// --- SERP history ---

export interface TargetHit {
  domain: string;
  position: number;
}

export interface SerpHistoryEntry {
  id: string;
  ts: number;
  keyword: string;
  location: string;
  language: string;
  device: string;
  depth: number;
  count: number;
  targetHits?: TargetHit[];
}

export async function getSerpHistory(): Promise<SerpHistoryEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, keyword, location, language, device, depth, result_count, target_hits FROM serp_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; keyword: string; location: string; language: string; device: string; depth: number; result_count: number; target_hits: string | null }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, keyword: r.keyword, location: r.location, language: r.language,
    device: r.device, depth: r.depth, count: r.result_count,
    targetHits: r.target_hits ? JSON.parse(r.target_hits) : undefined
  }));
}

export async function saveSerpSearch<T>(entry: SerpHistoryEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO serp_searches (id, ts, keyword, location, language, device, depth, result_count, items, target_hits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.keyword, entry.location, entry.language, entry.device, entry.depth, entry.count, JSON.stringify(items), entry.targetHits ? JSON.stringify(entry.targetHits) : null)
    .run();
}

export async function getSerpResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM serp_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Keyword Data history ---

export interface KdHistoryEntry {
  id: string;
  ts: number;
  se: string;
  seType: string;
  label: string;
  count: number;
  cost?: number;
  params: Record<string, string>;
}

export async function getKdHistory(): Promise<KdHistoryEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, se, se_type, label, result_count, cost, params FROM kd_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; se: string; se_type: string; label: string; result_count: number; cost: number | null; params: string }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, se: r.se, seType: r.se_type, label: r.label,
    count: r.result_count, cost: r.cost ?? undefined, params: JSON.parse(r.params)
  }));
}

export async function saveKdSearch<T>(entry: KdHistoryEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO kd_searches (id, ts, se, se_type, label, result_count, cost, params, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.se, entry.seType, entry.label, entry.count, entry.cost ?? null, JSON.stringify(entry.params), JSON.stringify(items))
    .run();
}

export async function getKdResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM kd_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Local Finder history ---

export interface LfHistoryEntry {
  id: string;
  ts: number;
  keyword: string;
  location: string;
  count: number;
  cost?: number;
  params: Record<string, string>;
}

export async function getLfHistory(): Promise<LfHistoryEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, keyword, location, result_count, cost, params FROM lf_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; keyword: string; location: string; result_count: number; cost: number | null; params: string }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, keyword: r.keyword, location: r.location,
    count: r.result_count, cost: r.cost ?? undefined, params: JSON.parse(r.params)
  }));
}

export async function saveLfSearch<T>(entry: LfHistoryEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO lf_searches (id, ts, keyword, location, result_count, cost, params, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.keyword, entry.location, entry.count, entry.cost ?? null, JSON.stringify(entry.params), JSON.stringify(items))
    .run();
}

export async function getLfResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM lf_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- OnPage tasks ---

export interface OnpageTask {
  id: string;
  ts: number;
  url: string;
  target: string;
  status: 'pending' | 'in_progress' | 'finished' | 'error';
  cost?: number;
  errorMessage?: string;
}

export async function getOnpageTasks(): Promise<OnpageTask[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, url, target, status, cost, error_message FROM onpage_tasks ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; url: string; target: string; status: string; cost: number | null; error_message: string | null }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, url: r.url, target: r.target,
    status: r.status as OnpageTask['status'],
    cost: r.cost ?? undefined,
    errorMessage: r.error_message ?? undefined
  }));
}

export async function upsertOnpageTask(task: OnpageTask): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO onpage_tasks (id, ts, url, target, status, cost, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(task.id, task.ts, task.url, task.target, task.status, task.cost ?? null, task.errorMessage ?? null)
    .run();
}

export async function getOnpageResult<T>(taskId: string): Promise<T | null> {
  const row = await getDb().prepare('SELECT result FROM onpage_tasks WHERE id = ?').bind(taskId).first<{ result: string | null }>();
  if (!row?.result) return null;
  try { return JSON.parse(row.result) as T; } catch { return null; }
}

export async function saveOnpageResult<T>(taskId: string, result: T): Promise<void> {
  await getDb()
    .prepare('UPDATE onpage_tasks SET result = ?, status = ? WHERE id = ?')
    .bind(JSON.stringify(result), 'finished', taskId)
    .run();
}

// --- Ranked Keywords ---

export interface RankedKwSearchEntry {
  id: string;
  ts: number;
  target: string;
  location: string;
  language: string;
  count: number;
  totalCount: number;
  cost?: number;
}

export async function getRankedKwHistory(): Promise<RankedKwSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, target, location, language, result_count, total_count, cost FROM ranked_kw_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; target: string; location: string; language: string; result_count: number; total_count: number; cost: number | null }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, target: r.target, location: r.location, language: r.language,
    count: r.result_count, totalCount: r.total_count, cost: r.cost ?? undefined
  }));
}

export async function saveRankedKwSearch<T>(entry: RankedKwSearchEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO ranked_kw_searches (id, ts, target, location, language, result_count, total_count, cost, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.target, entry.location, entry.language, entry.count, entry.totalCount, entry.cost ?? null, JSON.stringify(items))
    .run();
}

export async function getRankedKwResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM ranked_kw_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Keyword Overview ---

export interface KwOverviewSearchEntry {
  id: string;
  ts: number;
  keywords: string;
  location: string;
  language: string;
  count: number;
  cost?: number;
}

export async function getKwOverviewHistory(): Promise<KwOverviewSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, keywords, location, language, result_count, cost FROM kw_overview_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; keywords: string; location: string; language: string; result_count: number; cost: number | null }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, keywords: r.keywords, location: r.location, language: r.language,
    count: r.result_count, cost: r.cost ?? undefined
  }));
}

export async function saveKwOverviewSearch<T>(entry: KwOverviewSearchEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO kw_overview_searches (id, ts, keywords, location, language, result_count, cost, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.keywords, entry.location, entry.language, entry.count, entry.cost ?? null, JSON.stringify(items))
    .run();
}

export async function getKwOverviewResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM kw_overview_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Backlinks ---

export interface BacklinksSearchEntry {
  id: string;
  ts: number;
  target: string;
  cost?: number;
  linksTotal?: number;
}

export async function getBacklinksHistory(): Promise<BacklinksSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, target, cost, links_total FROM backlinks_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; target: string; cost: number | null; links_total: number | null }>();
  return results.map((r) => ({ id: r.id, ts: r.ts, target: r.target, cost: r.cost ?? undefined, linksTotal: r.links_total ?? undefined }));
}

export async function saveBacklinksSearch<T, L>(entry: BacklinksSearchEntry, result: T, links?: L[], linksTotal?: number): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO backlinks_searches (id, ts, target, cost, result, links, links_total) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.target, entry.cost ?? null, JSON.stringify(result), links ? JSON.stringify(links) : null, linksTotal ?? null)
    .run();
}

export async function getBacklinksResult<T>(id: string): Promise<T | null> {
  const row = await getDb().prepare('SELECT result FROM backlinks_searches WHERE id = ?').bind(id).first<{ result: string }>();
  if (!row) return null;
  try { return JSON.parse(row.result) as T; } catch { return null; }
}

export async function getBacklinksLinks<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT links FROM backlinks_searches WHERE id = ?').bind(id).first<{ links: string | null }>();
  if (!row?.links) return null;
  try { return JSON.parse(row.links) as T[]; } catch { return null; }
}

// --- Competitors ---

export interface CompetitorsSearchEntry {
  id: string;
  ts: number;
  target: string;
  location: string;
  language: string;
  count: number;
  cost?: number;
}

export async function getCompetitorsHistory(): Promise<CompetitorsSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, target, location, language, result_count, cost FROM competitors_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; target: string; location: string; language: string; result_count: number; cost: number | null }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, target: r.target, location: r.location, language: r.language,
    count: r.result_count, cost: r.cost ?? undefined
  }));
}

export async function saveCompetitorsSearch<T>(entry: CompetitorsSearchEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO competitors_searches (id, ts, target, location, language, result_count, cost, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.target, entry.location, entry.language, entry.count, entry.cost ?? null, JSON.stringify(items))
    .run();
}

export async function getCompetitorsResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM competitors_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Rank Tracker ---

export interface TrackedKeyword {
  id: number;
  keyword: string;
  domain: string;
  location: string;
  language: string;
  createdAt: number;
}

export interface RankCheck {
  id: number;
  keywordId: number;
  checkedAt: number;
  date: string;
  position: number | null;
  url: string | null;
  title: string | null;
  cost: number | null;
}

export async function getTrackedKeywords(): Promise<TrackedKeyword[]> {
  const { results } = await getDb()
    .prepare('SELECT id, keyword, domain, location, language, created_at FROM tracked_keywords ORDER BY created_at DESC')
    .all<{ id: number; keyword: string; domain: string; location: string; language: string; created_at: number }>();
  return results.map((r) => ({ id: r.id, keyword: r.keyword, domain: r.domain, location: r.location, language: r.language, createdAt: r.created_at }));
}

export async function addTrackedKeyword(keyword: string, domain: string, location: string, language: string): Promise<number> {
  const k = keyword.trim();
  const d = domain.trim();
  const result = await getDb()
    .prepare('INSERT OR IGNORE INTO tracked_keywords (keyword, domain, location, language, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(k, d, location, language, Date.now())
    .run();
  if (result.meta.changes === 0) {
    const row = await getDb()
      .prepare('SELECT id FROM tracked_keywords WHERE keyword = ? AND domain = ? AND location = ? AND language = ?')
      .bind(k, d, location, language)
      .first<{ id: number }>();
    return row!.id;
  }
  return Number(result.meta.last_row_id);
}

export async function removeTrackedKeyword(id: number): Promise<void> {
  await getDb().prepare('DELETE FROM tracked_keywords WHERE id = ?').bind(id).run();
}

export async function saveRankCheck(keywordId: number, position: number | null, url: string | null, title: string | null, cost: number | null): Promise<void> {
  const now = Date.now();
  const date = new Date(now).toISOString().split('T')[0];
  const existing = await getDb()
    .prepare('SELECT id FROM rank_checks WHERE keyword_id = ? AND date = ?')
    .bind(keywordId, date)
    .first<{ id: number }>();
  if (existing) {
    await getDb()
      .prepare('UPDATE rank_checks SET checked_at = ?, position = ?, url = ?, title = ?, cost = ? WHERE id = ?')
      .bind(now, position, url, title, cost, existing.id)
      .run();
  } else {
    await getDb()
      .prepare('INSERT INTO rank_checks (keyword_id, checked_at, date, position, url, title, cost) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(keywordId, now, date, position, url, title, cost)
      .run();
  }
}

export async function getRankHistory(keywordId: number, days = 30): Promise<RankCheck[]> {
  const { results } = await getDb()
    .prepare('SELECT id, keyword_id, checked_at, date, position, url, title, cost FROM rank_checks WHERE keyword_id = ? ORDER BY date DESC LIMIT ?')
    .bind(keywordId, days)
    .all<{ id: number; keyword_id: number; checked_at: number; date: string; position: number | null; url: string | null; title: string | null; cost: number | null }>();
  return results.map((r) => ({ id: r.id, keywordId: r.keyword_id, checkedAt: r.checked_at, date: r.date, position: r.position, url: r.url, title: r.title, cost: r.cost }));
}

export async function getLatestRankCheck(keywordId: number): Promise<RankCheck | null> {
  const row = await getDb()
    .prepare('SELECT id, keyword_id, checked_at, date, position, url, title, cost FROM rank_checks WHERE keyword_id = ? ORDER BY date DESC LIMIT 1')
    .bind(keywordId)
    .first<{ id: number; keyword_id: number; checked_at: number; date: string; position: number | null; url: string | null; title: string | null; cost: number | null }>();
  if (!row) return null;
  return { id: row.id, keywordId: row.keyword_id, checkedAt: row.checked_at, date: row.date, position: row.position, url: row.url, title: row.title, cost: row.cost };
}

// --- Referring Domains ---

export interface RefDomainsSearchEntry {
  id: string;
  ts: number;
  target: string;
  cost?: number;
  total?: number;
}

export async function getRefDomainsHistory(): Promise<RefDomainsSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, target, cost, total FROM ref_domains_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; target: string; cost: number | null; total: number | null }>();
  return results.map((r) => ({ id: r.id, ts: r.ts, target: r.target, cost: r.cost ?? undefined, total: r.total ?? undefined }));
}

export async function saveRefDomainsSearch<T>(entry: RefDomainsSearchEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO ref_domains_searches (id, ts, target, cost, total, items) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.target, entry.cost ?? null, entry.total ?? null, JSON.stringify(items))
    .run();
}

export async function getRefDomainsResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM ref_domains_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Anchors ---

export interface AnchorsSearchEntry {
  id: string;
  ts: number;
  target: string;
  cost?: number;
  total?: number;
}

export async function getAnchorsHistory(): Promise<AnchorsSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, target, cost, total FROM anchors_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; target: string; cost: number | null; total: number | null }>();
  return results.map((r) => ({ id: r.id, ts: r.ts, target: r.target, cost: r.cost ?? undefined, total: r.total ?? undefined }));
}

export async function saveAnchorsSearch<T>(entry: AnchorsSearchEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO anchors_searches (id, ts, target, cost, total, items) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.target, entry.cost ?? null, entry.total ?? null, JSON.stringify(items))
    .run();
}

export async function getAnchorsResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM anchors_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Historical Rank Overview ---

export interface HistRankSearchEntry {
  id: string;
  ts: number;
  target: string;
  location: string;
  language: string;
  cost?: number;
}

export async function getHistRankHistory(): Promise<HistRankSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, target, location, language, cost FROM hist_rank_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; target: string; location: string; language: string; cost: number | null }>();
  return results.map((r) => ({ id: r.id, ts: r.ts, target: r.target, location: r.location, language: r.language, cost: r.cost ?? undefined }));
}

export async function saveHistRankSearch<T>(entry: HistRankSearchEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO hist_rank_searches (id, ts, target, location, language, cost, items) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.target, entry.location, entry.language, entry.cost ?? null, JSON.stringify(items))
    .run();
}

export async function getHistRankResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM hist_rank_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Domain Intersection ---

export interface DomainIntersectionSearchEntry {
  id: string;
  ts: number;
  target1: string;
  target2: string;
  location: string;
  language: string;
  count: number;
  totalCount: number;
  cost?: number;
}

export async function getDomainIntersectionHistory(): Promise<DomainIntersectionSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, target1, target2, location, language, result_count, total_count, cost FROM domain_intersection_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; target1: string; target2: string; location: string; language: string; result_count: number; total_count: number; cost: number | null }>();
  return results.map((r) => ({ id: r.id, ts: r.ts, target1: r.target1, target2: r.target2, location: r.location, language: r.language, count: r.result_count, totalCount: r.total_count, cost: r.cost ?? undefined }));
}

export async function saveDomainIntersectionSearch<T>(entry: DomainIntersectionSearchEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO domain_intersection_searches (id, ts, target1, target2, location, language, result_count, total_count, cost, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.target1, entry.target2, entry.location, entry.language, entry.count, entry.totalCount, entry.cost ?? null, JSON.stringify(items))
    .run();
}

export async function getDomainIntersectionResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM domain_intersection_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Keyword Difficulty ---

export interface KwDifficultySearchEntry {
  id: string;
  ts: number;
  keywords: string;
  location: string;
  language: string;
  count: number;
  cost?: number;
}

export async function getKwDifficultyHistory(): Promise<KwDifficultySearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, keywords, location, language, result_count, cost FROM kw_difficulty_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; keywords: string; location: string; language: string; result_count: number; cost: number | null }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, keywords: r.keywords, location: r.location, language: r.language,
    count: r.result_count, cost: r.cost ?? undefined
  }));
}

export async function saveKwDifficultySearch<T>(entry: KwDifficultySearchEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO kw_difficulty_searches (id, ts, keywords, location, language, result_count, cost, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.keywords, entry.location, entry.language, entry.count, entry.cost ?? null, JSON.stringify(items))
    .run();
}

export async function getKwDifficultyResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM kw_difficulty_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Related Keywords ---

export interface RelatedKwSearchEntry {
  id: string;
  ts: number;
  keyword: string;
  location: string;
  language: string;
  depth: number;
  count: number;
  cost?: number;
}

export async function getRelatedKwHistory(): Promise<RelatedKwSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, keyword, location, language, depth, result_count, cost FROM related_kw_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; keyword: string; location: string; language: string; depth: number; result_count: number; cost: number | null }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, keyword: r.keyword, location: r.location, language: r.language,
    depth: r.depth, count: r.result_count, cost: r.cost ?? undefined
  }));
}

export async function saveRelatedKwSearch<T>(entry: RelatedKwSearchEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO related_kw_searches (id, ts, keyword, location, language, depth, result_count, cost, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.keyword, entry.location, entry.language, entry.depth, entry.count, entry.cost ?? null, JSON.stringify(items))
    .run();
}

export async function getRelatedKwResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM related_kw_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Grid Search ---

export interface GridSearchEntry {
  id: string;
  ts: number;
  keyword: string;
  target: string;
  center: string;
  grid_size: number;
  spacing_km: number;
  language: string;
  cost?: number;
}

export interface GridLocalItem {
  rank_group: number;
  title: string;
  domain?: string;
  rating_value?: number;
  rating_votes?: number;
  is_target: boolean;
}

export interface GridPoint {
  row: number;
  col: number;
  lat?: number;
  lng?: number;
  rank: number | null;
  items?: GridLocalItem[];
}

export async function getGridHistory(): Promise<GridSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, keyword, target, center, grid_size, spacing_km, language, cost FROM grid_searches ORDER BY ts DESC LIMIT 20')
    .all<{ id: string; ts: number; keyword: string; target: string; center: string; grid_size: number; spacing_km: number; language: string; cost: number | null }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, keyword: r.keyword, target: r.target, center: r.center,
    grid_size: r.grid_size, spacing_km: r.spacing_km, language: r.language, cost: r.cost ?? undefined
  }));
}

export async function saveGridSearch(entry: GridSearchEntry, results: GridPoint[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO grid_searches (id, ts, keyword, target, center, grid_size, spacing_km, language, cost, results) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.keyword, entry.target, entry.center, entry.grid_size, entry.spacing_km, entry.language, entry.cost ?? null, JSON.stringify(results))
    .run();
}

export async function getGridResults(id: string): Promise<GridPoint[] | null> {
  const row = await getDb().prepare('SELECT results FROM grid_searches WHERE id = ?').bind(id).first<{ results: string }>();
  if (!row) return null;
  try { return JSON.parse(row.results) as GridPoint[]; } catch { return null; }
}

// --- Instant Pages ---

export interface InstantPageEntry {
  id: string;
  ts: number;
  url: string;
  cost?: number;
}

export async function getInstantPageHistory(): Promise<InstantPageEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, url, cost FROM instant_page_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; url: string; cost: number | null }>();
  return results.map((r) => ({ id: r.id, ts: r.ts, url: r.url, cost: r.cost ?? undefined }));
}

export async function saveInstantPageResult<T>(entry: InstantPageEntry, result: T): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO instant_page_searches (id, ts, url, cost, result) VALUES (?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.url, entry.cost ?? null, JSON.stringify(result))
    .run();
}

export async function getInstantPageResult<T>(id: string): Promise<T | null> {
  const row = await getDb().prepare('SELECT result FROM instant_page_searches WHERE id = ?').bind(id).first<{ result: string }>();
  if (!row) return null;
  try { return JSON.parse(row.result) as T; } catch { return null; }
}

// --- Reddit ---

export interface RedditSearchEntry {
  id: string;
  ts: number;
  targets: string;
  count: number;
  cost?: number;
}

export async function getRedditHistory(): Promise<RedditSearchEntry[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, targets, result_count, cost FROM reddit_searches ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; targets: string; result_count: number; cost: number | null }>();
  return results.map((r) => ({ id: r.id, ts: r.ts, targets: r.targets, count: r.result_count, cost: r.cost ?? undefined }));
}

export async function saveRedditSearch<T>(entry: RedditSearchEntry, items: T[]): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO reddit_searches (id, ts, targets, result_count, cost, items) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(entry.id, entry.ts, entry.targets, entry.count, entry.cost ?? null, JSON.stringify(items))
    .run();
}

export async function getRedditResults<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT items FROM reddit_searches WHERE id = ?').bind(id).first<{ items: string }>();
  if (!row) return null;
  try { return JSON.parse(row.items) as T[]; } catch { return null; }
}

// --- Google Reviews ---

export interface ReviewsTask {
  id: string;
  ts: number;
  business: string;
  location: string;
  language: string;
  depth: number;
  sortBy: string;
  status: 'pending' | 'ready' | 'error';
  cost?: number;
  resultCount?: number;
}

export async function saveReviewsTask(id: string, business: string, location: string, language: string, depth: number, sortBy: string, cost?: number): Promise<void> {
  await getDb()
    .prepare('INSERT OR REPLACE INTO reviews_tasks (id, ts, business, location, language, depth, sort_by, status, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, Date.now(), business, location, language, depth, sortBy, 'pending', cost ?? null)
    .run();
}

export async function getReviewsTasks(): Promise<ReviewsTask[]> {
  const { results } = await getDb()
    .prepare('SELECT id, ts, business, location, language, depth, sort_by, status, cost, result_count FROM reviews_tasks ORDER BY ts DESC LIMIT 30')
    .all<{ id: string; ts: number; business: string; location: string; language: string; depth: number; sort_by: string; status: string; cost: number | null; result_count: number | null }>();
  return results.map((r) => ({
    id: r.id, ts: r.ts, business: r.business, location: r.location, language: r.language,
    depth: r.depth, sortBy: r.sort_by, status: r.status as ReviewsTask['status'],
    cost: r.cost ?? undefined, resultCount: r.result_count ?? undefined
  }));
}

export async function updateReviewsTask(id: string, status: ReviewsTask['status'], items: unknown[], cost?: number, resultCount?: number): Promise<void> {
  await getDb()
    .prepare('UPDATE reviews_tasks SET status = ?, result = ?, cost = ?, result_count = ? WHERE id = ?')
    .bind(status, JSON.stringify(items), cost ?? null, resultCount ?? items.length, id)
    .run();
}

export async function getReviewsTaskResult<T>(id: string): Promise<T[] | null> {
  const row = await getDb().prepare('SELECT result FROM reviews_tasks WHERE id = ?').bind(id).first<{ result: string | null }>();
  if (!row?.result) return null;
  try { return JSON.parse(row.result) as T[]; } catch { return null; }
}
