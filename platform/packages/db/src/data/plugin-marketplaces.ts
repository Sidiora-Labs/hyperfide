import { and, asc, eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { pluginMarketplaceIcons, pluginMarketplaces } from "../schema.js";

export type PluginMarketplaceSourceKind = "https" | "git" | "path";

export interface PluginMarketplaceRow {
  name: string;
  sourceKind: PluginMarketplaceSourceKind;
  manifestUrl: string;
  sourceGitRef: string | null;
  sourceGitSubdirectory: string | null;
  sourceGitCommit: string | null;
  manifestJson: string;
  statsJson: string | null;
  etag: string | null;
  lastModified: string | null;
  lastSuccessfulRefreshAt: number | null;
  lastAttemptedRefreshAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type UpsertPluginMarketplaceInput = Omit<
  PluginMarketplaceRow,
  "createdAt" | "updatedAt"
>;

export interface PluginMarketplaceIconRow {
  marketplaceName: string;
  entryId: string;
  sourceUrl: string;
  contentType: string;
  etag: string | null;
  contentHash: string;
  bytes: Buffer;
  updatedAt: number;
}

export type UpsertPluginMarketplaceIconInput = Omit<
  PluginMarketplaceIconRow,
  "updatedAt"
>;

export async function getPluginMarketplace(
  db: DbQueryConnection,
  name: string,
): Promise<PluginMarketplaceRow | undefined> {
  return await db
    .select()
    .from(pluginMarketplaces)
    .where(eq(pluginMarketplaces.name, name))
    .get();
}

export async function listPluginMarketplaces(
  db: DbQueryConnection,
): Promise<PluginMarketplaceRow[]> {
  return await db
    .select()
    .from(pluginMarketplaces)
    .orderBy(asc(pluginMarketplaces.name))
    .all();
}

export async function deletePluginMarketplace(
  db: DbQueryConnection,
  name: string,
): Promise<boolean> {
  await db
    .delete(pluginMarketplaceIcons)
    .where(eq(pluginMarketplaceIcons.marketplaceName, name))
    .run();
  return (
    (
      await db
        .delete(pluginMarketplaces)
        .where(eq(pluginMarketplaces.name, name))
        .run()
    ).changes > 0
  );
}

export async function upsertPluginMarketplace(
  db: DbQueryConnection,
  input: UpsertPluginMarketplaceInput,
): Promise<PluginMarketplaceRow> {
  const now = Date.now();
  const { name, ...columns } = input;
  await db
    .insert(pluginMarketplaces)
    .values({ name, ...columns, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: pluginMarketplaces.name,
      set: { ...columns, updatedAt: now },
    })
    .run();
  const row = await getPluginMarketplace(db, name);
  if (row === undefined) {
    throw new Error(`plugin marketplace "${name}" missing after upsert`);
  }
  return row;
}

export async function recordPluginMarketplaceRefreshFailure(
  db: DbConnection,
  name: string,
  attemptedAt: number,
  error: string,
): Promise<PluginMarketplaceRow | undefined> {
  await db
    .update(pluginMarketplaces)
    .set({
      lastAttemptedRefreshAt: attemptedAt,
      lastError: error,
      updatedAt: attemptedAt,
    })
    .where(eq(pluginMarketplaces.name, name))
    .run();
  return await getPluginMarketplace(db, name);
}

export async function listPluginMarketplaceIcons(
  db: DbQueryConnection,
  marketplaceName: string,
): Promise<PluginMarketplaceIconRow[]> {
  return await db
    .select()
    .from(pluginMarketplaceIcons)
    .where(eq(pluginMarketplaceIcons.marketplaceName, marketplaceName))
    .all();
}

export async function getPluginMarketplaceIcon(
  db: DbQueryConnection,
  marketplaceName: string,
  entryId: string,
): Promise<PluginMarketplaceIconRow | undefined> {
  return await db
    .select()
    .from(pluginMarketplaceIcons)
    .where(
      and(
        eq(pluginMarketplaceIcons.marketplaceName, marketplaceName),
        eq(pluginMarketplaceIcons.entryId, entryId),
      ),
    )
    .get();
}

async function upsertPluginMarketplaceIcon(
  db: DbQueryConnection,
  input: UpsertPluginMarketplaceIconInput,
): Promise<void> {
  const now = Date.now();
  await db
    .insert(pluginMarketplaceIcons)
    .values({ ...input, updatedAt: now })
    .onConflictDoUpdate({
      target: [
        pluginMarketplaceIcons.marketplaceName,
        pluginMarketplaceIcons.entryId,
      ],
      set: {
        sourceUrl: input.sourceUrl,
        contentType: input.contentType,
        etag: input.etag,
        contentHash: input.contentHash,
        bytes: input.bytes,
        updatedAt: now,
      },
    })
    .run();
}

export async function replacePluginMarketplaceIcons(
  db: DbQueryConnection,
  marketplaceName: string,
  icons: readonly UpsertPluginMarketplaceIconInput[],
): Promise<void> {
  await db
    .delete(pluginMarketplaceIcons)
    .where(eq(pluginMarketplaceIcons.marketplaceName, marketplaceName))
    .run();
  for (const icon of icons) await upsertPluginMarketplaceIcon(db, icon);
}
