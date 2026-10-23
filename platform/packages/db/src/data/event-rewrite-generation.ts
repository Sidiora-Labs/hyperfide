import { sql } from "drizzle-orm";
import type { DbConnection } from "../connection.js";

const generationsByThreadId = new Map<string, number>();

export function getThreadEventRewriteGeneration(threadId: string): number {
  return generationsByThreadId.get(threadId) ?? 0;
}

export function bumpThreadEventRewriteGeneration(threadId: string): void {
  generationsByThreadId.set(
    threadId,
    getThreadEventRewriteGeneration(threadId) + 1,
  );
}

export async function getDatabaseDataVersion(
  db: DbConnection,
): Promise<number> {
  if (db.dialect === "postgresql") {
    const row = await db.get<{ version: number }>(
      sql`SELECT coalesce(sum(version), 0) AS version FROM platform.__hyperfide_changes WHERE writer <> current_setting('hyperfide.connection_id')`,
    );
    return Number(row?.version ?? 0);
  }
  const version: unknown = db.$client.pragma("data_version", { simple: true });
  if (typeof version !== "number") {
    throw new Error("PRAGMA data_version did not return a number");
  }
  return version;
}
