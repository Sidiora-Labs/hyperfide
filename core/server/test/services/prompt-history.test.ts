import { describe, expect, it } from "vitest";
import {
  archiveThread,
  createQueuedThreadMessage,
  createProject,
  createPromptHistoryEntry,
  createThread,
  markThreadDeleted,
  noopNotifier,
  promptHistoryEntries,
  upsertHost,
  type DbConnection,
} from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";
import type { PromptHistoryScope, PromptInput } from "@hyperfide/domain";
import {
  listProjectPromptHistory,
  listThreadPromptHistory,
  recordAcceptedPromptHistoryEntry,
} from "../../src/services/prompt-history.js";
import { textInput } from "../helpers/prompt-input.js";

interface InsertPromptHistoryEntryArgs {
  createdAt: number;
  db: DbConnection;
  input: PromptInput[];
  projectId: string;
  requestSequence: number;
  scope: PromptHistoryScope;
  threadId: string;
}

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const firstProject = (
    await createProject(db, noopNotifier, {
      name: "Project A",
      source: { type: "local_path", hostId: host.id, path: "/tmp/project-a" },
    })
  ).project;
  const secondProject = (
    await createProject(db, noopNotifier, {
      name: "Project B",
      source: { type: "local_path", hostId: host.id, path: "/tmp/project-b" },
    })
  ).project;
  return { db, firstProject, secondProject };
}

async function insertPromptHistoryEntry(args: InsertPromptHistoryEntryArgs) {
  return await createPromptHistoryEntry(args.db, {
    projectId: args.projectId,
    threadId: args.threadId,
    scope: args.scope,
    requestSequence: args.requestSequence,
    input: args.input,
    createdAt: args.createdAt,
  });
}

describe("prompt history service", () => {
  it("returns project create history scoped to one project", async () => {
    const { db, firstProject, secondProject } = await setup();
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

    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: firstThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: textInput("Investigate auth flow"),
    });
    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: textInput("Open incident thread"),
    });
    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      scope: "project",
      requestSequence: 2,
      createdAt: 30,
      input: textInput("Open incident thread"),
    });
    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      scope: "thread",
      requestSequence: 3,
      createdAt: 40,
      input: textInput("Follow up inside thread"),
    });
    await insertPromptHistoryEntry({
      db,
      projectId: secondProject.id,
      threadId: otherProjectThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 60,
      input: textInput("Other project prompt"),
    });

    expect(
      await listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 30,
        input: textInput("Open incident thread"),
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: textInput("Investigate auth flow"),
      },
    ]);
  });

  it("includes archived thread starter prompts in project history", async () => {
    const { db, firstProject } = await setup();
    const liveThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const archivedThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: liveThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: textInput("Visible starter prompt"),
    });
    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: archivedThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: textInput("Archived starter prompt"),
    });
    await archiveThread(db, noopNotifier, archivedThread.id);

    expect(
      await listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 20,
        input: textInput("Archived starter prompt"),
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: textInput("Visible starter prompt"),
      },
    ]);
  });

  it("includes hidden root prompts in ordinary project history", async () => {
    const { db, firstProject } = await setup();
    const visibleThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const hiddenRootThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
      visibility: "hidden",
    });

    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: visibleThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: textInput("Visible starter prompt"),
    });
    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: hiddenRootThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: textInput("Workflow worker prompt"),
    });

    expect(
      await listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 20,
        input: textInput("Workflow worker prompt"),
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: textInput("Visible starter prompt"),
      },
    ]);
  });

  it("excludes deleted thread starter prompts from project history", async () => {
    const { db, firstProject } = await setup();
    const liveThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const deletedThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: liveThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: textInput("Visible starter prompt"),
    });
    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: deletedThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: textInput("Deleted starter prompt"),
    });
    await markThreadDeleted(db, noopNotifier, { threadId: deletedThread.id });

    expect(
      await listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: textInput("Visible starter prompt"),
      },
    ]);
  });

  it("does not record project history for child thread starts", async () => {
    const { db, firstProject } = await setup();
    const parentThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const directThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const childThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
      parentThreadId: parentThread.id,
    });

    expect(
      await recordAcceptedPromptHistoryEntry(
        { db },
        {
          thread: directThread,
          input: textInput("User-created thread"),
          initiator: "user",
          target: { kind: "thread-start" },
          requestSequence: 1,
        },
      ),
    ).toBe(true);
    expect(
      await recordAcceptedPromptHistoryEntry(
        { db },
        {
          thread: childThread,
          input: textInput("Parent-created worker"),
          initiator: "user",
          target: { kind: "thread-start" },
          requestSequence: 1,
        },
      ),
    ).toBe(false);

    expect(
      await listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: expect.any(Number),
        input: textInput("User-created thread"),
      },
    ]);
  });

  it("returns thread follow-up history with queued messages merged in", async () => {
    const { db, firstProject } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: textInput("Start thread"),
    });
    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      scope: "thread",
      requestSequence: 2,
      createdAt: 30,
      input: textInput("Fix the flaky test"),
    });
    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      scope: "thread",
      requestSequence: 3,
      createdAt: 40,
      input: textInput("Add regression coverage"),
    });
    await createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("Add regression coverage"),
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
      await listThreadPromptHistory(
        { db },
        {
          threadId: thread.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^queued-message:/u),
        createdAt: expect.any(Number),
        input: textInput("Add regression coverage"),
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 30,
        input: textInput("Fix the flaky test"),
      },
    ]);
  });

  it("silently skips malformed stored prompt history rows", async () => {
    const { db, firstProject } = await setup();
    const validThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const malformedThread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    await insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: validThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: textInput("Recover valid prompt history"),
    });
    await db
      .insert(promptHistoryEntries)
      .values({
        id: "phist_malformed",
        projectId: firstProject.id,
        threadId: malformedThread.id,
        scope: "project",
        requestSequence: 1,
        input: '[{"type":"text"}]',
        createdAt: 20,
      })
      .run();

    expect(
      await listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: textInput("Recover valid prompt history"),
      },
    ]);
  });
  it("does not persist empty-input turns as prompt history rows", async () => {
    const { db, firstProject } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    expect(
      await recordAcceptedPromptHistoryEntry(
        { db },
        {
          thread,
          input: [],
          initiator: "user",
          target: { kind: "thread-start" },
          requestSequence: 1,
        },
      ),
    ).toBe(false);

    expect(await db.select().from(promptHistoryEntries).all()).toEqual([]);
    expect(
      await listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([]);
  });

  it("excludes agent-only context from recalled prompt history", async () => {
    const { db, firstProject } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const visibleInput = textInput("Explain the selected message");

    expect(
      await recordAcceptedPromptHistoryEntry(
        { db },
        {
          thread,
          input: [
            {
              type: "text",
              text: "Replying to this earlier message",
              mentions: [],
              visibility: "agent-only",
            },
            ...visibleInput,
          ],
          initiator: "user",
          target: { kind: "new-turn" },
          requestSequence: 1,
        },
      ),
    ).toBe(true);
    expect(
      await listThreadPromptHistory({ db }, { threadId: thread.id, limit: 50 }),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: expect.any(Number),
        input: visibleInput,
      },
    ]);
  });
});
