import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  createThread,
  listRunningThreads,
  markThreadDeleted,
} from "../../src/data/threads.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const hostA = await upsertHost(db, noopNotifier, {
    name: "host-a",
  });
  const hostB = await upsertHost(db, noopNotifier, {
    name: "host-b",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "project-a",
    source: { type: "local_path", hostId: hostA.id, path: "/tmp/a" },
  });
  const environmentA = await createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    hostId: hostA.id,
    projectId: project.id,
    path: "/tmp/a",
  });
  const environmentB = await createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    hostId: hostB.id,
    projectId: project.id,
    path: "/tmp/b",
  });
  return { db, environmentA, environmentB, hostA, hostB, project };
}

describe("listRunningThreads", () => {
  it("returns only the statuses that occupy capacity", async () => {
    const { db, environmentA, project } = await setup();
    const ids = new Map<string, string>();
    for (const status of [
      "pending",
      "idle",
      "starting",
      "active",
      "stopping",
      "error",
    ] as const) {
      ids.set(
        status,
        (
          await createThread(db, noopNotifier, {
            environmentId: environmentA.id,
            projectId: project.id,
            providerId: "codex",
            status,
          })
        ).id,
      );
    }

    // `idle` is the one that is easy to get wrong: the thread has a live
    // session but is consuming nothing, so it holds no slot.
    expect((await listRunningThreads(db)).map((row) => row.id).sort()).toEqual(
      [ids.get("starting")!, ids.get("active")!].sort(),
    );
  });

  it("excludes archived and deleted threads but keeps hidden ones", async () => {
    const { db, environmentA, project } = await setup();
    const make = async (visibility: "visible" | "hidden" = "visible") =>
      await createThread(db, noopNotifier, {
        environmentId: environmentA.id,
        projectId: project.id,
        providerId: "codex",
        status: "active",
        visibility,
      });
    const live = await make();
    const hidden = await make("hidden");
    const archived = await make();
    const deleted = await make();
    await archiveThread(db, noopNotifier, archived.id);
    await markThreadDeleted(db, noopNotifier, { threadId: deleted.id });

    // A hidden thread burns a real slot on a real machine, so hiding it here
    // would under-report occupancy; archival and deletion actually stop one.
    expect((await listRunningThreads(db)).map((row) => row.id).sort()).toEqual(
      [live.id, hidden.id].sort(),
    );
  });

  it("resolves the host through the thread's environment, null when it has none", async () => {
    const { db, environmentA, environmentB, hostA, hostB, project } =
      await setup();
    const onA = await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });
    const onB = await createThread(db, noopNotifier, {
      environmentId: environmentB.id,
      projectId: project.id,
      providerId: "codex",
      status: "starting",
    });
    // A thread admitted but not yet provisioned: counts globally, on no host.
    const unplaced = await createThread(db, noopNotifier, {
      environmentId: null,
      projectId: project.id,
      providerId: "codex",
      status: "starting",
    });

    const byId = new Map(
      (await listRunningThreads(db)).map((row) => [row.id, row.hostId]),
    );
    expect(byId.get(onA.id)).toBe(hostA.id);
    expect(byId.get(onB.id)).toBe(hostB.id);
    expect(byId.get(unplaced.id)).toBeNull();
  });

  it("counts child and plugin-spawned threads like any other", async () => {
    // Occupancy is about slots, not provenance: a child thread and a
    // plugin-spawned one each burn a real slot on a real machine, so a row
    // that hid them would under-report what is running.
    const { db, environmentA, project } = await setup();
    const parent = await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });
    const child = await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
      parentThreadId: parent.id,
    });
    const spawned = await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
      originPluginId: "workflows",
    });

    expect((await listRunningThreads(db)).map((row) => row.id).sort()).toEqual(
      [parent.id, child.id, spawned.id].sort(),
    );
  });
});
