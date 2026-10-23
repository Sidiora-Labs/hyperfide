import {
  changedMessageSchema,
  type ThreadChangedMessage,
} from "@hyperfide/domain";
import { getThread, markThreadDeleted } from "@hyperfide/db";
import { HOST_RECONNECT_GRACE_MS } from "../../src/constants.js";
import { describe, expect, it, vi } from "vitest";
import {
  handleDaemonSocketClosed,
  handleHostRemoved,
} from "../../src/internal/session-owner-side-effects.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { onDaemonSocketOpen } from "../../src/ws/daemon-protocol.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedSession,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface HostThreadsFixture {
  activeThreadId: string;
  environmentId: string;
  hostId: string;
  idleThreadId: string;
  projectId: string;
  sessionId: string;
}

async function seedHostThreadsFixture(
  harness: TestAppHarness,
  value: number,
): Promise<HostThreadsFixture> {
  const { host, session } = await seedHostSession(harness.deps, {
    id: `host-runtime-status-${value}`,
  });
  const { project } = await seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/runtime-status-${value}`,
  });
  const environment = await seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/runtime-status-${value}`,
    status: "ready",
  });
  const activeThread = await seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "active",
  });
  const idleThread = await seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  return {
    activeThreadId: activeThread.id,
    environmentId: environment.id,
    hostId: host.id,
    idleThreadId: idleThread.id,
    projectId: project.id,
    sessionId: session.id,
  };
}

async function seedHostThreads(
  harness: TestAppHarness,
  args: {
    count: number;
    fixture: Pick<HostThreadsFixture, "environmentId" | "projectId">;
    status: "active" | "idle";
  },
): Promise<string[]> {
  return await Promise.all(
    Array.from(
      { length: args.count },
      async () =>
        (
          await seedThread(harness.deps, {
            projectId: args.fixture.projectId,
            environmentId: args.fixture.environmentId,
            status: args.status,
          })
        ).id,
    ),
  );
}

async function countPreparedStatements(
  harness: TestAppHarness,
  work: () => unknown,
): Promise<number> {
  const prepare = vi.spyOn(harness.db.$client, "prepare");
  try {
    await work();
    return prepare.mock.calls.length;
  } finally {
    prepare.mockRestore();
  }
}

function statusChangedMessagesFor(
  messages: readonly string[],
  threadId: string,
): ThreadChangedMessage[] {
  return messages.flatMap((raw) => {
    const message = changedMessageSchema.parse(JSON.parse(raw));
    return message.entity === "thread" &&
      message.id === threadId &&
      message.changes.includes("status-changed")
      ? [message]
      : [];
  });
}

async function hostDisconnectedMessagesFor(
  messages: readonly string[],
  hostId: string,
): Promise<string[]> {
  return messages.filter((raw) => {
    const message = changedMessageSchema.parse(JSON.parse(raw));
    return (
      message.entity === "host" &&
      message.id === hostId &&
      message.changes.includes("host-disconnected")
    );
  });
}

function lastStatusChange(
  messages: readonly string[],
  threadId: string,
): ThreadChangedMessage {
  const statusMessages = statusChangedMessagesFor(messages, threadId);
  const last = statusMessages.at(-1);
  if (!last) {
    throw new Error(`no status-changed message for thread ${threadId}`);
  }
  return last;
}

describe("host thread runtime status notifications", () => {
  it("keeps a closed daemon socket hidden until the reconnect grace ends, without interrupting the thread", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedHostThreadsFixture(harness, 1);
      const socket = createMockHubSocket();
      harness.hub.subscribe(socket, { kind: "thread-list" });
      harness.hub.subscribe(socket, { kind: "host-list" });

      vi.useFakeTimers();
      try {
        await handleDaemonSocketClosed(harness.deps, {
          sessionId: fixture.sessionId,
        });
        expect(
          lastStatusChange(socket.messages, fixture.activeThreadId).metadata
            ?.statusChange,
        ).toMatchObject({
          status: "active",
          runtime: { displayStatus: "active" },
        });
        expect(
          lastStatusChange(socket.messages, fixture.idleThreadId).metadata
            ?.statusChange,
        ).toBeUndefined();
        const hostChangesBeforeGraceEnd = (
          await hostDisconnectedMessagesFor(socket.messages, fixture.hostId)
        ).length;

        await vi.advanceTimersByTimeAsync(HOST_RECONNECT_GRACE_MS);

        await vi.waitFor(() =>
          expect(
            lastStatusChange(socket.messages, fixture.activeThreadId).metadata
              ?.statusChange?.runtime.displayStatus,
          ).toBe("waiting-for-host"),
        );

        expect(
          lastStatusChange(socket.messages, fixture.activeThreadId).metadata
            ?.statusChange,
        ).toMatchObject({
          status: "active",
          runtime: {
            displayStatus: "waiting-for-host",
          },
        });
        expect(
          await hostDisconnectedMessagesFor(socket.messages, fixture.hostId),
        ).toHaveLength(hostChangesBeforeGraceEnd + 1);
        expect(
          (await getThread(harness.db, fixture.activeThreadId))?.status,
        ).toBe("active");
      } finally {
        harness.hub.cancelPendingDaemonDisconnect(fixture.sessionId);
        vi.useRealTimers();
      }
    });
  });

  it("tells clients a disconnected host's threads are active again when its daemon reconnects", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedHostThreadsFixture(harness, 6);
      const socket = createMockHubSocket();
      harness.hub.subscribe(socket, { kind: "thread-list" });

      vi.useFakeTimers();
      try {
        await handleDaemonSocketClosed(harness.deps, {
          sessionId: fixture.sessionId,
        });
        await vi.advanceTimersByTimeAsync(HOST_RECONNECT_GRACE_MS);
        await vi.waitFor(() =>
          expect(
            lastStatusChange(socket.messages, fixture.activeThreadId).metadata
              ?.statusChange?.runtime.displayStatus,
          ).toBe("waiting-for-host"),
        );
      } finally {
        vi.useRealTimers();
      }
      expect(
        lastStatusChange(socket.messages, fixture.activeThreadId).metadata
          ?.statusChange?.runtime.displayStatus,
      ).toBe("waiting-for-host");

      const reconnected = await seedSession(harness.deps, fixture.hostId);
      await onDaemonSocketOpen(harness.deps, {
        hostId: fixture.hostId,
        sessionId: reconnected.id,
        socket: createMockHubSocket(),
      });

      expect(
        lastStatusChange(socket.messages, fixture.activeThreadId).metadata
          ?.statusChange,
      ).toMatchObject({
        status: "active",
        runtime: { displayStatus: "active" },
      });
    });
  });

  it("never shows a disconnect for a daemon that reconnects within the reconnect grace", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedHostThreadsFixture(harness, 5);
      const socket = createMockHubSocket();
      harness.hub.subscribe(socket, { kind: "thread-list" });

      vi.useFakeTimers();
      try {
        await handleDaemonSocketClosed(harness.deps, {
          sessionId: fixture.sessionId,
        });
        await vi.advanceTimersByTimeAsync(HOST_RECONNECT_GRACE_MS - 1_000);
        const reconnected = await seedSession(harness.deps, fixture.hostId);
        await harness.hub.registerDaemon(
          reconnected.id,
          fixture.hostId,
          createMockHubSocket(),
        );
        await vi.advanceTimersByTimeAsync(HOST_RECONNECT_GRACE_MS);
      } finally {
        vi.useRealTimers();
      }

      expect(
        statusChangedMessagesFor(socket.messages, fixture.activeThreadId).map(
          (message) => message.metadata?.statusChange?.runtime.displayStatus,
        ),
      ).toEqual(["active"]);
    });
  });

  it("publishes the disconnect fan-out in a statement count that does not grow with the host's thread count", async () => {
    await withTestHarness(async (harness) => {
      const small = await seedHostThreadsFixture(harness, 2);
      const large = await seedHostThreadsFixture(harness, 3);
      const largeActiveThreadIds = [
        large.activeThreadId,
        ...(await seedHostThreads(harness, {
          count: 2,
          fixture: large,
          status: "active",
        })),
      ];
      const largeIdleThreadIds = await seedHostThreads(harness, {
        count: 300,
        fixture: large,
        status: "idle",
      });
      const deletedActiveThread = await seedThread(harness.deps, {
        projectId: large.projectId,
        environmentId: large.environmentId,
        status: "active",
      });
      await markThreadDeleted(harness.db, harness.hub, {
        threadId: deletedActiveThread.id,
      });
      const socket = createMockHubSocket();
      harness.hub.subscribe(socket, { kind: "thread-list" });

      const largeStatements = await countPreparedStatements(
        harness,
        async () =>
          await handleDaemonSocketClosed(harness.deps, {
            sessionId: large.sessionId,
          }),
      );
      harness.hub.cancelPendingDaemonDisconnect(large.sessionId);
      const largeMessages = [...socket.messages];
      socket.messages.length = 0;

      const smallStatements = await countPreparedStatements(
        harness,
        async () =>
          await handleDaemonSocketClosed(harness.deps, {
            sessionId: small.sessionId,
          }),
      );
      harness.hub.cancelPendingDaemonDisconnect(small.sessionId);

      expect(largeStatements).toBe(smallStatements);

      for (const threadId of largeActiveThreadIds) {
        expect(
          lastStatusChange(largeMessages, threadId).metadata?.statusChange,
        ).toMatchObject({
          status: "active",
          runtime: { displayStatus: "active" },
        });
      }
      for (const threadId of [...largeIdleThreadIds, deletedActiveThread.id]) {
        expect(
          lastStatusChange(largeMessages, threadId).metadata?.statusChange,
        ).toBeUndefined();
      }
      expect(
        statusChangedMessagesFor(largeMessages, small.activeThreadId),
      ).toEqual([]);
    });
  });

  it("carries the settled post-interruption snapshot when the host is removed", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedHostThreadsFixture(harness, 4);
      const socket = createMockHubSocket();
      harness.hub.subscribe(socket, { kind: "thread-list" });

      await handleHostRemoved(harness.deps, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
      });

      const activeSnapshots = statusChangedMessagesFor(
        socket.messages,
        fixture.activeThreadId,
      ).flatMap((message) =>
        message.metadata?.statusChange ? [message.metadata.statusChange] : [],
      );
      expect(activeSnapshots.length).toBeGreaterThan(0);
      expect(
        (await getThread(harness.db, fixture.activeThreadId))?.status,
      ).toBe("idle");
      expect(activeSnapshots.at(-1)).toMatchObject({
        status: "idle",
        runtime: { displayStatus: "idle" },
      });
      expect(
        lastStatusChange(socket.messages, fixture.idleThreadId).metadata
          ?.statusChange,
      ).toBeUndefined();
    });
  });
});
