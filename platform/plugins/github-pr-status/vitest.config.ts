import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    name: "hyperfide-plugin-hyperfide--github-pr-status",
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
