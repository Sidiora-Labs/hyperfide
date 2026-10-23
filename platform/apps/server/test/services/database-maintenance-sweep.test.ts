// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "@hyperfide/db/testing";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createThread,
  DATABASE_MAINTENANCE_BUSY_TIMEOUT_MS,
  type DbConnection,
  type SlowDbQueryLogFields,
  type SlowDbQueryLogger,
  getDatabaseAutoVacuumMode,
  getDatabaseFreelistStats,
  listDeferredLegacyTables,
  migrate,
  noopNotifier,
  upsertHost,
} from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";
import type { ServerLogger } from "../../src/types.js";
import { runDatabaseMaintenanceSweep } from "../../src/services/system/periodic-sweeps.js";
import { testLogger } from "../helpers/test-app.js";

const FREELIST_ROW_COUNT = 1_200;
const SQLITE_BUSY_HEADROOM_MS = 1_000;
const TEST_DEFERRED_LEGACY_TABLE_NAMES = [
  "client_turn_requests",
  "environment_operations",
  "host_daemon_command_attempts",
  "host_daemon_commands",
  "project_operations",
  "thread_operations",
];

interface TempDatabasePath {
  dbPath: string;
  cleanup(): void;
}

class CapturingSlowQueryLogger implements SlowDbQueryLogger {
  debugLogs: SlowDbQueryLogFields[] = [];

  info(fields: SlowDbQueryLogFields): void {
    this.debugLogs.push(fields);
  }

  clear(): void {
    this.debugLogs = [];
  }
}

function createCapturingServerLogger() {
  const warnMessages: string[] = [];
  const logger: ServerLogger = {
    debug(): void {},
    error(): void {},
    info(): void {},
    warn(): void {
      warnMessages.push("warn");
    },
  };

  return { logger, warnMessages };
}

function createTempDatabasePath(): TempDatabasePath {
  const dir = mkdtempSync(join(tmpdir(), "hyperfide-server-db-maintenance-"));
  return {
    cleanup(): void {
      rmSync(dir, { force: true, recursive: true });
    },
    dbPath: join(dir, "hyperfide.db"),
  };
}

async function createLegacyDatabaseFile(dbPath: string): Promise<void> {
  const rawDb = await new Database(dbPath);
  try {
    rawDb.exec("PRAGMA journal_mode = WAL");
    rawDb.exec(
      "CREATE TABLE legacy_seed (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    await rawDb
      .prepare("INSERT INTO legacy_seed (id, value) VALUES (1, ?)")
      .run("legacy-data");
  } finally {
    await rawDb.close();
  }
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function createDeferredLegacyTables(db: DbConnection): Promise<void> {
  for (const tableName of TEST_DEFERRED_LEGACY_TABLE_NAMES) {
    await db.$client
      .prepare(
        `CREATE TABLE ${quoteSqlIdentifier(tableName)} (id TEXT PRIMARY KEY)`,
      )
      .run();
  }
}

async function markDatabaseBusy(db: DbConnection): Promise<void> {
  const host = await upsertHost(db, noopNotifier, {
    name: "maintenance-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "maintenance-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  });
  await createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    status: "active",
  });
}

async function buildFreelist(db: DbConnection): Promise<void> {
  await db.$client.exec(
    "CREATE TABLE scratch_blobs (id INTEGER PRIMARY KEY, blob TEXT)",
  );
  const insert = db.$client.prepare(
    "INSERT INTO scratch_blobs (blob) VALUES (?)",
  );
  const blob = "x".repeat(8 * 1024);
  const insertMany = db.$client.transaction((count: number) => {
    for (let index = 0; index < count; index += 1) {
      insert.run(blob);
    }
  });
  insertMany(FREELIST_ROW_COUNT);
  await db.$client.exec("DELETE FROM scratch_blobs");
}

async function setupBusyDatabaseWithFreelist() {
  const db = await createMigratedConnection();
  await markDatabaseBusy(db);
  await buildFreelist(db);

  return { db };
}

async function setupBusyFileDatabaseWithFreelist(
  tempDatabase: TempDatabasePath,
) {
  const db = await createConnection(tempDatabase.dbPath);
  await migrate(db);
  await markDatabaseBusy(db);
  await buildFreelist(db);

  return { db };
}

describe.skipIf(isPostgresTest)("runDatabaseMaintenanceSweep", () => {
  it("drops deferred legacy tables on an idle maintenance pass", async () => {
    const db = await createMigratedConnection();
    await createDeferredLegacyTables(db);
    expect(listDeferredLegacyTables(db)).toEqual(
      [...TEST_DEFERRED_LEGACY_TABLE_NAMES].sort(),
    );

    await runDatabaseMaintenanceSweep({ db, logger: testLogger });

    expect(listDeferredLegacyTables(db)).toEqual([]);
  });

  it("skips deferred legacy table cleanup while app work is active", async () => {
    const { db } = await setupBusyDatabaseWithFreelist();
    await createDeferredLegacyTables(db);

    await runDatabaseMaintenanceSweep({ db, logger: testLogger });

    expect(listDeferredLegacyTables(db)).toEqual(
      [...TEST_DEFERRED_LEGACY_TABLE_NAMES].sort(),
    );
  });

  it("skips busy legacy databases before dbstat or full maintenance", async () => {
    const tempDatabase = createTempDatabasePath();
    try {
      await createLegacyDatabaseFile(tempDatabase.dbPath);
      const slowQueryLogger = new CapturingSlowQueryLogger();
      const db = await createConnection(tempDatabase.dbPath, {
        slowQueryLogger,
        slowQueryThresholdMs: 0,
      });
      try {
        await migrate(db);
        expect(getDatabaseAutoVacuumMode(db)).toBe("none");
        await markDatabaseBusy(db);
        await buildFreelist(db);
        const before = getDatabaseFreelistStats(db);
        slowQueryLogger.clear();

        await runDatabaseMaintenanceSweep({ db, logger: testLogger });

        expect(getDatabaseAutoVacuumMode(db)).toBe("none");
        expect(getDatabaseFreelistStats(db).freelistCount).toBe(
          before.freelistCount,
        );
        expect(
          slowQueryLogger.debugLogs.some((log) => log.sql.includes("dbstat")),
        ).toBe(false);
      } finally {
        await db.close();
      }
    } finally {
      tempDatabase.cleanup();
    }
  });

  it("vacuums in chunks and yields to the event loop between them", async () => {
    const { db } = await setupBusyDatabaseWithFreelist();
    const before = getDatabaseFreelistStats(db);
    expect(before.freelistCount).toBeGreaterThan(512);
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });

    await runDatabaseMaintenanceSweep({ db, logger: testLogger });

    expect(yielded).toBe(true);
    expect(getDatabaseFreelistStats(db).freelistCount).toBeLessThan(
      before.freelistCount - 256,
    );
  });

  it.skipIf(isPostgresTest)(
    "does not wait on a WAL reader during incremental maintenance",
    async () => {
      const tempDatabase = createTempDatabasePath();
      try {
        const { db } = await setupBusyFileDatabaseWithFreelist(tempDatabase);
        const readerDb = await new Database(tempDatabase.dbPath, {
          readonly: true,
        });
        let readerTransactionOpen = false;
        try {
          readerDb.exec("BEGIN");
          readerTransactionOpen = true;
          await readerDb.prepare("SELECT COUNT(*) FROM scratch_blobs").get();
          const before = getDatabaseFreelistStats(db);
          const startedAt = performance.now();

          await runDatabaseMaintenanceSweep({ db, logger: testLogger });

          const elapsedMs = performance.now() - startedAt;
          expect(elapsedMs).toBeLessThan(
            DATABASE_MAINTENANCE_BUSY_TIMEOUT_MS + SQLITE_BUSY_HEADROOM_MS,
          );
          expect(getDatabaseFreelistStats(db).freelistCount).toBeLessThan(
            before.freelistCount,
          );
        } finally {
          if (readerTransactionOpen) {
            readerDb.exec("ROLLBACK");
          }
          await readerDb.close();
          await db.close();
        }
      } finally {
        tempDatabase.cleanup();
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "returns quickly when a WAL writer blocks incremental maintenance",
    async () => {
      const tempDatabase = createTempDatabasePath();
      try {
        const { db } = await setupBusyFileDatabaseWithFreelist(tempDatabase);
        const writerDb = await new Database(tempDatabase.dbPath);
        let writerTransactionOpen = false;
        try {
          writerDb.exec("BEGIN IMMEDIATE");
          writerTransactionOpen = true;
          const before = getDatabaseFreelistStats(db);
          const { logger, warnMessages } = createCapturingServerLogger();
          const startedAt = performance.now();

          await runDatabaseMaintenanceSweep({ db, logger });

          const elapsedMs = performance.now() - startedAt;
          expect(elapsedMs).toBeLessThan(
            DATABASE_MAINTENANCE_BUSY_TIMEOUT_MS + SQLITE_BUSY_HEADROOM_MS,
          );
          expect(warnMessages).toHaveLength(1);
          expect(getDatabaseFreelistStats(db).freelistCount).toBe(
            before.freelistCount,
          );
        } finally {
          if (writerTransactionOpen) {
            writerDb.exec("ROLLBACK");
          }
          await writerDb.close();
          await db.close();
        }
      } finally {
        tempDatabase.cleanup();
      }
    },
  );
});
