import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "hyperfide-plugin-hyperfide--storage-retention",
      include: ["src/**/*.test.ts", "app.test.tsx"],
    }),
  },
});
