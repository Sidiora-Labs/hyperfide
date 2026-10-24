import { describe, expect, it } from "vitest";
import {
  PERSONAL_PROJECT_ID,
  type QueuedMessageWaitingOn,
} from "@hyperfide/domain";
import { noopNotifier } from "../../src/notifier.js";
import {
  claimQueuedThreadMessageGroup,
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessage,
  getQueuedThreadMessage,
  releaseQueuedMessageClaim,
  releaseStaleQueuedMessageClaims,
  requeueClaimedQueuedThreadMessages,
  setQueuedThreadMessageFailureReason,
  setQueuedThreadMessageWaitingOn,
} from "../../src/data/queued-thread-messages.js";
import { createThread } from "../../src/data/threads.js";
import { createMigratedConnection } from "../../src/testing.js";

const RETRY_DELAYS_MS = [10, 20] as const;

async function setup() {
  const db = await createMigratedConnection();
  const thread = await createThread(db, noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "codex",
    status: "idle",
  });
  const queue = async (
    waitingOn: QueuedMessageWaitingOn | null,
    sendAt: number | null,
  ) =>
    await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: [{ type: "text", text: "hello", mentions: [] }],
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn,
      sendAt,
      payload: { kind: "inline" },
      systemNotice: null,
    });
  return { db, queue, threadId: thread.id };
}

describe("queued message state", () => {
  it("walks a row through every state its writers can reach", async () => {
    const { db, queue, threadId } = await setup();
    const row = await queue(null, null);
    expect(row.state).toBe("queued");

    const scheduled = await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId,
      waitingOn: { kind: "time" },
      sendAt: 5_000,
    });
    expect(scheduled?.state).toBe("scheduled");

    const [claimed] =
      (await claimQueuedThreadMessageGroup(db, noopNotifier, row.id, {
        kind: "explicit-send",
      })) ?? [];
    expect(claimed?.state).toBe("claimed");

    const requeued = await requeueClaimedQueuedThreadMessages(
      db,
      noopNotifier,
      {
        claims: [{ id: row.id, claimToken: claimed!.claimToken }],
        threadId,
        waitingOn: { kind: "plugin", pluginId: "limiter", reason: "full" },
        sendAt: null,
      },
    );
    expect(requeued).toMatchObject({
      state: "waiting",
      waitHolder: "plugin:limiter",
      claimedAt: null,
    });

    const fail = async () =>
      await setQueuedThreadMessageFailureReason(db, noopNotifier, {
        id: row.id,
        threadId,
        failureReason: "Provider not ready",
        now: 1_000,
        retryDelaysMs: RETRY_DELAYS_MS,
      });
    expect(await fail()).toMatchObject({
      state: "failed_retrying",
      failureCount: 1,
      nextAttemptAt: 1_010,
    });

    const [retrying] =
      (await claimQueuedThreadMessageGroup(db, noopNotifier, row.id, {
        kind: "automatic",
        isGroupEligible: () => true,
        retryingFailure: true,
      })) ?? [];
    expect(retrying?.state).toBe("claimed");
    expect(
      await releaseQueuedMessageClaim(db, noopNotifier, {
        id: row.id,
        claimToken: retrying!.claimToken,
      }),
    ).toBe(true);
    expect((await getQueuedThreadMessage(db, row.id))?.state).toBe(
      "failed_retrying",
    );

    await fail();
    expect(await fail()).toMatchObject({
      state: "failed_exhausted",
      failureCount: 3,
      nextAttemptAt: null,
    });

    expect(
      await clearQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id: row.id,
        threadId,
      }),
    ).toMatchObject({
      state: "failed_exhausted",
      waitingOn: null,
      waitHolder: null,
    });

    expect(
      await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id: row.id,
        threadId,
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
      }),
    ).toMatchObject({
      state: "waiting",
      failureReason: null,
      failureCount: 0,
    });
  });

  it("releases a stale claim back to the state the row was claimed from", async () => {
    const { db, queue } = await setup();
    const scheduled = await queue({ kind: "time" }, 5_000);
    const waiting = await queue({ kind: "provisioning" }, null);
    for (const row of [scheduled, waiting]) {
      await claimQueuedThreadMessageGroup(db, noopNotifier, row.id, {
        kind: "explicit-send",
      });
    }

    expect(
      await releaseStaleQueuedMessageClaims(db, noopNotifier, {
        claimedBefore: Date.now() + 1,
        protectedClaimTokens: [],
      }),
    ).toBe(2);
    expect((await getQueuedThreadMessage(db, scheduled.id))?.state).toBe(
      "scheduled",
    );
    expect((await getQueuedThreadMessage(db, waiting.id))?.state).toBe(
      "waiting",
    );
  });

  it("refuses to create a scheduled row with no wait", async () => {
    const { queue } = await setup();
    await expect((async () => await queue(null, 5_000))()).rejects.toThrow(
      /queued_thread_messages_schedule_check/,
    );
  });

  it("rejects raw writes that leave a row no state can describe", async () => {
    const { db, queue } = await setup();
    const row = await queue({ kind: "thread-busy" }, null);
    const write = (assignments: string) => async () =>
      await db.$client
        .prepare(
          `UPDATE queued_thread_messages SET ${assignments} WHERE id = ?`,
        )
        .run(row.id);

    await expect(write("claimed_at = 1")()).rejects.toThrow(
      /CHECK constraint failed|check constraint/,
    );
    await expect(
      write("claimed_at = 1, claim_token = 'c', state = 'waiting'")(),
    ).rejects.toThrow(/queued_thread_messages_state_check/);
    await expect(
      write("failure_reason = 'x', state = 'failed_exhausted'")(),
    ).rejects.toThrow(/queued_thread_messages_failure_check/);
    await expect(write("wait_holder = 'plugin:limiter'")()).rejects.toThrow(
      /queued_thread_messages_wait_holder_check/,
    );
    await expect(write("state = 'queued'")()).rejects.toThrow(
      /queued_thread_messages_state_check/,
    );
    await expect(write("state = 'paused'")()).rejects.toThrow(
      /queued_thread_messages_state_check/,
    );
  });
});
