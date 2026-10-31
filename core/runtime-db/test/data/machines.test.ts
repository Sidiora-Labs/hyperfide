// Native SQLite snapshots exercise serialize/reopen; portable placement reads run above.
import { isPostgresTest } from "../../src/testing.js";
import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { eq } from "drizzle-orm";
import { createEnvironment } from "../../src/data/environments.js";
import { updateHost, upsertHost } from "../../src/data/hosts.js";
import {
  listProviderMachines,
  machineHasLiveThreadLaunch,
  machineHasPendingThreads,
  machineHasProvisioningEnvironment,
  machineHasStartingThreadLaunch,
} from "../../src/data/machines.js";
import { createProject } from "../../src/data/projects.js";
import { archiveThread, createThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import { environments, threads } from "../../src/schema.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

describe("machine provisioning state", () => {
  it("selects unfinished provider machines through creation, suspension and removal", async () => {
    const { db, host } = await setup();
    try {
      await updateHost(db, noopNotifier, host.id, {
        machineProviderId: "test-machine",
      });
      const other = await upsertHost(db, noopNotifier, {
        name: "other-provider",
      });
      await updateHost(db, noopNotifier, other.id, {
        machineProviderId: "other-machine",
      });
      for (const phase of [
        "creating",
        "active",
        "suspending",
        "suspended",
        "resuming",
        "removing",
      ] as const) {
        await updateHost(db, noopNotifier, host.id, { phase });
        expect(
          (await listProviderMachines(db, "test-machine")).map((row) => row.id),
        ).toEqual([host.id]);
      }
      await updateHost(db, noopNotifier, host.id, { phase: "destroyed" });
      expect(await listProviderMachines(db, "test-machine")).toEqual([]);
      await updateHost(db, noopNotifier, host.id, {
        phase: "active",
        destroyedAt: 1,
      });
      expect(await listProviderMachines(db, "test-machine")).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("distinguishes starting launches from live threads retained until archive", async () => {
    const { db, host, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "starting",
    });
    await updateHost(db, noopNotifier, host.id, { launchKey: thread.id });

    expect(await machineHasLiveThreadLaunch(db, host.id)).toBe(true);
    expect(await machineHasStartingThreadLaunch(db, host.id)).toBe(true);
    for (const status of ["active", "idle", "error"] as const) {
      await db
        .update(threads)
        .set({ status })
        .where(eq(threads.id, thread.id))
        .run();
      expect(await machineHasStartingThreadLaunch(db, host.id)).toBe(false);
      expect(await machineHasLiveThreadLaunch(db, host.id)).toBe(true);
    }
    await archiveThread(db, noopNotifier, thread.id);
    expect(await machineHasLiveThreadLaunch(db, host.id)).toBe(false);
    expect(await machineHasStartingThreadLaunch(db, host.id)).toBe(false);
  });

  it("finds a provisioning environment on the host until it is ready", async () => {
    const { db, host, project } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/environment",
      providerOwnsPath: false,
      status: "provisioning",
      environmentProvider: null,
    });

    expect(await machineHasProvisioningEnvironment(db, host.id)).toBe(true);
    await db
      .update(environments)
      .set({ status: "ready" })
      .where(eq(environments.id, environment.id))
      .run();
    expect(await machineHasProvisioningEnvironment(db, host.id)).toBe(false);
  });
});

describe("pending machine ownership", () => {
  it.skipIf(isPostgresTest).each(["pending", "provisioning"] as const)(
    "retains persisted %s placement after reloading the database",
    async (kind) => {
      const { db, host, project } = await setup();
      try {
        const thread = await createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
          status: kind === "pending" ? "pending" : "starting",
        });
        const environmentIntent = {
          type: "provider",
          machine: { type: "existing", hostId: host.id },
        };
        await db
          .update(threads)
          .set({
            startupContext: JSON.stringify(
              kind === "pending"
                ? { kind, environmentIntent }
                : { kind, request: { environmentIntent } },
            ),
          })
          .where(eq(threads.id, thread.id))
          .run();
        const restored = await createConnection(db.$client.serialize());
        try {
          expect(await machineHasPendingThreads(restored, host.id)).toBe(true);
          expect(
            await machineHasPendingThreads(restored, "different-host"),
          ).toBe(false);
          for (const patch of [
            { status: "error" },
            { status: "idle" },
            { archivedAt: 1 },
            { deletedAt: 1 },
          ] as const) {
            await restored
              .update(threads)
              .set({
                status: kind === "pending" ? "pending" : "starting",
                archivedAt: null,
                deletedAt: null,
                ...patch,
              })
              .where(eq(threads.id, thread.id))
              .run();
            expect(await machineHasPendingThreads(restored, host.id)).toBe(
              false,
            );
          }
        } finally {
          await restored.close();
        }
      } finally {
        await db.close();
      }
    },
  );

  it("retains a preparing owner through ready-before-attachment but releases orphan or cancelled preparation", async () => {
    const { db, host, project } = await setup();
    try {
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "starting",
      });
      const environment = await createEnvironment(db, noopNotifier, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/preparing",
        status: "provisioning",
        providerOwnsPath: false,
        environmentProvider: null,
      });
      await db
        .update(environments)
        .set({ ownerThreadId: thread.id })
        .where(eq(environments.id, environment.id))
        .run();
      for (const status of ["creating", "provisioning", "ready"] as const) {
        await db
          .update(environments)
          .set({ status })
          .where(eq(environments.id, environment.id))
          .run();
        expect(await machineHasPendingThreads(db, host.id)).toBe(true);
      }
      await db
        .update(environments)
        .set({ teardownStatus: "running" })
        .where(eq(environments.id, environment.id))
        .run();
      expect(await machineHasPendingThreads(db, host.id)).toBe(false);
      await db
        .update(environments)
        .set({ teardownStatus: null })
        .where(eq(environments.id, environment.id))
        .run();
      for (const patch of [
        { status: "pending" },
        { status: "error" },
        { status: "idle" },
        { archivedAt: 1 },
        { deletedAt: 1 },
      ] as const) {
        await db
          .update(threads)
          .set({
            status: "starting",
            archivedAt: null,
            deletedAt: null,
            ...patch,
          })
          .where(eq(threads.id, thread.id))
          .run();
        expect(await machineHasPendingThreads(db, host.id)).toBe(false);
      }
      await db.delete(threads).where(eq(threads.id, thread.id)).run();
      expect(await machineHasPendingThreads(db, host.id)).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("finds an unattached pending reuse intent without retaining failed or destroyed workspaces", async () => {
    const { db, host, project } = await setup();
    try {
      const environment = await createEnvironment(db, noopNotifier, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/reuse",
        status: "ready",
        providerOwnsPath: false,
        environmentProvider: null,
      });
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "pending",
      });
      await db
        .update(threads)
        .set({
          startupContext: JSON.stringify({
            kind: "pending",
            environmentIntent: { type: "reuse", environmentId: environment.id },
          }),
        })
        .where(eq(threads.id, thread.id))
        .run();
      expect(await machineHasPendingThreads(db, host.id)).toBe(true);
      const oldHost = await upsertHost(db, noopNotifier, {
        name: "previous-host",
      });
      const oldEnvironment = await createEnvironment(db, noopNotifier, {
        projectId: project.id,
        hostId: oldHost.id,
        path: "/tmp/old",
        status: "ready",
        providerOwnsPath: false,
        environmentProvider: null,
      });
      await db
        .update(environments)
        .set({ ownerThreadId: thread.id })
        .where(eq(environments.id, oldEnvironment.id))
        .run();
      expect(await machineHasPendingThreads(db, oldHost.id)).toBe(false);
      for (const status of ["error", "destroyed"] as const) {
        await db
          .update(environments)
          .set({ status })
          .where(eq(environments.id, environment.id))
          .run();
        expect(await machineHasPendingThreads(db, host.id)).toBe(false);
      }
    } finally {
      await db.close();
    }
  });
});
