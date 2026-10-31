import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  threadScope,
  turnScope,
  type Thread,
  type ThreadEventItemType,
  type ThreadEventType,
} from "@hyperfide/domain";
import {
  createConnection,
  createProject,
  createThread,
  getLatestThreadSequence,
  insertEvents,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";

export type Random = () => number;

export async function observePostgresQueries(
  db: DbConnection,
  run: () => unknown,
  observe: (source: string, rows: number) => void,
): Promise<void> {
  const pool = (
    db.$client as unknown as {
      pool: { query: (...args: any[]) => Promise<any> };
    }
  ).pool;
  const original = pool.query.bind(pool);
  pool.query = async (...args: any[]) => {
    const result = await original(...args);
    const source = String(
      typeof args[0] === "string" ? args[0] : args[0].text,
    ).replaceAll('"platform".', "");
    if (!source.includes("__hyperfide_changes"))
      observe(source, result.rows?.length ?? 0);
    return result;
  };
  try {
    await run();
  } finally {
    pool.query = original;
  }
}

export interface TestThread {
  coldDb: DbConnection;
  db: DbConnection;
  projectId: string;
  thread: Thread;
}

export interface RowSpec {
  data?: Record<string, unknown>;
  itemId?: string | null;
  itemKind?: ThreadEventItemType | null;
  parentToolCallId?: string | null;
  providerThreadId?: string | null;
  turnId?: string | null;
  type: ThreadEventType;
}

export const PROVIDER_THREAD_ID = "provider-memo";

let migratedImage: Buffer | null = null;

async function readMigratedImage(): Promise<Buffer> {
  if (migratedImage === null) {
    const db = await createMigratedConnection();
    migratedImage = db.$client.serialize();
    await db.close();
  }
  return migratedImage;
}

export async function withTestThread(
  run: (testThread: TestThread) => void | Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperfide-timeline-cache-"));
  const file = path.join(dir, "hyperfide.db");
  const postgres = /^postgres(?:ql)?:/.test(
    process.env.HYPERFIDE_DATABASE_URL ?? "",
  );
  if (!postgres) fs.writeFileSync(file, await readMigratedImage());
  const db = postgres
    ? await createMigratedConnection()
    : await createConnection(file);
  const coldDb = await createConnection(postgres ? db.databaseUrl! : file);
  try {
    const host = await upsertHost(db, noopNotifier, {
      name: "timeline-cache-host",
    });
    const { project } = await createProject(db, noopNotifier, {
      name: "timeline-cache-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/memo" },
    });
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });
    await run({ coldDb, db, projectId: project.id, thread });
  } finally {
    await coldDb.close();
    await db.close();
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

export async function appendRows(
  testThread: Pick<TestThread, "db" | "thread">,
  specs: readonly RowSpec[],
): Promise<number> {
  const threadId = testThread.thread.id;
  const start = await getLatestThreadSequence(testThread.db, { threadId });
  await insertEvents(
    testThread.db,
    noopNotifier,
    specs.map((spec, index) => {
      const sequence = start + index + 1;
      const turnId = spec.turnId ?? null;
      return {
        createdAt: 1_800_000_000_000 + sequence * 1_000,
        data: JSON.stringify(spec.data ?? {}),
        itemId: spec.itemId ?? null,
        itemKind: spec.itemKind ?? null,
        parentToolCallId: spec.parentToolCallId ?? null,
        providerThreadId:
          spec.providerThreadId === undefined
            ? turnId === null
              ? null
              : PROVIDER_THREAD_ID
            : spec.providerThreadId,
        scope: turnId === null ? threadScope() : turnScope(turnId),
        sequence,
        threadId,
        type: spec.type,
      };
    }),
  );
  return start + specs.length;
}

export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function randomInteger(
  random: Random,
  min: number,
  max: number,
): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: Random, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) {
    throw new Error("Expected a non-empty choice list");
  }
  return value;
}
