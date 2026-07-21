import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // A parent folder (e.g. ~/Development) may contain a hoisted Tailwind v3 install that
  // breaks the client CSS build; keep resolution anchored to this project.
  resolve: {
    dedupe: ["tailwindcss", "@tailwindcss/vite", "@tailwindcss/node"]
  },
  optimizeDeps: {
    entries: [path.resolve(__dirname, "index.html")]
  },
  plugins: [agents(), react(), cloudflare(), tailwindcss()]
});
