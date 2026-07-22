import type { SEOArticleAgent } from "../server";
import { fetchBestsellersByBrowseNode } from "./amazon";
import { errMsg, getEnvBinding, keywordToSlug } from "./http-utils";

/**
 * top-seller-scout.ts — daily real-bestseller sweep.
 *
 * Runs once every 24h (`topSellerScoutTick` in server.ts, wrapped in a
 * wall-clock timeout there). Sweeps a fixed list of 18 Amazon Pet
 * Supplies > Cats browse-node categories via PA API's real SearchItems
 * (not a keyword-imagined LLM guess — see amazon.ts's
 * `fetchBestsellersByBrowseNode`), diffs the fetched ASINs against the
 * previous sweep, and either seeds a first-time keyword for a
 * never-covered category or requeues an existing one for refresh when
 * its bestseller lineup has genuinely changed. Legacy scout
 * (`scoutHighTicketCategory` in scout.ts) continues running unaffected
 * in between sweeps — this module never touches the `categories` table's
 * exclusion semantics, only its own dedicated `bestseller_nodes` table
 * (see server.ts onStart()).
 */

export interface BestsellerNode {
  nodeId: string;
  categoryName: string;
}

/**
 * The 18 fixed Amazon Pet Supplies > Cats browse nodes to sweep, in the
 * order they're swept each day. Node IDs supplied by the site operator —
 * these are real Amazon zgbs (Best Sellers) taxonomy IDs, not
 * LLM-imagined categories.
 */
export const BESTSELLER_NODES: BestsellerNode[] = [
  { nodeId: "2975241011", categoryName: "Cat Supplies" },
  { nodeId: "2975242011", categoryName: "Cat Apparel" },
  { nodeId: "2975243011", categoryName: "Cat Beds & Furniture" },
  { nodeId: "17440052011", categoryName: "Cat Cameras & Monitors" },
  { nodeId: "2975250011", categoryName: "Cat Carriers & Strollers" },
  { nodeId: "23763991011", categoryName: "Cat Doors, Steps, Nets & Pens" },
  { nodeId: "2975252011", categoryName: "Cat Collars, Harnesses & Leashes" },
  { nodeId: "205727374011", categoryName: "Cat Educational Repellents" },
  { nodeId: "2975259011", categoryName: "Cat Feeding & Watering Supplies" },
  { nodeId: "2975280011", categoryName: "Cat Flea & Tick Control" },
  { nodeId: "2975265011", categoryName: "Cat Food" },
  { nodeId: "211908759011", categoryName: "Cat Gift Sets" },
  { nodeId: "2975268011", categoryName: "Cat Grooming Supplies" },
  { nodeId: "2975276011", categoryName: "Cat Health Supplies" },
  { nodeId: "2975296011", categoryName: "Cat Litter & Housebreaking" },
  { nodeId: "2975302011", categoryName: "Cat Memorials & Funerary" },
  { nodeId: "2975303011", categoryName: "Cat Toys" },
  { nodeId: "2975309011", categoryName: "Cat Treats" }
];

/** Prefix keeps Top Seller Scout's categories visually/structurally
 * distinct from legacy scout's organically-discovered ones in the
 * dashboard and in published URLs. */
const CATEGORY_SLUG_PREFIX = "topseller-";

export function deriveCategorySlug(categoryName: string): string {
  const base = categoryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${CATEGORY_SLUG_PREFIX}${base}`;
}

interface AmazonCredentialPair {
  key: string;
  secret: string;
  label: "primary" | "fallback";
}

function resolveCredentialPairs(
  agent: SEOArticleAgent
): AmazonCredentialPair[] {
  const pairs: AmazonCredentialPair[] = [];
  const primaryKey = getEnvBinding(agent.envBindings, "AMAZON_ACCESS_KEY");
  const primarySecret = getEnvBinding(agent.envBindings, "AMAZON_SECRET_KEY");
  if (primaryKey && primarySecret) {
    pairs.push({ key: primaryKey, secret: primarySecret, label: "primary" });
  }
  const fallbackKey = getEnvBinding(
    agent.envBindings,
    "AMAZON_ACCESS_KEY_FALLBACK"
  );
  const fallbackSecret = getEnvBinding(
    agent.envBindings,
    "AMAZON_SECRET_KEY_FALLBACK"
  );
  if (fallbackKey && fallbackSecret) {
    pairs.push({ key: fallbackKey, secret: fallbackSecret, label: "fallback" });
  }
  return pairs;
}

/** Sorted-ASIN-array equality — order-independent, since PA API result
 * ordering for the same node can shift call to call without the actual
 * bestseller set having changed. */
export function asinSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((asin, i) => asin === sortedB[i]);
}

async function sweepOneNode(
  agent: SEOArticleAgent,
  node: BestsellerNode,
  credentialPairs: AmazonCredentialPair[],
  tag: string
): Promise<void> {
  agent.log(
    "info",
    `Scout: scouting best sellers — node ${node.nodeId} (${node.categoryName})`,
    "topSellerScout"
  );

  if (credentialPairs.length === 0) {
    agent.log(
      "warning",
      `Top Seller Scout: no Amazon PA API credentials configured (AMAZON_ACCESS_KEY/AMAZON_SECRET_KEY or _FALLBACK) — skipping node ${node.nodeId}`,
      "topSellerScout"
    );
    return;
  }

  let asins: string[] = [];
  for (const { key, secret, label } of credentialPairs) {
    if (asins.length > 0) break;
    try {
      const products = await fetchBestsellersByBrowseNode(
        node.nodeId,
        key,
        secret,
        tag,
        (msg) =>
          agent.log(
            "warning",
            `Top Seller Scout (PA API ${label}, node ${node.nodeId}): ${msg}`,
            "topSellerScout"
          )
      );
      asins = products
        .map((p) => p.asin)
        .filter((a): a is string => Boolean(a));
    } catch (err: unknown) {
      agent.log(
        "warning",
        `Top Seller Scout (PA API ${label}, node ${node.nodeId}) error: ${errMsg(err)}`,
        "topSellerScout"
      );
    }
  }

  if (asins.length === 0) {
    agent.log(
      "warning",
      `Top Seller Scout: 0 bestsellers returned for node ${node.nodeId} (${node.categoryName}) — leaving prior sweep data in place, will retry next sweep`,
      "topSellerScout"
    );
    return;
  }

  const existingRows = agent.sql<{ last_asins: string; category_slug: string }>`
    SELECT last_asins, category_slug FROM bestseller_nodes WHERE node_id = ${node.nodeId}
  `;
  const previousAsins: string[] =
    existingRows.length > 0
      ? (JSON.parse(existingRows[0].last_asins || "[]") as string[])
      : [];
  const categorySlug =
    existingRows.length > 0
      ? existingRows[0].category_slug
      : deriveCategorySlug(node.categoryName);
  const changed = !asinSetsEqual(asins, previousAsins);

  agent.sql`INSERT INTO bestseller_nodes (node_id, category_name, category_slug, last_swept_at, last_asins)
    VALUES (${node.nodeId}, ${node.categoryName}, ${categorySlug}, ${Date.now()}, ${JSON.stringify(asins)})
    ON CONFLICT(node_id) DO UPDATE SET
      last_swept_at = excluded.last_swept_at,
      last_asins = excluded.last_asins`;

  if (!changed && existingRows.length > 0) {
    agent.log(
      "info",
      `Top Seller Scout: node ${node.nodeId} (${node.categoryName}) — no change in bestsellers since last sweep, nothing to do`,
      "topSellerScout"
    );
    return;
  }

  // Route the bestseller-derived keyword through the Scout Database
  // (KEYWORDS_DB) — the autonomous loop claims it from there like every
  // other keyword. Real Amazon-demand data, tagged source='top-seller'.
  const keyword = `best ${node.categoryName.toLowerCase()}`;
  const slug = keywordToSlug(keyword);
  const db = agent.envBindings.KEYWORDS_DB;
  if (!db) {
    agent.log(
      "warning",
      `Top Seller Scout: KEYWORDS_DB binding missing — cannot enqueue "${keyword}"`,
      "topSellerScout"
    );
    return;
  }
  try {
    const existing = await db
      .prepare(`SELECT status FROM scout_keywords WHERE slug = ?1`)
      .bind(slug)
      .all<{ status: string }>();
    const row = existing.results?.[0];
    if (!row) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO scout_keywords
             (keyword, slug, category_slug, category_title, source, status)
           VALUES (?1, ?2, ?3, ?4, 'top-seller', 'pending')`
        )
        .bind(keyword, slug, categorySlug, node.categoryName)
        .run();
      agent.log(
        "info",
        `Top Seller Scout: seeded "${keyword}" into the Scout DB for node ${node.nodeId} (${asins.length} real bestsellers found)`,
        "topSellerScout"
      );
    } else if (row.status === "published") {
      // Bestseller lineup changed since the article was last written —
      // requeue for a refresh rather than inserting a duplicate row.
      await db
        .prepare(
          `UPDATE scout_keywords
              SET status = 'pending', kv_key = '', error = '',
                  claimed_at = NULL, finished_at = NULL
            WHERE slug = ?1`
        )
        .bind(slug)
        .run();
      agent.log(
        "info",
        `Top Seller Scout: bestsellers changed for node ${node.nodeId} (${node.categoryName}) — requeued "${keyword}" in the Scout DB`,
        "topSellerScout"
      );
    } else {
      agent.log(
        "info",
        `Top Seller Scout: bestsellers changed for node ${node.nodeId} but "${keyword}" is already ${row.status} in the Scout DB — leaving as-is`,
        "topSellerScout"
      );
    }
  } catch (dbErr: unknown) {
    agent.log(
      "warning",
      `Top Seller Scout: Scout DB enqueue failed for "${keyword}": ${errMsg(dbErr)}`,
      "topSellerScout"
    );
  }
}

/**
 * Sweep all 18 fixed browse nodes once. Called by `topSellerScoutTick`
 * (server.ts) on a 24h schedule. Intentionally sequential, not
 * parallel — 18 nodes at a few seconds each comfortably fits inside
 * TOP_SELLER_SCOUT_TIMEOUT_MS, and sequential calls are gentler on
 * PA API's per-account rate limit than firing 18 requests at once.
 */
export async function runTopSellerScoutSweep(
  agent: SEOArticleAgent
): Promise<void> {
  const credentialPairs = resolveCredentialPairs(agent);
  const tag = agent.envBindings.AMAZON_AFFILIATE_TAG || "catsluvus03-20";

  for (const node of BESTSELLER_NODES) {
    await sweepOneNode(agent, node, credentialPairs, tag);
  }

  agent.log(
    "info",
    "Scout: best-sellers list exhausted — resuming ROI-based scouting",
    "topSellerScout"
  );
}
