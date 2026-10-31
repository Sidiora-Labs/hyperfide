import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  notExists,
  notInArray,
  or,
} from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import {
  installedPlugins,
  pluginArtifacts,
  pluginKv,
  pluginSchedules,
  pluginSettings,
  pluginStateSnapshots,
} from "../schema.js";
import type { PluginKvRow, PluginSettingRow } from "./plugin-storage.js";
import type { PluginScheduleRow } from "./plugin-schedules.js";

export interface PluginStateSnapshotRow {
  id: string;
  pluginId: string;
  fromArtifactId: string | null;
  toArtifactId: string;
  snapshotPath: string;
  databasePath: string | null;
  statePath: string;
  secretsPath: string | null;
  registrationPath: string | null;
  status:
    | "pending"
    | "ready"
    | "rollback-pending"
    | "restoring"
    | "restored"
    | "failed";
  rollbackCandidateVersion: string | null;
  rollbackSourceFingerprint: string | null;
  rollbackHyperfideVersion: string | null;
  rollbackSdkVersion: string | null;
  rollbackDetail: string | null;
  createdAt: number;
  retainedUntil: number;
  updatedAt: number;
}

export async function createPluginStateSnapshot(
  db: DbConnection,
  snapshot: PluginStateSnapshotRow,
): Promise<PluginStateSnapshotRow> {
  await db.insert(pluginStateSnapshots).values(snapshot).run();
  return snapshot;
}

export async function getPluginStateSnapshot(
  db: DbConnection,
  id: string,
): Promise<PluginStateSnapshotRow | undefined> {
  return await db
    .select()
    .from(pluginStateSnapshots)
    .where(eq(pluginStateSnapshots.id, id))
    .get();
}

export async function listPluginStateSnapshots(
  db: DbConnection,
  pluginId?: string,
): Promise<PluginStateSnapshotRow[]> {
  const query = db.select().from(pluginStateSnapshots);
  return await (
    pluginId === undefined
      ? query
      : query.where(eq(pluginStateSnapshots.pluginId, pluginId))
  )
    .orderBy(asc(pluginStateSnapshots.createdAt), asc(pluginStateSnapshots.id))
    .all();
}

export async function listIncompletePluginRollbackSnapshots(
  db: DbConnection,
): Promise<PluginStateSnapshotRow[]> {
  return await db
    .select()
    .from(pluginStateSnapshots)
    .where(
      inArray(pluginStateSnapshots.status, ["rollback-pending", "restoring"]),
    )
    .orderBy(asc(pluginStateSnapshots.createdAt), asc(pluginStateSnapshots.id))
    .all();
}

export async function setPluginStateSnapshotRollbackPending(
  db: DbConnection,
  id: string,
  rollback: {
    candidateVersion: string;
    sourceFingerprint: string;
    hyperfideVersion: string;
    sdkVersion: string;
    detail: string;
    updatedAt: number;
  },
): Promise<boolean> {
  return (
    (
      await db
        .update(pluginStateSnapshots)
        .set({
          status: "rollback-pending",
          rollbackCandidateVersion: rollback.candidateVersion,
          rollbackSourceFingerprint: rollback.sourceFingerprint,
          rollbackHyperfideVersion: rollback.hyperfideVersion,
          rollbackSdkVersion: rollback.sdkVersion,
          rollbackDetail: rollback.detail,
          updatedAt: rollback.updatedAt,
        })
        .where(
          and(
            eq(pluginStateSnapshots.id, id),
            eq(pluginStateSnapshots.status, "ready"),
          ),
        )
        .run()
    ).changes > 0
  );
}

export async function setPluginStateSnapshotStatus(
  db: DbConnection,
  id: string,
  status: PluginStateSnapshotRow["status"],
  updatedAt: number,
): Promise<boolean> {
  return (
    (
      await db
        .update(pluginStateSnapshots)
        .set({ status, updatedAt })
        .where(eq(pluginStateSnapshots.id, id))
        .run()
    ).changes > 0
  );
}

export async function listExpiredPluginStateSnapshots(
  db: DbConnection,
  now: number,
): Promise<PluginStateSnapshotRow[]> {
  return await db
    .select()
    .from(pluginStateSnapshots)
    .where(
      and(
        lte(pluginStateSnapshots.retainedUntil, now),
        notInArray(pluginStateSnapshots.status, [
          "rollback-pending",
          "restoring",
        ]),
      ),
    )
    .orderBy(asc(pluginStateSnapshots.retainedUntil))
    .all();
}

export async function deletePluginStateSnapshot(
  db: DbConnection,
  id: string,
): Promise<boolean> {
  return (
    (
      await db
        .delete(pluginStateSnapshots)
        .where(eq(pluginStateSnapshots.id, id))
        .run()
    ).changes > 0
  );
}

export async function replacePluginSnapshotState(
  db: DbConnection,
  pluginId: string,
  state: {
    kv: PluginKvRow[];
    settings: PluginSettingRow[];
    schedules: PluginScheduleRow[];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(pluginKv).where(eq(pluginKv.pluginId, pluginId)).run();
    await tx
      .delete(pluginSettings)
      .where(eq(pluginSettings.pluginId, pluginId))
      .run();
    await tx
      .delete(pluginSchedules)
      .where(eq(pluginSchedules.pluginId, pluginId))
      .run();
    if (state.kv.length > 0) await tx.insert(pluginKv).values(state.kv).run();
    if (state.settings.length > 0) {
      await tx.insert(pluginSettings).values(state.settings).run();
    }
    if (state.schedules.length > 0) {
      await tx.insert(pluginSchedules).values(state.schedules).run();
    }
  });
}

export async function listGarbageCollectablePluginArtifacts(
  db: DbConnection,
  args: {
    retention: { now: number; cutoff: number } | null;
    pluginId: string | null;
  },
): Promise<Array<typeof pluginArtifacts.$inferSelect>> {
  const activeArtifact = db
    .select({ id: installedPlugins.id })
    .from(installedPlugins)
    .where(eq(installedPlugins.activeArtifactId, pluginArtifacts.id));
  const pendingRollback = inArray(pluginStateSnapshots.status, [
    "rollback-pending",
    "restoring",
  ]);
  const retainingSnapshot = db
    .select({ id: pluginStateSnapshots.id })
    .from(pluginStateSnapshots)
    .where(
      and(
        args.retention === null
          ? pendingRollback
          : or(
              gt(pluginStateSnapshots.retainedUntil, args.retention.now),
              pendingRollback,
            ),
        or(
          eq(pluginStateSnapshots.fromArtifactId, pluginArtifacts.id),
          eq(pluginStateSnapshots.toArtifactId, pluginArtifacts.id),
        ),
      ),
    );
  return await db
    .select()
    .from(pluginArtifacts)
    .where(
      and(
        args.retention === null
          ? undefined
          : lte(pluginArtifacts.updatedAt, args.retention.cutoff),
        args.pluginId === null
          ? undefined
          : eq(pluginArtifacts.pluginId, args.pluginId),
        notExists(activeArtifact),
        notExists(retainingSnapshot),
      ),
    )
    .all();
}
