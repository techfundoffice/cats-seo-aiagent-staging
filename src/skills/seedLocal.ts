import { recordVersion, upsertSkill } from "./db";

const localSkillFiles = import.meta.glob("../../.claude/skills/*/SKILL.md", {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

interface ParsedSkill {
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  sourceUrl: string | null;
  contentSha: string;
  skillMd: string;
}

/**
 * Seeds bundled local skill docs into the Skills DB.
 *
 * Each skill is written under `local/<slug>` and versioned with either the
 * embedded `contentSha` metadata value or a deterministic local fallback hash.
 */
export async function seedLocalSkills(env: Env): Promise<{
  seeded: number;
  skills: string[];
}> {
  const seeded: string[] = [];

  for (const [pathKey, body] of Object.entries(localSkillFiles)) {
    const parsed = parseSkill(pathKey, body);
    const skillId = `local/${parsed.slug}`;

    await upsertSkill(env.SKILLS_DB, {
      id: skillId,
      owner: "local",
      slug: parsed.slug,
      name: parsed.name,
      description: parsed.description,
      category: parsed.category,
      sourceUrl: parsed.sourceUrl,
      githubOwner: null,
      githubRepo: null,
      githubBranch: null,
      githubPath: null,
      latestSha: parsed.contentSha,
      metadataJson: JSON.stringify({ source: "repo-bundled" })
    });
    await recordVersion(
      env.SKILLS_DB,
      skillId,
      parsed.contentSha,
      parsed.skillMd
    );
    seeded.push(skillId);
  }

  return { seeded: seeded.length, skills: seeded };
}

function parseSkill(pathKey: string, body: string): ParsedSkill {
  const slug = extractSlug(pathKey);
  const frontmatter = readFrontmatter(body);
  const sourceMatch = body.match(/source:\s*(https:\/\/agentskill\.sh\/\S+)/);
  const shaMatch = body.match(/contentSha:\s*([0-9a-f]+)/i);

  return {
    slug,
    name: frontmatter.name ?? slug,
    description: frontmatter.description ?? null,
    category: frontmatter.category ?? null,
    sourceUrl: sourceMatch?.[1] ?? null,
    contentSha: shaMatch?.[1] ?? localContentSha(body),
    skillMd: body
  };
}

function extractSlug(pathKey: string): string {
  const normalizedPath = pathKey.replaceAll("\\", "/");
  const m = normalizedPath.match(/\/skills\/([^/]+)\/SKILL\.md$/);
  return m?.[1] ?? "unknown";
}

function readFrontmatter(body: string): Record<string, string> {
  if (!body.startsWith("---")) return {};
  const end = body.indexOf("\n---", 3);
  if (end < 0) return {};
  const yaml = body.slice(3, end);
  const out: Record<string, string> = {};
  let currentKey: string | null = null;
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      const value = m[2].trim();
      if (value.startsWith(">") || value.startsWith("|")) {
        const blockLines: string[] = [];
        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          if (nextLine.length > 0 && !/^\s/.test(nextLine)) break;
          i++;
          blockLines.push(nextLine.trim());
        }
        out[currentKey] = blockLines.join(" ").replace(/\s+/g, " ").trim();
      } else if (value) {
        out[currentKey] = stripQuotes(value);
      } else {
        out[currentKey] = "";
      }
    } else if (currentKey && line.startsWith("    ")) {
      out[currentKey] = (out[currentKey] + " " + line.trim()).trim();
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function localContentSha(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) {
    h = (h * 33) ^ body.charCodeAt(i);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
