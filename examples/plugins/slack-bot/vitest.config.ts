import { defineWorkspaceTestConfig } from "../../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    name: "hyperfide-plugin-slack-bot",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
