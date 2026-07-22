import { errMsg } from "./http-utils";
/**
 * Amazon product lookup — 3-tier approach for Cloudflare Workers.
 *
 * Strict order (Amazon first, scraper only as last resort):
 *   Tier 1: Amazon Creators API (OAuth2 → real ASINs, prices, ratings, images)
 *   Tier 2: Amazon PA API v5 (HMAC-SHA256 → real ASINs, prices, ratings)
 *   Tier 3: Apify Amazon scraper (FALLBACK ONLY when tiers 1–2 return 0 products)
 *
 * Callers in writer.ts must never invert this order or call Apify when
 * Creators/PA already returned products.
 * Tier 4: SerpAPI Shopping via Composio (Google Shopping results)
 * Tier 5: Keyword-derived fallback
 */

/** Timeout for OAuth2 LWA token exchange (ms). */
const CREATORS_TOKEN_TIMEOUT_MS = 10_000;
/** Timeout for Creators API search call (ms). */
const CREATORS_SEARCH_TIMEOUT_MS = 15_000;
/** Timeout for PA API v5 search call (ms). */
const PA_API_TIMEOUT_MS = 15_000;
/** Timeout for each individual Apify API call (run start, status poll, dataset fetch) (ms). */
const APIFY_CALL_TIMEOUT_MS = 10_000;

/**
 * Max characters of an upstream API error-response body we include in
 * our own log messages. 240 keeps log lines scannable while still
 * showing enough of the error for diagnosis.
 */
const MAX_ERROR_BODY_LENGTH = 240;

/**
 * Product display-name truncation. Amazon product names can run 200+
 * chars; we render shorter strings in pick cards. 80/77 keeps the cut
 * with a `...` suffix exactly 80 chars long.
 */
const MAX_DISPLAY_NAME_LENGTH = 80;
const TRUNCATED_DISPLAY_NAME_PREFIX_LENGTH = 77;

/**
 * Max product features rendered in the pick blurb's "features" list.
 * Three keeps the card scannable; more clutters the layout.
 */
const MAX_FEATURE_COUNT = 3;

export interface AmazonProduct {
  name: string;
  displayName: string;
  asin?: string;
  price?: string;
  priceValue?: number;
  rating?: string;
  ratingValue?: number;
  reviewCount?: number;
  imageUrl?: string;
  url?: string;
  features?: string;
  brand?: string;
  source: "creators-api" | "pa-api-v5" | "apify";
}

// ── Tier 1: Amazon Creators API ─────────────────────────────────────────────

/**
 * Per-credential cache of bearer tokens AND circuit-breaker state. Keyed by
 * Cognito client_id so primary and fallback creds (AMAZON_APP_ID vs
 * AMAZON_APP_ID_FALLBACK) get independent state — a 401 against the
 * primary doesn't block the fallback retry, and the breaker disables the
 * specific failing credential without poisoning a working one.
 *
 * Cognito issues bearer tokens for any well-formed client pair, so
 * token-exchange success ≠ "the registered app is provisioned for the
 * Creators API". When `searchItems` returns 401 `InvalidToken`, retrying
 * the same client_id within the same DO isolate is guaranteed to fail the
 * same way until a Worker secret rotation or Amazon-side app
 * authorization. Cache the failure for 1h so we fire ONE warning per
 * isolate × credential, and let Tier 2 / fallback creds handle the rest.
 */
const creatorsCredentialState = new Map<
  string,
  { token: string | null; tokenExpiry: number; disabledUntil: number }
>();
const CREATORS_API_FAILURE_TTL_MS = 60 * 60_000;
type CreatorsTokenResult = { token: string | null; warning?: string };

function getCreatorsState(credentialId: string) {
  let s = creatorsCredentialState.get(credentialId);
  if (!s) {
    s = { token: null, tokenExpiry: 0, disabledUntil: 0 };
    creatorsCredentialState.set(credentialId, s);
  }
  return s;
}

async function getCreatorsToken(
  credentialId: string,
  credentialSecret: string
): Promise<CreatorsTokenResult> {
  const state = getCreatorsState(credentialId);
  if (Date.now() < state.disabledUntil) return { token: null };
  if (state.token && Date.now() < state.tokenExpiry) {
    return { token: state.token };
  }

  try {
    // Creators API v3.x — Login With Amazon (LWA) OAuth2 client_credentials.
    // Endpoint: api.amazon.com/auth/o2/token. Credentials go in the
    // Authorization: Basic header, NOT the request body. Scope is
    // `creatorsapi::default` (double colon, not slash). The previous Cognito
    // path (creatorsapi.auth.us-east-1.amazoncognito.com) was the v1/v2
    // pattern and now returns invalid_client.
    const basic = `Basic ${btoa(`${credentialId}:${credentialSecret}`)}`;
    const resp = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "creatorsapi::default"
      }).toString(),
      signal: AbortSignal.timeout(CREATORS_TOKEN_TIMEOUT_MS)
    });

    if (!resp.ok) {
      let body = "";
      let bodyReadFailure = "";
      try {
        body = (await resp.text())
          .slice(0, MAX_ERROR_BODY_LENGTH)
          .replace(/\s+/g, " ");
      } catch (err: unknown) {
        bodyReadFailure = `; response body unavailable: ${errMsg(err)}`;
      }
      // 401/403 means the client credentials themselves are bad
      // (invalid_client) — retrying the exchange on every product search
      // can't succeed and was logging 6-8 identical warnings per article.
      // Arm the same per-credential circuit breaker the search path uses;
      // the disabledUntil guard at the top of this function and of
      // fetchViaCreatorsApi then short-circuits silently until the TTL
      // expires (Tier 2 PA-API fallback takes over automatically).
      const isAuthFailure = resp.status === 401 || resp.status === 403;
      if (isAuthFailure) {
        state.disabledUntil = Date.now() + CREATORS_API_FAILURE_TTL_MS;
      }
      return {
        token: null,
        warning: `Creators API: OAuth2 token exchange failed (${resp.status} ${resp.statusText})${body ? ` — ${body}` : ""}${bodyReadFailure}${
          isAuthFailure
            ? ` — credential disabled for ${Math.round(CREATORS_API_FAILURE_TTL_MS / 60000)} min; PA-API fallback takes over`
            : ""
        }`
      };
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const accessToken =
      typeof data.access_token === "string" ? data.access_token.trim() : "";
    if (!accessToken) {
      return {
        token: null,
        warning: "Creators API: OAuth2 token exchange returned no access_token"
      };
    }
    state.token = accessToken;
    state.tokenExpiry =
      Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60000;
    return { token: state.token };
  } catch (err: unknown) {
    return {
      token: null,
      warning: `Creators API: OAuth2 token exchange failed — ${errMsg(err)}`
    };
  }
}

/**
 * Tier 1 — Amazon Creators API product search.
 *
 * Uses OAuth2 (Cognito LWA) to obtain a bearer token for the Creators API,
 * then calls `POST /catalog/v1/searchItems` with the keyword.
 * Returns up to 5 products with title, ASIN, image, and price (when available).
 * Ratings and review counts are NOT available from this endpoint — those fields
 * are returned empty/zero so callers fall back to PA API v5 (Tier 2) when
 * review data is required.
 *
 * Circuit-breaker: a 401 InvalidToken response disables the credential for 1 h
 * via `creatorsCredentialState` so the same broken credential does not spam
 * warnings on every article. Tier 2 takes over automatically.
 *
 * @param credentialId   Cognito client_id (AMAZON_APP_ID env secret).
 * @param credentialSecret Cognito client_secret (AMAZON_API_SECRET env secret).
 * @param tag            Amazon Associates tracking tag appended to all product URLs.
 * @param onWarn         Optional callback for non-fatal warnings surfaced in the
 *                       activity feed; defaults to a no-op when omitted.
 */
export async function fetchViaCreatorsApi(
  keyword: string,
  credentialId: string,
  credentialSecret: string,
  tag: string,
  onWarn?: (msg: string) => void
): Promise<AmazonProduct[]> {
  const state = getCreatorsState(credentialId);
  if (Date.now() < state.disabledUntil) return [];
  const { token, warning } = await getCreatorsToken(
    credentialId,
    credentialSecret
  );
  if (!token) {
    onWarn?.(
      warning ??
        "Creators API: OAuth2 token exchange failed (check AMAZON_APP_ID/AMAZON_API_SECRET — AMAZON_APP_ID is the Creators API Application ID, NOT the legacy AMAZON_CREDENTIAL_ID)"
    );
    return [];
  }

  try {
    const resp = await fetch(
      "https://creatorsapi.amazon/catalog/v1/searchItems",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-marketplace": "www.amazon.com"
        },
        body: JSON.stringify({
          partnerTag: tag,
          keywords: keyword,
          searchIndex: "All",
          itemCount: 5,
          resources: [
            "images.primary.large",
            "images.primary.medium",
            "itemInfo.title",
            "itemInfo.features",
            "offersV2.listings.price",
            "offersV2.listings.availability",
            "offersV2.listings.condition"
          ]
        }),
        signal: AbortSignal.timeout(CREATORS_SEARCH_TIMEOUT_MS)
      }
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      // 401 InvalidToken means the bearer token Cognito minted isn't bound
      // to a Creators-API-provisioned app. Retrying with the same client_id
      // produces the same outcome until either AMAZON_APP_ID is rotated to
      // a provisioned app or Amazon authorizes the existing app. Trip the
      // circuit breaker so we fire ONE remediation warning and skip Tier 1
      // for the next hour — Tier 2 (PA API v5) takes over.
      if (resp.status === 401) {
        state.disabledUntil = Date.now() + CREATORS_API_FAILURE_TTL_MS;
        state.token = null;
        state.tokenExpiry = 0;
        const idHint = credentialId.slice(0, 8);
        onWarn?.(
          `Creators API 401 InvalidToken for client_id ${idHint}... — disabling this credential for 1h. ${body.slice(0, 160).replace(/\s+/g, " ")}. Remediation: confirm the secret matches a Creators-API-provisioned Cognito app, or set AMAZON_APP_ID_FALLBACK to a known-good pair. Tier 2 (PA API v5) handles product lookup in the meantime.`
        );
        return [];
      }
      onWarn?.(
        `Creators API ${resp.status} ${resp.statusText}: ${body.slice(0, MAX_ERROR_BODY_LENGTH).replace(/\s+/g, " ")}`
      );
      return [];
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const searchResult = data?.searchResult as
      | Record<string, unknown>
      | undefined;
    const items = (searchResult?.items || []) as Record<string, unknown>[];

    return items
      .slice(0, 5)
      .map((item: Record<string, unknown>) => {
        const asin = String(item.asin || "").toUpperCase();
        // Drop products whose API response lacks a real 10-char ASIN.
        // Without this filter the URL builder below produces
        // `https://www.amazon.com/dp/undefined?tag=…` — broken link →
        // lost commission for any click.
        if (!isValidAsin(asin)) return null;
        const offersV2 = item.offersV2 as Record<string, unknown> | undefined;
        const listings = offersV2?.listings as
          | Record<string, unknown>[]
          | undefined;
        const listing = listings?.[0] as Record<string, unknown> | undefined;
        const price = listing?.price as Record<string, unknown> | undefined;
        const money = price?.money as Record<string, unknown> | undefined;
        // See note above: suppress if PA/Creators didn't return a real
        // dollar amount (starts with "$"). Empty string → html-builder
        // omits the price line entirely.
        const raw = String(money?.displayAmount || price?.displayAmount || "");
        const priceDisplay = raw.match(/\$\d/) ? raw : "";
        const priceValue =
          parseFloat(String(money?.amount || price?.amount || "0")) || 0;
        const itemInfo = item.itemInfo as Record<string, unknown> | undefined;
        const titleObj = itemInfo?.title as Record<string, unknown> | undefined;
        const name = String(titleObj?.displayValue || keyword);
        const displayName =
          name.length > MAX_DISPLAY_NAME_LENGTH
            ? name.slice(0, TRUNCATED_DISPLAY_NAME_PREFIX_LENGTH) + "..."
            : name;
        const images = item.images as Record<string, unknown> | undefined;
        const primary = images?.primary as Record<string, unknown> | undefined;
        const large = primary?.large as Record<string, unknown> | undefined;
        const medium = primary?.medium as Record<string, unknown> | undefined;
        const featuresObj = itemInfo?.features as
          | Record<string, unknown>
          | undefined;
        const featureValues = (featuresObj?.displayValues || []) as string[];

        return {
          name,
          displayName,
          asin,
          price: priceDisplay,
          priceValue,
          rating: "",
          ratingValue: 0,
          reviewCount: 0,
          imageUrl: String(large?.url || medium?.url || ""),
          // Use the validated `asin` local rather than re-stringifying
          // `item.asin` — that path produced `"undefined"` literally
          // when the API returned no ASIN.
          url: `https://www.amazon.com/dp/${asin}?tag=${tag}`,
          features: featureValues.slice(0, MAX_FEATURE_COUNT).join("; "),
          brand: "",
          source: "creators-api" as const
        };
      })
      .filter((p) => p !== null) as AmazonProduct[];
  } catch (err: unknown) {
    onWarn?.(`Creators API: unexpected error — ${errMsg(err)}`);
    return [];
  }
}

// ── Tier 2: Amazon Product Advertising API v5 (SigV4) ──────────────────────
// Reaches the real catalog. Works when AMAZON_ACCESS_KEY + AMAZON_SECRET_KEY
// + AMAZON_PARTNER_TAG are set as Worker secrets. Independent of the
// Creators API — uses classic AWS SigV4 auth and the long-standing PA API.

const PA_API_HOST = "webservices.amazon.com";
const PA_API_REGION = "us-east-1";
const PA_API_SERVICE = "ProductAdvertisingAPI";
const PA_API_SEARCH_TARGET =
  "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems";
/**
 * Items requested per browse-node bestseller lookup. 10 is PA API 5.0's
 * per-request max for `SearchItems`; a browse-node sweep wants breadth
 * (compare several current bestsellers), unlike `fetchViaPaApi`'s
 * keyword search which only needs enough candidates for one product pick.
 */
const PA_API_BROWSE_NODE_ITEM_COUNT = 10;

function bytesToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return bytesToHex(buf);
}

async function hmacSha256(key: ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
}

function utf8Buf(s: string): ArrayBuffer {
  // Explicitly produce an ArrayBuffer (not SharedArrayBuffer) for
  // crypto.subtle.importKey typing.
  const src = new TextEncoder().encode(s);
  const out = new ArrayBuffer(src.byteLength);
  new Uint8Array(out).set(src);
  return out;
}

async function deriveSigningKey(
  secretKey: string,
  datestamp: string
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(utf8Buf(`AWS4${secretKey}`), datestamp);
  const kRegion = await hmacSha256(kDate, PA_API_REGION);
  const kService = await hmacSha256(kRegion, PA_API_SERVICE);
  return hmacSha256(kService, "aws4_request");
}

/**
 * Tier 2 — Amazon Product Advertising API v5 (PA API) product search.
 *
 * Signs the request with AWS Signature Version 4 (HMAC-SHA256) and calls
 * `POST /paapi5/searchitems` on the us-east-1 endpoint. Returns up to 5
 * products including title, ASIN, image, price, star rating, and review count.
 *
 * Unlike Tier 1 (Creators API), this endpoint returns `CustomerReviews`
 * (star rating + count), making it the preferred source when real review
 * data is needed for article grounding.
 *
 * Note: new Associates accounts may not receive `Offers.Listings.Price` data
 * until they generate sales. The price field is intentionally omitted from the
 * returned product when the API response does not include a dollar-prefixed
 * amount — see the inline comment near `priceDisplay` for details.
 *
 * @param accessKey  AWS Access Key ID (AMAZON_CREDENTIAL_ID env secret).
 * @param secretKey  AWS Secret Access Key (AMAZON_CREDENTIAL_SECRET env secret).
 * @param tag        Amazon Associates tracking tag appended to all product URLs.
 * @param onWarn     Optional callback for non-fatal warnings surfaced in the
 *                   activity feed; defaults to a no-op when omitted.
 */
export async function fetchViaPaApi(
  keyword: string,
  accessKey: string,
  secretKey: string,
  tag: string,
  onWarn?: (msg: string) => void
): Promise<AmazonProduct[]> {
  const payload = JSON.stringify({
    Keywords: keyword,
    Resources: [
      "Images.Primary.Large",
      "Images.Primary.Medium",
      "ItemInfo.Title",
      "ItemInfo.Features",
      "ItemInfo.ByLineInfo",
      "Offers.Listings.Price",
      "CustomerReviews.StarRating",
      "CustomerReviews.Count"
    ],
    PartnerTag: tag,
    PartnerType: "Associates",
    Marketplace: "www.amazon.com"
  });
  const now = new Date();
  const amzdate = now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace(/Z$/, "Z");
  const datestamp = amzdate.slice(0, 8);
  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `host:${PA_API_HOST}\n` +
    `x-amz-date:${amzdate}\n` +
    `x-amz-target:${PA_API_SEARCH_TARGET}\n`;
  const signedHeaders = "content-encoding;host;x-amz-date;x-amz-target";
  const payloadHash = await sha256Hex(payload);
  const canonicalRequest = `POST\n/paapi5/searchitems\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${datestamp}/${PA_API_REGION}/${PA_API_SERVICE}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzdate}\n${credentialScope}\n` +
    (await sha256Hex(canonicalRequest));
  const signingKey = await deriveSigningKey(secretKey, datestamp);
  const signatureBuf = await hmacSha256(signingKey, stringToSign);
  const signature = bytesToHex(signatureBuf);
  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  let resp: Response;
  try {
    resp = await fetch(`https://${PA_API_HOST}/paapi5/searchitems`, {
      method: "POST",
      headers: {
        "content-encoding": "amz-1.0",
        host: PA_API_HOST,
        "x-amz-date": amzdate,
        "x-amz-target": PA_API_SEARCH_TARGET,
        "content-type": "application/json; charset=utf-8",
        authorization: authHeader
      },
      body: payload,
      signal: AbortSignal.timeout(PA_API_TIMEOUT_MS)
    });
  } catch (err: unknown) {
    onWarn?.(`PA API v5 fetch threw: ${errMsg(err)}`);
    return [];
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    onWarn?.(
      `PA API v5 ${resp.status} ${resp.statusText}: ${body.slice(0, MAX_ERROR_BODY_LENGTH).replace(/\s+/g, " ")}`
    );
    return [];
  }
  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch (err: unknown) {
    onWarn?.(`PA API v5 JSON parse failed: ${errMsg(err)}`);
    return [];
  }
  const searchResult = data?.SearchResult as
    | Record<string, unknown>
    | undefined;
  const items =
    (searchResult?.Items as Record<string, unknown>[] | undefined) || [];
  return items
    .slice(0, 5)
    .map((item) => {
      const asin = String(item.ASIN || "").toUpperCase();
      // Drop products whose API response lacks a real 10-char ASIN.
      // Without this filter the affiliate URL ends as
      // `https://www.amazon.com/dp/?tag=…` — broken link → lost
      // commission for any click on the pick.
      if (!isValidAsin(asin)) return null;
      const itemInfo = item.ItemInfo as Record<string, unknown> | undefined;
      const titleObj = itemInfo?.Title as Record<string, unknown> | undefined;
      const title = String(titleObj?.DisplayValue || keyword);
      const featuresObj = itemInfo?.Features as
        | Record<string, unknown>
        | undefined;
      const featureValues =
        (featuresObj?.DisplayValues as string[] | undefined) || [];
      const byLineInfo = itemInfo?.ByLineInfo as
        | Record<string, unknown>
        | undefined;
      const brandObj = byLineInfo?.Brand as Record<string, unknown> | undefined;
      const brand = String(brandObj?.DisplayValue || "");
      const offers = item.Offers as Record<string, unknown> | undefined;
      const listings = offers?.Listings as
        | Record<string, unknown>[]
        | undefined;
      const price = listings?.[0]?.Price as Record<string, unknown> | undefined;
      // Suppress the price slot entirely when PA API v5 didn't return a
      // real amount. New partner-tag accounts don't get price data until
      // they show sales; rendering "Check Price" as a fake price line is
      // worse than hiding it and letting the "View on Amazon" button be
      // the sole CTA.
      const priceDisplay =
        price?.DisplayAmount &&
        typeof price.DisplayAmount === "string" &&
        price.DisplayAmount.match(/\$\d/)
          ? String(price.DisplayAmount)
          : "";
      const priceValue = parseFloat(String(price?.Amount || "0")) || 0;
      const imagesObj = item.Images as Record<string, unknown> | undefined;
      const primary = imagesObj?.Primary as Record<string, unknown> | undefined;
      const large = primary?.Large as Record<string, unknown> | undefined;
      const medium = primary?.Medium as Record<string, unknown> | undefined;
      const reviews = item.CustomerReviews as
        | Record<string, unknown>
        | undefined;
      const starRating = reviews?.StarRating as
        | Record<string, unknown>
        | undefined;
      const ratingValue = Number(starRating?.Value) || 0;
      const reviewCount = Number(reviews?.Count) || 0;
      return {
        name: title,
        displayName:
          title.length > MAX_DISPLAY_NAME_LENGTH
            ? title.slice(0, TRUNCATED_DISPLAY_NAME_PREFIX_LENGTH) + "..."
            : title,
        asin,
        price: priceDisplay,
        priceValue,
        rating: ratingValue > 0 ? String(ratingValue) : "",
        ratingValue,
        reviewCount,
        imageUrl: String(large?.URL || medium?.URL || ""),
        url: `https://www.amazon.com/dp/${asin}?tag=${tag}`,
        features: featureValues.slice(0, MAX_FEATURE_COUNT).join("; "),
        brand,
        source: "pa-api-v5" as const
      };
    })
    .filter((p) => p !== null) as AmazonProduct[];
}

/**
 * Top Seller Scout — real bestseller lookup by Amazon browse node.
 *
 * Same AWS SigV4-signed `POST /paapi5/searchitems` endpoint as
 * `fetchViaPaApi()` above and reuses its signing helpers
 * (`deriveSigningKey`/`hmacSha256`/`sha256Hex`) — the only difference is
 * the request payload: `BrowseNodeId` instead of `Keywords`, so results
 * come from a specific Amazon category (e.g. Pet Supplies > Cats > Toys)
 * rather than a text search.
 *
 * IMPORTANT CAVEAT, not resolvable in code: PA API 5.0's `SearchItems`
 * has no `SortBy` value that reproduces Amazon's public sales-rank-based
 * "Best Sellers" (zgbs) page ordering — the closest documented option is
 * `SortBy: "Featured"` (used here), which approximates but is not
 * guaranteed identical to the public bestseller ranking for the same
 * node. This has not been verified against a live browse node — no
 * Amazon PA API credentials are available in this environment. The first
 * real integration step is a live call against one of the 18 target node
 * IDs to confirm the response actually contains bestseller-shaped
 * results before this is wired into the daily sweep tick.
 *
 * @param browseNodeId  Amazon browse node ID, e.g. "2975241011" (Cats).
 * @param accessKey     AWS Access Key ID (same credential as `fetchViaPaApi`).
 * @param secretKey     AWS Secret Access Key (same credential as `fetchViaPaApi`).
 * @param tag           Amazon Associates tracking tag appended to product URLs.
 * @param onWarn        Optional callback for non-fatal warnings; defaults to no-op.
 */
export async function fetchBestsellersByBrowseNode(
  browseNodeId: string,
  accessKey: string,
  secretKey: string,
  tag: string,
  onWarn?: (msg: string) => void
): Promise<AmazonProduct[]> {
  const payload = JSON.stringify({
    BrowseNodeId: browseNodeId,
    SortBy: "Featured",
    ItemCount: PA_API_BROWSE_NODE_ITEM_COUNT,
    Resources: [
      "Images.Primary.Large",
      "Images.Primary.Medium",
      "ItemInfo.Title",
      "ItemInfo.Features",
      "ItemInfo.ByLineInfo",
      "Offers.Listings.Price",
      "CustomerReviews.StarRating",
      "CustomerReviews.Count"
    ],
    PartnerTag: tag,
    PartnerType: "Associates",
    Marketplace: "www.amazon.com"
  });
  const now = new Date();
  const amzdate = now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace(/Z$/, "Z");
  const datestamp = amzdate.slice(0, 8);
  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `host:${PA_API_HOST}\n` +
    `x-amz-date:${amzdate}\n` +
    `x-amz-target:${PA_API_SEARCH_TARGET}\n`;
  const signedHeaders = "content-encoding;host;x-amz-date;x-amz-target";
  const payloadHash = await sha256Hex(payload);
  const canonicalRequest = `POST\n/paapi5/searchitems\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${datestamp}/${PA_API_REGION}/${PA_API_SERVICE}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzdate}\n${credentialScope}\n` +
    (await sha256Hex(canonicalRequest));
  const signingKey = await deriveSigningKey(secretKey, datestamp);
  const signatureBuf = await hmacSha256(signingKey, stringToSign);
  const signature = bytesToHex(signatureBuf);
  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  let resp: Response;
  try {
    resp = await fetch(`https://${PA_API_HOST}/paapi5/searchitems`, {
      method: "POST",
      headers: {
        "content-encoding": "amz-1.0",
        host: PA_API_HOST,
        "x-amz-date": amzdate,
        "x-amz-target": PA_API_SEARCH_TARGET,
        "content-type": "application/json; charset=utf-8",
        authorization: authHeader
      },
      body: payload,
      signal: AbortSignal.timeout(PA_API_TIMEOUT_MS)
    });
  } catch (err: unknown) {
    onWarn?.(
      `PA API v5 (browse node ${browseNodeId}) fetch threw: ${errMsg(err)}`
    );
    return [];
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    onWarn?.(
      `PA API v5 (browse node ${browseNodeId}) ${resp.status} ${resp.statusText}: ${body.slice(0, MAX_ERROR_BODY_LENGTH).replace(/\s+/g, " ")}`
    );
    return [];
  }
  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch (err: unknown) {
    onWarn?.(
      `PA API v5 (browse node ${browseNodeId}) JSON parse failed: ${errMsg(err)}`
    );
    return [];
  }
  const searchResult = data?.SearchResult as
    | Record<string, unknown>
    | undefined;
  const items =
    (searchResult?.Items as Record<string, unknown>[] | undefined) || [];
  return items
    .slice(0, PA_API_BROWSE_NODE_ITEM_COUNT)
    .map((item) => {
      const asin = String(item.ASIN || "").toUpperCase();
      // Same anti-broken-link filter as fetchViaPaApi — see that function's
      // comment for why a missing/malformed ASIN must drop the item.
      if (!isValidAsin(asin)) return null;
      const itemInfo = item.ItemInfo as Record<string, unknown> | undefined;
      const titleObj = itemInfo?.Title as Record<string, unknown> | undefined;
      const title = String(titleObj?.DisplayValue || "");
      if (!title) return null;
      const featuresObj = itemInfo?.Features as
        | Record<string, unknown>
        | undefined;
      const featureValues =
        (featuresObj?.DisplayValues as string[] | undefined) || [];
      const byLineInfo = itemInfo?.ByLineInfo as
        | Record<string, unknown>
        | undefined;
      const brandObj = byLineInfo?.Brand as Record<string, unknown> | undefined;
      const brand = String(brandObj?.DisplayValue || "");
      const offers = item.Offers as Record<string, unknown> | undefined;
      const listings = offers?.Listings as
        | Record<string, unknown>[]
        | undefined;
      const price = listings?.[0]?.Price as Record<string, unknown> | undefined;
      // Same price-suppression rule as fetchViaPaApi — see that function's
      // comment. New partner-tag accounts don't get price data until they
      // show sales.
      const priceDisplay =
        price?.DisplayAmount &&
        typeof price.DisplayAmount === "string" &&
        price.DisplayAmount.match(/\$\d/)
          ? String(price.DisplayAmount)
          : "";
      const priceValue = parseFloat(String(price?.Amount || "0")) || 0;
      const imagesObj = item.Images as Record<string, unknown> | undefined;
      const primary = imagesObj?.Primary as Record<string, unknown> | undefined;
      const large = primary?.Large as Record<string, unknown> | undefined;
      const medium = primary?.Medium as Record<string, unknown> | undefined;
      const reviews = item.CustomerReviews as
        | Record<string, unknown>
        | undefined;
      const starRating = reviews?.StarRating as
        | Record<string, unknown>
        | undefined;
      const ratingValue = Number(starRating?.Value) || 0;
      const reviewCount = Number(reviews?.Count) || 0;
      return {
        name: title,
        displayName:
          title.length > MAX_DISPLAY_NAME_LENGTH
            ? title.slice(0, TRUNCATED_DISPLAY_NAME_PREFIX_LENGTH) + "..."
            : title,
        asin,
        price: priceDisplay,
        priceValue,
        rating: ratingValue > 0 ? String(ratingValue) : "",
        ratingValue,
        reviewCount,
        imageUrl: String(large?.URL || medium?.URL || ""),
        url: `https://www.amazon.com/dp/${asin}?tag=${tag}`,
        features: featureValues.slice(0, MAX_FEATURE_COUNT).join("; "),
        brand,
        source: "pa-api-v5" as const
      };
    })
    .filter((p) => p !== null) as AmazonProduct[];
}

// ── Tier 3: Apify Amazon Scraper ────────────────────────────────────────────

/**
 * Apify actor used for Tier 3 product search. The previous
 * `gajo-cz~amazon-product-scraper` was removed from the Apify store
 * (HTTP 404 record-not-found), which silently zeroed Top Picks for every
 * article once Creators + PA API failed. `junglee~amazon-crawler` is the
 * maintained public Amazon Product Scraper and accepts search-result URLs.
 */
const APIFY_AMAZON_ACTOR = "junglee~amazon-crawler";

/** How long to block on the Apify run start endpoint with waitForFinish (s). */
const APIFY_WAIT_FOR_FINISH_SECS = 90;

/**
 * Tier 3 — Apify `junglee/Amazon-crawler` actor fallback.
 *
 * Starts an Apify actor run with `waitForFinish` (up to 90 s), then falls
 * back to short status polling if the run is still in progress. Returns up
 * to 5 products with title, ASIN, image, price, rating, and review count.
 *
 * Used when both Tier 1 (Creators API) and Tier 2 (PA API v5) are unavailable
 * or return no results. Requires the `APIFY_TOKEN` Worker secret.
 *
 * Dog-only listings are filtered from results to avoid cross-species pollution.
 * Products without a valid 10-char ASIN are dropped so affiliate links never
 * point at `/dp/undefined`.
 *
 * @param apifyToken  Apify API token (APIFY_TOKEN env secret).
 * @param tag         Amazon Associates tracking tag appended to all product URLs.
 * @param onWarn      Optional callback for non-fatal warnings surfaced in the
 *                    activity feed; defaults to a no-op when omitted.
 */
export async function fetchViaApify(
  keyword: string,
  apifyToken: string,
  tag: string,
  onWarn?: (msg: string) => void
): Promise<AmazonProduct[]> {
  try {
    const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`;
    // Prefer waitForFinish so one HTTP call covers most successful runs.
    // If the run is still RUNNING after 90s, poll below with the returned run id.
    const runResp = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_AMAZON_ACTOR}/runs?token=${apifyToken}&waitForFinish=${APIFY_WAIT_FOR_FINISH_SECS}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryOrProductUrls: [{ url: searchUrl }],
          maxItemsPerStartUrl: 10,
          maxSearchPagesPerStartUrl: 1,
          scrapeProductDetails: false,
          proxyCountry: "US"
        }),
        // waitForFinish can hold the socket open for ~90s
        signal: AbortSignal.timeout((APIFY_WAIT_FOR_FINISH_SECS + 15) * 1000)
      }
    );

    if (!runResp.ok) {
      const body = await runResp.text().catch(() => "");
      onWarn?.(
        `Apify ${runResp.status} ${runResp.statusText}: ${body.slice(0, MAX_ERROR_BODY_LENGTH).replace(/\s+/g, " ")}`
      );
      return [];
    }
    const runData = (await runResp.json()) as Record<string, unknown>;
    const runDataInner = runData?.data as Record<string, unknown> | undefined;
    const runId = runDataInner?.id as string | undefined;
    if (!runId) {
      onWarn?.("Apify: run started but response lacked run id");
      return [];
    }

    let datasetId = runDataInner?.defaultDatasetId as string | undefined;
    let status = String(runDataInner?.status || "");

    // Poll only when waitForFinish returned before SUCCEEDED/FAILED.
    if (status !== "SUCCEEDED" && status !== "FAILED" && status !== "ABORTED") {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const statusResp = await fetch(
          `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`,
          { signal: AbortSignal.timeout(APIFY_CALL_TIMEOUT_MS) }
        );
        const statusData = (await statusResp.json()) as Record<string, unknown>;
        const statusDataInner = statusData?.data as
          | Record<string, unknown>
          | undefined;
        status = String(statusDataInner?.status || "");
        if (status === "SUCCEEDED") {
          datasetId = statusDataInner?.defaultDatasetId as string | undefined;
          break;
        }
        if (status === "FAILED" || status === "ABORTED") {
          onWarn?.(`Apify actor ${runId} ${status} — no products`);
          return [];
        }
      }
    }

    if (status === "FAILED" || status === "ABORTED") {
      onWarn?.(`Apify actor ${runId} ${status} — no products`);
      return [];
    }
    if (status !== "SUCCEEDED" || !datasetId) {
      onWarn?.(
        `Apify actor ${runId} still ${status || "unknown"} after wait — no products`
      );
      return [];
    }

    const dataResp = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&limit=10`,
      { signal: AbortSignal.timeout(APIFY_CALL_TIMEOUT_MS) }
    );
    if (!dataResp.ok) {
      onWarn?.(`Apify dataset fetch ${dataResp.status} ${dataResp.statusText}`);
      return [];
    }
    const dataset = (await dataResp.json()) as Record<string, unknown>[];
    if (!Array.isArray(dataset) || dataset.length === 0) return [];

    // Filter out dog products and rows without a real ASIN.
    const filtered = dataset.filter((p: Record<string, unknown>) => {
      const asin = String(p.asin || "").toUpperCase();
      if (!isValidAsin(asin)) return false;
      const title = String(p.title || p.name || "").toLowerCase();
      if (
        /\bdog\b|\bpuppy\b|\bcanine\b/.test(title) &&
        !/\bcat\b|\bkitten\b|\bfeline\b/.test(title)
      )
        return false;
      return true;
    });

    return filtered.slice(0, 5).map((p: Record<string, unknown>) => {
      const name = String(p.title || p.name || keyword);
      const displayName =
        name.length > MAX_DISPLAY_NAME_LENGTH
          ? name.slice(0, TRUNCATED_DISPLAY_NAME_PREFIX_LENGTH) + "..."
          : name;
      // junglee returns price as { value, currency }; older actors used a string.
      const priceObj = p.price as
        | { value?: number | string; currency?: string }
        | string
        | undefined;
      let priceValue = 0;
      let priceStr = "";
      if (priceObj && typeof priceObj === "object") {
        priceValue = parseFloat(String(priceObj.value ?? "0")) || 0;
        const currency = String(priceObj.currency || "$");
        if (priceValue > 0) {
          priceStr = currency.includes("$")
            ? `$${priceValue.toFixed(2)}`
            : `${currency}${priceValue.toFixed(2)}`;
        }
      } else {
        priceStr = String(priceObj || p.price || "");
        priceValue = parseFloat(priceStr.replace(/[^0-9.]/g, "")) || 0;
        if (!priceStr.match(/\$\d/) && priceValue > 0) {
          priceStr = `$${priceValue.toFixed(2)}`;
        }
        if (!priceStr.match(/\$\d/)) priceStr = "";
      }
      const ratingNum = parseFloat(String(p.stars ?? p.rating ?? "0")) || 0;
      const rawReviewCount = String(
        p.reviewsCount ?? p.reviewCount ?? p.reviews ?? "0"
      );
      const reviewCountMatch = rawReviewCount.match(
        /\d{1,3}(?:[,\s]\d{3})+|\d+/
      );
      const reviewCount = reviewCountMatch
        ? Number.parseInt(reviewCountMatch[0].replace(/[,\s]/g, ""), 10)
        : 0;
      const asin = String(p.asin || "").toUpperCase();

      return {
        name,
        displayName,
        asin,
        price: priceStr,
        priceValue,
        rating: ratingNum > 0 ? `${ratingNum}/5` : "",
        ratingValue: ratingNum,
        reviewCount,
        imageUrl: String(p.imageUrl || p.image || p.thumbnailImage || ""),
        url: `https://www.amazon.com/dp/${asin}?tag=${tag}`,
        features: Array.isArray(p.features)
          ? p.features
              .filter(
                (feature): feature is string => typeof feature === "string"
              )
              .slice(0, 3)
              .join("; ")
          : "",
        brand: String(p.brand || ""),
        source: "apify" as const
      };
    });
  } catch (err: unknown) {
    onWarn?.(`Apify threw: ${errMsg(err)}`);
    return [];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * ASIN format check — Amazon Standard Identification Numbers are 10
 * uppercase-alphanumeric characters (`B` prefix is common but not
 * universal; older books may begin with a digit). Used to filter out
 * products whose API response is missing or malformed at the ASIN
 * field, so the affiliate URL builders in each tier don't produce
 * `https://www.amazon.com/dp/undefined?tag=…` (revenue loss — clicks
 * go to an invalid Amazon page).
 */
function isValidAsin(asin: string): boolean {
  return /^[A-Z0-9]{10}$/.test(asin);
}

/**
 * Drop near-duplicate product listings. PA API v5 routinely returns the
 * same physical product (or near-identical variants) from multiple
 * sellers with different ASINs and near-identical titles, e.g.
 *   - "XXXXL Jumbo Stainless Steel Litter Box with Lid for Maine Coon, 28" L x 20" W..."
 *   - "XXXXL Jumbo Stainless Steel Litter Box with Lid for Maine Coon, 28" L x 20" W..."
 * Dedup on the first 8 normalized tokens of the name — strict enough to
 * collapse re-listings, loose enough to keep genuinely different picks.
 */
export function dedupeProducts(products: AmazonProduct[]): AmazonProduct[] {
  const seen = new Set<string>();
  const out: AmazonProduct[] = [];
  for (const p of products) {
    const fingerprint = (p.name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 8)
      .join(" ");
    if (!fingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(p);
  }
  return out;
}

// ── Price hydration removed ─────────────────────────────────────────────────
// We do NOT fetch prices anywhere in the pipeline. Amazon Associates
// compliance forbids displayed prices, and even handing prices to the
// writer prompt encourages Kimi to hallucinate dollar amounts in prose.
// Live prices live on the affiliate link only. Any `price` / `priceValue`
// fields populated upstream by PA API or Creators API are zeroed in
// `writer.ts` before the product list reaches the prompt builder.

/**
 * Build the product-grounding block injected into the Kimi writer prompt.
 *
 * Products are listed with numbered `[PRODUCT_N]` slot tokens that the
 * model uses to reference each item. After generation, `hydrateProductSlots`
 * replaces those tokens with real display names. Prices are intentionally
 * excluded: Amazon Associates compliance forbids displaying scraped prices,
 * and passing price values encourages the model to hallucinate dollar amounts
 * in prose. Live prices live on the affiliate link only.
 *
 * Returns an empty string when `products` is empty so callers can safely
 * include the result in a larger prompt without extra guard checks.
 */
export function buildProductPromptText(products: AmazonProduct[]): string {
  if (products.length === 0) return "";
  return `REAL PRODUCT DATA — USE SLOT TOKENS TO REFERENCE THESE:
${products
  .map((p, i) => {
    const lines = [
      // No prices — Amazon Associates compliance forbids displayed prices,
      // and even mentioning them upstream encourages Kimi to hallucinate
      // dollar amounts in prose. Live prices are only on the affiliate
      // link itself.
      `${i + 1}. [PRODUCT_${i + 1}] = "${p.displayName}"${p.asin ? ` (ASIN: ${p.asin})` : ""}`
    ];
    if (p.brand) lines.push(`   Brand: ${p.brand}`);
    if (p.rating)
      lines.push(
        `   Rating: ${p.rating}${p.reviewCount ? ` (${p.reviewCount.toLocaleString()} reviews)` : ""}`
      );
    if (p.features) lines.push(`   Features: ${p.features.slice(0, 200)}`);
    if (p.imageUrl) lines.push(`   Image: ${p.imageUrl}`);
    return lines.join("\n");
  })
  .join("\n\n")}

IMPORTANT: Use [PRODUCT_1], [PRODUCT_2], etc. in your article. They will be replaced with real product names.`;
}

/**
 * Replace `[PRODUCT_N]` slot tokens in `text` with the corresponding
 * product display names from `products`.
 *
 * Tokens beyond the end of the `products` array (e.g. `[PRODUCT_9]` when
 * only 5 products exist) are silently removed so they never reach
 * published HTML. Returns the patched text and the count of slot-token
 * occurrences replaced for logging.
 */
export function hydrateProductSlots(
  text: string,
  products: AmazonProduct[]
): { text: string; slotsReplaced: number } {
  let result = text;
  let replaced = 0;
  for (let i = 0; i < products.length; i++) {
    const token = `[PRODUCT_${i + 1}]`;
    const parts = result.split(token);
    const occurrences = parts.length - 1;
    if (occurrences > 0) {
      result = parts.join(products[i].displayName);
      replaced += occurrences;
    }
  }
  result = result.replace(/\[PRODUCT_\d+\]/g, "");
  return { text: result, slotsReplaced: replaced };
}
