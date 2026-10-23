// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../../src/testing.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createConnection, migrate } from "../../src/index.js";
import { threadPluginMetadata } from "../../src/schema.js";
import { withWriteAfterFirstRead } from "../helpers/interleave.js";
import { createProject } from "../../src/data/projects.js";
import {
  createThread,
  deleteThread,
  searchThreadsWithPendingInteractionState,
} from "../../src/data/threads.js";
import {
  getThreadPluginMetadata,
  insertThreadPluginMetadata,
  listThreadPluginMetadataRows,
  patchThreadPluginMetadata,
} from "../../src/data/thread-plugin-metadata.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup(name: string) {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: `${name}-host`,
    type: "persistent",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: `${name}-project`,
    source: { type: "local_path", hostId: host.id, path: `/tmp/${name}` },
  });
  return { db, project };
}

describe("thread plugin metadata persistence", () => {
  it("seeds one namespace and returns {} when absent", async () => {
    const { db, project } = await setup("seed");
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      pluginMetadata: { pluginId: "alpha", metadata: { a: 1, nullable: null } },
    });
    expect(await getThreadPluginMetadata(db, thread.id, "alpha")).toEqual({
      metadata: { a: 1, nullable: null },
      corrupt: false,
    });
    expect(await getThreadPluginMetadata(db, thread.id, "missing")).toEqual({
      metadata: {},
      corrupt: false,
    });
    await insertThreadPluginMetadata(db, {
      threadId: thread.id,
      pluginId: "beta",
      metadata: { b: 2 },
    });
    expect(
      await listThreadPluginMetadataRows(db, thread.id, [
        "alpha",
        "beta",
        "gamma",
      ]),
    ).toEqual(
      expect.arrayContaining([
        { pluginId: "alpha", metadataJson: '{"a":1,"nullable":null}' },
        { pluginId: "beta", metadataJson: '{"b":2}' },
      ]),
    );
    expect(await listThreadPluginMetadataRows(db, thread.id, ["beta"])).toEqual(
      [{ pluginId: "beta", metadataJson: '{"b":2}' }],
    );
    expect(await listThreadPluginMetadataRows(db, thread.id, [])).toEqual([]);
  });

  it("stores no row for an empty seed", async () => {
    const { db, project } = await setup("empty-seed");
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      pluginMetadata: { pluginId: "alpha", metadata: {} },
    });
    expect(
      await listThreadPluginMetadataRows(db, thread.id, ["alpha"]),
    ).toEqual([]);
  });

  it("shallow sets then removes atomically, including null and empty deletion", async () => {
    const { db, project } = await setup("patch");
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    await insertThreadPluginMetadata(db, {
      threadId: thread.id,
      pluginId: "p",
      metadata: { nested: { old: true }, keep: 1 },
    });
    expect(
      await patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "p",
        set: { nested: { next: true }, nullable: null },
        remove: ["keep"],
      }),
    ).toEqual({
      ok: true,
      metadata: { nested: { next: true }, nullable: null },
      replacedCorrupt: false,
    });
    expect(
      await patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "p",
        set: {},
        remove: ["missing"],
      }),
    ).toEqual({
      ok: true,
      metadata: { nested: { next: true }, nullable: null },
      replacedCorrupt: false,
    });
    expect(
      await patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "p",
        set: {},
        remove: ["nested", "nullable"],
      }),
    ).toEqual({ ok: true, metadata: {}, replacedCorrupt: false });
    expect(await listThreadPluginMetadataRows(db, thread.id, ["p"])).toEqual(
      [],
    );
  });

  it("reports an oversized merge without changing the stored namespace", async () => {
    const { db, project } = await setup("oversized");
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    await insertThreadPluginMetadata(db, {
      threadId: thread.id,
      pluginId: "p",
      metadata: { preserved: "x".repeat(200 * 1024) },
    });
    expect(
      await patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "p",
        set: { extra: "y".repeat(100 * 1024) },
        remove: [],
      }),
    ).toEqual({ ok: false, reason: "too_large" });
    expect(await getThreadPluginMetadata(db, thread.id, "p")).toEqual({
      metadata: { preserved: "x".repeat(200 * 1024) },
      corrupt: false,
    });
  });

  it("reports a corrupt row as {} and lets a patch replace it", async () => {
    const { db, project } = await setup("corrupt");
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    for (const metadataJson of ["not-json", "[1,2]", "null"]) {
      await db.delete(threadPluginMetadata).run();
      await db
        .insert(threadPluginMetadata)
        .values({ threadId: thread.id, pluginId: "p", metadataJson })
        .run();
      expect(await getThreadPluginMetadata(db, thread.id, "p")).toEqual({
        metadata: {},
        corrupt: true,
      });
      expect(
        await patchThreadPluginMetadata(db, {
          threadId: thread.id,
          pluginId: "p",
          set: { repaired: true },
          remove: [],
        }),
      ).toEqual({
        ok: true,
        metadata: { repaired: true },
        replacedCorrupt: true,
      });
      expect(await getThreadPluginMetadata(db, thread.id, "p")).toEqual({
        metadata: { repaired: true },
        corrupt: false,
      });
    }
  });

  it.skipIf(isPostgresTest)(
    "rejects a competing file-backed write after the first read while immediate holds the lock",
    async () => {
      const directory = mkdtempSync(
        join(tmpdir(), "bb-thread-plugin-metadata-"),
      );
      const path = join(directory, "db.sqlite");
      const first = await createConnection(path);
      const second = await createConnection(path);
      try {
        await migrate(first);
        const threadId = "thread-concurrency";
        first.$client.pragma("foreign_keys = OFF");
        await first
          .insert(threadPluginMetadata)
          .values({
            threadId,
            pluginId: "p",
            metadataJson: JSON.stringify({ initial: true }),
          })
          .run();
        second.$client.pragma("busy_timeout = 0");
        let secondWrites = 0;
        const secondPatch = async () => {
          secondWrites += 1;
          await expect(
            (async () =>
              await patchThreadPluginMetadata(second, {
                threadId,
                pluginId: "p",
                set: { competing: true },
                remove: [],
              }))(),
          ).rejects.toThrow(/locked|busy/u);
        };
        const transactionProxy = new Proxy(first, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property !== "transaction" || typeof value !== "function") {
              return value;
            }
            return (callback: (tx: unknown) => unknown, options?: unknown) =>
              Reflect.apply(value, target, [
                (tx: unknown) =>
                  callback(withWriteAfterFirstRead(tx as object, secondPatch)),
                options,
              ]);
          },
        });
        expect(
          await patchThreadPluginMetadata(transactionProxy, {
            threadId,
            pluginId: "p",
            set: { first: true },
            remove: [],
          }),
        ).toEqual({
          ok: true,
          metadata: { initial: true, first: true },
          replacedCorrupt: false,
        });
        expect(secondWrites).toBe(1);
        expect(await getThreadPluginMetadata(first, threadId, "p")).toEqual({
          metadata: { initial: true, first: true },
          corrupt: false,
        });
      } finally {
        await first.close();
        await second.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "rolls back thread and search state when initial metadata insertion fails",
    async () => {
      const { db, project } = await setup("rollback");
      await db.$client.exec(`
      CREATE TRIGGER thread_plugin_metadata_before_insert_abort
      BEFORE INSERT ON thread_plugin_metadata
      BEGIN
        SELECT RAISE(ABORT, 'thread plugin metadata insert aborted');
      END;
    `);

      await expect(
        (async () =>
          await createThread(db, noopNotifier, {
            projectId: project.id,
            providerId: "codex",
            title: "rollback-metadata-title",
            pluginMetadata: { pluginId: "alpha", metadata: { seeded: true } },
          }))(),
      ).rejects.toThrow(/thread plugin metadata insert aborted/u);
      expect(
        await db.$client
          .prepare<
            [],
            { count: number }
          >("SELECT COUNT(*) AS count FROM threads WHERE title = 'rollback-metadata-title'")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        await db.$client
          .prepare<
            [],
            { count: number }
          >("SELECT COUNT(*) AS count FROM thread_search_segments WHERE text = 'rollback-metadata-title'")
          .get(),
      ).toEqual({ count: 0 });
    },
  );

  it("keeps metadata out of thread search while retaining title discovery", async () => {
    const { db, project } = await setup("search");
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "discoverable-metadata-title",
      pluginMetadata: {
        pluginId: "alpha",
        metadata: { marker: "metadata-only-search-marker" },
      },
    });
    expect(
      (
        await searchThreadsWithPendingInteractionState(db, {
          query: "discoverable-metadata-title",
          limitPerGroup: 20,
        })
      ).active.results.map((result) => result.thread.id),
    ).toEqual([thread.id]);
    const privateResults = await searchThreadsWithPendingInteractionState(db, {
      query: "metadata-only-search-marker",
      limitPerGroup: 20,
    });
    expect(privateResults.active.total).toBe(0);
    expect(privateResults.archived.total).toBe(0);
  });

  it("cascades metadata when its thread is deleted", async () => {
    const { db, project } = await setup("cascade");
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      pluginMetadata: { pluginId: "p", metadata: { seeded: true } },
    });
    expect(
      await listThreadPluginMetadataRows(db, thread.id, ["p"]),
    ).toHaveLength(1);
    expect(await deleteThread(db, noopNotifier, thread.id)).toBe(true);
    expect(await listThreadPluginMetadataRows(db, thread.id, ["p"])).toEqual(
      [],
    );
  });
});
