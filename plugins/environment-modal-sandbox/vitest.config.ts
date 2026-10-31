import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "hyperfide-plugin-environment-modal-sandbox",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
