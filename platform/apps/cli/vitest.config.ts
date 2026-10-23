import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    testTimeout: 15_000,
    env: {
      HYPERFIDE_SERVER_URL: "http://127.0.0.1:49161",
      HYPERFIDE_HOST_DAEMON_PORT: "49162",
      HYPERFIDE_CLI_ERROR_LOG: "0",
    },
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@bb/cli",
      include: ["src/**/*.test.ts"],
    }),
  },
});
