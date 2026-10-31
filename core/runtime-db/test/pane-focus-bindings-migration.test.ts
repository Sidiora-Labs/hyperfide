// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../src/testing.js";
import { describe, expect, it } from "vitest";
import type { AppKeybindingOverrides } from "@hyperfide/domain";
import {
  createConnection,
  getAppKeybindingOverrides,
  migrate,
  setAppKeybindingOverrides,
} from "../src/index.js";
import {
  dropPluginEnabledFollowsDefaultColumn,
  dropIdleLifecycleIndexes,
  rewindThreadPruningWork,
  dropMarketplaceSourceGitSubdirectoryColumn,
  dropThreadParentNotificationsColumn,
  dropQueuedMessageEditHeldUntilColumn,
} from "./helpers/rewind.js";

const migrationTimestamp = 1790738477751;
const directions = ["left", "right", "up", "down"] as const;
const legacyOverrides: AppKeybindingOverrides = directions.map((direction) => ({
  command: `pane.focus.${direction}`,
  platform: "mac",
  shortcut: {
    key: `Arrow${direction[0].toUpperCase()}${direction.slice(1)}`,
    mod: true,
    meta: false,
    control: false,
    alt: false,
    shift: true,
  },
}));
const custom: AppKeybindingOverrides = [
  {
    command: "pane.focus.left",
    shortcut: {
      key: "h",
      mod: false,
      meta: false,
      control: true,
      alt: true,
      shift: false,
    },
  },
  { command: "pane.focus.right", shortcut: null },
  { command: "thread.new", shortcut: null },
];

async function upgradeDatabase(overrides: AppKeybindingOverrides | undefined) {
  const db = await createConnection(":memory:");
  await migrate(db);
  dropIdleLifecycleIndexes(db);
  await rewindThreadPruningWork(db);
  await dropPluginEnabledFollowsDefaultColumn(db);
  await dropQueuedMessageEditHeldUntilColumn(db);
  await dropMarketplaceSourceGitSubdirectoryColumn(db);
  await dropThreadParentNotificationsColumn(db);
  await db.$client
    .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
    .run(migrationTimestamp);
  if (overrides !== undefined) await setAppKeybindingOverrides(db, overrides);
  return db;
}

describe("pane focus compatibility migration", () => {
  it.each([
    { name: "untouched settings", overrides: undefined },
    { name: "empty overrides", overrides: [] },
    { name: "custom and disabled overrides", overrides: custom },
    {
      name: "all directions disabled",
      overrides: directions.map((direction) => ({
        command: `pane.focus.${direction}` as const,
        shortcut: null,
      })),
    },
  ])(
    "preserves effective defaults and explicit overrides on upgrade ($name)",
    async ({ overrides }) => {
      const db = await upgradeDatabase(overrides);
      try {
        await migrate(db);
        const expected = [
          ...(overrides ?? []),
          ...legacyOverrides.filter(
            (binding) =>
              !overrides?.some(
                (override) => override.command === binding.command,
              ),
          ),
        ];
        expect(await getAppKeybindingOverrides(db)).toEqual(expected);
        await migrate(db);
        expect(await getAppKeybindingOverrides(db)).toEqual(expected);
        await setAppKeybindingOverrides(
          db,
          expected.filter((binding) => binding.command !== "pane.focus.up"),
        );
        const restarted = await createConnection(db.$client.serialize());
        try {
          await migrate(restarted);
          expect(await getAppKeybindingOverrides(restarted)).toEqual(
            expected.filter((binding) => binding.command !== "pane.focus.up"),
          );
          await setAppKeybindingOverrides(restarted, []);
          await migrate(restarted);
          expect(await getAppKeybindingOverrides(restarted)).toEqual([]);
        } finally {
          await restarted.close();
        }
      } finally {
        await db.close();
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "keeps fresh installations on live defaults across restart",
    async () => {
      const db = await createConnection(":memory:");
      try {
        await migrate(db);
        expect(await getAppKeybindingOverrides(db)).toEqual([]);
        const restarted = await createConnection(db.$client.serialize());
        try {
          await migrate(restarted);
          expect(await getAppKeybindingOverrides(restarted)).toEqual([]);
        } finally {
          await restarted.close();
        }
      } finally {
        await db.close();
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "rolls back settings and the ledger together, then retries safely",
    async () => {
      const db = await upgradeDatabase(custom);
      try {
        db.$client
          .exec(`CREATE TRIGGER reject_pane_migration BEFORE INSERT ON __drizzle_migrations
        WHEN NEW.created_at = ${migrationTimestamp}
        BEGIN SELECT RAISE(ABORT, 'migration interrupted'); END`);
        await expect((async () => await migrate(db))()).rejects.toThrow(
          "Failed to run the query",
        );
        expect(await getAppKeybindingOverrides(db)).toEqual(custom);
        expect(
          await db.$client
            .prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ?")
            .get(migrationTimestamp),
        ).toBeUndefined();
        await db.$client.exec("DROP TRIGGER reject_pane_migration");
        await migrate(db);
        expect(await getAppKeybindingOverrides(db)).toEqual([
          ...custom,
          ...legacyOverrides.slice(2),
        ]);
      } finally {
        await db.close();
      }
    },
  );
});
