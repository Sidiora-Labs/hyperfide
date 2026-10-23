import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    conditions: ["source"],
    alias: {
      "@hyperfide/plugin-sdk/testing": new URL("../../packages/plugin-sdk/src/testing/index.ts", import.meta.url).pathname,
    },
  },
  test: { environment: "node", testTimeout: 15000 },
});
