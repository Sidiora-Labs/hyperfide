import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { tsconfigPaths: true, conditions: ["source"] },
  test: {
    name: "hyperfide-dispatch",
    testTimeout: 15000,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
