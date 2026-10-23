import {
  createEnvironment,
  createProject,
  createThread,
  environments,
  threads,
  noopNotifier,
  updateThread,
  upsertHost,
} from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";
import { eq } from "drizzle-orm";
import {
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@hyperfide/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { NotificationHub } from "../../src/ws/hub.js";
import { WatchInterestCoordinator } from "../../src/ws/watch-interests.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

async function setup(queries?: string[]) {
  const db = await createMigratedConnection(
    queries
      ? {
          slowQueryThresholdMs: 0,
          slowQueryLogger: {
            info(fields) {
              queries.push(fields.sql);
            },
          },
        }
      : undefined,
  );
  const hub = await new NotificationHub();
  const watchInterests = await new WatchInterestCoordinator({ db, hub });
  const subscribe = hub.subscribe.bind(hub);
  hub.subscribe = async (...args) => {
    subscribe(...args);
    await watchInterests.whenIdle();
  };
  const unsubscribe = hub.unsubscribe.bind(hub);
  hub.unsubscribe = async (...args) => {
    unsubscribe(...args);
    await watchInterests.whenIdle();
  };
  const unregister = hub.unregisterClient.bind(hub);
  hub.unregisterClient = async (...args) => {
    unregister(...args);
    await watchInterests.whenIdle();
  };
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const environment = await createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/test-workspace",
    status: "ready",
  });
  return { db, environment, host, hub, project, watchInterests };
}

function lastDaemonMessage(socket: {
  messages: string[];
}): HostDaemonServerWsMessage {
  const message = socket.messages[socket.messages.length - 1];
  if (!message) {
    throw new Error("Expected daemon message");
  }
  return hostDaemonServerWsMessageSchema.parse(JSON.parse(message));
}

describe("WatchInterestCoordinator", () => {
  it("ref-counts duplicate workspace interests across sockets", async () => {
    const { environment, host, hub } = await setup();
    const daemonSocket = createMockHubSocket();
    const socketA = createMockHubSocket();
    const socketB = createMockHubSocket();
    await hub.registerDaemon("session-1", host.id, daemonSocket);

    await hub.subscribe(socketA, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    await hub.subscribe(socketB, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    expect(daemonSocket.messages).toHaveLength(1);

    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      workspaceTargets: [
        {
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: "/tmp/test-workspace",
          },
        },
      ],
      threadStorageTargets: [],
    });

    await hub.unsubscribe(socketA, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    expect(daemonSocket.messages).toHaveLength(1);
    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      workspaceTargets: [
        {
          environmentId: environment.id,
        },
      ],
    });

    await hub.unsubscribe(socketB, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    expect(daemonSocket.messages).toHaveLength(2);
    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      workspaceTargets: [],
      threadStorageTargets: [],
    });
  });

  it("does not create watch targets for list subscriptions", async () => {
    const { host, hub, watchInterests } = await setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    await hub.registerDaemon("session-1", host.id, daemonSocket);

    await hub.subscribe(socket, { kind: "environment-list" });
    await hub.subscribe(socket, { kind: "thread-list" });

    expect(daemonSocket.messages).toHaveLength(0);
    expect(await watchInterests.reconcileWatchSetForHost(host.id)).toEqual({
      generation: 0,
      workspaceTargets: [],
      threadStorageTargets: [],
    });
  });

  it("releases all socket interests on socket close", async () => {
    const { environment, host, hub } = await setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    await hub.registerDaemon("session-1", host.id, daemonSocket);

    await hub.subscribe(socket, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    await hub.unregisterClient(socket);

    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      workspaceTargets: [],
      threadStorageTargets: [],
    });
  });

  it("includes current targets in session-open watch sets", async () => {
    const { environment, host, hub, watchInterests } = await setup();
    const socket = createMockHubSocket();

    await hub.subscribe(socket, {
      kind: "environment-detail",
      environmentId: environment.id,
    });

    expect(await watchInterests.reconcileWatchSetForHost(host.id)).toEqual({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: "/tmp/test-workspace",
          },
        },
      ],
      threadStorageTargets: [],
    });
  });

  it("omits unresolved workspace targets from snapshots", async () => {
    const { db, host, hub, project, watchInterests } = await setup();
    const unready = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/unready",
      status: "provisioning",
    });
    const destroyed = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/destroyed",
      status: "destroyed",
    });
    const socket = createMockHubSocket();

    await hub.subscribe(socket, {
      kind: "environment-detail",
      environmentId: unready.id,
    });
    await hub.subscribe(socket, {
      kind: "environment-detail",
      environmentId: destroyed.id,
    });

    expect(
      (await watchInterests.reconcileWatchSetForHost(host.id)).workspaceTargets,
    ).toEqual([]);
  });

  it("starts watching when a subscribed environment becomes ready", async () => {
    const { db, host, hub, project } = await setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/later-ready",
      status: "provisioning",
    });
    await hub.registerDaemon("session-1", host.id, daemonSocket);

    await hub.subscribe(socket, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    expect(daemonSocket.messages).toHaveLength(0);

    await db
      .update(environments)
      .set({ status: "ready" })
      .where(eq(environments.id, environment.id))
      .run();
    await hub.notifyEnvironment(environment.id, ["status-changed"]);

    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      workspaceTargets: [
        {
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: "/tmp/later-ready",
          },
        },
      ],
      threadStorageTargets: [],
    });
  });

  it("does not replace watch sets for ordinary workspace change events", async () => {
    const { environment, host, hub } = await setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    await hub.registerDaemon("session-1", host.id, daemonSocket);

    await hub.subscribe(socket, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    const snapshotCount = daemonSocket.messages.length;

    await hub.notifyEnvironment(environment.id, ["work-status-changed"]);

    expect(daemonSocket.messages).toHaveLength(snapshotCount);
  });

  it("does not replace a watch set when a relevant invalidation resolves identically", async () => {
    const { environment, host, hub } = await setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    await hub.registerDaemon("session-1", host.id, daemonSocket);

    await hub.subscribe(socket, {
      kind: "environment-detail",
      environmentId: environment.id,
    });
    const snapshotCount = daemonSocket.messages.length;

    await hub.notifyEnvironment(environment.id, ["metadata-changed"]);

    expect(daemonSocket.messages).toHaveLength(snapshotCount);
  });

  it("resolves thread-detail subscriptions to the owning thread storage target", async () => {
    const { db, environment, host, hub, project, watchInterests } =
      await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const socket = createMockHubSocket();

    await hub.subscribe(socket, {
      kind: "thread-detail",
      threadId: thread.id,
    });

    expect(
      await watchInterests.reconcileWatchSetForHost(host.id),
    ).toMatchObject({
      threadStorageTargets: [
        {
          environmentId: environment.id,
          threadId: thread.id,
        },
      ],
      workspaceTargets: [],
    });
  });

  it("starts watching thread storage after a subscribed thread is attached to an environment", async () => {
    const { db, environment, host, hub, project } = await setup();
    const daemonSocket = createMockHubSocket();
    const socket = createMockHubSocket();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: null,
      providerId: "codex",
    });
    await hub.registerDaemon("session-1", host.id, daemonSocket);

    await hub.subscribe(socket, {
      kind: "thread-detail",
      threadId: thread.id,
    });
    expect(daemonSocket.messages).toHaveLength(0);

    await updateThread(db, hub, thread.id, {
      environmentId: environment.id,
    });

    expect(lastDaemonMessage(daemonSocket)).toMatchObject({
      type: "watch-set.replace",
      threadStorageTargets: [
        {
          environmentId: environment.id,
          threadId: thread.id,
        },
      ],
      workspaceTargets: [],
    });
  });
  it("batches a refresh while removing moved, archived and destroyed targets from their previous hosts", async () => {
    const queries: string[] = [];
    const { db, environment, host, hub, project, watchInterests } =
      await setup(queries);
    const otherHost = await upsertHost(db, noopNotifier, {
      name: "other-host",
    });
    const otherEnvironment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: otherHost.id,
      path: "/tmp/other-workspace",
      status: "ready",
    });
    const firstDaemon = createMockHubSocket();
    const secondDaemon = createMockHubSocket();
    await hub.registerDaemon("first", host.id, firstDaemon);
    await hub.registerDaemon("second", otherHost.id, secondDaemon);
    const socket = createMockHubSocket();
    for (const target of [environment, otherEnvironment])
      await hub.subscribe(socket, {
        kind: "environment-detail",
        environmentId: target.id,
      });
    const watched = await Promise.all(
      Array.from(
        { length: 12 },
        async (_, index) =>
          await createThread(db, noopNotifier, {
            projectId: project.id,
            environmentId:
              index % 2 === 0 ? environment.id : otherEnvironment.id,
            providerId: "test-provider",
          }),
      ),
    );
    for (const thread of watched)
      await hub.subscribe(socket, {
        kind: "thread-detail",
        threadId: thread.id,
      });
    await db
      .update(environments)
      .set({ hostId: otherHost.id, path: "/tmp/moved" })
      .where(eq(environments.id, environment.id))
      .run();
    queries.length = 0;
    await hub.notifyEnvironment(environment.id, ["metadata-changed"]);
    const reads = queries.filter((sql) => sql.startsWith("select ")).length;
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(4);
    expect(lastDaemonMessage(firstDaemon)).toMatchObject({
      workspaceTargets: [],
      threadStorageTargets: [],
    });
    expect(lastDaemonMessage(secondDaemon)).toMatchObject({
      workspaceTargets: [
        {
          environmentId: environment.id,
          workspaceContext: { workspacePath: "/tmp/moved" },
        },
        { environmentId: otherEnvironment.id },
      ],
      threadStorageTargets: watched.map((thread) => ({
        threadId: thread.id,
        environmentId: thread.environmentId,
      })),
    });
    const generation = (
      await watchInterests.reconcileWatchSetForHost(otherHost.id)
    ).generation;
    await hub.notifyEnvironment(environment.id, ["metadata-changed"]);
    expect(
      (await watchInterests.reconcileWatchSetForHost(otherHost.id)).generation,
    ).toBe(generation);
    await db
      .update(threads)
      .set({ archivedAt: Date.now() })
      .where(eq(threads.id, watched[0]!.id))
      .run();
    await hub.notifyThread(watched[0]!.id, ["archived-changed"]);
    expect(
      (await watchInterests.reconcileWatchSetForHost(otherHost.id))
        .threadStorageTargets,
    ).toHaveLength(11);
    await db
      .update(threads)
      .set({ deletedAt: Date.now() })
      .where(eq(threads.id, watched[2]!.id))
      .run();
    await hub.notifyThread(watched[2]!.id, ["thread-deleted"]);
    expect(
      (await watchInterests.reconcileWatchSetForHost(otherHost.id))
        .threadStorageTargets,
    ).toHaveLength(10);
    await db
      .update(environments)
      .set({ status: "destroyed" })
      .where(eq(environments.id, otherEnvironment.id))
      .run();
    await hub.notifyEnvironment(otherEnvironment.id, ["status-changed"]);
    expect(
      await watchInterests.reconcileWatchSetForHost(otherHost.id),
    ).toMatchObject({
      workspaceTargets: [{ environmentId: environment.id }],
      threadStorageTargets: watched
        .filter((_, index) => index > 2 && index % 2 === 0)
        .map((thread) => ({
          threadId: thread.id,
          environmentId: thread.environmentId,
        })),
    });
    await hub.unregisterClient(socket);
    expect(lastDaemonMessage(secondDaemon)).toMatchObject({
      workspaceTargets: [],
      threadStorageTargets: [],
    });
    await db.close();
  });
});
