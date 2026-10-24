import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PendingInteractionStatus } from "@hyperfide/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createPendingInteractionId } from "../ids.js";
import { pendingInteractions } from "../schema.js";

type PendingInteractionWriteConnection = DbConnection | DbTransaction;
type PendingInteractionReadConnection = DbConnection | DbTransaction;

export type PendingInteractionRow = typeof pendingInteractions.$inferSelect;

interface CreatePendingInteractionInputBase {
  expiresAt?: number | null;
  payload: string;
  threadId: string;
}

export type CreatePendingInteractionInput =
  | (CreatePendingInteractionInputBase & {
      originKind?: "provider";
      providerId: string;
      providerRequestId: string;
      providerThreadId: string;
      turnId: string;
    })
  | (CreatePendingInteractionInputBase & {
      originKind: "plugin";
      pluginId: string;
      rendererId: string;
      turnId: string | null;
    });

export interface PendingInteractionProviderRequestIdentity {
  providerId: string;
  providerRequestId: string;
  providerThreadId: string;
}

export interface ListPendingInteractionsArgs {
  statuses?: readonly PendingInteractionStatus[];
  threadId: string;
}

export interface SetPendingInteractionTerminalStateArgs {
  allowedCurrentStatuses: readonly PendingInteractionStatus[];
  id: string;
  resolution: string | null;
  status: "interrupted" | "resolved";
  statusReason: string | null;
}

export interface SetPendingInteractionResolvingArgs {
  id: string;
  resolution: string;
}

export interface InterruptPendingInteractionsForThreadsArgs {
  providerId: string;
  statusReason: string;
  threadIds: readonly string[];
}

export interface InterruptPendingInteractionsForThreadIdsArgs {
  statusReason: string;
  threadIds: readonly string[];
}

export interface InterruptPendingInteractionsForPluginArgs {
  pluginId: string;
  statusReason: string;
}

const SQLITE_IN_CLAUSE_BATCH_SIZE = 900;

function sliceInClauseBatches<T>(values: readonly T[]): T[][] {
  const batches: T[][] = [];

  for (
    let offset = 0;
    offset < values.length;
    offset += SQLITE_IN_CLAUSE_BATCH_SIZE
  ) {
    batches.push(values.slice(offset, offset + SQLITE_IN_CLAUSE_BATCH_SIZE));
  }

  return batches;
}

async function updatePendingInteractionTerminalState(
  db: PendingInteractionWriteConnection,
  args: SetPendingInteractionTerminalStateArgs,
): Promise<PendingInteractionRow | null> {
  const now = Date.now();

  return (
    (await db
      .update(pendingInteractions)
      .set({
        status: args.status,
        resolution: args.resolution,
        statusReason: args.statusReason,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(pendingInteractions.id, args.id),
          inArray(pendingInteractions.status, [...args.allowedCurrentStatuses]),
        ),
      )
      .returning()
      .get()) ?? null
  );
}

export async function createPendingInteraction(
  db: PendingInteractionWriteConnection,
  input: CreatePendingInteractionInput,
): Promise<PendingInteractionRow> {
  const now = Date.now();

  return await db
    .insert(pendingInteractions)
    .values({
      id: createPendingInteractionId(),
      threadId: input.threadId,
      originKind: input.originKind ?? "provider",
      turnId: input.turnId,
      providerId: input.originKind !== "plugin" ? input.providerId : null,
      providerThreadId:
        input.originKind !== "plugin" ? input.providerThreadId : null,
      providerRequestId:
        input.originKind !== "plugin" ? input.providerRequestId : null,
      pluginId: input.originKind === "plugin" ? input.pluginId : null,
      rendererId: input.originKind === "plugin" ? input.rendererId : null,
      status: "pending",
      payload: input.payload,
      resolution: null,
      statusReason: null,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
      resolvedAt: null,
      updatedAt: now,
    })
    .returning()
    .get();
}

export async function getPendingInteraction(
  db: PendingInteractionReadConnection,
  id: string,
): Promise<PendingInteractionRow | null> {
  return (
    (await db
      .select()
      .from(pendingInteractions)
      .where(eq(pendingInteractions.id, id))
      .get()) ?? null
  );
}

export async function getPendingInteractionByProviderRequest(
  db: PendingInteractionReadConnection,
  args: PendingInteractionProviderRequestIdentity,
): Promise<PendingInteractionRow | null> {
  return (
    (await db
      .select()
      .from(pendingInteractions)
      .where(
        and(
          eq(pendingInteractions.originKind, "provider"),
          eq(pendingInteractions.providerId, args.providerId),
          eq(pendingInteractions.providerThreadId, args.providerThreadId),
          eq(pendingInteractions.providerRequestId, args.providerRequestId),
        ),
      )
      .get()) ?? null
  );
}

export async function listActivePluginPendingInteractions(
  db: PendingInteractionReadConnection,
): Promise<PendingInteractionRow[]> {
  return await db
    .select()
    .from(pendingInteractions)
    .where(
      and(
        eq(pendingInteractions.originKind, "plugin"),
        inArray(pendingInteractions.status, ["pending", "resolving"]),
      ),
    )
    .orderBy(desc(pendingInteractions.createdAt))
    .all();
}

export async function getActivePendingInteractionForThread(
  db: PendingInteractionReadConnection,
  threadId: string,
): Promise<PendingInteractionRow | null> {
  return (
    (await db
      .select()
      .from(pendingInteractions)
      .where(
        and(
          eq(pendingInteractions.threadId, threadId),
          inArray(pendingInteractions.status, ["pending", "resolving"]),
        ),
      )
      .orderBy(desc(pendingInteractions.createdAt))
      .get()) ?? null
  );
}

export async function hasTurnBoundActivePendingInteractionForThread(
  db: PendingInteractionReadConnection,
  threadId: string,
): Promise<boolean> {
  return (
    (await db
      .select({ id: pendingInteractions.id })
      .from(pendingInteractions)
      .where(
        and(
          eq(pendingInteractions.threadId, threadId),
          inArray(pendingInteractions.status, ["pending", "resolving"]),
          isNotNull(pendingInteractions.turnId),
        ),
      )
      .get()) !== undefined
  );
}

export async function listPendingInteractionsByThread(
  db: PendingInteractionReadConnection,
  args: ListPendingInteractionsArgs,
): Promise<PendingInteractionRow[]> {
  return await db
    .select()
    .from(pendingInteractions)
    .where(
      and(
        eq(pendingInteractions.threadId, args.threadId),
        args.statuses && args.statuses.length > 0
          ? inArray(pendingInteractions.status, [...args.statuses])
          : undefined,
      ),
    )
    .orderBy(desc(pendingInteractions.createdAt))
    .all();
}

export async function setPendingInteractionResolved(
  db: PendingInteractionWriteConnection,
  args: {
    id: string;
    resolution: string;
  },
): Promise<PendingInteractionRow | null> {
  return await updatePendingInteractionTerminalState(db, {
    id: args.id,
    allowedCurrentStatuses: ["pending", "resolving"],
    resolution: args.resolution,
    status: "resolved",
    statusReason: null,
  });
}

export async function setPendingInteractionResolving(
  db: PendingInteractionWriteConnection,
  args: SetPendingInteractionResolvingArgs,
): Promise<PendingInteractionRow | null> {
  const now = Date.now();

  return (
    (await db
      .update(pendingInteractions)
      .set({
        status: "resolving",
        resolution: args.resolution,
        statusReason: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(pendingInteractions.id, args.id),
          eq(pendingInteractions.status, "pending"),
        ),
      )
      .returning()
      .get()) ?? null
  );
}

export async function setPendingInteractionInterrupted(
  db: PendingInteractionWriteConnection,
  args: {
    id: string;
    statusReason: string;
  },
): Promise<PendingInteractionRow | null> {
  return await updatePendingInteractionTerminalState(db, {
    id: args.id,
    allowedCurrentStatuses: ["pending", "resolving"],
    resolution: null,
    status: "interrupted",
    statusReason: args.statusReason,
  });
}

async function interruptPendingInteractionsBatched(
  db: PendingInteractionWriteConnection,
  args: {
    extraConditions: SQL[];
    statusReason: string;
    threadIds: readonly string[];
  },
): Promise<PendingInteractionRow[]> {
  if (args.threadIds.length === 0) {
    return [];
  }

  const now = Date.now();
  const interruptedRows: PendingInteractionRow[] = [];

  for (const threadIdsBatch of sliceInClauseBatches(args.threadIds)) {
    interruptedRows.push(
      ...(await db
        .update(pendingInteractions)
        .set({
          status: "interrupted",
          statusReason: args.statusReason,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            ...args.extraConditions,
            inArray(pendingInteractions.threadId, threadIdsBatch),
            inArray(pendingInteractions.status, ["pending", "resolving"]),
          ),
        )
        .returning()
        .all()),
    );
  }

  return interruptedRows;
}

export async function interruptPendingInteractionsForThreads(
  db: PendingInteractionWriteConnection,
  args: InterruptPendingInteractionsForThreadsArgs,
): Promise<PendingInteractionRow[]> {
  return await interruptPendingInteractionsBatched(db, {
    extraConditions: [
      eq(pendingInteractions.originKind, "provider"),
      eq(pendingInteractions.providerId, args.providerId),
    ],
    statusReason: args.statusReason,
    threadIds: args.threadIds,
  });
}

export async function interruptPendingInteractionsForPlugin(
  db: PendingInteractionWriteConnection,
  args: InterruptPendingInteractionsForPluginArgs,
): Promise<PendingInteractionRow[]> {
  const now = Date.now();
  return await db
    .update(pendingInteractions)
    .set({
      status: "interrupted",
      statusReason: args.statusReason,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(pendingInteractions.originKind, "plugin"),
        eq(pendingInteractions.pluginId, args.pluginId),
        inArray(pendingInteractions.status, ["pending", "resolving"]),
      ),
    )
    .returning()
    .all();
}

export async function interruptPendingInteractionsForThreadIds(
  db: PendingInteractionWriteConnection,
  args: InterruptPendingInteractionsForThreadIdsArgs,
): Promise<PendingInteractionRow[]> {
  return await interruptPendingInteractionsBatched(db, {
    extraConditions: [],
    statusReason: args.statusReason,
    threadIds: args.threadIds,
  });
}
