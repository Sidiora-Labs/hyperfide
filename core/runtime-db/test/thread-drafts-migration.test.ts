import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PERSONAL_PROJECT_ID, type PromptInput } from "@hyperfide/domain";
import {
  createConnection,
  createQueuedThreadMessage,
  createThread,
  migrate,
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

const THREAD_DRAFTS_MIGRATION_TIMESTAMP = 1790322211064;
const originalMigration = readFileSync(
  new URL("./fixtures/0132_thread_drafts_original.sql", import.meta.url),
  "utf8",
);

function text(value: string): PromptInput {
  return { type: "text", text: value, mentions: [] };
}

it.each([false, true])(
  "removes the native draft schema without moving queue data (original migration applied: %s)",
  async (alreadyMigrated) => {
    const db = await createConnection(":memory:");
    try {
      await migrate(db);
      const draftThread = await createThread(db, noopNotifier, {
        projectId: PERSONAL_PROJECT_ID,
        providerId: "test-provider",
        status: "pending",
      });
      const followUpThread = await createThread(db, noopNotifier, {
        projectId: PERSONAL_PROJECT_ID,
        providerId: "test-provider",
        status: "idle",
      });
      const queue = async (
        threadId: string,
        content: PromptInput[],
        pluginId: string | null,
      ) =>
        await createQueuedThreadMessage(db, noopNotifier, {
          threadId,
          content,
          model: "test-model",
          reasoningLevel: "medium",
          permissionMode: "auto",
          serviceTier: "default",
          waitingOn:
            pluginId === null
              ? null
              : { kind: "plugin", pluginId, reason: "Draft" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        });
      await queue(draftThread.id, [text("First draft")], "drafts");
      await queue(followUpThread.id, [text("Draft one")], "drafts");
      await queue(
        followUpThread.id,
        [
          text("Draft two"),
          { type: "localFile", path: "/tmp/notes.md", name: "notes.md" },
        ],
        "drafts",
      );
      await queue(followUpThread.id, [text("Queued for real")], null);
      await queue(
        followUpThread.id,
        [text("Held elsewhere")],
        "concurrency-limit",
      );
      await db.$client.exec(
        `INSERT INTO plugins (id, source, provenance, source_kind, source_builtin_name, root_dir, version, installed_at, updated_at)
         VALUES ('drafts', 'builtin:drafts', 'builtin', 'builtin', 'drafts', '/tmp/drafts', '0.1.0', 1, 1)`,
      );
      await db.$client
        .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
        .run(THREAD_DRAFTS_MIGRATION_TIMESTAMP);

      if (alreadyMigrated) {
        await db.$client.exec(originalMigration);
        await db.$client
          .prepare(
            "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
          )
          .run(
            createHash("sha256").update(originalMigration).digest("hex"),
            THREAD_DRAFTS_MIGRATION_TIMESTAMP,
          );
        expect(
          await db.$client
            .prepare("SELECT draft FROM threads WHERE draft IS NOT NULL")
            .all(),
        ).toHaveLength(2);
      }

      const queueBefore = await db.$client
        .prepare("SELECT * FROM queued_thread_messages ORDER BY id")
        .all();
      const pluginsBefore = await db.$client
        .prepare("SELECT * FROM plugins ORDER BY id")
        .all();
      const threadsBefore = await db.$client
        .prepare("SELECT id, status FROM threads ORDER BY id")
        .all();
      expect(queueBefore).toHaveLength(alreadyMigrated ? 2 : 5);

      dropIdleLifecycleIndexes(db);
      await rewindThreadPruningWork(db);
      await dropPluginEnabledFollowsDefaultColumn(db);
      await dropQueuedMessageEditHeldUntilColumn(db);
      await dropMarketplaceSourceGitSubdirectoryColumn(db);
      await dropThreadParentNotificationsColumn(db);
      await migrate(db);
      await migrate(db);

      expect(
        await db.$client
          .prepare("SELECT * FROM queued_thread_messages ORDER BY id")
          .all(),
      ).toEqual(queueBefore);
      expect(
        await db.$client.prepare("SELECT * FROM plugins ORDER BY id").all(),
      ).toEqual(pluginsBefore);
      expect(
        await db.$client
          .prepare("SELECT id, status FROM threads ORDER BY id")
          .all(),
      ).toEqual(threadsBefore);
      expect(
        await db.$client
          .prepare(
            "SELECT name FROM pragma_table_info('threads') WHERE name = 'draft'",
          )
          .all(),
      ).toEqual([]);
      expect(
        await db.$client.prepare("PRAGMA foreign_key_check").all(),
      ).toEqual([]);
    } finally {
      await db.close();
    }
  },
);
