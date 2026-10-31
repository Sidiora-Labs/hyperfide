import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "hyperfide-plugin-hyperfide-guide",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
