import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin builds one output per environment under `dist/`:
// `dist/client` for the browser bundle (which wrangler serves as assets) and
// `dist/collab_ai` for the Worker. Don't override `build.outDir` — the plugin
// appends the environment name to it, which nests the output a level too deep.
export default defineConfig({
  plugins: [react(), cloudflare()],
});
