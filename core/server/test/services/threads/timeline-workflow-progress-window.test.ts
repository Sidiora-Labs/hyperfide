import { describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  LOCAL_WORKFLOW_TASK_TYPE,
  threadScope,
  turnScope,
} from "@hyperfide/domain";
import type { Thread } from "@hyperfide/domain";
import {
  createProject,
  createThread,
  insertEvents,
  noopNotifier,
  upsertHost,
} from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";
import type { DbConnection } from "@hyperfide/db";
import type {
  TimelinePaginationCursor,
  TimelineRow,
} from "@hyperfide/server-contract";
import {
  buildThreadConversationOutline,
  buildThreadTimelineWithProfile,
} from "../../../src/services/threads/timeline.js";

const LARGE_BUDGET = 1_000_000;
const providerThreadId = "provider-root";
const WORKFLOW_CALL_ID = "call-workflow";
const WORKFLOW_TASK_ID = "task:wf-1";
const SNAPSHOT_BYTES = 300_000;
const SNAPSHOT_COUNT = 45;

const execution = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
} as const;

type EventInput = Parameters<typeof insertEvents>[2][number];

async function setup(): Promise<{ db: DbConnection; thread: Thread }> {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = await createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
  });
  return { db, thread };
}

function workflowTaskData(args: {
  status: "pending" | "completed";
  padding: number;
}): string {
  return JSON.stringify({
    providerThreadId,
    item: {
      type: "backgroundTask",
      id: WORKFLOW_TASK_ID,
      taskType: LOCAL_WORKFLOW_TASK_TYPE,
      description: "sweep the codebase",
      status: args.status,
      taskStatus: args.status === "pending" ? "running" : "completed",
      skipTranscript: false,
      foreground: false,
      workflowName: "sweep",
      parentToolCallId: WORKFLOW_CALL_ID,
      workflow: {
        phases: [{ index: 1, title: "Find" }],
        agents: [
          {
            index: 1,
            label: "find:boot",
            state: "running",
            model: "gpt-5",
            attempt: 1,
            cached: false,
            lastProgressAt: 1,
            promptPreview: "x".repeat(args.padding),
          },
        ],
      },
    },
  });
}

async function seedWorkflowThread(
  db: DbConnection,
  thread: Thread,
  options: {
    pendingTurnItems?: number;
    snapshotCount: number;
  },
): Promise<void> {
  const events: EventInput[] = [];
  let sequence = 0;
  const push = (event: Omit<EventInput, "sequence" | "threadId">): void => {
    sequence += 1;
    events.push({ ...event, sequence, threadId: thread.id });
  };
  const clientRequestId = encodeClientTurnRequestIdNumber({ value: 1 });
  push({
    type: "client/turn/requested",
    scope: threadScope(),
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    data: JSON.stringify({
      direction: "outbound",
      source: "tell",
      initiator: "user",
      request: { method: "turn/start", params: {} },
      requestId: clientRequestId,
      senderThreadId: null,
      input: [{ type: "text", text: "Sweep the codebase", mentions: [] }],
      target: { kind: "thread-start" },
      execution,
    }),
  });
  push({
    type: "turn/started",
    scope: turnScope("turn-1"),
    providerThreadId,
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    data: JSON.stringify({}),
  });
  push({
    type: "turn/input/accepted",
    scope: turnScope("turn-1"),
    providerThreadId,
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    data: JSON.stringify({ clientRequestId }),
  });
  push({
    type: "item/started",
    scope: turnScope("turn-1"),
    providerThreadId,
    itemId: WORKFLOW_CALL_ID,
    itemKind: "toolCall",
    parentToolCallId: null,
    data: JSON.stringify({
      providerThreadId,
      item: {
        type: "toolCall",
        id: WORKFLOW_CALL_ID,
        tool: "Workflow",
        arguments: { script: "export const meta = {}" },
        status: "pending",
      },
    }),
  });
  push({
    type: "item/started",
    scope: turnScope("turn-1"),
    providerThreadId,
    itemId: WORKFLOW_TASK_ID,
    itemKind: "backgroundTask",
    parentToolCallId: WORKFLOW_CALL_ID,
    data: workflowTaskData({ status: "pending", padding: 0 }),
  });
  push({
    type: "item/completed",
    scope: turnScope("turn-1"),
    providerThreadId,
    itemId: WORKFLOW_CALL_ID,
    itemKind: "toolCall",
    parentToolCallId: null,
    data: JSON.stringify({
      providerThreadId,
      item: {
        type: "toolCall",
        id: WORKFLOW_CALL_ID,
        tool: "Workflow",
        arguments: { script: "export const meta = {}" },
        result: "started",
        status: "completed",
      },
    }),
  });
  push({
    type: "item/completed",
    scope: turnScope("turn-1"),
    providerThreadId,
    itemId: "assistant-1",
    itemKind: "agentMessage",
    parentToolCallId: null,
    data: JSON.stringify({
      providerThreadId,
      item: {
        type: "agentMessage",
        id: "assistant-1",
        text: "The workflow will notify me when it completes.",
        status: "completed",
      },
    }),
  });
  push({
    type: "turn/completed",
    scope: turnScope("turn-1"),
    providerThreadId,
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    data: JSON.stringify({ status: "completed", providerThreadId }),
  });
  push({
    type: "turn/started",
    scope: turnScope("turn-2"),
    providerThreadId,
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    data: JSON.stringify({}),
  });
  for (let index = 0; index < (options.pendingTurnItems ?? 0); index += 1) {
    const itemId = `turn-2-item-${index}`;
    const command = "x".repeat(25_000);
    push({
      type: "item/started",
      scope: turnScope("turn-2"),
      providerThreadId,
      itemId,
      itemKind: "commandExecution",
      parentToolCallId: null,
      data: JSON.stringify({
        item: {
          type: "commandExecution",
          id: itemId,
          command,
          cwd: "/tmp/test",
          status: "pending",
          approvalStatus: null,
        },
      }),
    });
    push({
      type: "item/completed",
      scope: turnScope("turn-2"),
      providerThreadId,
      itemId,
      itemKind: "commandExecution",
      parentToolCallId: null,
      data: JSON.stringify({
        item: {
          type: "commandExecution",
          id: itemId,
          command,
          cwd: "/tmp/test",
          status: "completed",
          approvalStatus: null,
          exitCode: 0,
          aggregatedOutput: `output ${index}`,
        },
      }),
    });
  }
  for (let index = 0; index < options.snapshotCount; index += 1) {
    push({
      type: "item/backgroundTask/progress",
      scope: threadScope(),
      providerThreadId,
      itemId: WORKFLOW_TASK_ID,
      itemKind: "backgroundTask",
      parentToolCallId: WORKFLOW_CALL_ID,
      data: workflowTaskData({ status: "pending", padding: SNAPSHOT_BYTES }),
    });
  }
  await insertEvents(db, noopNotifier, events);
}

async function buildPage(
  db: DbConnection,
  thread: Thread,
  cursor: TimelinePaginationCursor | null,
  eventBudget = LARGE_BUDGET,
) {
  return await buildThreadTimelineWithProfile(db, thread, {
    completedTurnDisplay: "collapse",
    eventBudget,
    includeClearedContextHistory: false,
    includeDiagnosticOperations: false,
    compactionOfferEnabled: false,
    summarizeShellCommands: true,
    includeNestedRows: false,
    maxInlineOutputChars: 32_000,
    maxSeq: 0,
    page: cursor
      ? { kind: "older", beforeCursor: cursor, segmentLimit: 20 }
      : { kind: "latest", segmentLimit: 20 },
  });
}

interface WalkResult {
  maxEventDataBytes: number;
  pages: number;
  rows: TimelineRow[];
}

async function walkAllPages(
  db: DbConnection,
  thread: Thread,
): Promise<WalkResult> {
  const rowsByPage: TimelineRow[][] = [];
  let cursor: TimelinePaginationCursor | null = null;
  let maxEventDataBytes = 0;
  let pages = 0;
  for (;;) {
    const { profile, response } = await buildPage(db, thread, cursor);
    pages += 1;
    maxEventDataBytes = Math.max(maxEventDataBytes, profile.eventDataBytes);
    rowsByPage.push(response.rows);
    if (response.timelinePage.olderCursor === null) {
      break;
    }
    cursor = response.timelinePage.olderCursor;
    expect(cursor).not.toBeNull();
    expect(pages).toBeLessThan(50);
  }
  return { maxEventDataBytes, pages, rows: rowsByPage.reverse().flat() };
}

describe("workflow progress snapshots across timeline pages", () => {
  it("does not emit the spawning turn's summary on byte pages of a later turn", async () => {
    const { db, thread } = await setup();
    await seedWorkflowThread(db, thread, {
      pendingTurnItems: 250,
      snapshotCount: 1,
    });

    const walk = await walkAllPages(db, thread);
    expect(walk.pages).toBeGreaterThan(1);
    const turnOneRows = walk.rows.filter(
      (row) => row.kind === "turn" && row.turnId === "turn-1",
    );
    expect(turnOneRows.map((row) => row.id)).toHaveLength(1);
    expect(turnOneRows[0]?.sourceSeqStart).toBeLessThan(10);
    expect(
      walk.rows.filter((row) => row.kind === "turn" && row.turnId === "turn-2"),
    ).toHaveLength(0);
    const latest = await buildPage(db, thread, null);
    expect(latest.response.activeWorkflows).toHaveLength(1);
  }, 15_000);

  it("does not spend the byte budget on superseded progress snapshots", async () => {
    const { db, thread } = await setup();
    await seedWorkflowThread(db, thread, { snapshotCount: SNAPSHOT_COUNT });

    const latest = await buildPage(db, thread, null);
    expect(latest.response.timelinePage.olderCursor).toBeNull();
    expect(latest.profile.eventDataBytes).toBeLessThan(SNAPSHOT_BYTES * 3);
    expect(latest.response.activeWorkflows).toHaveLength(1);
    expect(
      latest.response.rows.flatMap((row) =>
        row.kind === "turn" ? [row.turnId] : [],
      ),
    ).toEqual(["turn-1"]);

    const eventBudgeted = await buildPage(db, thread, null, 30);
    expect(eventBudgeted.response.timelinePage.olderCursor).toBeNull();
    expect(eventBudgeted.response.rows).toEqual(latest.response.rows);

    const outline = await buildThreadConversationOutline(db, thread, {
      completedTurnDisplay: "collapse",
      includeClearedContextHistory: false,
      maxSeq: 0,
    });
    expect(outline.items.map((item) => item.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
