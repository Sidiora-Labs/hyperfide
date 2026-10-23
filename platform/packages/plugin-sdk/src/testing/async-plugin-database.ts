import type Database from "better-sqlite3";
import type { PluginAsyncDatabase } from "../backend-contract.js";
export function asyncPluginDatabase(
  database: Database.Database,
  migrate: (database: Database.Database, statements: string[]) => void,
): PluginAsyncDatabase {
  let nextSavepoint = 0;
  const make = (nested: boolean): PluginAsyncDatabase => ({
    dialect: "sqlite",
    async query<T>(source: string, parameters: readonly unknown[] = []) {
      return database.prepare(source).all(...parameters) as T[];
    },
    async execute(source: string, parameters: readonly unknown[] = []) {
      return { changes: database.prepare(source).run(...parameters).changes };
    },
    async transaction<T>(work: (db: PluginAsyncDatabase) => Promise<T>) {
      const name = `hyperfide_plugin_${++nextSavepoint}`;
      database.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
      try {
        const result = await work(make(true));
        database.exec(nested ? `RELEASE ${name}` : "COMMIT");
        return result;
      } catch (error) {
        database.exec(nested ? `ROLLBACK TO ${name}` : "ROLLBACK");
        throw error;
      }
    },
    async migrate(statements) {
      migrate(database, [...statements]);
    },
    async close() {
      if (database.open) database.close();
    },
  });
  return make(false);
}
