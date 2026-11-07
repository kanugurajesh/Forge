import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@forge/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@forge/runner": fileURLToPath(new URL("./packages/runner/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"], testTimeout: 60000 },
});
