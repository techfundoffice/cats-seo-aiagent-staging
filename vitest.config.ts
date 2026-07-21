import { defineConfig } from "vitest/config";

// Minimal node-environment config. The tests in this repo target pure
// helpers (redactSecrets, ring buffer, observer-health math). They do not
// import React render code or the Cloudflare Workers runtime, so we
// don't need jsdom or @cloudflare/vitest-pool-workers — both would add
// significant install + CI cost for zero benefit.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    benchmark: { include: ["src/**/*.bench.ts"] }
  }
});
