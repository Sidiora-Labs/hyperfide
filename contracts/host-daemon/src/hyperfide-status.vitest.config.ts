import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    name: "@hyperfide/host-daemon-contract-status",
    include: ["src/hyperfide-status.test.ts"],
  },
});
