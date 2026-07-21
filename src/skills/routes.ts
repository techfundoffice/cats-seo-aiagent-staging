import { errMsg } from "../pipeline/http-utils";
import { parseObjectLike } from "../objectLike";
import {
  buildSkillFetchJob,
  fetchSkillMd,
  SkillFetchHttpError,
  listSkillsPage
} from "./agentskillClient";
import type { AgentskillCatalogRecord } from "./schema";
import { dashboardHTML } from "./dashboard";
import {
  getLatestVersion,
  getSkillById,
  readCursor,
  recordVersion,
  upsertSkill,
  writeCursor
} from "./db";
import { searchSkills } from "./search";
import { seedLocalSkills } from "./seedLocal";

// ─────────────────────────────────────────────────────────────────────────────
// User's n8n search workflow Cq4OuDbFj84JjUXQ. Production webhook only —
// /webhook-test/ is one-shot in n8n and has to be re-armed every request.
// The current workflow registers a GET trigger; the proxy below tries GET
// first and falls back to POST so the dashboard works either way if/when
// the user flips the Webhook node's HTTP method.
const N8N_HOST = "https://n8n.srv828840.hstgr.cloud";
const N8N_WEBHOOK_PATH = "b10d7cdf-02c5-4e77-b7ec-2413e1d87afd";
const N8N_WEBHOOK_URL = `${N8N_HOST}/webhook/${N8N_WEBHOOK_PATH}`;
const UTF8_ENCODER = new TextEncoder();
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when a pathname is handled by the Skills dashboard/API router.
 */
export function isSkillsRoute(pathname: string): boolean {
  return (
    pathname === "/api/skills" ||
    pathname.startsWith("/api/skills/") ||
    pathname === "/skills" ||
    pathname === "/skills/"
  );
}

/**
 * Entry-point router for the Skills dashboard/API surface.
 *
 * Keeps all `/skills` and `/api/skills/*` request handling in one place so
 * the top-level Worker fetch handler can delegate with a single call.
 */
export async function handleSkillsRoute(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if ((path === "/skills" || path === "/skills/") && method === "GET") {
    return new Response(dashboardHTML(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=60"
      }
    });
  }

  if (path === "/api/skills/search" && method === "GET") {
    return await handleSearch(url, env);
  }
  if (path === "/api/skills/n8n-search" && method === "POST") {
    return await handleN8nSearch(request);
  }
  if (path === "/api/skills/n8n-info" && method === "GET") {
    return jsonResponse({
      webhook_url: N8N_WEBHOOK_URL,
      worker_search_url:
        "https://cats-seo-aiagent.webmaster-bc8.workers.dev/api/skills/search",
      workflow_editor:
        "https://n8n.srv828840.hstgr.cloud/workflow/Cq4OuDbFj84JjUXQ"
    });
  }
  if (path === "/api/skills/crawl/status" && method === "GET") {
    return await handleCrawlStatus(env);
  }
  if (path === "/api/skills/crawl/start" && method === "POST") {
    return await handleCrawlStart(request, env);
  }
  if (path === "/api/skills/seed-local" && method === "POST") {
    return await handleSeedLocal(request, env);
  }
  if (path === "/api/skills/install" && method === "POST") {
    return await handleInstall(request, env);
  }
  if ((path === "/api/skills" || path === "/api/skills/") && method === "GET") {
    return await handleList(url, env);
  }
  const showMatch = path.match(/^\/api\/skills\/([^/]+)\/([^/]+)$/);
  if (showMatch && method === "GET") {
    return await handleShow(showMatch[1], showMatch[2], env);
  }

  return jsonResponse({ error: "not found" }, 404);
}

async function handleSearch(url: URL, env: Env): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return jsonResponse({ error: "missing 'q'" }, 400);
  const k = clampInt(url.searchParams.get("k"), 25, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 100_000);
  // `URLSearchParams.get` returns `string | null`; downstream consumers
  // accept `string | undefined` so we normalize null → undefined.
  const owner = url.searchParams.get("owner") || undefined;
  const includeBody = url.searchParams.get("body") !== "0";
  const t0 = Date.now();
  const result = await searchSkills(env, q, { k, offset, owner, includeBody });
  return jsonResponse({
    query: q,
    k,
    offset,
    took_ms: Date.now() - t0,
    total_matches: result.totalMatches,
    has_more: result.hasMore,
    count: result.hits.length,
    hits: result.hits
  });
}

async function handleList(url: URL, env: Env): Promise<Response> {
  const ownerRaw = url.searchParams.get("owner");
  const owner = ownerRaw?.trim() || null;
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);

  const where = owner ? `WHERE owner = ?` : ``;
  const stmt = env.SKILLS_DB.prepare(
    `SELECT id, owner, slug, name, description, category, source_url, latest_sha, updated_at
         FROM skills ${where}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`
  );
  const bound = owner
    ? stmt.bind(owner, limit, offset)
    : stmt.bind(limit, offset);
  const result = await bound.all();

  const totalRow = await env.SKILLS_DB.prepare(
    owner
      ? `SELECT COUNT(*) as c FROM skills WHERE owner = ?`
      : `SELECT COUNT(*) as c FROM skills`
  )
    .bind(...(owner ? [owner] : []))
    .first<{ c: number }>();

  return jsonResponse({
    total: totalRow?.c ?? 0,
    limit,
    offset,
    skills: result.results
  });
}

async function handleShow(
  owner: string,
  slug: string,
  env: Env
): Promise<Response> {
  const id = `${owner}/${slug}`;
  const skill = await getSkillById(env.SKILLS_DB, id);
  if (!skill) return jsonResponse({ error: "not found", id }, 404);
  const latest = await getLatestVersion(env.SKILLS_DB, id);
  return jsonResponse({
    skill,
    version: latest
      ? {
          content_sha: latest.content_sha,
          fetched_at: latest.fetched_at,
          skill_md: latest.skill_md
        }
      : null
  });
}

async function handleInstall(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }
  const body = parseObjectLike(payload) ?? {};
  const owner = typeof body.owner === "string" ? body.owner.trim() : "";
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!owner || !slug) {
    return jsonResponse({ error: "owner and slug required" }, 400);
  }

  const ownerLower = owner.toLowerCase();
  const slugLower = slug.toLowerCase();
  const targetSlugLower = `${ownerLower}/${slugLower}`;
  let foundRecord: AgentskillCatalogRecord | undefined;
  let page = 1;
  while (page <= 50) {
    const data = await listSkillsPage(page, 100);
    if (!Array.isArray(data.data)) {
      const dataShape =
        data.data === null
          ? "null"
          : Array.isArray(data.data)
            ? "array"
            : typeof data.data;
      return jsonResponse(
        {
          error: "malformed_catalog_payload",
          page,
          detail: `expected data array, got ${dataShape}`
        },
        502
      );
    }
    const match = data.data.find((r) => {
      const recordSlugLower = r.slug.trim().toLowerCase();
      if (recordSlugLower === targetSlugLower) return true;
      if (recordSlugLower !== slugLower) return false;
      const recordOwnerLower =
        typeof r.githubOwner === "string"
          ? r.githubOwner.trim().toLowerCase()
          : "";
      return recordOwnerLower === ownerLower;
    });
    if (match) {
      foundRecord = match;
      break;
    }
    if (!data.hasMore) break;
    page++;
  }
  if (!foundRecord) {
    return jsonResponse({ error: "skill not found in catalog" }, 404);
  }

  const job = buildSkillFetchJob(foundRecord);
  let skillMd = "";
  try {
    skillMd = await fetchSkillMd(
      {
        githubOwner: job.githubOwner,
        githubRepo: job.githubRepo,
        githubBranch: job.githubBranch,
        githubPath: job.githubPath
      },
      env.GITHUB_TOKEN_SECRET?.trim() || undefined
    );
  } catch (err: unknown) {
    if (err instanceof SkillFetchHttpError && err.statusCode === 422) {
      return jsonResponse({ error: err.message }, 422);
    }
    throw err;
  }
  const sha = job.contentSha ?? "unknown";

  await upsertSkill(env.SKILLS_DB, {
    id: job.skillId,
    owner: job.owner,
    slug: job.slug,
    name: job.name,
    description: job.description ?? null,
    category: job.category ?? null,
    sourceUrl: job.sourceUrl,
    githubOwner: job.githubOwner,
    githubRepo: job.githubRepo,
    githubBranch: job.githubBranch ?? null,
    githubPath: job.githubPath,
    latestSha: sha,
    metadataJson: JSON.stringify(job.metadata)
  });
  await recordVersion(env.SKILLS_DB, job.skillId, sha, skillMd);

  return jsonResponse({
    installed: job.skillId,
    contentSha: sha,
    bytes: skillMd.length
  });
}

async function handleSeedLocal(request: Request, env: Env): Promise<Response> {
  if (!isAdminAuthorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const result = await seedLocalSkills(env);
  return jsonResponse(result);
}

async function handleCrawlStart(request: Request, env: Env): Promise<Response> {
  if (!isAdminAuthorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  await writeCursor(env.SKILLS_DB, "next_page", "1");
  await writeCursor(env.SKILLS_DB, "paused", "0");
  return jsonResponse({ ok: true, next_page: 1 });
}

async function handleCrawlStatus(env: Env): Promise<Response> {
  const [
    nextPage,
    totalPages,
    lastPageSeen,
    paused,
    lastFullPassAt,
    count,
    errorCount
  ] = await Promise.all([
    readCursor(env.SKILLS_DB, "next_page"),
    readCursor(env.SKILLS_DB, "total_pages"),
    readCursor(env.SKILLS_DB, "last_page_seen"),
    readCursor(env.SKILLS_DB, "paused"),
    readCursor(env.SKILLS_DB, "last_full_pass_at"),
    env.SKILLS_DB.prepare(`SELECT COUNT(*) as c FROM skills`).first<{
      c: number;
    }>(),
    env.SKILLS_DB.prepare(
      `SELECT COUNT(*) as c FROM crawl_errors WHERE occurred_at > ?`
    )
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .first<{ c: number }>()
  ]);
  const nextPageValue = parseStoredInt(nextPage, 1) ?? 1;
  const totalPagesValue = parseStoredInt(totalPages, 1);
  const lastPageSeenValue = parseStoredInt(lastPageSeen, 1);
  const lastFullPassAtValue = parseStoredInt(lastFullPassAt, 0);
  return jsonResponse({
    next_page: nextPageValue,
    total_pages: totalPagesValue,
    last_page_seen: lastPageSeenValue,
    paused: paused === "1",
    last_full_pass_at: lastFullPassAtValue,
    skills_in_db: count?.c ?? 0,
    errors_24h: errorCount?.c ?? 0
  });
}

function isAdminAuthorized(request: Request, env: Env): boolean {
  const expected = env.SKILLS_ADMIN_TOKEN?.trim();
  if (!expected) return false;
  const provided = request.headers.get("x-admin-token")?.trim();
  if (!provided) return false;
  return safeEqual(provided, expected);
}

function safeEqual(a: string, b: string): boolean {
  const aBytes = UTF8_ENCODER.encode(a);
  const bBytes = UTF8_ENCODER.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  const n = parseStrictInteger(raw);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseStoredInt(raw: string | null, min: number): number | null {
  const parsed = parseStrictInteger(raw);
  if (parsed === null || parsed < min) return null;
  return parsed;
}

function parseStrictInteger(raw: string | null): number | null {
  if (!raw || raw.trim() === "") return null;
  const normalized = raw.trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  const n = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

function shouldRetryN8nGetAsPost(status: number, bodyText: string): boolean {
  const normalizedBodyText = bodyText.toLowerCase();
  if (normalizedBodyText.includes("did you mean to make a post request")) {
    return true;
  }
  if (status === 405) {
    return true;
  }
  if (status !== 404) {
    return false;
  }
  return (
    normalizedBodyText.includes("webhook") &&
    normalizedBodyText.includes("not registered") &&
    normalizedBodyText.includes("get")
  );
}

async function handleN8nSearch(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return jsonResponse({ error: "invalid json body" }, 400);
  }
  const payloadRecord = payload as Record<string, unknown>;
  const q = typeof payloadRecord.q === "string" ? payloadRecord.q.trim() : "";
  if (!q) return jsonResponse({ error: "missing 'q'" }, 400);
  const k = clampInt(String(payloadRecord.k ?? 5), 5, 1, 25);

  // The user's webhook is currently a GET trigger. Try GET first with query
  // params; if n8n returns 404 with the "Did you mean to make a GET request?"
  // hint reversed (i.e. POST-only webhook), fall back to POST.
  const t0 = Date.now();
  const getUrl = `${N8N_WEBHOOK_URL}?q=${encodeURIComponent(q)}&k=${k}`;
  const attempts: { method: string; status: number; bodyText: string }[] = [];

  let resp: Response;
  try {
    resp = await fetch(getUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000)
    });
  } catch (err) {
    return jsonResponse(
      {
        error: "fetch_failed",
        webhook_url: N8N_WEBHOOK_URL,
        message: errMsg(err)
      },
      502
    );
  }

  let respText = await resp.text();
  attempts.push({
    method: "GET",
    status: resp.status,
    bodyText: respText.slice(0, 200)
  });

  const shouldRetryAsPost = shouldRetryN8nGetAsPost(resp.status, respText);

  if (shouldRetryAsPost) {
    try {
      resp = await fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({ q, k }),
        signal: AbortSignal.timeout(15_000)
      });
      respText = await resp.text();
      attempts.push({
        method: "POST",
        status: resp.status,
        bodyText: respText.slice(0, 200)
      });
    } catch (err) {
      return jsonResponse(
        {
          error: "fetch_failed_after_method_switch",
          webhook_url: N8N_WEBHOOK_URL,
          message: errMsg(err),
          attempts
        },
        502
      );
    }
  }

  let n8nBody: unknown = respText;
  try {
    n8nBody = JSON.parse(respText);
  } catch {
    /* leave as text */
  }

  // Detect the "Workflow was started" default response — this means the
  // user's workflow is missing a "Respond to Webhook" node, so the actual
  // search results never come back. Surface that hint to the dashboard.
  let hint: string | undefined;
  if (isWorkflowStartedWebhookAck(n8nBody)) {
    hint =
      "n8n acknowledged the request but did not return data. " +
      "In your workflow, add a 'Respond to Webhook' node after the " +
      "HTTP Request node and set its body to ={{ $json }} — then " +
      "the actual search results will come back here.";
  }

  return jsonResponse({
    webhook_url: N8N_WEBHOOK_URL,
    workflow_editor:
      "https://n8n.srv828840.hstgr.cloud/workflow/Cq4OuDbFj84JjUXQ",
    took_ms: Date.now() - t0,
    n8n_status: resp.status,
    n8n_method: attempts[attempts.length - 1]?.method ?? "GET",
    n8n_body: n8nBody,
    hint,
    attempts
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function getStringRecordField(value: unknown, key: string): string | undefined {
  const record = parseObjectLike(value);
  if (!record) {
    return undefined;
  }
  const direct = record[key];
  if (typeof direct === "string") return direct;

  const expectedKey = key.trim().toLowerCase();
  if (expectedKey === "") return undefined;
  for (const [recordKey, recordValue] of Object.entries(record)) {
    if (recordKey.trim().toLowerCase() !== expectedKey) continue;
    return typeof recordValue === "string" ? recordValue : undefined;
  }
  return undefined;
}

function isWorkflowStartedWebhookAck(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().toLowerCase().startsWith("workflow was started");
  }
  const message = getStringRecordField(value, "message");
  if (!message) return false;
  return message.trim().toLowerCase().startsWith("workflow was started");
}
