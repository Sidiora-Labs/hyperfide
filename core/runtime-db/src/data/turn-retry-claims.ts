import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../connection.js";
import { turnRetryClaims } from "../schema.js";

/**
 * Reserve one retry attempt in the database. The composite primary key is the
 * cross-worker fence; process-local sets cannot protect two server workers.
 */
export async function claimTurnRetryInTransaction(
  db: DbTransaction,
  args: {
    threadId: string;
    originalRequestId: string;
    attempt: number;
  },
): Promise<boolean> {
  const result = await db
    .insert(turnRetryClaims)
    .values({ ...args, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

export async function hasTurnRetryClaim(
  db: DbTransaction,
  args: { threadId: string; originalRequestId: string; attempt: number },
): Promise<boolean> {
  return (
    (await db
      .select({ threadId: turnRetryClaims.threadId })
      .from(turnRetryClaims)
      .where(
        and(
          eq(turnRetryClaims.threadId, args.threadId),
          eq(turnRetryClaims.originalRequestId, args.originalRequestId),
          eq(turnRetryClaims.attempt, args.attempt),
        ),
      )
      .limit(1)
      .get()) !== undefined
  );
}
