import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listStoredUiPreferences,
  overwriteStoredUiPreference,
  replaceStoredUiPreference,
  type DbConnection,
} from "../../src/index.js";
import { createMigratedConnection } from "../../src/testing.js";

describe("ui preferences data", () => {
  let db: DbConnection;

  beforeEach(async () => {
    db = await createMigratedConnection();
  });

  afterEach(async () => {
    await db.close();
  });

  it("creates a row at revision 1 only when the expected revision is 0", async () => {
    expect(await listStoredUiPreferences(db)).toEqual([]);
    expect(
      await replaceStoredUiPreference(db, {
        expectedRevision: 3,
        key: "sidebar.organizationMode",
        valueJson: '"machine"',
      }),
    ).toEqual({ outcome: "conflict", revision: 0 });
    expect(
      await replaceStoredUiPreference(db, {
        expectedRevision: 0,
        key: "sidebar.organizationMode",
        valueJson: '"machine"',
      }),
    ).toEqual({ outcome: "updated", revision: 1 });
    expect(await listStoredUiPreferences(db)).toEqual([
      {
        key: "sidebar.organizationMode",
        revision: 1,
        valueJson: '"machine"',
      },
    ]);
  });

  it("rejects stale writes and keeps the current value", async () => {
    await replaceStoredUiPreference(db, {
      expectedRevision: 0,
      key: "sidebar.hiddenFooterItems",
      valueJson: '["prj_1"]',
    });
    await replaceStoredUiPreference(db, {
      expectedRevision: 1,
      key: "sidebar.hiddenFooterItems",
      valueJson: '["prj_1","prj_2"]',
    });
    expect(
      await replaceStoredUiPreference(db, {
        expectedRevision: 1,
        key: "sidebar.hiddenFooterItems",
        valueJson: "[]",
      }),
    ).toEqual({ outcome: "conflict", revision: 2 });
    expect(await listStoredUiPreferences(db)).toEqual([
      {
        key: "sidebar.hiddenFooterItems",
        revision: 2,
        valueJson: '["prj_1","prj_2"]',
      },
    ]);
  });

  it("overwrites without a revision check and still advances the revision", async () => {
    expect(
      await overwriteStoredUiPreference(db, {
        key: "sidebar.chronologicalSort",
        valueJson: '"alpha"',
      }),
    ).toEqual({ revision: 1 });
    await replaceStoredUiPreference(db, {
      expectedRevision: 1,
      key: "sidebar.chronologicalSort",
      valueJson: '"created"',
    });
    expect(
      await overwriteStoredUiPreference(db, {
        key: "sidebar.chronologicalSort",
        valueJson: '"updated"',
      }),
    ).toEqual({ revision: 3 });
    expect(await listStoredUiPreferences(db)).toEqual([
      {
        key: "sidebar.chronologicalSort",
        revision: 3,
        valueJson: '"updated"',
      },
    ]);
  });
});
