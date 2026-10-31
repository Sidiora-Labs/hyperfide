import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@hyperfide/plugin-sdk/testing";
import type { Ask } from "../../hyperfide-asks/client.js";
import asksPlugin from "../../hyperfide-asks/src/server.js";
import graphPlugin from "../../hyperfide-graph/server.js";
import { runAskCommand, type QuestionMapping } from "./ask-sync.js";
import { createAskUserQuestionPlugin, TOOL_NAME } from "./server.js";

const executeFile = promisify(execFile);
const binary = resolve(import.meta.dirname, "../../..", "cg");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "hyperfide-question-"));
  cleanups.push(() =>
    rm(repository, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    }),
  );
  await executeFile("git", ["init", "-q", repository]);
  await executeFile(binary, ["init"], { cwd: repository });
  vi.stubEnv("HYPERFIDE_BINARY", binary);
  const command = vi.fn(runAskCommand);
  async function list(): Promise<
    Array<
      Ask & {
        id: string;
        session: string;
        recommended: string;
        options: string[];
      }
    >
  > {
    const result = JSON.parse(
      await runAskCommand(repository, ["ask", "list", "--all", "--json"]),
    );
    return result.asks.map((row: Record<string, unknown>) => ({
      ...row,
      id: String(row.id),
      status: row.state,
      question: row.title,
      repository,
    }));
  }
  const graphHost = createFakePluginHost({ pluginId: "hyperfide-graph" });
  graphPlugin(graphHost.hyperfide);
  await graphHost.harness.callRpc("setSettings", {
    repository,
    hostId: "local",
    settings: { enabled: true, binaryPath: binary },
  });
  cleanups.push(() => graphHost.harness.lifecycle.dispose());
  const asksHost = createFakePluginHost({
    pluginId: "hyperfide-asks",
    sdk: {
      plugins: {
        callRpc: async ({ method, input }) => graphHost.harness.callRpc(method, input),
      },
      projects: { list: async () => [{ id: "project-test", sources: [{ path: repository }] }] },
      threads: { get: async () => ({ projectId: "project-test", originPluginId: "hyperfide-spec", title: "hyperfide-v22/3.4: Notifications" }) },
    },
  });
  await asksHost.hyperfide.storage.kv.set("inbox.repositories", [repository]);
  await asksPlugin(asksHost.hyperfide);
  cleanups.push(() => asksHost.harness.lifecycle.dispose());
  let hiddenReads = 0;
  let interactionReads = 0;
  const host: FakePluginHost = createFakePluginHost({
    pluginId: "hyperfide-ask-user-question",
    sdk: {
      plugins: {
        callRpc: async ({ method, input }) => asksHost.harness.callRpc(method, input),
      },
      threads: {
        interactions: {
          list: async () => {
            interactionReads++;
            if (hiddenReads > 0) {
              hiddenReads--;
              return [];
            }
            return host.harness.pendingInteractions.map((entry) => ({
              id: entry.id,
              threadId: entry.threadId,
              status: "pending" as const,
              statusReason: null,
              createdAt: 1,
              resolvedAt: null,
              turnId: null,
              origin: {
                kind: "plugin" as const,
                pluginId: "hyperfide-ask-user-question",
                rendererId: entry.rendererId,
              },
              payload: {
                kind: "plugin" as const,
                title: entry.title,
                data: entry.payload,
              },
              resolution: null,
            }));
          },
          respond: async ({ interactionId, value }) => {
            host.harness.submitInteraction(interactionId, value);
            return { ok: true as const };
          },
        },
      },
    },
  });
  createAskUserQuestionPlugin({ command, pollMs: 5 })(host.hyperfide);
  cleanups.push(() => host.harness.lifecycle.dispose());
  return {
    host,
    asksHost,
    repository,
    command,
    list,
    hideNextInteractionRead: () => {
      hiddenReads = 1;
    },
    interactionReads: () => interactionReads,
  };
}

const question = {
  question: "Which store?",
  header: "Store",
  recommendation: "SQLite",
  options: [
    { label: "SQLite", description: "Embedded" },
    { label: "Postgres", description: "Server" },
  ],
};

describe("real Ask CLI round trips with a fake plugin host", () => {
  it("resolves context through the real bridge and rejects a different project", async () => {
    const { asksHost, repository } = await fixture();
    expect(await asksHost.harness.callRpc("context", {
      threadId: "thread-34", projectId: "project-test",
    })).toEqual({ repository, task: "3.4" });
    await expect(asksHost.harness.callRpc("context", {
      threadId: "thread-34", projectId: "different-project",
    })).rejects.toThrow("spec worker thread");
  });

  it("raises with task, session, options and recommendation; thread answers settle the Ask", async () => {
    const { host, list, command } = await fixture();
    const call = host.harness.callAgentTool(
      TOOL_NAME,
      { questions: [question] },
      { threadId: "thread-34" },
    );
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "question",
      task: "3.4",
      session: "thread-34",
      recommended: "SQLite",
    });
    expect(rows[0]?.options).toEqual(["SQLite", "Postgres", "Other"]);
    const keys = await host.hyperfide.storage.kv.list("question:");
    const mapping = await host.hyperfide.storage.kv.get<QuestionMapping>(keys[0]!);
    expect(mapping?.asks).toEqual({ q0: rows[0]?.id });
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
      answers: {
        q0: { selected: ["q0o1"], freeText: "Use the managed service" },
      },
    });
    expect(await call).not.toHaveProperty("isError", true);
    expect((await list())[0]).toMatchObject({
      status: "answered",
      answer: "Postgres",
    });
    expect(
      command.mock.calls.filter(([, argv]) => argv[1] === "answer"),
    ).toHaveLength(1);
  }, 60_000);

  it("an inbox answer submits the pending card and treats CLI already-answered as settled", async () => {
    const {
      host,
      repository,
      list,
      command,
      hideNextInteractionRead,
      interactionReads,
    } = await fixture();
    const call = host.harness.callAgentTool(TOOL_NAME, {
      questions: [question],
    });
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    hideNextInteractionRead();
    await runAskCommand(repository, [
      "ask",
      "answer",
      (await list())[0]!.id,
      "Postgres",
    ]);
    const result = await call;
    expect(result).not.toHaveProperty("isError", true);
    expect(JSON.stringify(result)).toContain("Postgres");
    expect(host.harness.pendingInteractions).toHaveLength(0);
    expect(interactionReads()).toBeGreaterThanOrEqual(2);
    expect(
      command.mock.calls.filter(([, argv]) => argv[1] === "answer"),
    ).toHaveLength(1);
    expect((await list())[0]?.answer).toBe("Postgres");
  });

  it("keeps the text when the inbox answers Other with a note", async () => {
    const { host, repository, list } = await fixture();
    const call = host.harness.callAgentTool(TOOL_NAME, {
      questions: [question],
    });
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    await runAskCommand(repository, [
      "ask",
      "answer",
      (await list())[0]!.id,
      "Other",
      "-m",
      "Use a file",
    ]);
    const result = await call;
    expect(result).not.toHaveProperty("isError", true);
    expect(JSON.stringify(result)).toContain("Use a file");
    expect(host.harness.pendingInteractions).toHaveLength(0);
  });

  it("preserves multiple selections and custom text in the answer note", async () => {
    const { host, list } = await fixture();
    const call = host.harness.callAgentTool(TOOL_NAME, {
      questions: [{ ...question, multiSelect: true }],
    });
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const response = {
      selected: ["q0o0", "q0o1"],
      freeText: "Both during migration",
    };
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
      answers: { q0: response },
    });
    expect(await call).not.toHaveProperty("isError", true);
    expect(JSON.parse((await list())[0]!.note!)).toEqual(response);
  });

  it("does not silently invent a recommendation", async () => {
    const { host, command } = await fixture();
    const result = await host.harness.callAgentTool(TOOL_NAME, {
      questions: [{ ...question, recommendation: undefined }],
    });
    expect(result).toHaveProperty("isError", true);
    expect(JSON.stringify(result)).toContain("requires a recommended option");
    expect(command).not.toHaveBeenCalled();
  });
});
