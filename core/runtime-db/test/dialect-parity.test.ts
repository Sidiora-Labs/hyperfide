import { describe, expect, it } from "vitest";
import { Table, getTableColumns, getTableName, is, sql } from "drizzle-orm";
import * as sqlite from "../src/schema.js";
import * as postgres from "../src/schema-postgres.js";
import { createMigratedConnection } from "../src/testing.js";
import { countAppliedMigrations, migrate } from "../src/migrate.js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { postgresMigrations } from "../src/postgres-migrations.generated.js";

function shape(schema: Record<string, unknown>) {
  return Object.values(schema)
    .filter((value) => is(value, Table))
    .map((table) => ({
      name: getTableName(table),
      columns: Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
describe("storage dialect contract", () => {
  it("bundles the same PostgreSQL migration journal used by the source package", () => {
    expect(postgresMigrations).toEqual(
      readMigrationFiles({
        migrationsFolder: fileURLToPath(
          new URL("../drizzle-postgres", import.meta.url),
        ),
      }),
    );
  });
  it("keeps PostgreSQL and SQLite tables and columns in step", () => {
    expect(shape(postgres)).toEqual(shape(sqlite));
  });
  it("applies the migration journal once and creates every declared column", async () => {
    const db = await createMigratedConnection();
    try {
      const applied = await countAppliedMigrations(db);
      expect(applied).toBeGreaterThan(0);
      await migrate(db);
      expect(await countAppliedMigrations(db)).toBe(applied);
      for (const table of shape(sqlite)) {
        const rows =
          db.dialect === "postgresql"
            ? await db.all<{ name: string }>(
                sql`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = ${table.name}`,
              )
            : await db.all<{ name: string }>(
                sql.raw(`PRAGMA table_info("${table.name}")`),
              );
        expect(rows.map((row) => row.name).sort(), table.name).toEqual(
          table.columns,
        );
      }
    } finally {
      await db.close();
    }
  });
});
