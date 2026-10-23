import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 2),
    silent: "passed-only",
    name: "hyperfide-plugin-provider-pi",
    include: ["*.test.ts", "*.test.tsx", "src/**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
