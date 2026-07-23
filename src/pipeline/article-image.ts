import type { SEOArticleAgent } from "../server";
import { errMsg, getEnvBinding } from "./http-utils";

/**
 * article-image.ts — Cloudflare-native article image generation.
 *
 * Ported from the production repo's `src/pipeline/images.ts` (deleted
 * 2026-05-14 as "dead code" after its `pub.catsluvus.com` R2 custom
 * domain broke; recovered from history at commit a5b52955^). The prompt
 * system — topic detection, breed/interaction/angle/lighting
 * randomization with deterministic seeds — is production's; the serving
 * scheme is staging's working one: the IMAGES_R2 bucket's managed
 * public r2.dev domain, a host the staging → production HTML rewrite
 * never touches, so image URLs survive prod publishing unchanged.
 *
 * Slop guard: diffusion models mangle written text, so every prompt is
 * scene-based and forbids text/labels/logos. Never put packaging in
 * frame.
 *
 * Flags: ARTICLE_HERO_IMAGE="off" disables the hero;
 * ARTICLE_PRODUCT_IMAGES="on" enables per-product images (default OFF —
 * pick cards already show real Amazon product photos; AI look-alike
 * product shots next to real ones is an editorial call).
 */

// FLUX.2 Klein 4B — fast, cheap; hero/blog imagery.
const BLOG_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
// FLUX.2 Dev — premium quality; product imagery.
const PRODUCT_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-dev";
// Fallback when Klein/Dev are unavailable.
const FALLBACK_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** seo-images-staging bucket's managed public domain (enabled 2026-07-23). */
export const DEFAULT_IMAGES_PUBLIC_BASE_URL =
  "https://pub-d005467c78ef4809ab585678182662c8.r2.dev";

export interface GeneratedImage {
  r2Key: string;
  url: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
  imageType: "hero" | "section" | "product";
  prompt: string;
}

// ── Topic detection (ported verbatim from production) ───────────────────────

export function detectTopic(keyword: string): string {
  const lower = keyword.toLowerCase();
  const topics: Record<string, RegExp> = {
    medical:
      /\b(flea|tick|worm|treatment|medicine|vet|health|vaccine|supplement)\b/,
    dental: /\b(dental|teeth|tooth|mouth|breath|gum)\b/,
    grooming: /\b(groom|brush|comb|fur|bath|wash|nail|trim|shed)\b/,
    behavior: /\b(behavior|train|scratch|bite|stress|anxiety|pheromone|calm)\b/,
    feeding: /\b(food|feed|diet|nutrition|meal|feeder|bowl|fountain|water)\b/,
    litter: /\b(litter|litter box|self.clean|scoop|clump)\b/,
    furniture: /\b(tree|tower|shelf|perch|catio|enclosure|door|gate)\b/,
    toys: /\b(toy|play|wand|feather|mouse|ball|laser|puzzle|catnip)\b/,
    beds: /\b(bed|blanket|mat|cushion|cave|hammock|heated|cooling)\b/,
    carrier: /\b(carrier|travel|stroller|backpack|crate)\b/,
    tech: /\b(gps|tracker|camera|monitor|smart|wifi|app|sensor)\b/
  };
  for (const [topic, pattern] of Object.entries(topics)) {
    if (pattern.test(lower)) return topic;
  }
  return "general";
}

// ── Breed + interaction randomization (ported verbatim) ─────────────────────

const CAT_BREEDS = [
  "a beautiful orange tabby cat",
  "an elegant gray shorthair cat",
  "a sleek black cat with green eyes",
  "a fluffy white longhair cat",
  "a calico cat with distinctive markings",
  "a large brown tabby cat",
  "a cream-colored longhair cat with blue eyes",
  "a spotted golden cat"
];

const INTERACTIONS: Record<string, string[]> = {
  feeding: [
    "sitting beside a ceramic food bowl, looking up expectantly",
    "sniffing curiously at a stainless steel feeding dish",
    "sitting patiently next to a meal area with ears forward"
  ],
  medical: [
    "sitting calmly on a veterinary exam table being gently examined",
    "relaxing on a soft blanket with a caring hand nearby",
    "looking peaceful while resting on a clean surface"
  ],
  dental: [
    "sitting calmly while a gentle hand holds a small cat toothbrush near its mouth",
    "looking relaxed on a clean surface with dental care items nearby",
    "sitting attentively while being examined around the mouth area"
  ],
  grooming: [
    "being gently brushed with a grooming tool, eyes half-closed",
    "sitting contentedly while being combed along its back",
    "stretching during a grooming session on a towel"
  ],
  behavior: [
    "sitting upright with alert ears, looking calmly at a calming diffuser on a shelf",
    "stretched out peacefully on a cozy blanket, visibly relaxed",
    "exploring a puzzle toy on the floor with focused curiosity"
  ],
  litter: [
    "sitting near a clean modern litter box in a tidy laundry room",
    "stepping carefully into a covered litter box",
    "sitting beside an automatic self-cleaning litter system"
  ],
  furniture: [
    "perched on top of a cat tree looking proud",
    "climbing a wall-mounted cat shelf system",
    "peeking through a cat door in a modern home"
  ],
  toys: [
    "playfully batting at a dangling feather toy",
    "crouching playfully near an interactive puzzle toy",
    "engaged with a motorized toy on a hardwood floor"
  ],
  beds: [
    "curled up contentedly in a cozy cat bed",
    "stretching luxuriously on a heated pet mat",
    "nestled into a plush cave bed in a sunlit room"
  ],
  carrier: [
    "sitting inside a cozy carrier looking comfortable",
    "peeking out of a backpack carrier on a hiking trail",
    "relaxing in a pet stroller in a park setting"
  ],
  tech: [
    "wearing a GPS collar in a garden, looking curious",
    "sitting near a smart pet camera in a modern living room",
    "being observed by a pet monitoring device on a shelf"
  ],
  general: [
    "sitting attentively in a cozy modern home",
    "exploring curiously in a bright clean room",
    "relaxing comfortably in warm natural light"
  ]
};

const ANGLES = [
  "from a slightly elevated front-facing angle",
  "from eye level with a shallow depth of field",
  "from a three-quarter angle showing the cat's profile",
  "from slightly below looking up at the cat"
];

const LIGHTING = [
  "soft diffused natural window light streaming in",
  "warm golden hour sunlight from a nearby window",
  "bright natural daylight filling the room evenly",
  "gentle ambient light with a warm cozy feel"
];

function pick<T>(arr: readonly T[], seed: number): T {
  if (arr.length === 0) {
    throw new Error("pick() received an empty array");
  }
  return arr[Math.abs(seed) % arr.length];
}

// ── Prompt builders (ported; no-text clause retained everywhere) ────────────

export function buildHeroPrompt(keyword: string, index: number): string {
  const topic = detectTopic(keyword);
  const seed = index + keyword.length;
  const breed = pick(CAT_BREEDS, seed + 3);
  const interactions = INTERACTIONS[topic] || INTERACTIONS.general;
  const interaction = pick(interactions, seed);
  const angle = pick(ANGLES, seed + 7);
  const lighting = pick(LIGHTING, seed + 11);

  return `A realistic photograph of ${breed}, ${interaction}. Shot ${angle} with ${lighting}. Sharp focus, realistic fur texture, natural composition in a real home environment. Softly blurred background, no studio equipment visible. The cat has exactly 4 legs, 2 eyes, 2 ears, and 1 tail. No text, no labels, no logos, no watermarks.`;
}

export function buildProductPrompt(
  keyword: string,
  productName: string,
  index: number
): string {
  const topic = detectTopic(keyword);
  const seed = index + keyword.length + productName.length;
  const breed = pick(CAT_BREEDS, seed);

  const genericProducts: Record<string, string> = {
    feeding: "a premium automatic cat feeder",
    grooming: "a cat grooming product",
    medical: "a cat health supplement",
    dental: "a cat dental care kit",
    behavior: "a cat calming product",
    litter: "a modern self-cleaning litter box",
    furniture: "a cat tree tower",
    toys: "a colorful interactive cat toy",
    beds: "a cozy heated cat bed",
    carrier: "a pet carrier backpack",
    tech: "a smart pet monitoring device",
    general: "a cat care product"
  };
  const generic = genericProducts[topic] || genericProducts.general;

  const cameraSpecs = [
    "Shot with a portrait lens at f/2.8, shallow depth of field",
    "Shot with an 85mm lens at f/2.2, creamy background blur",
    "Close-up shot with a macro lens at f/3.2, crisp detail"
  ];

  const camera = pick(cameraSpecs, seed + 7);
  const lighting = pick(LIGHTING, seed + 11);

  return `${breed} naturally posed beside ${generic} on a styled surface. ${camera}. ${lighting}. Realistic home photograph, sharp focus on the cat, shallow depth of field with soft bokeh background. No studio equipment, no text, no labels, no logos, no brand names, no watermarks.`;
}

// ── Generation + R2 storage ─────────────────────────────────────────────────

function imagesPublicBase(env: unknown): string {
  return (
    getEnvBinding(env, "IMAGES_PUBLIC_BASE_URL") ??
    DEFAULT_IMAGES_PUBLIC_BASE_URL
  ).replace(/\/$/, "");
}

export function heroImageR2Key(categorySlug: string, slug: string): string {
  return `articles/${categorySlug}/${slug}-hero.jpg`;
}

export function productImageR2Key(
  categorySlug: string,
  slug: string,
  productIndex: number
): string {
  return `articles/${categorySlug}/${slug}-product-${productIndex}.jpg`;
}

async function generateSingleImage(
  agent: SEOArticleAgent,
  prompt: string,
  model: string
): Promise<Uint8Array | null> {
  const ai = (
    agent.envBindings as {
      AI?: { run: (model: string, inputs: unknown) => Promise<unknown> };
    }
  ).AI;
  if (!ai) return null;
  const models = [model, FALLBACK_MODEL];

  for (const m of models) {
    try {
      const result = await ai.run(m, { prompt });
      if (
        result &&
        typeof result === "object" &&
        "image" in (result as Record<string, unknown>) &&
        typeof (result as Record<string, unknown>).image === "string"
      ) {
        return Uint8Array.from(
          atob((result as Record<string, string>).image),
          (c) => c.charCodeAt(0)
        );
      }
    } catch (err: unknown) {
      agent.log("warning", `Image model ${m} failed: ${errMsg(err)}`);
    }
  }
  return null;
}

async function storeImage(
  agent: SEOArticleAgent,
  r2Key: string,
  bytes: Uint8Array
): Promise<string | null> {
  const bucket = (agent.envBindings as { IMAGES_R2?: R2Bucket }).IMAGES_R2;
  if (!bucket) return null;
  await bucket.put(r2Key, bytes, {
    httpMetadata: {
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable"
    }
  });
  return `${imagesPublicBase(agent.envBindings)}/${r2Key}`;
}

/** Generate the hero image for an article. */
export async function generateHeroImage(
  agent: SEOArticleAgent,
  keyword: string,
  categorySlug: string,
  slug: string
): Promise<GeneratedImage | null> {
  const prompt = buildHeroPrompt(keyword, 0);
  const bytes = await generateSingleImage(agent, prompt, BLOG_IMAGE_MODEL);
  if (!bytes) return null;

  const r2Key = heroImageR2Key(categorySlug, slug);
  const url = await storeImage(agent, r2Key, bytes);
  if (!url) return null;
  agent.log(
    "info",
    `Hero image: ${r2Key} (${Math.round(bytes.length / 1024)} KB) → ${url}`,
    "productManager",
    { kanbanStage: "done" }
  );

  return {
    r2Key,
    url,
    alt: `${keyword} - cat product photo`,
    caption: keyword,
    width: 1024,
    height: 1024,
    imageType: "hero",
    prompt
  };
}

/** Generate a product image for the comparison table (flag-gated). */
export async function generateProductImage(
  agent: SEOArticleAgent,
  keyword: string,
  productName: string,
  categorySlug: string,
  slug: string,
  productIndex: number
): Promise<GeneratedImage | null> {
  const prompt = buildProductPrompt(keyword, productName, productIndex);
  const bytes = await generateSingleImage(agent, prompt, PRODUCT_IMAGE_MODEL);
  if (!bytes) return null;

  const r2Key = productImageR2Key(categorySlug, slug, productIndex);
  const url = await storeImage(agent, r2Key, bytes);
  if (!url) return null;
  agent.log(
    "info",
    `Product image ${productIndex}: ${r2Key} (${Math.round(bytes.length / 1024)} KB)`,
    "productManager"
  );

  return {
    r2Key,
    url,
    alt: `${productName} - product photo`,
    caption: productName,
    width: 1024,
    height: 1024,
    imageType: "product",
    prompt
  };
}

/**
 * Pipeline entry point (writer.ts Step 10.5): hero image, plus product
 * images when ARTICLE_PRODUCT_IMAGES="on". Never throws; a null hero
 * just means the article publishes without one.
 */
export async function generateAndStoreHeroImage(
  agent: SEOArticleAgent,
  keyword: string,
  _categoryName: string,
  categorySlug: string,
  slug: string
): Promise<string | null> {
  const env = agent.envBindings;
  const flag = (getEnvBinding(env, "ARTICLE_HERO_IMAGE") ?? "on").toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return null;

  try {
    const hero = await generateHeroImage(agent, keyword, categorySlug, slug);
    return hero?.url ?? null;
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Hero image generation failed (non-fatal, article publishes without it): ${errMsg(err)}`,
      "productManager"
    );
    return null;
  }
}

/**
 * Generate all images for an article (hero + up to 3 product images).
 * Product images run only when ARTICLE_PRODUCT_IMAGES="on" — pick cards
 * already show real Amazon photos, so AI product shots are an explicit
 * editorial opt-in.
 */
export async function generateArticleImages(
  agent: SEOArticleAgent,
  keyword: string,
  categorySlug: string,
  slug: string,
  products: Array<{ name?: string; displayName?: string }>
): Promise<GeneratedImage[]> {
  const images: GeneratedImage[] = [];

  const hero = await generateHeroImage(agent, keyword, categorySlug, slug);
  if (hero) images.push(hero);

  const productFlag = (
    getEnvBinding(agent.envBindings, "ARTICLE_PRODUCT_IMAGES") ?? "off"
  ).toLowerCase();
  if (productFlag === "on" || productFlag === "true" || productFlag === "1") {
    const realProducts = products
      .filter((p) => p.displayName || p.name)
      .slice(0, 3);
    for (let i = 0; i < realProducts.length; i++) {
      const pName =
        realProducts[i].displayName || realProducts[i].name || keyword;
      const productImg = await generateProductImage(
        agent,
        keyword,
        pName,
        categorySlug,
        slug,
        i
      );
      if (productImg) images.push(productImg);
    }
  }

  agent.log(
    "info",
    `Images: ${images.length} generated (${images.filter((i) => i.imageType === "hero").length} hero + ${images.filter((i) => i.imageType === "product").length} product)`
  );
  return images;
}
