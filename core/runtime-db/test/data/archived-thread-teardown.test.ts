import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createTerminalSession } from "../../src/data/terminal-sessions.js";
import {
  archiveThread,
  createThread,
  listArchivedThreadsPendingTeardown,
} from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import { threads } from "../../src/schema.js";
import { createMigratedConnection } from "../../src/testing.js";
import type { ThreadStatus } from "@hyperfide/domain";
import type { TerminalSessionStatus } from "@hyperfide/domain";

async function setup(status: ThreadStatus) {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const environment = await createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/environment",
    providerOwnsPath: false,
    status: "ready",
    environmentProvider: null,
  });
  const thread = await createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    environmentId: environment.id,
    status,
  });
  return { db, environment, host, thread };
}

async function seedTerminal(
  db: Awaited<ReturnType<typeof createMigratedConnection>>,
  args: {
    environmentId: string;
    hostId: string;
    status: TerminalSessionStatus;
    threadId: string;
  },
) {
  return await createTerminalSession(db, {
    cols: 80,
    daemonSessionId: null,
    environmentId: args.environmentId,
    hostId: args.hostId,
    initialCwd: "/tmp/environment",
    rows: 24,
    status: args.status,
    threadId: args.threadId,
    title: "dev server",
  });
}

describe("listArchivedThreadsPendingTeardown", () => {
  it("returns an archived thread whose status still holds host work", async () => {
    const { db, environment, host, thread } = await setup("active");

    expect(await listArchivedThreadsPendingTeardown(db)).toEqual([]);

    await archiveThread(db, noopNotifier, thread.id);

    expect(await listArchivedThreadsPendingTeardown(db)).toMatchObject([
      { id: thread.id, status: "active" },
    ]);
    for (const status of ["starting", "running", "disconnected"] as const) {
      await seedTerminal(db, {
        environmentId: environment.id,
        hostId: host.id,
        status,
        threadId: thread.id,
      });
    }
    expect(await listArchivedThreadsPendingTeardown(db)).toMatchObject([
      { id: thread.id, status: "active" },
    ]);
    await db
      .update(threads)
      .set({ deletedAt: 1 })
      .where(eq(threads.id, thread.id))
      .run();
    expect(await listArchivedThreadsPendingTeardown(db)).toEqual([]);
  });

  it.each(["starting", "running", "disconnected"] as const)(
    "returns an archived idle thread only while a terminal session is %s",
    async (status) => {
      const { db, environment, host, thread } = await setup("active");
      const terminal = await seedTerminal(db, {
        environmentId: environment.id,
        hostId: host.id,
        status,
        threadId: thread.id,
      });
      await archiveThread(db, noopNotifier, thread.id);
      await db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, thread.id))
        .run();

      expect(await listArchivedThreadsPendingTeardown(db)).toMatchObject([
        { id: thread.id, status: "idle" },
      ]);

      await db.update(threads).set({ status: "idle" }).run();
      await seedTerminal(db, {
        environmentId: environment.id,
        hostId: host.id,
        status: "exited",
        threadId: thread.id,
      });
      expect(await listArchivedThreadsPendingTeardown(db)).toMatchObject([
        { id: thread.id },
      ]);

      await db.update(threads).set({ archivedAt: null }).run();
      expect(await listArchivedThreadsPendingTeardown(db)).toEqual([]);

      await archiveThread(db, noopNotifier, thread.id);
      expect(await listArchivedThreadsPendingTeardown(db)).toMatchObject([
        { id: terminal.threadId },
      ]);
    },
  );

  it("skips an archived idle thread with no open terminal session", async () => {
    const { db, environment, host, thread } = await setup("active");
    await seedTerminal(db, {
      environmentId: environment.id,
      hostId: host.id,
      status: "exited",
      threadId: thread.id,
    });
    await archiveThread(db, noopNotifier, thread.id);
    await db
      .update(threads)
      .set({ status: "idle" })
      .where(eq(threads.id, thread.id))
      .run();

    expect(await listArchivedThreadsPendingTeardown(db)).toEqual([]);
  });
});
