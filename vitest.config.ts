import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          GITHUB_CLIENT_SECRET: "test-github-secret",
          SCHWAB_CLIENT_ID: "test-schwab-client",
          SCHWAB_CLIENT_SECRET: "test-schwab-secret",
          ENABLE_TRADING: "true",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
