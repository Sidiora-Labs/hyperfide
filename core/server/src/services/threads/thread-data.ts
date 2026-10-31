import {
  canHydrateRetainedEventOutputRowsWithinDataByteLimit,
  findStoredEventRow as findStoredEventRowRecord,
  getLatestThreadOutputEventRow,
  getLatestThreadSystemErrorEventRow,
  hydrateRetainedEventOutputRows,
  listStoredEventRows as listStoredEventRowRecords,
} from "@hyperfide/db";
import type { DbConnection, StoredEventRow } from "@hyperfide/db";
import { toRecord } from "@hyperfide/core-ui";
import { buildThreadEventRow, parseStoredThreadEvent } from "@hyperfide/domain";
import { threadScope, turnScope } from "@hyperfide/domain";
import type {
  ThreadEvent,
  ThreadEventRow,
  ThreadEventScope,
  ThreadEventType,
} from "@hyperfide/domain";
import { ApiError } from "../../errors.js";

const THREAD_EVENT_RESPONSE_DATA_BYTE_LIMIT = 8 * 1024 * 1024;

type StoredEventPayloadRow = Pick<
  StoredEventRow,
  "data" | "sequence" | "threadId" | "type"
>;

interface ListThreadEventRowsArgs {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  order?: "asc" | "desc";
  threadId: string;
  types?: readonly ThreadEventType[];
}

interface FindThreadEventArgs {
  afterSeq?: number;
  threadId: string;
  type: ThreadEventType;
}

export function parseStoredEventPayload(
  row: StoredEventPayloadRow,
): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is not valid JSON`,
    );
  }

  const record = toRecord(data);
  if (!record) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  return record;
}

function parseStoredEventScope(row: StoredEventRow): ThreadEventScope {
  switch (row.scopeKind) {
    case "thread":
      return threadScope();
    case "turn":
      if (row.turnId === null) {
        throw new ApiError(
          500,
          "internal_error",
          `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} has turn scope without turn_id`,
        );
      }
      return turnScope(row.turnId);
    default:
      throw new ApiError(
        500,
        "internal_error",
        `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} has invalid scope_kind`,
      );
  }
}

export function parseStoredEvent(row: StoredEventRow): ThreadEvent {
  return parseStoredThreadEvent({
    type: row.type,
    data: parseStoredEventPayload(row),
    threadId: row.threadId,
    providerThreadId: row.providerThreadId,
    scope: parseStoredEventScope(row),
  });
}

function parseStoredEventRow(row: StoredEventRow): ThreadEventRow {
  return buildThreadEventRow({
    id: row.id,
    scope: parseStoredEventScope(row),
    threadId: row.threadId,
    seq: row.sequence,
    createdAt: row.createdAt,
    event: parseStoredEvent(row),
  });
}

async function hydrateRawThreadEventRows(
  db: DbConnection,
  rows: readonly StoredEventRow[],
): Promise<StoredEventRow[]> {
  if (
    !(await canHydrateRetainedEventOutputRowsWithinDataByteLimit(
      db,
      rows,
      THREAD_EVENT_RESPONSE_DATA_BYTE_LIMIT,
    ))
  ) {
    throw new ApiError(
      413,
      "event_data_too_large",
      "Event response exceeds the 8 MiB limit",
    );
  }
  return await hydrateRetainedEventOutputRows(db, rows);
}

export async function listThreadEventRows(
  db: DbConnection,
  args: ListThreadEventRowsArgs,
): Promise<ThreadEventRow[]> {
  const rows = await listStoredEventRowRecords(db, {
    afterSequence: args.afterSeq,
    beforeSequence: args.beforeSeq,
    limit: args.limit,
    order: args.order,
    threadId: args.threadId,
    types: args.types,
  });
  return (await hydrateRawThreadEventRows(db, rows)).map((row) =>
    parseStoredEventRow(row),
  );
}

export async function findThreadEvent(
  db: DbConnection,
  args: FindThreadEventArgs,
): Promise<ThreadEventRow | null> {
  const row = await findStoredEventRowRecord(db, {
    afterSequence: args.afterSeq,
    threadId: args.threadId,
    type: args.type,
  });
  if (!row) {
    return null;
  }
  const [hydrated] = await hydrateRawThreadEventRows(db, [row]);
  return parseStoredEventRow(hydrated ?? row);
}

export async function getLastThreadOutput(
  db: DbConnection,
  threadId: string,
): Promise<string | null> {
  const row = await getLatestThreadOutputEventRow(db, { threadId });

  if (!row) return null;

  const eventRow = parseStoredEventRow(row);

  if (eventRow.type === "system/manager/user_message") {
    return eventRow.data.text.length > 0 ? eventRow.data.text : null;
  }

  if (
    eventRow.type === "item/completed" &&
    eventRow.data.item.type === "agentMessage" &&
    eventRow.data.item.text.length > 0
  ) {
    return eventRow.data.item.text;
  }

  return null;
}

export async function getLastThreadErrorMessage(
  db: DbConnection,
  threadId: string,
): Promise<string | null> {
  const row = await getLatestThreadSystemErrorEventRow(db, { threadId });
  if (!row) return null;
  const eventRow = parseStoredEventRow(row);
  return eventRow.type === "system/error" ? eventRow.data.message : null;
}
