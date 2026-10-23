import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskBridge, fallbackPolicy, parsePolicy } from "./bridge.js";
import { localGraphHost } from "./graph-host.js";
let root: string;
let bridge: AskBridge;
let stop: (() => void) | undefined;
const publish = vi.fn();
const rows = ["decision", "question", "secret", "variable", "permission"].map(
  (kind, index) => ({
    id: index + 1,
    kind,
    task: "3.1",
    title: "Choose",
    body: "Details",
    options: kind === "decision" ? ["a", "b"] : [],
    recommended: "a",
    state: "open",
    deadline: 123456,
    raised: 123400,
    blocking: ["secret", "variable", "permission"].includes(kind),
    default_policy: fallbackPolicy[kind],
    session: "fixture-session",
  }),
);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hyperfide-ask-bridge-"));
  await mkdir(join(root, ".codegraph"));
  await mkdir(join(root, "spec"));
  await writeFile(join(root, ".codegraph/graph.db"), "fixture");
  await writeFile(join(root, "store.json"), JSON.stringify(rows));
  const binary = join(root, "hyperfide");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync('store.json', 'utf8'));
if (args.join(' ') === '--version') console.log('hyperfide fixture');
else if (args.join(' ') === 'ask list --all --json') console.log(JSON.stringify({asks:rows}));
else if (args[0] === 'ask' && args[1] === 'answer' && args.at(-1) === '--json') {
  const row = rows.find(row => String(row.id) === args[2]);
  row.answer = args[3]; row.state = 'answered';
  fs.writeFileSync('store.json', JSON.stringify(rows));
  fs.appendFileSync('events.jsonl', JSON.stringify({kind:'ask.answered', ...{payload:row}})+'\\n');
  fs.appendFileSync('.codegraph/graph.db-wal', 'change');
  console.log(JSON.stringify(row));
} else if (args.join(' ') === 'events --kind ask. --json') {
  process.stdout.write(fs.existsSync('events.jsonl') ? fs.readFileSync('events.jsonl') : '');
} else { process.stderr.write('bad argv: '+args.join(' ')); process.exit(1); }
`,
    { mode: 0o755 },
  );
  publish.mockClear();
  bridge = new AskBridge(localGraphHost(binary), publish);
});
afterEach(async () => {
  stop?.();
  stop = undefined;
  await rm(root, { recursive: true, force: true });
});
it("mirrors the binary fields and aliases without losing raw data", async () => {
  const asks = await bridge.list(root);
  expect(asks).toHaveLength(5);
  expect(asks[0]).toMatchObject({
    ...rows[0],
    question: "Choose\n\nDetails",
    recommendation: "a",
    status: "open",
    raised_at: 123400,
  });
  expect(await bridge.get(root, "99")).toBeNull();
});
it("answers through the binary, publishes, and reads the answer journal", async () => {
  expect(await bridge.answer(root, "1", "b", "reason")).toMatchObject({
    answer: "b",
    status: "answered",
  });
  expect(
    JSON.parse(await readFile(join(root, "store.json"), "utf8"))[0].answer,
  ).toBe("b");
  expect(await bridge.journal(root)).toMatchObject([
    { kind: "ask.answered", payload: { answer: "b" } },
  ]);
  expect(publish).toHaveBeenCalledWith(
    "asks.changed",
    expect.objectContaining({ repository: root }),
  );
});
it("watches database and WAL changes, debounces, and disposes", async () => {
  stop = await bridge.watch(root);
  await writeFile(join(root, ".codegraph/graph.db-wal"), "wal");
  await vi.waitFor(
    () => expect(publish).toHaveBeenCalledWith("asks.changed", expect.anything()),
    { timeout: 10_000 },
  );
  publish.mockClear();
  await writeFile(join(root, ".codegraph/graph.db"), "db");
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  stop();
  stop = undefined;
  publish.mockClear();
  await writeFile(join(root, ".codegraph/graph.db-wal"), "stopped");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(publish).not.toHaveBeenCalled();
});
it("reads policy data with a complete built-in fallback", async () => {
  expect(await bridge.policy(root)).toEqual(fallbackPolicy);
  await writeFile(
    join(root, "spec/workflow.kvx"),
    '[asks]\nkinds = ["secret", "decision", "custom"]\nsecret = "block"\ndecision = "block"\ncustom = "proceed-and-flag"\n[next]\n',
  );
  expect(await bridge.policy(root)).toEqual({
    secret: "block",
    decision: "block",
    custom: "proceed-and-flag",
  });
  expect(() => parsePolicy('[asks]\nkinds = ["unknown"]\n')).toThrow("Missing");
});
it("rejects raw secrets and invalid options before execution", async () => {
  await expect(bridge.answer(root, "3", "private-value")).rejects.toThrow(
    "reference",
  );
  await expect(
    bridge.answer(root, "3", "secret-ref:fixture", "private-note"),
  ).rejects.toThrow("reference");
  await expect(bridge.answer(root, "1", "other")).rejects.toThrow("option");
  expect(await bridge.answer(root, "3", "secret-ref:fixture")).toMatchObject({
    answer: "secret-ref:fixture",
  });
});
it("redacts command failures and isolates repositories", async () => {
  const graph = localGraphHost(join(root, "hyperfide"));
  graph.exec = async () => {
    throw new Error("private argv");
  };
  await expect(new AskBridge(graph, publish).list(root)).rejects.toThrow(
    /^Hyperfide ask command failed$/,
  );
  const other = await mkdtemp(join(tmpdir(), "hyperfide-ask-other-"));
  try {
    await expect(bridge.list(other)).rejects.toThrow("command failed");
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

it("registers store RPCs beside the inbox and cleans up its watches", async () => {
  const { createFakePluginHost } =
    await import("@hyperfide/plugin-sdk/testing");
  const { default: plugin } = await import("./server.js");
  const host = createFakePluginHost({ pluginId: "hyperfide-asks", sdk: { plugins: { async callRpc(input) {
    expect(input.pluginId).toBe("hyperfide-graph");
    expect(input.method).toBe("getSettings");
    return { enabled: true, binaryPath: join(root, "hyperfide") };
  } } } });
  await host.hyperfide.storage.kv.set("inbox.repositories", [root]);
  await plugin(host.hyperfide as unknown as Parameters<typeof plugin>[0]);
  try {
    const call = host.harness.behavior.callRpc;
    expect(await call("list", { repository: root })).toMatchObject({
      asks: [{ id: 1, raised_at: 123400 }, {}, {}, {}, {}],
    });
    expect(await call("get", { repository: root, id: 1 })).toMatchObject({
      question: "Choose\n\nDetails",
    });
    expect(await call("policy", { repository: root })).toEqual(fallbackPolicy);
    expect(
      await call("answer", { repository: root, id: "1", answer: "b" }),
    ).toMatchObject({ status: "answered" });
    expect(await call("journal", { repository: root })).toHaveLength(1);
    expect(await call("inboxList", {})).toHaveLength(4);
    await expect(
      call("answer", { repository: root, id: "3", answer: "raw-secret" }),
    ).rejects.toThrow("reference");
  } finally {
    await host.harness.dispose();
  }
});
it("adapts policy data and watch ownership for the thread lifecycle", async () => {
  const { createStoreThreadBridge } = await import("./thread-bridge.js");
  const onError = vi.fn();
  const adapter = createStoreThreadBridge(bridge, onError);
  expect(await adapter.policy(root)).toMatchObject({
    secret: { default_policy: "block" },
    decision: { default_policy: "proceed-and-flag" },
  });
  expect((await adapter.list(root))[0]).toMatchObject({
    task: "3.1",
    session: "fixture-session",
    question: "Choose\n\nDetails",
  });
  const changed = vi.fn();
  stop = adapter.watch(root, changed);
  await bridge.answer(root, "1", "a");
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect(onError).not.toHaveBeenCalled();
});

it("exposes policy, normalized rows and watch ownership to the thread lifecycle", async () => {
  expect(await bridge.policy(root)).toMatchObject({
    secret: "block", decision: "proceed-and-flag",
  });
  expect((await bridge.list(root))[0]).toMatchObject({
    task: "3.1", session: "fixture-session", question: "Choose\n\nDetails",
  });
  const changed = vi.fn();
  stop = await bridge.watch(root, changed);
  await bridge.answer(root, "1", "a");
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
});

it("pauses and resumes through the store bridge while retaining task flags", async () => {
  const { createAskThreadService } = await import("./server.js");
  const record = vi.fn();
  const interrupt = vi.fn();
  const send = vi.fn();
  const service = createAskThreadService({
    repository: root,
    bridge,
    threads: { async list() {
      return [{ id: "fixture-session", repository: root, task: "3.1" }];
    } },
    operations: { record, stop: interrupt, send },
  });
  await service.lifecycle.sync();
  expect(interrupt).toHaveBeenCalledTimes(3);
  expect(service.board.forTask(root, "3.1").flagged).toBe(true);
  await bridge.answer(root, "3", "secret-ref:fixture");
  await bridge.answer(root, "4", "configured");
  await service.lifecycle.sync();
  expect(send).not.toHaveBeenCalled();
  await bridge.answer(root, "5", "granted");
  await service.lifecycle.sync();
  expect(send).toHaveBeenCalledWith("fixture-session", expect.stringContaining("secret-ref:fixture"));
  expect(record).toHaveBeenCalledWith("fixture-session", expect.objectContaining({ resumed: true }));
  await service.lifecycle.dispose();
});
