import type { SEOArticleAgent } from "../server";
import { errMsg, getEnvBinding } from "./http-utils";

/**
 * article-image.ts — Cloudflare-native hero image generation.
 *
 * Rebuilds the image step that was removed when R2 public URLs broke:
 * Workers AI (flux-1-schnell, free on the existing AI binding) renders a
 * photorealistic scene for the article, the bytes land in the IMAGES_R2
 * bucket, and the page references the bucket's managed public r2.dev
 * domain — a host the staging → production rewrite never touches, so
 * image URLs survive prod publishing unchanged.
 *
 * Slop guard: diffusion models mangle written text, so prompts are
 * scene-based and explicitly forbid text/labels/packaging. Never put a
 * product box in frame.
 *
 * Disable with worker var/secret ARTICLE_HERO_IMAGE="off".
 */

export const HERO_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** seo-images-staging bucket's managed public domain (enabled 2026-07-23). */
export const DEFAULT_IMAGES_PUBLIC_BASE_URL =
  "https://pub-d005467c78ef4809ab585678182662c8.r2.dev";

export function buildHeroImagePrompt(
  keyword: string,
  categoryName: string
): string {
  const topic = categoryName?.trim() || keyword;
  return (
    `Warm editorial lifestyle photograph for a premium cat care magazine, ` +
    `illustrating "${keyword}": a beautiful domestic cat in a bright, cozy ` +
    `home setting related to ${topic.toLowerCase()}, natural window light, ` +
    `shallow depth of field, photorealistic, professional magazine ` +
    `composition. Strictly no text, no labels, no logos, no product ` +
    `packaging, no writing of any kind, no watermarks.`
  );
}

export function heroImageR2Key(categorySlug: string, slug: string): string {
  return `articles/${categorySlug}/${slug}.jpg`;
}

/**
 * Generate the hero image and store it in R2. Returns the public URL, or
 * null when disabled, unconfigured, or on any failure — the article
 * publishes fine without a hero; this step must never block a publish.
 */
export async function generateAndStoreHeroImage(
  agent: SEOArticleAgent,
  keyword: string,
  categoryName: string,
  categorySlug: string,
  slug: string
): Promise<string | null> {
  const env = agent.envBindings;
  const flag = (getEnvBinding(env, "ARTICLE_HERO_IMAGE") ?? "on").toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return null;

  const ai = (
    env as {
      AI?: { run: (model: string, inputs: unknown) => Promise<unknown> };
    }
  ).AI;
  const bucket = (env as { IMAGES_R2?: R2Bucket }).IMAGES_R2;
  if (!ai || !bucket) {
    agent.log(
      "warning",
      `Hero image: skipped — missing ${!ai ? "AI" : "IMAGES_R2"} binding`,
      "productManager"
    );
    return null;
  }

  try {
    const res = (await ai.run(HERO_IMAGE_MODEL, {
      prompt: buildHeroImagePrompt(keyword, categoryName),
      steps: 8
    })) as { image?: string };
    if (!res?.image) throw new Error("no image in Workers AI response");
    const binary = atob(res.image);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const key = heroImageR2Key(categorySlug, slug);
    await bucket.put(key, bytes, {
      httpMetadata: {
        contentType: "image/jpeg",
        cacheControl: "public, max-age=31536000, immutable"
      }
    });
    const base = (
      getEnvBinding(env, "IMAGES_PUBLIC_BASE_URL") ??
      DEFAULT_IMAGES_PUBLIC_BASE_URL
    ).replace(/\/$/, "");
    const url = `${base}/${key}`;
    agent.log(
      "info",
      `Hero image: generated via ${HERO_IMAGE_MODEL} → ${url} (${Math.round(bytes.length / 1024)} KB)`,
      "productManager",
      { kanbanStage: "done" }
    );
    return url;
  } catch (err: unknown) {
    agent.log(
      "warning",
      `Hero image generation failed (non-fatal, article publishes without it): ${errMsg(err)}`,
      "productManager"
    );
    return null;
  }
}
