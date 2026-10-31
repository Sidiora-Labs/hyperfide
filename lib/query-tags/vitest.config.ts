import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@hyperfide/query-tags",
      include: ["test/**/*.test.ts"],
    }),
  },
});
