import { and, asc, eq, lte, notInArray } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { pluginSchedules } from "../schema.js";

export interface PluginScheduleRow {
  pluginId: string;
  name: string;
  cron: string;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: "running" | "ok" | "error" | null;
  lastError: string | null;
  updatedAt: number;
}

export async function upsertPluginSchedule(
  db: DbConnection,
  args: { pluginId: string; name: string; cron: string; nextRunAt: number },
): Promise<void> {
  const updatedAt = Date.now();
  await db
    .insert(pluginSchedules)
    .values({ ...args, updatedAt })
    .onConflictDoUpdate({
      target: [pluginSchedules.pluginId, pluginSchedules.name],
      set: { cron: args.cron, nextRunAt: args.nextRunAt, updatedAt },
    })
    .run();
}

export async function prunePluginSchedules(
  db: DbConnection,
  pluginId: string,
  keepNames: string[],
): Promise<void> {
  const conditions = [eq(pluginSchedules.pluginId, pluginId)];
  if (keepNames.length > 0) {
    conditions.push(notInArray(pluginSchedules.name, keepNames));
  }
  await db
    .delete(pluginSchedules)
    .where(and(...conditions))
    .run();
}

export async function deletePluginSchedules(
  db: DbConnection,
  pluginId: string,
): Promise<void> {
  await db
    .delete(pluginSchedules)
    .where(eq(pluginSchedules.pluginId, pluginId))
    .run();
}

export async function listPluginSchedules(
  db: DbConnection,
  pluginId?: string,
): Promise<PluginScheduleRow[]> {
  const query = db.select().from(pluginSchedules);
  return await (
    pluginId === undefined
      ? query
      : query.where(eq(pluginSchedules.pluginId, pluginId))
  )
    .orderBy(asc(pluginSchedules.pluginId), asc(pluginSchedules.name))
    .all();
}

export async function listDuePluginSchedules(
  db: DbConnection,
  args: { now: number; limit: number },
): Promise<PluginScheduleRow[]> {
  return await db
    .select()
    .from(pluginSchedules)
    .where(lte(pluginSchedules.nextRunAt, args.now))
    .orderBy(asc(pluginSchedules.nextRunAt), asc(pluginSchedules.pluginId))
    .limit(args.limit)
    .all();
}

export async function claimPluginScheduledRun(
  db: DbConnection,
  args: {
    pluginId: string;
    name: string;
    expectedNextRunAt: number;
    newNextRunAt: number;
    now: number;
  },
): Promise<boolean> {
  const result = await db
    .update(pluginSchedules)
    .set({
      nextRunAt: args.newNextRunAt,
      lastRunAt: args.now,
      lastStatus: "running",
      lastError: null,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(pluginSchedules.pluginId, args.pluginId),
        eq(pluginSchedules.name, args.name),
        eq(pluginSchedules.nextRunAt, args.expectedNextRunAt),
      ),
    )
    .run();
  return result.changes > 0;
}

export async function recordPluginScheduleResult(
  db: DbConnection,
  args: {
    pluginId: string;
    name: string;
    status: "ok" | "error";
    error: string | null;
    now: number;
  },
): Promise<void> {
  await db
    .update(pluginSchedules)
    .set({
      lastStatus: args.status,
      lastError: args.error,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(pluginSchedules.pluginId, args.pluginId),
        eq(pluginSchedules.name, args.name),
      ),
    )
    .run();
}
