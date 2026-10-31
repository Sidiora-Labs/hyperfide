import type Database from "better-sqlite3";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export interface AsyncPluginDatabase {
  readonly dialect: "sqlite" | "postgresql";
  query<T = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<T[]>;
  execute(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<{ changes: number }>;
  transaction<T>(work: (db: AsyncPluginDatabase) => Promise<T>): Promise<T>;
  migrate(statements: readonly string[]): Promise<void>;
  close(): Promise<void>;
}
export async function createAsyncPluginDatabase(
  source: string | Database.Database,
  pluginId: string,
): Promise<AsyncPluginDatabase> {
  if (typeof source !== "string" || !/^postgres(?:ql)?:/.test(source)) {
    const NativeDatabase = createRequire(import.meta.url)(
      "better-sqlite3",
    ) as typeof Database;
    const sqlite =
      typeof source === "string" ? new NativeDatabase(source) : source;
    let tail: Promise<unknown> = Promise.resolve();
    const schedule = <T>(nested: boolean, work: () => T): Promise<T> => {
      if (nested) return Promise.resolve().then(work);
      const pending = tail.then(work, work);
      tail = pending.catch(() => {});
      return pending;
    };
    const make = (nested: boolean): AsyncPluginDatabase => ({
      dialect: "sqlite",
      async query<T>(sql: string, parameters: readonly unknown[] = []) {
        return schedule(
          nested,
          () => sqlite.prepare(sql).all(...parameters) as T[],
        );
      },
      async execute(sql: string, parameters: readonly unknown[] = []) {
        return schedule(nested, () => ({
          changes: sqlite.prepare(sql).run(...parameters).changes,
        }));
      },
      transaction<T>(work: (db: AsyncPluginDatabase) => Promise<T>) {
        const run = async () => {
          const marker = `hyperfide_plugin_${++sequence}`;
          sqlite.exec(nested ? `SAVEPOINT ${marker}` : "BEGIN IMMEDIATE");
          try {
            const result = await work(make(true));
            sqlite.exec(nested ? `RELEASE ${marker}` : "COMMIT");
            return result;
          } catch (error) {
            sqlite.exec(nested ? `ROLLBACK TO ${marker}` : "ROLLBACK");
            throw error;
          }
        };
        if (nested) return run();
        const result = tail.then(run, run);
        tail = result.catch(() => {});
        return result;
      },
      async migrate(statements) {
        await migratePlugin(this, statements);
      },
      async close() {
        await tail;
        if (sqlite.open) sqlite.close();
      },
    });
    return make(false);
  }
  const namespace = `hyperfide_plugin_${createHash("sha256").update(pluginId).digest("hex").slice(0, 32)}`;
  const pool = new Pool({
    connectionString: source,
    options: `-c search_path=${namespace},public`,
  });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${namespace}"`);
  const make = (client?: PoolClient): AsyncPluginDatabase => ({
    dialect: "postgresql",
    async query<T>(sql: string, parameters: readonly unknown[] = []) {
      return (await (client ?? pool).query(sql, [...parameters])).rows as T[];
    },
    async execute(sql: string, parameters: readonly unknown[] = []) {
      return {
        changes:
          (await (client ?? pool).query(sql, [...parameters])).rowCount ?? 0,
      };
    },
    async transaction<T>(work: (db: AsyncPluginDatabase) => Promise<T>) {
      const owned = client ?? (await pool.connect());
      const marker = `hyperfide_plugin_${++sequence}`;
      await owned.query(client ? `SAVEPOINT ${marker}` : "BEGIN");
      try {
        const result = await work(make(owned));
        await owned.query(client ? `RELEASE ${marker}` : "COMMIT");
        return result;
      } catch (error) {
        await owned.query(client ? `ROLLBACK TO ${marker}` : "ROLLBACK");
        throw error;
      } finally {
        if (!client) owned.release();
      }
    },
    async migrate(statements) {
      await migratePlugin(this, statements);
    },
    async close() {
      await pool.end();
    },
  });
  return make();
}
let sequence = 0;
async function migratePlugin(
  db: AsyncPluginDatabase,
  statements: readonly string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    if (db.dialect === "postgresql")
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext(current_schema()))",
      );
    await tx.execute(
      "CREATE TABLE IF NOT EXISTS hyperfide_plugin_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL)",
    );
    const rows = await tx.query<{ id: number; hash: string }>(
      "SELECT id, hash FROM hyperfide_plugin_migrations ORDER BY id",
    );
    if (rows.length > statements.length)
      throw new Error("Plugin migrations cannot be removed");
    for (const [id, statement] of statements.entries()) {
      const hash = createHash("sha256").update(statement).digest("hex");
      if (rows[id]) {
        if (rows[id].id !== id || rows[id].hash !== hash)
          throw new Error(`Plugin migration ${id} changed`);
        continue;
      }
      await tx.execute(statement);
      await tx.execute(
        db.dialect === "postgresql"
          ? "INSERT INTO hyperfide_plugin_migrations VALUES ($1, $2)"
          : "INSERT INTO hyperfide_plugin_migrations VALUES (?, ?)",
        [id, hash],
      );
    }
  });
}
