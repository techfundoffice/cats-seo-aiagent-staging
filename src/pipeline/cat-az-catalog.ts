/**
 * Cat A–Z catalog refill.
 *
 * Pending keywords come from real Amazon cat products. Each tick tries
 * several queries for the current letter (A, then B, …) until a title or
 * brand starts with that letter, enqueues those product keywords with
 * their ASINs, and advances when the letter is exhausted. Exhausted means
 * the catalog page was empty, every matching product was already seen or
 * rejected, or the pending cap filled and no enqueueable match remains.
 * Hits that do not match the letter do not move the cursor. A partial
 * enqueue that still has buffer room also leaves the cursor in place.
 * The pending buffer stays small so Generate 1 claims one real product.
 */

import type { SEOArticleAgent } from "../server";
import type { AmazonProduct } from "./amazon";
import { fetchViaCreatorsApi, fetchViaPaApi } from "./amazon";
import {
  evaluateCommercialKeyword,
  isJunkProductKeyword
} from "./commercial-keyword-gate";
import { errMsg, getEnvBinding, keywordToSlug } from "./http-utils";

export const CAT_AZ_PENDING_CAP = 3;
export const CAT_AZ_SOURCE = "cat-az";

const ASIN_RE = /^[A-Z0-9]{10}$/;

export interface CatAzCatalogHit {
  asin: string;
  title: string;
  brand?: string;
}

export interface CatAzEnqueueRow {
  keyword: string;
  asin: string;
  slug: string;
  categorySlug: string;
  categoryTitle: string;
}

export interface CatAzRefillPlan {
  enqueue: CatAzEnqueueRow[];
  skipAsins: string[];
  nextLetter: string;
  advanced: boolean;
}

export interface CatAzRefillReport {
  enqueued: number;
  skippedJunk: number;
  letter: string;
  nextLetter: string;
  advanced: boolean;
  pending: number;
  searched: boolean;
}

interface CredentialPair {
  id: string;
  secret: string;
  label: string;
}

interface PaPair {
  key: string;
  secret: string;
  label: string;
}

export function normalizeCursorLetter(
  letter: string | null | undefined
): string {
  const ch = (letter ?? "").trim().toUpperCase();
  if (/^[A-Z]$/.test(ch)) return ch;
  return "A";
}

export function nextCatalogLetter(letter: string): string {
  const current = normalizeCursorLetter(letter);
  if (current === "Z") return "A";
  return String.fromCharCode(current.charCodeAt(0) + 1);
}

export function catAzCategorySlug(letter: string): string {
  return `cat-${normalizeCursorLetter(letter).toLowerCase()}`;
}

/** Queries tried, in order, until a letter-matching product appears. */
export function catCatalogSearchQueries(letter: string): readonly string[] {
  const normalized = normalizeCursorLetter(letter);
  return [
    `cat ${normalized}`,
    `${normalized} for cats`,
    `${normalized} cat toy`,
    `${normalized} cat tree`
  ];
}

export function catCatalogSearchKeyword(letter: string): string {
  return catCatalogSearchQueries(letter)[0];
}

export function leadingCatalogLetter(value: string): string {
  const match = value.match(/[A-Za-z]/);
  return match ? match[0].toUpperCase() : "";
}

export function matchesCatalogLetter(
  product: { title: string; brand?: string },
  letter: string
): boolean {
  const target = normalizeCursorLetter(letter);
  return (
    leadingCatalogLetter(product.title) === target ||
    leadingCatalogLetter(product.brand ?? "") === target
  );
}

export function keywordFromCatalogTitle(title: string): string {
  return title
    .replace(/[®™©]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function planCatAzRefill(input: {
  letter: string;
  doneAsins: ReadonlySet<string>;
  pendingCount: number;
  products: readonly CatAzCatalogHit[];
  searchOk: boolean;
  cap?: number;
}): CatAzRefillPlan {
  const letter = normalizeCursorLetter(input.letter);
  const cap = input.cap ?? CAT_AZ_PENDING_CAP;
  const slots = Math.max(0, cap - Math.max(0, input.pendingCount));
  if (!input.searchOk || slots === 0) {
    return {
      enqueue: [],
      skipAsins: [],
      nextLetter: letter,
      advanced: false
    };
  }

  const enqueue: CatAzEnqueueRow[] = [];
  const skipAsins: string[] = [];
  let stoppedForCap = false;
  let letterMatches = 0;
  let resolvedMatches = 0;
  const categorySlug = catAzCategorySlug(letter);
  const categoryTitle = `Cat ${letter}`;

  for (const product of input.products) {
    const asin = product.asin.trim().toUpperCase();
    if (!ASIN_RE.test(asin)) continue;
    if (!matchesCatalogLetter(product, letter)) continue;
    letterMatches++;
    if (input.doneAsins.has(asin)) {
      resolvedMatches++;
      continue;
    }
    const keyword = keywordFromCatalogTitle(product.title);
    const gate = keyword
      ? evaluateCommercialKeyword(keyword, categorySlug)
      : null;
    if (!keyword || !gate?.ok) {
      skipAsins.push(asin);
      resolvedMatches++;
      continue;
    }
    if (enqueue.length >= slots) {
      stoppedForCap = true;
      break;
    }
    enqueue.push({
      keyword,
      asin,
      slug: keywordToSlug(keyword),
      categorySlug,
      categoryTitle
    });
  }

  // Hold the letter when this search returned products but none match it.
  // Advance when the page was empty, when every letter match was already
  // seen or rejected, or when the pending cap is full and every remaining
  // match was skipped. A partial enqueue that still has buffer room stays
  // put so the next tick can try another query for this letter.
  const everyMatchSeenOrRejected =
    letterMatches > 0 && resolvedMatches === letterMatches && !stoppedForCap;
  const capFilledAndPageDone =
    enqueue.length > 0 && enqueue.length >= slots && !stoppedForCap;
  const advanced =
    input.products.length === 0 ||
    everyMatchSeenOrRejected ||
    capFilledAndPageDone;
  return {
    enqueue,
    skipAsins,
    nextLetter: advanced ? nextCatalogLetter(letter) : letter,
    advanced
  };
}

interface CatalogQueryPage {
  ok: boolean;
  products: AmazonProduct[];
  matched: AmazonProduct[];
}

function isFreshCatalogAsin(
  asin: string | undefined,
  doneAsins: ReadonlySet<string>
): boolean {
  const normalized = (asin ?? "").trim().toUpperCase();
  return ASIN_RE.test(normalized) && !doneAsins.has(normalized);
}

async function searchCatalogQuery(
  keyword: string,
  creds: { creators: CredentialPair[]; pa: PaPair[] },
  tag: string,
  letter: string,
  onWarn: (msg: string) => void
): Promise<CatalogQueryPage> {
  let anySuccess = false;
  let lastHits: AmazonProduct[] = [];
  const consider = (
    found: AmazonProduct[],
    warned: boolean
  ): AmazonProduct[] | null => {
    if (!warned || found.length > 0) anySuccess = true;
    if (found.length > 0) lastHits = found;
    const matched = found.filter((product) =>
      matchesCatalogLetter(
        { title: product.name || "", brand: product.brand },
        letter
      )
    );
    return matched.length > 0 ? matched : null;
  };

  for (const pair of creds.creators) {
    let warned = false;
    try {
      const found = await fetchViaCreatorsApi(
        keyword,
        pair.id,
        pair.secret,
        tag,
        (msg) => {
          warned = true;
          onWarn(`Creators ${pair.label}: ${msg}`);
        }
      );
      const matched = consider(found, warned);
      if (matched) return { ok: true, products: found, matched };
    } catch (err: unknown) {
      onWarn(`Creators ${pair.label}: ${errMsg(err)}`);
    }
  }

  for (const pair of creds.pa) {
    let warned = false;
    try {
      const found = await fetchViaPaApi(
        keyword,
        pair.key,
        pair.secret,
        tag,
        (msg) => {
          warned = true;
          onWarn(`PA API ${pair.label}: ${msg}`);
        }
      );
      const matched = consider(found, warned);
      if (matched) return { ok: true, products: found, matched };
    } catch (err: unknown) {
      onWarn(`PA API ${pair.label}: ${errMsg(err)}`);
    }
  }

  return { ok: anySuccess, products: lastHits, matched: [] };
}

export async function searchCatCatalogLetter(
  letter: string,
  creds: { creators: CredentialPair[]; pa: PaPair[] },
  tag: string,
  onWarn: (msg: string) => void,
  doneAsins: ReadonlySet<string> = new Set()
): Promise<{ ok: boolean; products: AmazonProduct[] }> {
  if (creds.creators.length === 0 && creds.pa.length === 0) {
    return { ok: false, products: [] };
  }

  const queries = catCatalogSearchQueries(letter);
  const normalized = normalizeCursorLetter(letter);
  let anySuccess = false;
  let unmatchedHits = 0;
  let unmatched: AmazonProduct[] = [];
  const exhausted: AmazonProduct[] = [];

  for (const keyword of queries) {
    const page = await searchCatalogQuery(keyword, creds, tag, letter, onWarn);
    if (page.ok) anySuccess = true;
    if (page.matched.length === 0) {
      if (page.products.length > 0) {
        unmatched = page.products;
        unmatchedHits += page.products.length;
      }
      continue;
    }
    const fresh = page.matched.filter((product) =>
      isFreshCatalogAsin(product.asin, doneAsins)
    );
    if (fresh.length > 0) return { ok: true, products: page.matched };
    exhausted.push(...page.matched);
  }

  if (exhausted.length > 0) {
    return { ok: anySuccess, products: exhausted };
  }

  if (anySuccess && unmatched.length > 0) {
    onWarn(
      `letter ${normalized} searches returned ${unmatchedHits} catalog hit(s) but no title or brand starts with ${normalized} (tried: ${queries.join(", ")}) — not advancing`
    );
    return { ok: true, products: unmatched };
  }

  return { ok: anySuccess, products: [] };
}

function creatorsPairs(agent: SEOArticleAgent): CredentialPair[] {
  const pairs: CredentialPair[] = [];
  const appId = getEnvBinding(agent.envBindings, "AMAZON_APP_ID");
  const credId = getEnvBinding(agent.envBindings, "AMAZON_CREDENTIAL_ID");
  const primaryId = (appId || credId || "").trim();
  const primarySecret = getEnvBinding(agent.envBindings, "AMAZON_API_SECRET");
  if (primaryId && primarySecret) {
    pairs.push({
      id: primaryId,
      secret: primarySecret,
      label: appId ? "primary" : "legacy"
    });
  }
  const fallbackId = getEnvBinding(agent.envBindings, "AMAZON_APP_ID_FALLBACK");
  const fallbackSecret = getEnvBinding(
    agent.envBindings,
    "AMAZON_API_SECRET_FALLBACK"
  );
  if (fallbackId && fallbackSecret) {
    pairs.push({ id: fallbackId, secret: fallbackSecret, label: "fallback" });
  }
  return pairs;
}

function paPairs(agent: SEOArticleAgent): PaPair[] {
  const pairs: PaPair[] = [];
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
    pairs.push({
      key: fallbackKey,
      secret: fallbackSecret,
      label: "fallback"
    });
  }
  return pairs;
}

function affiliateTag(agent: SEOArticleAgent): string {
  return agent.envBindings.AMAZON_AFFILIATE_TAG || "catsluvus03-20";
}

async function ensureCatAzSchema(
  db: NonNullable<SEOArticleAgent["envBindings"]["KEYWORDS_DB"]>
): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS cat_az_cursor (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         letter TEXT NOT NULL DEFAULT 'A'
       )`
    )
    .run();
  await db
    .prepare(`INSERT OR IGNORE INTO cat_az_cursor (id, letter) VALUES (1, 'A')`)
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS cat_az_seen_asin (
         asin TEXT PRIMARY KEY,
         letter TEXT NOT NULL,
         disposition TEXT NOT NULL
       )`
    )
    .run();
  try {
    await db
      .prepare(`ALTER TABLE scout_keywords ADD COLUMN asin TEXT DEFAULT ''`)
      .run();
  } catch (err: unknown) {
    const msg = errMsg(err).toLowerCase();
    if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
      throw err;
    }
  }
}

async function rejectJunkPending(
  agent: SEOArticleAgent,
  db: NonNullable<SEOArticleAgent["envBindings"]["KEYWORDS_DB"]>
): Promise<number> {
  let skipped = 0;
  const runtime = agent.sql<{ id: string; keyword: string }>`
    SELECT id, keyword FROM keywords WHERE status = 'pending' LIMIT 100`;
  for (const row of runtime) {
    if (!isJunkProductKeyword(row.keyword)) continue;
    agent.sql`UPDATE keywords SET status = 'skipped' WHERE id = ${row.id}`;
    skipped++;
  }

  const pending = await db
    .prepare(
      `SELECT id, keyword FROM scout_keywords
        WHERE status = 'pending'
        LIMIT 200`
    )
    .all<{ id: number; keyword: string }>();
  for (const row of pending.results ?? []) {
    if (!isJunkProductKeyword(row.keyword)) continue;
    await db
      .prepare(
        `UPDATE scout_keywords
            SET status = 'rejected', error = 'junk-keyword',
                finished_at = datetime('now')
          WHERE id = ?1 AND status = 'pending'`
      )
      .bind(row.id)
      .run();
    skipped++;
  }
  return skipped;
}

/**
 * One refill tick. No-ops when the Cat A–Z pending buffer is already full
 * or Amazon credentials are missing (the letter stays put on auth failure).
 */
export async function refillCatAzKeywords(
  agent: SEOArticleAgent
): Promise<CatAzRefillReport> {
  const empty: CatAzRefillReport = {
    enqueued: 0,
    skippedJunk: 0,
    letter: "A",
    nextLetter: "A",
    advanced: false,
    pending: 0,
    searched: false
  };
  const db = agent.envBindings.KEYWORDS_DB;
  if (!db) {
    agent.log(
      "warning",
      "Cat A–Z: KEYWORDS_DB binding missing — cannot enqueue product keywords",
      "analyst"
    );
    return empty;
  }

  await ensureCatAzSchema(db);
  const skippedJunk = await rejectJunkPending(agent, db);

  const pendingRes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM scout_keywords
        WHERE status = 'pending' AND source = ?1`
    )
    .bind(CAT_AZ_SOURCE)
    .all<{ n: number }>();
  const pending = Number(pendingRes.results?.[0]?.n ?? 0);

  const cursorRes = await db
    .prepare(`SELECT letter FROM cat_az_cursor WHERE id = 1`)
    .all<{ letter: string }>();
  const letter = normalizeCursorLetter(cursorRes.results?.[0]?.letter);

  if (pending >= CAT_AZ_PENDING_CAP) {
    if (skippedJunk > 0) {
      agent.log(
        "info",
        `Cat A–Z: rejected ${skippedJunk} junk pending keyword(s); buffer already at ${pending}`,
        "analyst"
      );
    }
    return {
      ...empty,
      skippedJunk,
      letter,
      nextLetter: letter,
      pending
    };
  }

  const creators = creatorsPairs(agent);
  const pa = paPairs(agent);
  if (creators.length === 0 && pa.length === 0) {
    agent.log(
      "warning",
      "Cat A–Z: no Amazon Creators or PA API credentials — letter cursor unchanged",
      "analyst"
    );
    return { ...empty, skippedJunk, letter, nextLetter: letter, pending };
  }

  const seenRes = await db
    .prepare(`SELECT asin FROM cat_az_seen_asin`)
    .all<{ asin: string }>();
  const doneAsins = new Set(
    (seenRes.results ?? []).map((row) => row.asin.toUpperCase())
  );
  const search = await searchCatCatalogLetter(
    letter,
    { creators, pa },
    affiliateTag(agent),
    (msg) => agent.log("warning", `Cat A–Z: ${msg}`, "productManager"),
    doneAsins
  );
  const plan = planCatAzRefill({
    letter,
    doneAsins,
    pendingCount: pending,
    products: search.products.map((product) => ({
      asin: product.asin ?? "",
      title: product.name || "",
      brand: product.brand
    })),
    searchOk: search.ok
  });

  for (const row of plan.enqueue) {
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO scout_keywords
           (keyword, slug, category_slug, category_title, source, status, priority, asin)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 100, ?6)`
      )
      .bind(
        row.keyword,
        row.slug,
        row.categorySlug,
        row.categoryTitle,
        CAT_AZ_SOURCE,
        row.asin
      )
      .run();
    const wrote = (inserted.meta?.changes ?? 0) > 0;
    await db
      .prepare(
        `INSERT OR IGNORE INTO cat_az_seen_asin (asin, letter, disposition)
         VALUES (?1, ?2, 'enqueued')`
      )
      .bind(row.asin, letter)
      .run();
    if (wrote) {
      agent.log(
        "info",
        `Cat A–Z: enqueued "${row.keyword}" ASIN ${row.asin} (${row.categorySlug})`,
        "analyst",
        { kanbanStage: "queue", categorySlug: row.categorySlug }
      );
    }
  }

  for (const asin of plan.skipAsins) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO cat_az_seen_asin (asin, letter, disposition)
         VALUES (?1, ?2, 'skipped')`
      )
      .bind(asin, letter)
      .run();
  }

  if (plan.advanced) {
    await db
      .prepare(`UPDATE cat_az_cursor SET letter = ?1 WHERE id = 1`)
      .bind(plan.nextLetter)
      .run();
    agent.log(
      "info",
      `Cat A–Z: letter ${letter} exhausted — cursor now ${plan.nextLetter}`,
      "analyst"
    );
  }

  const enqueued = plan.enqueue.length;
  return {
    enqueued,
    skippedJunk,
    letter,
    nextLetter: plan.nextLetter,
    advanced: plan.advanced,
    pending: pending + enqueued,
    searched: true
  };
}
