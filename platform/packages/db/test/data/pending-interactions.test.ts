import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  createPendingInteraction,
  getActivePendingInteractionForThread,
  getPendingInteractionByProviderRequest,
  interruptPendingInteractionsForThreads,
  listPendingInteractionsByThread,
  setPendingInteractionResolved,
} from "../../src/data/pending-interactions.js";
import { createThread } from "../../src/data/threads.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/test-project",
    },
  });
  const environment = await createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    projectId: project.id,
    hostId: host.id,
    status: "ready",
  });
  const thread = await createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
  });
  const siblingThread = await createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
  });

  return { db, thread, siblingThread };
}

function commandApprovalPayload(command: string, itemId: string): string {
  return JSON.stringify({
    subject: {
      kind: "command",
      itemId,
      command,
      cwd: "/tmp/project",
    },
    reason: null,
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  });
}

function fileChangeApprovalPayload(itemId: string): string {
  return JSON.stringify({
    subject: {
      kind: "file_change",
      itemId,
    },
    reason: "Needs file write approval",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  });
}

describe("pending interactions", () => {
  it("creates and looks up provider-correlated pending interactions", async () => {
    const { db, thread } = await setup();

    const created = await createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
      payload: commandApprovalPayload("git push", "item-1"),
    });

    expect(created.status).toBe("pending");
    expect(
      (
        await getPendingInteractionByProviderRequest(db, {
          providerId: "codex",
          providerThreadId: "provider-thread-1",
          providerRequestId: "request-1",
        })
      )?.id,
    ).toBe(created.id);
    expect(
      (await getActivePendingInteractionForThread(db, thread.id))?.id,
    ).toBe(created.id);
  });

  it("rejects duplicate provider request identities", async () => {
    const { db, siblingThread, thread } = await setup();
    const created = await createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
      payload: commandApprovalPayload("git push", "item-1"),
    });

    await expect(
      (async () =>
        await createPendingInteraction(db, {
          threadId: siblingThread.id,
          turnId: "turn-2",
          providerId: "codex",
          providerThreadId: "provider-thread-1",
          providerRequestId: "request-1",
          payload: commandApprovalPayload("git status", "item-2"),
        }))(),
    ).rejects.toThrow();
    expect(
      (
        await getPendingInteractionByProviderRequest(db, {
          providerId: "codex",
          providerThreadId: "provider-thread-1",
          providerRequestId: "request-1",
        })
      )?.id,
    ).toBe(created.id);
  });

  it("lists pending interactions newest first and transitions them to resolved", async () => {
    const { db, thread } = await setup();

    const older = await createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
      payload: commandApprovalPayload("git push", "item-1"),
    });
    const newer = await createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-2",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-2",
      payload: fileChangeApprovalPayload("item-2"),
    });

    expect(
      (await listPendingInteractionsByThread(db, { threadId: thread.id })).map(
        (row) => row.id,
      ),
    ).toEqual([newer.id, older.id]);

    const resolved = await setPendingInteractionResolved(db, {
      id: older.id,
      resolution: JSON.stringify({
        decision: "allow_for_session",
        grantedPermissions: null,
      }),
    });

    expect(resolved).toMatchObject({
      id: older.id,
      status: "resolved",
    });
  });

  it("interrupts pending interactions for matching provider threads only", async () => {
    const { db, thread, siblingThread } = await setup();

    const interruptedTarget = await createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
      payload: commandApprovalPayload("git push", "item-1"),
    });
    await createPendingInteraction(db, {
      threadId: siblingThread.id,
      turnId: "turn-2",
      providerId: "claude-code",
      providerThreadId: "provider-thread-2",
      providerRequestId: "request-2",
      payload: commandApprovalPayload("rm -rf build", "item-2"),
    });

    const interrupted = await interruptPendingInteractionsForThreads(db, {
      providerId: "codex",
      threadIds: [thread.id],
      statusReason: "Provider exited",
    });

    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({
      id: interruptedTarget.id,
      status: "interrupted",
      statusReason: "Provider exited",
    });
    expect(
      (await getActivePendingInteractionForThread(db, siblingThread.id))
        ?.status,
    ).toBe("pending");
  });

  it("chunks provider-thread interrupts to stay under SQLite variable limits", async () => {
    const { db, siblingThread, thread } = await setup();
    const threadIds = Array.from(
      { length: 1_050 },
      (_, index) => `thr_missing_batch_${index}`,
    );
    threadIds[0] = thread.id;
    threadIds[1_000] = siblingThread.id;
    const targetThreadIds = [thread.id, siblingThread.id];

    for (const [index, threadId] of targetThreadIds.entries()) {
      await createPendingInteraction(db, {
        threadId,
        turnId: `turn-batched-interrupt-provider-${index}`,
        providerId: "codex",
        providerThreadId: `provider-thread-batched-interrupt-provider-${index}`,
        providerRequestId: `request-batched-interrupt-provider-${index}`,
        payload: commandApprovalPayload(
          "git push",
          `item-batched-interrupt-provider-${index}`,
        ),
      });
    }

    expect(
      new Set(
        (
          await interruptPendingInteractionsForThreads(db, {
            providerId: "codex",
            threadIds,
            statusReason: "Provider exited",
          })
        ).map((row) => row.threadId),
      ),
    ).toEqual(new Set(targetThreadIds));
  });
});
