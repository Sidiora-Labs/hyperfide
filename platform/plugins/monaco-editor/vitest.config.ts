import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true, conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    silent: "passed-only",
    name: "hyperfide-plugin-monaco-editor",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
