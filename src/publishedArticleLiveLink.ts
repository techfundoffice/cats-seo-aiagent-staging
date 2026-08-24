/**
 * Where does a published article actually serve?
 *
 * The Published Article Log panel used to link every row at its staging
 * (`workers.dev`) URL and label the link "live". That is wrong in both
 * directions:
 *
 *   - An article that cleared `PROD_PUBLISH_MIN_SCORE` was promoted by
 *     `prod-publish.ts`, which DELETES the staging KV entry and leaves a
 *     `redirect:<kvKey>` tombstone. The staging URL then only 301s to
 *     catsluvus.com — it is no longer the article's address.
 *   - An article below the bar was never promoted. Its staging URL renders
 *     fine, so the panel looked healthy, while the article 404s on
 *     catsluvus.com and is invisible to readers and crawlers.
 *
 * This resolves one row into the link the operator should actually click
 * plus a state label. Kept as a pure function so the rule is testable
 * without rendering the dashboard.
 */

/** Promotion state as recorded on a `recentPublishedArticles` row. */
export type ArticlePromotionStatus = "published-prod" | "staging-only";

export interface PublishedArticleLinkInput {
  /** Staging (workers.dev) URL. A 301 tombstone once promoted. */
  url?: string;
  /** catsluvus.com URL, present only after a successful promotion. */
  prodUrl?: string;
  /** Absent on rows written before promotion tracking existed. */
  promotionStatus?: ArticlePromotionStatus;
}

export interface PublishedArticleLink {
  /** True when the article is serving on the production domain. */
  promoted: boolean;
  /**
   * False only for legacy rows that predate promotion tracking. The panel
   * renders those as "unknown" rather than guessing either way.
   */
  promotionKnown: boolean;
  /** The URL worth opening — production when promoted, else staging. */
  href: string;
  /** Badge text for the Live column. */
  label: "prod" | "staging only" | "unknown";
}

/**
 * Resolve a published-article row into its real live link + state.
 *
 * A row counts as promoted when it says so explicitly, or when it carries a
 * `prodUrl` (older rows recorded the URL before the status field existed).
 * `href` falls back to the staging URL whenever production is unavailable,
 * so a row never renders as an empty link.
 */
export function resolvePublishedArticleLink(
  row: PublishedArticleLinkInput
): PublishedArticleLink {
  const prodUrl = row.prodUrl?.trim() ?? "";
  const stagingUrl = row.url?.trim() ?? "";
  const promoted = row.promotionStatus === "published-prod" || prodUrl !== "";
  const promotionKnown = row.promotionStatus != null || prodUrl !== "";
  return {
    promoted,
    promotionKnown,
    href: promoted && prodUrl !== "" ? prodUrl : stagingUrl,
    label: promoted ? "prod" : promotionKnown ? "staging only" : "unknown"
  };
}
