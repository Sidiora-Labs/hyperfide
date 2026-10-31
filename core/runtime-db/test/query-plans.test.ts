// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../src/testing.js";
import { advanceThreadPruning } from "../src/data/thread-pruning.js";
import {
  findEnvironmentPathClaim,
  listProviderLifecycleEnvironments,
  releaseFinishedEnvironmentPreparationOwners,
} from "../src/data/environments.js";
import { describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  type ClientTurnRequestId,
} from "@hyperfide/domain";
import {
  type DbConnection,
  type SlowDbQueryLogger,
  type SlowDbQueryLogFields,
} from "../src/connection.js";
import { createMigratedConnection } from "../src/testing.js";
import { noopNotifier } from "../src/notifier.js";
import {
  createPendingInteraction,
  getPendingInteractionByProviderRequest,
} from "../src/data/pending-interactions.js";
import {
  appendDaemonEventsInTransaction,
  getFirstParentedTimelineBoundarySequence,
  getTimelineGroupingContextChangesInRange,
  hasStoredSpawnAgentToolCall,
  hasStoredTerminalClientTurnRequestEvent,
  listStoredEventRowsInSequenceRange,
  getLastStoredProviderThreadId,
  insertEvents,
  listActiveBackgroundTaskCountsByThreadIds,
  listItemEventSpansByItems,
  listLatestBackgroundTaskStateRowsByItemIds,
  listOpenTurnInputAcceptedRowsByThreadIds,
  listLatestThreadStateEventRowsByThreadIds,
  listLatestOpenBackgroundTaskStateRowsForThread,
  listOpenBackgroundTaskItemRowsForHost,
  listOpenBackgroundTaskItemRowsForThread,
  listStoredConversationOutlineEventRows,
  listStoredDelegatingItemRowsByItemIds,
  listStoredEventRows,
  listStoredEventRowsByParentToolCallIds,
  listStoredTurnCompletedKeys,
  listTodoSnapshotEventRowsForThread,
} from "../src/data/events.js";
import {
  MAX_COMPLETED_EVENT_OUTPUT_MIGRATION_EVENT_DATA_BYTES,
  migrateNextCompletedEventItemOutput,
  migrateNextLegacyImageGenerationOutput,
  pruneClosedSessions,
} from "../src/data/sweeps.js";
import { COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS } from "../src/retained-event-output.js";
import {
  deleteExpiredRetainedEventOutputs,
  hydrateRetainedEventOutputRows,
} from "../src/data/retained-event-outputs.js";
import { getDatabaseMaintenanceActivity } from "../src/data/maintenance.js";
import { replaceStoredProviderModelCatalog } from "../src/data/provider-model-catalogs.js";
import { openSession } from "../src/data/sessions.js";
import {
  listDueScheduledQueuedThreadMessages,
  listRetryableFailedQueuedThreadMessages,
  listQueuedThreadMessagesByWaitHolder,
} from "../src/data/queued-thread-messages.js";
import { listEnvironments } from "../src/data/environments.js";
import { upsertHost } from "../src/data/hosts.js";
import { createProject } from "../src/data/projects.js";
import {
  createThread,
  listRunningThreads,
  listArchivedThreadsPendingTeardown,
  listThreadsWithPendingInteractionState,
} from "../src/data/threads.js";
import {
  countTerminalSessions,
  listTerminalSessions,
} from "../src/data/terminal-sessions.js";

type SqliteParameter = string | number | bigint | Buffer | null;
type LoggedSqlPredicate = (fields: SlowDbQueryLogFields) => boolean;
type CloseSessionAtParameters = ["closed", number, number, string];

interface CloseSessionAtArgs {
  closedAt: number;
  db: DbConnection;
  sessionId: string;
}

interface LoggedDebug {
  fields: SlowDbQueryLogFields;
  message: string;
}

interface QueryPlanRow {
  detail: string;
  id: number;
  notused: number;
  parent: number;
}

interface IndexNameRow {
  name: string;
}

interface IdentifiedRow {
  id: string;
}

interface TestDb {
  db: DbConnection;
  host: IdentifiedRow;
  logger: CapturingSlowQueryLogger;
  project: IdentifiedRow;
  thread: IdentifiedRow;
}

interface FindOnlyDebugLogArgs {
  logger: CapturingSlowQueryLogger;
  predicate: LoggedSqlPredicate;
}

interface QueryPlanDetailsArgs {
  db: DbConnection;
  params: readonly SqliteParameter[];
  sql: string;
}

interface AssertEmittedQueryPlanUsesIndexArgs {
  db: DbConnection;
  debugLog: LoggedDebug;
  indexName: string;
  params: readonly SqliteParameter[];
}

class CapturingSlowQueryLogger implements SlowDbQueryLogger {
  readonly debugLogs: LoggedDebug[] = [];

  info: SlowDbQueryLogger["info"] = (fields, message) => {
    this.debugLogs.push({ fields, message });
  };

  clear(): void {
    this.debugLogs.length = 0;
  }
}

async function setup(): Promise<TestDb> {
  const logger = new CapturingSlowQueryLogger();
  const db = await createMigratedConnection({
    slowQueryLogger: logger,
    slowQueryThresholdMs: 0,
  });
  const host = await upsertHost(db, noopNotifier, {
    name: "query-plan-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "query-plan-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/query-plan" },
  });
  const thread = await createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  logger.clear();
  return { db, host, logger, project, thread };
}

async function closeSessionAt(args: CloseSessionAtArgs): Promise<void> {
  await args.db.$client
    .prepare<CloseSessionAtParameters>(
      `
        UPDATE host_daemon_sessions
        SET status = ?, closed_at = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .run("closed", args.closedAt, args.closedAt, args.sessionId);
}

function findOnlyDebugLog(args: FindOnlyDebugLogArgs): LoggedDebug {
  const matches = args.logger.debugLogs.filter((debugLog) =>
    args.predicate(debugLog.fields),
  );
  expect(matches.map((debugLog) => debugLog.fields.sql)).toHaveLength(1);
  const debugLog = matches[0];
  if (!debugLog) {
    throw new Error("Expected one matching SQL debug log");
  }
  return debugLog;
}

interface CapturedStatement {
  params: SqliteParameter[];
  sql: string;
}

async function captureStatements(
  db: DbConnection,
  run: () => unknown,
): Promise<CapturedStatement[]> {
  const captured: CapturedStatement[] = [];
  const raw = db.$client;
  const originalPrepare = raw.prepare.bind(raw);
  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = originalPrepare(source);
      const originalAll = statement.all.bind(statement);
      const originalGet = statement.get.bind(statement);
      statement.all = (...params: unknown[]) => {
        captured.push({ params: params as SqliteParameter[], sql: source });
        return originalAll(...params);
      };
      statement.get = (...params: unknown[]) => {
        captured.push({ params: params as SqliteParameter[], sql: source });
        return originalGet(...params);
      };
      return statement;
    },
  });
  try {
    await run();
  } finally {
    Object.defineProperty(raw, "prepare", {
      configurable: true,
      writable: true,
      value: originalPrepare,
    });
  }
  return captured;
}

async function queryPlanDetails(args: QueryPlanDetailsArgs): Promise<string> {
  const planRows = await args.db.$client
    .prepare<SqliteParameter[], QueryPlanRow>(`EXPLAIN QUERY PLAN ${args.sql}`)
    .all(...args.params);
  return planRows.map((row) => row.detail).join("\n");
}

async function assertEmittedQueryPlanUsesIndex(
  args: AssertEmittedQueryPlanUsesIndexArgs,
): Promise<void> {
  expect(args.debugLog.fields.bindingArgumentCount).toBe(args.params.length);
  const details = await queryPlanDetails({
    db: args.db,
    params: args.params,
    sql: args.debugLog.fields.sql,
  });
  expect(
    details.includes(`USING INDEX ${args.indexName}`) ||
      details.includes(`USING COVERING INDEX ${args.indexName}`),
  ).toBe(true);
}

function expectNoThreadOnlyEventSeek(details: string): void {
  expect(details).not.toMatch(
    /USING (?:COVERING )?INDEX events_\w+ \(thread_id=\?\)$/mu,
  );
}

describe.skipIf(isPostgresTest)("slow query index plans", () => {
  it("checks spawn-agent history without reading unrelated event payloads", async () => {
    const { db, thread } = await setup();
    try {
      const captured = await captureStatements(db, async () => {
        expect(await hasStoredSpawnAgentToolCall(db, thread.id)).toBe(false);
      });
      expect(captured).toHaveLength(1);
      expect(await queryPlanDetails({ db, ...captured[0]! })).toContain(
        "USING INDEX events_delegating_item_lookup_idx (thread_id=?)",
      );
      await db.$client
        .prepare(
          `INSERT INTO events
        (id, thread_id, scope_kind, sequence, type, item_kind, data, created_at)
        VALUES (?, ?, 'thread', ?, 'item/started', ?, ?, 0)`,
        )
        .run(
          "ordinary-tool",
          thread.id,
          1,
          "toolCall",
          JSON.stringify({ item: { tool: "exec" } }),
        );
      expect(await hasStoredSpawnAgentToolCall(db, thread.id)).toBe(false);
      await db.$client
        .prepare(
          `INSERT INTO events
        (id, thread_id, scope_kind, sequence, type, item_kind, data, created_at)
        VALUES (?, ?, 'thread', 3, 'item/completed', 'delegation', ?, 0)`,
        )
        .run(
          "delegation",
          thread.id,
          JSON.stringify({ item: { tool: "spawnAgent" } }),
        );
      expect(await hasStoredSpawnAgentToolCall(db, thread.id)).toBe(false);
      await db.$client
        .prepare(
          `INSERT INTO events
        (id, thread_id, scope_kind, sequence, type, item_kind, data, created_at)
        VALUES (?, ?, 'thread', ?, 'item/completed', ?, ?, 0)`,
        )
        .run(
          "spawn-tool",
          thread.id,
          2,
          "toolCall",
          JSON.stringify({ item: { tool: "spawnAgent" } }),
        );
      expect(await hasStoredSpawnAgentToolCall(db, thread.id)).toBe(true);
      expect(await hasStoredSpawnAgentToolCall(db, "other-thread")).toBe(false);
      await db.$client
        .prepare("DELETE FROM events WHERE id = ?")
        .run("spawn-tool");
      expect(await hasStoredSpawnAgentToolCall(db, thread.id)).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("resolves a provider session with two indexed lookups regardless of history length", async () => {
    const { db, thread } = await setup();
    try {
      await insertEvents(
        db,
        noopNotifier,
        Array.from({ length: 50 }, (_, index) => ({
          threadId: thread.id,
          sequence: index + 1,
          scope: threadScope(),
          providerThreadId: "provider-owner-plan",
          type: "thread/identity" as const,
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({ providerThreadId: "provider-owner-plan" }),
        })),
      );
      const captured = await captureStatements(db, async () => {
        expect(await getLastStoredProviderThreadId(db, thread.id)).toBe(
          "provider-owner-plan",
        );
      });
      expect(captured).toHaveLength(2);
      const [identityQuery, ownerQuery] = captured;
      expect(await queryPlanDetails({ db, ...identityQuery! })).toContain(
        "USING INDEX events_thread_type_sequence_idx",
      );
      expect(await queryPlanDetails({ db, ...ownerQuery! })).toContain(
        "USING INDEX events_provider_identity_idx",
      );
    } finally {
      await db.close();
    }
  });

  it("seeks accepted inputs past each thread's latest interruption", async () => {
    const { db, thread } = await setup();
    try {
      const captured = await captureStatements(db, async () => {
        await listOpenTurnInputAcceptedRowsByThreadIds(db, {
          threadIds: [thread.id, "missing"],
        });
      });
      expect(captured).toHaveLength(1);
      const query = captured[0]!;
      expect(await queryPlanDetails({ db, ...query })).toContain(
        "events_thread_type_sequence_idx (thread_id=? AND type=? AND sequence>?)",
      );
    } finally {
      await db.close();
    }
  });

  it.each([null, "/tmp/claimed"])(
    "indexes active environment claims for path %s",
    async (path) => {
      const { db } = await setup();
      const captured = await captureStatements(db, async () => {
        expect(
          await findEnvironmentPathClaim(db, "host_test", path, null),
        ).toBeNull();
      });
      expect(captured).toHaveLength(1);
      const query = captured[0]!;
      const details = await queryPlanDetails({
        db,
        params: query.params,
        sql: query.sql,
      });
      expect(details).toContain("USING INDEX environments_claim_idx");
      expect(details).not.toContain("SCAN environments");
    },
  );

  it("finds due scheduled queued messages through the state due index", async () => {
    const { db } = await setup();

    const captured = await captureStatements(db, async () => {
      expect(await listDueScheduledQueuedThreadMessages(db, 1_000)).toEqual([]);
    });
    expect(captured).toHaveLength(1);
    const details = await queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });
    expect(details).toMatch(/USING INDEX queued_thread_messages_due_idx/u);
    expect(details).not.toMatch(/SCAN queued_thread_messages/u);

    await db.close();
  });

  it("finds retryable failed queued messages through the state retry index", async () => {
    const { db } = await setup();

    const captured = await captureStatements(db, async () => {
      expect(await listRetryableFailedQueuedThreadMessages(db, 1_000)).toEqual(
        [],
      );
    });
    expect(captured).toHaveLength(1);
    const details = await queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });
    expect(details).toMatch(/USING INDEX queued_thread_messages_retry_idx/u);
    expect(details).not.toMatch(/SCAN queued_thread_messages/u);

    await db.close();
  });

  it("finds a plugin's held queued messages through the partial holder index", async () => {
    const { db } = await setup();

    const captured = await captureStatements(db, async () => {
      expect(
        await listQueuedThreadMessagesByWaitHolder(db, "plugin:limiter"),
      ).toEqual([]);
    });
    expect(captured).toHaveLength(1);
    const details = await queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });
    expect(details).toMatch(
      /USING INDEX queued_thread_messages_wait_holder_idx/u,
    );
    expect(details).not.toMatch(/SCAN queued_thread_messages/u);

    await db.close();
  });

  it("finds a provider's own environment through the provider/instance index", async () => {
    const { db } = await setup();

    const captured = await captureStatements(db, async () => {
      expect(
        await listEnvironments(db, {
          environmentProviderId: "git-worktree",
          instanceKey: "thr_1",
          statuses: ["provisioning", "ready", "error"],
        }),
      ).toEqual([]);
    });
    expect(captured).toHaveLength(1);
    const details = await queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });
    expect(details).toMatch(/USING INDEX environments_provider_instance_idx/u);
    expect(details).not.toMatch(/SCAN environments/u);

    await db.close();
  });

  it("finds the occupying threads through the archived/status index", async () => {
    // A dispatch gate calls this on every admission decision, so a plan that
    // degraded to a table scan would put one on every send in the server.
    const { db } = await setup();

    const captured = await captureStatements(db, async () => {
      await listRunningThreads(db);
    });
    expect(captured).toHaveLength(1);
    const details = await queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });
    expect(details).toMatch(/USING INDEX threads_archived_status_idx/u);
    expect(details).not.toMatch(/SCAN threads/u);

    await db.close();
  });

  it.each([
    { afterSequence: undefined, limit: 25, queryCount: 2 },
    { afterSequence: 20, limit: 25, queryCount: 2 },
    { afterSequence: 20, limit: undefined, queryCount: 1 },
  ])(
    "uses the thread/type/sequence index for filtered event pages after $afterSequence with limit $limit",
    async ({ afterSequence, limit, queryCount }) => {
      const { db, thread } = await setup();

      const captured = await captureStatements(db, async () => {
        expect(
          await listStoredEventRows(db, {
            afterSequence,
            beforeSequence: 100,
            limit,
            order: "desc",
            threadId: thread.id,
            types: ["provider/error", "turn/completed"],
          }),
        ).toEqual([]);
      });
      expect(captured).toHaveLength(queryCount);
      for (const query of captured) {
        const details = await queryPlanDetails({
          db,
          params: query.params,
          sql: query.sql,
        });
        expect(details).toMatch(/USING INDEX events_thread_type_sequence_idx/u);
        expect(details).not.toMatch(/events_thread_sequence_idx/u);
      }

      await db.close();
    },
  );

  it("looks up completed turns by thread and turn key", async () => {
    const { db, thread } = await setup();
    await insertEvents(
      db,
      noopNotifier,
      ["turn-plan-1", "turn-plan-2", "turn-plan-3"].flatMap((turnId, index) => [
        {
          threadId: thread.id,
          sequence: index * 2 + 1,
          type: "turn/started" as const,
          scope: turnScope(turnId),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({ providerThreadId: "provider-plan" }),
        },
        ...(turnId === "turn-plan-2"
          ? []
          : [
              {
                threadId: thread.id,
                sequence: index * 2 + 2,
                type: "turn/completed" as const,
                scope: turnScope(turnId),
                itemId: null,
                itemKind: null,
                parentToolCallId: null,
                data: JSON.stringify({
                  providerThreadId: "provider-plan",
                  status: "completed",
                }),
              },
            ]),
      ]),
    );

    const captured = await captureStatements(db, async () => {
      expect(
        await listStoredTurnCompletedKeys(db, {
          keys: [
            { threadId: thread.id, turnId: "turn-plan-1" },
            { threadId: thread.id, turnId: "turn-plan-3" },
          ],
        }),
      ).toEqual([
        { threadId: thread.id, turnId: "turn-plan-1" },
        { threadId: thread.id, turnId: "turn-plan-3" },
      ]);
    });

    const fullChunkCaptured = await captureStatements(db, async () => {
      await listStoredTurnCompletedKeys(db, {
        keys: Array.from({ length: 250 }, (_, index) => ({
          threadId: thread.id,
          turnId: `turn-plan-${index + 1}`,
        })),
      });
    });

    expect(captured).toHaveLength(1);
    expect(fullChunkCaptured).toHaveLength(1);
    for (const query of [captured[0]!, fullChunkCaptured[0]!]) {
      const details = await queryPlanDetails({ db, ...query });
      expect(details).toContain("MULTI-INDEX OR");
      expect(details).toContain(
        "events_thread_turn_type_item_sequence_idx (thread_id=? AND turn_id=? AND type=?)",
      );
      expect(details).not.toContain("turn_id>?");
      expect(details).not.toMatch(/SCAN events/u);
    }

    await db.close();
  });

  it("loads daemon item lifecycle state through the targeted partial index", async () => {
    const { db, logger, thread } = await setup();
    const turnId = "turn-lifecycle-plan";
    const itemId = "item-lifecycle-plan";

    await insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope(turnId),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ providerThreadId: "provider-plan" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/completed",
        scope: turnScope(turnId),
        itemId,
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider-plan",
          item: { type: "agentMessage", id: itemId, text: "done" },
        }),
      },
    ]);

    await db.transaction(
      async (tx) =>
        await appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            environmentId: null,
            type: "item/completed",
            scope: turnScope(turnId),
            itemId,
            itemKind: "agentMessage",
            parentToolCallId: null,
            providerThreadId: "provider-plan",
            data: JSON.stringify({
              providerThreadId: "provider-plan",
              item: { type: "agentMessage", id: itemId, text: "done" },
            }),
          },
        ]),
      { behavior: "immediate" },
    );

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" && fields.sql.includes("requested_item"),
    });
    expect(debugLog.fields.bindingArgumentCount).toBe(2);
    const lifecycleTypes =
      "IN ('item/started', 'item/completed', 'item/backgroundTask/completed')";
    const planSql = debugLog.fields.sql.replaceAll(
      "IN ( '?', '?', '?' )",
      lifecycleTypes,
    );
    const details = await queryPlanDetails({
      db,
      params: [thread.id, itemId],
      sql: planSql,
    });
    expect(
      details.match(/events_item_lifecycle_thread_item_sequence_idx/gu),
    ).toHaveLength(2);

    await db.close();
  });

  it("resolves root turn starts for the parented boundary through the turn index", async () => {
    const { db, thread } = await setup();

    const captured = await captureStatements(db, async () => {
      expect(
        await getFirstParentedTimelineBoundarySequence(db, {
          maxSeq: 10,
          sequenceStart: 0,
          threadId: thread.id,
        }),
      ).toBeNull();
    });
    const query = captured.find((entry) => entry.sql.includes("root_start"));
    if (!query) {
      throw new Error("Expected the parented timeline boundary SQL");
    }
    const details = await queryPlanDetails({
      db,
      params: query.params,
      sql: query.sql,
    });
    expect(details).toMatch(
      /SEARCH root_start (?:EXISTS )?USING (?:COVERING )?INDEX events_thread_turn_type_item_sequence_idx \(thread_id=\? AND turn_id=\? AND type=\?\)/u,
    );
    expect(details).toMatch(
      /SEARCH events USING COVERING INDEX events_parent_tool_call_thread_parent_sequence_idx \(thread_id=\? AND parent_tool_call_id>\?\)/u,
    );
    expect(details.indexOf("SCAN nested_history")).toBeGreaterThanOrEqual(0);
    expect(details.indexOf("SCAN nested_history")).toBeLessThan(
      details.indexOf("INDEX events_delegating_item_lookup_idx"),
    );
    expect(details).toMatch(
      /SEARCH events USING (?:COVERING )?INDEX events_delegating_item_lookup_idx/u,
    );

    await db.close();
  });

  it.each([
    {
      name: "probes appended grouping-context rows",
      run: async (db: DbConnection, threadId: string) =>
        await getTimelineGroupingContextChangesInRange(db, {
          afterSequence: 10,
          threadId,
          throughSequence: 30,
        }),
    },
    {
      name: "lists rows in a sequence range",
      run: async (db: DbConnection, threadId: string) =>
        await listStoredEventRowsInSequenceRange(db, {
          afterSequence: 10,
          limit: 513,
          maxInlineOutputChars: 32_000,
          threadId,
          throughSequence: 30,
        }),
    },
  ])("$name through the thread sequence index", async ({ run }) => {
    const { db, thread } = await setup();

    const [query] = await captureStatements(
      db,
      async () => await run(db, thread.id),
    );
    if (!query) {
      throw new Error("Expected the sequence-range SQL");
    }
    expect((await queryPlanDetails({ db, ...query })).split("\n")).toEqual([
      "SEARCH events USING INDEX events_thread_sequence_idx (thread_id=? AND sequence>? AND sequence<?)",
    ]);

    await db.close();
  });

  it("loads parented timeline rows through the normalized parent index", async () => {
    const { db, thread } = await setup();

    const [query] = await captureStatements(db, async () => {
      expect(
        await listStoredEventRowsByParentToolCallIds(db, {
          maxInlineOutputChars: null,
          parentToolCallIds: ["parent-tool-call"],
          threadId: thread.id,
        }),
      ).toEqual([]);
    });
    if (!query) {
      throw new Error("Expected the parented timeline row lookup SQL");
    }
    expect(
      await queryPlanDetails({ db, params: query.params, sql: query.sql }),
    ).toMatch(
      /SEARCH events USING INDEX events_parent_tool_call_thread_parent_sequence_idx/u,
    );

    await db.close();
  });

  it("seeks each missing delegating parent through the thread-and-item index", async () => {
    const { db, thread } = await setup();
    const lifecycle = [
      ["tool-a", "toolCall", "item/started"],
      ["delegation-b", "delegation", "item/started"],
      ["command-c", "commandExecution", "item/started"],
      ["tool-a", "toolCall", "item/completed"],
      ["command-c", "commandExecution", "item/completed"],
      ["delegation-b", "delegation", "item/completed"],
    ] as const;
    await insertEvents(
      db,
      noopNotifier,
      lifecycle.map(([itemId, itemKind, type], index) => ({
        threadId: thread.id,
        sequence: index + 1,
        type,
        scope: threadScope(),
        itemId,
        itemKind,
        parentToolCallId: null,
        data: JSON.stringify({ item: { id: itemId, type: itemKind } }),
      })),
    );
    const delegatingRows = (
      await listStoredEventRowsInSequenceRange(db, {
        afterSequence: 0,
        limit: lifecycle.length,
        maxInlineOutputChars: 32_000,
        threadId: thread.id,
        throughSequence: lifecycle.length,
      })
    ).filter((row) => row.itemKind !== "commandExecution");

    const [query] = await captureStatements(db, async () => {
      expect(
        await listStoredDelegatingItemRowsByItemIds(db, {
          itemIds: ["delegation-b", "command-c", "tool-a"],
          maxInlineOutputChars: 32_000,
          threadId: thread.id,
        }),
      ).toEqual(delegatingRows);
    });
    if (!query) {
      throw new Error("Expected the delegating item lookup SQL");
    }
    expect(await queryPlanDetails({ db, ...query })).toContain(
      "SEARCH events USING INDEX events_delegating_item_lookup_idx (thread_id=? AND item_id=?)",
    );

    await db.close();
  });

  it("seeks latest background-task and delegation state by item", async () => {
    const { db, thread } = await setup();
    const lifecycle = [
      ["bg-a", "backgroundTask", "item/started"],
      ["delegation-b", "delegation", "item/started"],
      ["bg-a", "backgroundTask", "item/backgroundTask/progress"],
      ["delegation-b", "delegation", "item/delegation/progress"],
      ["command-c", "commandExecution", "item/started"],
      ["bg-a", "backgroundTask", "item/backgroundTask/completed"],
      ["delegation-b", "delegation", "item/delegation/completed"],
    ] as const;
    await insertEvents(
      db,
      noopNotifier,
      lifecycle.map(([itemId, itemKind, type], index) => ({
        threadId: thread.id,
        sequence: index + 1,
        type,
        scope: threadScope(),
        itemId,
        itemKind,
        parentToolCallId: null,
        data: JSON.stringify({ item: { id: itemId, type: itemKind } }),
      })),
    );

    const lookup = async (beforeSequence?: number) =>
      (
        await listLatestBackgroundTaskStateRowsByItemIds(db, {
          beforeSequence,
          itemIds: ["delegation-b", "command-c", "bg-a"],
          threadId: thread.id,
        })
      ).map((row) => [row.itemId, row.type]);
    const [query] = await captureStatements(db, async () => {
      expect(await lookup()).toEqual([
        ["bg-a", "item/backgroundTask/completed"],
        ["delegation-b", "item/delegation/completed"],
      ]);
    });
    expect(await lookup(6)).toEqual([
      ["bg-a", "item/backgroundTask/progress"],
      ["delegation-b", "item/delegation/progress"],
    ]);
    if (!query) {
      throw new Error("Expected the background-task state lookup SQL");
    }
    const details = await queryPlanDetails({ db, ...query });
    expect(details).toContain(
      "SEARCH events USING COVERING INDEX events_background_task_thread_type_item_sequence_idx (thread_id=? AND type=? AND item_id=?)",
    );
    expect(details).toContain(
      "SEARCH events USING INDEX events_delegating_item_lookup_idx (thread_id=? AND item_id=?)",
    );
    expectNoThreadOnlyEventSeek(details);

    await db.close();
  });

  it("probes settled background tasks by item when listing open tasks", async () => {
    const { db, host, thread } = await setup();
    const lifecycle = [
      ["bg-open", "item/started"],
      ["bg-done", "item/started"],
      ["bg-open", "item/backgroundTask/progress"],
      ["bg-done", "item/backgroundTask/completed"],
    ] as const;
    await insertEvents(
      db,
      noopNotifier,
      lifecycle.map(([itemId, type], index) => ({
        threadId: thread.id,
        sequence: index + 1,
        type,
        scope: threadScope(),
        itemId,
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: JSON.stringify({ item: { id: itemId, type: "backgroundTask" } }),
      })),
    );

    const captured = await captureStatements(db, async () => {
      expect(
        (
          await listOpenBackgroundTaskItemRowsForThread(db, {
            threadId: thread.id,
          })
        ).map((row) => row.itemId),
      ).toEqual(["bg-open"]);
      await listOpenBackgroundTaskItemRowsForHost(db, { hostId: host.id });
    });
    expect(captured).toHaveLength(2);
    for (const query of captured) {
      const details = await queryPlanDetails({ db, ...query });
      expect(details).toMatch(
        /SEARCH \w+ USING COVERING INDEX events_background_task_thread_type_item_sequence_idx \(thread_id=\? AND type=\? AND item_id=\?\)/u,
      );
      expectNoThreadOnlyEventSeek(details);
    }

    await db.close();
  });

  it("finds a terminal client turn request event through the type index", async () => {
    const { db, thread } = await setup();
    const acceptedRequestId = encodeClientTurnRequestIdNumber({ value: 1 });
    const rejectedRequestId = encodeClientTurnRequestIdNumber({ value: 2 });
    const pendingRequestId = encodeClientTurnRequestIdNumber({ value: 3 });
    await insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/input/accepted",
        scope: turnScope("turn-1"),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ clientRequestId: acceptedRequestId }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "client/turn/rejected",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ requestId: rejectedRequestId }),
      },
    ]);

    const has = async (requestId: ClientTurnRequestId) =>
      await hasStoredTerminalClientTurnRequestEvent(db, {
        requestId,
        threadId: thread.id,
      });
    const [query] = await captureStatements(db, async () => {
      expect(await has(pendingRequestId)).toBe(false);
    });
    expect(await has(acceptedRequestId)).toBe(true);
    expect(await has(rejectedRequestId)).toBe(true);
    if (!query) {
      throw new Error("Expected the terminal client turn request SQL");
    }
    const details = await queryPlanDetails({ db, ...query });
    expect(details).toContain(
      "SEARCH events USING INDEX events_thread_type_sequence_idx (thread_id=? AND type=?)",
    );
    expectNoThreadOnlyEventSeek(details);

    await db.close();
  });

  it("scans background-task history once without a completed-set join", async () => {
    const { db, thread } = await setup();

    const captured = await captureStatements(db, async () => {
      await listActiveBackgroundTaskCountsByThreadIds(db, {
        threadIds: [thread.id],
      });
    });
    const query = captured.find((entry) =>
      entry.sql.includes("latest_background_task_state"),
    );
    if (!query) {
      throw new Error("Expected the active background-task count SQL");
    }
    expect(query.params).toHaveLength(15);
    const details = await queryPlanDetails({
      db,
      params: query.params,
      sql: query.sql,
    });
    expect(
      details.match(/events_background_task_thread_type_item_sequence_idx/gu),
    ).toHaveLength(1);
    expect(details).not.toMatch(/CORRELATED|LEFT-JOIN|SCAN completed/u);

    await db.close();
  });

  it("uses selective indexes for conversation-outline events", async () => {
    const { db, thread } = await setup();

    const captured = await captureStatements(db, async () => {
      await listStoredConversationOutlineEventRows(db, {
        sequenceStart: 0,
        threadId: thread.id,
      });
    });
    const outline = captured.filter((query) =>
      query.sql.includes('from "events"'),
    );
    expect(outline).toHaveLength(1);
    const [query] = outline;
    expect(query?.params).toEqual([
      thread.id,
      0,
      "client/turn/requested",
      "turn/input/accepted",
      "turn/started",
      "turn/completed",
      "system/manager/user_message",
      "system/thread/interrupted",
      "system/error",
      "provider/error",
      "item/agentMessage/delta",
      "item/plan/delta",
      thread.id,
      0,
      "item/completed",
      "agentMessage",
      "plan",
      thread.id,
      0,
      "item/started",
      "item/completed",
      "item/backgroundTask/progress",
      "item/backgroundTask/completed",
      "backgroundTask",
      "toolCall",
      "item/started",
    ]);
    const details = await queryPlanDetails({
      db,
      params: query?.params ?? [],
      sql: query?.sql ?? "",
    });
    expect(
      details.match(/USING INDEX events_thread_type_sequence_idx/gu),
    ).toHaveLength(1);
    expect(
      details.match(/USING INDEX events_thread_type_item_kind_sequence_idx/gu),
    ).toHaveLength(2);
    expect(details).toMatch(
      /USING INDEX events_item_lifecycle_thread_item_sequence_idx/u,
    );
    expect(details).toMatch(
      /USING COVERING INDEX events_background_task_thread_type_item_sequence_idx/u,
    );
    expect(details).not.toMatch(/SCAN events/u);

    await db.close();
  });

  it("loads the newest plan snapshot through the kind-based plan-steps index", async () => {
    const { db, thread } = await setup();

    const captured = await captureStatements(db, async () => {
      expect(
        await listTodoSnapshotEventRowsForThread(db, { threadId: thread.id }),
      ).toEqual([]);
    });
    const query = captured.find((entry) => entry.sql.includes("planSteps"));
    if (!query) {
      throw new Error("Expected the plan snapshot SQL");
    }
    expect(query.sql).not.toContain("json_extract");
    expect(query.sql).not.toContain("tool_name");
    expect(query.params).toEqual([thread.id, 1]);
    expect(
      await queryPlanDetails({ db, params: query.params, sql: query.sql }),
    ).toContain("events_plan_steps_thread_sequence_idx");

    await db.close();
  });

  it("resolves open background-task state without per-row subqueries", async () => {
    const { db, logger, thread } = await setup();

    await listLatestOpenBackgroundTaskStateRowsForThread(db, {
      threadId: thread.id,
    });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.includes("completed_background_task_state"),
    });
    const params = [
      thread.id,
      thread.id,
      "backgroundTask",
      "item/started",
      "item/backgroundTask/progress",
      thread.id,
      "item/backgroundTask/completed",
    ];
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "events_background_task_thread_type_item_sequence_idx",
      params,
    });

    const details = await queryPlanDetails({
      db,
      params,
      sql: debugLog.fields.sql,
    });
    expect(details).not.toMatch(/CORRELATED/);
    expectNoThreadOnlyEventSeek(details);

    await db.close();
  });

  it("uses the closed-session prune index for emitted delete SQL", async () => {
    const { db, host, logger } = await setup();
    const now = Date.now();
    const staleSession = await openSession(db, {
      hostId: host.id,
      instanceId: "closed-prune-query-plan",
      hostName: "query-plan-host",
      dataDir: "/tmp/query-plan-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    const closedBefore = now - 5_000;
    await closeSessionAt({
      closedAt: now - 10_000,
      db,
      sessionId: staleSession.id,
    });
    logger.clear();

    await pruneClosedSessions(db, { closedBefore, limit: 100 });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith("DELETE FROM host_daemon_sessions"),
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "host_daemon_sessions_closed_prune_idx",
      params: ["closed", closedBefore, 100],
    });
    await db.close();
  });

  it("skips removed environments in the provider lifecycle sweep", async () => {
    const { db } = await setup();
    const captured = await captureStatements(db, async () => {
      expect(
        await listProviderLifecycleEnvironments(db, "git-worktree", {
          pluginId: "environment-git-worktree",
          teardownMessage: "blocked",
        }),
      ).toEqual([]);
    });
    expect(captured).toHaveLength(1);
    const details = await queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });
    expect(details).toContain(
      "USING INDEX environments_provider_lifecycle_idx",
    );
    expect(details).not.toContain("SCAN environments");
    await db.close();
  });

  it("releases preparation owners through the owner index", async () => {
    const { db, logger } = await setup();
    await releaseFinishedEnvironmentPreparationOwners(db);
    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith('update "environments" set "owner_thread_id"'),
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "environments_owner_thread_idx",
      params: [null, "removed"],
    });
    await db.close();
  });

  it("uses the provider request index for pending interaction lookups", async () => {
    const { db, logger, thread } = await setup();
    await createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-provider-request-query-plan",
      providerId: "codex",
      providerThreadId: "provider-thread-query-plan",
      providerRequestId: "request-query-plan",
      payload: "{}",
    });
    logger.clear();

    expect(
      await getPendingInteractionByProviderRequest(db, {
        providerId: "codex",
        providerThreadId: "provider-thread-query-plan",
        providerRequestId: "request-query-plan",
      }),
    ).toMatchObject({
      threadId: thread.id,
    });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.includes('from "pending_interactions"') &&
        fields.sql.includes('"provider_request_id" = ?'),
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "pending_interactions_provider_request_idx",
      params: [
        "provider",
        "codex",
        "provider-thread-query-plan",
        "request-query-plan",
      ],
    });

    await db.close();
  });

  it.each([
    ["agentMessage", "item/agentMessage/delta"],
    ["reasoning", "item/reasoning/textDelta"],
  ] as const)(
    "does not parse %s completion payloads for retention support",
    async (itemKind, deltaType) => {
      const { db, thread } = await setup();
      try {
        await insertEvents(
          db,
          noopNotifier,
          [1, 2, 3].map((sequence) => ({
            data: "{}",
            itemId: "item",
            itemKind: sequence === 3 ? itemKind : null,
            parentToolCallId: null,
            scope: turnScope("support-turn"),
            sequence,
            threadId: thread.id,
            type: sequence === 3 ? "item/completed" : deltaType,
          })),
        );
        const statements = await captureStatements(db, async () => {
          expect(
            (await advanceThreadPruning(db, "resolved-items")).removed,
          ).toBe(1);
        });
        const supportQueries = statements.filter((statement) =>
          /from events indexed by events_thread_turn_type_item_sequence_idx/i.test(
            statement.sql,
          ),
        );
        expect(supportQueries.length).toBeGreaterThan(0);
        for (const statement of supportQueries) {
          const instructions = await db.$client
            .prepare<SqliteParameter[], { p4: string | null }>(
              `EXPLAIN ${statement.sql}`,
            )
            .all(...statement.params);
          expect(instructions.some((row) => row.p4?.startsWith("json_"))).toBe(
            false,
          );
        }
      } finally {
        await db.close();
      }
    },
  );

  it("discovers archived teardown work without walking archived thread history", async () => {
    const { db } = await setup();
    try {
      const captured = await captureStatements(db, async () => {
        await listArchivedThreadsPendingTeardown(db);
      });
      const statement = captured[0]!;
      const details = await queryPlanDetails({ db, ...statement });
      expect(details).toMatch(/SEARCH threads USING INDEX \S+ \(status=\?\)/);
      expect(details).toContain(
        "SEARCH threads USING INDEX sqlite_autoindex_threads_1 (id=?)",
      );
      expect(details).not.toContain("CORRELATED SCALAR SUBQUERY");
      expect(details).not.toContain("SCAN threads");
      expect(details).not.toContain("SCAN terminal_sessions");
    } finally {
      await db.close();
    }
  });

  it("lists live terminals without walking exited session history", async () => {
    const { db } = await setup();
    try {
      const statements = await captureStatements(db, async () => {
        await listTerminalSessions(db, {
          scope: { kind: "all" },
          visible: true,
        });
      });
      const details = await queryPlanDetails({ db, ...statements[0]! });
      expect(details).not.toContain("SCAN terminal_sessions");
      expect(details).toMatch(
        /SEARCH terminal_sessions USING INDEX \S+ \(status=\?\)/,
      );
    } finally {
      await db.close();
    }
  });

  it("counts standalone terminals by host and live status", async () => {
    const { db, host } = await setup();
    try {
      const statements = await captureStatements(db, async () => {
        await countTerminalSessions(db, {
          scope: { kind: "host-path", hostId: host.id, cwd: null },
          visible: true,
        });
      });
      const details = await queryPlanDetails({ db, ...statements[0]! });
      expect(details).not.toContain("SCAN terminal_sessions");
      expect(details).toMatch(
        /SEARCH terminal_sessions USING INDEX \S+ \(host_id=\? AND status=\?\)/,
      );
    } finally {
      await db.close();
    }
  });

  it("uses the active-thread maintenance index for emitted idle checks", async () => {
    const { db, logger } = await setup();
    logger.clear();

    await getDatabaseMaintenanceActivity(db);

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.includes('from "threads"') &&
        fields.sql.includes('"threads"."deleted_at" is null'),
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "threads_active_maintenance_idx",
      params: ["active", "provisioning"],
    });

    await db.close();
  });

  it("uses the thread and sequence index for search segment suffix deletes", async () => {
    const { db } = await setup();

    const details = await queryPlanDetails({
      db,
      params: ["thread-query-plan", 10, 20],
      sql: `
        DELETE FROM thread_search_segments
        WHERE thread_id = ?
          AND source_seq >= ?
          AND source_seq <= ?
      `,
    });

    expect(details).toMatch(
      /USING (?:COVERING )?INDEX thread_search_segments_thread_source_seq_idx/,
    );
    expect(details).not.toContain("SCAN thread_search_segments");

    await db.close();
  });

  it("uses selective indexes for completed output migration cursor and event scans", async () => {
    const { db, logger, thread } = await setup();
    const createdBefore = Date.now();
    const commandOutput =
      "command-head-" +
      "a".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
      "-command-tail";
    await insertEvents(db, noopNotifier, [
      {
        createdAt: createdBefore - 10_000,
        data: JSON.stringify({
          item: {
            aggregatedOutput: commandOutput,
            id: "cmd-truncation-query-plan",
            type: "commandExecution",
          },
        }),
        itemId: "cmd-truncation-query-plan",
        itemKind: "commandExecution",
        parentToolCallId: null,
        scope: turnScope("turn_truncation_query_plan"),
        sequence: 1,
        threadId: thread.id,
        type: "item/completed",
      },
    ]);
    const insertedEvent = await db.$client
      .prepare<[string, number], IdentifiedRow>(
        "SELECT id FROM events WHERE thread_id = ? AND sequence = ?",
      )
      .get(thread.id, 1);
    if (!insertedEvent) {
      throw new Error("Expected completed output query-plan event");
    }
    logger.clear();

    await migrateNextCompletedEventItemOutput(db, {
      itemKind: "commandExecution",
      limit: 10,
      migratedAt: createdBefore,
      outputPath: "aggregatedOutput",
    });

    const cursorDebugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.includes('from "maintenance_scan_cursors"') &&
        fields.bindingArgumentCount === 2,
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: cursorDebugLog,
      indexName: "sqlite_autoindex_maintenance_scan_cursors_1",
      params: [
        "legacy_completed_event_output_sidecar:v1:commandExecution:aggregatedOutput",
        "legacy_completed_event_output_sidecar_window:v1:commandExecution:aggregatedOutput",
      ],
    });

    const scanDebugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.startsWith("SELECT id, created_at FROM events") &&
        fields.sql.includes("ORDER BY created_at, id") &&
        fields.bindingArgumentCount === 6,
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: scanDebugLog,
      indexName: "events_completed_item_truncation_idx",
      params: ["item/completed", "commandExecution", createdBefore, 0, "", 10],
    });

    const candidateDebugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.startsWith(
          "SELECT id, created_at, created_at AS scan_created_at, data, thread_id FROM events",
        ) &&
        fields.bindingArgumentCount === 14,
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: candidateDebugLog,
      indexName: "events_completed_item_truncation_idx",
      params: [
        "item/completed",
        "commandExecution",
        createdBefore,
        0,
        "",
        createdBefore - 10_000,
        insertedEvent.id,
        MAX_COMPLETED_EVENT_OUTPUT_MIGRATION_EVENT_DATA_BYTES,
        "$.item.aggregatedOutput",
        "$.item.truncation.aggregatedOutput",
        "$.item.type",
        "commandExecution",
        "$.item.aggregatedOutput",
        COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS,
      ],
    });

    await db.close();
  });

  it("bounds legacy image generation migration with the event primary key", async () => {
    const { db, logger, thread } = await setup();
    const migratedAt = Date.now();
    await insertEvents(db, noopNotifier, [
      {
        createdAt: migratedAt - 10_000,
        data: JSON.stringify({
          providerId: "codex",
          rawType: "item/completed",
          rawEvent: {
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              item: {
                failure: null,
                id: "legacy-image-query-plan",
                result: "i".repeat(
                  COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS + 1,
                ),
                revisedPrompt: "Draw an indexed image",
                savedPath: "/tmp/indexed.png",
                status: "completed",
                transparentBackground: false,
                type: "imageGeneration",
              },
            },
          },
        }),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        scope: turnScope("turn_legacy_image_query_plan"),
        sequence: 1,
        threadId: thread.id,
        type: "provider/unhandled",
      },
    ]);
    const insertedEvent = await db.$client
      .prepare<[string, number], IdentifiedRow>(
        "SELECT id FROM events WHERE thread_id = ? AND sequence = ?",
      )
      .get(thread.id, 1);
    if (!insertedEvent) {
      throw new Error("Expected legacy image generation query-plan event");
    }
    logger.clear();

    await migrateNextLegacyImageGenerationOutput(db, {
      limit: 10,
      migratedAt,
    });

    const scanDebugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.startsWith("SELECT id, 0 AS created_at FROM events") &&
        fields.sql.includes("ORDER BY id") &&
        fields.bindingArgumentCount === 2,
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: scanDebugLog,
      indexName: "sqlite_autoindex_events_1",
      params: ["", 10],
    });

    const candidateDebugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.startsWith(
          "SELECT id, created_at, 0 AS scan_created_at, data, thread_id FROM events",
        ) &&
        fields.bindingArgumentCount === 9,
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: candidateDebugLog,
      indexName: "sqlite_autoindex_events_1",
      params: [
        "",
        insertedEvent.id,
        "provider/unhandled",
        migratedAt,
        MAX_COMPLETED_EVENT_OUTPUT_MIGRATION_EVENT_DATA_BYTES,
        "item/completed",
        "item/completed",
        "imageGeneration",
        COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS,
      ],
    });

    await db.close();
  });

  it("uses the retained-output primary key for hydration", async () => {
    const { db, logger, thread } = await setup();
    const now = 1_800_000_000_000;
    await insertEvents(db, noopNotifier, [
      {
        createdAt: now,
        data: JSON.stringify({
          item: {
            aggregatedOutput: "x".repeat(
              COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS + 1,
            ),
            id: "retained-hydration-plan",
            type: "commandExecution",
          },
        }),
        itemId: "retained-hydration-plan",
        itemKind: "commandExecution",
        parentToolCallId: null,
        scope: turnScope("turn_retained_hydration_plan"),
        sequence: 1,
        threadId: thread.id,
        type: "item/completed",
      },
    ]);
    const [stored] = await listStoredEventRows(db, { threadId: thread.id });
    if (!stored) {
      throw new Error("Expected retained hydration event");
    }
    logger.clear();

    await hydrateRetainedEventOutputRows(db, [stored], now);

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.includes('from "retained_event_outputs"') &&
        fields.sql.includes('"event_id" in'),
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "sqlite_autoindex_retained_event_outputs_1",
      params: [stored.id, now],
    });

    await db.close();
  });

  it("uses the expiry and primary-key indexes for bounded cleanup", async () => {
    const { db, logger, thread } = await setup();
    const now = 1_800_000_000_000;
    await insertEvents(db, noopNotifier, [
      {
        createdAt: now,
        data: JSON.stringify({
          item: {
            aggregatedOutput: "x".repeat(
              COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS + 1,
            ),
            id: "retained-expiry-plan",
            type: "commandExecution",
          },
        }),
        itemId: "retained-expiry-plan",
        itemKind: "commandExecution",
        parentToolCallId: null,
        scope: turnScope("turn_retained_expiry_plan"),
        sequence: 1,
        threadId: thread.id,
        type: "item/completed",
      },
    ]);
    const [stored] = await listStoredEventRows(db, { threadId: thread.id });
    if (!stored) {
      throw new Error("Expected retained expiry event");
    }
    const expiredAtOrBefore = Number.MAX_SAFE_INTEGER;
    logger.clear();

    await deleteExpiredRetainedEventOutputs(db, {
      expiredAtOrBefore,
      limit: 1,
    });

    const selection = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.includes('from "retained_event_outputs"') &&
        fields.sql.includes('order by "retained_event_outputs"."expires_at"'),
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: selection,
      indexName: "retained_event_outputs_expiry_idx",
      params: [expiredAtOrBefore, 1],
    });
    const deletion = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith('delete from "retained_event_outputs"'),
    });
    await assertEmittedQueryPlanUsesIndex({
      db,
      debugLog: deletion,
      indexName: "sqlite_autoindex_retained_event_outputs_1",
      params: [stored.id],
    });

    await db.close();
  });

  it("pins maintenance discovery to the typed sequence index", async () => {
    const { db, thread } = await setup();
    await insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/diff/updated",
        scope: turnScope("pruning-turn"),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: "{}",
        createdAt: 1,
      },
    ]);
    const statements = await captureStatements(db, async () => {
      await advanceThreadPruning(db, "turn-diffs");
    });
    const discovery = statements.find((statement) =>
      statement.sql.includes(
        "FROM events INDEXED BY events_thread_type_sequence_idx",
      ),
    );
    expect(discovery).toBeDefined();
    if (!discovery) throw new Error("Missing maintenance discovery query");
    expect(await queryPlanDetails({ db, ...discovery })).toContain(
      "USING INDEX events_thread_type_sequence_idx",
    );
    expect(discovery.sql).toContain("LIMIT ?");
    await db.close();
  });

  it("bounds delta support probes with the consolidated scope index", async () => {
    const { db, logger, thread } = await setup();
    const turnId = "turn_resolved_delta_query_plan";
    const itemId = "call_resolved_delta_query_plan";
    await insertEvents(db, noopNotifier, [
      {
        data: JSON.stringify({ output: "first", parentToolCallId: "parent" }),
        itemId,
        itemKind: null,
        parentToolCallId: "parent",
        scope: turnScope(turnId),
        sequence: 1,
        threadId: thread.id,
        type: "item/commandExecution/outputDelta",
      },
      {
        data: JSON.stringify({ output: "second", parentToolCallId: "parent" }),
        itemId,
        itemKind: null,
        parentToolCallId: "parent",
        scope: turnScope(turnId),
        sequence: 2,
        threadId: thread.id,
        type: "item/commandExecution/outputDelta",
      },
      {
        data: JSON.stringify({
          item: {
            aggregatedOutput: "firstsecond",
            id: itemId,
            parentToolCallId: "parent",
            type: "commandExecution",
          },
        }),
        itemId,
        itemKind: "commandExecution",
        parentToolCallId: "parent",
        scope: turnScope(turnId),
        sequence: 3,
        threadId: thread.id,
        type: "item/completed",
      },
    ]);
    logger.clear();

    const statements = await captureStatements(db, async () => {
      expect((await advanceThreadPruning(db, "resolved-items")).removed).toBe(
        1,
      );
    });
    const discovery = statements.find((statement) =>
      statement.sql.includes("WITH candidate_ids AS MATERIALIZED"),
    );
    if (!discovery) throw new Error("Missing typed delta candidate discovery");
    const discoveryPlan = await queryPlanDetails({ db, ...discovery });
    expect(
      discoveryPlan.match(
        /USING COVERING INDEX events_thread_type_sequence_idx/gu,
      ),
    ).toHaveLength(4);
    expect(discoveryPlan).toContain("USING INTEGER PRIMARY KEY (rowid=?)");
    expect(discoveryPlan).not.toContain("events_thread_sequence_idx");
    const supportQueries = statements.filter((statement) =>
      /from events indexed by events_thread_turn_type_item_sequence_idx/i.test(
        statement.sql,
      ),
    );
    expect(supportQueries.length).toBeGreaterThan(0);
    for (const statement of supportQueries) {
      expect(await queryPlanDetails({ db, ...statement })).toContain(
        "USING INDEX events_thread_turn_type_item_sequence_idx",
      );
      expect(statement.sql).toMatch(/LIMIT \?/i);
    }
    const pruneQuery = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith("DELETE FROM events"),
    });
    expect(pruneQuery.fields.sql).toContain("WHERE id IN");
    expect(pruneQuery.fields.bindingArgumentCount).toBeLessThanOrEqual(500);
    expect(pruneQuery.fields.sql).not.toContain("json_extract");

    await db.close();
  });

  it("discovers token usage keepers without reading payloads or computing unused byte totals", async () => {
    const { db, thread } = await setup();
    try {
      await insertEvents(
        db,
        noopNotifier,
        [1, 2].map((sequence) => ({
          data: JSON.stringify({ tokenUsage: { modelContextWindow: 200000 } }),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          scope: turnScope("usage-turn"),
          sequence,
          threadId: thread.id,
          type: "thread/tokenUsage/updated" as const,
        })),
      );
      await advanceThreadPruning(db, "usage");
      await advanceThreadPruning(db, "usage");
      const statements = await captureStatements(db, async () => {
        const result = await advanceThreadPruning(db, "usage");
        expect(result.scanned).toBe(2);
        expect(result.removed).toBe(0);
        expect(result.removedBytes).toBe(0);
        expect(result.cursor.latestRootSequence).toBe(2);
      });
      for (const statement of statements) {
        const instructions = await db.$client
          .prepare<SqliteParameter[], { p4: string | null }>(
            `EXPLAIN ${statement.sql}`,
          )
          .all(...statement.params);
        expect(
          instructions.filter((row) => /^(json_|sum\()/u.test(row.p4 ?? "")),
        ).toEqual([]);
      }
    } finally {
      await db.close();
    }
  });

  it("pins multi-thread latest state lookups to one candidate seek per requested thread", async () => {
    const { db, project, thread } = await setup();
    const otherThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    await insertEvents(
      db,
      noopNotifier,
      [thread, otherThread].flatMap((stateThread, threadIndex) =>
        Array.from({ length: 64 }, (_, index) => ({
          data: JSON.stringify(
            index === 63
              ? { goal: `goal-${threadIndex}` }
              : { kind: "other-plugin/state", payload: { index } },
          ),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          scope: threadScope(),
          sequence: index + 1,
          threadId: stateThread.id,
          type:
            index === 63
              ? ("thread/goal/updated" as const)
              : ("thread/extensionState/updated" as const),
        })),
      ),
    );

    const captured = await captureStatements(db, async () => {
      expect(
        await listLatestThreadStateEventRowsByThreadIds(db, {
          threadIds: [thread.id, otherThread.id],
          kind: "provider-codex/goal",
        }),
      ).toHaveLength(2);
    });
    const statement = captured.find((entry) =>
      entry.sql.includes("events_thread_state_thread_sequence_idx"),
    );
    if (!statement) {
      throw new Error("Expected the latest-thread-state lookup SQL");
    }

    expect(statement.sql).toContain("VALUES");
    const details = await queryPlanDetails({
      db,
      params: statement.params,
      sql: statement.sql,
    });
    expect(
      details.match(
        /USING (?:COVERING )?INDEX events_thread_state_thread_sequence_idx/gu,
      ),
    ).toHaveLength(1);
    expect(details).not.toMatch(
      /USING (?:COVERING )?INDEX events_thread_sequence_idx/u,
    );
    expect(details).not.toContain("USE TEMP B-TREE");

    await db.close();
  });

  it("serves the thread-list pending probe from its covering index without a GROUP BY sort", async () => {
    const { db } = await setup();

    const captured = await captureStatements(db, async () => {
      await listThreadsWithPendingInteractionState(db, {
        includeHidden: false,
      });
    });
    const statement = captured.find(
      (entry) =>
        entry.sql.includes('from "threads"') &&
        entry.sql.includes("pending_interactions"),
    );
    if (!statement) {
      throw new Error("Expected the thread-list SQL");
    }

    const details = await queryPlanDetails({
      db,
      params: statement.params,
      sql: statement.sql,
    });
    expect(details).toContain(
      "USING COVERING INDEX pending_interactions_thread_status_created_idx",
    );
    expect(details).not.toContain("USE TEMP B-TREE FOR GROUP BY");

    await db.close();
  });

  it("drops redundant events indexes after creating their consolidated replacement", async () => {
    const { db } = await setup();
    const indexRows = await db.$client
      .prepare<[], IndexNameRow>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'",
      )
      .all();
    const indexNames = indexRows.map((row) => row.name);

    expect(indexNames).toContain("events_thread_turn_type_item_sequence_idx");
    expect(indexNames).toContain("events_completed_item_truncation_idx");
    expect(indexNames).not.toContain("events_thread_turn_sequence_idx");
    expect(indexNames).not.toContain("events_thread_item_id_sequence_idx");
    expect(indexNames).not.toContain(
      "events_thread_turn_type_item_kind_item_idx",
    );
    const [statement] = await captureStatements(
      db,
      async () =>
        await listItemEventSpansByItems(db, {
          threadId: "query-plan-thread",
          items: ["turn-1", "turn-2"].map((turnId) => ({
            itemId: turnId,
            scopeKind: "turn",
            turnId,
          })),
        }),
    );
    expect(await queryPlanDetails({ db, ...statement! })).toContain(
      "events_thread_turn_type_item_sequence_idx",
    );

    await db.close();
  });

  it("prunes stored provider model catalogs through the primary-key prefix", async () => {
    const { db, host, logger } = await setup();
    const pruneWorkspaceRowsFetchedBefore = 10_000;
    const isCatalogDelete = (fields: SlowDbQueryLogFields): boolean =>
      fields.operation === "run" &&
      fields.sql.startsWith('delete from "provider_model_catalogs"');
    logger.clear();

    await replaceStoredProviderModelCatalog(db, {
      row: {
        hostId: host.id,
        providerId: "acp-pi-acp",
        scopeKey: "/w/current",
        fingerprint: "catalog-prune-plan",
        modelsJson: "[]",
        selectedOnlyModelsJson: "[]",
        fetchedAt: 20_000,
      },
      pruneWorkspaceRowsFetchedBefore,
    });

    const prune = findOnlyDebugLog({ logger, predicate: isCatalogDelete });
    const pruneParams = [
      host.id,
      "acp-pi-acp",
      "",
      pruneWorkspaceRowsFetchedBefore,
    ];
    expect(prune.fields.bindingArgumentCount).toBe(pruneParams.length);
    const pruneDetails = await queryPlanDetails({
      db,
      params: pruneParams,
      sql: prune.fields.sql,
    });
    expect(pruneDetails).toMatch(
      /USING (COVERING )?INDEX sqlite_autoindex_provider_model_catalogs_1 \(host_id=\? AND provider_id=\?\)/u,
    );
    expect(pruneDetails).not.toMatch(/SCAN provider_model_catalogs/u);

    await db.close();
  });
});
