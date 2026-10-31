import { eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { uiPreferenceDefaults, uiPreferences } from "../schema.js";

export interface StoredUiPreference {
  key: string;
  revision: number;
  valueJson: string;
}

export type ReplaceUiPreferenceResult =
  | { outcome: "updated"; revision: number }
  | { outcome: "conflict"; revision: number };

export async function listStoredUiPreferences(
  db: DbConnection,
): Promise<StoredUiPreference[]> {
  return await db
    .select({
      key: uiPreferences.key,
      revision: uiPreferences.revision,
      valueJson: uiPreferences.valueJson,
    })
    .from(uiPreferences)
    .all();
}

export async function listStoredUiPreferenceDefaults(
  db: DbConnection,
): Promise<{ key: string; valueJson: string }[]> {
  return await db.select().from(uiPreferenceDefaults).all();
}

export async function getStoredUiPreferenceDefault(
  db: DbConnection,
  key: string,
): Promise<string | undefined> {
  return (
    await db
      .select({ valueJson: uiPreferenceDefaults.valueJson })
      .from(uiPreferenceDefaults)
      .where(eq(uiPreferenceDefaults.key, key))
      .get()
  )?.valueJson;
}

async function upsertStoredUiPreference(
  db: DbQueryConnection,
  args: { key: string; revision: number; valueJson: string },
): Promise<void> {
  const updatedAt = Date.now();
  await db
    .insert(uiPreferences)
    .values({
      key: args.key,
      revision: args.revision,
      updatedAt,
      valueJson: args.valueJson,
    })
    .onConflictDoUpdate({
      target: uiPreferences.key,
      set: { revision: args.revision, updatedAt, valueJson: args.valueJson },
    })
    .run();
}

export async function replaceStoredUiPreference(
  db: DbConnection,
  args: { expectedRevision: number; key: string; valueJson: string },
): Promise<ReplaceUiPreferenceResult> {
  return await db.transaction(async (tx) => {
    const current = await tx
      .select({ revision: uiPreferences.revision })
      .from(uiPreferences)
      .where(eq(uiPreferences.key, args.key))
      .get();
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== args.expectedRevision) {
      return { outcome: "conflict", revision: currentRevision };
    }
    const revision = currentRevision + 1;
    await upsertStoredUiPreference(tx, {
      key: args.key,
      revision,
      valueJson: args.valueJson,
    });
    return { outcome: "updated", revision };
  });
}

export async function overwriteStoredUiPreference(
  db: DbConnection,
  args: { key: string; valueJson: string },
): Promise<{ revision: number }> {
  return await db.transaction(async (tx) => {
    const current = await tx
      .select({ revision: uiPreferences.revision })
      .from(uiPreferences)
      .where(eq(uiPreferences.key, args.key))
      .get();
    const revision = (current?.revision ?? 0) + 1;
    await upsertStoredUiPreference(tx, {
      key: args.key,
      revision,
      valueJson: args.valueJson,
    });
    return { revision };
  });
}
