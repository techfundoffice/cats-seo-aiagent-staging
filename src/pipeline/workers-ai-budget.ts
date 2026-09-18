/**
 * Workers AI neuron kill switch.
 *
 * Every Workers AI (`env.AI`) inference call is billed in **neurons**. The
 * Aug 14 – Sep 13, 2026 Cloudflare invoice charged 65,371,887 "Regular Twitch
 * Neurons" at $0.011/1,000 = **$719.09**, which was ~91% of a $788.68 bill
 * (everything else — R2 $3.09, KV $1.50, Pro plan $25.00 — was noise, and
 * Fast Twitch Neurons were $0.00). So neuron spend is the only Cloudflare
 * cost in this account worth controlling.
 *
 * Four surfaces in this Worker reach `env.AI`, and two of them burned
 * neurons unconditionally:
 *
 *  - `scout`  — `getScoutModel` ran Qwen3-30B on `env.AI` *by design*, never
 *               OpenRouter, up to 3 attempts × 2000 output tokens per tick.
 *  - `image`  — `article-image.ts` ran flux for every hero/product image,
 *               both through the binding and through the REST `ai/run/`
 *               endpoint (same account, same neurons).
 *  - `text`   — `runKimiWithPoll` / `getKimiModel` only reach Workers AI as
 *               the last resort *after* Claude and OpenRouter, but when
 *               OpenRouter credits run dry the entire writer lands here (the
 *               documented "6/6→6/10 publish drought" wedge). That is the
 *               most likely shape of a 65M-neuron month.
 *  - `vision` — `vision-audit.ts` Llava fallback behind Claude.
 *
 * Each surface is **disabled by default**. Re-enable deliberately, per
 * surface, by setting a var/secret to a truthy value:
 *
 *   WORKERS_AI_ENABLED         → master switch, turns all four back on
 *   WORKERS_AI_TEXT_ENABLED    → LLM fallback (kimi-model / ai-poll)
 *   WORKERS_AI_IMAGE_ENABLED   → flux hero + product images
 *   WORKERS_AI_VISION_ENABLED  → Llava design-audit fallback
 *   WORKERS_AI_SCOUT_ENABLED   → Qwen3 category scout
 *
 * A per-surface flag wins over the master switch, so
 * `WORKERS_AI_ENABLED=true` + `WORKERS_AI_IMAGE_ENABLED=false` turns
 * everything on except image generation.
 *
 * Disabling a surface never throws into the pipeline by itself — each call
 * site degrades the way it already degrades on a Workers AI outage (null
 * image, recorded vision error, OpenRouter-only text). The one behavior
 * change worth knowing: with `scout` off the category scout runs on the
 * OpenRouter free-model router instead, so it keeps working at zero cost.
 */

/** The four `env.AI` surfaces, each independently switchable. */
export type WorkersAiSurface = "text" | "image" | "vision" | "scout";

export const WORKERS_AI_SURFACES: readonly WorkersAiSurface[] = [
  "text",
  "image",
  "vision",
  "scout"
];

/** Env var that overrides the master switch for one surface. */
const SURFACE_FLAG: Record<WorkersAiSurface, string> = {
  text: "WORKERS_AI_TEXT_ENABLED",
  image: "WORKERS_AI_IMAGE_ENABLED",
  vision: "WORKERS_AI_VISION_ENABLED",
  scout: "WORKERS_AI_SCOUT_ENABLED"
};

const MASTER_FLAG = "WORKERS_AI_ENABLED";

/**
 * Parse a flag value into an explicit boolean, or `undefined` when the flag
 * is absent/blank so the caller can fall through to the next tier.
 *
 * Accepts booleans as well as strings because `wrangler.jsonc` vars arrive
 * as strings while a test or a `define` may supply a real boolean.
 */
export function parseFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
}

/**
 * True when `surface` may call `env.AI`. Resolution order:
 * per-surface flag → master flag → **disabled**.
 *
 * `env` is deliberately typed loosely: this is called from modules that hold
 * `Env`, `agent.envBindings`, and bare binding bags alike, and an unknown key
 * simply reads as absent.
 */
export function isWorkersAiEnabled(
  env: unknown,
  surface: WorkersAiSurface
): boolean {
  const bag = (env ?? {}) as Record<string, unknown>;
  const perSurface = parseFlag(bag[SURFACE_FLAG[surface]]);
  if (perSurface !== undefined) return perSurface;
  const master = parseFlag(bag[MASTER_FLAG]);
  if (master !== undefined) return master;
  return false;
}

/**
 * Human-readable reason for a skipped call, naming the exact flag to set.
 * Used verbatim in activity-log lines so the dashboard says why a model call
 * did not happen, and in the `Error` thrown at the terminal text fallback.
 */
export function workersAiDisabledReason(surface: WorkersAiSurface): string {
  return (
    `Workers AI "${surface}" is disabled to stop neuron billing — ` +
    `set ${SURFACE_FLAG[surface]}=true (or ${MASTER_FLAG}=true) to re-enable`
  );
}

/** Error thrown where a call site has no non-throwing way to degrade. */
export class WorkersAiDisabledError extends Error {
  readonly surface: WorkersAiSurface;

  constructor(surface: WorkersAiSurface) {
    super(workersAiDisabledReason(surface));
    this.name = "WorkersAiDisabledError";
    this.surface = surface;
  }
}
