import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@hyperfide/domain";
import {
  createConnection,
  migrate,
  createProject,
  createThread,
  upsertHost,
  noopNotifier,
} from "../src/index.js";
import {
  dropPluginEnabledFollowsDefaultColumn,
  dropIdleLifecycleIndexes,
  rewindThreadPruningWork,
  dropMarketplaceSourceGitSubdirectoryColumn,
  dropThreadParentNotificationsColumn,
  dropQueuedMessageEditHeldUntilColumn,
} from "./helpers/rewind.js";

const SIDEBAR_INSTALLATION_DEFAULTS_MIGRATION_TIMESTAMP = 1790009314673;

it("leaves a fresh migrated database without an installation override", async () => {
  const db = await createConnection(":memory:");
  try {
    await migrate(db);
    expect(
      await db.$client.prepare("SELECT * FROM ui_preference_defaults").all(),
    ).toEqual([]);
    expect(
      await db.$client.prepare("SELECT * FROM ui_preferences").all(),
    ).toEqual([]);
    await db.$client.exec(
      `INSERT INTO ui_preferences VALUES ('sidebar.chronologicalSort', '"alpha"', 1, 1)`,
    );
    await migrate(db);
    expect(
      await db.$client.prepare("SELECT * FROM ui_preference_defaults").all(),
    ).toEqual([]);
  } finally {
    await db.close();
  }
});

describe.each(["project", "thread", "preference"] as const)(
  "existing installation with %s",
  (kind) => {
    it.each([null, "chronological", "machine", "project"])(
      "keeps saved choice %s separate from the fallback",
      async (choice) => {
        const db = await createConnection(":memory:");
        try {
          await migrate(db);
          if (kind === "preference") {
            await db.$client.exec(
              `INSERT INTO ui_preferences VALUES ('sidebar.chronologicalSort', '"alpha"', 1, 1)`,
            );
          } else if (kind === "thread") {
            await createThread(db, noopNotifier, {
              projectId: PERSONAL_PROJECT_ID,
              providerId: "test-provider",
            });
          } else {
            const host = await upsertHost(db, noopNotifier, {
              id: "host-sidebar",
              name: "Sidebar test",
            });
            await createProject(db, noopNotifier, {
              name: "Existing project",
              source: {
                type: "local_path",
                hostId: host.id,
                path: "/tmp/sidebar-installation-defaults",
              },
            });
          }
          if (choice !== null) {
            await db.$client
              .prepare(
                "INSERT INTO ui_preferences VALUES ('sidebar.organizationMode', ?, 4, 123)",
              )
              .run(JSON.stringify(choice));
          }
          const before = await db.$client
            .prepare("SELECT * FROM ui_preferences")
            .all();
          const projects = await db.$client
            .prepare("SELECT * FROM projects")
            .all();
          const threads = await db.$client
            .prepare("SELECT * FROM threads")
            .all();
          await db.$client.exec("DROP TABLE ui_preference_defaults");
          dropIdleLifecycleIndexes(db);
          await rewindThreadPruningWork(db);
          await dropPluginEnabledFollowsDefaultColumn(db);
          await dropQueuedMessageEditHeldUntilColumn(db);
          await dropMarketplaceSourceGitSubdirectoryColumn(db);
          await dropThreadParentNotificationsColumn(db);
          await db.$client
            .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
            .run(SIDEBAR_INSTALLATION_DEFAULTS_MIGRATION_TIMESTAMP);
          await migrate(db);
          expect(
            await db.$client
              .prepare("SELECT * FROM ui_preference_defaults")
              .all(),
          ).toEqual([
            { key: "sidebar.organizationMode", value_json: '"project"' },
          ]);
          expect(
            await db.$client.prepare("SELECT * FROM ui_preferences").all(),
          ).toEqual(before);
          expect(
            await db.$client.prepare("SELECT * FROM projects").all(),
          ).toEqual(projects);
          expect(
            await db.$client.prepare("SELECT * FROM threads").all(),
          ).toEqual(threads);
          await migrate(db);
          expect(
            await db.$client.prepare("SELECT * FROM ui_preferences").all(),
          ).toEqual(before);
        } finally {
          await db.close();
        }
      },
    );
  },
);
