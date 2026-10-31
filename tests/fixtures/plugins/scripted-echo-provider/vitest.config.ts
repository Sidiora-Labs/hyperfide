import { defineWorkspaceTestConfig } from "../../../../platform/vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    name: "hyperfide-plugin-scripted-echo-provider",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
