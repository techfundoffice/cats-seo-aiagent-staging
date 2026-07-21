import type {
  AgentskillCatalogPage,
  AgentskillCatalogRecord,
  SkillFetchJob
} from "./schema";

const CATALOG_BASE = "https://agentskill.sh/api/skills";
const SKILL_FETCH_TIMEOUT_MS = 10_000;

/**
 * Thrown by `fetchSkillMd` and `listSkillsPage` when the remote server
 * returns a non-2xx HTTP status. Carries the numeric `statusCode` so
 * callers can distinguish retriable errors (5xx, 429) from permanent ones
 * (404, 410, 422) without string-matching the error message.
 */
export class SkillFetchHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "SkillFetchHttpError";
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = SKILL_FETCH_TIMEOUT_MS,
  context?: string
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  let upstreamListenerAdded = false;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      abortFromUpstream();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, {
        once: true
      });
      upstreamListenerAdded = true;
    }
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (err: unknown) {
    if (timedOut && err instanceof Error && err.name === "AbortError") {
      const contextPrefix = context ? `${context}: ` : "";
      throw new Error(
        `${contextPrefix}request timed out after ${timeoutMs}ms: ${url}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (upstreamListenerAdded) {
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    }
  }
}

/**
 * Fetch one page of skills from the agentskill.sh catalog API.
 *
 * @param page  1-based page number to request.
 * @param limit Max records per page (sent to the API as-is).
 * @returns The parsed catalog page including `data`, pagination metadata, and
 *          the `hasMore` flag used by `runCrawlTick` to decide whether to
 *          advance the `next_page` cursor.
 * @throws {SkillFetchHttpError} on non-2xx HTTP status.
 * @throws {Error} on network error or request timeout.
 */
export async function listSkillsPage(
  page: number,
  limit: number
): Promise<AgentskillCatalogPage> {
  const url = `${CATALOG_BASE}?page=${page}&limit=${limit}`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: { accept: "application/json" }
    },
    SKILL_FETCH_TIMEOUT_MS,
    `agentskill list ${page}`
  );
  if (!res.ok) {
    throw new SkillFetchHttpError(
      res.status,
      `agentskill list ${page}: HTTP ${res.status}`
    );
  }
  return (await res.json()) as AgentskillCatalogPage;
}

/**
 * Fetch the raw SKILL.md content for a skill from GitHub.
 *
 * Primary path: `raw.githubusercontent.com` (anonymous, fast, no token
 * required). Fallback path: GitHub Contents API with `githubToken` — used
 * when the raw CDN returns 403 (private repo or rate-limited by IP).
 *
 * @param record      Skill source coordinates from the agentskill catalog.
 * @param githubToken Optional personal-access token or fine-grained token
 *                    with at least `contents: read` scope. Used only on the
 *                    API fallback path.
 * @returns The raw SKILL.md text.
 * @throws {SkillFetchHttpError} with code 422 when `record` is missing
 *         required source fields (owner / repo / path).
 * @throws {SkillFetchHttpError} with the upstream HTTP status on fetch failure.
 * @throws {Error} on network error or request timeout.
 */
export async function fetchSkillMd(
  record: Pick<
    AgentskillCatalogRecord,
    "githubOwner" | "githubRepo" | "githubBranch" | "githubPath"
  >,
  githubToken?: string
): Promise<string> {
  const rawGithubOwner = record.githubOwner;
  const rawGithubRepo = record.githubRepo;
  const rawGithubPath = record.githubPath;
  const githubOwner = rawGithubOwner.trim();
  const githubRepo = rawGithubRepo.trim();
  const githubPath = rawGithubPath.trim();
  const branch = record.githubBranch?.trim() || "main";
  if (!githubOwner || !githubRepo || !githubPath) {
    throw new SkillFetchHttpError(
      422,
      `invalid skill source metadata (owner="${rawGithubOwner}", repo="${rawGithubRepo}", path="${rawGithubPath}")`
    );
  }
  const rawUrl = `https://raw.githubusercontent.com/${githubOwner}/${githubRepo}/${branch}/${githubPath}`;
  const rawRes = await fetchWithTimeout(
    rawUrl,
    {
      headers: { accept: "text/plain" }
    },
    SKILL_FETCH_TIMEOUT_MS,
    `raw github ${githubOwner}/${githubRepo}`
  );
  if (rawRes.ok) return await rawRes.text();
  if (rawRes.status === 429 || rawRes.status === 403) {
    if (githubToken) {
      const apiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${githubPath}?ref=${branch}`;
      const apiRes = await fetchWithTimeout(
        apiUrl,
        {
          headers: {
            accept: "application/vnd.github.raw",
            authorization: `Bearer ${githubToken}`,
            "user-agent": "cats-seo-aiagent-skills-crawler"
          }
        },
        SKILL_FETCH_TIMEOUT_MS,
        `github contents api ${githubOwner}/${githubRepo}`
      );
      if (apiRes.ok) return await apiRes.text();
      throw new SkillFetchHttpError(
        apiRes.status,
        `github contents api ${githubOwner}/${githubRepo}: HTTP ${apiRes.status}`
      );
    }
  }
  throw new SkillFetchHttpError(
    rawRes.status,
    `raw github ${githubOwner}/${githubRepo}@${branch}/${githubPath}: HTTP ${rawRes.status}`
  );
}

/**
 * Construct a `SkillFetchJob` queue message from a raw agentskill catalog
 * record.
 *
 * Normalises the slug and owner fields so the queue consumer always receives
 * a fully-resolved `skillId`, even when the catalog record's `githubOwner`
 * is empty (falls back to the penultimate slug path segment).  Unrecognised
 * fields from the catalog are preserved verbatim in `metadata` for
 * forward-compatibility with future agentskill API additions.
 *
 * @param record  A single record from the agentskill catalog page response.
 * @returns A `SkillFetchJob` ready to be enqueued via `SKILL_FETCH_QUEUE`.
 */
export function buildSkillFetchJob(
  record: AgentskillCatalogRecord
): SkillFetchJob {
  const trimmedGithubOwner = record.githubOwner.trim();
  const githubRepo = record.githubRepo.trim();
  const githubPath = record.githubPath.trim();
  const branch = record.githubBranch?.trim();
  const githubBranch = branch || undefined;
  const slugParts = record.slug
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const resolvedGithubOwner =
    trimmedGithubOwner || slugParts.at(-2) || "unknown-owner";
  const slug = slugParts.at(-1) || githubRepo || "unknown-skill";
  return {
    skillId: `${resolvedGithubOwner}/${slug}`,
    owner: resolvedGithubOwner,
    slug,
    name: record.name,
    description:
      typeof record.description === "string" ? record.description : undefined,
    category: typeof record.category === "string" ? record.category : undefined,
    githubOwner: resolvedGithubOwner,
    githubRepo,
    githubBranch,
    githubPath,
    contentSha: record.contentSha,
    sourceUrl: `https://agentskill.sh/${resolvedGithubOwner}/${slug}`,
    metadata: record
  };
}
