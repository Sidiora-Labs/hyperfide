import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@hyperfide/scripts",
      include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
      // Inline projects need the command-line exclusions applied explicitly.
      exclude: [
        "dist/**",
        "node_modules/**",
        ...process.argv.flatMap((arg, index) =>
          arg === "--exclude" && process.argv[index + 1]
            ? [process.argv[index + 1]!]
            : [],
        ),
      ],
    }),
  },
});
