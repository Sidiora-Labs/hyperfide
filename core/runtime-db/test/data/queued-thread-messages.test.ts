import { describe, expect, it, vi } from "vitest";
import { threadScope, type PromptInput } from "@hyperfide/domain";
import { noopNotifier } from "../../src/notifier.js";
import { insertEvents } from "../../src/data/events.js";
import {
  claimNextQueuedThreadMessageGroup,
  claimQueuedThreadMessageGroup,
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessage,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  deleteQueuedThreadMessage,
  getQueuedThreadMessage,
  holdQueuedThreadMessageForEdit,
  listIdleThreadsWithQueuedMessages,
  listQueuedThreadMessages,
  releaseQueuedMessageClaim,
  releaseQueuedThreadMessageEditHold,
  releaseStaleQueuedMessageClaims,
  reorderQueuedThreadMessage,
  requeueClaimedQueuedThreadMessages,
  setQueuedThreadMessageGroupBoundary,
  updateQueuedThreadMessage,
} from "../../src/data/queued-thread-messages.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../../src/testing.js";

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

const defaultInput = textInput("hello");
const altInput = textInput("world");

async function queueTurnEndMessage(
  db: Awaited<ReturnType<typeof createMigratedConnection>>,
  threadId: string,
  content: PromptInput[],
  wait: {
    sendAt: number | null;
    waitingOn: { kind: "thread-busy" | "time" };
  } = {
    sendAt: null,
    waitingOn: { kind: "thread-busy" },
  },
) {
  return await createQueuedThreadMessage(db, noopNotifier, {
    threadId,
    content,
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: wait.waitingOn,
    sendAt: wait.sendAt,
    payload: { kind: "inline" },
    systemNotice: null,
  });
}

async function setup() {
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
    providerId: "codex",
  });
  return { db, project, thread };
}

describe("queued thread messages", () => {
  it("lists an idle thread waiting for its turn to start", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "turn-starting" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      (await listIdleThreadsWithQueuedMessages(db)).map((row) => row.threadId),
    ).toContain(thread.id);
  });

  it("updates queued message content without changing its identity or position", async () => {
    const { db, thread } = await setup();
    const first = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const second = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    await setQueuedThreadMessageGroupBoundary({
      db,
      expectedGroupedPrefixQueuedMessageIds: [first.id, second.id],
      groupBoundaryQueuedMessageId: second.id,
      notifier: noopNotifier,
      threadId: thread.id,
    });
    const before = await getQueuedThreadMessage(db, first.id);

    const result = await updateQueuedThreadMessage(db, noopNotifier, {
      content: textInput("edited in place"),
      expectedUpdatedAt: before?.updatedAt ?? -1,
      id: first.id,
      threadId: thread.id,
    });

    expect(result.kind).toBe("updated");
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((row) => row.id),
    ).toEqual([first.id, second.id]);
    expect(await getQueuedThreadMessage(db, first.id)).toMatchObject({
      content: JSON.stringify(textInput("edited in place")),
      createdAt: before?.createdAt,
      groupWithNext: true,
      id: first.id,
      model: before?.model,
      permissionMode: before?.permissionMode,
      reasoningLevel: before?.reasoningLevel,
      serviceTier: before?.serviceTier,
      sortKey: before?.sortKey,
    });
  });

  it("rejects a second update based on the same queued message version", async () => {
    const { db, thread } = await setup();
    const queuedMessage = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      (
        await updateQueuedThreadMessage(db, noopNotifier, {
          content: textInput("first edit"),
          expectedUpdatedAt: queuedMessage.updatedAt,
          id: queuedMessage.id,
          threadId: thread.id,
        })
      ).kind,
    ).toBe("updated");
    expect(
      await updateQueuedThreadMessage(db, noopNotifier, {
        content: textInput("stale edit"),
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }),
    ).toEqual({ kind: "stale" });
    expect((await getQueuedThreadMessage(db, queuedMessage.id))?.content).toBe(
      JSON.stringify(textInput("first edit")),
    );
  });

  it("advances updatedAt when an update occurs within the same millisecond", async () => {
    const fixedNow = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      const { db, thread } = await setup();
      const queuedMessage = await createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      const result = await updateQueuedThreadMessage(db, noopNotifier, {
        content: altInput,
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      });

      expect(result).toMatchObject({
        kind: "updated",
        queuedMessage: { updatedAt: fixedNow + 1 },
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not update a queued message that is already claimed for sending", async () => {
    const { db, thread } = await setup();
    const queuedMessage = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    await claimQueuedThreadMessageGroup(db, noopNotifier, queuedMessage.id, {
      kind: "explicit-send",
    });

    expect(
      await updateQueuedThreadMessage(db, noopNotifier, {
        content: altInput,
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }),
    ).toEqual({ kind: "claimed" });
    expect((await getQueuedThreadMessage(db, queuedMessage.id))?.content).toBe(
      JSON.stringify(defaultInput),
    );
  });

  it("deletes a queued message", async () => {
    const { db, thread } = await setup();
    const queuedMessage = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      await deleteQueuedThreadMessage(db, noopNotifier, queuedMessage.id),
    ).toBe(true);
    expect(await listQueuedThreadMessages(db, thread.id)).toHaveLength(0);
    expect(
      await deleteQueuedThreadMessage(db, noopNotifier, queuedMessage.id),
    ).toBe(false);
  });

  it("claims a queued message and hides it from the queue until the claim is released", async () => {
    const { db, thread } = await setup();
    const queuedMessage = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const claimedQueuedMessage = (
      await claimQueuedThreadMessageGroup(db, noopNotifier, queuedMessage.id, {
        kind: "explicit-send",
      })
    )?.[0];
    expect(claimedQueuedMessage?.id).toBe(queuedMessage.id);
    expect(claimedQueuedMessage?.claimToken).toMatch(/^qclaim_/);
    expect(await listQueuedThreadMessages(db, thread.id)).toHaveLength(0);

    if (!claimedQueuedMessage) {
      throw new Error("Expected queued message claim");
    }
    expect(
      await releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: claimedQueuedMessage.claimToken,
      }),
    ).toBe(true);
    expect(await listQueuedThreadMessages(db, thread.id)).toHaveLength(1);
  });

  it("does not release or consume a queued message claimed by another owner", async () => {
    const { db, thread } = await setup();
    const queuedMessage = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const firstClaim = (
      await claimQueuedThreadMessageGroup(db, noopNotifier, queuedMessage.id, {
        kind: "explicit-send",
      })
    )?.[0];
    if (!firstClaim) {
      throw new Error("Expected first queued message claim");
    }
    expect(
      await releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: "qclaim_staleowner",
      }),
    ).toBe(false);
    expect(
      (await getQueuedThreadMessage(db, queuedMessage.id))?.claimToken,
    ).toBe(firstClaim.claimToken);
    expect(
      await db.transaction(
        async (tx) =>
          await deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
            queuedMessages: [
              { id: queuedMessage.id, claimToken: "qclaim_staleowner" },
            ],
          }),
      ),
    ).toBe(false);

    expect(
      await releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: firstClaim.claimToken,
      }),
    ).toBe(true);
    const secondClaim = (
      await claimQueuedThreadMessageGroup(db, noopNotifier, queuedMessage.id, {
        kind: "explicit-send",
      })
    )?.[0];
    if (!secondClaim) {
      throw new Error("Expected second queued message claim");
    }
    expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(
      await db.transaction(
        async (tx) =>
          await deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
            queuedMessages: [
              { id: queuedMessage.id, claimToken: firstClaim.claimToken },
            ],
          }),
      ),
    ).toBe(false);
    expect(
      (await getQueuedThreadMessage(db, queuedMessage.id))?.claimToken,
    ).toBe(secondClaim.claimToken);
    expect(
      await db.transaction(
        async (tx) =>
          await deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
            queuedMessages: [
              { id: queuedMessage.id, claimToken: secondClaim.claimToken },
            ],
          }),
      ),
    ).toBe(true);
    expect(await getQueuedThreadMessage(db, queuedMessage.id)).toBeNull();
  });

  it("releases stale queued message claims", async () => {
    const { db, thread } = await setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000);
      const queuedMessage = await createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      const claimedQueuedMessage = (
        await claimQueuedThreadMessageGroup(
          db,
          noopNotifier,
          queuedMessage.id,
          { kind: "explicit-send" },
        )
      )?.[0];
      expect(claimedQueuedMessage?.claimedAt).toBe(1_000);
      expect(claimedQueuedMessage?.claimToken).toMatch(/^qclaim_/);
      expect(await listQueuedThreadMessages(db, thread.id)).toHaveLength(0);

      nowSpy.mockReturnValue(10_000);
      expect(
        await releaseStaleQueuedMessageClaims(db, noopNotifier, {
          claimedBefore: 5_000,
          protectedClaimTokens: [],
        }),
      ).toBe(1);
      expect(
        (await listQueuedThreadMessages(db, thread.id)).map((row) => row.id),
      ).toEqual([queuedMessage.id]);
      expect(
        (await getQueuedThreadMessage(db, queuedMessage.id))?.claimToken,
      ).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not release stale queued message claims protected by a live owner", async () => {
    const { db, thread } = await setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000);
      const protectedQueuedMessage = await createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: thread.id,
          content: defaultInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );
      const releasableQueuedMessage = await createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: thread.id,
          content: altInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );
      const protectedClaim = (
        await claimQueuedThreadMessageGroup(
          db,
          noopNotifier,
          protectedQueuedMessage.id,
          { kind: "explicit-send" },
        )
      )?.[0];
      const releasableClaim = (
        await claimQueuedThreadMessageGroup(
          db,
          noopNotifier,
          releasableQueuedMessage.id,
          { kind: "explicit-send" },
        )
      )?.[0];
      if (!protectedClaim || !releasableClaim) {
        throw new Error("Expected queued message claims");
      }

      nowSpy.mockReturnValue(10_000);
      expect(
        await releaseStaleQueuedMessageClaims(db, noopNotifier, {
          claimedBefore: 5_000,
          protectedClaimTokens: [protectedClaim.claimToken],
        }),
      ).toBe(1);

      expect(
        (await getQueuedThreadMessage(db, protectedQueuedMessage.id))
          ?.claimToken,
      ).toBe(protectedClaim.claimToken);
      expect(
        (await getQueuedThreadMessage(db, releasableQueuedMessage.id))
          ?.claimToken,
      ).toBeNull();
      expect(
        (await listQueuedThreadMessages(db, thread.id)).map((row) => row.id),
      ).toEqual([releasableQueuedMessage.id]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("claims the oldest queued message first", async () => {
    const { db, thread } = await setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValueOnce(1_000);
      const firstQueuedMessage = await createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: thread.id,
          content: defaultInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: { kind: "turn-starting" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );
      nowSpy.mockReturnValueOnce(2_000);
      const secondQueuedMessage = await createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: thread.id,
          content: altInput,
          model: "gpt-5",
          reasoningLevel: "high",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );

      const claimedQueuedMessage = (
        await claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        )
      )?.[0];
      expect(claimedQueuedMessage?.id).toBe(firstQueuedMessage.id);
      expect(
        (await listQueuedThreadMessages(db, thread.id)).map(
          (queuedMessage) => queuedMessage.id,
        ),
      ).toEqual([secondQueuedMessage.id]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("persists the contiguous lead group boundary", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );

    const result = await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("updated");
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: true },
      { id: secondQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("rejects a group boundary when the expected prefix is stale", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    expect(
      (
        await reorderQueuedThreadMessage({
          db,
          notifier: noopNotifier,
          threadId: thread.id,
          queuedMessageId: thirdQueuedMessage.id,
          previousQueuedMessageId: firstQueuedMessage.id,
          nextQueuedMessageId: secondQueuedMessage.id,
        })
      ).kind,
    ).toBe("reordered");

    const result = await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("stale_neighbor");
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("claims the contiguous lead group together", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    const claimedQueuedMessages = await claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
      () => true,
    );

    expect(
      claimedQueuedMessages?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([firstQueuedMessage.id, secondQueuedMessage.id]);
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map(
        (queuedMessage) => queuedMessage.id,
      ),
    ).toEqual([thirdQueuedMessage.id]);
  });

  it("pauses ordinary turn-end rows without pausing system notices", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    const ordinary = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const notice = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: {
        kind: "child-completed",
        subject: {
          kind: "thread",
          threadId: "thr_child",
          threadName: "Child",
        },
      },
    });
    await insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ reason: "manual-stop" }),
      },
    ]);

    expect(
      (await listIdleThreadsWithQueuedMessages(db)).map((row) => row.threadId),
    ).toContain(thread.id);
    expect(
      await claimQueuedThreadMessageGroup(db, noopNotifier, ordinary.id, {
        kind: "automatic",
        isGroupEligible: () => true,
        retryingFailure: false,
      }),
    ).toBeNull();
    expect(
      (
        await claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        )
      )?.map((row) => row.id),
    ).toEqual([notice.id]);
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((row) => row.id),
    ).toEqual([ordinary.id]);
  });

  it("lets a row the user asked for during the stop out of the manual-stop pause", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    const heldBack = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const askedForDuringStop = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "stopping" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    await insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ reason: "manual-stop" }),
      },
    ]);

    expect(
      (await listIdleThreadsWithQueuedMessages(db)).map((row) => row.threadId),
    ).toContain(thread.id);
    expect(
      await claimQueuedThreadMessageGroup(db, noopNotifier, heldBack.id, {
        kind: "automatic",
        isGroupEligible: () => true,
        retryingFailure: false,
      }),
    ).toBeNull();
    expect(
      (
        await claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        )
      )?.map((row) => row.id),
    ).toEqual([askedForDuringStop.id]);
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((row) => row.id),
    ).toEqual([heldBack.id]);
  });

  it("keeps a paused thread off the idle drain when every row is an ordinary turn-end wait", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    await insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ reason: "manual-stop" }),
      },
    ]);

    expect(
      (await listIdleThreadsWithQueuedMessages(db)).map((row) => row.threadId),
    ).not.toContain(thread.id);
  });

  it("does not split a requeued group: the tail waits with its blocked lead", async () => {
    const { db, thread } = await setup();
    const lead = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const tail = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [lead.id, tail.id],
      groupBoundaryQueuedMessageId: tail.id,
    });
    const claimed = await claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
      () => true,
    );
    expect(claimed?.map((queuedMessage) => queuedMessage.id)).toEqual([
      lead.id,
      tail.id,
    ]);
    await requeueClaimedQueuedThreadMessages(db, noopNotifier, {
      claims: claimed!.map(({ id, claimToken }) => ({ id, claimToken })),
      threadId: thread.id,
      waitingOn: { kind: "plugin", pluginId: "limits", reason: "At capacity" },
      sendAt: null,
    });

    // The requeue wrote the wait on the lead only; the tail must not be
    // claimable alone, or the drain would dispatch half a composed prompt.
    expect(
      await claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      ),
    ).toBeNull();

    // An independent row behind the blocked group still drains past it.
    const independent = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("independent"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    expect(
      (
        await claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        )
      )?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([independent.id]);
  });

  it("claiming a cleared lead takes its still-grouped tail with it", async () => {
    const { db, thread } = await setup();
    const lead = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const tail = await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [lead.id, tail.id],
      groupBoundaryQueuedMessageId: tail.id,
    });
    const claimed = await claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
      () => true,
    );
    await requeueClaimedQueuedThreadMessages(db, noopNotifier, {
      claims: claimed!.map(({ id, claimToken }) => ({ id, claimToken })),
      threadId: thread.id,
      waitingOn: { kind: "plugin", pluginId: "limits", reason: "At capacity" },
      sendAt: null,
    });
    await clearQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: lead.id,
      threadId: thread.id,
    });

    // The requested drain clears the lead's wait and claims by id; the claim
    // is a claim on the batch, so the tail dispatches with it.
    expect(
      (
        await claimQueuedThreadMessageGroup(db, noopNotifier, lead.id, {
          kind: "explicit-send",
        })
      )?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([lead.id, tail.id]);
  });

  it("claims only the selected message when sending outside the lead group", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    const claimedQueuedMessages = await claimQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thirdQueuedMessage.id,
      { kind: "explicit-send" },
    );

    expect(
      claimedQueuedMessages?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([thirdQueuedMessage.id]);
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map(
        (queuedMessage) => queuedMessage.id,
      ),
    ).toEqual([firstQueuedMessage.id, secondQueuedMessage.id]);
  });

  it("clears the previous group edge when deleting a grouped follower", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(
      await deleteQueuedThreadMessage(db, noopNotifier, secondQueuedMessage.id),
    ).toBe(true);

    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
    expect(
      (
        await claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        )
      )?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([firstQueuedMessage.id]);
  });

  it("clears the previous group edge when claiming a grouped follower", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(
      (
        await claimQueuedThreadMessageGroup(
          db,
          noopNotifier,
          secondQueuedMessage.id,
          {
            kind: "explicit-send",
          },
        )
      )?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([secondQueuedMessage.id]);

    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("clears the claimed follower group edge when releasing a failed direct send", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
        thirdQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: thirdQueuedMessage.id,
    });

    const claimed = await claimQueuedThreadMessageGroup(
      db,
      noopNotifier,
      secondQueuedMessage.id,
      { kind: "explicit-send" },
    );
    expect(claimed?.map((queuedMessage) => queuedMessage.id)).toEqual([
      secondQueuedMessage.id,
    ]);
    expect(claimed?.[0]).toBeDefined();
    if (!claimed?.[0]) return;

    await releaseQueuedMessageClaim(db, noopNotifier, {
      id: claimed[0].id,
      claimToken: claimed[0].claimToken,
    });

    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("rejects grouped prefixes that mix sender attribution", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        senderThreadId: "thr_sender",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );

    const result = await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("invalid_sender");
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("rejects grouped prefixes that mix execution options", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5.5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );

    const result = await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("invalid_execution_options");
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("does not consume any grouped claim when batch deletion is stale", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });
    const claimedQueuedMessages = await claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
      () => true,
    );
    if (!claimedQueuedMessages) {
      throw new Error("Expected grouped claim");
    }

    const staleClaim = [
      claimedQueuedMessages[0]!,
      { ...claimedQueuedMessages[1]!, claimToken: "qclaim_stale" },
    ];
    expect(
      await db.transaction(
        async (tx) =>
          await deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
            queuedMessages: staleClaim,
          }),
      ),
    ).toBe(false);

    expect(
      (await getQueuedThreadMessage(db, firstQueuedMessage.id))?.claimToken,
    ).toBe(claimedQueuedMessages[0]!.claimToken);
    expect(
      (await getQueuedThreadMessage(db, secondQueuedMessage.id))?.claimToken,
    ).toBe(claimedQueuedMessages[1]!.claimToken);
  });

  it("reorders queued messages to the front, middle, and end", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );

    const moveToFront = await reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: thirdQueuedMessage.id,
      previousQueuedMessageId: null,
      nextQueuedMessageId: firstQueuedMessage.id,
    });
    expect(moveToFront.kind).toBe("reordered");
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((row) => row.id),
    ).toEqual([
      thirdQueuedMessage.id,
      firstQueuedMessage.id,
      secondQueuedMessage.id,
    ]);

    const moveToMiddle = await reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: secondQueuedMessage.id,
      previousQueuedMessageId: thirdQueuedMessage.id,
      nextQueuedMessageId: firstQueuedMessage.id,
    });
    expect(moveToMiddle.kind).toBe("reordered");
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((row) => row.id),
    ).toEqual([
      thirdQueuedMessage.id,
      secondQueuedMessage.id,
      firstQueuedMessage.id,
    ]);

    const moveToEnd = await reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: thirdQueuedMessage.id,
      previousQueuedMessageId: firstQueuedMessage.id,
      nextQueuedMessageId: null,
    });
    expect(moveToEnd.kind).toBe("reordered");
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((row) => row.id),
    ).toEqual([
      secondQueuedMessage.id,
      firstQueuedMessage.id,
      thirdQueuedMessage.id,
    ]);
  });

  it("claims the reordered first queued message", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );

    expect(
      (
        await reorderQueuedThreadMessage({
          db,
          notifier: noopNotifier,
          threadId: thread.id,
          queuedMessageId: secondQueuedMessage.id,
          previousQueuedMessageId: null,
          nextQueuedMessageId: firstQueuedMessage.id,
        })
      ).kind,
    ).toBe("reordered");

    const claimedQueuedMessage = (
      await claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      )
    )?.[0];
    expect(claimedQueuedMessage?.id).toBe(secondQueuedMessage.id);
    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((row) => row.id),
    ).toEqual([firstQueuedMessage.id]);
  });

  it("rolls back a reorder when the requested group boundary is invalid", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        senderThreadId: "thr_sender",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );

    expect(
      (
        await reorderQueuedThreadMessage({
          db,
          notifier: noopNotifier,
          threadId: thread.id,
          queuedMessageId: thirdQueuedMessage.id,
          previousQueuedMessageId: null,
          nextQueuedMessageId: firstQueuedMessage.id,
          groupBoundaryQueuedMessageId: secondQueuedMessage.id,
        })
      ).kind,
    ).toBe("invalid_sender");

    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("clears grouping when reorder-only would regroup different messages", async () => {
    const { db, thread } = await setup();
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    await setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(
      (
        await reorderQueuedThreadMessage({
          db,
          notifier: noopNotifier,
          threadId: thread.id,
          queuedMessageId: thirdQueuedMessage.id,
          previousQueuedMessageId: firstQueuedMessage.id,
          nextQueuedMessageId: secondQueuedMessage.id,
        })
      ).kind,
    ).toBe("reordered");

    expect(
      (await listQueuedThreadMessages(db, thread.id)).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
    expect(
      (
        await claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        )
      )?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([firstQueuedMessage.id]);
  });

  it("rejects reordering claimed, missing, cross-thread, and inverted neighbors", async () => {
    const { db, thread } = await setup();
    const otherThread = await createThread(db, noopNotifier, {
      projectId: thread.projectId,
      providerId: "codex",
    });
    const firstQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const secondQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const thirdQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: thread.id,
        content: textInput("third"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );
    const otherQueuedMessage = await createQueuedThreadMessage(
      db,
      noopNotifier,
      {
        threadId: otherThread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    );

    expect(
      (
        await reorderQueuedThreadMessage({
          db,
          notifier: noopNotifier,
          threadId: thread.id,
          queuedMessageId: "qmsg_missing",
          previousQueuedMessageId: null,
          nextQueuedMessageId: firstQueuedMessage.id,
        })
      ).kind,
    ).toBe("not_found");
    expect(
      (
        await reorderQueuedThreadMessage({
          db,
          notifier: noopNotifier,
          threadId: thread.id,
          queuedMessageId: thirdQueuedMessage.id,
          previousQueuedMessageId: otherQueuedMessage.id,
          nextQueuedMessageId: null,
        })
      ).kind,
    ).toBe("stale_neighbor");
    expect(
      (
        await reorderQueuedThreadMessage({
          db,
          notifier: noopNotifier,
          threadId: thread.id,
          queuedMessageId: firstQueuedMessage.id,
          previousQueuedMessageId: thirdQueuedMessage.id,
          nextQueuedMessageId: secondQueuedMessage.id,
        })
      ).kind,
    ).toBe("invalid_neighbor_order");

    const claimedQueuedMessage = (
      await claimQueuedThreadMessageGroup(
        db,
        noopNotifier,
        secondQueuedMessage.id,
        { kind: "explicit-send" },
      )
    )?.[0];
    if (!claimedQueuedMessage) {
      throw new Error("Expected queued message claim");
    }
    expect(
      (
        await reorderQueuedThreadMessage({
          db,
          notifier: noopNotifier,
          threadId: thread.id,
          queuedMessageId: secondQueuedMessage.id,
          previousQueuedMessageId: null,
          nextQueuedMessageId: firstQueuedMessage.id,
        })
      ).kind,
    ).toBe("claimed");
    expect(
      (
        await reorderQueuedThreadMessage({
          db,
          notifier: noopNotifier,
          threadId: thread.id,
          queuedMessageId: thirdQueuedMessage.id,
          previousQueuedMessageId: null,
          nextQueuedMessageId: secondQueuedMessage.id,
        })
      ).kind,
    ).toBe("stale_neighbor");
  });

  describe("edit holds", () => {
    it("keeps an edited row and the rows behind it from automatic dispatch until the save", async () => {
      const { db, thread } = await setup();
      const edited = await queueTurnEndMessage(
        db,
        thread.id,
        textInput("ORIGINAL"),
      );
      const behind = await queueTurnEndMessage(db, thread.id, altInput);

      expect(
        await holdQueuedThreadMessageForEdit(db, {
          heldUntil: Date.now() + 60_000,
          id: edited.id,
          threadId: thread.id,
        }),
      ).toEqual({ kind: "held" });

      expect(
        await claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        ),
      ).toBeNull();
      expect(
        await claimQueuedThreadMessageGroup(db, noopNotifier, edited.id, {
          kind: "automatic",
          isGroupEligible: () => true,
          retryingFailure: false,
        }),
      ).toBeNull();
      expect((await getQueuedThreadMessage(db, edited.id))?.updatedAt).toBe(
        edited.updatedAt,
      );

      const saved = await updateQueuedThreadMessage(db, noopNotifier, {
        content: textInput("SAVED EDIT"),
        expectedUpdatedAt: edited.updatedAt,
        id: edited.id,
        threadId: thread.id,
      });
      expect(saved).toMatchObject({ kind: "updated", releasedEditHold: true });

      const claimed = await claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      );
      expect(claimed?.map((row) => [row.id, row.content])).toEqual([
        [edited.id, JSON.stringify(textInput("SAVED EDIT"))],
      ]);
      expect(
        (await listQueuedThreadMessages(db, thread.id)).map((row) => row.id),
      ).toEqual([behind.id]);
    });

    it("lets a row dispatch once its hold is released or lapses", async () => {
      const { db, thread } = await setup();
      const released = await queueTurnEndMessage(db, thread.id, defaultInput);
      const lapsed = await queueTurnEndMessage(db, thread.id, altInput);
      await holdQueuedThreadMessageForEdit(db, {
        heldUntil: Date.now() + 60_000,
        id: released.id,
        threadId: thread.id,
      });
      await holdQueuedThreadMessageForEdit(db, {
        heldUntil: Date.now() - 1,
        id: lapsed.id,
        threadId: thread.id,
      });

      expect(
        await releaseQueuedThreadMessageEditHold(db, {
          id: released.id,
          threadId: thread.id,
        }),
      ).toBe(true);
      expect(
        await releaseQueuedThreadMessageEditHold(db, {
          id: released.id,
          threadId: thread.id,
        }),
      ).toBe(false);

      expect(
        (
          await claimNextQueuedThreadMessageGroup(
            db,
            noopNotifier,
            thread.id,
            () => true,
          )
        )?.map((row) => row.id),
      ).toEqual([released.id]);
      expect(
        (
          await claimNextQueuedThreadMessageGroup(
            db,
            noopNotifier,
            thread.id,
            () => true,
          )
        )?.map((row) => row.id),
      ).toEqual([lapsed.id]);
    });

    it("does not hold back idle-drain rows behind an edited row that waits on something else", async () => {
      const { db, thread } = await setup();
      const scheduled = await queueTurnEndMessage(db, thread.id, defaultInput, {
        sendAt: Date.now() + 60_000,
        waitingOn: { kind: "time" },
      });
      const plain = await queueTurnEndMessage(db, thread.id, altInput);
      await holdQueuedThreadMessageForEdit(db, {
        heldUntil: Date.now() + 60_000,
        id: scheduled.id,
        threadId: thread.id,
      });

      expect(
        (
          await claimNextQueuedThreadMessageGroup(
            db,
            noopNotifier,
            thread.id,
            () => true,
          )
        )?.map((row) => row.id),
      ).toEqual([plain.id]);
    });

    it("refuses to hold a row a dispatch already claimed or another thread owns", async () => {
      const { db, project, thread } = await setup();
      const otherThread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const queued = await queueTurnEndMessage(db, thread.id, defaultInput);

      expect(
        await holdQueuedThreadMessageForEdit(db, {
          heldUntil: Date.now() + 60_000,
          id: queued.id,
          threadId: otherThread.id,
        }),
      ).toEqual({ kind: "not_found" });

      await claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      );
      expect(
        await holdQueuedThreadMessageForEdit(db, {
          heldUntil: Date.now() + 60_000,
          id: queued.id,
          threadId: thread.id,
        }),
      ).toEqual({ kind: "claimed" });
    });
  });
});
