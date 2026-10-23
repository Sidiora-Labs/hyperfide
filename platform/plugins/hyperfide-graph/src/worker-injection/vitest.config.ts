import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["plugins/hyperfide-graph/src/worker-injection/**/*.test.ts"] },
});
