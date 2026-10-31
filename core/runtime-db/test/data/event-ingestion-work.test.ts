// SQLite total_changes() measures native write amplification.
import { isPostgresTest } from "../../src/testing.js";
import { createMigratedConnection } from "../../src/testing.js";
import {
  appendDaemonEventsInTransaction,
  appendStoredThreadEventsInTransaction,
  copyStoredThreadEventsInTransaction,
  createProject,
  createThread,
  insertEvents,
  listStoredEventRows,
  noopNotifier,
  upsertHost,
} from "@hyperfide/db";
import { threadScope } from "@hyperfide/domain";
import { expect, it } from "vitest";

it.skipIf(isPostgresTest).each(["daemon", "stored", "import", "copy"] as const)(
  "bounds pruning writes for %s event batches and rolls them back with events",
  async (mode) => {
    const db = await createMigratedConnection();
    const host = await upsertHost(db, noopNotifier, { name: "ingestion" });
    const { project } = await createProject(db, noopNotifier, {
      name: "ingestion",
      source: { type: "local_path", hostId: host.id, path: "/tmp/ingestion" },
    });
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "benchmark",
    });
    const source = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "benchmark",
    });
    const stored = (threadId: string) =>
      Array.from({ length: 128 }, () => ({
        threadId,
        scope: threadScope(),
        type: "system/error" as const,
        data: { message: "benchmark" },
      }));
    await db.transaction(
      async (tx) =>
        await appendStoredThreadEventsInTransaction(tx, stored(source.id)),
    );
    const copied = await listStoredEventRows(db, { threadId: source.id });
    let sequence = 0;
    const append = async () => {
      const inputs = stored(thread.id);
      switch (mode) {
        case "daemon":
          await db.transaction(
            async (tx) =>
              await appendDaemonEventsInTransaction(
                tx,
                inputs.map((input) => ({
                  ...input,
                  data: JSON.stringify(input.data),
                  environmentId: null,
                  providerThreadId: null,
                  itemId: null,
                  itemKind: null,
                  parentToolCallId: null,
                })),
              ),
          );
          break;
        case "stored":
          await db.transaction(
            async (tx) =>
              await appendStoredThreadEventsInTransaction(tx, inputs),
          );
          break;
        case "import":
          await insertEvents(
            db,
            noopNotifier,
            inputs.map((input) => ({
              ...input,
              sequence: ++sequence,
              data: JSON.stringify(input.data),
              itemId: null,
              itemKind: null,
              parentToolCallId: null,
            })),
          );
          break;
        case "copy":
          await db.transaction(
            async (tx) =>
              await copyStoredThreadEventsInTransaction(tx, {
                rows: copied,
                targetThreadId: thread.id,
                targetEnvironmentId: null,
              }),
          );
          break;
      }
    };
    const changes = async () =>
      await db.$client.prepare("SELECT total_changes()").pluck().get();
    try {
      const before = await changes();
      if (typeof before !== "number")
        throw new Error("Invalid SQLite change count");
      await append();
      const after = await changes();
      if (typeof after !== "number")
        throw new Error("Invalid SQLite change count");
      expect(after - before).toBeLessThanOrEqual(128 + 1);
      expect(
        await db.$client
          .prepare(
            "SELECT count(*) FROM thread_pruning_work WHERE thread_id = ?",
          )
          .pluck()
          .get(thread.id),
      ).toBe(1);
      await append();
      const coalesced = await changes();
      if (typeof coalesced !== "number")
        throw new Error("Invalid SQLite change count");
      expect(coalesced - after).toBe(128);
      await db.$client
        .prepare("DELETE FROM thread_pruning_work WHERE thread_id = ?")
        .run(thread.id);
      await expect(
        (async () =>
          db.transaction(async () => {
            await append();
            throw new Error("rollback ingestion");
          }))(),
      ).rejects.toThrow("rollback ingestion");
      expect(
        await listStoredEventRows(db, { threadId: thread.id }),
      ).toHaveLength(256);
      expect(
        await db.$client
          .prepare(
            "SELECT count(*) FROM thread_pruning_work WHERE thread_id = ?",
          )
          .pluck()
          .get(thread.id),
      ).toBe(0);
    } finally {
      await db.close();
    }
  },
);
