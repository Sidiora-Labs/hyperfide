import { and, desc, eq } from "drizzle-orm";
import { type DbConnection, events, promptHistoryEntries } from "@bb/db";
import {
  arePromptHistoryInputsEqual,
  promptInputSchema,
  turnRequestEventDataSchema,
  type PromptHistoryScope,
  type PromptInput,
} from "@bb/domain";
import { z } from "zod";
import { expect } from "vitest";

const storedPromptHistoryInputSchema = z.array(promptInputSchema).min(1);

interface AssertPromptHistoryForTurnRequestArgs {
  db: DbConnection;
  input: PromptInput[];
  scope: PromptHistoryScope;
  threadId: string;
}

export function assertPromptHistoryForTurnRequest(
  args: AssertPromptHistoryForTurnRequestArgs,
): void {
  const turnRequestRows = args.db
    .select({
      data: events.data,
      sequence: events.sequence,
      threadId: events.threadId,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .orderBy(desc(events.sequence))
    .all();

  const turnRequestRow = turnRequestRows.find((row) => {
    const event = turnRequestEventDataSchema.parse(JSON.parse(row.data));
    return arePromptHistoryInputsEqual(event.input, args.input);
  });
  expect(turnRequestRow).toBeDefined();
  if (!turnRequestRow) {
    return;
  }
  expect(turnRequestRow.threadId).toBe(args.threadId);

  const historyRow = args.db
    .select({
      input: promptHistoryEntries.input,
      requestSequence: promptHistoryEntries.requestSequence,
      scope: promptHistoryEntries.scope,
      threadId: promptHistoryEntries.threadId,
    })
    .from(promptHistoryEntries)
    .where(
      and(
        eq(promptHistoryEntries.threadId, args.threadId),
        eq(promptHistoryEntries.scope, args.scope),
        eq(promptHistoryEntries.requestSequence, turnRequestRow.sequence),
      ),
    )
    .get();

  expect(historyRow).toBeDefined();
  if (!historyRow) {
    return;
  }
  expect(historyRow.threadId).toBe(args.threadId);
  expect(historyRow.scope).toBe(args.scope);
  expect(historyRow.requestSequence).toBe(turnRequestRow.sequence);
  expect(
    storedPromptHistoryInputSchema.parse(JSON.parse(historyRow.input)),
  ).toEqual(args.input);
}
