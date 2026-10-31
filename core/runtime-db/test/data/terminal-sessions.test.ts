import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  countTerminalSessions,
  createTerminalSession,
  listTerminalSessions,
  updateTerminalSession,
  updateTerminalSessions,
} from "../../src/data/terminal-sessions.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { openSession } from "../../src/data/sessions.js";
import { createThread } from "../../src/data/threads.js";
import { createMigratedConnection } from "../../src/testing.js";

type TestDb = ReturnType<typeof createConnection>;
type TestHost = Awaited<ReturnType<typeof upsertHost>>;
type TestSession = Awaited<ReturnType<typeof openSession>>;
type TestEnvironment = Awaited<ReturnType<typeof createEnvironment>>;
type TestThread = Awaited<ReturnType<typeof createThread>>;

interface TerminalSessionFixture {
  db: TestDb;
  environment: TestEnvironment;
  host: TestHost;
  session: TestSession;
  thread: TestThread;
}

async function listTerminalSessionsByThread(db: TestDb, threadId: string) {
  return await listTerminalSessions(db, {
    scope: { kind: "thread", threadId },
    visible: false,
  });
}

async function listVisibleTerminalSessionsByThread(
  db: TestDb,
  threadId: string,
) {
  return await listTerminalSessions(db, {
    scope: { kind: "thread", threadId },
    visible: true,
  });
}

async function listThreadlessTerminalSessionsByEnvironment(
  db: TestDb,
  environmentId: string,
) {
  return await listTerminalSessions(db, {
    scope: { environmentId, kind: "threadless-environment" },
    visible: false,
  });
}

async function markTerminalSessionUserInput(
  db: TestDb,
  args: { now: number; terminalId: string; threadId: string },
) {
  return await updateTerminalSession(db, {
    now: args.now,
    scope: { kind: "terminal", terminalId: args.terminalId },
    update: { kind: "user-input" },
  });
}

async function markTerminalSessionRunning(
  db: TestDb,
  args: {
    cols: number;
    daemonSessionId: string;
    initialCwd: string;
    rows: number;
    terminalId: string;
    title: string;
  },
) {
  return await updateTerminalSession(db, {
    scope: {
      daemonSessionId: args.daemonSessionId,
      kind: "daemon",
      statuses: ["starting"],
      terminalId: args.terminalId,
    },
    update: {
      cols: args.cols,
      daemonSessionId: args.daemonSessionId,
      initialCwd: args.initialCwd,
      kind: "running",
      rows: args.rows,
      title: args.title,
    },
  });
}

async function markThreadTerminalSessionsExited(
  db: TestDb,
  args: { closeReason: "thread-deleted"; threadId: string },
) {
  return await updateTerminalSessions(db, {
    scope: {
      kind: "thread",
      statuses: ["starting", "running", "disconnected"],
      threadId: args.threadId,
    },
    update: { closeReason: args.closeReason, kind: "exit" },
  });
}

async function markEnvironmentTerminalSessionsExited(
  db: TestDb,
  args: { closeReason: "environment-destroyed"; environmentId: string },
) {
  return await updateTerminalSessions(db, {
    scope: {
      environmentId: args.environmentId,
      kind: "environment",
      statuses: ["starting", "running", "disconnected"],
    },
    update: { closeReason: args.closeReason, kind: "exit" },
  });
}

async function markDaemonTerminalSessionsDisconnected(
  db: TestDb,
  args: { daemonSessionId: string },
) {
  return await updateTerminalSessions(db, {
    scope: {
      daemonSessionId: args.daemonSessionId,
      kind: "daemon",
      statuses: ["starting", "running"],
    },
    update: { kind: "disconnect", retainDaemonSession: false },
  });
}

async function openTestSession(
  db: TestDb,
  hostId: string,
): Promise<TestSession> {
  return await openSession(db, {
    hostId,
    instanceId: "inst-1",
    hostName: "test-host",
    dataDir: "/tmp/test-host-data",
    protocolVersion: 1,
    heartbeatIntervalMs: 10_000,
    leaseTimeoutMs: 30_000,
  });
}

async function setup(): Promise<TerminalSessionFixture> {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const session = await openTestSession(db, host.id);
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  });
  const environment = await createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/workspace",
    status: "ready",
    isGitRepo: true,
    branchName: "main",
    baseBranch: null,
    defaultBranch: "main",
    mergeBaseBranch: null,
  });
  const thread = await createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "idle",
  });
  return {
    db,
    environment,
    host,
    session,
    thread,
  };
}

async function createStartingTerminal(fixture: TerminalSessionFixture) {
  return await createTerminalSession(fixture.db, {
    cols: 80,
    daemonSessionId: fixture.session.id,
    environmentId: fixture.environment.id,
    hostId: fixture.host.id,
    initialCwd: "/tmp/workspace",
    rows: 24,
    status: "starting",
    threadId: fixture.thread.id,
    title: "Terminal 1",
  });
}

async function createStartingThreadlessTerminal(
  fixture: TerminalSessionFixture,
) {
  return await createTerminalSession(fixture.db, {
    cols: 80,
    daemonSessionId: fixture.session.id,
    environmentId: fixture.environment.id,
    hostId: fixture.host.id,
    initialCwd: "/tmp/workspace",
    rows: 24,
    status: "starting",
    threadId: null,
    title: "Terminal 1",
  });
}

describe("terminal sessions", () => {
  it("keeps threadless environment terminals out of thread terminal queries", async () => {
    const fixture = await setup();
    const threadTerminal = await createStartingTerminal(fixture);
    const threadlessTerminal = await createStartingThreadlessTerminal(fixture);

    expect(
      await listTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).toEqual([expect.objectContaining({ id: threadTerminal.id })]);
    expect(
      await listThreadlessTerminalSessionsByEnvironment(
        fixture.db,
        fixture.environment.id,
      ),
    ).toEqual([expect.objectContaining({ id: threadlessTerminal.id })]);
  });

  it("marks only the expected starting daemon session running", async () => {
    const fixture = await setup();
    const terminal = await createStartingTerminal(fixture);

    const running = await markTerminalSessionRunning(fixture.db, {
      cols: 100,
      daemonSessionId: fixture.session.id,
      initialCwd: "/tmp/workspace",
      rows: 30,
      terminalId: terminal.id,
      title: "zsh",
    });

    expect(running).toMatchObject({
      id: terminal.id,
      status: "running",
      daemonSessionId: fixture.session.id,
      cols: 100,
      rows: 30,
      title: "zsh",
    });
  });

  it("does not resurrect a terminal exited by thread deletion", async () => {
    const fixture = await setup();
    const terminal = await createStartingTerminal(fixture);
    await markThreadTerminalSessionsExited(fixture.db, {
      threadId: fixture.thread.id,
      closeReason: "thread-deleted",
    });

    const running = await markTerminalSessionRunning(fixture.db, {
      cols: 100,
      daemonSessionId: fixture.session.id,
      initialCwd: "/tmp/workspace",
      rows: 30,
      terminalId: terminal.id,
      title: "zsh",
    });

    expect(running).toBeNull();
    expect(
      await listTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: terminal.id,
        closeReason: "thread-deleted",
        daemonSessionId: null,
        status: "exited",
      }),
    ]);
  });

  it("marks a terminal dirty on first user input only", async () => {
    const fixture = await setup();
    const terminal = await createStartingTerminal(fixture);

    const firstInput = await markTerminalSessionUserInput(fixture.db, {
      terminalId: terminal.id,
      threadId: fixture.thread.id,
      now: 10,
    });
    const secondInput = await markTerminalSessionUserInput(fixture.db, {
      terminalId: terminal.id,
      threadId: fixture.thread.id,
      now: 20,
    });

    expect(firstInput).toMatchObject({
      id: terminal.id,
      lastUserInputAt: 10,
      updatedAt: 10,
    });
    expect(secondInput).toBeNull();
    expect(
      await listTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: terminal.id,
        lastUserInputAt: 10,
      }),
    ]);
  });

  it("does not resurrect a terminal exited by environment destruction", async () => {
    const fixture = await setup();
    const terminal = await createStartingTerminal(fixture);
    await markEnvironmentTerminalSessionsExited(fixture.db, {
      environmentId: fixture.environment.id,
      closeReason: "environment-destroyed",
    });

    const running = await markTerminalSessionRunning(fixture.db, {
      cols: 100,
      daemonSessionId: fixture.session.id,
      initialCwd: "/tmp/workspace",
      rows: 30,
      terminalId: terminal.id,
      title: "zsh",
    });

    expect(running).toBeNull();
    expect(
      await listTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: terminal.id,
        closeReason: "environment-destroyed",
        daemonSessionId: null,
        status: "exited",
      }),
    ]);
  });

  it("does not resurrect a terminal disconnected from its daemon session", async () => {
    const fixture = await setup();
    const terminal = await createStartingTerminal(fixture);
    await markDaemonTerminalSessionsDisconnected(fixture.db, {
      daemonSessionId: fixture.session.id,
    });

    const running = await markTerminalSessionRunning(fixture.db, {
      cols: 100,
      daemonSessionId: fixture.session.id,
      initialCwd: "/tmp/workspace",
      rows: 30,
      terminalId: terminal.id,
      title: "zsh",
    });

    expect(running).toBeNull();
    expect(
      await listTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: terminal.id,
        daemonSessionId: null,
        status: "disconnected",
      }),
    ]);
  });

  it("lists starting, running, and disconnected terminals as visible", async () => {
    const fixture = await setup();
    const starting = await createTerminalSession(fixture.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/workspace",
      now: 1,
      rows: 24,
      status: "starting",
      threadId: fixture.thread.id,
      title: "Starting terminal",
    });
    const running = await createTerminalSession(fixture.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/workspace",
      now: 2,
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Running terminal",
    });
    const disconnected = await createTerminalSession(fixture.db, {
      cols: 80,
      daemonSessionId: null,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/workspace",
      now: 3,
      rows: 24,
      status: "disconnected",
      threadId: fixture.thread.id,
      title: "Disconnected terminal",
    });
    const exited = await createTerminalSession(fixture.db, {
      cols: 80,
      daemonSessionId: null,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/workspace",
      now: 4,
      rows: 24,
      status: "exited",
      threadId: fixture.thread.id,
      title: "Exited terminal",
    });

    expect(
      await listVisibleTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: starting.id }),
        expect.objectContaining({ id: running.id }),
        expect.objectContaining({ id: disconnected.id }),
      ]),
    );
    expect(
      await listVisibleTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).toHaveLength(3);
    expect(
      await listVisibleTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: exited.id })]),
    );
  });

  it("does not mark a starting terminal running for another daemon session", async () => {
    const fixture = await setup();
    const terminal = await createStartingTerminal(fixture);
    const replacementSession = await openTestSession(
      fixture.db,
      fixture.host.id,
    );

    const running = await markTerminalSessionRunning(fixture.db, {
      cols: 100,
      daemonSessionId: replacementSession.id,
      initialCwd: "/tmp/workspace",
      rows: 30,
      terminalId: terminal.id,
      title: "zsh",
    });

    expect(running).toBeNull();
    expect(
      await listTerminalSessionsByThread(fixture.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: terminal.id,
        daemonSessionId: fixture.session.id,
        status: "starting",
      }),
    ]);
  });
});

describe("countTerminalSessions", () => {
  it("preserves historical scoped counts and live standalone host/path counts", async () => {
    const { db, host, environment, thread } = await setup();
    try {
      const otherHost = await upsertHost(db, noopNotifier, {
        name: "other-host",
      });
      const rows = [
        {
          hostId: host.id,
          threadId: thread.id,
          environmentId: environment.id,
          status: "running",
          initialCwd: "/a",
        },
        {
          hostId: host.id,
          threadId: null,
          environmentId: environment.id,
          status: "running",
          initialCwd: "/a",
        },
        {
          hostId: host.id,
          threadId: thread.id,
          environmentId: environment.id,
          status: "exited",
          initialCwd: "/a",
        },
        {
          hostId: host.id,
          threadId: null,
          environmentId: environment.id,
          status: "exited",
          initialCwd: "/a",
        },
        {
          hostId: host.id,
          threadId: null,
          environmentId: null,
          status: "running",
          initialCwd: "/a",
        },
        {
          hostId: host.id,
          threadId: null,
          environmentId: null,
          status: "starting",
          initialCwd: "/b",
        },
        {
          hostId: host.id,
          threadId: null,
          environmentId: null,
          status: "disconnected",
          initialCwd: "/a",
        },
        {
          hostId: host.id,
          threadId: null,
          environmentId: null,
          status: "exited",
          initialCwd: "/a",
        },
        {
          hostId: otherHost.id,
          threadId: null,
          environmentId: null,
          status: "running",
          initialCwd: "/a",
        },
      ] as const;
      for (const row of rows) {
        await createTerminalSession(db, {
          ...row,
          cols: 80,
          rows: 24,
          daemonSessionId: null,
          title: "Terminal",
        });
      }
      expect(
        await countTerminalSessions(db, {
          scope: { kind: "thread", threadId: thread.id },
          visible: false,
        }),
      ).toBe(2);
      expect(
        await countTerminalSessions(db, {
          scope: {
            kind: "threadless-environment",
            environmentId: environment.id,
          },
          visible: false,
        }),
      ).toBe(2);
      for (const [cwd, expected] of [
        [null, 3],
        ["/a", 2],
        ["/b", 1],
        ["/missing", 0],
      ] as const) {
        expect(
          await countTerminalSessions(db, {
            scope: { kind: "host-path", hostId: host.id, cwd },
            visible: true,
          }),
        ).toBe(expected);
      }
    } finally {
      await db.close();
    }
  });
});
