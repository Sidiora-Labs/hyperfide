import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  countThreads,
  createThread,
  markThreadDeleted,
} from "../../src/data/threads.js";
import { createMigratedConnection } from "../../src/testing.js";

/**
 * Two hosts, two projects and threads spread across both, so every grouping
 * has more than one bucket and a filter that ignored its argument would show.
 */
async function setup() {
  const db = await createMigratedConnection();
  const hostA = await upsertHost(db, noopNotifier, {
    name: "host-a",
  });
  const hostB = await upsertHost(db, noopNotifier, {
    name: "host-b",
  });
  const { project: projectA } = await createProject(db, noopNotifier, {
    name: "project-a",
    source: { type: "local_path", hostId: hostA.id, path: "/tmp/a" },
  });
  const { project: projectB } = await createProject(db, noopNotifier, {
    name: "project-b",
    source: { type: "local_path", hostId: hostB.id, path: "/tmp/b" },
  });
  const environmentA = await createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    hostId: hostA.id,
    projectId: projectA.id,
    path: "/tmp/a",
  });
  const environmentB = await createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    hostId: hostB.id,
    projectId: projectB.id,
    path: "/tmp/b",
  });
  return { db, environmentA, environmentB, hostA, hostB, projectA, projectB };
}

describe("countThreads", () => {
  it("counts live visible threads and excludes archived and deleted ones", async () => {
    const { db, environmentA, projectA } = await setup();
    const live = await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    const archived = await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    const deleted = await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    const hidden = await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
      visibility: "hidden",
    });
    await archiveThread(db, noopNotifier, archived.id);
    await markThreadDeleted(db, noopNotifier, { threadId: deleted.id });

    expect(await countThreads(db, {})).toEqual({ total: 1 });
    // Archived rows are countable on request; deleted ones never are.
    expect(await countThreads(db, { includeArchived: true })).toEqual({
      total: 2,
    });
    expect(await countThreads(db, { includeHidden: true })).toEqual({
      total: 2,
    });
    expect(
      await countThreads(db, { includeArchived: true, includeHidden: true }),
    ).toEqual({ total: 3 });
    expect((await countThreads(db, { status: "active" })).total).toBe(1);
    expect((await countThreads(db, { status: "idle" })).total).toBe(0);
    expect(live.id).not.toBe(hidden.id);
  });

  it("groups by host, provider and project", async () => {
    const { db, environmentA, environmentB, hostA, hostB, projectA, projectB } =
      await setup();
    await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "claude-code",
      status: "active",
    });
    await createThread(db, noopNotifier, {
      environmentId: environmentB.id,
      projectId: projectB.id,
      providerId: "codex",
      status: "active",
    });
    // A thread with no environment yet — the case a host grouping has to place
    // somewhere rather than drop.
    await createThread(db, noopNotifier, {
      environmentId: null,
      projectId: projectA.id,
      providerId: "codex",
      status: "starting",
    });

    const byHost = await countThreads(db, { groupBy: "host" });
    expect(byHost.total).toBe(4);
    expect(byKey(byHost.groups)).toEqual({
      "<none>": 1,
      [hostA.id]: 2,
      [hostB.id]: 1,
    });

    const byProvider = await countThreads(db, { groupBy: "provider" });
    expect(byKey(byProvider.groups)).toEqual({ "claude-code": 1, codex: 3 });

    const byProject = await countThreads(db, { groupBy: "project" });
    expect(byKey(byProject.groups)).toEqual({
      [projectA.id]: 3,
      [projectB.id]: 1,
    });
  });

  it("filters by host through the environment join", async () => {
    const { db, environmentA, environmentB, hostA, projectA, projectB } =
      await setup();
    await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    await createThread(db, noopNotifier, {
      environmentId: environmentB.id,
      projectId: projectB.id,
      providerId: "codex",
      status: "active",
    });

    expect(await countThreads(db, { hostId: hostA.id })).toEqual({ total: 1 });
    expect(await countThreads(db, { hostId: "host_missing" })).toEqual({
      total: 0,
    });
  });

  it("distinguishes root threads from a named parent and from no filter", async () => {
    const { db, environmentA, projectA } = await setup();
    const root = await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      parentThreadId: root.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    await createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      parentThreadId: root.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });

    // Three states, three answers — this is what the route's "none" sentinel
    // buys over an empty-string parameter.
    expect((await countThreads(db, {})).total).toBe(3);
    expect((await countThreads(db, { parent: { kind: "root" } })).total).toBe(
      1,
    );
    expect(
      (
        await countThreads(db, {
          parent: { kind: "id", parentThreadId: root.id },
        })
      ).total,
    ).toBe(2);
  });
});

/** Group ids are random, so compare as a keyed map rather than an ordered list. */
function byKey(groups: { key: string | null; count: number }[] | undefined) {
  return Object.fromEntries(
    (groups ?? []).map((group) => [group.key ?? "<none>", group.count]),
  );
}
