// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../../src/testing.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { threads } from "../../src/schema.js";
import { noopNotifier as hub } from "../../src/notifier.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import {
  createThread,
  archiveThread,
  unarchiveThread,
  markThreadDeleted,
  deleteThread,
  getThread,
} from "../../src/data/threads.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, hub, { name: "host" });
  const { project } = await createProject(db, hub, {
    name: "project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/ownership" },
  });
  const spawn = async (lifecycleOwnerThreadId?: string) =>
    await createThread(db, hub, {
      projectId: project.id,
      providerId: "test",
      lifecycleOwnerThreadId,
      status: "idle",
    });
  return { db, project, host, spawn };
}

describe("lifecycle ownership", () => {
  it("cascades through archived intermediates while preserving ownership and history until leaf deletion", async () => {
    const { db, spawn } = await setup();
    const owner = await spawn();
    const child = await spawn(owner.id);
    const leaf = await spawn(child.id);
    const independent = await spawn();
    await archiveThread(db, hub, child.id);
    expect((await getThread(db, owner.id))?.archivedAt).toBeNull();
    await archiveThread(db, hub, owner.id);
    for (const thread of [owner, child, leaf])
      expect((await getThread(db, thread.id))?.archivedAt).toEqual(
        expect.any(Number),
      );
    expect(await unarchiveThread(db, hub, leaf.id)).toBeNull();
    await unarchiveThread(db, hub, owner.id);
    expect((await getThread(db, child.id))?.archivedAt).toEqual(
      expect.any(Number),
    );
    await unarchiveThread(db, hub, child.id);
    expect((await unarchiveThread(db, hub, leaf.id))?.archivedAt).toBeNull();
    await markThreadDeleted(db, hub, { threadId: owner.id });
    expect(await deleteThread(db, hub, owner.id)).toBe(false);
    await expect(
      (async () =>
        await db.delete(threads).where(eq(threads.id, owner.id)).run())(),
    ).rejects.toThrow();
    expect((await getThread(db, child.id))?.lifecycleOwnerThreadId).toBe(
      owner.id,
    );
    expect(await deleteThread(db, hub, child.id)).toBe(false);
    expect(await deleteThread(db, hub, leaf.id)).toBe(true);
    expect(await deleteThread(db, hub, child.id)).toBe(true);
    expect(await deleteThread(db, hub, owner.id)).toBe(true);
    expect((await getThread(db, independent.id))?.deletedAt).toBeNull();
  });

  it("rejects unavailable owners and accepts cross-project owners", async () => {
    const { db, spawn, project, host } = await setup();
    await expect((async () => await spawn("missing"))()).rejects.toThrow(
      /lifecycleOwner/,
    );
    const owner = await spawn();
    await archiveThread(db, hub, owner.id);
    await expect((async () => await spawn(owner.id))()).rejects.toThrow(
      /lifecycleOwner/,
    );
    await unarchiveThread(db, hub, owner.id);
    await markThreadDeleted(db, hub, { threadId: owner.id });
    await expect((async () => await spawn(owner.id))()).rejects.toThrow(
      /lifecycleOwner/,
    );
    const live = await spawn();
    const other = (
      await createProject(db, hub, {
        name: "other",
        source: { type: "local_path", hostId: host.id, path: "/tmp/other" },
      })
    ).project;
    expect(other.id).not.toBe(project.id);
    const dependent = await createThread(db, hub, {
      projectId: other.id,
      providerId: "test",
      lifecycleOwnerThreadId: live.id,
    });
    await archiveThread(db, hub, live.id);
    expect((await getThread(db, dependent.id))?.archivedAt).toEqual(
      expect.any(Number),
    );
    await markThreadDeleted(db, hub, { threadId: live.id });
    expect((await getThread(db, dependent.id))?.deletedAt).toEqual(
      expect.any(Number),
    );
  });

  it("preserves earlier archive/delete timestamps and skips deleted rows during archive", async () => {
    const { db, spawn } = await setup();
    const owner = await spawn();
    const archived = await spawn(owner.id);
    const deleted = await spawn(owner.id);
    await db
      .update(threads)
      .set({ archivedAt: 100, updatedAt: 100 })
      .where(eq(threads.id, archived.id))
      .run();
    await markThreadDeleted(db, hub, { threadId: deleted.id, deletedAt: 200 });
    await archiveThread(db, hub, owner.id);
    expect((await getThread(db, archived.id))?.archivedAt).toBe(100);
    expect((await getThread(db, deleted.id))?.archivedAt).toBeNull();
    await markThreadDeleted(db, hub, { threadId: owner.id, deletedAt: 300 });
    expect((await getThread(db, deleted.id))?.deletedAt).toBe(200);
    expect((await getThread(db, archived.id))?.deletedAt).toBe(300);
  });
});

it.skipIf(isPostgresTest)(
  "leaves existing helpers unowned and preserves their state during migration",
  async () => {
    const { db, spawn, project } = await setup();
    const owner = await spawn();
    const side = await createThread(db, hub, {
      projectId: project.id,
      providerId: "test",
      sourceThreadId: owner.id,
      originKind: "fork",
      originPluginId: "side-chat",
      visibility: "hidden",
    });
    const unknown = await createThread(db, hub, {
      projectId: project.id,
      providerId: "test",
      sourceThreadId: owner.id,
      originKind: "fork",
      visibility: "hidden",
      title: "side-chat",
    });
    const worker = await createThread(db, hub, {
      projectId: project.id,
      providerId: "test",
      originPluginId: "workflows",
      pluginMetadata: {
        pluginId: "workflows",
        metadata: {
          workflowWorker: 1,
          runId: "run",
          callId: "call",
          originThreadId: owner.id,
        },
      },
    });
    await db
      .update(threads)
      .set({ createdAt: 1, deletedAt: 2, archivedAt: 2 })
      .where(eq(threads.id, owner.id))
      .run();
    const migration = readFileSync(
      new URL("../../drizzle/0121_fluffy_major_mapleleaf.sql", import.meta.url),
      "utf8",
    );
    const before = await db.$client
      .prepare("SELECT * FROM threads ORDER BY id")
      .all();
    await db.$client.exec(`
    DROP INDEX threads_lifecycle_owner_idx;
    ALTER TABLE threads DROP COLUMN lifecycle_owner_thread_id;
  `);
    await db.$client.exec(migration);
    expect(
      await db.$client.prepare("SELECT * FROM threads ORDER BY id").all(),
    ).toEqual(before);
    for (const child of [side, worker, unknown])
      expect(await getThread(db, child.id)).toMatchObject({
        lifecycleOwnerThreadId: null,
        deletedAt: null,
        archivedAt: null,
      });
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  },
);
