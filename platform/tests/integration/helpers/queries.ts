import { eq } from "drizzle-orm";
import { events, hostDaemonSessions, type DbConnection } from "@hyperfide/db";

export interface StoredTurnEventRow {
  sequence: number;
  turnId: string | null;
  type: string;
}

export async function readStoredTurnEvents(
  db: DbConnection,
  threadId: string,
): Promise<StoredTurnEventRow[]> {
  return await db
    .select({
      sequence: events.sequence,
      turnId: events.turnId,
      type: events.type,
    })
    .from(events)
    .where(eq(events.threadId, threadId))
    .orderBy(events.sequence)
    .all();
}

export async function readSessionRow(
  db: DbConnection,
  sessionId: string,
): Promise<typeof hostDaemonSessions.$inferSelect | null> {
  return (
    (await db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, sessionId))
      .get()) ?? null
  );
}
