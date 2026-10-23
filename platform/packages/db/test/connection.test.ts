// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../src/testing.js";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resourceUsage } from "node:process";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createConnection,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_CACHE_SIZE_KIB,
  SQLITE_MMAP_SIZE_BYTES,
  type SlowDbQueryLogger,
  type SlowDbQueryLogFields,
} from "../src/connection.js";
import { createMigratedConnection } from "../src/testing.js";
import { migrate } from "../src/migrate.js";
import { hosts } from "../src/schema.js";

interface LoggedInfo {
  fields: SlowDbQueryLogFields;
  message: string;
}

class CapturingSlowQueryLogger implements SlowDbQueryLogger {
  readonly infoLogs: LoggedInfo[] = [];

  info(fields: SlowDbQueryLogFields, message: string): void {
    this.infoLogs.push({ fields, message });
  }

  clear(): void {
    this.infoLogs.length = 0;
  }
}

function getOnlyInfoLog(logger: CapturingSlowQueryLogger): LoggedInfo {
  expect(logger.infoLogs).toHaveLength(1);
  const infoLog = logger.infoLogs[0];
  if (!infoLog) {
    throw new Error("Expected slow query info log");
  }
  return infoLog;
}

describe.skipIf(isPostgresTest)("createConnection", () => {
  it("distinguishes time waiting inside SQLite from CPU work", async () => {
    const logger = new CapturingSlowQueryLogger();
    const db = await createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
      slowQueryDiagnosticsEnabled: () => true,
    });
    await migrate(db);
    try {
      const signal = new Int32Array(new SharedArrayBuffer(4));
      let insideBefore = resourceUsage();
      let insideAfter = insideBefore;
      db.$client.function("wait_for_io", () => {
        insideBefore = resourceUsage();
        const pages = Buffer.alloc(32 * 1024 * 1024, 1);
        Atomics.wait(signal, 0, 0, 100);
        insideAfter = resourceUsage();
        return 6 + pages[0]!;
      });
      logger.clear();
      const outsideBefore = resourceUsage();
      expect(db.$client.prepare("SELECT wait_for_io() AS value").get()).toEqual(
        { value: 7 },
      );
      const outsideAfter = resourceUsage();
      const { fields } = getOnlyInfoLog(logger);
      expect(fields.durationMs).toBeGreaterThanOrEqual(90);
      expect(fields.cpuDurationMs).toBeGreaterThanOrEqual(0);
      expect(fields.durationMs - fields.cpuDurationMs).toBeGreaterThan(50);
      const diagnostics = fields.diagnostics;
      expect(diagnostics).toBeDefined();
      if (!diagnostics) throw new Error("Expected diagnostic attribution");
      for (const key of [
        "minorPageFault",
        "majorPageFault",
        "fsRead",
        "fsWrite",
        "voluntaryContextSwitches",
        "involuntaryContextSwitches",
      ] as const) {
        expect(diagnostics.resourceUsage[key]).toBeGreaterThanOrEqual(
          insideAfter[key] - insideBefore[key],
        );
        expect(diagnostics.resourceUsage[key]).toBeLessThanOrEqual(
          outsideAfter[key] - outsideBefore[key],
        );
      }
      expect(diagnostics.wal).toEqual({ sizeBytes: null, sampledAt: null });
    } finally {
      await db.close();
    }
  });

  it("samples WAL asynchronously and reuses timestamped samples across slow-query bursts", async () => {
    const logger = new CapturingSlowQueryLogger();
    let diagnosticsEnabled = false;
    const directory = mkdtempSync(join(tmpdir(), "hyperfide-wal-sampler-"));
    const databasePath = join(directory, "hyperfide.db");
    const template = await createMigratedConnection();
    writeFileSync(databasePath, template.$client.serialize());
    await template.close();
    const db = await createConnection(databasePath, {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
      slowQueryDiagnosticsEnabled: () => diagnosticsEnabled,
    });
    try {
      await db.$client.exec("CREATE TABLE diagnostic_values (value INTEGER)");
      await db.$client.exec("INSERT INTO diagnostic_values VALUES (0)");
      const update = db.$client.prepare(
        "UPDATE diagnostic_values SET value = value + 1",
      );
      logger.clear();
      update.run();
      expect(getOnlyInfoLog(logger).fields).not.toHaveProperty("diagnostics");
      diagnosticsEnabled = true;
      logger.clear();
      update.run();
      expect(getOnlyInfoLog(logger).fields.diagnostics?.wal).toEqual({
        sizeBytes: null,
        sampledAt: null,
      });
      await expect
        .poll(() => {
          logger.clear();
          update.run();
          return getOnlyInfoLog(logger).fields.diagnostics?.wal.sizeBytes;
        })
        .toBeGreaterThan(0);
      const sample = getOnlyInfoLog(logger).fields.diagnostics!.wal;
      expect(sample.sampledAt).toEqual(expect.any(String));
      for (let i = 0; i < 100; i++) update.run();
      for (const log of logger.infoLogs) {
        expect(log.fields.diagnostics?.wal).toEqual(sample);
      }
      expect(statSync(`${db.$client.name}-wal`).size).toBeGreaterThan(
        sample.sizeBytes!,
      );
      diagnosticsEnabled = false;
      logger.clear();
      update.run();
      expect(getOnlyInfoLog(logger).fields).not.toHaveProperty("diagnostics");
      db.$client.pragma("journal_mode = DELETE");
      await delay(1_050);
      diagnosticsEnabled = true;
      await expect
        .poll(() => {
          logger.clear();
          update.run();
          return getOnlyInfoLog(logger).fields.diagnostics?.wal;
        })
        .toEqual({ sizeBytes: null, sampledAt: expect.any(String) });
    } finally {
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies live thresholds to statements prepared before the setting changed", async () => {
    const logger = new CapturingSlowQueryLogger();
    let thresholdMs = Infinity;
    const db = await createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: () => thresholdMs,
    });
    await migrate(db);
    try {
      const statement = db.$client.prepare("SELECT 1");
      statement.get();
      expect(logger.infoLogs).toHaveLength(0);
      thresholdMs = 0;
      statement.get();
      expect(getOnlyInfoLog(logger).fields.thresholdMs).toBe(0);
      logger.clear();
      thresholdMs = Infinity;
      statement.get();
      expect(logger.infoLogs).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it.each(["default", "deferred", "immediate", "exclusive"] as const)(
    "times complete %s transactions and exec while preserving rollback and receivers",
    async (mode) => {
      const logger = new CapturingSlowQueryLogger();
      const db = await createConnection(":memory:", {
        slowQueryLogger: logger,
        slowQueryThresholdMs: 0,
      });
      await migrate(db);
      try {
        await db.$client.exec("CREATE TABLE diagnostic_values (value TEXT)");
        logger.clear();
        expect(
          db.$client.exec(
            "INSERT INTO diagnostic_values VALUES ('private-value')",
          ),
        ).toBe(db.$client);
        expect(getOnlyInfoLog(logger).fields).toMatchObject({
          operation: "exec",
          sql: "INSERT INTO diagnostic_values VALUES ('?')",
        });
        const nested = db.$client.transaction(() => {
          db.$client.exec(
            "INSERT INTO diagnostic_values VALUES ('rolled-back')",
          );
          throw new Error("rollback nested transaction");
        });
        const transaction = db.$client.transaction(function (
          this: { prefix: string },
          value: string,
        ) {
          db.$client
            .prepare("INSERT INTO diagnostic_values VALUES (?)")
            .run(value);
          expect(() => nested()).toThrow("rollback nested transaction");
          return this.prefix + value;
        });
        logger.clear();
        expect(transaction[mode].call({ prefix: "result:" }, "committed")).toBe(
          "result:committed",
        );
        const transactions = logger.infoLogs.filter(
          (log) => log.fields.operation === "transaction",
        );
        expect(transactions.map((log) => log.fields.sql)).toEqual([
          "TRANSACTION DEFAULT",
          `TRANSACTION ${mode.toUpperCase()}`,
        ]);
        expect(transactions[1]?.fields).toMatchObject({
          bindingArgumentCount: 1,
          cpuDurationMs: expect.any(Number),
          durationMs: expect.any(Number),
        });
        expect(
          db.$client
            .prepare("SELECT value FROM diagnostic_values ORDER BY value")
            .all(),
        ).toEqual([{ value: "committed" }, { value: "private-value" }]);
        expect(transaction.default).toBe(transaction);
        expect(Reflect.get(transaction[mode], "database")).toBe(db.$client);
      } finally {
        await db.close();
      }
    },
  );

  it("logs slow prepared statement executions without parameter values", async () => {
    const logger = new CapturingSlowQueryLogger();
    const db = await createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    db.$client.prepare("SELECT ? AS value").get("sensitive-value");

    const infoLog = getOnlyInfoLog(logger);
    expect(infoLog.message).toBe("Slow DB query");
    expect(infoLog.fields).not.toHaveProperty("diagnostics");
    expect(infoLog.fields.operation).toBe("get");
    expect(infoLog.fields.bindingArgumentCount).toBe(1);
    expect(infoLog.fields.sql).toBe("SELECT ? AS value");
    expect(infoLog.fields.sql).not.toContain("sensitive-value");

    await db.close();
  });

  it("redacts SQL string literals in slow query logs", async () => {
    const logger = new CapturingSlowQueryLogger();
    const db = await createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    db.$client.prepare("SELECT 'sensitive-literal' AS value").get();

    const infoLog = getOnlyInfoLog(logger);
    expect(infoLog.fields.sql).toBe("SELECT '?' AS value");
    expect(infoLog.fields.sql).not.toContain("sensitive-literal");

    await db.close();
  });

  it("logs slow drizzle ORM statement executions", async () => {
    const logger = new CapturingSlowQueryLogger();
    const db = await createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });
    await migrate(db);
    await db
      .insert(hosts)
      .values({
        createdAt: 1,
        id: "host-drizzle",
        name: "Drizzle Host",
        type: "persistent",
        updatedAt: 1,
      })
      .run();
    logger.clear();

    const row = await db
      .select()
      .from(hosts)
      .where(eq(hosts.id, "host-drizzle"))
      .get();

    expect(row?.name).toBe("Drizzle Host");
    const infoLog = getOnlyInfoLog(logger);
    expect(infoLog.message).toBe("Slow DB query");
    expect(infoLog.fields.operation).toBe("get");
    expect(infoLog.fields.bindingArgumentCount).toBe(1);
    expect(infoLog.fields.sql).toContain("from");
    expect(infoLog.fields.sql).toContain("hosts");
    expect(infoLog.fields.sql).not.toContain("host-drizzle");

    await db.close();
  });

  it("keeps truncated slow query SQL within the logged length limit", async () => {
    const logger = new CapturingSlowQueryLogger();
    const db = await createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });
    const longSql = `SELECT '${"x".repeat(1_200)}' AS value, ${"1 OR ".repeat(
      300,
    )} 1`;

    db.$client.prepare(longSql).get();

    const infoLog = getOnlyInfoLog(logger);
    expect(infoLog.fields.sql).toHaveLength(1_000);
    expect(infoLog.fields.sql.endsWith("...")).toBe(true);

    await db.close();
  });

  it("applies the hot-path sqlite pragmas on a file database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hyperfide-db-pragmas-"));
    const db = await createConnection(join(directory, "hyperfide.db"));

    try {
      expect(
        db.$client.prepare("PRAGMA cache_size").get() as {
          cache_size: number;
        },
      ).toEqual({ cache_size: -SQLITE_CACHE_SIZE_KIB });
      expect(
        db.$client.prepare("PRAGMA synchronous").get() as {
          synchronous: number;
        },
      ).toEqual({ synchronous: 1 });
      expect(
        db.$client.prepare("PRAGMA mmap_size").get() as { mmap_size: number },
      ).toEqual({ mmap_size: SQLITE_MMAP_SIZE_BYTES });
      expect(
        db.$client.prepare("PRAGMA busy_timeout").get() as { timeout: number },
      ).toEqual({ timeout: SQLITE_BUSY_TIMEOUT_MS });
      expect(
        db.$client.prepare("PRAGMA journal_mode").get() as {
          journal_mode: string;
        },
      ).toEqual({ journal_mode: "wal" });
    } finally {
      await db.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
