import { and, eq, lt, ne } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { providerModelCatalogs } from "../schema.js";

export type StoredProviderModelCatalog =
  typeof providerModelCatalogs.$inferSelect;

export type ProviderModelCatalogRowKey = Pick<
  StoredProviderModelCatalog,
  "hostId" | "providerId" | "scopeKey"
>;

export async function getStoredProviderModelCatalog(
  db: DbConnection,
  key: ProviderModelCatalogRowKey,
): Promise<StoredProviderModelCatalog | null> {
  return (
    (await db
      .select()
      .from(providerModelCatalogs)
      .where(
        and(
          eq(providerModelCatalogs.hostId, key.hostId),
          eq(providerModelCatalogs.providerId, key.providerId),
          eq(providerModelCatalogs.scopeKey, key.scopeKey),
        ),
      )
      .get()) ?? null
  );
}

export async function replaceStoredProviderModelCatalog(
  db: DbConnection,
  args: {
    row: StoredProviderModelCatalog;
    pruneWorkspaceRowsFetchedBefore: number | null;
  },
): Promise<void> {
  const { row, pruneWorkspaceRowsFetchedBefore } = args;
  await db.transaction(async (tx) => {
    await tx
      .insert(providerModelCatalogs)
      .values(row)
      .onConflictDoUpdate({
        target: [
          providerModelCatalogs.hostId,
          providerModelCatalogs.providerId,
          providerModelCatalogs.scopeKey,
        ],
        set: {
          fingerprint: row.fingerprint,
          modelsJson: row.modelsJson,
          selectedOnlyModelsJson: row.selectedOnlyModelsJson,
          fetchedAt: row.fetchedAt,
        },
      })
      .run();
    if (pruneWorkspaceRowsFetchedBefore !== null) {
      await tx
        .delete(providerModelCatalogs)
        .where(
          and(
            eq(providerModelCatalogs.hostId, row.hostId),
            eq(providerModelCatalogs.providerId, row.providerId),
            ne(providerModelCatalogs.scopeKey, ""),
            lt(
              providerModelCatalogs.fetchedAt,
              pruneWorkspaceRowsFetchedBefore,
            ),
          ),
        )
        .run();
    }
  });
}

export async function deleteStoredProviderModelCatalogsForHost(
  db: DbConnection,
  hostId: string,
): Promise<void> {
  await db
    .delete(providerModelCatalogs)
    .where(eq(providerModelCatalogs.hostId, hostId))
    .run();
}
