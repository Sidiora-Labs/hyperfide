import { eq } from "drizzle-orm";
import {
  defaultAppTheme,
  defaultFaviconColor,
  type FaviconColorPreference,
} from "@hyperfide/domain";
import type { DbConnection } from "../connection.js";
import { appTheme } from "../schema.js";

const APP_THEME_ROW_ID = "current";

export async function getStoredThemeId(db: DbConnection): Promise<string> {
  const row = await db
    .select({ themeId: appTheme.themeId })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();

  return row?.themeId ?? defaultAppTheme.themeId;
}

export async function getStoredFaviconColor(
  db: DbConnection,
): Promise<FaviconColorPreference> {
  const row = await db
    .select({ faviconColor: appTheme.faviconColor })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();

  return row?.faviconColor ?? defaultFaviconColor;
}

export async function setStoredAppearance(
  db: DbConnection,
  appearance: { themeId: string; faviconColor: FaviconColorPreference },
): Promise<void> {
  const updatedAt = Date.now();
  const { themeId, faviconColor } = appearance;
  await db
    .insert(appTheme)
    .values({ id: APP_THEME_ROW_ID, themeId, faviconColor, updatedAt })
    .onConflictDoUpdate({
      target: appTheme.id,
      set: { themeId, faviconColor, updatedAt },
    })
    .run();
}
