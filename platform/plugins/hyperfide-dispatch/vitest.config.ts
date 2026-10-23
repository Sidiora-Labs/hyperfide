import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    name: "hyperfide-dispatch",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
