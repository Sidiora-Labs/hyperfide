import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createConnection } from "./connection.js";
import type { CreateConnectionOptions, DbConnection } from "./connection.js";
import { migrate } from "./migrate.js";

export const isPostgresTest = /^postgres(?:ql)?:/.test(
  process.env.HYPERFIDE_DATABASE_URL ?? "",
);
let migratedTemplate: Buffer | undefined;
let postgresTemplate: Promise<string> | undefined;
const testConnections = new Set<() => Promise<void>>();
export async function closeTestConnections(): Promise<void> {
  for (const close of [...testConnections]) await close();
}
async function preparePostgresTemplate(): Promise<string> {
  const inherited = process.env.HYPERFIDE_TEST_PG_TEMPLATE;
  if (inherited) return inherited;
  postgresTemplate ??= (async () => {
    const admin = new Pool({
      connectionString: process.env.HYPERFIDE_DATABASE_URL,
      max: 1,
      idleTimeoutMillis: 0,
    });
    const name = `hyperfide_template_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.HYPERFIDE_DATABASE_URL!);
    url.pathname = `/${name}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const db = createConnection(url.toString());
    try {
      await migrate(db);
    } finally {
      await db.close();
      await admin.end();
    }
    process.env.HYPERFIDE_TEST_PG_TEMPLATE = name;
    return name;
  })();
  return postgresTemplate;
}
let templatePending: Promise<void> | undefined;
export async function prepareMigratedConnectionTemplate(): Promise<void> {
  if (isPostgresTest) {
    await preparePostgresTemplate();
    return;
  }
  templatePending ??= (async () => {
    const db = createConnection(":memory:");
    try {
      await migrate(db);
      migratedTemplate = db.$client.serialize();
    } finally {
      await db.close();
    }
  })();
  await templatePending;
}
export async function createMigratedConnection(
  options: CreateConnectionOptions = {},
): Promise<DbConnection> {
  if (!isPostgresTest) {
    await prepareMigratedConnectionTemplate();
    return createConnection(migratedTemplate!, options);
  }
  // Each fixture owns a database; parallel tests cannot delete each other's rows.
  const admin = new Pool({
    connectionString: process.env.HYPERFIDE_DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 0,
  });
  const name = `hyperfide_test_${randomUUID().replaceAll("-", "")}`;
  const template = await preparePostgresTemplate();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  const url = new URL(process.env.HYPERFIDE_DATABASE_URL!);
  url.pathname = `/${name}`;
  const db = createConnection(url.toString(), {
    ...options,
    postgresIdleTimeoutMs: 0,
  });
  const close = db.close.bind(db);
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    testConnections.delete(cleanup);
    await close();
    try {
      // Pool.end closes sockets before PostgreSQL necessarily detaches backends.
      for (let attempt = 0; ; attempt++) {
        try {
          await admin.query(`DROP DATABASE "${name}"`);
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== "55006" || attempt >= 20)
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    } finally {
      await admin.end();
    }
  };
  db.$client.close = cleanup as unknown as typeof db.$client.close;
  db.close = cleanup;
  testConnections.add(cleanup);
  try {
    return db;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export async function setupMigratedConnectionTemplate(): Promise<() => void> {
  await prepareMigratedConnectionTemplate();
  return () => {};
}
