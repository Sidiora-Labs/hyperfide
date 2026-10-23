import { describe, expect, it } from "vitest";
import { threadScope, turnScope } from "@hyperfide/domain";
import type { DbConnection } from "../../src/connection.js";
import { getThreadEventRewriteGeneration } from "../../src/data/event-rewrite-generation.js";
import {
  appendDaemonEventsInTransaction,
  deleteThreadEventSuffixInTransaction,
  insertEvents,
  type InsertEventInput,
} from "../../src/data/events.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { migrateNextCompletedEventItemOutput } from "../../src/data/sweeps.js";
import {
  advanceThreadPruning,
  type ThreadPruningPolicy,
} from "../../src/data/thread-pruning.js";
import { createThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import { COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS } from "../../src/retained-event-output.js";
import { events } from "../../src/schema.js";
import { createMigratedConnection } from "../../src/testing.js";

interface RewriteCase {
  between?: (threadId: string) => InsertEventInput[];
  name: string;
  noop: (db: DbConnection, threadId: string) => number | Promise<number>;
  rewrite: (db: DbConnection, threadId: string) => number | Promise<number>;
  seed: (threadId: string) => InsertEventInput[];
}

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, { name: "rewrite-host" });
  const { project } = await createProject(db, noopNotifier, {
    name: "rewrite-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/rewrite" },
  });
  const createCodexThread = async () =>
    (
      await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      })
    ).id;
  return {
    db,
    otherThreadId: await createCodexThread(),
    threadId: await createCodexThread(),
  };
}

async function pruneThreadEvents(
  db: DbConnection,
  policy: ThreadPruningPolicy,
): Promise<number> {
  let removed = 0;
  for (let pass = 0; pass < 100; pass += 1) {
    const result = await advanceThreadPruning(db, policy);
    removed += result.removed;
    if (result.action === "cycle-complete") return removed;
  }
  throw new Error("Pruning did not finish a cycle");
}

async function expectGenerationBump(
  threadId: string,
  bumped: boolean,
  mutate: () => unknown,
): Promise<void> {
  const before = getThreadEventRewriteGeneration(threadId);
  await mutate();
  expect(getThreadEventRewriteGeneration(threadId) !== before).toBe(bumped);
}

function row(
  threadId: string,
  sequence: number,
  type: InsertEventInput["type"],
  data: Record<string, unknown>,
  overrides: Partial<InsertEventInput> = {},
): InsertEventInput {
  return {
    data: JSON.stringify(data),
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    scope: turnScope("turn-1"),
    sequence,
    threadId,
    type,
    ...overrides,
  };
}

function message(threadId: string, sequence: number): InsertEventInput {
  return row(
    threadId,
    sequence,
    "system/manager/user_message",
    { text: `message ${sequence}` },
    { scope: threadScope() },
  );
}

function tokenUsage(threadId: string, sequence: number): InsertEventInput {
  return row(threadId, sequence, "thread/tokenUsage/updated", {
    tokenUsage: {
      modelContextWindow: sequence === 1 ? 200_000 : null,
      total: { totalTokens: sequence * 10 },
    },
  });
}

function taskProgress(threadId: string, sequence: number): InsertEventInput {
  return row(
    threadId,
    sequence,
    "item/backgroundTask/progress",
    {
      item: {
        description: "fixture workflow",
        id: "task:wf-1",
        skipTranscript: false,
        foreground: false,
        status: "pending",
        taskStatus: "running",
        taskType: "local_workflow",
        type: "backgroundTask",
      },
    },
    { itemId: "task:wf-1", itemKind: "backgroundTask", scope: threadScope() },
  );
}

async function deleteSuffix(
  db: DbConnection,
  threadId: string,
  cutoffSequence: number,
): Promise<number> {
  return await db.transaction(
    async (tx) =>
      (
        await deleteThreadEventSuffixInTransaction(tx, {
          cutoffSequence,
          oldMaxSequence: cutoffSequence + 2,
          threadId,
        })
      ).deletedEventCount,
  );
}

async function insertCommandOutput(
  db: DbConnection,
  threadId: string,
  output: string,
) {
  await db
    .insert(events)
    .values({
      createdAt: 1_799_999_940_000,
      data: JSON.stringify({
        item: {
          aggregatedOutput: output,
          id: "cmd-1",
          type: "commandExecution",
        },
      }),
      id: "evt_command_output",
      itemId: "cmd-1",
      itemKind: "commandExecution",
      parentToolCallId: null,
      providerThreadId: null,
      scopeKind: "turn",
      sequence: 1,
      threadId,
      turnId: "turn-1",
      type: "item/completed",
    })
    .run();
  return (
    await migrateNextCompletedEventItemOutput(db, {
      itemKind: "commandExecution",
      limit: 10,
      migratedAt: 1_800_000_000_000,
      outputPath: "aggregatedOutput",
    })
  ).action;
}

describe("thread event rewrite generation", () => {
  it.each<RewriteCase>([
    {
      name: "a suffix delete",
      seed: (threadId) =>
        [1, 2, 3].map((sequence) => message(threadId, sequence)),
      noop: async (db, threadId) => await deleteSuffix(db, threadId, 10),
      rewrite: async (db, threadId) => await deleteSuffix(db, threadId, 2),
    },
    {
      name: "a usage prune",
      seed: (threadId) => [tokenUsage(threadId, 1)],
      noop: async (db) => await pruneThreadEvents(db, "usage"),
      between: (threadId) =>
        [2, 3, 4].map((sequence) => tokenUsage(threadId, sequence)),
      rewrite: async (db) => await pruneThreadEvents(db, "usage"),
    },
    {
      name: "a resolved delta prune",
      seed: (threadId) =>
        [1, 2, 3].map((sequence) =>
          row(
            threadId,
            sequence,
            "item/agentMessage/delta",
            { delta: `chunk ${sequence}`, itemId: "msg-1" },
            { itemId: "msg-1" },
          ),
        ),
      noop: async (db) => await pruneThreadEvents(db, "resolved-items"),
      between: (threadId) => [
        row(
          threadId,
          4,
          "item/completed",
          {
            item: {
              id: "msg-1",
              text: "chunk 1chunk 2chunk 3",
              type: "agentMessage",
            },
          },
          { itemId: "msg-1", itemKind: "agentMessage" },
        ),
      ],
      rewrite: async (db) => await pruneThreadEvents(db, "resolved-items"),
    },
    {
      name: "a background task progress prune",
      seed: (threadId) => [taskProgress(threadId, 1)],
      noop: async (db) => await pruneThreadEvents(db, "resolved-items"),
      between: (threadId) => [taskProgress(threadId, 2)],
      rewrite: async (db) => await pruneThreadEvents(db, "resolved-items"),
    },
  ])("changes only when $name removes rows", async (testCase) => {
    const { db, otherThreadId, threadId } = await setup();
    await insertEvents(db, noopNotifier, [
      ...testCase.seed(threadId),
      message(otherThreadId, 1),
    ]);

    await expectGenerationBump(threadId, false, async () => {
      expect(await testCase.noop(db, threadId)).toBe(0);
    });
    await insertEvents(db, noopNotifier, testCase.between?.(threadId) ?? []);
    const otherBefore = getThreadEventRewriteGeneration(otherThreadId);
    await expectGenerationBump(threadId, true, async () => {
      expect(await testCase.rewrite(db, threadId)).toBeGreaterThan(0);
    });
    expect(getThreadEventRewriteGeneration(otherThreadId)).toBe(otherBefore);
  });

  it("changes when a completed output is migrated and not when the scanned output fits", async () => {
    const fits = await setup();
    await expectGenerationBump(fits.threadId, false, async () => {
      expect(await insertCommandOutput(fits.db, fits.threadId, "small")).toBe(
        "scanned",
      );
    });

    const oversized = await setup();
    await expectGenerationBump(oversized.threadId, true, async () => {
      expect(
        await insertCommandOutput(
          oversized.db,
          oversized.threadId,
          "x".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS + 1),
        ),
      ).toBe("migrated");
    });
  });

  it("does not change for daemon appends, increasing inserts or ignored duplicates", async () => {
    const { db, threadId } = await setup();
    await expectGenerationBump(threadId, false, async () => {
      await insertEvents(db, noopNotifier, [
        message(threadId, 1),
        message(threadId, 2),
      ]);
      await insertEvents(db, noopNotifier, [message(threadId, 5)]);
      expect(
        (await insertEvents(db, noopNotifier, [message(threadId, 5)]))
          .insertedCount,
      ).toBe(0);
      await db.transaction(async (tx) => {
        expect(
          (
            await appendDaemonEventsInTransaction(tx, [
              {
                data: JSON.stringify({ text: "daemon" }),
                environmentId: null,
                itemId: null,
                itemKind: null,
                parentToolCallId: null,
                providerThreadId: null,
                scope: threadScope(),
                threadId,
                type: "system/manager/user_message",
              },
            ])
          ).acceptedEvents,
        ).toEqual([{ sequence: 6, threadId }]);
      });
    });
  });

  it("changes only for the thread whose insert backfills at or below its high-water mark", async () => {
    const { db, otherThreadId, threadId } = await setup();
    await insertEvents(db, noopNotifier, [
      message(threadId, 2),
      message(threadId, 4),
    ]);
    const otherBefore = getThreadEventRewriteGeneration(otherThreadId);

    await expectGenerationBump(threadId, true, async () => {
      expect(
        (
          await insertEvents(db, noopNotifier, [
            message(otherThreadId, 1),
            message(threadId, 3),
          ])
        ).insertedCount,
      ).toBe(2);
    });
    expect(getThreadEventRewriteGeneration(otherThreadId)).toBe(otherBefore);
  });
});
