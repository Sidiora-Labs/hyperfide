import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "hyperfide-dispatch", include: ["src/**/*.test.ts"] },
});
