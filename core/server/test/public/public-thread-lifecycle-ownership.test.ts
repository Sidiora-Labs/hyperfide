import { archiveEnvironmentThreads } from "../../src/services/threads/thread-archive.js";
import {
  beginProjectDeletion,
  advanceProjectDeletion,
} from "../../src/services/projects/project-deletion.js";
import {
  archiveThread,
  markThreadDeleted,
  getThread,
  getProject,
} from "@hyperfide/db";
import { describe, expect, it, vi } from "vitest";
import { reconcileDaemonReportedThreads } from "../../src/services/threads/thread-lifecycle.js";
import { runThreadLifecycleSweep } from "../../src/services/system/periodic-sweeps.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  expireArchiveUndoGrace,
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";

async function remove(harness: TestAppHarness, id: string) {
  return harness.app.request(`/api/v1/threads/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ childThreadsConfirmed: true }),
  });
}

describe("lifecycle ownership deletion", () => {
  it.each(["parentThreadId", "lifecycleOwnerThreadId"] as const)(
    "durably marks nested %s descendants before effects and recovers after interruption",
    async (relationship) => {
      await withTestHarness(async (harness) => {
        const { host } = await seedHostSession(harness.deps);
        const { project } = await seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const owner = await seedThread(harness.deps, { projectId: project.id });
        const child = await seedThread(harness.deps, {
          projectId: project.id,
          [relationship]: owner.id,
        });
        const nested = await seedThread(harness.deps, {
          projectId: project.id,
          lifecycleOwnerThreadId: child.id,
        });
        const hidden = await seedThread(harness.deps, {
          projectId: project.id,
          parentThreadId: nested.id,
          visibility: "hidden",
        });
        await archiveThread(harness.db, harness.deps.hub, nested.id);
        await archiveThread(harness.db, harness.deps.hub, hidden.id);
        const descendants = [owner, child, nested, hidden];
        const close = vi
          .spyOn(harness.deps.terminalSessions, "closeDeletedThreadTerminals")
          .mockImplementationOnce(() => {
            throw new Error("Interrupted");
          });
        expect((await remove(harness, owner.id)).status).toBe(500);
        close.mockRestore();
        for (const thread of descendants)
          expect((await getThread(harness.db, thread.id))?.deletedAt).toEqual(
            expect.any(Number),
          );
        expect(
          (await getThread(harness.db, nested.id))?.lifecycleOwnerThreadId,
        ).toBe(child.id);
        for (let i = 0; i < 3; i++) await runThreadLifecycleSweep(harness.deps);
        for (const thread of descendants)
          expect(await getThread(harness.db, thread.id)).toBeNull();
      });
    },
  );

  it.each([false, true])(
    "retains owner until active cross-host dependent storage is deleted (archived: %s)",
    async (archived) => {
      await withTestHarness(async (harness) => {
        const { host } = await seedHostSession(harness.deps);
        const { project } = await seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const other = (await seedHostSession(harness.deps)).host;
        const otherProject = (
          await seedProjectWithSource(harness.deps, {
            hostId: other.id,
          })
        ).project;
        const environment = await seedEnvironment(harness.deps, {
          hostId: other.id,
          projectId: otherProject.id,
        });
        const owner = await seedThread(harness.deps, { projectId: project.id });
        const child = await seedThread(harness.deps, {
          projectId: otherProject.id,
          lifecycleOwnerThreadId: owner.id,
          environmentId: environment.id,
          status: "active",
        });
        await seedThreadRuntimeState(harness.deps, {
          environmentId: environment.id,
          threadId: child.id,
          providerThreadId: "dependent",
        });
        const nested = await seedThread(harness.deps, {
          projectId: project.id,
          lifecycleOwnerThreadId: child.id,
        });
        const independent = await seedThread(harness.deps, {
          projectId: project.id,
          sourceThreadId: owner.id,
          visibility: "hidden",
        });
        const sidebar = await seedThread(harness.deps, {
          projectId: project.id,
          parentThreadId: owner.id,
        });
        if (archived)
          await archiveThread(harness.db, harness.deps.hub, child.id);
        expect((await remove(harness, owner.id)).status).toBe(200);
        expect(await getThread(harness.db, nested.id)).toBeNull();
        expect((await getThread(harness.db, owner.id))?.deletedAt).toEqual(
          expect.any(Number),
        );
        expect(
          (await getThread(harness.db, child.id))?.lifecycleOwnerThreadId,
        ).toBe(owner.id);
        const command = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.storage.delete" &&
            command.threadId === child.id,
        );
        await reportQueuedCommandError(harness, command, {
          errorCode: "temporary_failure",
          errorMessage: "Disconnected",
        });
        expect(
          (await getThread(harness.db, child.id))?.lifecycleOwnerThreadId,
        ).toBe(owner.id);
        await reconcileDaemonReportedThreads(harness.deps, {
          hostId: other.id,
          activeThreadIds: [child.id],
          undeliveredEventThreadIds: [],
          sameDaemonInstance: false,
        });
        const retry = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.storage.delete" &&
            command.threadId === child.id,
        );
        await reportQueuedCommandSuccess(harness, retry, {
          providerCheckpointId: null,
        });
        await runThreadLifecycleSweep(harness.deps);
        expect(await getThread(harness.db, owner.id)).toBeNull();
        expect(await getThread(harness.db, child.id)).toBeNull();
        expect(await getThread(harness.db, sidebar.id)).toBeNull();
        expect(await getThread(harness.db, independent.id)).toMatchObject({
          archivedAt: null,
          deletedAt: null,
          lifecycleOwnerThreadId: null,
        });
      });
    },
  );
});

describe("cross-project lifecycle ownership", () => {
  it.each(["owner", "dependent"] as const)(
    "deleting the %s project follows ownership only downward",
    async (target) => {
      await withTestHarness(async (harness) => {
        const { host } = await seedHostSession(harness.deps);
        const ownerProject = (
          await seedProjectWithSource(harness.deps, {
            hostId: host.id,
            path: "/tmp/owner-project",
          })
        ).project;
        const dependentProject = (
          await seedProjectWithSource(harness.deps, {
            hostId: host.id,
            path: "/tmp/dependent-project",
          })
        ).project;
        const owner = await seedThread(harness.deps, {
          projectId: ownerProject.id,
        });
        const child = await seedThread(harness.deps, {
          projectId: dependentProject.id,
          lifecycleOwnerThreadId: owner.id,
        });
        const nested = await seedThread(harness.deps, {
          projectId: ownerProject.id,
          lifecycleOwnerThreadId: child.id,
        });
        const independent = await seedThread(harness.deps, {
          projectId: dependentProject.id,
        });
        const projectId =
          target === "owner" ? ownerProject.id : dependentProject.id;
        await beginProjectDeletion(harness.deps, { projectId });
        for (let i = 0; i < 3; i++) {
          await runThreadLifecycleSweep(harness.deps);
          await advanceProjectDeletion(harness.deps, { projectId });
        }
        expect(await getProject(harness.db, projectId)).toBeNull();
        expect(await getThread(harness.db, child.id)).toBeNull();
        expect(await getThread(harness.db, nested.id)).toBeNull();
        if (target === "owner") {
          expect(await getThread(harness.db, owner.id)).toBeNull();
          expect(
            (await getThread(harness.db, independent.id))?.deletedAt,
          ).toBeNull();
          expect(
            (await getProject(harness.db, dependentProject.id))?.deletedAt,
          ).toBeNull();
        } else {
          expect((await getThread(harness.db, owner.id))?.deletedAt).toBeNull();
          expect(
            (await getProject(harness.db, ownerProject.id))?.deletedAt,
          ).toBeNull();
        }
      });
    },
  );

  it("archives cross-project dependents and requires explicit owner-first unarchive", async () => {
    await withTestHarness(async (harness) => {
      const { host } = await seedHostSession(harness.deps);
      const ownerProject = (
        await seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/archive-owner",
        })
      ).project;
      const dependentProject = (
        await seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/archive-dependent",
        })
      ).project;
      const owner = await seedThread(harness.deps, {
        projectId: ownerProject.id,
      });
      const child = await seedThread(harness.deps, {
        projectId: dependentProject.id,
        lifecycleOwnerThreadId: owner.id,
      });
      const post = (id: string, action: string) =>
        harness.app.request(`/api/v1/threads/${id}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      expect((await post(owner.id, "archive-all")).status).toBe(200);
      expect((await getThread(harness.db, child.id))?.archivedAt).toEqual(
        expect.any(Number),
      );
      expect((await post(child.id, "unarchive")).status).toBe(409);
      expect((await post(owner.id, "unarchive")).status).toBe(200);
      expect((await getThread(harness.db, child.id))?.archivedAt).toEqual(
        expect.any(Number),
      );
      expect((await post(child.id, "unarchive")).status).toBe(200);
    });
  });
});

it("environment archival stops cross-environment lifecycle dependents on their own host", async () => {
  await withTestHarness(async (harness) => {
    const first = (await seedHostSession(harness.deps)).host;
    const second = (await seedHostSession(harness.deps)).host;
    const { project } = await seedProjectWithSource(harness.deps, {
      hostId: first.id,
    });
    const ownerEnvironment = await seedEnvironment(harness.deps, {
      hostId: first.id,
      projectId: project.id,
    });
    const childEnvironment = await seedEnvironment(harness.deps, {
      hostId: second.id,
      projectId: project.id,
    });
    const owner = await seedThread(harness.deps, {
      projectId: project.id,
      environmentId: ownerEnvironment.id,
    });
    const child = await seedThread(harness.deps, {
      projectId: project.id,
      environmentId: childEnvironment.id,
      lifecycleOwnerThreadId: owner.id,
      status: "active",
    });
    await seedThreadRuntimeState(harness.deps, {
      threadId: child.id,
      environmentId: childEnvironment.id,
      providerThreadId: "dependent-archive",
    });
    const sidebarChild = await seedThread(harness.deps, {
      projectId: project.id,
      parentThreadId: child.id,
      environmentId: childEnvironment.id,
    });
    const hiddenFork = await seedThread(harness.deps, {
      projectId: project.id,
      sourceThreadId: child.id,
      originKind: "fork",
      visibility: "hidden",
      environmentId: childEnvironment.id,
    });
    const deleted = await seedThread(harness.deps, {
      projectId: project.id,
      lifecycleOwnerThreadId: child.id,
      environmentId: childEnvironment.id,
    });
    await markThreadDeleted(harness.db, harness.deps.hub, {
      threadId: deleted.id,
      deletedAt: 100,
    });
    const archivedIds = await archiveEnvironmentThreads(harness.deps, {
      environment: ownerEnvironment,
    });
    expect(archivedIds).toEqual(
      expect.arrayContaining([sidebarChild.id, hiddenFork.id]),
    );
    expect(archivedIds).not.toContain(deleted.id);
    expect(await getThread(harness.db, deleted.id)).toMatchObject({
      deletedAt: 100,
      archivedAt: null,
    });
    for (const descendant of [sidebarChild, hiddenFork])
      expect((await getThread(harness.db, descendant.id))?.archivedAt).toEqual(
        expect.any(Number),
      );
    expect((await getThread(harness.db, child.id))?.archivedAt).toEqual(
      expect.any(Number),
    );
    await expireArchiveUndoGrace(harness.deps, child.id);
    await runThreadLifecycleSweep(harness.deps);
    const command = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.stop" && command.threadId === child.id,
    );
    expect(command.command).toMatchObject({
      environmentId: childEnvironment.id,
    });
    await reportQueuedCommandSuccess(harness, command, {
      providerCheckpointId: null,
    });
    expect((await getThread(harness.db, child.id))?.status).toBe("idle");
  });
});

it("recovers archived active threads through the periodic sweep", async () => {
  await withTestHarness(async (harness) => {
    const { host } = await seedHostSession(harness.deps);
    const { project } = await seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = await seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const thread = await seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      status: "active",
    });
    await seedThreadRuntimeState(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "sweep-recovery",
    });
    await archiveThread(harness.db, harness.deps.hub, thread.id);
    await runThreadLifecycleSweep(harness.deps);
    expect((await getThread(harness.db, thread.id))?.status).toBe("active");
    await expireArchiveUndoGrace(harness.deps, thread.id);
    await runThreadLifecycleSweep(harness.deps);
    const command = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.stop" && command.threadId === thread.id,
    );
    await reportQueuedCommandSuccess(harness, command, {
      providerCheckpointId: null,
    });
    expect(await getThread(harness.db, thread.id)).toMatchObject({
      status: "idle",
      archivedAt: expect.any(Number),
    });
  });
});

it("keeps an owning project pending while cross-project host cleanup fails and completes after reconnect", async () => {
  await withTestHarness(async (harness) => {
    const { host } = await seedHostSession(harness.deps);
    const remote = (await seedHostSession(harness.deps)).host;
    const ownerProject = (
      await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      })
    ).project;
    const dependentProject = (
      await seedProjectWithSource(harness.deps, {
        hostId: remote.id,
        path: "/tmp/offline-dependent",
      })
    ).project;
    const environment = await seedEnvironment(harness.deps, {
      hostId: remote.id,
      projectId: dependentProject.id,
    });
    const owner = await seedThread(harness.deps, {
      projectId: ownerProject.id,
    });
    const child = await seedThread(harness.deps, {
      projectId: dependentProject.id,
      environmentId: environment.id,
      lifecycleOwnerThreadId: owner.id,
      status: "active",
    });
    await seedThreadRuntimeState(harness.deps, {
      threadId: child.id,
      environmentId: environment.id,
      providerThreadId: "project-cleanup",
    });
    await beginProjectDeletion(harness.deps, { projectId: ownerProject.id });
    const command = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.storage.delete" &&
        command.threadId === child.id,
    );
    await reportQueuedCommandError(harness, command, {
      errorCode: "temporary_failure",
      errorMessage: "Host disconnected",
    });
    expect((await getProject(harness.db, ownerProject.id))?.deletedAt).toEqual(
      expect.any(Number),
    );
    expect((await getThread(harness.db, owner.id))?.deletedAt).toEqual(
      expect.any(Number),
    );
    expect(await getThread(harness.db, child.id)).toMatchObject({
      lifecycleOwnerThreadId: owner.id,
      deletedAt: expect.any(Number),
      storageDeletedAt: null,
    });
    await reconcileDaemonReportedThreads(harness.deps, {
      hostId: remote.id,
      activeThreadIds: [child.id],
      undeliveredEventThreadIds: [],
      sameDaemonInstance: false,
    });
    const retry = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.storage.delete" &&
        command.threadId === child.id,
    );
    await reportQueuedCommandSuccess(harness, retry, {
      providerCheckpointId: null,
    });
    await runThreadLifecycleSweep(harness.deps);
    await advanceProjectDeletion(harness.deps, { projectId: ownerProject.id });
    expect(await getProject(harness.db, ownerProject.id)).toBeNull();
    expect(await getThread(harness.db, child.id)).toBeNull();
    expect(
      (await getProject(harness.db, dependentProject.id))?.deletedAt,
    ).toBeNull();
  });
});
