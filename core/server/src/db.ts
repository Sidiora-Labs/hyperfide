import {
  createConnection,
  ensurePersonalProject,
  migrate,
} from "@hyperfide/db";
import type {
  DbConnection,
  MigrationWarningLogger,
  SlowDbQueryLogger,
} from "@hyperfide/db";
import type { Logger } from "@hyperfide/logger";
import {
  exportLegacyAutomationsForPluginImport,
  hasLegacyAutomationsToExport,
} from "./legacy-automations-export.js";

type InitDbLogger = MigrationWarningLogger &
  SlowDbQueryLogger &
  Pick<Logger, "error" | "info">;

interface InitDbOptions {
  dataDir?: string;
  slowQueryThresholdMs?: number | (() => number);
  slowQueryDiagnosticsEnabled?: () => boolean;
  logger?: InitDbLogger;
}

export async function initDb(
  databasePath: string,
  options: InitDbOptions = {},
): Promise<DbConnection> {
  const db = createConnection(databasePath, {
    slowQueryLogger: options.logger,
    slowQueryThresholdMs: options.slowQueryThresholdMs,
    slowQueryDiagnosticsEnabled: options.slowQueryDiagnosticsEnabled,
  });
  try {
    if (db.dialect === "postgresql") {
      // PostgreSQL has no legacy SQLite installation to export.
    } else if (options.dataDir !== undefined && options.logger !== undefined) {
      exportLegacyAutomationsForPluginImport({
        dataDir: options.dataDir,
        db,
        logger: options.logger,
      });
    } else if (hasLegacyAutomationsToExport(db)) {
      throw new Error(
        "Cannot migrate legacy automations without dataDir and logger; refusing to drop kernel automation rows before exporting them for the automations plugin",
      );
    }
    await migrate(db, { logger: options.logger });
    await ensurePersonalProject(db);
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}
