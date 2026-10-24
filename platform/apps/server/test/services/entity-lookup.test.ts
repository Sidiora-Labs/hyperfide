import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  closeSession,
  createEnvironment,
  createProject,
  createThread,
  hostDaemonSessions,
  markProjectDeleted,
  noopNotifier,
  openSession,
  updateHost,
  upsertHost,
  type DbConnection,
} from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";
import type { Host, Project } from "@hyperfide/domain";
import { makeHost } from "@hyperfide/test-helpers/domain-fixtures";
import { ApiError } from "../../src/errors.js";
import { NotificationHub } from "../../src/ws/hub.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import {
  listPublicHostsWithStatus,
  requireConnectedHostSession,
  requireNonDestroyedHostWithStatus,
  requirePublicProject,
  requireReadyEnvironment,
  requireThreadEnvironment,
} from "../../src/services/lib/entity-lookup.js";

interface SetupResult {
  db: DbConnection;
  host: Host;
  hub: NotificationHub;
  project: Project;
}

type ThrowingCallback = () => unknown;

async function setup(): Promise<SetupResult> {
  const db = await createMigratedConnection();
  const hub = await new NotificationHub();
  const hostRow = await upsertHost(db, noopNotifier, {
    id: "host_entity_lookup",
    name: "Entity Lookup Host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "Entity Lookup Project",
    source: {
      type: "local_path",
      hostId: hostRow.id,
      path: "/tmp/entity-lookup",
    },
  });
  const host = makeHost({
    id: hostRow.id,
    name: hostRow.name,
    status: "disconnected",
    maxPermissionMode: hostRow.maxPermissionMode,
    lastSeenAt: hostRow.lastSeenAt,
    createdAt: hostRow.createdAt,
    updatedAt: hostRow.updatedAt,
  });
  return { db, host, hub, project };
}

async function openTestSession(db: DbConnection, hostId: string) {
  return await openSession(db, {
    hostId,
    instanceId: "instance-entity-lookup",
    hostName: "Entity Lookup Host",
    dataDir: "/tmp/entity-lookup-data",
    protocolVersion: 1,
    heartbeatIntervalMs: 5_000,
    leaseTimeoutMs: 30_000,
  });
}

async function closeTestSession(
  db: DbConnection,
  args: {
    closeReason: "daemon-disconnect" | "expired";
    closedAt: number;
    sessionId: string;
  },
): Promise<void> {
  await closeSession(db, noopNotifier, args.sessionId, args.closeReason);
  await db
    .update(hostDaemonSessions)
    .set({ closedAt: args.closedAt })
    .where(eq(hostDaemonSessions.id, args.sessionId))
    .run();
}

async function captureApiError(callback: ThrowingCallback): Promise<ApiError> {
  try {
    await callback();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected ApiError");
}

describe("entity lookup lifecycle errors", () => {
  it("returns structured environment_not_ready details", async () => {
    const { db, host, project } = await setup();
    try {
      const environment = await createEnvironment(db, noopNotifier, {
        providerOwnsPath: false,
        hostId: host.id,
        projectId: project.id,
        environmentProvider: {
          environmentProviderId: "git-worktree",
          instanceKey: null,
          selection: {
            machine: { type: "existing", hostId: host.id },
            inputs: null,
          },
        },
        path: null,
        status: "destroyed",
      });

      const error = await captureApiError(async () => {
        await requireReadyEnvironment(db, environment.id);
      });

      expect(error.status).toBe(409);
      expect(error.body).toEqual({
        code: "environment_not_ready",
        message: "Environment unavailable",
        details: {
          environmentStatus: "destroyed",
          hasPath: false,
        },
      });
    } finally {
      await db.close();
    }
  });

  it("returns structured thread_environment_unavailable details", async () => {
    const { db, host, project } = await setup();
    try {
      const unattachedThread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const unattachedError = await captureApiError(async () => {
        await requireThreadEnvironment(db, unattachedThread.id);
      });
      expect(unattachedError.body).toEqual({
        code: "thread_environment_unavailable",
        message: "Thread environment is unavailable",
        details: {
          reason: "never_attached",
          environmentStatus: null,
        },
      });

      const environment = await createEnvironment(db, noopNotifier, {
        providerOwnsPath: false,
        hostId: host.id,
        projectId: project.id,
        environmentProvider: {
          environmentProviderId: "git-worktree",
          instanceKey: null,
          selection: {
            machine: { type: "existing", hostId: host.id },
            inputs: null,
          },
        },
        path: null,
        status: "destroyed",
      });
      const destroyedEnvironmentThread = await createThread(db, noopNotifier, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
      });
      const destroyedError = await captureApiError(async () => {
        await requireThreadEnvironment(db, destroyedEnvironmentThread.id);
      });
      expect(destroyedError.body).toEqual({
        code: "thread_environment_unavailable",
        message: "Thread environment is unavailable",
        details: {
          reason: "destroyed",
          environmentStatus: "destroyed",
        },
      });
    } finally {
      await db.close();
    }
  });

  it("returns structured host_unavailable details", async () => {
    const { db, host, hub } = await setup();
    try {
      const disconnectedError = await captureApiError(async () => {
        await requireConnectedHostSession({ db, hub }, host.id);
      });
      expect(disconnectedError.status).toBe(502);
      expect(disconnectedError.body).toEqual({
        code: "host_unavailable",
        message: "Host is not connected",
        details: {
          reason: "disconnected",
          hostStatus: "disconnected",
          suspendedAt: null,
          destroyedAt: null,
        },
      });

      await updateHost(db, noopNotifier, host.id, {
        phase: "suspended",
        suspendedAt: 123,
      });
      const suspendedError = await captureApiError(async () => {
        await requireConnectedHostSession({ db, hub }, host.id);
      });
      expect(suspendedError.status).toBe(502);
      expect(suspendedError.body).toEqual({
        code: "host_unavailable",
        message: "Host is suspended",
        details: {
          reason: "suspended",
          hostStatus: "disconnected",
          suspendedAt: 123,
          destroyedAt: null,
        },
      });

      await updateHost(db, noopNotifier, host.id, { suspendedAt: null });
      const legacySuspendedError = await captureApiError(async () => {
        await requireConnectedHostSession({ db, hub }, host.id);
      });
      expect(legacySuspendedError.body.details).toMatchObject({
        reason: "suspended",
        suspendedAt: null,
      });

      await updateHost(db, noopNotifier, host.id, { destroyedAt: 456 });
      const destroyedError = await captureApiError(async () => {
        await requireNonDestroyedHostWithStatus({ db, hub }, host.id);
      });
      expect(destroyedError.status).toBe(404);
      expect(destroyedError.body).toEqual({
        code: "host_unavailable",
        message: "Host is unavailable",
        details: {
          reason: "destroyed",
          hostStatus: null,
          suspendedAt: null,
          destroyedAt: 456,
        },
      });
    } finally {
      await db.close();
    }
  });

  it("returns project_unavailable for pending project deletion", async () => {
    const { db, project } = await setup();
    try {
      await markProjectDeleted(db, noopNotifier, {
        deletedAt: 123,
        projectId: project.id,
      });

      const error = await captureApiError(async () => {
        await requirePublicProject(db, project.id);
      });

      expect(error.status).toBe(404);
      expect(error.body).toEqual({
        code: "project_unavailable",
        message: "Project is unavailable",
        details: {
          reason: "pending_deletion",
          deletedAt: 123,
        },
      });
    } finally {
      await db.close();
    }
  });

  it("returns project_unavailable for repeated project deletion", async () => {
    const { db, project } = await setup();
    try {
      await markProjectDeleted(db, noopNotifier, {
        deletedAt: 123,
        projectId: project.id,
      });
      const repeated = await markProjectDeleted(db, noopNotifier, {
        deletedAt: 456,
        projectId: project.id,
      });
      expect(repeated).toBeNull();

      const error = await captureApiError(async () => {
        await requirePublicProject(db, project.id);
      });

      expect(error.status).toBe(404);
      expect(error.body).toEqual({
        code: "project_unavailable",
        message: "Project is unavailable",
        details: {
          reason: "pending_deletion",
          deletedAt: 123,
        },
      });
    } finally {
      await db.close();
    }
  });
});

describe("host status after a lost daemon connection", () => {
  it.each(["daemon-disconnect", "expired"] as const)(
    "reports a host whose session closed (%s) as disconnected immediately",
    async (closeReason) => {
      const { db, host, hub } = await setup();
      try {
        const session = await openTestSession(db, host.id);
        await closeTestSession(db, {
          closeReason,
          closedAt: Date.now() - 1_000,
          sessionId: session.id,
        });

        expect((await listPublicHostsWithStatus({ db, hub }))[0]?.status).toBe(
          "disconnected",
        );
        expect(
          (await requireNonDestroyedHostWithStatus({ db, hub }, host.id))
            .status,
        ).toBe("disconnected");
      } finally {
        await db.close();
      }
    },
  );

  it("reports a reconnecting host as connected only once its daemon socket registers", async () => {
    const { db, host, hub } = await setup();
    try {
      const lost = await openTestSession(db, host.id);
      await closeTestSession(db, {
        closeReason: "daemon-disconnect",
        closedAt: Date.now() - 1_000,
        sessionId: lost.id,
      });
      const reopened = await openTestSession(db, host.id);

      expect((await listPublicHostsWithStatus({ db, hub }))[0]?.status).toBe(
        "disconnected",
      );

      await hub.registerDaemon(reopened.id, host.id, createMockHubSocket());

      expect((await listPublicHostsWithStatus({ db, hub }))[0]?.status).toBe(
        "connected",
      );
    } finally {
      await db.close();
    }
  });
});
