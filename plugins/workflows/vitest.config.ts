import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: "hyperfide-plugin-workflows",
    environment: "node",
    testTimeout: 15_000,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
