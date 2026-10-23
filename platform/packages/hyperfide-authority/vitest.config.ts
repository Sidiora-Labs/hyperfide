import { defineWorkspaceTestConfig } from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({test: {
  name: "@hyperfide/authority", include: ["test/**/*.test.ts"],
}});
