import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // These two secrets are fake on purpose. The Worker refuses every
        // request unless both ANTHROPIC_API_KEY and ROOM_SECRET are present
        // (see src/server/index.ts), so the pool needs *some* value for each
        // to exercise that code path — but no integration test in this suite
        // may ever reach the real Anthropic API. If a test only passes
        // because it used a real key, it is testing the wrong thing: these
        // tests exist to guard routing, auth and admission logic, not model
        // output. Keep these obviously-fake so nobody is tempted to swap in
        // a real key "to make it work".
        bindings: {
          ANTHROPIC_API_KEY: "test-key-not-real",
          ROOM_SECRET: "test-secret-not-real-but-long-enough-to-sign-with",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
