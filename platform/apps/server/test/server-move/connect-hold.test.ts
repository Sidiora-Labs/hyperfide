import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginStartOptions } from "../../src/services/plugins/plugin-service.js";
import { startServerPlugins } from "../../src/start-server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-connect-hold-"));
  tempDirs.push(dataDir);
  return dataDir;
}

describe("server plugin startup", () => {
  it("starts the server's plugins without a hosted hold, then settles registrations and update checks", async () => {
    const dataDir = await makeDataDir();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const events: string[] = [];
    const starts: Array<PluginStartOptions | undefined> = [];

    await startServerPlugins({
      dataDir,
      logger,
      pluginService: {
        start: async (options) => {
          starts.push(options);
          events.push("start");
        },
        startPeriodicUpdateChecks: () => {
          events.push("update-checks");
        },
      },
      providerRegistry: {
        markRegistrationsSettled: () => {
          events.push("registrations-settled");
        },
      },
    });

    expect(events).toEqual(["start", "registrations-settled", "update-checks"]);
    expect(starts).toEqual([undefined]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
