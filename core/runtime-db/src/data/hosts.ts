import { prepareCachedQuery } from "../connection.js";
import { and, eq, inArray, isNull, ne, placeholder } from "drizzle-orm";
import {
  resolveEnvironmentHostLifecycle,
  type HostChangeKind,
  type HostType,
  type JsonValue,
  type PermissionMode,
} from "@hyperfide/domain";
import type {
  DbConnection,
  DbTransaction,
  DbQueryConnection,
} from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { environments, hosts } from "../schema.js";
import { createHostId } from "../ids.js";

export type HostRow = typeof hosts.$inferSelect;

type HostWriteConnection = DbConnection | DbTransaction;

export interface UpsertHostInput {
  connectMachineId?: string | null;
  id?: string;
  name: string;
  type?: HostType;
  destroyedAt?: number | null;
}

export interface UpdateHostInput {
  type?: HostType;
  machineOperationId?: string | null;
  launchKey?: string | null;
  inputs?: JsonValue | null;
  pendingLog?: string;
  destroyedAt?: number | null;
  lastRejectedProtocolVersion?: number | null;
  maxPermissionMode?: PermissionMode;
  name?: string;
  machineProviderId?: string | null;
  phase?:
    | "creating"
    | "active"
    | "suspending"
    | "suspended"
    | "resuming"
    | "removing"
    | "destroyed";
  resource?: JsonValue | null;
  removeRetryAt?: number | null;
  statusMessage?: string | null;
  suspendRetryAt?: number | null;
  suspendedAt?: number | null;
  teardownAttempt?: number;
  teardownStatus?: "running" | "failed" | "removed" | null;
}

async function notifyHostMutation(
  db: HostWriteConnection,
  notifier: DbNotifier,
  previous: Awaited<ReturnType<typeof getHost>>,
  next: Awaited<ReturnType<typeof getHost>>,
): Promise<void> {
  if (!previous || !next) {
    return;
  }

  if (
    resolveEnvironmentHostLifecycle(previous) !==
    resolveEnvironmentHostLifecycle(next)
  ) {
    for (const environment of await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.hostId, next.id))
      .all()) {
      await notifier.notifyEnvironment(environment.id, ["status-changed"]);
    }
  }

  const hostChange = getHostConnectionChange(previous, next);
  if (!hostChange) {
    return;
  }

  await notifier.notifyHost(next.id, [hostChange]);
}

function getHostConnectionChange(
  previous: NonNullable<Awaited<ReturnType<typeof getHost>>>,
  next: NonNullable<Awaited<ReturnType<typeof getHost>>>,
): HostChangeKind | null {
  if (previous.destroyedAt === null && next.destroyedAt !== null) {
    return "host-disconnected";
  }

  if (previous.destroyedAt !== null && next.destroyedAt === null) {
    return "host-connected";
  }

  return null;
}

export async function upsertHost(
  db: HostWriteConnection,
  notifier: DbNotifier,
  input: UpsertHostInput,
) {
  const now = Date.now();
  const id = input.id ?? createHostId();
  const existing = await db.select().from(hosts).where(eq(hosts.id, id)).get();

  if (existing) {
    const updated = (await db
      .update(hosts)
      .set({
        type: input.type ?? existing.type,
        connectMachineId:
          input.connectMachineId !== undefined
            ? input.connectMachineId
            : existing.connectMachineId,
        destroyedAt:
          input.destroyedAt !== undefined
            ? input.destroyedAt
            : existing.destroyedAt,
        lastSeenAt: existing.lastSeenAt,
        lastRejectedProtocolVersion: existing.lastRejectedProtocolVersion,
        updatedAt: now,
      })
      .where(eq(hosts.id, id))
      .returning()
      .get())!;
    await notifyHostMutation(db, notifier, existing, updated);
    return updated;
  } else {
    const row = await db
      .insert(hosts)
      .values({
        id,
        name: input.name,
        type: input.type ?? "persistent",
        connectMachineId: input.connectMachineId ?? null,
        machineProviderId: null,
        resource: null,
        phase: "active",
        suspendedAt: null,
        statusMessage: null,
        suspendRetryAt: null,
        removeRetryAt: null,
        teardownAttempt: 0,
        teardownStatus: null,
        destroyedAt: input.destroyedAt ?? null,
        lastSeenAt: null,
        lastRejectedProtocolVersion: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    await notifier.notifyHost(id, ["host-connected"]);
    return row;
  }
}

export async function markHostSeen(
  db: HostWriteConnection,
  hostId: string,
  at: number = Date.now(),
): Promise<void> {
  await db
    .update(hosts)
    .set({ lastSeenAt: at, updatedAt: at })
    .where(eq(hosts.id, hostId))
    .run();
}

const prepareGetHost = (db: DbQueryConnection) =>
  db
    .select()
    .from(hosts)
    .where(eq(hosts.id, placeholder("id")))
    .prepare();

export async function getHost(db: HostWriteConnection, id: string) {
  return (await prepareCachedQuery(db, prepareGetHost).get({ id })) ?? null;
}

export async function getNonDestroyedHost(db: DbConnection, id: string) {
  return (
    (await db
      .select()
      .from(hosts)
      .where(and(eq(hosts.id, id), isNull(hosts.destroyedAt)))
      .get()) ?? null
  );
}

export async function getNonDestroyedHostByLaunchKey(
  db: HostWriteConnection,
  launchKey: string,
) {
  return (
    (await db
      .select()
      .from(hosts)
      .where(and(eq(hosts.launchKey, launchKey), isNull(hosts.destroyedAt)))
      .get()) ?? null
  );
}

export async function listHosts(db: DbConnection) {
  return await db.select().from(hosts).all();
}

export async function listPublicHosts(
  db: DbConnection,
  options?: { includeCreating?: boolean; type?: HostType },
) {
  return await db
    .select()
    .from(hosts)
    .where(
      and(
        isNull(hosts.destroyedAt),
        ...(options?.includeCreating ? [] : [ne(hosts.phase, "creating")]),
        ...(options?.type ? [eq(hosts.type, options.type)] : []),
      ),
    )
    .all();
}

export async function listHostsByIds(
  db: DbConnection,
  hostIds: readonly string[],
) {
  if (hostIds.length === 0) return [];
  return await db
    .select()
    .from(hosts)
    .where(inArray(hosts.id, [...hostIds]))
    .all();
}

export async function listNonDestroyedHostsByIds(
  db: DbConnection,
  hostIds: readonly string[],
) {
  if (hostIds.length === 0) {
    return [];
  }

  return await db
    .select()
    .from(hosts)
    .where(and(inArray(hosts.id, [...hostIds]), isNull(hosts.destroyedAt)))
    .all();
}

export async function updateHost(
  db: HostWriteConnection,
  notifier: DbNotifier,
  hostId: string,
  input: UpdateHostInput,
) {
  const existing = await getHost(db, hostId);
  if (!existing) {
    return null;
  }

  const now = Date.now();
  await db
    .update(hosts)
    .set({
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.destroyedAt !== undefined
        ? { destroyedAt: input.destroyedAt }
        : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.maxPermissionMode !== undefined
        ? { maxPermissionMode: input.maxPermissionMode }
        : {}),
      ...(input.lastRejectedProtocolVersion !== undefined
        ? { lastRejectedProtocolVersion: input.lastRejectedProtocolVersion }
        : {}),
      ...(input.machineProviderId !== undefined
        ? { machineProviderId: input.machineProviderId }
        : {}),
      ...(input.machineOperationId !== undefined
        ? { machineOperationId: input.machineOperationId }
        : {}),
      ...(input.launchKey !== undefined ? { launchKey: input.launchKey } : {}),
      ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
      ...(input.pendingLog !== undefined
        ? { pendingLog: input.pendingLog }
        : {}),
      ...(input.phase !== undefined ? { phase: input.phase } : {}),
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
      ...(input.removeRetryAt !== undefined
        ? { removeRetryAt: input.removeRetryAt }
        : {}),
      ...(input.suspendedAt !== undefined
        ? { suspendedAt: input.suspendedAt }
        : {}),
      ...(input.statusMessage !== undefined
        ? { statusMessage: input.statusMessage }
        : {}),
      ...(input.suspendRetryAt !== undefined
        ? { suspendRetryAt: input.suspendRetryAt }
        : {}),
      ...(input.teardownAttempt !== undefined
        ? { teardownAttempt: input.teardownAttempt }
        : {}),
      ...(input.teardownStatus !== undefined
        ? { teardownStatus: input.teardownStatus }
        : {}),
      updatedAt: now,
    })
    .where(eq(hosts.id, hostId))
    .run();

  const updated = await getHost(db, hostId);
  await notifyHostMutation(db, notifier, existing, updated);
  return updated;
}
