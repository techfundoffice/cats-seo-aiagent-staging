import { errMsg } from "../pipeline/http-utils";
import { buildSkillFetchJob, listSkillsPage } from "./agentskillClient";
import { readCursor, recordCrawlError, writeCursor } from "./db";
import type { SkillFetchJob } from "./schema";

const PAGE_LIMIT = 100;

/**
 * Runs one crawl tick for the skills catalog producer queue.
 *
 * Cursor semantics:
 * - `next_page = "0"` means the previous full pass completed, so this tick is
 *   idle until another process resets the cursor to `"1"`.
 * - `paused = "1"` means the crawl is manually paused.
 */
export async function runCrawlTick(env: Env): Promise<{
  page: number;
  enqueued: number;
  done: boolean;
}> {
  const paused = await readCursor(env.SKILLS_DB, "paused");
  if ((paused ?? "").trim() === "1")
    return { page: 0, enqueued: 0, done: false };

  const cursor = await readCursor(env.SKILLS_DB, "next_page");
  const normalizedCursor = cursor?.trim() ?? "";
  if (normalizedCursor === "") {
    await recordCrawlError(
      env.SKILLS_DB,
      null,
      null,
      "Missing crawl next_page cursor; reset to page 1 so crawl resumes on next tick"
    );
    await writeCursor(env.SKILLS_DB, "next_page", "1");
    return { page: 1, enqueued: 0, done: false };
  }
  if (!/^\d+$/.test(normalizedCursor)) {
    await recordCrawlError(
      env.SKILLS_DB,
      null,
      null,
      `Invalid crawl next_page cursor ${JSON.stringify(cursor)}; will retry from page 1 on next tick`
    );
    await writeCursor(env.SKILLS_DB, "next_page", "1");
    return { page: 1, enqueued: 0, done: false };
  }
  const page = Number.parseInt(normalizedCursor, 10);
  if (!Number.isSafeInteger(page)) {
    await recordCrawlError(
      env.SKILLS_DB,
      null,
      null,
      `Invalid crawl next_page cursor ${JSON.stringify(cursor)}; page must be a safe integer, will retry from page 1 on next tick`
    );
    await writeCursor(env.SKILLS_DB, "next_page", "1");
    return { page: 1, enqueued: 0, done: false };
  }
  if (page === 0) {
    if (normalizedCursor !== "0") {
      await recordCrawlError(
        env.SKILLS_DB,
        null,
        null,
        `Invalid crawl next_page cursor ${JSON.stringify(cursor)}; only literal "0" is allowed for a completed crawl marker, will retry from page 1 on next tick`
      );
      await writeCursor(env.SKILLS_DB, "next_page", "1");
      return { page: 1, enqueued: 0, done: false };
    }
    return { page: 0, enqueued: 0, done: false };
  }

  let pageData;
  try {
    pageData = await listSkillsPage(page, PAGE_LIMIT);
  } catch (err: unknown) {
    await recordCrawlError(env.SKILLS_DB, null, page, errMsg(err));
    return { page, enqueued: 0, done: false };
  }

  if (!Array.isArray(pageData.data)) {
    await recordCrawlError(
      env.SKILLS_DB,
      null,
      page,
      `Invalid agentskill payload for page ${page}: expected data array, got ${JSON.stringify(pageData.data)}`
    );
    return { page, enqueued: 0, done: false };
  }

  const jobs: SkillFetchJob[] = [];
  for (const [index, rawRecord] of pageData.data.entries()) {
    try {
      jobs.push(buildSkillFetchJob(rawRecord));
    } catch (err: unknown) {
      let recordHint: unknown;
      if (typeof rawRecord === "object" && rawRecord !== null) {
        const record = rawRecord as Record<string, unknown>;
        recordHint = record.id ?? record.name;
      }
      await recordCrawlError(
        env.SKILLS_DB,
        null,
        page,
        `Invalid agentskill record on page ${page} at index ${index}${recordHint ? ` (${JSON.stringify(recordHint)})` : ""}: ${errMsg(err)}`
      );
    }
  }
  if (jobs.length > 0) {
    const messages = jobs.map((body) => ({ body }));
    await env.SKILL_FETCH_QUEUE.sendBatch(messages);
  }

  const totalPages = pageData.totalPages;
  const hasValidTotalPages = Number.isSafeInteger(totalPages) && totalPages > 0;
  if (!hasValidTotalPages) {
    await recordCrawlError(
      env.SKILLS_DB,
      null,
      page,
      `Invalid agentskill totalPages value ${JSON.stringify(totalPages)} on page ${page}; continuing crawl using hasMore only`
    );
  }
  const done = !pageData.hasMore || (hasValidTotalPages && page >= totalPages);

  if (hasValidTotalPages) {
    await writeCursor(env.SKILLS_DB, "total_pages", String(totalPages));
  }
  await writeCursor(env.SKILLS_DB, "last_page_seen", String(page));
  if (done) {
    await writeCursor(env.SKILLS_DB, "next_page", "0");
    await writeCursor(env.SKILLS_DB, "last_full_pass_at", String(Date.now()));
  } else {
    await writeCursor(env.SKILLS_DB, "next_page", String(page + 1));
  }

  return { page, enqueued: jobs.length, done };
}
