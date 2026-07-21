/**
 * Multi-provider health derivation from the in-memory activity log.
 * Generalizes the Kimi-only banner shipped in #4780. Operators have
 * been silently losing multiple external services at once (OpenRouter
 * credit wall + Composio API-key revocation + DataForSEO 402 paid-tier
 * exhaustion). Without a unified view, each surfaces only as scattered
 * warning lines that are easy to miss.
 *
 * Pure derivation. No state field, endpoint, scheduled tick.
 */

import { computeKimiProviderHealth } from "./kimiProviderHealth";

export type ExternalProviderId =
  | "kimi"
  | "composio"
  | "dataforseo"
  | "amazon"
  | "indexnow";

type ProviderHealthTier = "ok" | "degraded" | "exhausted";

export interface ExternalProviderStatus {
  id: ExternalProviderId;
  label: string;
  tier: ProviderHealthTier;
  failures: number;
  /**
   * Operator-actionable next step. Either a top-up URL, a credential
   * rotation note, or both. Rendered as a link in the banner.
   */
  remediation: string;
  remediationUrl?: string;
  /** Short description of WHAT we observed in the log. */
  evidence: string;
}

/**
 * Composio API-key auth failures. Surfaces when the sheet mirror /
 * Doppler / browser-tool calls reject the configured `ak_…` key with a
 * 401 — operator needs to rotate via Composio dashboard. Detected via
 * the canonical "Invalid API key" wire message + the `ak_` prefix.
 */
const COMPOSIO_AUTH_PATTERN = /Invalid API key:\s*ak_[A-Za-z0-9_*]{3,}/i;

/**
 * DataForSEO HTTP 402 ("payment required") — the analytics + SERP
 * fallback chain exhausts a paid-tier quota and starts returning 402.
 * Detected on the canonical `Analytics tick: ranked_keywords failed`
 * wrapper that carries the HTTP code.
 */
const DATAFORSEO_402_PATTERN =
  /(?:Analytics tick|ranked_keywords|DataForSEO)[^\n]*HTTP 402\b/i;

/**
 * Amazon Creators API OAuth2 token-exchange failure. When this fails,
 * the affiliate URL primary path is dead and every product pick ships
 * with broken/missing CTA buttons — direct revenue + UX hit, and a
 * ranking signal regression (commerce-intent articles with no
 * checkout links bounce harder).
 *
 * Detected on the canonical wrapper that carries the failure reason:
 *   `Amazon (Creators API primary): Creators API: OAuth2 token
 *    exchange failed (401 Unauthorized) — {…}`
 */
const AMAZON_CREATORS_AUTH_PATTERN =
  /Amazon \(Creators API[^)]*\):[^\n]*(?:OAuth2 token exchange failed|401 Unauthorized|Client authentication failed)/i;

/**
 * IndexNow API rejecting the site as unverified (UserForbiddedToAccessSite).
 * When this fires, newly-published article URLs are NOT being announced
 * to Bing/Yandex — indexation slows to crawl-discovery pace. Site
 * verification needs to be repaired (key file at
 * /<INDEXNOW_KEY>.txt, or HTTP host mismatch).
 */
const INDEXNOW_403_PATTERN =
  /IndexNow:\s*403\b[^\n]*(?:Forbidden|UserForbiddedToAccessSite)/i;

/** Threshold above which any non-Kimi provider gets the "exhausted" tier. */
const EXHAUSTED_THRESHOLD = 5;

function classify(failures: number): { tier: ProviderHealthTier } {
  if (failures >= EXHAUSTED_THRESHOLD) return { tier: "exhausted" };
  if (failures > 0) return { tier: "degraded" };
  return { tier: "ok" };
}

/**
 * Derive the full, fixed-order provider-health snapshot used by the
 * dashboard banner from recent activity-log rows. Every known provider
 * is always returned so callers can render a stable list and then decide
 * whether to keep only degraded entries via `degradedProviders()`.
 */
export function computeExternalProviderHealth(
  activityLog: ReadonlyArray<{ msg?: string }>
): ExternalProviderStatus[] {
  // Kimi delegates to the dedicated helper so detection thresholds stay
  // pinned to the existing tests.
  const kimi = computeKimiProviderHealth(activityLog);

  let composioFailures = 0;
  let dataforseoFailures = 0;
  let amazonFailures = 0;
  let indexnowFailures = 0;
  for (const entry of activityLog) {
    const msg = entry.msg ?? "";
    if (COMPOSIO_AUTH_PATTERN.test(msg)) composioFailures++;
    if (DATAFORSEO_402_PATTERN.test(msg)) dataforseoFailures++;
    if (AMAZON_CREATORS_AUTH_PATTERN.test(msg)) amazonFailures++;
    if (INDEXNOW_403_PATTERN.test(msg)) indexnowFailures++;
  }
  const composio = classify(composioFailures);
  const dataforseo = classify(dataforseoFailures);
  const amazon = classify(amazonFailures);
  const indexnow = classify(indexnowFailures);

  const statuses: ExternalProviderStatus[] = [
    {
      id: "kimi",
      label: "Kimi (OpenRouter)",
      tier: kimi.tier,
      failures: kimi.openrouterFailures,
      evidence: `${kimi.openrouterFailures} OpenRouter failure(s), ${kimi.creditsExhaustedHits} credit-exhausted`,
      remediation: "Top up OpenRouter credits",
      remediationUrl: "https://openrouter.ai/settings/credits"
    },
    {
      id: "composio",
      label: "Composio (sheet mirror / browser / Doppler)",
      tier: composio.tier,
      failures: composioFailures,
      evidence: `${composioFailures} "Invalid API key: ak_…" auth failure(s) in the live log`,
      remediation:
        "Rotate COMPOSIO_API_KEY worker secret (Cloudflare → Workers → secrets)",
      remediationUrl: "https://app.composio.dev/settings"
    },
    {
      id: "dataforseo",
      label: "DataForSEO (analytics + ranked keywords)",
      tier: dataforseo.tier,
      failures: dataforseoFailures,
      evidence: `${dataforseoFailures} ranked-keywords HTTP 402 (paid tier quota)`,
      remediation: "Top up DataForSEO credits / verify API plan",
      remediationUrl: "https://app.dataforseo.com/login"
    },
    {
      id: "amazon",
      label: "Amazon Creators API (affiliate URLs)",
      tier: amazon.tier,
      failures: amazonFailures,
      evidence: `${amazonFailures} OAuth2 token-exchange 401(s) — product picks may ship with broken CTAs`,
      remediation:
        "Rotate AMAZON_APP_ID / AMAZON_API_SECRET (Creators API Cognito client_id/secret) worker secrets, or point AMAZON_APP_ID_FALLBACK / AMAZON_API_SECRET_FALLBACK at a known-good pair",
      remediationUrl: "https://affiliate-program.amazon.com/influencer-hub"
    },
    {
      id: "indexnow",
      label: "IndexNow (Bing/Yandex announce)",
      tier: indexnow.tier,
      failures: indexnowFailures,
      evidence: `${indexnowFailures} "UserForbiddedToAccessSite" 403(s) — newly-published URLs not announced`,
      remediation:
        "Re-verify site ownership: ensure /<INDEXNOW_KEY>.txt is reachable on catsluvus.com",
      remediationUrl: "https://www.indexnow.org/documentation"
    }
  ];

  return statuses;
}

/**
 * Return only the providers currently degraded (any tier != "ok"), in
 * the same order as `computeExternalProviderHealth`. The dashboard
 * renders only this filtered list so healthy providers stay invisible.
 */
export function degradedProviders(
  activityLog: ReadonlyArray<{ msg?: string }>
): ExternalProviderStatus[] {
  return computeExternalProviderHealth(activityLog).filter(
    (p) => p.tier !== "ok"
  );
}
