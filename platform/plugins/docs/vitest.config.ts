import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "hyperfide-plugin-simple-notes",
    testTimeout: 15_000,
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
