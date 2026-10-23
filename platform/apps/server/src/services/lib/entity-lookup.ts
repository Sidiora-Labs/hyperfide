import {
  getEnvironment,
  getHost,
  getNonDestroyedHost,
  getProject,
  getSessionById,
  getThread,
  listPublicHosts,
  type HostDaemonSessionRow,
} from "@hyperfide/db";
import type { EnvironmentRow, HostRow } from "@hyperfide/db";
import type { Host, HostType } from "@hyperfide/domain";
import type { DbConnection } from "@hyperfide/db";
import type { NotificationHub } from "../../ws/hub.js";
import { ApiError } from "../../errors.js";
import {
  destroyedHostUnavailableDetails,
  destroyedThreadEnvironmentDetails,
  inactiveHostUnavailableDetails,
  throwEnvironmentNotReady,
  throwHostUnavailable,
  throwProjectUnavailable,
  throwThreadEnvironmentUnavailable,
  threadEnvironmentUnavailableDetails,
} from "./lifecycle-api-errors.js";

type ProjectRow = NonNullable<Awaited<ReturnType<typeof getProject>>>;
type ThreadRow = NonNullable<Awaited<ReturnType<typeof getThread>>>;
type StandardProject = ProjectRow & { kind: "standard" };
type HostLookupHub = Pick<NotificationHub, "getDaemonSessionIdForHost">;

interface HostLookupDeps {
  db: DbConnection;
  hub: HostLookupHub;
}

interface ThreadEnvironmentLookupResult {
  environment: EnvironmentRow;
  thread: ThreadRow;
}

export async function findHostDataDir(
  deps: HostLookupDeps,
  hostId: string,
): Promise<string | null> {
  return (await getOpenDaemonSessionForHost(deps, hostId))?.dataDir ?? null;
}

async function getOpenDaemonSessionForHost(
  deps: HostLookupDeps,
  hostId: string,
): Promise<HostDaemonSessionRow | null> {
  const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);
  if (!sessionId) {
    return null;
  }

  const session = await getSessionById(deps.db, { sessionId });
  if (!session || session.hostId !== hostId || session.status !== "active") {
    return null;
  }
  return session;
}

export async function toHostWithStatus(
  deps: HostLookupDeps,
  row: HostRow,
): Promise<Host> {
  return toHostRecord(
    row,
    (await getOpenDaemonSessionForHost(deps, row.id))
      ? "connected"
      : "disconnected",
  );
}

export function toHostRecord(row: HostRow, status: Host["status"]): Host {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status,
    machineProviderId: row.machineProviderId,
    lifecycle: {
      phase: row.phase,
      suspendedAt: row.suspendedAt,
      message: row.statusMessage,
      pendingLog: row.pendingLog,
      teardown:
        row.teardownStatus === null
          ? null
          : {
              status: row.teardownStatus,
              attempt: row.teardownAttempt,
            },
    },
    maxPermissionMode: row.maxPermissionMode,
    lastSeenAt: row.lastSeenAt,
    lastRejectedProtocolVersion: row.lastRejectedProtocolVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function throwHostNotFound(): never {
  throw new ApiError(404, "host_not_found", "Host not found");
}

function isStandardProject(project: ProjectRow): project is StandardProject {
  return project.kind === "standard";
}

export async function listPublicHostsWithStatus(
  deps: HostLookupDeps,
  options?: { includeCreating?: boolean; type?: HostType },
): Promise<Host[]> {
  return await Promise.all(
    (await listPublicHosts(deps.db, options)).map(
      async (row) => await toHostWithStatus(deps, row),
    ),
  );
}

export async function requireNonDestroyedHostWithStatus(
  deps: HostLookupDeps,
  hostId: string,
): Promise<Host> {
  const host = await getHost(deps.db, hostId);
  if (!host) {
    throwHostNotFound();
  }
  if (host.destroyedAt !== null) {
    throwHostUnavailable(
      404,
      "Host is unavailable",
      destroyedHostUnavailableDetails(host.destroyedAt),
    );
  }
  return await toHostWithStatus(deps, host);
}

export async function getNonDestroyedHostWithStatus(
  deps: HostLookupDeps,
  hostId: string,
): Promise<Host | null> {
  const host = await getNonDestroyedHost(deps.db, hostId);
  if (!host) {
    return null;
  }
  return await toHostWithStatus(deps, host);
}

export async function requireConnectedHostSession(
  deps: HostLookupDeps,
  hostId: string,
) {
  const host = await getHost(deps.db, hostId);
  if (!host) {
    throwHostNotFound();
  }
  if (host.destroyedAt !== null) {
    throwHostUnavailable(
      404,
      "Host is unavailable",
      destroyedHostUnavailableDetails(host.destroyedAt),
    );
  }
  const session = await getOpenDaemonSessionForHost(deps, hostId);
  const details = inactiveHostUnavailableDetails(
    session ? "connected" : "disconnected",
    host,
  );
  if (details.reason === "suspended") {
    throwHostUnavailable(502, "Host is suspended", details);
  }
  if (!session) {
    throwHostUnavailable(502, "Host is not connected", details);
  }
  return session;
}

export async function requireProject(
  db: DbConnection,
  projectId: string,
): Promise<ProjectRow> {
  const project = await getProject(db, projectId);
  if (!project) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return project;
}

export async function requirePublicProject(
  db: DbConnection,
  projectId: string,
): Promise<ProjectRow> {
  const project = await requireProject(db, projectId);
  if (project.deletedAt !== null) {
    throwProjectUnavailable({
      reason: "pending_deletion",
      deletedAt: project.deletedAt,
    });
  }
  return project;
}

export async function requirePublicStandardProject(
  db: DbConnection,
  projectId: string,
): Promise<StandardProject> {
  const project = await requirePublicProject(db, projectId);
  if (!isStandardProject(project)) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return project;
}

async function requireThread(
  db: DbConnection,
  threadId: string,
): Promise<ThreadRow> {
  const thread = await getThread(db, threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return thread;
}

export async function requirePublicThread(
  db: DbConnection,
  threadId: string,
): Promise<ThreadRow> {
  const thread = await requireThread(db, threadId);
  const project = await getProject(db, thread.projectId);
  if (thread.deletedAt !== null || project?.deletedAt !== null) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return thread;
}

export async function requireEnvironment(
  db: DbConnection,
  environmentId: string,
): Promise<EnvironmentRow> {
  const environment = await getEnvironment(db, environmentId);
  if (!environment) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  return environment;
}

export async function requireReadyEnvironment(
  db: DbConnection,
  environmentId: string,
): Promise<EnvironmentRow & { path: string; status: "ready" }> {
  const environment = await requireEnvironment(db, environmentId);
  if (environment.status !== "ready" || !environment.path) {
    throwEnvironmentNotReady(environment);
  }
  return {
    ...environment,
    path: environment.path,
    status: "ready",
  };
}

async function requireEnvironmentForThread(
  db: DbConnection,
  thread: ThreadRow,
): Promise<EnvironmentRow> {
  if (!thread.environmentId) {
    throwThreadEnvironmentUnavailable(
      threadEnvironmentUnavailableDetails("never_attached", null),
    );
  }
  return await requireEnvironment(db, thread.environmentId);
}

function ensureThreadEnvironmentAvailable(environment: EnvironmentRow): void {
  const unavailableDetails = destroyedThreadEnvironmentDetails(environment);
  if (unavailableDetails) {
    throwThreadEnvironmentUnavailable(unavailableDetails);
  }
}

export async function requireThreadEnvironmentAllowingDestroyed(
  db: DbConnection,
  threadId: string,
): Promise<ThreadEnvironmentLookupResult> {
  const thread = await requireThread(db, threadId);
  return {
    thread,
    environment: await requireEnvironmentForThread(db, thread),
  };
}

export async function requireThreadEnvironment(
  db: DbConnection,
  threadId: string,
): Promise<ThreadEnvironmentLookupResult> {
  const result = await requireThreadEnvironmentAllowingDestroyed(db, threadId);
  ensureThreadEnvironmentAvailable(result.environment);
  return result;
}

async function requirePublicThreadEnvironmentAllowingDestroyed(
  db: DbConnection,
  threadId: string,
): Promise<ThreadEnvironmentLookupResult> {
  const thread = await requirePublicThread(db, threadId);
  return {
    thread,
    environment: await requireEnvironmentForThread(db, thread),
  };
}

export async function requirePublicThreadEnvironment(
  db: DbConnection,
  threadId: string,
): Promise<ThreadEnvironmentLookupResult> {
  const result = await requirePublicThreadEnvironmentAllowingDestroyed(
    db,
    threadId,
  );
  ensureThreadEnvironmentAvailable(result.environment);
  return result;
}
