import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "hyperfide-plugin-custom-instructions",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
