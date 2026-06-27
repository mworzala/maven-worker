import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig, type Plugin, type ViteUserConfig } from "vitest/config";

export default defineConfig(async (): Promise<ViteUserConfig> => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }) as Plugin,
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      coverage: {
        provider: "istanbul",
        include: ["src/**/*.ts"],
        exclude: ["src/types.ts"],
        reporter: ["text", "text-summary"],
      },
    },
  };
});
