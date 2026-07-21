/**
 * Wireframe ingestion — returns a prompt-safe `WireframeSummary` that the
 * Editorial Agent injects into Kimi prompts. The wireframe is a *skeletal
 * inspiration*, never a content source: our articles keep their own titles,
 * topics, products, and voice.
 *
 * Reference URLs (e.g. NYT Wirecutter's best-automatic-cat-litter-box
 * roundup) are served from checked-in seeds in `./wireframe-seeds/` so the
 * pipeline never makes an outbound fetch for the same handful of fixed
 * benchmark pages. To refresh a seed after a redesign, hand-edit the JSON.
 *
 * Compliance notes:
 * - Seeds contain only abstract patterns (section types, pick role labels,
 *   trust-signal categories). No prose, product names, or prices.
 * - Amazon Associates Operating Agreement: we never display prices, so
 *   even seed inputs never carry priceMentions.
 */

import type { SEOArticleAgent } from "../server";
import { getSeededWireframe } from "./wireframe-seeds";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Abstract pattern types extractable from any commerce-review article.
 * Keep this list generic — NYT-specific labels never reach here.
 */
export type PatternType =
  | "intro"
  | "trust_block"
  | "audience_qualifier"
  | "selection_criteria"
  | "methodology"
  | "product_pick_archetype"
  | "tradeoff_block"
  | "competition_note"
  | "sources"
  | "other";

export interface PickArchetype {
  /** Abstract role, NOT the NYT product's name. */
  role:
    | "top_pick"
    | "best_for_detailed_data"
    | "open_top_variant"
    | "budget_pick"
    | "premium_variant"
    | "runner_up"
    | "other";
  /** True if the wireframe's pick of this role has a flaws-but-not-dealbreakers block. */
  hasTradeoffBlock: boolean;
}

export interface MethodologyShape {
  considered?: number;
  tested?: number;
  subjects?: number;
  durationPattern?: "short_term" | "long_term" | "unspecified";
  testPhases?: string[]; // generic phase names, never verbatim quotes
}

/**
 * Prompt-safe wireframe. What the Editorial Agent actually sees in Kimi
 * prompts. All source-specific prose (titles, headlines, product names,
 * prices, quotes) is stripped before `WireframeSummary` is assembled.
 */
export interface WireframeSummary {
  sourceUrl: string;
  sourceDomain: string;
  /** Pattern-type list, in reader-visible order. */
  sections: PatternType[];
  pickArchetypes: PickArchetype[];
  trustSignals: string[]; // abstract signal names only
  methodologyShape: MethodologyShape;
  evaluationCriteria: string[]; // abstract categories only
  /** Structural presence flags. */
  features: {
    hasAtAGlanceTable: boolean;
    hasTradeoffBlockPerPick: boolean;
    hasWhoThisIsFor: boolean;
    hasWhoShouldSkip: boolean;
    hasHowWePicked: boolean;
    hasHowWeTested: boolean;
    hasCompetitionSection: boolean;
  };
  /** DataForSEO on-page summary task id for later polling (may be null). */
  seoSummaryTaskId?: string;
  fetchedAt: string;
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Resolve a `WireframeSummary` for `url`. Hits the static seed index first
 * (the only path expected to fire in production). Returns `null` for
 * unseeded URLs so the Editorial Agent falls back to URL-only prompts —
 * no live fetch, no Firecrawl, no Browser Rendering.
 */
export async function loadOrIngestWireframe(
  agent: SEOArticleAgent,
  url: string
): Promise<WireframeSummary | null> {
  const seeded = getSeededWireframe(url);
  if (seeded) {
    agent.log(
      "info",
      `Wireframe: served from static seed for ${url}`,
      "editorialAgent"
    );
    return seeded;
  }

  agent.log(
    "warning",
    `Wireframe: no seed for ${url} — falling back to URL-only prompts. Add a seed under src/pipeline/wireframe-seeds/ to enable structural cues.`,
    "editorialAgent"
  );
  return null;
}
