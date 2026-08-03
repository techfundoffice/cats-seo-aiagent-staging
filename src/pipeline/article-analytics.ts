/**
 * Browser analytics for published SEO articles.
 *
 * Injects the same GTM + GA4 IDs used on the live catsluvus.com chrome
 * (petinsurance worker) plus outbound Amazon click tracking.
 *
 * Click events:
 *   1. dataLayer push (`amazon_click`) — GTM can forward to GA4/ads
 *   2. gtag event when present
 *   3. sendBeacon to first-party `/api/affiliate-click` on the SEO worker
 *      so we have ASIN-level click counts independent of Amazon reports lag
 *
 * `ensureArticleAnalytics` is idempotent and safe on already-published KV
 * HTML at serve time.
 */

/** Matches production Universal Chrome / petinsurance worker. */
export const GA4_MEASUREMENT_ID = "G-QBGF94YE7C";
export const GTM_CONTAINER_ID = "GTM-KPSXGQWC";

/**
 * First-party click collector. Staging and production article hosts may
 * differ; beacon always hits the production SEO worker so one ledger
 * aggregates everything. CORS is open on that route.
 */
export const AFFILIATE_CLICK_BEACON_URL =
  "https://cats-seo-aiagent.webmaster-bc8.workers.dev/api/affiliate-click";

export const ANALYTICS_MARKER = "clu-article-analytics";

/**
 * <head> snippet: GTM bootstrap + gtag config.
 * Escaped for embedding inside a JS/TS template string.
 */
export function buildAnalyticsHeadHtml(
  opts: {
    ga4Id?: string;
    gtmId?: string;
  } = {}
): string {
  const ga4 = opts.ga4Id ?? GA4_MEASUREMENT_ID;
  const gtm = opts.gtmId ?? GTM_CONTAINER_ID;
  return (
    `<!-- ${ANALYTICS_MARKER} -->` +
    `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':` +
    `new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],` +
    `j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=` +
    `'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);` +
    `})(window,document,'script','dataLayer','${gtm}');</script>` +
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${ga4}"></script>` +
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
    `gtag('js',new Date());gtag('config','${ga4}',{anonymize_ip:true});` +
    `gtag('event','page_view',{page_path:location.pathname,content_group:'seo_article'});</script>`
  );
}

/**
 * End-of-<body> click tracker. Marker attribute prevents double-binding
 * if ensure runs twice.
 */
export function buildAnalyticsBodyHtml(
  opts: { beaconUrl?: string } = {}
): string {
  const beacon = JSON.stringify(opts.beaconUrl ?? AFFILIATE_CLICK_BEACON_URL);
  // Keep this script dependency-free and small. No template literals inside
  // the emitted browser JS (we build with string concat only).
  return (
    `<script id="${ANALYTICS_MARKER}" data-clu-analytics="1">` +
    `(function(){` +
    `if(window.__cluAmazonClickBound)return;window.__cluAmazonClickBound=1;` +
    `var BEACON=${beacon};` +
    `function asinFrom(h){` +
    `try{var m=String(h).match(/\\/(?:dp|gp\\/product|gp\\/aw\\/d)\\/([A-Z0-9]{10})/i);` +
    `return m?m[1].toUpperCase():"";}catch(e){return"";}` +
    `}` +
    `function track(a){` +
    `var href=a.href||"";` +
    `var asin=asinFrom(href);` +
    `var text=(a.getAttribute("aria-label")||a.textContent||"").replace(/\\s+/g," ").trim().slice(0,80);` +
    `var path=location.pathname||"";` +
    `window.dataLayer=window.dataLayer||[];` +
    `window.dataLayer.push({event:"amazon_click",amazon_asin:asin,amazon_href:href,link_text:text,page_path:path});` +
    `if(typeof gtag==="function"){` +
    `gtag("event","amazon_click",{event_category:"affiliate",event_label:asin||href,transport_type:"beacon",link_url:href,page_path:path});` +
    `}` +
    `try{` +
    `var body=JSON.stringify({event:"amazon_click",asin:asin,href:href,text:text,path:path,ts:Date.now(),tag:extractTag(href)});` +
    `if(navigator.sendBeacon){navigator.sendBeacon(BEACON,new Blob([body],{type:"application/json"}));}` +
    `else{fetch(BEACON,{method:"POST",headers:{"content-type":"application/json"},body:body,mode:"cors",keepalive:true});}` +
    `}catch(e){}` +
    `}` +
    `function extractTag(h){try{var u=new URL(h);return u.searchParams.get("tag")||"";}catch(e){return"";}}` +
    `document.addEventListener("click",function(e){` +
    `var t=e.target;if(!t||!t.closest)return;` +
    `var a=t.closest('a[href*="amazon."]');` +
    `if(!a)return;` +
    `track(a);` +
    `},true);` +
    `})();` +
    `</script>`
  );
}

/**
 * Idempotently inject analytics into a full HTML document.
 * Safe for serve-time upgrades of the published corpus.
 */
export function ensureArticleAnalytics(html: string): string {
  if (!html || typeof html !== "string") return html;
  if (
    html.includes(ANALYTICS_MARKER) ||
    html.includes('data-clu-analytics="1"')
  ) {
    return html;
  }

  const head = buildAnalyticsHeadHtml();
  const body = buildAnalyticsBodyHtml();
  let out = html;

  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${head}</head>`);
  } else if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*>)/i, `<head$1${head}`);
  } else {
    out = head + out;
  }

  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${body}</body>`);
  } else {
    out = out + body;
  }

  return out;
}

/** Parse path `/category/slug` → `category:slug` ledger key. */
export function pathToKvKey(path: string): string | null {
  if (!path || typeof path !== "string") return null;
  const clean = path.split("?")[0].split("#")[0].replace(/\/+$/, "");
  const m = clean.match(/^\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

export interface AffiliateClickEvent {
  event?: string;
  asin?: string;
  href?: string;
  text?: string;
  path?: string;
  ts?: number;
  tag?: string;
}

/**
 * Validate + normalize a beacon payload. Returns null if unusable.
 */
export function normalizeAffiliateClick(
  raw: unknown
): AffiliateClickEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const href = typeof o.href === "string" ? o.href.slice(0, 500) : "";
  const path = typeof o.path === "string" ? o.path.slice(0, 200) : "";
  let asin = typeof o.asin === "string" ? o.asin.toUpperCase() : "";
  if (asin && !/^[A-Z0-9]{10}$/.test(asin)) asin = "";
  if (!asin && href) {
    const m = href.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
    if (m) asin = m[1].toUpperCase();
  }
  // Require either a path or href so we don't store empty junk.
  if (!path && !href) return null;
  const text = typeof o.text === "string" ? o.text.slice(0, 80) : "";
  const tag = typeof o.tag === "string" ? o.tag.slice(0, 40) : "";
  const ts =
    typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : Date.now();
  return {
    event: "amazon_click",
    asin,
    href,
    text,
    path,
    ts,
    tag
  };
}
