import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings } from "@hyperfide/domain";
import {
  getAppKeybindingOverrides,
  getAppSettings,
  setAppKeybindingOverrides,
  setAppSettings,
  type DbConnection,
} from "../../src/index.js";
import { createMigratedConnection } from "../../src/testing.js";

describe("app settings data", () => {
  let db: DbConnection;

  beforeEach(async () => {
    db = await createMigratedConnection();
  });

  afterEach(async () => {
    await db.close();
  });

  it("defaults archive confirmation to enabled and persists opting out", async () => {
    expect((await getAppSettings(db)).confirmThreadArchive).toBe(true);
    await setAppSettings(db, {
      ...defaultAppSettings,
      confirmThreadArchive: false,
    });
    expect((await getAppSettings(db)).confirmThreadArchive).toBe(false);
  });

  it("preserves the legacy diagnostic preference and lets the new preference override it", async () => {
    await db.$client.exec(
      "INSERT INTO app_settings_values (key, value, updated_at) VALUES ('showUnhandledProviderEvents', 'true', 1)",
    );
    expect((await getAppSettings(db)).showDiagnosticEvents).toBe(true);
    await db.$client.exec(
      "INSERT INTO app_settings_values (key, value, updated_at) VALUES ('showDiagnosticEvents', 'false', 2)",
    );
    expect((await getAppSettings(db)).showDiagnosticEvents).toBe(false);
    await setAppSettings(db, {
      ...defaultAppSettings,
      showDiagnosticEvents: true,
    });
    expect((await getAppSettings(db)).showDiagnosticEvents).toBe(true);
    expect(
      await db.$client
        .prepare(
          "SELECT key FROM app_settings_values WHERE key = 'showUnhandledProviderEvents'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("defaults terminal copy-on-select to enabled and persists opting out", async () => {
    expect((await getAppSettings(db)).terminalCopyOnSelect).toBe(true);
    await setAppSettings(db, {
      ...defaultAppSettings,
      terminalCopyOnSelect: false,
    });
    expect((await getAppSettings(db)).terminalCopyOnSelect).toBe(false);
    await db.$client.exec(
      "UPDATE app_settings_values SET value = '\"invalid\"' WHERE key = 'terminalCopyOnSelect'",
    );
    expect((await getAppSettings(db)).terminalCopyOnSelect).toBe(true);
  });

  it("persists keyboard overrides without clobbering general settings", async () => {
    const overrides = [{ command: "thread.new" as const, shortcut: null }];
    await setAppSettings(db, {
      ...defaultAppSettings,
      showKeyboardHints: false,
      steerActiveThreadOnEnter: true,
      providerOrder: ["pi"],
      defaultProviderId: "pi",
    });
    await setAppKeybindingOverrides(db, overrides);

    expect(await getAppSettings(db)).toEqual({
      ...defaultAppSettings,
      showKeyboardHints: false,
      steerActiveThreadOnEnter: true,
      providerOrder: ["pi"],
      defaultProviderId: "pi",
    });
    expect(await getAppKeybindingOverrides(db)).toEqual(overrides);

    await setAppSettings(db, defaultAppSettings);
    expect(await getAppKeybindingOverrides(db)).toEqual(overrides);
  });

  it("ignores retired keys and falls back per key on an unreadable value", async () => {
    await setAppSettings(db, {
      ...defaultAppSettings,
      steerActiveThreadOnEnter: true,
    });
    await db.$client.exec(`
      INSERT INTO app_settings_values (key, value, updated_at)
      VALUES ('retiredPreference', 'true', 1)
      ON CONFLICT (key) DO UPDATE SET value = 'true';
      UPDATE app_settings_values
      SET value = '"yes"'
      WHERE key = 'showKeyboardHints';
      UPDATE app_settings_values
      SET value = 'not json'
      WHERE key = 'providerOrder';
    `);

    expect(await getAppSettings(db)).toEqual({
      ...defaultAppSettings,
      steerActiveThreadOnEnter: true,
    });
  });
});
