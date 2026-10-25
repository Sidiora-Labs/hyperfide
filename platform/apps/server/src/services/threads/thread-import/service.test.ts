import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { PERSONAL_PROJECT_ID } from "@hyperfide/domain";
import {
  createProject,
  getStoredProviderSession,
  listStoredEventRows,
  noopNotifier,
  threads,
  upsertHost,
} from "@hyperfide/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../../../test/helpers/test-app.js";
import { discoverImportSources, importSessions } from "./service.js";
import { parseStoredEvent } from "../thread-data.js";

let harness: TestAppHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function setup() {
  harness = await createTestAppHarness();
  const host = await upsertHost(harness.db, noopNotifier, {
    name: "Import host",
  });
  await writeFile(join(harness.config.dataDir, "host-id"), host.id);
  const root = join(harness.config.dataDir, "transcripts");
  await mkdir(root, { recursive: true });
  return { deps: harness, root };
}

function stamped(rows: Record<string, unknown>[]) {
  return (
    rows
      .map((row, index) =>
        JSON.stringify({
          timestamp: `2026-10-24T12:00:${String(index).padStart(2, "0")}.000Z`,
          ...row,
        }),
      )
      .join("\n") + "\n"
  );
}

function claudeRows(
  sessionId = "claude-session",
  cwd = "/workspace/repo/nested",
) {
  const common = { sessionId, cwd };
  return [
    { ...common, type: "ai-title", title: "Prior Claude work" },
    {
      ...common,
      type: "user",
      message: { role: "user", content: "Read project files" },
    },
    {
      ...common,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Reviewing the project" },
          { type: "text", text: "Inspecting files" },
          {
            type: "tool_use",
            id: "read",
            name: "Read",
            input: { file_path: `${cwd}/file.txt` },
          },
        ],
      },
    },
    {
      ...common,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read",
            content: "Redacted contents",
          },
        ],
      },
    },
  ];
}

describe("host session import service", () => {
  it("maps cwd, preserves timestamps and canonical events, links children and reimports idempotently", async () => {
    const { deps, root } = await setup();
    const host = await upsertHost(deps.db, noopNotifier, {
      name: "Import host",
    });
    await writeFile(join(deps.config.dataDir, "host-id"), host.id);
    const { project } = await createProject(deps.db, noopNotifier, {
      name: "Mapped repo",
      source: { type: "local_path", hostId: host.id, path: "/workspace/repo" },
    });
    await writeFile(join(root, "claude-session.jsonl"), stamped(claudeRows()));
    const childDir = join(root, "claude-session", "subagents");
    await mkdir(childDir, { recursive: true });
    await writeFile(
      join(childDir, "agent-worker.jsonl"),
      stamped([
        {
          type: "user",
          sessionId: "claude-session",
          cwd: "/workspace/repo/nested",
          isSidechain: true,
          agentId: "worker",
          message: { role: "user", content: "Inspect child files" },
        },
        {
          type: "assistant",
          sessionId: "claude-session",
          isSidechain: true,
          agentId: "worker",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Child reply" }],
          },
        },
      ]),
    );
    expect(
      (await discoverImportSources({ source: "claude-code", root })).sources[0]
        .count,
    ).toBe(2);
    const first = await importSessions(deps, { source: "claude-code", root });
    expect(first.errors).toEqual([]);
    expect(first.imported).toBe(2);
    const parent = first.threads.find(
      (thread) => thread.title === "Prior Claude work",
    )!;
    expect(parent).toMatchObject({
      providerId: "provider-claude-code",
      providerThreadId: "claude-session",
    });
    const stored = await deps.db
      .select()
      .from(threads)
      .where(eq(threads.id, parent.id))
      .get();
    expect(stored).toMatchObject({
      projectId: project.id,
      createdAt: Date.parse("2026-10-24T12:00:00.000Z"),
      updatedAt: Date.parse("2026-10-24T12:00:03.000Z"),
    });
    const child = await deps.db
      .select()
      .from(threads)
      .where(eq(threads.parentThreadId, parent.id))
      .get();
    expect(child?.title).toBe("Inspect child files");
    expect(await getStoredProviderSession(deps.db, parent.id)).toEqual({
      kind: "owned",
      providerThreadId: "claude-session",
    });
    const events = await listStoredEventRows(deps.db, { threadId: parent.id });
    for (const event of events)
      expect(() => parseStoredEvent(event)).not.toThrow();
    for (const event of await listStoredEventRows(deps.db, {
      threadId: child!.id,
    }))
      expect(() => parseStoredEvent(event)).not.toThrow();
    expect(events[0]).toMatchObject({
      type: "thread/identity",
      providerThreadId: "claude-session",
      createdAt: Date.parse("2026-10-24T12:00:00.000Z"),
    });
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(events.some((event) => event.type === "turn/started")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "item/completed" &&
          JSON.parse(event.data).item?.type === "fileRead" &&
          JSON.parse(event.data).item?.status === "completed",
      ),
    ).toBe(true);
    const content = JSON.stringify(events);
    for (const text of [
      "Read project files",
      "Reviewing the project",
      "Inspecting files",
      "fileRead",
    ])
      expect(content).toContain(text);
    const again = await importSessions(deps, { source: "claude-code", root });
    expect(again).toMatchObject({
      imported: 0,
      updated: 0,
      records: 0,
      errors: [],
    });
    expect(await listStoredEventRows(deps.db, { threadId: parent.id })).toEqual(
      events,
    );
    expect(
      await deps.db
        .select()
        .from(threads)
        .where(eq(threads.id, parent.id))
        .get(),
    ).toMatchObject({
      createdAt: stored!.createdAt,
      updatedAt: stored!.updatedAt,
    });
    await appendFile(
      join(root, "claude-session.jsonl"),
      JSON.stringify({
        type: "ai-title",
        sessionId: "claude-session",
        aiTitle: "Updated Claude title",
        timestamp: "2026-10-24T12:02:00.000Z",
      }) + "\n",
    );
    const renamed = await importSessions(deps, { source: "claude-code", root });
    expect(renamed.errors).toEqual([]);
    expect(
      await deps.db
        .select()
        .from(threads)
        .where(eq(threads.id, parent.id))
        .get(),
    ).toMatchObject({ title: "Updated Claude title" });
  });

  it("imports Codex rollout events into the personal project and serializes concurrent imports", async () => {
    const { deps, root } = await setup();
    await writeFile(
      join(root, "rollout.jsonl"),
      stamped([
        {
          type: "session_meta",
          payload: { id: "codex-session", cwd: "/unmapped/project" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Prior Codex work" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Codex reasoning" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "shell",
            name: "exec_command",
            arguments: '{"cmd":"pwd"}',
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "shell",
            output: "/unmapped/project",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Codex reply" }],
          },
        },
        { type: "event_msg", payload: { type: "task_complete" } },
      ]),
    );
    const dry = await importSessions(deps, {
      source: "codex",
      root,
      dryRun: true,
    });
    expect(dry).toMatchObject({ imported: 1, records: 0, errors: [] });
    expect(await deps.db.select().from(threads).all()).toHaveLength(0);
    const results = await Promise.all([
      importSessions(deps, { source: "codex", root }),
      importSessions(deps, { source: "codex", root }),
    ]);
    expect(results.map((result) => result.imported)).toEqual([1, 0]);
    expect(results.flatMap((result) => result.errors)).toEqual([]);
    expect(results[1]).toMatchObject({ records: 0, updated: 0 });
    const thread = results[0].threads[0];
    expect(thread).toMatchObject({
      title: "Prior Codex work",
      providerId: "provider-codex",
      providerThreadId: "codex-session",
    });
    expect(await deps.db.select().from(threads).all()).toHaveLength(1);
    expect(
      await deps.db
        .select()
        .from(threads)
        .where(eq(threads.id, thread.id))
        .get(),
    ).toMatchObject({ projectId: PERSONAL_PROJECT_ID });
    const rows = await listStoredEventRows(deps.db, { threadId: thread.id });
    for (const row of rows) expect(() => parseStoredEvent(row)).not.toThrow();
    expect(await getStoredProviderSession(deps.db, thread.id)).toEqual({
      kind: "owned",
      providerThreadId: "codex-session",
    });
    for (const text of [
      "Prior Codex work",
      "Codex reasoning",
      "pwd",
      "Codex reply",
    ])
      expect(JSON.stringify(rows)).toContain(text);
    expect(rows.some((row) => row.type === "turn/completed")).toBe(true);
  });

  it("links a Codex subagent even when its rollout sorts before the parent", async () => {
    const { deps, root } = await setup();
    await writeFile(
      join(root, "a-child.jsonl"),
      stamped([
        {
          type: "session_meta",
          payload: {
            id: "codex-child",
            cwd: "/workspace/repo",
            source: {
              subagent: { thread_spawn: { parent_thread_id: "codex-parent" } },
            },
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Inspect delegated work" }],
          },
        },
      ]),
    );
    await writeFile(
      join(root, "z-parent.jsonl"),
      stamped([
        {
          type: "session_meta",
          payload: { id: "codex-parent", cwd: "/workspace/repo" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Inspect parent work" }],
          },
        },
      ]),
    );
    const result = await importSessions(deps, { source: "codex", root });
    expect(result).toMatchObject({ imported: 2, errors: [] });
    const parent = result.threads.find(
      (thread) => thread.providerThreadId === "codex-parent",
    )!;
    const child = result.threads.find(
      (thread) => thread.providerThreadId === "codex-child",
    )!;
    expect(
      await deps.db
        .select()
        .from(threads)
        .where(eq(threads.id, child.id))
        .get(),
    ).toMatchObject({ parentThreadId: parent.id });
    expect(await getStoredProviderSession(deps.db, child.id)).toEqual({
      kind: "owned",
      providerThreadId: "codex-child",
    });
  });

  it("skips a torn interior record instead of failing the session", async () => {
    const { deps, root } = await setup();
    const rows = stamped(claudeRows()).split("\n");
    const torn = JSON.stringify({
      type: "assistant",
      sessionId: "claude-session",
      timestamp: "2026-10-24T12:00:30.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "cut" }] },
    });
    // Two records written over each other on one line, as a provider crash leaves them.
    rows.splice(2, 0, torn.slice(0, Math.floor(torn.length / 2)) + torn);
    await writeFile(join(root, "claude-session.jsonl"), rows.join("\n"));
    const result = await importSessions(deps, { source: "claude-code", root });
    expect(result).toMatchObject({ imported: 1, errors: [] });
    expect(result.records).toBeGreaterThan(0);
    const events = await listStoredEventRows(deps.db, {
      threadId: result.threads[0].id,
    });
    for (const event of events)
      expect(() => parseStoredEvent(event)).not.toThrow();
    expect(JSON.stringify(events)).not.toContain("cut");
  });
  it("defers an unterminated partial record then appends it exactly once when completed", async () => {
    const { deps, root } = await setup();
    const path = join(root, "claude-session.jsonl");
    await writeFile(path, stamped(claudeRows()).replaceAll("\n", "\r\n"));
    const initial = await importSessions(deps, { source: "claude-code", root });
    const threadId = initial.threads[0].id;
    const before = await listStoredEventRows(deps.db, { threadId });
    const record = JSON.stringify({
      type: "assistant",
      sessionId: "claude-session",
      timestamp: "2026-10-24T12:01:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Later appended reply" }],
      },
    });
    const middle = Math.floor(record.length / 2);
    await appendFile(path, record.slice(0, middle));
    expect(
      await importSessions(deps, { source: "claude-code", root }),
    ).toMatchObject({ imported: 0, updated: 0, records: 0, errors: [] });
    await appendFile(path, record.slice(middle) + "\r\n");
    const appended = await importSessions(deps, {
      source: "claude-code",
      root,
    });
    expect(appended).toMatchObject({ imported: 0, updated: 1, errors: [] });
    expect(appended.records).toBeGreaterThan(0);
    const after = await listStoredEventRows(deps.db, { threadId });
    for (const event of after)
      expect(() => parseStoredEvent(event)).not.toThrow();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(JSON.stringify(after.slice(before.length))).toContain(
      "Later appended reply",
    );
    expect(
      await importSessions(deps, { source: "claude-code", root }),
    ).toMatchObject({ imported: 0, updated: 0, records: 0, errors: [] });
  });
});


describe("import source registry", () => {
  it("returns provider labels and keywords and rejects unregistered source kinds", async () => {
    const { root } = await setup();
    const discovery = await discoverImportSources({ source: "codex", root });
    expect(discovery.sources[0]).toMatchObject({
      source: "codex", label: "Codex", keywords: expect.arrayContaining(["codex"]),
    });
    await expect(discoverImportSources({ source: "unregistered-source", root })).rejects.toMatchObject({ status: 400 });
  });
});
