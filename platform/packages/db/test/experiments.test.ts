import { createMigratedConnection } from "../src/testing.js";
import { describe, expect, it } from "vitest";
import {
  defaultAppSettings,
  defaultExperiments,
  earlyAdopterExperiments,
} from "@hyperfide/domain";
import {
  getExperiments,
  setAppSettings,
  setExperiments,
} from "../src/index.js";

async function storedExperimentRows(
  db: Awaited<ReturnType<typeof createMigratedConnection>>,
) {
  return await db.$client
    .prepare<[], { key: string; value: number }>(
      "SELECT key, value FROM system_experiments ORDER BY key",
    )
    .all();
}

describe("experiments", () => {
  it("stores typed experiment keys and ignores unknown stored keys", async () => {
    const db = await createMigratedConnection();

    try {
      expect(await getExperiments(db)).toEqual(defaultExperiments);

      await setExperiments(db, { changelogPreview: true });
      await db.$client
        .prepare(
          "INSERT INTO system_experiments (key, value, updated_at) VALUES ('futureExperiment', 1, 1)",
        )
        .run();

      expect(await getExperiments(db)).toEqual({
        ...defaultExperiments,
        changelogPreview: true,
      });
    } finally {
      await db.close();
    }
  });

  it("stores only the experiments a write names so the rest follow their defaults", async () => {
    const db = await createMigratedConnection();

    try {
      await setExperiments(db, { serverMove: true });
      await setExperiments(db, { serverMove: false });

      expect(await storedExperimentRows(db)).toEqual([
        { key: "serverMove", value: 0 },
      ]);
      expect(await getExperiments(db)).toEqual({
        ...defaultExperiments,
        serverMove: false,
      });
    } finally {
      await db.close();
    }
  });

  it("follows the early adopter defaults only for experiments the user has not set", async () => {
    const db = await createMigratedConnection();

    try {
      await setExperiments(db, { timelinePush: false, changelogPreview: true });
      await setAppSettings(db, { ...defaultAppSettings, earlyAdopter: true });

      expect(await getExperiments(db)).toEqual({
        ...earlyAdopterExperiments,
        timelinePush: false,
        changelogPreview: true,
      });

      await db.$client.prepare("DELETE FROM system_experiments").run();
      expect(await getExperiments(db)).toEqual(earlyAdopterExperiments);

      await setAppSettings(db, { ...defaultAppSettings, earlyAdopter: false });
      expect(await getExperiments(db)).toEqual(defaultExperiments);
    } finally {
      await db.close();
    }
  });
});
