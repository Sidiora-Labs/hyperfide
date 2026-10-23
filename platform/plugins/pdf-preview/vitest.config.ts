import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "hyperfide-plugin-pdf-preview",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
