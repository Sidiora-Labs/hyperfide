import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "hyperfide-spec", include: ["src/**/*.test.ts"] },
});
