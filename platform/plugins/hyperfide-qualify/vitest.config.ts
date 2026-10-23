import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    name: "hyperfide-qualify",
    include: ["*.test.ts"],
    testTimeout: 15000,
  },
});
