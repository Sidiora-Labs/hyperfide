import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DbTransaction } from "../../src/connection.js";
import { noopNotifier } from "../../src/notifier.js";
import { threads } from "../../src/schema.js";
import {
  applyThreadLifecycleEvent,
  applyThreadLifecycleEventInTransaction,
  createThread,
  getThread,
  markThreadDeleted,
  requireThreadLifecycleEventApplied,
  ThreadLifecycleEventNotAppliedError,
} from "../../src/data/threads.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { withWriteAfterFirstRead } from "../helpers/interleave.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

describe("applyThreadLifecycleEvent", () => {
  it("applies a legal event and persists the row", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "starting",
    });

    const outcome = await applyThreadLifecycleEvent(db, {
      event: { type: "run.started" },
      threadId: thread.id,
    });

    expect(outcome.applied).toBe(true);
    if (outcome.applied) {
      expect(outcome.thread.status).toBe("active");
    }
    expect((await getThread(db, thread.id))?.status).toBe("active");
  });

  it("applies events inside an existing transaction", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });

    const outcome = await db.transaction(
      async (tx) =>
        await applyThreadLifecycleEventInTransaction(tx, {
          event: { type: "run.succeeded" },
          threadId: thread.id,
        }),
    );

    expect(outcome.applied).toBe(true);
    expect((await getThread(db, thread.id))?.status).toBe("idle");
  });

  it("no-ops as illegal-transition and leaves the row untouched", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = await setup();
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });

      vi.setSystemTime(2_000);
      const outcome = await applyThreadLifecycleEvent(db, {
        event: { type: "run.succeeded" },
        threadId: thread.id,
      });

      expect(outcome).toEqual({
        applied: false,
        detail: "no transition for run.succeeded from status idle",
        reason: "illegal-transition",
      });
      expect(await getThread(db, thread.id)).toEqual(thread);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no-ops as superseded when the thread is deleted", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "starting",
    });
    await markThreadDeleted(db, noopNotifier, { threadId: thread.id });
    const beforeRow = await getThread(db, thread.id);

    const outcome = await applyThreadLifecycleEvent(db, {
      event: { type: "run.started" },
      threadId: thread.id,
    });

    expect(outcome).toEqual({
      applied: false,
      detail: "deletedAt set",
      reason: "superseded",
    });
    expect(await getThread(db, thread.id)).toEqual(beforeRow);
  });

  it("no-ops as not-found for a missing thread", async () => {
    const { db } = await setup();
    const outcome = await applyThreadLifecycleEvent(db, {
      event: { type: "run.started" },
      threadId: "thr_nonexistent",
    });
    expect(outcome).toEqual({
      applied: false,
      detail: "thread not found: thr_nonexistent",
      reason: "not-found",
    });
  });

  it("no-ops as cas-conflict when the status changes between load and update", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "starting",
    });

    const outcome = await db.transaction(async (tx: DbTransaction) => {
      const interleaved = withWriteAfterFirstRead(tx, async () => {
        await tx
          .update(threads)
          .set({ status: "idle" })
          .where(eq(threads.id, thread.id))
          .run();
      });
      return await applyThreadLifecycleEventInTransaction(interleaved, {
        event: { type: "run.started" },
        threadId: thread.id,
      });
    });

    expect(outcome).toEqual({
      applied: false,
      detail: "status changed from starting while applying run.started",
      reason: "cas-conflict",
    });
    expect((await getThread(db, thread.id))?.status).toBe("idle");
  });

  it("sets latestAttentionAt only on attention-worthy transitions", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = await setup();

      const cases = [
        {
          attention: true,
          event: { type: "run.succeeded" },
          parent: false,
          status: "active",
          target: "idle",
        },
        {
          attention: false,
          event: { type: "run.succeeded" },
          parent: true,
          status: "active",
          target: "idle",
        },
        {
          attention: false,
          event: { type: "run.started" },
          parent: false,
          status: "starting",
          target: "active",
        },
        {
          attention: true,
          event: { type: "run.failed" },
          parent: false,
          status: "starting",
          target: "error",
        },
      ] as const;

      let now = 1_000;
      for (const testCase of cases) {
        const parentThreadId = testCase.parent
          ? (
              await createThread(db, noopNotifier, {
                projectId: project.id,
                providerId: "codex",
              })
            ).id
          : null;
        const thread = await createThread(db, noopNotifier, {
          parentThreadId,
          projectId: project.id,
          providerId: "codex",
          status: testCase.status,
        });

        now += 1_000;
        vi.setSystemTime(now);
        const outcome = await applyThreadLifecycleEvent(db, {
          event: testCase.event,
          threadId: thread.id,
        });

        expect(outcome.applied).toBe(true);
        if (!outcome.applied) {
          continue;
        }
        expect(outcome.thread.status).toBe(testCase.target);
        expect(outcome.thread.updatedAt).toBe(now);
        expect(outcome.thread.latestAttentionAt).toBe(
          testCase.attention ? now : thread.latestAttentionAt,
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("requireThreadLifecycleEventApplied", () => {
  it("throws a typed error carrying reason and detail on a no-op", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });

    const outcome = await applyThreadLifecycleEvent(db, {
      event: { type: "run.succeeded" },
      threadId: thread.id,
    });
    let caught: ThreadLifecycleEventNotAppliedError | null = null;
    try {
      requireThreadLifecycleEventApplied(outcome);
    } catch (error) {
      if (error instanceof ThreadLifecycleEventNotAppliedError) {
        caught = error;
      }
    }
    expect(caught?.reason).toBe("illegal-transition");
    expect(caught?.detail).toBe(
      "no transition for run.succeeded from status idle",
    );
  });
});
