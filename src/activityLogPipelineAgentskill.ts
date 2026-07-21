/**
 * Maps `updateStep()` labels (e.g. `5/12: AI Writing`) to agentskill.sh slugs
 * for the Google Sheet "Agentskill.sh" attribution column.
 *
 * Most return values correspond to a local `.claude/skills/<slug>/SKILL.md`
 * folder (e.g. `"seo-optimizer"`, `"prompt-engineer"`). Some steps map to an
 * external agentskill.sh reference that has no local folder — for example the
 * Live SEO pass returns `"anthropic/seo-content-optimizer"`.
 *
 * Returns `""` when no skill mapping applies to the given step label.
 */

/**
 * Returns a kebab-case skill slug for the pipeline step label, or `""` when
 * none applies.
 *
 * **Check order is intentional** — some step labels are substrings of others
 * and must be tested first:
 *   - `"seo score card ai"` before `"seo score"` (the former contains the
 *     latter as a substring, so reversing the order would mis-classify
 *     `"12/24: SEO Score Card AI"` as `"seo-optimizer"` instead of
 *     `"review-skill"`).
 *   - `"browser-use"` before `"verify"` so `"15.5/24: browser-use Verify"`
 *     maps to `"cloudflare-browser-rendering"` rather than
 *     `"cloudflare-worker-dev"`.
 *   - `"kv deploy"` before `"kv check"` (the latter is checked late in the
 *     chain; the former must not be masked by it).
 *
 * Covers all `updateStep()` labels emitted by `writer.ts` and the two
 * explicit `sheetPipelineStepLabel` values set in
 * `seo-scorecard-qc-prompts.ts` (`"12/24: SEO Score Card AI"`) and
 * `quora-seeder.ts` (`"21/24: Quora Seeder"`).
 *
 * Returns `""` for `"Complete"` (the terminal step sentinel) and for any
 * unrecognised label.
 */
export function resolveAgentskillSlugForPipelineStepLabel(
  pipelineStepLabel: string | null | undefined
): string {
  const raw = (pipelineStepLabel ?? "").trim();
  if (!raw || /^complete$/i.test(raw)) return "";
  const s = raw.toLowerCase();

  if (s.includes("seo score card ai")) return "review-skill";
  if (s.includes("design audit")) return "design-audit";
  if (s.includes("polish")) return "prompt-engineer";
  if (s.includes("qc review")) return "seo-optimizer";
  if (s.includes("sitemap")) return "seo-optimizer";
  if (s.includes("kv deploy")) return "cloudflare-worker-dev";
  if (s.includes("seo score")) return "seo-optimizer";
  if (s.includes("html assembly")) return "web-html";
  if (s.includes("youtube")) return "web-html";
  if (s.includes("content enhancement")) return "prompt-engineer";
  if (s.includes("json parsing")) return "prompt-engineer";
  if (s.includes("ai writing")) return "prompt-engineer";
  if (s.includes("intent gap")) return "prompt-engineer";
  if (s.includes("text editor")) return "prompt-engineer";
  if (s.includes("internal links")) return "seo-optimizer";
  if (s.includes("paa")) return "seo-optimizer";
  if (s.includes("competitor")) return "seo-optimizer";
  if (s.includes("serp")) return "seo-optimizer";
  if (s.includes("browser-use") || s.includes("browser harness")) {
    return "cloudflare-browser-rendering";
  }
  if (s.includes("verify")) return "cloudflare-worker-dev";
  if (s.includes("amazon products")) return "cats-amazon-roi-scout";
  if (s.includes("kv check")) return "cloudflare-worker-dev";
  if (s.includes("seo-content-optimizer") || s.includes("live seo")) {
    return "anthropic/seo-content-optimizer";
  }
  if (s.includes("siss")) return "seo-optimizer";
  if (s.includes("quora seeder")) return "seo-optimizer";
  if (s.includes("qa syndication") || s.includes("q&a syndication")) {
    return "seo-optimizer";
  }
  if (s.includes("reverse link")) return "seo-optimizer";
  if (s.includes("rss")) return "seo-optimizer";

  return "";
}
