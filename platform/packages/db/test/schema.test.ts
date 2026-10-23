// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../src/testing.js";
import { createMigratedConnection } from "../src/testing.js";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createEnvironmentId,
  createHostDaemonSessionId,
  createProjectId,
  createPromptHistoryEntryId,
  createProjectSourceId,
  createThreadId,
} from "../src/ids.js";
import {
  createQueuedThreadMessageId,
  createEventId,
  createHostId,
  environments,
  events,
  hostDaemonSessions,
  hosts,
  promptHistoryEntries,
  projectSources,
  projects,
  queuedThreadMessages,
  threadDynamicContextFileStates,
  threads,
} from "../src/index.js";

interface ColumnNameRow {
  name: string;
}

async function closeConnection(
  db: Awaited<ReturnType<typeof createMigratedConnection>>,
): Promise<void> {
  await db.close();
}

interface TableColumnRow {
  name: string;
}

describe("db rebuild schema", () => {
  it.skipIf(isPostgresTest)(
    "does not retain the derived host daemon heartbeat column",
    async () => {
      const db = await createMigratedConnection();

      const columnNames = (
        await db.$client
          .prepare<[], TableColumnRow>(
            "SELECT name FROM pragma_table_info('host_daemon_sessions')",
          )
          .all()
      ).map((column) => column.name);

      expect(columnNames).not.toContain("last_heartbeat_at");

      await closeConnection(db);
    },
  );

  it.skipIf(isPostgresTest)(
    "creates pending interactions with the canonical thread-scoped columns",
    async () => {
      const db = await createMigratedConnection();

      const columns = await db.$client
        .prepare(
          'SELECT name, lower(type) AS type, "notnull" AS "notNull", pk AS "primaryKey" FROM pragma_table_info(\'pending_interactions\')',
        )
        .all();

      expect(columns).toHaveLength(17);
      expect(columns).toEqual(
        expect.arrayContaining([
          { name: "id", type: "text", notNull: 1, primaryKey: 1 },
          { name: "thread_id", type: "text", notNull: 1, primaryKey: 0 },
          { name: "origin_kind", type: "text", notNull: 1, primaryKey: 0 },
          { name: "turn_id", type: "text", notNull: 0, primaryKey: 0 },
          { name: "provider_id", type: "text", notNull: 0, primaryKey: 0 },
          {
            name: "provider_thread_id",
            type: "text",
            notNull: 0,
            primaryKey: 0,
          },
          {
            name: "provider_request_id",
            type: "text",
            notNull: 0,
            primaryKey: 0,
          },
          { name: "plugin_id", type: "text", notNull: 0, primaryKey: 0 },
          { name: "renderer_id", type: "text", notNull: 0, primaryKey: 0 },
          { name: "status", type: "text", notNull: 1, primaryKey: 0 },
          { name: "payload", type: "text", notNull: 1, primaryKey: 0 },
          { name: "resolution", type: "text", notNull: 0, primaryKey: 0 },
          { name: "status_reason", type: "text", notNull: 0, primaryKey: 0 },
          { name: "created_at", type: "integer", notNull: 1, primaryKey: 0 },
          { name: "expires_at", type: "integer", notNull: 0, primaryKey: 0 },
          { name: "resolved_at", type: "integer", notNull: 0, primaryKey: 0 },
          { name: "updated_at", type: "integer", notNull: 1, primaryKey: 0 },
        ]),
      );

      await closeConnection(db);
    },
  );

  it.skipIf(isPostgresTest)(
    "does not persist terminal runtime-only columns",
    async () => {
      const db = await createMigratedConnection();

      try {
        const columnNames = (
          await db.$client
            .prepare<[], ColumnNameRow>(
              `
            SELECT name
            FROM pragma_table_info('terminal_sessions')
            ORDER BY cid
          `,
            )
            .all()
        ).map((row) => row.name);

        expect(columnNames).toEqual([
          "id",
          "thread_id",
          "environment_id",
          "host_id",
          "daemon_session_id",
          "title",
          "initial_cwd",
          "cols",
          "rows",
          "status",
          "exit_code",
          "close_reason",
          "created_at",
          "updated_at",
          "last_user_input_at",
        ]);
      } finally {
        await closeConnection(db);
      }
    },
  );

  it("cascades host deletion to host-scoped project sources", async () => {
    const db = await createMigratedConnection();

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const sourceId = createProjectSourceId();

    await db
      .insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(projectSources)
      .values({
        id: sourceId,
        projectId,
        type: "local_path",
        hostId,
        path: "/tmp/rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await db.delete(hosts).where(eq(hosts.id, hostId)).run();

    expect(await db.select().from(projectSources).all()).toHaveLength(0);

    await closeConnection(db);
  });

  it("cascades project deletion to environments and threads", async () => {
    const db = await createMigratedConnection();

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const environmentId = createEnvironmentId();
    const threadId = createThreadId();

    await db
      .insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(environments)
      .values({
        id: environmentId,
        projectId,
        hostId,
        path: "/tmp/rebuild/.bb/env",
        isGitRepo: true,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(threads)
      .values({
        id: threadId,
        projectId,
        environmentId,
        providerId: "codex",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await db.delete(projects).where(eq(projects.id, projectId)).run();

    expect(await db.select().from(environments).all()).toHaveLength(0);
    expect(await db.select().from(threads).all()).toHaveLength(0);

    await closeConnection(db);
  });

  it("cascades thread deletion to thread-owned rows", async () => {
    const db = await createMigratedConnection();

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const threadId = createThreadId();

    await db
      .insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(threads)
      .values({
        id: threadId,
        projectId,
        providerId: "codex",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(threadDynamicContextFileStates)
      .values({
        threadId,
        fileKey: "manager-preferences",
        contentStatus: "present",
        contentHash: "sha256:abc",
        shownAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await db.delete(threads).where(eq(threads.id, threadId)).run();

    expect(
      await db.select().from(threadDynamicContextFileStates).all(),
    ).toHaveLength(0);

    await closeConnection(db);
  });

  it("cascades host deletion to host-scoped records", async () => {
    const db = await createMigratedConnection();

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const environmentId = createEnvironmentId();
    const sessionId = createHostDaemonSessionId();

    await db
      .insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(environments)
      .values({
        id: environmentId,
        projectId,
        hostId,
        path: "/tmp/rebuild/.bb/env",
        isGitRepo: true,
        branchName: "bb/env-1",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(hostDaemonSessions)
      .values({
        id: sessionId,
        hostId,
        instanceId: "instance-1",
        hostName: "Local host",
        dataDir: "/tmp/test-data",
        protocolVersion: 1,
        heartbeatIntervalMs: 10_000,
        leaseTimeoutMs: 30_000,
        status: "connected",
        leaseExpiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db.delete(hosts).where(eq(hosts.id, hostId)).run();

    expect(await db.select().from(environments).all()).toHaveLength(0);
    expect(await db.select().from(hostDaemonSessions).all()).toHaveLength(0);

    await closeConnection(db);
  });

  it("sets nullable environment references to null when an environment is deleted", async () => {
    const db = await createMigratedConnection();

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const environmentId = createEnvironmentId();
    const threadId = createThreadId();

    await db
      .insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(environments)
      .values({
        id: environmentId,
        projectId,
        hostId,
        path: "/tmp/rebuild/.bb/env",
        isGitRepo: true,
        branchName: "bb/env-1",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(threads)
      .values({
        id: threadId,
        projectId,
        environmentId,
        providerId: "codex",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(events)
      .values({
        id: createEventId(),
        threadId,
        scopeKind: "thread",
        environmentId,
        sequence: 1,
        type: "system/error",
        data: "{}",
        createdAt: now,
      })
      .run();

    await db
      .delete(environments)
      .where(eq(environments.id, environmentId))
      .run();

    expect((await db.select().from(threads).get())?.environmentId).toBeNull();
    expect((await db.select().from(events).get())?.environmentId).toBeNull();

    await closeConnection(db);
  });

  it("cascades thread deletion to events, prompt history, and queued messages", async () => {
    const db = await createMigratedConnection();

    const now = Date.now();
    const projectId = createProjectId();
    const threadId = createThreadId();

    await db
      .insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(threads)
      .values({
        id: threadId,
        projectId,
        providerId: "codex",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(queuedThreadMessages)
      .values({
        id: createQueuedThreadMessageId(),
        threadId,
        content: "[]",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        state: "queued",
        sortKey: "V",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(promptHistoryEntries)
      .values({
        id: createPromptHistoryEntryId(),
        projectId,
        threadId,
        scope: "thread",
        requestSequence: 1,
        input: '[{"type":"text","text":"Follow up"}]',
        createdAt: now,
      })
      .run();
    await db
      .insert(events)
      .values({
        id: createEventId(),
        threadId,
        scopeKind: "thread",
        sequence: 1,
        type: "system/error",
        data: "{}",
        createdAt: now,
      })
      .run();

    await db.delete(threads).where(eq(threads.id, threadId)).run();

    expect(await db.select().from(queuedThreadMessages).all()).toHaveLength(0);
    expect(await db.select().from(promptHistoryEntries).all()).toHaveLength(0);
    expect(await db.select().from(events).all()).toHaveLength(0);

    await closeConnection(db);
  });

  it("rejects duplicate event sequence numbers within a thread", async () => {
    const db = await createMigratedConnection();

    const now = Date.now();
    const projectId = createProjectId();
    const threadId = createThreadId();

    await db
      .insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(threads)
      .values({
        id: threadId,
        projectId,
        providerId: "codex",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(events)
      .values({
        id: createEventId(),
        threadId,
        scopeKind: "thread",
        sequence: 1,
        type: "system/error",
        data: "{}",
        createdAt: now,
      })
      .run();

    await expect(
      (async () =>
        await db
          .insert(events)
          .values({
            id: createEventId(),
            threadId,
            scopeKind: "thread",
            sequence: 1,
            type: "system/error",
            data: "{}",
            createdAt: now + 1,
          })
          .run())(),
    ).rejects.toThrow();

    await closeConnection(db);
  });

  it("generates prefixed ids for rebuild entities", () => {
    expect(createHostId()).toMatch(/^host_/u);
    expect(createProjectId()).toMatch(/^proj_/u);
    expect(createProjectSourceId()).toMatch(/^src_/u);
    expect(createEnvironmentId()).toMatch(/^env_/u);
    expect(createThreadId()).toMatch(/^thr_/u);
    expect(createEventId()).toMatch(/^evt_/u);
    expect(createPromptHistoryEntryId()).toMatch(/^phist_/u);
    expect(createQueuedThreadMessageId()).toMatch(/^qmsg_/u);
    expect(createHostDaemonSessionId()).toMatch(/^hses_/u);
  });

  it("requires a non-null data_dir on host_daemon_sessions", async () => {
    const db = await createMigratedConnection();
    const hostId = createHostId();
    const now = Date.now();
    await db
      .insert(hosts)
      .values({
        id: hostId,
        name: "host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await expect(
      (async () =>
        await db
          .insert(hostDaemonSessions)
          .values({
            id: createHostDaemonSessionId(),
            hostId,
            instanceId: "instance",
            hostName: "host",
            protocolVersion: 1,
            heartbeatIntervalMs: 1_000,
            leaseTimeoutMs: 10_000,
            status: "active",
            leaseExpiresAt: now + 10_000,
            createdAt: now,
            updatedAt: now,
          } as never)
          .run())(),
    ).rejects.toThrow(
      /NOT NULL constraint failed: host_daemon_sessions\.data_dir|null value in column "data_dir"/,
    );
    await closeConnection(db);
  });
});
