/**
 * Static, checked-in `WireframeSummary` seeds.
 *
 * Why static: the reference URLs (NYT Wirecutter roundups) don't change
 * shape between runs, and live-fetching them at every cold cache made the
 * pipeline depend on Firecrawl uptime + KV TTLs. Seeds are abstracted —
 * no NYT prose, product names, or prices — so they're prompt-safe by
 * construction. To refresh after a NYT redesign, hand-edit the JSON.
 */

import type { WireframeSummary } from "../wireframe-ingest";
import nytLitterBox from "./nyt-best-automatic-cat-litter-box.json";

const SEEDS: ReadonlyArray<WireframeSummary> = [
  nytLitterBox as WireframeSummary
];

/**
 * Normalize a URL for stable lookup:
 * - ignore protocol + www
 * - preserve non-default ports
 * - strip query/hash + trailing slash
 * - collapse trailing `/index.html` and `/index.htm`
 * - lowercase host/path
 */
function canonicalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return "";
  try {
    return canonicalizeParsedUrl(new URL(trimmed));
  } catch {
    // Accept scheme-less forms like `www.example.com/path` by parsing under
    // an https default, so default-port normalization matches absolute URLs.
    try {
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
        return canonicalizeParsedUrl(new URL(`https://${trimmed}`));
      }
    } catch {
      // Fall through to conservative string-based normalization.
    }
    return trimmed
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/[?#].*$/, "")
      .toLowerCase()
      .replace(/\/+$/, "")
      .replace(/\/index\.html?$/i, "");
  }
}

function canonicalizeParsedUrl(parsed: URL): string {
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  // WHATWG URL parsing clears default ports (80/443), so only non-default
  // explicit ports remain here.
  const port = parsed.port ? `:${parsed.port}` : "";
  const path = parsed.pathname
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\/index\.html?$/i, "");
  return `${host}${port}${path}`;
}

const SEED_INDEX: ReadonlyMap<string, WireframeSummary> = new Map(
  SEEDS.map((s) => [canonicalizeUrl(s.sourceUrl), s])
);

/** Returns the seeded `WireframeSummary` for `url`, or `null` if none. */
export function getSeededWireframe(url: string): WireframeSummary | null {
  return SEED_INDEX.get(canonicalizeUrl(url)) ?? null;
}
