import { eq, inArray, sql } from "drizzle-orm";
import {
  aiServiceSelectionSchema,
  AI_TASKS,
  appKeybindingOverridesSchema,
  appSettingsSchema,
  defaultAiServiceSelections,
  defaultAppSettings,
  disabledProviderIdsSchema,
  pluginPackageJsonSchema,
  type AiServiceSelection,
  type AiServiceSelections,
  type AiTask,
  type AppKeybindingOverrides,
  type AppSettings,
} from "@hyperfide/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { appSettingsValues } from "../schema.js";

const appSettingsKeySchema = appSettingsSchema.keyof();
const appSettingsKeys = appSettingsKeySchema.options;

const KEYBINDING_OVERRIDES_KEY = "keybindingOverrides";
const AI_SERVICE_SELECTIONS_KEY = "aiServiceSelections";
const PLUGIN_SAFE_MODE_KEY = "pluginSafeMode";
const DISABLED_PROVIDER_IDS_KEY = "disabledProviderIds";
const LEGACY_DIAGNOSTIC_EVENTS_KEY = "showUnhandledProviderEvents";
const INSTALL_TURN_NUMBER_KEY = "installTurnNumber";

function parseStoredValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function writeValue(
  db: DbQueryConnection,
  key: string,
  value: unknown,
  updatedAt: number,
): Promise<void> {
  const text = JSON.stringify(value);
  await db
    .insert(appSettingsValues)
    .values({ key, value: text, updatedAt })
    .onConflictDoUpdate({
      target: appSettingsValues.key,
      set: { value: text, updatedAt },
    })
    .run();
}

export async function getAppSettings(db: DbConnection): Promise<AppSettings> {
  const values: Record<string, unknown> = { ...defaultAppSettings };
  const rows = await db
    .select({ key: appSettingsValues.key, value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(
      inArray(appSettingsValues.key, [
        ...appSettingsKeys,
        LEGACY_DIAGNOSTIC_EVENTS_KEY,
      ]),
    )
    .all();

  const legacyDiagnosticEvents = rows.find(
    (row) => row.key === LEGACY_DIAGNOSTIC_EVENTS_KEY,
  );
  if (legacyDiagnosticEvents) {
    const parsed = appSettingsSchema.shape.showDiagnosticEvents.safeParse(
      parseStoredValue(legacyDiagnosticEvents.value),
    );
    if (parsed.success) values.showDiagnosticEvents = parsed.data;
  }

  for (const row of rows) {
    const key = appSettingsKeySchema.safeParse(row.key);
    if (!key.success) continue;
    const value = appSettingsSchema.shape[key.data].safeParse(
      parseStoredValue(row.value),
    );
    if (value.success) values[key.data] = value.data;
  }

  return appSettingsSchema.parse(values);
}

export async function setAppSettings(
  db: DbConnection,
  settings: AppSettings,
): Promise<void> {
  const updatedAt = Date.now();
  await db.transaction(async (transaction) => {
    for (const key of appSettingsKeys) {
      await writeValue(transaction, key, settings[key], updatedAt);
    }
    await transaction
      .delete(appSettingsValues)
      .where(eq(appSettingsValues.key, LEGACY_DIAGNOSTIC_EVENTS_KEY))
      .run();
  });
}

export async function getAppKeybindingOverrides(
  db: DbConnection,
): Promise<AppKeybindingOverrides> {
  const row = await db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, KEYBINDING_OVERRIDES_KEY))
    .get();

  if (row === undefined) {
    return [];
  }
  return appKeybindingOverridesSchema.parse(parseStoredValue(row.value));
}

export async function setAppKeybindingOverrides(
  db: DbConnection,
  overrides: AppKeybindingOverrides,
): Promise<void> {
  await writeValue(db, KEYBINDING_OVERRIDES_KEY, overrides, Date.now());
}

export async function getAiServiceSelections(
  db: DbConnection,
): Promise<AiServiceSelections> {
  const row = await db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, AI_SERVICE_SELECTIONS_KEY))
    .get();
  const stored: unknown =
    row === undefined ? undefined : parseStoredValue(row.value);
  const selections: AiServiceSelections = { ...defaultAiServiceSelections };
  if (typeof stored !== "object" || stored === null) return selections;
  for (const task of AI_TASKS) {
    const parsed = aiServiceSelectionSchema.safeParse(
      Reflect.get(stored, task),
    );
    if (parsed.success) selections[task] = parsed.data;
  }
  return selections;
}

export async function setAiServiceSelection(
  db: DbConnection,
  task: AiTask,
  selection: AiServiceSelection,
): Promise<AiServiceSelections> {
  const selections = {
    ...(await getAiServiceSelections(db)),
    [task]: selection,
  };
  await writeValue(db, AI_SERVICE_SELECTIONS_KEY, selections, Date.now());
  return selections;
}

export async function getEarlyAdopter(db: DbConnection): Promise<boolean> {
  const row = await db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, appSettingsKeySchema.enum.earlyAdopter))
    .get();
  return row !== undefined && parseStoredValue(row.value) === true;
}

export async function getPluginSafeMode(db: DbConnection): Promise<boolean> {
  const row = await db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, PLUGIN_SAFE_MODE_KEY))
    .get();
  return row !== undefined && parseStoredValue(row.value) === true;
}

export async function setPluginSafeMode(
  db: DbConnection,
  enabled: boolean,
): Promise<void> {
  await writeValue(db, PLUGIN_SAFE_MODE_KEY, enabled, Date.now());
}

export async function getDisabledProviderIds(
  db: DbConnection,
): Promise<string[]> {
  const row = await db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, DISABLED_PROVIDER_IDS_KEY))
    .get();
  const parsed = disabledProviderIdsSchema.safeParse(
    row === undefined ? [] : parseStoredValue(row.value),
  );
  return parsed.success ? parsed.data : [];
}

export async function setDisabledProviderIds(
  db: DbConnection,
  providerIds: readonly string[],
): Promise<void> {
  await writeValue(db, DISABLED_PROVIDER_IDS_KEY, providerIds, Date.now());
}

const pluginProviderCatalogSchema =
  pluginPackageJsonSchema.shape.bb.shape.experimental_providers
    .unwrap()
    .element.omit({ kind: true })
    .array();

function pluginProviderCatalogKey(pluginId: string): string {
  return `pluginProviders:${pluginId}`;
}

export async function getDisabledPluginProviderCatalog(
  db: DbConnection,
  pluginId: string,
): Promise<Array<{ id: string; displayName: string }>> {
  const row = await db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, pluginProviderCatalogKey(pluginId)))
    .get();
  const parsed = pluginProviderCatalogSchema.safeParse(
    row === undefined ? [] : parseStoredValue(row.value),
  );
  return parsed.success ? parsed.data : [];
}

export async function setDisabledPluginProviderCatalog(
  db: DbConnection,
  pluginId: string,
  providers: Array<{ id: string; displayName: string }>,
): Promise<void> {
  await writeValue(
    db,
    pluginProviderCatalogKey(pluginId),
    providers,
    Date.now(),
  );
}

export async function forgetPluginProviders(
  db: DbConnection,
  pluginId: string,
  providerIds: ReadonlySet<string>,
): Promise<void> {
  const disabledProviderIds = await getDisabledProviderIds(db);
  await db.transaction(async (transaction) => {
    await writeValue(
      transaction,
      DISABLED_PROVIDER_IDS_KEY,
      disabledProviderIds.filter((id) => !providerIds.has(id)),
      Date.now(),
    );
    await transaction
      .delete(appSettingsValues)
      .where(eq(appSettingsValues.key, pluginProviderCatalogKey(pluginId)))
      .run();
  });
}

export async function claimInstallTurnNumber(
  db: DbQueryConnection,
  now: number,
): Promise<number> {
  const row = await db
    .insert(appSettingsValues)
    .values({ key: INSTALL_TURN_NUMBER_KEY, value: "1", updatedAt: now })
    .onConflictDoUpdate({
      target: appSettingsValues.key,
      set: {
        value: sql`CAST(CAST(${appSettingsValues.value} AS INTEGER) + 1 AS TEXT)`,
        updatedAt: now,
      },
    })
    .returning({ value: appSettingsValues.value })
    .get();
  return Number(row!.value);
}
