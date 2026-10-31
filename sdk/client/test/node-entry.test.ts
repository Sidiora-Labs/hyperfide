import { afterEach, describe, expect, it, vi } from "vitest";

const NODE_ENTRY_IMPORT_TEST_TIMEOUT_MS = 60_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("@hyperfide/sdk/node entry", () => {
  it(
    "imports and builds explicit SDKs without HYPERFIDE server configuration",
    async () => {
      vi.stubEnv("HYPERFIDE_SERVER_URL", undefined);
      vi.stubEnv("HYPERFIDE_HOST_DAEMON_PORT", undefined);

      const nodeEntry = await import("../src/node.js");
      const sdk = nodeEntry.createNodeHyperfideSdk({ baseUrl: "http://server" });

      expect(typeof sdk.threads.list).toBe("function");
    },
    NODE_ENTRY_IMPORT_TEST_TIMEOUT_MS,
  );
});
