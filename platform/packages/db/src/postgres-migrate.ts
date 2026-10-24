import { postgresCompatibilitySql } from "./postgres-sql.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { postgresMigrations } from "./postgres-migrations.generated.js";
import type { Pool } from "pg";
import type { DbConnection } from "./async-connection.js";
export function postgresPool(db: DbConnection): Pool {
  return (db.$client as unknown as { pool: Pool }).pool;
}
export async function migratePostgres(db: DbConnection): Promise<void> {
  const pool = postgresPool(db);
  await pool.query("CREATE SCHEMA IF NOT EXISTS platform");
  await pool.query(postgresCompatibilitySql);
  await new PgDialect().migrate(
    postgresMigrations,
    drizzle(pool)._.session as unknown as Parameters<PgDialect["migrate"]>[1],
    {
      migrationsFolder: "",
      migrationsSchema: "platform",
    },
  );
  await pool.query(
    "CREATE OR REPLACE VIEW platform.thread_search_segments_fts AS SELECT ctid, text FROM platform.thread_search_segments",
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform.__hyperfide_changes (writer text PRIMARY KEY, version bigint NOT NULL);
    CREATE OR REPLACE FUNCTION platform.hyperfide_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO platform.__hyperfide_changes VALUES (current_setting('hyperfide.connection_id'), 1)
      ON CONFLICT (writer) DO UPDATE SET version = __hyperfide_changes.version + 1;
      RETURN NULL;
    END $$;
    CREATE OR REPLACE TRIGGER hyperfide_events_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON platform.events FOR EACH STATEMENT EXECUTE FUNCTION platform.hyperfide_record_change();
  `);
}
