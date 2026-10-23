import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CreateConnectionOptions } from "./connection.js";
import { portablePostgresSql, postgresPlaceholders } from "./postgres-sql.js";
import { Pool, types } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { aliasedTable } from "drizzle-orm/alias";
import {
  Column,
  SQL,
  Table,
  getTableColumns,
  getTableName,
  is,
  sql,
} from "drizzle-orm";
import * as sqliteSchema from "./schema.js";
import * as postgresSchema from "./schema-postgres.js";
import type { DbConnection } from "./async-connection.js";
import { withCommitCallbacks } from "./async-connection.js";

// Milliseconds, counters and aggregate results use the same JS numbers as SQLite.
types.setTypeParser(20, Number);
types.setTypeParser(1700, Number);
const tables = new Map<string, Table>();
const replacements = new Map<unknown, unknown>();
for (const [key, table] of Object.entries(sqliteSchema)) {
  if (!is(table, Table)) continue;
  const pgTable = (postgresSchema as Record<string, unknown>)[key] as Table;
  tables.set(getTableName(table), pgTable);
  replacements.set(table, pgTable);
  const pgColumns = getTableColumns(pgTable);
  for (const [name, column] of Object.entries(getTableColumns(table)))
    replacements.set(column, pgColumns[name]);
}
function translate(value: any): any {
  if (!value || typeof value !== "object") return value;
  if (replacements.has(value)) return replacements.get(value);
  if (is(value, Table) && (value as any)[Symbol.for("drizzle:IsAlias")]) {
    const original = tables.get(
      (value as any)[Symbol.for("drizzle:OriginalName")],
    );
    if (original) {
      const translated = aliasedTable(original, getTableName(value));
      replacements.set(value, translated);
      return translated;
    }
  }
  if (is(value, Column)) {
    const table = translate(value.table);
    if (table) {
      const column = Object.values(getTableColumns(table as Table)).find(
        (c) => c.name === value.name,
      );
      if (column) return column;
    }
  }
  if (is(value, SQL)) {
    const copy = new SQL(value.queryChunks.map(translate));
    const decoder = (
      value as unknown as {
        decoder: { mapFromDriverValue(value: unknown): unknown };
      }
    ).decoder;
    Object.assign(copy, {
      decoder: {
        mapFromDriverValue: (input: unknown) =>
          decoder.mapFromDriverValue(
            typeof input === "boolean" ? Number(input) : input,
          ),
      },
    });
    return copy;
  }
  if (Array.isArray(value)) return value.map(translate);
  if (Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, translate(member)]),
    );
  return value;
}
let preparedId = 0;
function rawRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "boolean" ? Number(value) : value,
    ]),
  );
}
function wrap(value: any): any {
  if (!value || typeof value !== "object") return value;
  return new Proxy(value, {
    get(target, key) {
      if (key === "constructor") return target.constructor;
      if (key === "then")
        return typeof target.then === "function"
          ? target.then.bind(target)
          : undefined;
      if (key === "get")
        return async (params?: Record<string, unknown>) =>
          (
            await (target.execute ? target.execute(params) : target.all(params))
          )[0];
      if (key === "all")
        return async (params?: Record<string, unknown>) =>
          target.execute(params);
      if (key === "run")
        return async (params?: Record<string, unknown>) => {
          const result = await target.execute(params);
          return {
            changes: result.rowCount ?? result.length ?? 0,
            lastInsertRowid: 0,
          };
        };
      if (key === "prepare")
        return () => wrap(target.prepare(`hyperfide_${++preparedId}`));
      const member = Reflect.get(target, key);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) =>
        wrap(member.apply(target, args.map(translate)));
    },
  });
}
export function createPostgresConnection(
  url: string,
  options: CreateConnectionOptions = {},
): DbConnection {
  const active = new AsyncLocalStorage<any>();
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=platform,public -c hyperfide.connection_id=${randomUUID()}`,
    max: 10,
    idleTimeoutMillis: options.postgresIdleTimeoutMs,
  });
  pool.on("connect", (client) => {
    const query = client.query.bind(client);
    client.query = ((...args: any[]) => {
      if (typeof args[0] === "string") args[0] = portablePostgresSql(args[0]);
      else if (args[0]?.text)
        args[0] = { ...args[0], text: portablePostgresSql(args[0].text) };
      const started = options.slowQueryLogger ? performance.now() : 0;
      const finish = () => {
        if (!options.slowQueryLogger) return;
        const durationMs = performance.now() - started;
        const thresholdMs =
          typeof options.slowQueryThresholdMs === "function"
            ? options.slowQueryThresholdMs()
            : (options.slowQueryThresholdMs ?? 100);
        const source = String(
          typeof args[0] === "string" ? args[0] : args[0]?.text,
        );
        if (durationMs >= thresholdMs)
          options.slowQueryLogger.info(
            {
              bindingArgumentCount:
                (typeof args[0] === "string" ? args[1] : args[0]?.values)
                  ?.length ?? 0,
              durationMs,
              cpuDurationMs: 0,
              operation: /^\s*(insert|update|delete)/i.test(source)
                ? "run"
                : "all",
              thresholdMs,
              sql: source.replace(/'(?:''|[^'])*'/g, "?"),
            },
            "Slow database query",
          );
      };
      const callbackIndex = args.length - 1;
      if (typeof args[callbackIndex] === "function") {
        const callback = args[callbackIndex];
        args[callbackIndex] = (...result: unknown[]) => {
          finish();
          callback(...result);
        };
      }
      const result = (query as any)(...args);
      if (result && typeof result.then === "function")
        return result.finally(finish);
      return result;
    }) as typeof client.query;
  });
  const originalQuery = pool.query.bind(pool);
  pool.query = ((...args: any[]) => {
    if (pool.ended || pool.ending)
      throw new Error("PostgreSQL connection is closed");
    if (typeof args[0] === "string") args[0] = portablePostgresSql(args[0]);
    else if (args[0]?.text)
      args[0] = { ...args[0], text: portablePostgresSql(args[0].text) };
    const transaction = active.getStore();
    return transaction
      ? transaction.session.client.query(...args)
      : (originalQuery as any)(...args);
  }) as typeof pool.query;
  const raw = {
    pool,
    get inTransaction() {
      return active.getStore() !== undefined;
    },
    close: () => pool.end(),
    async exec(source: string) {
      await pool.query(portablePostgresSql(source));
    },
    prepare(source: string) {
      const query = async (args: unknown[]) =>
        pool.query(postgresPlaceholders(portablePostgresSql(source)), args);
      return {
        async *iterate(...args: unknown[]) {
          const transaction = active.getStore();
          const client = transaction?.session.client ?? (await pool.connect());
          const cursor = `hyperfide_rows_${randomUUID().replaceAll("-", "")}`;
          try {
            if (!transaction) await client.query("BEGIN");
            await client.query(
              `DECLARE ${cursor} NO SCROLL CURSOR FOR ${postgresPlaceholders(portablePostgresSql(source))}`,
              args,
            );
            for (;;) {
              const result = await client.query(`FETCH 1 FROM ${cursor}`);
              if (!result.rows.length) break;
              yield* result.rows;
            }
          } finally {
            try {
              if (transaction) await client.query(`CLOSE ${cursor}`);
              else await client.query("ROLLBACK");
            } finally {
              if (!transaction) client.release();
            }
          }
        },
        async all(...args: unknown[]) {
          return (await query(args)).rows.map(rawRow);
        },
        async get(...args: unknown[]) {
          const row = (await query(args)).rows[0];
          return row && rawRow(row);
        },
        async run(...args: unknown[]) {
          return { changes: (await query(args)).rowCount ?? 0 };
        },
      };
    },
  };
  const db = drizzle(pool);
  function connection(target: any): any {
    return new Proxy(target, {
      get(object, key) {
        if (
          object === db &&
          active.getStore() &&
          !["$client", "dialect", "close"].includes(String(key))
        )
          object = active.getStore();
        if (key === "databaseUrl") return url;
        if (key === "dialect") return "postgresql";
        if (key === "close") return Reflect.get(object, key) ?? raw.close;
        if (key === "$client") return raw;
        if (["all", "get", "run", "values"].includes(String(key)))
          return async (statement: SQL) => {
            const result = await object.execute(translate(statement));
            if (key === "all") return result.rows.map(rawRow);
            if (key === "get") return result.rows[0] && rawRow(result.rows[0]);
            if (key === "values")
              return result.rows.map((row: Record<string, unknown>) =>
                Object.values(row),
              );
            return { changes: result.rowCount ?? 0 };
          };
        if (key === "transaction")
          return (work: (tx: any) => Promise<unknown>) => {
            if (pool.ended || pool.ending)
              throw new Error(
                "PostgreSQL transaction requested after connection closed",
              );
            return withCommitCallbacks(() =>
              object.transaction(async (tx: any) => {
                // Sequence allocation shares SQLite's writer ordering across connections.
                if (object === db)
                  await tx.execute(
                    sql`SELECT pg_advisory_xact_lock(hashtext('hyperfide.platform.write'))`,
                  );
                return active.run(tx, () => work(connection(tx)));
              }),
            );
          };
        const member = Reflect.get(object, key);
        return typeof member === "function"
          ? (...args: unknown[]) =>
              wrap(member.apply(object, args.map(translate)))
          : member;
      },
    });
  }
  return connection(db) as DbConnection;
}
