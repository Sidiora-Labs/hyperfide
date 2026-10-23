// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../src/testing.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, it } from "vitest";
import { createConnection, migrate } from "../src/index.js";

it.skipIf(isPostgresTest)(
  "upgrades the merged environment schema and preserves existing hosts",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "hyperfide-machine-upgrade-"));
    writeFileSync(join(directory, "host-id"), "local-host\n");
    const db = await createConnection(join(directory, "hyperfide.db"));
    try {
      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      });
      await db.$client.exec(
        'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
      );
      for (const migration of migrations.slice(0, 115)) {
        for (const statement of migration.sql) await db.$client.exec(statement);
        await db.$client
          .prepare(
            'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
          )
          .run(migration.hash, migration.folderMillis);
      }
      for (const id of ["local-host", "remote-host"])
        await db.$client
          .prepare(
            "INSERT INTO hosts (id, name, type, created_at, updated_at) VALUES (?, ?, 'persistent', 10, 20)",
          )
          .run(id, id);
      await migrate(db);
      expect(
        await db.$client
          .prepare(
            "SELECT id, name, machine_provider_id, phase, created_at, updated_at FROM hosts ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          id: "local-host",
          name: "local-host",
          machine_provider_id: null,
          phase: "active",
          created_at: 10,
          updated_at: 20,
        },
        {
          id: "remote-host",
          name: "remote-host",
          machine_provider_id: "manual",
          phase: "active",
          created_at: 10,
          updated_at: 20,
        },
      ]);
      expect(
        await db.$client
          .prepare("SELECT resource FROM hosts WHERE id = 'remote-host'")
          .get(),
      ).toEqual({
        resource: JSON.stringify({ version: 1, hostId: "remote-host" }),
      });
      expect(
        await db.$client
          .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
          .get(),
      ).toEqual({ count: migrations.length });
      expect(db.$client.pragma("foreign_key_check")).toEqual([]);
      await migrate(db);
      expect(
        await db.$client
          .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
          .get(),
      ).toEqual({ count: migrations.length });
    } finally {
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
