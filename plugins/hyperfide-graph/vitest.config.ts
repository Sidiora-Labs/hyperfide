import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { tsconfigPaths: true, conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    name: "hyperfide-graph",
    include: [
      "*.test.{ts,tsx}",
      "../../core/server/test/services/plugins/builtin-registry.test.ts",
    ],
  },
});
