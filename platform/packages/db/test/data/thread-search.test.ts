// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../../src/testing.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  type PromptInput,
} from "@hyperfide/domain";
import { createConnection } from "../../src/connection.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  appendStoredThreadEvent,
  insertEvents,
} from "../../src/data/events.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  createThread,
  deleteThread,
  searchThreadsWithPendingInteractionState,
  updateThread,
  upsertThreadSearchSegments,
} from "../../src/data/threads.js";
import { createMigratedConnection } from "../../src/testing.js";

interface SetupResult {
  db: ReturnType<typeof createConnection>;
  project: Awaited<ReturnType<typeof createProject>>["project"];
}

async function setup(): Promise<SetupResult> {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, project };
}

async function closeConnection(
  db: ReturnType<typeof createConnection>,
): Promise<void> {
  await db.close();
}

function runThreadSearchMigrationFiles(
  db: ReturnType<typeof createConnection>,
): void {
  for (const migrationFile of [
    "0039_thread_search.sql",
    "0040_thread_search_rowid_fts.sql",
    "0101_thread_search_prefix_fts.sql",
  ]) {
    const migrationSql = readFileSync(
      resolve(__dirname, "../../drizzle", migrationFile),
      "utf-8",
    );
    for (const statement of migrationSql
      .split("--> statement-breakpoint")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)) {
      db.$client.exec(statement);
    }
  }
}

function dropThreadSearchSchema(db: ReturnType<typeof createConnection>): void {
  db.$client.exec(`
    DROP TRIGGER IF EXISTS thread_search_segments_after_text_update;
    DROP TRIGGER IF EXISTS thread_search_segments_after_delete;
    DROP TRIGGER IF EXISTS thread_search_segments_after_insert;
    DROP TABLE IF EXISTS thread_search_segments_fts;
    DROP TABLE IF EXISTS thread_search_segments;
  `);
}

function textInput(text: string, visibility?: "agent-only"): PromptInput {
  return {
    type: "text",
    text,
    mentions: [],
    ...(visibility ? { visibility } : {}),
  };
}

function turnRequestData(input: PromptInput[]) {
  return {
    direction: "outbound" as const,
    requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
    source: "tell" as const,
    initiator: "user" as const,
    senderThreadId: null,
    input,
    target: { kind: "new-turn" as const },
    request: {
      method: "turn/start" as const,
      params: {},
    },
    execution: {
      model: "gpt-5",
      serviceTier: "default" as const,
      reasoningLevel: "medium" as const,
      permissionMode: "full" as const,
      source: "client/turn/requested" as const,
    },
  };
}

describe("thread search data", () => {
  it.skipIf(isPostgresTest)(
    "backfills existing title and conversation segments from the migration",
    async () => {
      const { db, project } = await setup();
      try {
        const thread = await createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
          title: "titlebackfill",
          titleFallback: "fallbackbackfill",
        });
        dropThreadSearchSchema(db);
        await insertEvents(db, noopNotifier, [
          {
            threadId: thread.id,
            sequence: 1,
            type: "client/turn/requested",
            scope: threadScope(),
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            data: JSON.stringify(
              turnRequestData([
                textInput("visiblebackfill"),
                textInput("secretbackfill", "agent-only"),
              ]),
            ),
          },
          {
            threadId: thread.id,
            sequence: 2,
            type: "item/completed",
            scope: turnScope("turn-1"),
            itemId: "msg-1",
            itemKind: "agentMessage",
            parentToolCallId: null,
            data: JSON.stringify({
              item: {
                id: "msg-1",
                type: "agentMessage",
                text: "assistantbackfill",
              },
            }),
          },
          {
            threadId: thread.id,
            sequence: 3,
            type: "system/manager/user_message",
            scope: threadScope(),
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            data: JSON.stringify({ text: "legacybackfill" }),
          },
        ]);

        runThreadSearchMigrationFiles(db);

        for (const query of [
          "titlebackfill",
          "fallbackbackfill",
          "visiblebackfill",
          "assistantbackfill",
          "legacybackfill",
        ]) {
          const results = await searchThreadsWithPendingInteractionState(db, {
            query,
            limitPerGroup: 20,
          });
          expect(
            results.active.results.map((result) => result.thread.id),
          ).toEqual([thread.id]);
        }

        const secretResults = await searchThreadsWithPendingInteractionState(
          db,
          {
            query: "secretbackfill",
            limitPerGroup: 20,
          },
        );
        expect(secretResults.active.total).toBe(0);
        expect(secretResults.archived.total).toBe(0);

        await updateThread(db, noopNotifier, thread.id, {
          title: "titleupdatebackfill",
        });
        const titleUpdateResults =
          await searchThreadsWithPendingInteractionState(db, {
            query: "titleupdatebackfill",
            limitPerGroup: 20,
          });
        expect(
          titleUpdateResults.active.results.map((result) => result.thread.id),
        ).toEqual([thread.id]);
      } finally {
        await closeConnection(db);
      }
    },
  );

  it("indexes live writes, groups archived matches, and excludes deleted threads", async () => {
    const { db, project } = await setup();
    try {
      const activeThread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Active thread",
      });
      await appendStoredThreadEvent(db, noopNotifier, {
        threadId: activeThread.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: turnRequestData([textInput("livewriterneedle")]),
      });
      await appendStoredThreadEvent(db, noopNotifier, {
        threadId: activeThread.id,
        type: "item/completed",
        scope: turnScope("turn-1"),
        providerThreadId: "provider-thread-1",
        data: {
          providerThreadId: "provider-thread-1",
          item: {
            id: "msg-1",
            type: "agentMessage",
            text: "assistantwriterneedle",
          },
        },
      });
      await appendStoredThreadEvent(db, noopNotifier, {
        threadId: activeThread.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: turnRequestData([textInput("secretwriterneedle", "agent-only")]),
      });

      const archivedThread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "archivewriterneedle",
      });
      await archiveThread(db, noopNotifier, archivedThread.id);

      const deletedThread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "deletedwriterneedle",
      });
      await deleteThread(db, noopNotifier, deletedThread.id);

      await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "hiddenwriterneedle",
        visibility: "hidden",
      });
      const hiddenArchivedThread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "hiddenarchivedwriterneedle",
        visibility: "hidden",
      });
      await archiveThread(db, noopNotifier, hiddenArchivedThread.id);

      const activeResults = await searchThreadsWithPendingInteractionState(db, {
        query: "livewriterneedle",
        limitPerGroup: 20,
      });
      expect(
        activeResults.active.results.map((result) => result.thread.id),
      ).toEqual([activeThread.id]);
      expect(activeResults.archived.total).toBe(0);

      const assistantResults = await searchThreadsWithPendingInteractionState(
        db,
        {
          query: "assistantwriterneedle",
          limitPerGroup: 20,
        },
      );
      expect(assistantResults.active.results[0]?.matches[0]).toMatchObject({
        sourceKind: "assistant_message",
        text: "assistantwriterneedle",
        sourceSeq: expect.any(Number),
      });

      const archivedResults = await searchThreadsWithPendingInteractionState(
        db,
        {
          query: "archivewriterneedle",
          limitPerGroup: 20,
        },
      );
      expect(archivedResults.active.total).toBe(0);
      expect(
        archivedResults.archived.results.map((result) => result.thread.id),
      ).toEqual([archivedThread.id]);

      const hiddenResults = await searchThreadsWithPendingInteractionState(db, {
        query: "hiddenwriterneedle",
        limitPerGroup: 20,
      });
      expect(hiddenResults.active.total).toBe(0);
      expect(hiddenResults.archived.total).toBe(0);

      const hiddenArchivedResults =
        await searchThreadsWithPendingInteractionState(db, {
          query: "hiddenarchivedwriterneedle",
          limitPerGroup: 20,
        });
      expect(hiddenArchivedResults.active.total).toBe(0);
      expect(hiddenArchivedResults.archived.total).toBe(0);

      for (const query of ["secretwriterneedle", "deletedwriterneedle"]) {
        const results = await searchThreadsWithPendingInteractionState(db, {
          query,
          limitPerGroup: 20,
        });
        expect(results.active.total).toBe(0);
        expect(results.archived.total).toBe(0);
      }
    } finally {
      await closeConnection(db);
    }
  });

  it("keeps one message match per thread for broad matches across limited threads", async () => {
    const { db, project } = await setup();
    try {
      const threadIndexesById = new Map<string, number>();
      for (let threadIndex = 0; threadIndex < 5; threadIndex += 1) {
        const thread = await createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
          title: `Broad match thread ${threadIndex}`,
        });
        threadIndexesById.set(thread.id, threadIndex);
        await upsertThreadSearchSegments(db, {
          segments: Array.from({ length: 100 }, (_, segmentIndex) => ({
            threadId: thread.id,
            sourceKind: "user_message",
            sourceKey: `event:${segmentIndex}`,
            sourceSeq: segmentIndex,
            text: `broadmatchneedle thread ${threadIndex} segment ${segmentIndex}`,
          })),
        });
      }

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "broadmatchneedle",
        limitPerGroup: 3,
      });

      expect(results.active.total).toBe(5);
      expect(results.active.results).toHaveLength(3);
      for (const result of results.active.results) {
        const threadIndex = threadIndexesById.get(result.thread.id);
        expect(threadIndex).toBeDefined();
        expect(result.matches.map((match) => match.text)).toEqual([
          `broadmatchneedle thread ${threadIndex} segment 0`,
        ]);
      }
    } finally {
      await closeConnection(db);
    }
  });

  it("ranks title matches first, then the rest by most recent activity", async () => {
    const { db, project } = await setup();
    try {
      const titled = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Moss plugins",
      });
      const older = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Weekly planning",
      });
      const newer = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Release notes",
      });
      await upsertThreadSearchSegments(db, {
        segments: [older, newer].map((thread) => ({
          threadId: thread.id,
          sourceKind: "assistant_message",
          sourceKey: "event:1",
          sourceSeq: 1,
          text: "moss plugins moss plugins moss plugins",
        })),
      });
      const setUpdatedAt = await db.$client.prepare(
        "UPDATE threads SET updated_at = ? WHERE id = ?",
      );
      await setUpdatedAt.run(1, titled.id);
      await setUpdatedAt.run(2, older.id);
      await setUpdatedAt.run(3, newer.id);

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "moss plugins",
        limitPerGroup: 20,
      });

      expect(results.active.results.map((result) => result.thread.id)).toEqual([
        titled.id,
        newer.id,
        older.id,
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("does not rank a titled thread's fallback text as a title match", async () => {
    const { db, project } = await setup();
    try {
      const titledWithFallback = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Weekly planning",
        titleFallback: "fallbackneedle in the first prompt",
      });
      const newerMessage = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Release notes",
      });
      await upsertThreadSearchSegments(db, {
        segments: [
          {
            threadId: newerMessage.id,
            sourceKind: "user_message",
            sourceKey: "event:1",
            sourceSeq: 1,
            text: "a fallbackneedle message",
          },
        ],
      });
      const setUpdatedAt = await db.$client.prepare(
        "UPDATE threads SET updated_at = ? WHERE id = ?",
      );
      await setUpdatedAt.run(1, titledWithFallback.id);
      await setUpdatedAt.run(2, newerMessage.id);

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "fallbackneedle",
        limitPerGroup: 20,
      });

      expect(results.active.results.map((result) => result.thread.id)).toEqual([
        newerMessage.id,
        titledWithFallback.id,
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("ranks a title as a title match only when it has every word", async () => {
    const { db, project } = await setup();
    try {
      const fullTitle = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Moss plugins",
      });
      const partialTitle = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Moss editor",
      });
      await upsertThreadSearchSegments(db, {
        segments: [
          {
            threadId: partialTitle.id,
            sourceKind: "user_message",
            sourceKey: "event:1",
            sourceSeq: 1,
            text: "add plugins support",
          },
        ],
      });
      const setUpdatedAt = await db.$client.prepare(
        "UPDATE threads SET updated_at = ? WHERE id = ?",
      );
      await setUpdatedAt.run(1, fullTitle.id);
      await setUpdatedAt.run(2, partialTitle.id);

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "moss plugins",
        limitPerGroup: 20,
      });

      expect(results.active.results.map((result) => result.thread.id)).toEqual([
        fullTitle.id,
        partialTitle.id,
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("splits an underscored query into words like other punctuation", async () => {
    const { db, project } = await setup();
    try {
      const titled = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Search the thread list",
      });
      const newerMessage = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Weekly planning",
      });
      await upsertThreadSearchSegments(db, {
        segments: [
          {
            threadId: newerMessage.id,
            sourceKind: "user_message",
            sourceKey: "event:1",
            sourceSeq: 1,
            text: "rename thread_search before shipping",
          },
        ],
      });
      const setUpdatedAt = await db.$client.prepare(
        "UPDATE threads SET updated_at = ? WHERE id = ?",
      );
      await setUpdatedAt.run(1, titled.id);
      await setUpdatedAt.run(2, newerMessage.id);

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "thread_search",
        limitPerGroup: 20,
      });

      expect(results.active.results.map((result) => result.thread.id)).toEqual([
        titled.id,
        newerMessage.id,
      ]);
      expect(results.active.results[1]?.matches[0]?.highlightRanges).toEqual([
        { start: 7, end: 13 },
        { start: 14, end: 20 },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("shows the message that has every word over an earlier partial match", async () => {
    const { db, project } = await setup();
    try {
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Weekly planning",
      });
      await upsertThreadSearchSegments(db, {
        segments: [
          {
            threadId: thread.id,
            sourceKind: "user_message",
            sourceKey: "event:1",
            sourceSeq: 1,
            text: "moss notes",
          },
          {
            threadId: thread.id,
            sourceKind: "assistant_message",
            sourceKey: "event:2",
            sourceSeq: 2,
            text: "moss plugins",
          },
        ],
      });

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "moss plugins",
        limitPerGroup: 20,
      });

      expect(
        results.active.results[0]?.matches.map((match) => ({
          text: match.text,
          sourceSeq: match.sourceSeq,
        })),
      ).toEqual([{ text: "moss plugins", sourceSeq: 2 }]);
    } finally {
      await closeConnection(db);
    }
  });

  it("returns title matches alongside the single best message match", async () => {
    const { db, project } = await setup();
    try {
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "pairedneedle title",
        titleFallback: "pairedneedle fallback",
      });
      await upsertThreadSearchSegments(db, {
        segments: [
          {
            threadId: thread.id,
            sourceKind: "user_message",
            sourceKey: "event:1",
            sourceSeq: 1,
            text: "first pairedneedle message",
          },
          {
            threadId: thread.id,
            sourceKind: "assistant_message",
            sourceKey: "event:2",
            sourceSeq: 2,
            text: "second pairedneedle reply",
          },
        ],
      });

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "pairedneedle",
        limitPerGroup: 20,
      });

      expect(results.active.total).toBe(1);
      const matches = results.active.results[0]?.matches ?? [];
      expect(
        matches
          .filter((match) => match.sourceSeq === null)
          .map((match) => match.sourceKind)
          .sort(),
      ).toEqual(["title", "title_fallback"]);
      expect(matches.filter((match) => match.sourceSeq !== null)).toHaveLength(
        1,
      );
    } finally {
      await closeConnection(db);
    }
  });

  it("limits and counts each group from one partitioned scan", async () => {
    const { db, project } = await setup();
    try {
      const activeIds: string[] = [];
      const archivedIds: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const activeThread = await createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
          title: `partitionneedle active ${index}`,
        });
        activeIds.push(activeThread.id);
        const archivedThread = await createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
          title: `partitionneedle archived ${index}`,
        });
        await archiveThread(db, noopNotifier, archivedThread.id);
        archivedIds.push(archivedThread.id);
      }

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "partitionneedle",
        limitPerGroup: 2,
      });

      expect(results.active.total).toBe(4);
      expect(results.archived.total).toBe(4);
      expect(results.active.results).toHaveLength(2);
      expect(results.archived.results).toHaveLength(2);
      for (const result of results.active.results) {
        expect(activeIds).toContain(result.thread.id);
        expect(result.thread.archivedAt).toBeNull();
      }
      for (const result of results.archived.results) {
        expect(archivedIds).toContain(result.thread.id);
        expect(result.thread.archivedAt).not.toBeNull();
      }
    } finally {
      await closeConnection(db);
    }
  });

  it("bounds message snippets around the first highlight with rebased ranges", async () => {
    const { db, project } = await setup();
    try {
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Long message thread",
      });
      const filler = Array.from(
        { length: 80 },
        (_, index) => `word${index}`,
      ).join(" ");
      const text = `${filler} snippetneedle here ${filler} snippetneedle again ${filler}`;
      await upsertThreadSearchSegments(db, {
        segments: [
          {
            threadId: thread.id,
            sourceKind: "assistant_message",
            sourceKey: "event:1",
            sourceSeq: 1,
            text,
          },
        ],
      });

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "SnippetNeedle",
        limitPerGroup: 20,
      });

      const match = results.active.results[0]?.matches.find(
        (candidate) => candidate.sourceKind === "assistant_message",
      );
      expect(match).toBeDefined();
      if (match === undefined) {
        return;
      }
      expect(match.text.length).toBeLessThanOrEqual(162);
      expect(match.text.startsWith("…")).toBe(true);
      expect(match.text.endsWith("…")).toBe(true);
      expect(match.text).toContain("snippetneedle here");
      expect(match.highlightRanges.length).toBeGreaterThan(0);
      for (const range of match.highlightRanges) {
        expect(match.text.slice(range.start, range.end)).toBe("snippetneedle");
      }
      expect(match.text.slice(1)).toMatch(/^word\d+ /u);
    } finally {
      await closeConnection(db);
    }
  });

  it("returns short messages whole and cuts unmatched long text from the start", async () => {
    const { db, project } = await setup();
    try {
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Snippet edge thread",
      });
      const longTail = "x".repeat(400);
      await upsertThreadSearchSegments(db, {
        segments: [
          {
            threadId: thread.id,
            sourceKind: "user_message",
            sourceKey: "event:1",
            sourceSeq: 1,
            text: "wholeneedle stays intact",
          },
          {
            threadId: thread.id,
            sourceKind: "user_message",
            sourceKey: "event:2",
            sourceSeq: 2,
            text: `leadneedle then ${longTail}`,
          },
        ],
      });

      const wholeResults = await searchThreadsWithPendingInteractionState(db, {
        query: "wholeneedle",
        limitPerGroup: 20,
      });
      expect(wholeResults.active.results[0]?.matches[0]).toMatchObject({
        text: "wholeneedle stays intact",
        highlightRanges: [{ start: 0, end: 11 }],
      });

      const leadResults = await searchThreadsWithPendingInteractionState(db, {
        query: "leadneedle",
        limitPerGroup: 20,
      });
      const leadMatch = leadResults.active.results[0]?.matches[0];
      expect(leadMatch?.text.startsWith("leadneedle then ")).toBe(true);
      expect(leadMatch?.text.endsWith("…")).toBe(true);
      expect(leadMatch?.text.length).toBeLessThanOrEqual(161);
      expect(leadMatch?.highlightRanges).toEqual([{ start: 0, end: 10 }]);
    } finally {
      await closeConnection(db);
    }
  });

  it("never splits a surrogate pair when cutting a snippet", async () => {
    const { db, project } = await setup();
    try {
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "Emoji thread",
      });
      const emoji = "\u{1F600}".repeat(100);
      await upsertThreadSearchSegments(db, {
        segments: [
          {
            threadId: thread.id,
            sourceKind: "assistant_message",
            sourceKey: "event:1",
            sourceSeq: 1,
            text: `${emoji}surrogateneedle${emoji}`,
          },
        ],
      });

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "surrogateneedle",
        limitPerGroup: 20,
      });

      const match = results.active.results[0]?.matches[0];
      expect(match).toBeDefined();
      if (match === undefined) {
        return;
      }
      expect(match.text).not.toMatch(/[\uD800-\uDFFF]/u);
      expect(match.text.startsWith("…")).toBe(true);
      expect(match.text.endsWith("…")).toBe(true);
      expect(match.highlightRanges).toHaveLength(1);
      const range = match.highlightRanges[0];
      expect(
        range === undefined ? null : match.text.slice(range.start, range.end),
      ).toBe("surrogateneedle");
    } finally {
      await closeConnection(db);
    }
  });

  it.skipIf(isPostgresTest)(
    "creates the FTS index with a prefix index for typeahead queries",
    async () => {
      const { db } = await setup();
      try {
        const row = await db.$client
          .prepare<
            [],
            { sql: string }
          >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thread_search_segments_fts'")
          .get();
        expect(row?.sql).toContain("prefix = '2 3'");
      } finally {
        await closeConnection(db);
      }
    },
  );

  it("finds multi-token queries split across thread segments", async () => {
    const { db, project } = await setup();
    try {
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "alpha split title",
      });
      await appendStoredThreadEvent(db, noopNotifier, {
        threadId: thread.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: turnRequestData([textInput("beta split message")]),
      });

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "alpha beta",
        limitPerGroup: 20,
      });

      expect(results.active.results.map((result) => result.thread.id)).toEqual([
        thread.id,
      ]);
      expect(
        results.active.results[0]?.matches.map((match) => match.text),
      ).toEqual(["alpha split title", "beta split message"]);
    } finally {
      await closeConnection(db);
    }
  });

  it("highlights unicode61 accent-folded matches", async () => {
    const { db, project } = await setup();
    try {
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "café planning",
      });

      const results = await searchThreadsWithPendingInteractionState(db, {
        query: "cafe",
        limitPerGroup: 20,
      });

      expect(results.active.results.map((result) => result.thread.id)).toEqual([
        thread.id,
      ]);
      expect(results.active.results[0]?.matches[0]).toMatchObject({
        text: "café planning",
        highlightRanges: [{ start: 0, end: 4 }],
        sourceSeq: null,
      });
    } finally {
      await closeConnection(db);
    }
  });
});
