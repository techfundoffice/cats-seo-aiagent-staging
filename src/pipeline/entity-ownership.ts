/**
 * entity-ownership.ts — the cannibalization guard.
 *
 * One (entity, intent) pair may have at most one live owning article.
 * `checkKeywordOwnership` runs BEFORE generation so a duplicate is never
 * written; `recordKeywordOwnership` runs after a successful publish so
 * the next claim sees it.
 *
 * Every function here is fail-open: if the table is missing, the DB is
 * unavailable, or anything throws, the pipeline behaves exactly as it
 * did before this feature existed. A graph miss must never fail — or
 * silently block — a publish.
 */

import { errMsg } from "./http-utils";
import { resolveKeywordEntity, type EntityIntent } from "./entity-resolver";

export interface OwnershipVerdict {
  /** True when another LIVE article already owns this entity+intent. */
  duplicate: boolean;
  entityId: string;
  intent: EntityIntent;
  /** kvKey of the existing owner, when duplicate. */
  ownerKvKey?: string;
  ownerUrl?: string;
}

/**
 * Does a live article already own this keyword's (entity, intent)?
 *
 * Deliberately requires an EXACT entity+intent match rather than fuzzy
 * similarity: a near-miss must never block a legitimate publish. The
 * fuzzy comparison lives in the reporting sweep, where a human decides.
 */
export async function checkKeywordOwnership(
  db: D1Database | undefined,
  keyword: string,
  opts: { asin?: string; categorySlug?: string } = {}
): Promise<OwnershipVerdict> {
  const resolved = resolveKeywordEntity(keyword, opts);
  const base: OwnershipVerdict = {
    duplicate: false,
    entityId: resolved.entityId,
    intent: resolved.intent
  };
  if (!db) return base;
  try {
    const row = await db
      .prepare(
        `SELECT owning_kv_key, owning_url
           FROM keyword_ownership
          WHERE entity_id = ?1 AND intent = ?2 AND status = 'owned'
          LIMIT 1`
      )
      .bind(resolved.entityId, resolved.intent)
      .first<{ owning_kv_key: string; owning_url: string }>();
    if (!row?.owning_kv_key) return base;
    return {
      ...base,
      duplicate: true,
      ownerKvKey: row.owning_kv_key,
      ownerUrl: row.owning_url
    };
  } catch {
    // Table missing (pre-migration) or D1 hiccup — fail open.
    return base;
  }
}

/**
 * Record ownership after a successful publish. Idempotent: re-publishing
 * the same kvKey refreshes its row rather than conflicting.
 *
 * The partial unique index on (entity_id, intent) WHERE status='owned'
 * means a genuine race can raise a constraint error. That is caught and
 * swallowed: losing the race means someone else owns it, which is the
 * correct end state either way.
 */
export async function recordKeywordOwnership(
  db: D1Database | undefined,
  params: {
    keyword: string;
    keywordSlug: string;
    kvKey: string;
    url: string;
    asin?: string;
    categorySlug?: string;
  }
): Promise<{ ok: boolean; entityId: string; error?: string }> {
  // Resolve WITHOUT the ASIN, deliberately.
  //
  // The claim-time guard runs before products are fetched, so it can only
  // ever compute a `topic:<tokens>` entity. If ownership were recorded
  // under `product:<ASIN>` the two would live in different namespaces and
  // the guard would be structurally blind to everything published since
  // the feature shipped. That is exactly what happened: by 2026-07-28 the
  // table held 230 `product:` rows against 193 `topic:` rows (the latter
  // only from the initial backfill), and both guard firings to date had
  // matched backfilled rows. Coverage was degrading with every publish.
  //
  // The ASIN is still the stronger identity, but it is useless to a guard
  // that cannot see it. Symmetry with the checker beats precision here;
  // the ASIN is retained on the entities row instead.
  const resolved = resolveKeywordEntity(params.keyword, {
    categorySlug: params.categorySlug
  });
  if (!db) return { ok: false, entityId: resolved.entityId, error: "no db" };
  try {
    // Clear any prior live row for this kvKey so a re-publish under a
    // changed keyword doesn't leave a stale owner behind.
    await db
      .prepare(
        `UPDATE keyword_ownership SET status = 'superseded'
          WHERE owning_kv_key = ?1 AND status = 'owned'
            AND entity_id != ?2`
      )
      .bind(params.kvKey, resolved.entityId)
      .run();

    await db
      .prepare(
        `INSERT INTO keyword_ownership
           (keyword_slug, entity_id, intent, owning_kv_key, owning_url, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'owned')
         ON CONFLICT (keyword_slug) DO UPDATE SET
           entity_id = excluded.entity_id,
           intent = excluded.intent,
           owning_kv_key = excluded.owning_kv_key,
           owning_url = excluded.owning_url,
           status = 'owned',
           claimed_at = datetime('now')`
      )
      .bind(
        params.keywordSlug,
        resolved.entityId,
        resolved.intent,
        params.kvKey,
        params.url
      )
      .run();
    return { ok: true, entityId: resolved.entityId };
  } catch (err: unknown) {
    // Unique-index collision = another article already owns this
    // entity+intent. Expected under races; not an error worth failing on.
    return { ok: false, entityId: resolved.entityId, error: errMsg(err) };
  }
}

/** Ensure an entity row exists. Best-effort; never throws. */
export async function upsertEntity(
  db: D1Database | undefined,
  entity: {
    id: string;
    type: string;
    canonicalName: string;
    slug: string;
    asin?: string;
  }
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        `INSERT INTO entities (id, type, canonical_name, slug, asin)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET
           canonical_name = excluded.canonical_name,
           updated_at = datetime('now')`
      )
      .bind(
        entity.id,
        entity.type,
        entity.canonicalName,
        entity.slug,
        entity.asin ?? null
      )
      .run();
  } catch {
    /* best-effort */
  }
}
