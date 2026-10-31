import { createMigratedConnection } from "../../src/testing.js";
import { describe, expect, it } from "vitest";
import type { PromptHistoryScope, PromptInput } from "@hyperfide/domain";
import {
  createProject,
  createPromptHistoryEntry,
  createThread,
  listPromptHistoryPage,
  markThreadDeleted,
  upsertHost,
} from "../../src/data/index.js";
import { noopNotifier } from "../../src/notifier.js";

type TestDb = Awaited<ReturnType<typeof createMigratedConnection>>;

function text(text: string): PromptInput {
  return { type: "text", text, mentions: [] };
}

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, { name: "test-host" });
  const firstProject = (
    await createProject(db, noopNotifier, {
      name: "First",
      source: { type: "local_path", hostId: host.id, path: "/tmp/first" },
    })
  ).project;
  const secondProject = (
    await createProject(db, noopNotifier, {
      name: "Second",
      source: { type: "local_path", hostId: host.id, path: "/tmp/second" },
    })
  ).project;
  const firstThread = await createThread(db, noopNotifier, {
    projectId: firstProject.id,
    providerId: "codex",
  });
  const secondThread = await createThread(db, noopNotifier, {
    projectId: firstProject.id,
    providerId: "codex",
  });
  const otherProjectThread = await createThread(db, noopNotifier, {
    projectId: secondProject.id,
    providerId: "codex",
  });
  return {
    db,
    firstProject,
    firstThread,
    otherProjectThread,
    secondProject,
    secondThread,
  };
}

async function insert(
  db: TestDb,
  args: {
    createdAt: number;
    input: PromptInput[];
    projectId: string;
    requestSequence: number;
    scope: PromptHistoryScope;
    threadId: string;
  },
) {
  return await createPromptHistoryEntry(db, args);
}

describe("prompt history page query", () => {
  it("pages every project and thread newest first, breaking ties by sequence and id", async () => {
    const fixture = await setup();
    const rows = [
      await insert(fixture.db, {
        projectId: fixture.firstProject.id,
        threadId: fixture.firstThread.id,
        scope: "project",
        requestSequence: 1,
        createdAt: 10,
        input: [text("first")],
      }),
      await insert(fixture.db, {
        projectId: fixture.firstProject.id,
        threadId: fixture.firstThread.id,
        scope: "thread",
        requestSequence: 2,
        createdAt: 20,
        input: [text("second")],
      }),
      await insert(fixture.db, {
        projectId: fixture.firstProject.id,
        threadId: fixture.secondThread.id,
        scope: "thread",
        requestSequence: 2,
        createdAt: 20,
        input: [text("tied")],
      }),
      await insert(fixture.db, {
        projectId: fixture.secondProject.id,
        threadId: fixture.otherProjectThread.id,
        scope: "thread",
        requestSequence: 3,
        createdAt: 20,
        input: [text("later sequence")],
      }),
    ];
    const expected = [...rows]
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt ||
          right.requestSequence - left.requestSequence ||
          (left.id < right.id ? 1 : -1),
      )
      .map((row) => row.id);

    const pages: string[][] = [];
    let before = null;
    do {
      const page = await listPromptHistoryPage(fixture.db, {
        before,
        limit: 3,
      });
      pages.push(page.map((row) => row.id));
      const last = page.at(-1);
      before = page.length === 3 && last !== undefined ? last : null;
    } while (before !== null);

    expect(pages.flat()).toEqual(expected);
    expect(pages.map((page) => page.length)).toEqual([3, 1]);
  });

  it("keeps prompts from soft-deleted threads", async () => {
    const fixture = await setup();
    const row = await insert(fixture.db, {
      projectId: fixture.firstProject.id,
      threadId: fixture.firstThread.id,
      scope: "thread",
      requestSequence: 1,
      createdAt: 10,
      input: [text("still history")],
    });
    await markThreadDeleted(fixture.db, noopNotifier, {
      threadId: fixture.firstThread.id,
    });

    expect(
      (
        await listPromptHistoryPage(fixture.db, { before: null, limit: 10 })
      ).map((entry) => entry.id),
    ).toEqual([row.id]);
  });
});
