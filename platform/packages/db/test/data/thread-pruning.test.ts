// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../../src/testing.js";
import { markThreadPruningWork } from "../../src/data/thread-pruning-work.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createConnection } from "../../src/connection.js";
import {
  events,
  threadPruningCursors,
  threadPruningWork,
  threads,
} from "../../src/schema.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  createThread,
  unarchiveThread,
} from "../../src/data/threads.js";
import {
  advanceThreadPruning,
  getNextThreadPruningPolicy,
} from "../../src/data/thread-pruning.js";
import type { ThreadPruningPolicy } from "../../src/data/thread-pruning.js";
import {
  appendDaemonEventsInTransaction,
  getHighWaterMarks,
  deleteThreadEventSuffixInTransaction,
  getLastStoredProviderThreadId,
  getLatestStoredRateLimitsEvent,
  listThreadTurnInterruptionEventStates,
} from "../../src/data/events.js";
import { advanceLiveEventPruning } from "../../src/data/resolved-item-pruning.js";
import { getThreadEventRewriteGeneration } from "../../src/data/event-rewrite-generation.js";
import { THREAD_CONTEXT_CLEAR_OPERATION, turnScope } from "@hyperfide/domain";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, { name: "pruning" });
  const { project } = await createProject(db, noopNotifier, {
    name: "pruning",
    source: { type: "local_path", hostId: host.id, path: "/tmp/pruning" },
  });
  const thread = await createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, thread, project };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
async function seed(
  f: Fixture,
  sequence: number,
  values: Partial<typeof events.$inferInsert> = {},
) {
  await f.db
    .insert(events)
    .values({
      id: `${f.thread.id}-${sequence}`,
      threadId: f.thread.id,
      sequence,
      scopeKind: "turn",
      turnId: "turn",
      type: "provider/rateLimits/updated",
      data: JSON.stringify({ rateLimits: { providerId: "codex" } }),
      createdAt: 1,
      ...values,
    })
    .run();
  await markThreadPruningWork(f.db, [f.thread.id]);
}
async function cycle(f: Fixture, policy: ThreadPruningPolicy) {
  const results = [];
  for (let i = 0; i < 2000; i++) {
    const result = await advanceThreadPruning(f.db, policy);
    expect(result.scanned).toBeLessThanOrEqual(500);
    expect(result.removed).toBeLessThanOrEqual(500);
    results.push(result);
    if (result.action === "cycle-complete") return results;
  }
  throw new Error("Pruning did not finish a cycle");
}
async function sequences(f: Fixture) {
  return (
    await f.db
      .select({ sequence: events.sequence })
      .from(events)
      .where(eq(events.threadId, f.thread.id))
      .orderBy(events.sequence)
      .all()
  ).map((r) => r.sequence);
}

describe("thread pruning", () => {
  it("queues archive changes for every owned thread and rolls them back together", async () => {
    const f = await setup();
    try {
      const child = await createThread(f.db, noopNotifier, {
        projectId: f.project.id,
        providerId: "codex",
        lifecycleOwnerThreadId: f.thread.id,
      });
      const work = async () =>
        await f.db.select().from(threadPruningWork).all();
      await expect(
        (async () =>
          f.db.transaction(async (tx) => {
            await archiveThread(tx, noopNotifier, f.thread.id);
            throw new Error("rollback archive");
          }))(),
      ).rejects.toThrow("rollback archive");
      expect(await work()).toEqual([]);
      expect(
        (await f.db.select().from(threads).all()).every(
          (thread) => thread.archivedAt === null,
        ),
      ).toBe(true);
      await archiveThread(f.db, noopNotifier, f.thread.id);
      expect(await work()).toHaveLength(2);
      expect(await work()).toEqual(
        expect.arrayContaining([
          { policy: "rate-limits", threadId: f.thread.id, revision: 1 },
          { policy: "rate-limits", threadId: child.id, revision: 1 },
        ]),
      );
      await archiveThread(f.db, noopNotifier, f.thread.id);
      expect((await work()).every((row) => row.revision === 1)).toBe(true);
      await unarchiveThread(f.db, noopNotifier, f.thread.id);
      await expect(
        (async () =>
          f.db.transaction(async () => {
            await unarchiveThread(f.db, noopNotifier, child.id);
            throw new Error("rollback unarchive");
          }))(),
      ).rejects.toThrow("rollback unarchive");
      expect(
        (await work()).find((row) => row.threadId === child.id)?.revision,
      ).toBe(1);
      expect(
        (
          await f.db
            .select()
            .from(threads)
            .where(eq(threads.id, child.id))
            .get()
        )?.archivedAt,
      ).not.toBeNull();
      await unarchiveThread(f.db, noopNotifier, child.id);
      expect((await work()).every((row) => row.revision === 2)).toBe(true);
    } finally {
      await f.db.close();
    }
  });

  it("advances past a thread that becomes dirty again before its next cycle", async () => {
    const f = await setup();
    try {
      const other = await createThread(f.db, noopNotifier, {
        projectId: f.project.id,
        providerId: "codex",
      });
      const [first, second] = [f.thread, other].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      if (!first || !second) throw new Error("Missing pruning fixtures");
      await seed({ ...f, thread: first }, 1);
      await seed({ ...f, thread: second }, 1);
      expect((await advanceThreadPruning(f.db, "rate-limits")).threadId).toBe(
        first.id,
      );
      await seed({ ...f, thread: first }, 2);
      expect((await advanceThreadPruning(f.db, "rate-limits")).threadId).toBe(
        second.id,
      );
    } finally {
      await f.db.close();
    }
  });

  it("requires output presence only when pruning command output deltas", async () => {
    const f = await setup();
    try {
      let sequence = 0;
      const retained: number[] = [];
      for (const [itemKind, type] of [
        ["agentMessage", "item/agentMessage/delta"],
        ["reasoning", "item/reasoning/textDelta"],
        ["commandExecution", "item/commandExecution/outputDelta"],
      ] as const) {
        for (const [data, hasOutput] of [
          ["malformed", false],
          ["{}", false],
          ['{"item":{"aggregatedOutput":null}}', true],
          ['{"item":{"aggregatedOutput":42}}', true],
          ['{"item":{"aggregatedOutput":"done"}}', true],
        ] as const) {
          const itemId = `item-${sequence}`;
          await seed(f, ++sequence, { type, itemId });
          retained.push(sequence);
          await seed(f, ++sequence, { type, itemId });
          if (itemKind === "commandExecution" && !hasOutput)
            retained.push(sequence);
          await seed(f, ++sequence, {
            type: "item/completed",
            itemKind,
            itemId,
            data,
          });
          retained.push(sequence);
        }
      }
      await cycle(f, "resolved-items");
      expect(await sequences(f)).toEqual(retained);
    } finally {
      await f.db.close();
    }
  });

  it.skipIf(isPostgresTest)(
    "rotates scoped live policies durably and drains active usage without global idle cleanup",
    async () => {
      let f = await setup();
      try {
        await f.db
          .update(threads)
          .set({ status: "active" })
          .where(eq(threads.id, f.thread.id))
          .run();
        for (let i = 1; i <= 200; i++) {
          await seed(f, i, {
            type: "thread/contextWindowUsage/updated",
            data: JSON.stringify({
              contextWindowUsage: {
                usedTokens: i,
                modelContextWindow: i === 1 ? 200000 : null,
              },
            }),
          });
        }
        await seed(f, 201, { type: "turn/completed" });
        const policies = [];
        for (let i = 0; i < 160; i++) {
          const policy = await getNextThreadPruningPolicy(
            f.db,
            new Set(),
            f.thread.id,
          );
          if (policy === null) throw new Error("Missing policy");
          policies.push(policy);
          const result = await advanceThreadPruning(f.db, {
            threadId: f.thread.id,
          });
          expect(result.scanned).toBeLessThanOrEqual(32);
          expect(result.removed).toBeLessThanOrEqual(32);
          if (i === 6) {
            const saved = f.db.$client.serialize();
            await f.db.close();
            f = { ...f, db: createConnection(saved) };
          }
        }
        expect(policies.slice(0, 8)).toEqual([
          "rate-limits",
          "usage",
          "turn-diffs",
          "resolved-items",
          "rate-limits",
          "usage",
          "turn-diffs",
          "resolved-items",
        ]);
        expect(await sequences(f)).toEqual([1, 200, 201]);
        expect(
          (await f.db.select().from(threadPruningCursors).all()).every(
            (row) => row.scope === f.thread.id,
          ),
        ).toBe(true);
      } finally {
        await f.db.close();
      }
    },
  );

  it("reaches resolved deltas beyond unrelated history in one scoped advance", async () => {
    const f = await setup();
    try {
      await f.db.transaction(async () => {
        for (let i = 1; i <= 2000; i++)
          await seed(f, i, { type: "provider/warning" });
        await seed(f, 2001, {
          type: "item/agentMessage/delta",
          itemId: "message",
        });
        await seed(f, 2002, {
          type: "item/agentMessage/delta",
          itemId: "message",
        });
        await seed(f, 2003, {
          type: "item/completed",
          itemKind: "agentMessage",
          itemId: "message",
        });
      });
      for (let i = 0; i < 3; i++)
        await advanceThreadPruning(f.db, { threadId: f.thread.id });
      const result = await advanceThreadPruning(f.db, {
        threadId: f.thread.id,
      });
      expect(result.policy).toBe("resolved-items");
      expect(result.scanned).toBe(2);
      expect(result.removed).toBe(1);
      expect(await sequences(f)).toContain(2001);
      expect(await sequences(f)).not.toContain(2002);
      expect(await sequences(f)).toContain(2003);
    } finally {
      await f.db.close();
    }
  });

  it.skipIf(isPostgresTest)(
    "rolls back scoped live progress and deletion and restores the busy timeout",
    async () => {
      const f = await setup();
      try {
        await seed(f, 1);
        await seed(f, 2);
        await f.db.run(
          sql`CREATE TRIGGER fail_live_advance BEFORE UPDATE ON thread_pruning_cursors BEGIN SELECT RAISE(ABORT, 'live advance failed'); END`,
        );
        const generation = getThreadEventRewriteGeneration(f.thread.id);
        await expect(
          (async () =>
            await advanceThreadPruning(f.db, { threadId: f.thread.id }))(),
        ).rejects.toThrow("live advance failed");
        expect(f.db.$client.pragma("busy_timeout", { simple: true })).toBe(
          5000,
        );
        expect(await sequences(f)).toEqual([1, 2]);
        expect(await f.db.select().from(threadPruningCursors).all()).toEqual(
          [],
        );
        expect(getThreadEventRewriteGeneration(f.thread.id)).toBe(generation);
        await f.db.run(sql`DROP TRIGGER fail_live_advance`);
        expect(
          (await advanceThreadPruning(f.db, { threadId: f.thread.id })).removed,
        ).toBe(1);
        expect(getThreadEventRewriteGeneration(f.thread.id)).toBe(
          generation + 1,
        );
      } finally {
        await f.db.close();
      }
    },
  );

  it("isolates live progress by thread and preserves global progress on thread deletion", async () => {
    const f = await setup();
    try {
      const other = {
        ...f,
        thread: await createThread(f.db, noopNotifier, {
          projectId: f.project.id,
          providerId: "codex",
        }),
      };
      for (const fixture of [f, other]) {
        await fixture.db.transaction(async () => {
          for (let i = 1; i <= 600; i++)
            await seed(fixture, i, { type: "item/agentMessage/delta" });
        });
        for (let i = 0; i < 4; i++)
          await advanceThreadPruning(f.db, { threadId: fixture.thread.id });
      }
      await advanceThreadPruning(f.db, "rate-limits");
      const before = await f.db.select().from(threadPruningCursors).all();
      expect(
        before
          .filter((row) => row.policy === "deltas")
          .map((row) => row.scope)
          .sort(),
      ).toEqual([f.thread.id, other.thread.id].sort());
      const hasLiveDeltaCursor = async () =>
        (await f.db.select().from(threadPruningCursors).all()).some(
          (row) => row.policy === "deltas" && row.scope === f.thread.id,
        );
      for (let i = 0; i < 1000 && (await hasLiveDeltaCursor()); i++)
        await advanceThreadPruning(f.db, { threadId: f.thread.id });
      expect(await hasLiveDeltaCursor()).toBe(false);
      const remaining = await f.db.select().from(threadPruningCursors).all();
      expect(remaining.filter((row) => row.scope !== f.thread.id)).toEqual(
        before.filter((row) => row.scope !== f.thread.id),
      );
      await f.db.delete(threads).where(eq(threads.id, other.thread.id)).run();
      expect(
        (await f.db.select().from(threadPruningCursors).all()).filter(
          (row) => row.scope !== f.thread.id,
        ),
      ).toEqual(before.filter((row) => row.scope === ""));
    } finally {
      await f.db.close();
    }
  });

  it.skipIf(isPostgresTest)(
    "keeps only the latest thread snapshot across restart and late arrivals",
    async () => {
      let f = await setup();
      try {
        await f.db.transaction(async () => {
          for (let i = 1; i <= 1100; i++)
            await seed(f, i, {
              data: JSON.stringify({
                rateLimits: { providerId: "codex" },
              }),
            });
          for (const [i, data] of [
            "{broken",
            "{}",
            '{"rateLimits":{"providerId":3}}',
            '{"rateLimits":{"providerId":""}}',
          ].entries())
            await seed(f, 1101 + i, { data });
        });
        await advanceThreadPruning(f.db, "rate-limits");
        expect(
          (await advanceThreadPruning(f.db, "rate-limits")).scanned,
        ).toBeLessThanOrEqual(64);
        await seed(f, 1105);
        const saved = f.db.$client.serialize();
        await f.db.close();
        f = { ...f, db: createConnection(saved) };
        await cycle(f, "rate-limits");
        expect(await sequences(f)).toEqual([1105]);
        await cycle(f, "rate-limits");
        expect(await sequences(f)).toEqual([1105]);
        expect(
          (
            await getLatestStoredRateLimitsEvent(f.db, {
              threadId: f.thread.id,
            })
          )?.sequence,
        ).toBe(1105);
        expect(
          (await cycle(f, "rate-limits")).reduce((n, r) => n + r.removed, 0),
        ).toBe(0);
      } finally {
        await f.db.close();
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "advances live cleanup past retained first deltas and revisits late completions",
    async () => {
      const f = await setup();
      try {
        await f.db.transaction(async () => {
          for (let i = 1; i <= 125; i++) {
            await seed(f, i, {
              type: "item/agentMessage/delta",
              itemId: `item-${i}`,
            });
            await seed(f, 126 + i, {
              type: "item/completed",
              itemKind: "agentMessage",
              itemId: `item-${i}`,
            });
          }
          await seed(f, 126, {
            type: "item/agentMessage/delta",
            itemId: "item-1",
          });
          await seed(f, 252, { type: "turn/completed" });
        });
        await f.db.run(
          sql`CREATE TRIGGER fail_live_insert BEFORE INSERT ON thread_pruning_cursors WHEN NEW.policy = 'deltas' BEGIN SELECT RAISE(ABORT, 'live insert failed'); END`,
        );
        await expect(
          (async () => await advanceThreadPruning(f.db, "resolved-items"))(),
        ).rejects.toThrow("live insert failed");
        expect(await sequences(f)).toContain(126);
        expect(await f.db.select().from(threadPruningCursors).all()).toEqual(
          [],
        );
        await f.db.run(sql`DROP TRIGGER fail_live_insert`);
        expect(
          (await cycle(f, "resolved-items")).reduce((n, r) => n + r.removed, 0),
        ).toBe(1);
        expect(await sequences(f)).not.toContain(126);
        expect(
          (await sequences(f)).filter((sequence) => sequence <= 125),
        ).toHaveLength(125);
        await seed(f, 253, { type: "item/agentMessage/delta", itemId: "late" });
        await seed(f, 254, { type: "item/agentMessage/delta", itemId: "late" });
        await cycle(f, "resolved-items");
        expect(await sequences(f)).toContain(254);
        await seed(f, 255, {
          type: "item/completed",
          itemKind: "agentMessage",
          itemId: "late",
        });
        await cycle(f, "resolved-items");
        expect(await sequences(f)).toContain(253);
        expect(await sequences(f)).not.toContain(254);
      } finally {
        await f.db.close();
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "persists unfinished live probes across restart and rolls progress back with deletion",
    async () => {
      let f = await setup();
      try {
        await seed(f, 1, {
          type: "item/agentMessage/delta",
          itemId: "reused",
          parentToolCallId: "target",
        });
        await seed(f, 2, {
          type: "item/agentMessage/delta",
          itemId: "reused",
          parentToolCallId: "target",
        });
        await f.db.transaction(async () => {
          for (let i = 3; i <= 1202; i++)
            await seed(f, i, {
              type: "item/completed",
              itemKind: "agentMessage",
              itemId: "reused",
              parentToolCallId: `other-${i}`,
            });
          await seed(f, 1203, {
            type: "item/completed",
            itemKind: "agentMessage",
            itemId: "reused",
            parentToolCallId: "target",
          });
        });
        expect(
          (await advanceThreadPruning(f.db, "resolved-items")).removed,
        ).toBe(0);
        const before = await f.db.select().from(threadPruningCursors).all();
        expect(
          before.find((row) => row.policy === "deltas")?.probeSequence,
        ).toBeGreaterThan(0);
        await f.db.run(
          sql`CREATE TRIGGER fail_live_cursor BEFORE UPDATE ON thread_pruning_cursors BEGIN SELECT RAISE(ABORT, 'live cursor failed'); END`,
        );
        await expect(
          (async () => await advanceThreadPruning(f.db, "resolved-items"))(),
        ).rejects.toThrow("live cursor failed");
        expect(await f.db.select().from(threadPruningCursors).all()).toEqual(
          before,
        );
        await f.db.run(sql`DROP TRIGGER fail_live_cursor`);
        const saved = f.db.$client.serialize();
        await f.db.close();
        f = { ...f, db: createConnection(saved) };
        await cycle(f, "resolved-items");
        expect(await sequences(f)).toContain(1);
        expect(await sequences(f)).not.toContain(2);
        await f.db.delete(threads).where(eq(threads.id, f.thread.id)).run();
        expect(
          (await f.db.select().from(threadPruningCursors).all()).filter(
            (row) => row.scope !== "",
          ),
        ).toEqual([]);
      } finally {
        await f.db.close();
      }
    },
  );

  it(
    "finishes unarchived cleanup in the background and advances past retained task progress",
    async () => {
      const f = await setup();
      try {
        await f.db.transaction(async () => {
          for (let i = 1; i <= 510; i++)
            await seed(f, i, {
              type: "item/backgroundTask/progress",
              itemId: `task-${i}`,
            });
          await seed(f, 511, {
            type: "item/backgroundTask/progress",
            itemId: "task-1",
          });
          await seed(f, 512, { type: "turn/completed" });
        });
        await cycle(f, "resolved-items");
        expect(await sequences(f)).not.toContain(1);
        expect(await sequences(f)).toContain(511);
        await seed(f, 513, {
          type: "item/agentMessage/delta",
          itemId: "message",
        });
        await seed(f, 514, {
          type: "item/agentMessage/delta",
          itemId: "message",
        });
        await seed(f, 515, {
          type: "item/completed",
          itemId: "message",
          itemKind: "agentMessage",
        });
        await cycle(f, "resolved-items");
        expect(await sequences(f)).toContain(513);
        expect(await sequences(f)).not.toContain(514);
      } finally {
        await f.db.close();
      }
    },
    isPostgresTest ? 60_000 : 15_000,
  );

  it("prunes oversized snapshots without parsing their payloads", async () => {
    const f = await setup();
    try {
      const data = JSON.stringify({
        rateLimits: { providerId: "codex" },
        padding: "x".repeat(2 * 1024 * 1024),
      });
      await seed(f, 1, { data });
      await seed(f, 2, { data });
      const first = await advanceThreadPruning(f.db, "rate-limits");
      expect(first.scanned).toBe(2);
      expect(first.removed).toBe(1);
      await cycle(f, "rate-limits");
      expect(await sequences(f)).toEqual([2]);
    } finally {
      await f.db.close();
    }
  });

  it.skipIf(isPostgresTest)(
    "rolls back the cursor and deletions together without publishing a rewrite generation",
    async () => {
      const f = await setup();
      try {
        await seed(f, 1);
        await f.db
          .insert(threadPruningCursors)
          .values({ policy: "rate-limits", version: 1, updatedAt: 1 })
          .run();
        await seed(f, 2);
        const before = await f.db.select().from(threadPruningCursors).all();
        const generation = getThreadEventRewriteGeneration(f.thread.id);
        await f.db.run(
          sql`CREATE TRIGGER fail_pruning BEFORE UPDATE ON thread_pruning_cursors BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
        );
        await expect(
          (async () => await advanceThreadPruning(f.db, "rate-limits"))(),
        ).rejects.toThrow("injected failure");
        expect(await sequences(f)).toEqual([1, 2]);
        expect(await f.db.select().from(threadPruningCursors).all()).toEqual(
          before,
        );
        expect(getThreadEventRewriteGeneration(f.thread.id)).toBe(generation);
        await f.db.run(sql`DROP TRIGGER fail_pruning`);
        expect((await advanceThreadPruning(f.db, "rate-limits")).removed).toBe(
          1,
        );
        expect(getThreadEventRewriteGeneration(f.thread.id)).toBe(
          generation + 1,
        );
      } finally {
        await f.db.close();
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "resumes after a competing writer and preserves the current latest snapshot after truncation",
    async () => {
      let f = await setup();
      const directory = mkdtempSync(join(tmpdir(), "hyperfide-pruning-concurrent-"));
      const path = join(directory, "fixture.db");
      let writer: ReturnType<typeof createConnection> | undefined;
      try {
        await f.db.transaction(async () => {
          for (let i = 1; i <= 600; i++) await seed(f, i);
        });
        writeFileSync(path, f.db.$client.serialize());
        await f.db.close();
        f = { ...f, db: createConnection(path) };
        writer = createConnection(path);
        await advanceThreadPruning(f.db, "rate-limits");
        await writer.$client.exec("BEGIN IMMEDIATE");
        await expect(
          (async () =>
            await advanceThreadPruning(f.db, { threadId: f.thread.id }))(),
        ).rejects.toThrow("database is locked");
        expect(f.db.$client.pragma("busy_timeout", { simple: true })).toBe(
          5000,
        );
        await expect(
          (async () => await advanceThreadPruning(f.db, "rate-limits"))(),
        ).rejects.toThrow("database is locked");
        expect(f.db.$client.pragma("busy_timeout", { simple: true })).toBe(
          5000,
        );
        await writer.$client.exec("ROLLBACK");
        const batch = await advanceThreadPruning(f.db, "rate-limits");
        const nextSurvivor = 599;
        expect(batch.removed).toBeLessThanOrEqual(64);
        await writer.delete(events).where(eq(events.sequence, 600)).run();
        await markThreadPruningWork(writer, [f.thread.id]);
        await cycle(f, "rate-limits");
        expect(await sequences(f)).toEqual([nextSurvivor]);
        expect(
          (
            await getLatestStoredRateLimitsEvent(f.db, {
              threadId: f.thread.id,
            })
          )?.sequence,
        ).toBe(nextSurvivor);
      } finally {
        await writer?.close();
        await f.db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("revisits new thread IDs behind the traversal cursor", async () => {
    const f = await setup();
    try {
      await seed(f, 1);
      await seed(f, 2);
      await cycle(f, "rate-limits");
      const added = await createThread(f.db, noopNotifier, {
        projectId: f.project.id,
        providerId: "claude",
      });
      await f.db
        .update(threads)
        .set({ id: "aaa-pruning" })
        .where(eq(threads.id, added.id))
        .run();
      const newer = { ...f, thread: { ...added, id: "aaa-pruning" } };
      await seed(newer, 1);
      await seed(newer, 2);
      await cycle(f, "rate-limits");
      expect(await sequences(newer)).toEqual([2]);
    } finally {
      await f.db.close();
    }
  });

  it("retains the latest historical row and skips incoming diffs without allocating sequences", async () => {
    const f = await setup();
    try {
      await seed(f, 1, {
        type: "turn/started",
        providerThreadId: "old",
        data: "{}",
      });
      await seed(f, 2, {
        type: "item/completed",
        itemId: "edit",
        itemKind: "fileChange",
        data: '{"item":{"type":"fileChange","id":"edit","changes":[]}}',
      });
      await seed(f, 3, {
        type: "turn/diff/updated",
        providerThreadId: "new",
        data: '{"diff":"large"}',
      });
      await cycle(f, "turn-diffs");
      expect(await sequences(f)).toEqual([1, 2, 3]);
      expect((await getHighWaterMarks(f.db, [f.thread.id]))[f.thread.id]).toBe(
        3,
      );
      expect(await getLastStoredProviderThreadId(f.db, f.thread.id)).toBeNull();
      expect(
        (
          await listThreadTurnInterruptionEventStates(f.db, {
            threadIds: [f.thread.id],
          })
        )[0]?.latestProviderThreadId,
      ).toBeNull();
      const result = await f.db.transaction(
        async (tx) =>
          await appendDaemonEventsInTransaction(tx, [
            {
              threadId: f.thread.id,
              environmentId: null,
              scope: turnScope("turn"),
              providerThreadId: "newer",
              type: "turn/diff/updated",
              itemId: null,
              itemKind: null,
              parentToolCallId: null,
              data: '{"diff":"never stored"}',
            },
            {
              threadId: f.thread.id,
              environmentId: null,
              scope: turnScope("turn"),
              providerThreadId: "newer",
              type: "item/completed",
              itemId: "edit2",
              itemKind: "fileChange",
              parentToolCallId: null,
              data: '{"item":{"type":"fileChange","id":"edit2","changes":[]}}',
            },
          ]),
      );
      expect(result.acceptedEvents.map((r) => r.sequence)).toEqual([4]);
      expect(result.insertedInputIndexes).toEqual([1]);
      expect(await sequences(f)).toEqual([1, 2, 3, 4]);
      expect(await getLastStoredProviderThreadId(f.db, f.thread.id)).toBeNull();
      await cycle(f, "turn-diffs");
      expect(await sequences(f)).toEqual([1, 2, 4]);
      expect((await getHighWaterMarks(f.db, [f.thread.id]))[f.thread.id]).toBe(
        4,
      );
    } finally {
      await f.db.close();
    }
  });

  it("preserves the current latest row when resuming after truncation", async () => {
    const f = await setup();
    try {
      await f.db.transaction(async () => {
        for (let i = 1; i <= 1200; i++)
          await seed(f, i, { type: "turn/diff/updated", data: "{}" });
      });
      expect((await advanceThreadPruning(f.db, "turn-diffs")).removed).toBe(
        500,
      );
      await f.db.transaction(
        async (tx) =>
          await deleteThreadEventSuffixInTransaction(tx, {
            threadId: f.thread.id,
            cutoffSequence: 1000,
            oldMaxSequence: 1200,
          }),
      );
      expect((await getHighWaterMarks(f.db, [f.thread.id]))[f.thread.id]).toBe(
        999,
      );
      await cycle(f, "turn-diffs");
      expect(await sequences(f)).toEqual([999]);
      expect((await getHighWaterMarks(f.db, [f.thread.id]))[f.thread.id]).toBe(
        999,
      );
    } finally {
      await f.db.close();
    }
  });

  it("recovers identity from retained lifecycle events and respects context clearing", async () => {
    const f = await setup();
    try {
      await seed(f, 1, {
        type: "thread/identity",
        providerThreadId: "old",
        data: "{}",
      });
      await seed(f, 2, {
        type: "turn/started",
        providerThreadId: "old",
        data: "{}",
      });
      await seed(f, 3, {
        type: "turn/diff/updated",
        providerThreadId: "old",
        data: "{}",
      });
      await seed(f, 4, {
        type: "thread/identity",
        providerThreadId: "new",
        data: "{}",
      });
      await seed(f, 5, {
        type: "turn/diff/updated",
        providerThreadId: "new",
        data: "{}",
      });
      await seed(f, 6, {
        type: "turn/completed",
        providerThreadId: "new",
        data: "{}",
      });
      await seed(f, 7, {
        type: "system/error",
        providerThreadId: null,
        data: "{}",
      });
      await cycle(f, "turn-diffs");
      expect(await sequences(f)).toEqual([1, 2, 4, 6, 7]);
      expect(await getLastStoredProviderThreadId(f.db, f.thread.id)).toBe(
        "new",
      );
      expect(
        (
          await listThreadTurnInterruptionEventStates(f.db, {
            threadIds: [f.thread.id],
          })
        )[0]?.latestProviderThreadId,
      ).toBe("new");
      await seed(f, 8, {
        type: "system/operation",
        data: JSON.stringify({
          operation: THREAD_CONTEXT_CLEAR_OPERATION,
          status: "completed",
        }),
      });
      expect(await getLastStoredProviderThreadId(f.db, f.thread.id)).toBeNull();
      await seed(f, 9, {
        type: "thread/identity",
        providerThreadId: "replacement",
        data: "{}",
      });
      expect(await getLastStoredProviderThreadId(f.db, f.thread.id)).toBe(
        "replacement",
      );
    } finally {
      await f.db.close();
    }
  });

  it("drains more than 500 resolved deltas and preserves scope, first-delta and output guards", async () => {
    const f = await setup();
    try {
      await archiveThread(f.db, noopNotifier, f.thread.id);
      await f.db.transaction(async () => {
        for (let i = 1; i <= 1200; i++)
          await seed(f, i, {
            type: "item/commandExecution/outputDelta",
            itemId: "cmd",
            itemKind: "commandExecution",
            data: '{"delta":"x"}',
          });
        await seed(f, 1201, {
          type: "item/completed",
          itemId: "cmd",
          itemKind: "commandExecution",
          data: '{"item":{"aggregatedOutput":"x"}}',
        });
        for (let i = 1202; i <= 1203; i++)
          await seed(f, i, {
            type: "item/commandExecution/outputDelta",
            itemId: "cmd",
            turnId: "other",
            data: '{"delta":"keep"}',
          });
        for (let i = 1204; i <= 1205; i++)
          await seed(f, i, {
            type: "item/commandExecution/outputDelta",
            itemId: "cmd",
            parentToolCallId: "nested",
            data: '{"delta":"keep"}',
          });
        for (let i = 1206; i <= 1207; i++)
          await seed(f, i, {
            type: "item/commandExecution/outputDelta",
            itemId: "no-output",
            data: '{"delta":"keep"}',
          });
        await seed(f, 1208, {
          type: "item/completed",
          itemId: "no-output",
          itemKind: "commandExecution",
          data: '{"item":{}}',
        });
      });
      await cycle(f, "resolved-items");
      expect(await sequences(f)).toEqual([
        1, 1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208,
      ]);
    } finally {
      await f.db.close();
    }
  });

  it("preserves the first delta of each type across batches with reversed storage order", async () => {
    const f = await setup();
    try {
      const types = [
        "item/agentMessage/delta",
        "item/commandExecution/outputDelta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
      ] as const;
      for (const [index, itemKind] of (
        ["agentMessage", "commandExecution", "reasoning"] as const
      ).entries()) {
        await seed(f, 13 + index, {
          type: "item/completed",
          itemId: "item",
          itemKind,
          data: '{"item":{"aggregatedOutput":"complete"}}',
        });
      }
      for (let sequence = 12; sequence > 0; sequence--) {
        await seed(f, sequence, {
          type: types[(sequence - 1) % types.length],
          itemId: "item",
        });
      }
      await seed(f, 16, { type: "turn/completed" });
      let complete = false;
      let removed = 0;
      for (let i = 0; i < 30; i++) {
        const batch = await f.db.transaction(
          async (tx) =>
            await advanceLiveEventPruning(tx, {
              threadId: f.thread.id,
              kind: "deltas",
              limit: 5,
            }),
        );
        expect(batch.scanned).toBeLessThanOrEqual(5);
        removed += batch.removed;
        if (batch.complete) {
          complete = true;
          break;
        }
      }
      expect(complete).toBe(true);
      expect(removed).toBe(8);
      expect(await sequences(f)).toEqual([1, 2, 3, 4, 13, 14, 15, 16]);
    } finally {
      await f.db.close();
    }
  });

  it("rechecks archive status and the latest-event safeguard between rate batches", async () => {
    const f = await setup();
    try {
      for (let i = 1; i <= 130; i++) await seed(f, i);
      await seed(f, 131, { type: "turn/completed" });
      await archiveThread(f.db, noopNotifier, f.thread.id);
      expect((await advanceThreadPruning(f.db, "rate-limits")).removed).toBe(
        64,
      );
      await unarchiveThread(f.db, noopNotifier, f.thread.id);
      await cycle(f, "rate-limits");
      expect(await sequences(f)).toEqual([130, 131]);
      await archiveThread(f.db, noopNotifier, f.thread.id);
      await f.db.delete(events).where(eq(events.sequence, 131)).run();
      await markThreadPruningWork(f.db, [f.thread.id]);
      await cycle(f, "rate-limits");
      expect(await sequences(f)).toEqual([130]);
      await seed(f, 131, { type: "turn/completed" });
      await cycle(f, "rate-limits");
      expect(await sequences(f)).toEqual([131]);
    } finally {
      await f.db.close();
    }
  });

  it.each([null, 1])(
    "keeps only root usage and capacity witnesses with archivedAt=%s",
    async (archivedAt) => {
      const f = await setup();
      try {
        if (archivedAt !== null)
          await archiveThread(f.db, noopNotifier, f.thread.id);
        for (let sequence = 1; sequence <= 6; sequence++) {
          await seed(f, sequence, {
            type: "thread/contextWindowUsage/updated",
            data: JSON.stringify({
              contextWindowUsage: {
                usedTokens: sequence * 100,
                modelContextWindow: sequence === 2 ? 200000 : null,
              },
            }),
          });
          await seed(f, sequence + 6, {
            type: "thread/tokenUsage/updated",
            data: JSON.stringify({
              tokenUsage: {
                modelContextWindow: sequence === 1 ? 200000 : null,
              },
            }),
          });
        }
        await seed(f, 13, {
          type: "turn/started",
          turnId: "nested",
          parentToolCallId: "parent",
        });
        await seed(f, 14, {
          type: "thread/contextWindowUsage/updated",
          turnId: "nested",
          data: '{"contextWindowUsage":{"modelContextWindow":1000}}',
        });
        await seed(f, 15, {
          type: "thread/tokenUsage/updated",
          turnId: "nested",
        });
        await cycle(f, "usage");
        expect(await sequences(f)).toEqual([2, 6, 12, 13, 15]);
        await seed(f, 16, { type: "turn/completed" });
        await cycle(f, "usage");
        expect(await sequences(f)).toEqual([2, 6, 12, 13, 16]);
      } finally {
        await f.db.close();
      }
    },
  );

  it("retains the latest context snapshot boundary through pruning between estimates", async () => {
    const f = await setup();
    try {
      const usage = async (sequence: number, values: object) =>
        await seed(f, sequence, {
          type: "thread/contextWindowUsage/updated",
          data: JSON.stringify({
            contextWindowUsage: { estimated: true, ...values },
          }),
        });
      await usage(1, {
        usedTokens: 128000,
        modelContextWindow: 256000,
        snapshot: {
          contextWindowTokens: 256000,
          autoCompactAtTokens: 223000,
        },
      });
      await usage(2, { usedTokens: 140000, modelContextWindow: 1000000 });
      await usage(3, { usedTokens: 150000, modelContextWindow: 1000000 });
      await cycle(f, "usage");
      expect(await sequences(f)).toEqual([1, 3]);
      await usage(4, { usedTokens: null, modelContextWindow: null });
      await usage(5, { usedTokens: 160000, modelContextWindow: 1000000 });
      await cycle(f, "usage");
      expect(await sequences(f)).toEqual([4, 5]);
    } finally {
      await f.db.close();
    }
  });

  it("reports exact removed UTF-8 bytes while retaining usage keepers", async () => {
    const f = await setup();
    try {
      const context = (modelContextWindow: number | null) =>
        JSON.stringify({
          contextWindowUsage: { modelContextWindow },
          text: "é🙂",
        });
      const payloads = [
        context(200000),
        context(null),
        context(null),
        "",
        isPostgresTest ? "é🙂 x" : "é🙂\0x",
        "{}",
        "malformed",
      ];
      for (const [index, data] of payloads.entries())
        await seed(f, index + 1, {
          type:
            index < 3
              ? "thread/contextWindowUsage/updated"
              : "thread/tokenUsage/updated",
          data,
        });
      await seed(f, 8, {
        type: "turn/started",
        turnId: "nested",
        parentToolCallId: "tool",
      });
      await seed(f, 9, {
        type: "thread/tokenUsage/updated",
        turnId: "nested",
        data: "{}",
      });
      await seed(f, 10, { type: "turn/completed" });
      const results = await cycle(f, "usage");
      expect(await sequences(f)).toEqual([1, 3, 7, 8, 10]);
      expect(results.reduce((total, result) => total + result.removed, 0)).toBe(
        5,
      );
      expect(
        results.reduce((total, result) => total + result.removedBytes, 0),
      ).toBe(
        Buffer.byteLength(context(null)) +
          Buffer.byteLength(isPostgresTest ? "é🙂 x" : "é🙂\0x") +
          4,
      );
      expect(
        results
          .filter((result) => result.removed === 0)
          .every((result) => result.removedBytes === 0),
      ).toBe(true);
    } finally {
      await f.db.close();
    }
  });

  it("restarts usage keeper discovery after a keeper disappears during a visit", async () => {
    const f = await setup();
    try {
      await archiveThread(f.db, noopNotifier, f.thread.id);
      await f.db.transaction(async () => {
        for (let i = 1; i <= 600; i++)
          await seed(f, i, {
            type: "thread/contextWindowUsage/updated",
            data: JSON.stringify({
              contextWindowUsage: {
                modelContextWindow: i === 1 ? 200000 : null,
              },
            }),
          });
        await seed(f, 1000, {
          type: "system/error",
          scopeKind: "thread",
          turnId: null,
          data: "{}",
        });
      });
      await advanceThreadPruning(f.db, "usage");
      await advanceThreadPruning(f.db, "usage");
      await f.db.delete(events).where(eq(events.sequence, 600)).run();
      await markThreadPruningWork(f.db, [f.thread.id]);
      expect((await advanceThreadPruning(f.db, "usage")).removed).toBe(0);
      await cycle(f, "usage");
      await cycle(f, "usage");
      expect(await sequences(f)).toEqual([1, 599, 1000]);
    } finally {
      await f.db.close();
    }
  });

  it("revisits deltas whose completion arrives after their candidate window", async () => {
    const f = await setup();
    try {
      await archiveThread(f.db, noopNotifier, f.thread.id);
      await f.db.transaction(async () => {
        for (let i = 1; i <= 800; i++)
          await seed(f, i, {
            type: "item/agentMessage/delta",
            itemId: "late",
            data: '{"delta":"part"}',
          });
      });
      for (let i = 0; i < 10; i++) {
        const result = await advanceThreadPruning(f.db, "resolved-items");
        if (result.scanned > 0) break;
      }
      await seed(f, 801, {
        type: "item/completed",
        itemId: "late",
        itemKind: "agentMessage",
        data: '{"item":{"text":"complete"}}',
      });
      await cycle(f, "resolved-items");
      expect(await sequences(f)).toContain(1);
      await cycle(f, "resolved-items");
      expect(await sequences(f)).toEqual([1, 801]);
    } finally {
      await f.db.close();
    }
  });

  it.skipIf(isPostgresTest)(
    "resumes bounded support probes through adversarial reused-item scopes",
    async () => {
      let f = await setup();
      try {
        await archiveThread(f.db, noopNotifier, f.thread.id);
        await seed(f, 1, {
          type: "item/agentMessage/delta",
          itemId: "reused",
          parentToolCallId: "target",
        });
        await seed(f, 2, {
          type: "item/agentMessage/delta",
          itemId: "reused",
          parentToolCallId: "target",
        });
        await f.db.transaction(async () => {
          for (let i = 3; i <= 1202; i++)
            await seed(f, i, {
              type: "item/completed",
              itemId: "reused",
              itemKind: "agentMessage",
              parentToolCallId: `other-${i}`,
              data: '{"item":{"text":"unrelated"}}',
            });
          await seed(f, 1203, {
            type: "item/completed",
            itemId: "reused",
            itemKind: "agentMessage",
            parentToolCallId: "target",
            data: '{"item":{"text":"complete"}}',
          });
        });
        let pending = false;
        for (let i = 0; i < 30; i++) {
          await advanceThreadPruning(f.db, "resolved-items");
          if (
            (await f.db.select().from(threadPruningCursors).all()).some(
              (row) => row.probeEventId !== null && row.probeSequence > 0,
            )
          ) {
            pending = true;
            break;
          }
        }
        expect(pending).toBe(true);
        const saved = f.db.$client.serialize();
        await f.db.close();
        f = { ...f, db: createConnection(saved) };
        expect(await sequences(f)).toContain(2);
        const results = await cycle(f, "resolved-items");
        expect(results.reduce((sum, r) => sum + r.removed, 0)).toBe(1);
        expect(await sequences(f)).toContain(1);
        expect(await sequences(f)).not.toContain(2);
      } finally {
        await f.db.close();
      }
    },
  );

  it("cycles past disappeared threads and resets independent versioned policies", async () => {
    const f = await setup();
    try {
      for (let i = 1; i <= 501; i++) await seed(f, i);
      await advanceThreadPruning(f.db, "rate-limits");
      await f.db.delete(threads).where(eq(threads.id, f.thread.id)).run();
      expect((await advanceThreadPruning(f.db, "rate-limits")).action).toBe(
        "missing-thread",
      );
      await cycle(f, "rate-limits");
      await f.db
        .update(threadPruningCursors)
        .set({ version: 0, lastThreadId: "zzz" })
        .run();
      await cycle(f, "rate-limits");
      expect(
        (await f.db.select().from(threadPruningCursors).get())?.version,
      ).toBe(1);
      expect(await f.db.select().from(threadPruningCursors).all()).toHaveLength(
        1,
      );
      await cycle(f, "turn-diffs");
      expect(await f.db.select().from(threadPruningCursors).all()).toHaveLength(
        2,
      );
    } finally {
      await f.db.close();
    }
  });
});
