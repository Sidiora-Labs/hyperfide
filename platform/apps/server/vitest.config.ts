import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    testTimeout: 30_000,
    expect: { poll: { timeout: 10_000, interval: 25 } },
    globalSetup: [
      "test/setup/migrated-db-template.ts",
      "test/setup/native-module-cache.ts",
    ],
    setupFiles: [
      "test/setup/connection-cleanup.ts",
      "test/setup/stored-event-decode-freeze.ts",
      "test/setup/warm-test-harness.ts",
    ],
    env: {
      HYPERFIDE_DATA_DIR: "/tmp/hyperfide-server-test",
      HYPERFIDE_SERVER_PORT: "49161",
      HYPERFIDE_HOST_DAEMON_PORT: "49162",
    },
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@hyperfide/server",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    }),
  },
});
