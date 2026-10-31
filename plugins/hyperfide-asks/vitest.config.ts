import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    conditions: ["source"],
    alias: {
      "@hyperfide/plugin-sdk/testing/app": new URL("../../sdk/plugins/src/testing/app.tsx", import.meta.url).pathname,
      "@hyperfide/plugin-sdk/testing": new URL("../../sdk/plugins/src/testing/index.ts", import.meta.url).pathname,
    },
  },
  test: { environment: "node", testTimeout: 15000 },
});
