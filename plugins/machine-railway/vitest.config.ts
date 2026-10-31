import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: { "@hyperfide/plugin-sdk/testing": new URL("../../sdk/plugins/src/testing/index.ts", import.meta.url).pathname },
  },
  test: { name: "hyperfide-machine-railway", include: ["src/**/*.test.ts"] },
});
