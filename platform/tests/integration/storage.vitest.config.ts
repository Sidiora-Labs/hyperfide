import { defineWorkspaceTestConfig } from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({
  test: { include: ["storage-dialects.test.ts"], testTimeout: 15_000 },
});
