import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeLegacyAutomationPartitions } from "../src/desktop-browser-legacy-partitions.js";

describe("removeLegacyAutomationPartitions", () => {
  let userDataPath: string | null = null;

  afterEach(async () => {
    if (userDataPath !== null)
      await rm(userDataPath, { recursive: true, force: true });
    userDataPath = null;
  });

  it("removes old automation partitions and keeps the Browser partition", async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "hyperfide-desktop-partitions-"));
    const partitions = join(userDataPath, "Partitions");
    for (const name of [
      "hyperfide-browser",
      "hyperfide-browser-automation-3f2a",
      "hyperfide-browser-automation-9c1d",
      "other-app",
    ])
      await mkdir(join(partitions, name, "Cookies"), { recursive: true });

    await removeLegacyAutomationPartitions(userDataPath);

    expect((await readdir(partitions)).sort()).toEqual([
      "hyperfide-browser",
      "other-app",
    ]);
  });

  it("does nothing when no partitions exist yet", async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "hyperfide-desktop-partitions-"));
    await expect(
      removeLegacyAutomationPartitions(userDataPath),
    ).resolves.toBeUndefined();
  });
});
