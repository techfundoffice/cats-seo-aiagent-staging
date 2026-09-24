import type { SEOArticleAgent } from "../server";

/**
 * article-image.ts — prompt helpers retained from the old Flux pipeline.
 *
 * Workers AI image generation is removed. The `ai` binding billed Regular
 * Twitch Neurons, and there is no replacement image provider (Claude does
 * not generate images). `generateAndStoreHeroImage` returns null so the
 * article still publishes. Direct generate* calls throw
 * `WORKERS_AI_IMAGES_REMOVED_ERROR` instead of calling `@cf/` models or
 * `accounts/.../ai/run`.
 *
 * The prompt builders stay so the no-text slop guard remains tested. They
 * are not sent to a model.
 */

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

// ── R2 key scheme (storage helpers; nothing writes images today) ───────────

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

export const WORKERS_AI_IMAGES_REMOVED_ERROR =
  "Workers AI image generation was removed (Regular Twitch Neurons). This worker has no AI binding and no replacement image provider.";

function workersAiImagesRemoved(): never {
  throw new Error(WORKERS_AI_IMAGES_REMOVED_ERROR);
}

/** Refuses to call Workers AI. There is no image provider to fall back to. */
export async function generateHeroImage(
  _agent: SEOArticleAgent,
  _keyword: string,
  _categorySlug: string,
  _slug: string
): Promise<GeneratedImage | null> {
  workersAiImagesRemoved();
}

/** Refuses to call Workers AI. There is no image provider to fall back to. */
export async function generateProductImage(
  _agent: SEOArticleAgent,
  _keyword: string,
  _productName: string,
  _categorySlug: string,
  _slug: string,
  _productIndex: number
): Promise<GeneratedImage | null> {
  workersAiImagesRemoved();
}

/**
 * Pipeline entry point (writer.ts Step 10.5). Never throws. Returns null
 * so the article publishes without a generated hero.
 */
export async function generateAndStoreHeroImage(
  agent: SEOArticleAgent,
  _keyword: string,
  _categoryName: string,
  _categorySlug: string,
  _slug: string
): Promise<string | null> {
  agent.log(
    "info",
    "Hero image skipped: Workers AI was removed (Regular Twitch Neurons). Article publishes without a generated hero.",
    "productManager"
  );
  return null;
}

/**
 * Refuses to call Workers AI. Callers that still want a batch must handle
 * the error; the writer path uses `generateAndStoreHeroImage` instead.
 */
export async function generateArticleImages(
  _agent: SEOArticleAgent,
  _keyword: string,
  _categorySlug: string,
  _slug: string,
  _products: Array<{ name?: string; displayName?: string }>
): Promise<GeneratedImage[]> {
  workersAiImagesRemoved();
}
