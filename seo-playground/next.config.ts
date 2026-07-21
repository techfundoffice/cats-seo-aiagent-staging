import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Wires D1/KV/etc. bindings into `next dev` via wrangler.
initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  // Don't fail builds on upstream-origin lint warnings; they're tracked in UPSTREAM.md
  eslint: { ignoreDuringBuilds: true },
  // Silence the "inferred workspace root" warning from the parent repo's lockfile
  outputFileTracingRoot: __dirname
};

export default nextConfig;
