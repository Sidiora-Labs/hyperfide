import { getThread, listEvents } from "@hyperfide/db";
import { turnScope } from "@hyperfide/domain";
import { groupHostDaemonEvents } from "@hyperfide/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { applyTurnCompletedEvent } from "../../src/internal/turn-completed-events.js";
import { pruneThreadEventHistoryBestEffort } from "../../src/services/system/event-pruning.js";
import { buildThreadTimelineWithProfile } from "../../src/services/threads/timeline.js";
import {
  createTestDaemonEventEnvelope,
  internalAuthHeaders,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness, withTestHarness } from "../helpers/test-app.js";

interface SeedNoiseRowsArgs {
  endingSequence: number;
  startingSequence?: number;
  threadId: string;
}

interface CreateTokenUsageDataArgs {
  modelContextWindow: number | null;
  totalTokens: number;
}

interface CreateContextWindowUsageDataArgs {
  estimated?: boolean;
  modelContextWindow: number | null;
  usedTokens: number | null;
}

function createTokenUsageData(
  args: CreateTokenUsageDataArgs,
): Record<string, unknown> {
  return {
    tokenUsage: {
      total: {
        totalTokens: args.totalTokens,
        inputTokens: args.totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: args.totalTokens,
        inputTokens: args.totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: args.modelContextWindow,
    },
  };
}

function createContextWindowUsageData(
  args: CreateContextWindowUsageDataArgs,
): Record<string, unknown> {
  return {
    contextWindowUsage: {
      usedTokens: args.usedTokens,
      modelContextWindow: args.modelContextWindow,
      estimated: args.estimated ?? false,
    },
  };
}

async function listEventSequencesForType(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: { itemId?: string; threadId: string; type: string },
): Promise<number[]> {
  return (
    await listEvents(harness.db, {
      threadId: args.threadId,
    })
  )
    .filter(
      (event) =>
        event.type === args.type &&
        (args.itemId === undefined || event.itemId === args.itemId),
    )
    .map((event) => event.sequence);
}

async function drainLivePruning(
  deps: Parameters<typeof pruneThreadEventHistoryBestEffort>[0],
  args: Parameters<typeof pruneThreadEventHistoryBestEffort>[1],
) {
  let totalRemoved = 0;
  let passesSinceRemoval = 0;
  for (let i = 0; i < 1000 && passesSinceRemoval < 256; i++) {
    const result = await pruneThreadEventHistoryBestEffort(deps, args);
    if (result === null) throw new Error("Live cleanup failed");
    expect(result.scanned).toBeLessThanOrEqual(32);
    totalRemoved += result.totalRemoved;
    passesSinceRemoval = result.totalRemoved > 0 ? 0 : passesSinceRemoval + 1;
  }
  return { totalRemoved };
}

async function seedNoiseRows(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: SeedNoiseRowsArgs,
): Promise<void> {
  const startingSequence = args.startingSequence ?? 1;
  for (
    let sequence = startingSequence;
    sequence <= args.endingSequence;
    sequence += 1
  ) {
    await seedStoredEvent(harness.deps, {
      threadId: args.threadId,
      providerThreadId: "provider-thread-1",
      sequence,
      scope: turnScope(`turn-${sequence}`),
      type: "thread/tokenUsage/updated",
      itemId: null,
      itemKind: null,
      data: createTokenUsageData({
        totalTokens: sequence,
        modelContextWindow: null,
      }),
    });
  }
}

async function seedResolvedAssistantMessage(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: {
    completedSequence: number;
    deltaSequences: readonly number[];
    itemId: string;
    threadId: string;
    turnId?: string;
  },
): Promise<void> {
  const turnId = args.turnId ?? "turn-1";
  for (const sequence of args.deltaSequences) {
    await seedStoredEvent(harness.deps, {
      threadId: args.threadId,
      sequence,
      type: "item/agentMessage/delta",
      scope: turnScope(turnId),
      itemId: args.itemId,
      itemKind: null,
      data: {
        itemId: args.itemId,
        delta: `chunk-${sequence}`,
      },
    });
  }

  await seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    sequence: args.completedSequence,
    type: "item/completed",
    scope: turnScope(turnId),
    itemId: args.itemId,
    itemKind: "agentMessage",
    data: {
      item: {
        id: args.itemId,
        type: "agentMessage",
        text: "Final answer",
      },
    },
  });
}

describe("thread event pruning", () => {
  it("preserves context window usage when idle pruning removes old context-usage rows", async () => {
    await withTestHarness(async (harness) => {
      const host = await seedHost(harness.deps);
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      for (let sequence = 1; sequence <= 305; sequence += 1) {
        await seedStoredEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "provider-thread-1",
          sequence,
          scope: turnScope(`turn-${sequence}`),
          type: "thread/contextWindowUsage/updated",
          itemId: null,
          itemKind: null,
          data: createContextWindowUsageData({
            usedTokens: sequence,
            modelContextWindow: sequence === 1 ? 200_000 : null,
            estimated: sequence !== 1,
          }),
        });
      }

      const result = await drainLivePruning(harness.deps, {
        mode: "idle",
        threadId: thread.id,
      });
      const timeline = (
        await buildThreadTimelineWithProfile(harness.db, thread, {
          completedTurnDisplay: "collapse",
          eventBudget: 1_000_000,
          includeClearedContextHistory: false,
          includeDiagnosticOperations: true,
          compactionOfferEnabled: false,
          summarizeShellCommands: true,
          maxInlineOutputChars: null,
          maxSeq: 0,
          page: {
            kind: "latest",
            segmentLimit: Number.MAX_SAFE_INTEGER,
          },
        })
      ).response;

      expect(result.totalRemoved).toBe(303);
      expect(
        await listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/contextWindowUsage/updated",
        }),
      ).toEqual([1, 305]);
      expect(timeline.contextWindowUsage).toEqual({
        usedTokens: 305,
        modelContextWindow: 200_000,
        estimated: true,
      });
    });
  });

  it("prunes thread history when turn completion returns the thread to idle", async () => {
    await withTestHarness(async (harness) => {
      const host = await seedHost(harness.deps);
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      await seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 305,
      });
      await seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 306,
        type: "turn/started",
        itemId: null,
        itemKind: null,
        data: {
          providerThreadId: "provider-thread-1",
        },
      });
      await seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-1",
        deltaSequences: [307, 308],
        completedSequence: 309,
      });
      await seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 310,
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        data: {
          status: "completed",
        },
      });

      await applyTurnCompletedEvent(harness.deps, {
        type: "turn/completed",
        threadId: thread.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        status: "completed",
      });

      expect((await getThread(harness.db, thread.id))?.status).toBe("idle");
      await drainLivePruning(harness.deps, {
        threadId: thread.id,
        mode: "idle",
      });
      expect(
        (
          await listEventSequencesForType(harness, {
            threadId: thread.id,
            type: "thread/tokenUsage/updated",
          })
        ).at(0),
      ).toBe(305);
      expect(
        await listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
        }),
      ).toEqual([307]);
    });
  });

  it("identifies root completions even when the thread is already settled", async () => {
    await withTestHarness(async (harness) => {
      const host = await seedHost(harness.deps);
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      await seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "turn/started",
        itemId: null,
        itemKind: null,
        data: {
          providerThreadId: "provider-thread-1",
        },
      });
      await seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        data: {
          status: "completed",
        },
      });

      const result = await applyTurnCompletedEvent(harness.deps, {
        type: "turn/completed",
        threadId: thread.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        status: "completed",
      });

      expect(result.isRootTurnCompletion).toBe(true);
      expect(result.nextStatus).toBeNull();
      expect((await getThread(harness.db, thread.id))?.status).toBe("idle");
    });
  });

  it("prunes thread history on archive using the same usage retention rule", async () => {
    await withTestHarness(async (harness) => {
      const host = await seedHost(harness.deps);
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      await seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 130,
      });
      await seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-1",
        deltaSequences: [131, 132],
        completedSequence: 133,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive-all`,
        {
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect((await getThread(harness.db, thread.id))?.archivedAt).toBeTypeOf(
        "number",
      );
      await drainLivePruning(harness.deps, {
        threadId: thread.id,
        mode: "archived",
      });
      expect(
        (
          await listEventSequencesForType(harness, {
            threadId: thread.id,
            type: "thread/tokenUsage/updated",
          })
        ).at(0),
      ).toBe(130);
      expect(
        await listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
        }),
      ).toEqual([131]);
    });
  });

  it("notifies only after a committed live advance and reports its bounded work", async () => {
    await withTestHarness(async (harness) => {
      const host = await seedHost(harness.deps);
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      for (let sequence = 1; sequence <= 100; sequence++)
        await seedStoredEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "provider-thread",
          sequence,
          scope: turnScope("turn"),
          type: "provider/rateLimits/updated",
          itemId: null,
          itemKind: null,
          data: {},
        });
      const notify = vi
        .spyOn(harness.deps.hub, "notifyThread")
        .mockImplementation(() => {});
      const first = await pruneThreadEventHistoryBestEffort(harness.deps, {
        threadId: thread.id,
        mode: "active",
      });
      expect(first).toMatchObject({
        policy: "rate-limits",
        scanned: 32,
        totalRemoved: 32,
      });
      expect(notify).toHaveBeenCalledExactlyOnceWith(thread.id, [
        "history-compacted",
      ]);
      const second = await pruneThreadEventHistoryBestEffort(harness.deps, {
        threadId: thread.id,
        mode: "active",
      });
      expect(second).toMatchObject({ policy: "usage", totalRemoved: 0 });
      expect(notify).toHaveBeenCalledTimes(1);
      notify.mockRestore();
    });
  });

  it("logs and returns null when best-effort pruning cannot run", async () => {
    await withTestHarness(async (harness) => {
      const host = await seedHost(harness.deps);
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const loggerWarn = vi.fn();
      harness.deps.logger.warn = loggerWarn;

      await harness.db.close();

      expect(
        await pruneThreadEventHistoryBestEffort(harness.deps, {
          mode: "idle",
          threadId: thread.id,
        }),
      ).toBeNull();
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
        }),
        "Failed to prune thread event history",
      );
    });
  });

  it("prunes active-thread noise rows after ingest without dropping unresolved deltas", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = await seedHostSession(harness.deps);
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      await seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 1_000,
      });
      await seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-completed",
        deltaSequences: [1_001, 1_002],
        completedSequence: 1_003,
      });
      await seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 1_006,
        type: "turn/started",
        providerThreadId: "provider-thread-1",
        itemId: null,
        itemKind: null,
        data: {
          providerThreadId: "provider-thread-1",
        },
      });
      for (const sequence of [1_004, 1_005]) {
        await seedStoredEvent(harness.deps, {
          threadId: thread.id,
          scope: turnScope("turn-active"),
          sequence,
          type: "item/agentMessage/delta",
          itemId: "msg-active",
          itemKind: null,
          data: {
            itemId: "msg-active",
            delta: `chunk-${sequence}`,
          },
        });
      }

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: await internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            createTestDaemonEventEnvelope({
              event: {
                type: "thread/tokenUsage/updated",
                threadId: thread.id,
                providerThreadId: "provider-thread-1",
                scope: turnScope("turn-1"),
                tokenUsage: {
                  total: {
                    totalTokens: 1,
                    inputTokens: 1,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    reasoningOutputTokens: 0,
                  },
                  last: {
                    totalTokens: 1,
                    inputTokens: 1,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    reasoningOutputTokens: 0,
                  },
                  modelContextWindow: 200_000,
                },
              },
            }),
          ]),
        }),
      });

      expect(response.status).toBe(200);
      await drainLivePruning(harness.deps, {
        threadId: thread.id,
        mode: "active",
      });
      expect(
        (
          await listEventSequencesForType(harness, {
            threadId: thread.id,
            type: "thread/tokenUsage/updated",
          })
        ).at(0),
      ).toBe(1007);
      expect(
        await listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
          itemId: "msg-completed",
        }),
      ).toEqual([1_001]);
      expect(
        await listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
          itemId: "msg-active",
        }),
      ).toEqual([1_004, 1_005]);
    });
  });
});
