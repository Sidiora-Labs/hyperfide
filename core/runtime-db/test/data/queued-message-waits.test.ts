/**
 * The queue's wait columns: `send_at`, the typed `waiting_on`, and the
 * `wait_holder` denormalization that exists purely so the orphan sweep can ask
 * "which rows does this plugin hold?" with an indexed lookup.
 *
 * What is worth pinning here is the set of guards a drain depends on and that
 * a refactor could quietly drop: waits only mutate LIVE rows (a claimed row is
 * already on its way to a provider, so queueing it would be a lost update), the
 * due sweep's boundary is inclusive and excludes threads the user threw away,
 * and `wait_holder` is derived from `waiting_on` rather than passed in, so the
 * two can never disagree.
 */
import { describe, expect, it } from "vitest";
import type { PromptInput } from "@hyperfide/domain";
import { noopNotifier } from "../../src/notifier.js";
import {
  claimQueuedThreadMessageGroup,
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessage,
  getQueuedThreadMessage,
  listDueScheduledQueuedThreadMessages,
  listQueuedThreadMessagesByWaitHolder,
  listQueuedThreadMessagesWaitingOnKind,
  setQueuedThreadMessageWaitingOn,
} from "../../src/data/queued-thread-messages.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  createThread,
  deleteThread,
} from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../../src/testing.js";

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
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

async function queue(
  db: Awaited<ReturnType<typeof setup>>["db"],
  threadId: string,
  text = "hello",
) {
  return await createQueuedThreadMessage(db, noopNotifier, {
    threadId,
    content: textInput(text),
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: null,
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
  });
}

describe("queued message waits", () => {
  it("defaults a fresh row to an inline message with no wait", async () => {
    const { db, thread } = await setup();
    const row = await queue(db, thread.id);

    expect(row.state).toBe("queued");
    expect(row.sendAt).toBeNull();
    expect(row.waitingOn).toBeNull();
    expect(row.waitHolder).toBeNull();
    expect(row.payloadKind).toBe("inline");
    expect(row.retryOfTurnRequestId).toBeNull();
    expect(row.retryAttempt).toBeNull();
  });

  it("derives wait_holder from a plugin wait and clears it for a core wait", async () => {
    const { db, thread } = await setup();
    const row = await queue(db, thread.id);

    const queued = await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: {
        kind: "plugin",
        pluginId: "concurrency-limit",
        reason: "4 of 4 running",
      },
      sendAt: null,
    });
    expect(queued?.waitHolder).toBe("plugin:concurrency-limit");
    expect(JSON.parse(queued!.waitingOn!)).toEqual({
      kind: "plugin",
      pluginId: "concurrency-limit",
      reason: "4 of 4 running",
    });

    // Re-queueing onto a core wait must retire the previous holder, or the
    // orphan sweep would keep finding a row that plugin no longer holds.
    const requeued = await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "provisioning" },
      sendAt: null,
    });
    expect(requeued?.waitHolder).toBeNull();
    expect(JSON.parse(requeued!.waitingOn!)).toEqual({ kind: "provisioning" });
  });

  it("clears sendAt when a wait is replaced by a non-time wait", async () => {
    const { db, thread } = await setup();
    const row = await queue(db, thread.id);

    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 9_000,
    });
    const requeued = await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
    });
    expect(requeued?.sendAt).toBeNull();
  });

  it("refuses to write or clear a wait on a claimed row", async () => {
    const { db, thread } = await setup();
    const row = await queue(db, thread.id);
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "provisioning" },
      sendAt: null,
    });

    expect(
      await claimQueuedThreadMessageGroup(db, noopNotifier, row.id, {
        kind: "explicit-send",
      }),
    ).not.toBeNull();

    expect(
      await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id: row.id,
        threadId: thread.id,
        waitingOn: { kind: "interaction" },
        sendAt: null,
      }),
    ).toBeNull();
    expect(
      await clearQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id: row.id,
        threadId: thread.id,
      }),
    ).toBeNull();

    // The claimed row keeps the wait it was waiting on: neither call touched it.
    const after = await getQueuedThreadMessage(db, row.id);
    expect(JSON.parse(after!.waitingOn!)).toEqual({ kind: "provisioning" });
  });

  it("refuses to write a wait on a row belonging to another thread", async () => {
    const { db, project, thread } = await setup();
    const other = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const row = await queue(db, thread.id);

    expect(
      await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id: row.id,
        threadId: other.id,
        waitingOn: { kind: "provisioning" },
        sendAt: null,
      }),
    ).toBeNull();
  });

  it("clears a wait back to an ordinary queued row", async () => {
    const { db, thread } = await setup();
    const row = await queue(db, thread.id);
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 9_000,
    });

    const cleared = await clearQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
    });
    expect(cleared?.state).toBe("queued");
    expect(cleared?.waitingOn).toBeNull();
    expect(cleared?.waitHolder).toBeNull();
    expect(cleared?.sendAt).toBeNull();
  });
});

describe("listDueScheduledQueuedThreadMessages", () => {
  it("includes a row due exactly now and excludes one due a millisecond later", async () => {
    const { db, thread } = await setup();
    const due = await queue(db, thread.id, "due");
    const notYet = await queue(db, thread.id, "not yet");
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: due.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 5_000,
    });
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: notYet.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 5_001,
    });

    expect(
      (await listDueScheduledQueuedThreadMessages(db, 5_000)).map(
        (row) => row.id,
      ),
    ).toEqual([due.id]);
  });

  it("orders oldest-due first", async () => {
    const { db, thread } = await setup();
    const later = await queue(db, thread.id, "later");
    const earlier = await queue(db, thread.id, "earlier");
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: later.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 2_000,
    });
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: earlier.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 1_000,
    });

    expect(
      (await listDueScheduledQueuedThreadMessages(db, 5_000)).map(
        (row) => row.id,
      ),
    ).toEqual([earlier.id, later.id]);
  });

  it("skips claimed rows", async () => {
    const { db, thread } = await setup();
    const row = await queue(db, thread.id);
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 1_000,
    });
    await claimQueuedThreadMessageGroup(db, noopNotifier, row.id, {
      kind: "explicit-send",
    });

    expect(await listDueScheduledQueuedThreadMessages(db, 5_000)).toEqual([]);
  });

  it("skips rows on archived and deleted threads", async () => {
    const { db, project } = await setup();
    for (const [name, dispose] of [
      ["archived", archiveThread],
      ["deleted", deleteThread],
    ] as const) {
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const row = await queue(db, thread.id, name);
      await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id: row.id,
        threadId: thread.id,
        waitingOn: { kind: "time" },
        sendAt: 1_000,
      });
      expect(
        (await listDueScheduledQueuedThreadMessages(db, 5_000)).map(
          (r) => r.id,
        ),
      ).toEqual([row.id]);

      await dispose(db, noopNotifier, thread.id);
      expect(await listDueScheduledQueuedThreadMessages(db, 5_000)).toEqual([]);
    }
  });
});

describe("wait lookups", () => {
  it("finds only the rows a given plugin holds, and only while they are live", async () => {
    const { db, thread } = await setup();
    const mine = await queue(db, thread.id, "mine");
    const theirs = await queue(db, thread.id, "theirs");
    const core = await queue(db, thread.id, "core");
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: mine.id,
      threadId: thread.id,
      waitingOn: { kind: "plugin", pluginId: "limiter", reason: "full" },
      sendAt: null,
    });
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: theirs.id,
      threadId: thread.id,
      waitingOn: { kind: "plugin", pluginId: "router", reason: "picking" },
      sendAt: null,
    });
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: core.id,
      threadId: thread.id,
      waitingOn: { kind: "provisioning" },
      sendAt: null,
    });

    expect(
      (await listQueuedThreadMessagesByWaitHolder(db, "plugin:limiter")).map(
        (row) => row.id,
      ),
    ).toEqual([mine.id]);

    await claimQueuedThreadMessageGroup(db, noopNotifier, mine.id, {
      kind: "explicit-send",
    });
    expect(
      await listQueuedThreadMessagesByWaitHolder(db, "plugin:limiter"),
    ).toEqual([]);
  });

  it("lists a thread's rows by wait kind, in queue order, scoped to that thread", async () => {
    const { db, project, thread } = await setup();
    const otherThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const first = await queue(db, thread.id, "first");
    const second = await queue(db, thread.id, "second");
    const otherKind = await queue(db, thread.id, "other kind");
    const elsewhere = await queue(db, otherThread.id, "elsewhere");
    for (const id of [first.id, second.id]) {
      await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id,
        threadId: thread.id,
        waitingOn: { kind: "provisioning" },
        sendAt: null,
      });
    }
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: otherKind.id,
      threadId: thread.id,
      waitingOn: { kind: "interaction" },
      sendAt: null,
    });
    await setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: elsewhere.id,
      threadId: otherThread.id,
      waitingOn: { kind: "provisioning" },
      sendAt: null,
    });

    expect(
      (
        await listQueuedThreadMessagesWaitingOnKind(db, {
          kind: "provisioning",
          threadId: thread.id,
        })
      ).map((row) => row.id),
    ).toEqual([first.id, second.id]);
  });

  it("does not mistake a row with no wait for any wait kind", async () => {
    const { db, thread } = await setup();
    await queue(db, thread.id);

    for (const kind of [
      "time",
      "thread-busy",
      "turn-starting",
      "provisioning",
      "interaction",
      "plugin",
    ] as const) {
      expect(
        await listQueuedThreadMessagesWaitingOnKind(db, {
          kind,
          threadId: thread.id,
        }),
      ).toEqual([]);
    }
  });
});
