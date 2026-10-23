import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    name: "hyperfide-graph",
    include: [
      "*.test.{ts,tsx}",
      "../../apps/server/test/services/plugins/builtin-registry.test.ts",
    ],
  },
});
