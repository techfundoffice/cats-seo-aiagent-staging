import { errMsg } from "../pipeline/http-utils";
import { fetchSkillMd, SkillFetchHttpError } from "./agentskillClient";
import { recordCrawlError, recordVersion, upsertSkill } from "./db";
import type { SkillFetchJob } from "./schema";

/**
 * Consume one queue batch of skill-fetch jobs, persisting fetched SKILL.md
 * content and recording crawl failures. Permanent source errors (404/410/422)
 * are acknowledged to stop infinite retries; transient failures are retried.
 */
export async function handleSkillFetchBatch(
  batch: MessageBatch<SkillFetchJob>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processOne(message.body, env);
      message.ack();
    } catch (err: unknown) {
      const errorMessage = errMsg(err);
      try {
        await recordCrawlError(
          env.SKILLS_DB,
          message.body.skillId,
          null,
          errorMessage
        );
      } catch (recordErr: unknown) {
        console.warn(
          `[skills] failed to record crawl error for "${message.body.skillId}": ${errMsg(recordErr)}`
        );
      }
      if (isNonRetriableSkillFetchError(err)) {
        // 404/410 indicate permanently missing source content; consume the
        // message to avoid infinite retries for the same broken reference.
        console.warn(
          `[skills] acknowledging non-retriable crawl failure for "${message.body.skillId}": ${errorMessage}`
        );
        message.ack();
      } else {
        console.warn(
          `[skills] retrying crawl for "${message.body.skillId}" after fetch failure: ${errorMessage}`
        );
        message.retry();
      }
    }
  }
}

function isNonRetriableSkillFetchError(err: unknown): boolean {
  if (err instanceof SkillFetchHttpError) {
    return (
      err.statusCode === 404 || err.statusCode === 410 || err.statusCode === 422
    );
  }
  return false;
}

async function processOne(job: SkillFetchJob, env: Env): Promise<void> {
  const skillMd = await fetchSkillMd(
    {
      githubOwner: job.githubOwner,
      githubRepo: job.githubRepo,
      githubBranch: job.githubBranch,
      githubPath: job.githubPath
    },
    env.GITHUB_TOKEN_SECRET?.trim() || undefined
  );

  const sha = job.contentSha ?? (await sha256Short(skillMd));

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
}

async function sha256Short(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < 4; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
