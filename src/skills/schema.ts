export interface SkillRow {
  id: string;
  owner: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  source_url: string | null;
  github_owner: string | null;
  github_repo: string | null;
  github_branch: string | null;
  github_path: string | null;
  latest_sha: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface SkillVersionRow {
  skill_id: string;
  content_sha: string;
  skill_md: string;
  fetched_at: number;
}

export interface AgentskillCatalogRecord {
  _id: string;
  name: string;
  slug: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch?: string;
  githubPath: string;
  contentSha?: string;
  description?: string;
  category?: string;
  [k: string]: unknown;
}

export interface AgentskillCatalogPage {
  data: AgentskillCatalogRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

export interface SkillFetchJob {
  skillId: string;
  owner: string;
  slug: string;
  name: string;
  description?: string;
  category?: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch?: string;
  githubPath: string;
  contentSha?: string;
  sourceUrl: string;
  metadata: AgentskillCatalogRecord;
}
