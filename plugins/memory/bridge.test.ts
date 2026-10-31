import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";
import plugin from "./server.js";
import { DurableMemoryBridge } from "./durable-memory.js";
import { createBoardServer } from "../hyperfide-spec/src/board/server.js";
import { BoardController } from "../hyperfide-spec/src/board/app.js";
import { SpecReader, binaryCommand } from "../hyperfide-spec/src/reader.js";
import { createTaskWorker } from "../hyperfide-spec/src/worker.js";
import { TaskMemory } from "../hyperfide-spec/task-memory.js";

const exec = promisify(execFile);
const binary = resolve(import.meta.dirname, "../../cg");
let fixture: string;
let otherRepository: string;
const env = { ...process.env, HYPERFIDE_BIN: binary };
const bridge = new DurableMemoryBridge(env);
const task = "fixture/7.2";
const scope = () => ({ repository: fixture, task });

beforeAll(async () => {
  fixture = await mkdtemp(`${tmpdir()}/hyperfide-memory-`);
  otherRepository = await mkdtemp(`${tmpdir()}/hyperfide-memory-other-`);
  for (const repository of [fixture, otherRepository]) {
    await exec("git", ["init", "-q"], { cwd: repository });
    await writeFile(`${repository}/fixture.c`, "int fixture(void) { return 1; }\n");
    await exec(binary, ["init"], { cwd: repository });
  }
}, 60_000);
afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
  if (otherRepository) await rm(otherRepository, { recursive: true, force: true });
});

describe("Hyperfide durable memory bridge", () => {
  it("records from a worker CLI, exposes task detail and injects prerequisite packets", async () => {
    const pluginHost = createFakePluginHost({ pluginId: "hyperfide-memory" });
    await plugin(pluginHost.hyperfide, bridge);
    const recorded = await pluginHost.harness.runCli([
      "remember", "Use the shared authority schema", "--repository", fixture, "--task", task,
    ], { projectId: "fixture", threadId: "worker-7.2" });
    expect(recorded.exitCode, recorded.stderr).toBe(0);
    const id = JSON.parse(recorded.stdout ?? "").id;
    expect(id).toBeGreaterThan(0);
    const persisted = JSON.parse((await exec(binary, ["recall", "--task", task, "--json"], { cwd: fixture })).stdout);
    expect(persisted.memories).toEqual(expect.arrayContaining([expect.objectContaining({ id, body: "Use the shared authority schema" })]));
    await pluginHost.harness.callRpc("rememberDecision", { ...scope(), body: "Keep task boundaries", type: "constraint" });
    await mkdir(`${fixture}/spec/fixture`, { recursive: true });
    await writeFile(`${fixture}/spec/workflow.kvx`, '[meta]\nactive_feature = "fixture"\n');
    await writeFile(`${fixture}/spec/fixture/spec.kvx`, `[meta]
feature = "fixture"
name = "Memory fixture"
[task.7.2]
title = "Decision producer"
status = "implemented"
wave = 7
[task.7.3]
title = "Decision consumer"
status = "pending"
wave = 7
requires = ["7.2", "fixture/7.2"]
`);
    const cache = new Map();
    const reader = new SpecReader(fixture, {
      async get(key) { return cache.get(key); },
      async set(key, value) { cache.set(key, value); },
    }, async () => {}, binaryCommand(binary));
    const detail = await reader.task("fixture", "7.2");
    expect(detail.recalledDecisions).toHaveLength(2);
    const boardTask = { ...detail, status: "implemented" as const };
    const boardRpc = createBoardServer(fixture, async () => [boardTask], binary);
    const board = new BoardController({ feature: "fixture", tasks: [boardTask] }, boardRpc);
    await board.select("7.2");
    expect(board.render()).toContain("Recalled decisions");
    expect(board.render()).toContain("Use the shared authority schema");
    const rpc = await pluginHost.harness.callRpc("recallDecisions", scope());
    expect(rpc).toEqual({ memories: detail.recalledDecisions });
    const recalled = await pluginHost.harness.runCli(["recall", "--repository", fixture, "--task", task]);
    expect(JSON.parse(recalled.stdout ?? "").memories).toHaveLength(2);
    await exec(binary, ["remember", "Exclude facts", "--task", task, "--type", "fact"], { cwd: fixture });
    await bridge.remember({ repository: fixture, task: "fixture/other" }, "Exclude unrelated decisions");
    const packets = new TaskMemory(bridge);
    await bridge.remember({ repository: fixture, task: "fixture/7.3" }, "Current task decision");
    let packet = "";
    const worker = createTaskWorker({
      async readFile(environment, path) {
        if (path === ".hyperfide/packet-preamble.md") return "Fixture preamble";
        return readFile(resolve(environment, path), "utf8");
      },
      async baseCommit() { return "fixture-base"; },
      async spawn(request) { packet = request.prompt; return { id: "worker-7.3", environment: fixture }; },
      onStopped() { return () => {}; },
      async publish() {},
    }, packets);
    await worker.runTask({ repository: fixture, projectId: "fixture", feature: "fixture", task: "7.3", providerId: "fixture" });
    expect(packet).toContain("# Task fixture/7.3: Decision consumer");
    expect(packet).toContain("Fixture preamble");
    expect(packet).toContain("## Recalled decisions");
    expect(packet).toContain("Use the shared authority schema");
    expect(packet).toContain("Keep task boundaries");
    expect(packet).toContain("Current task decision");
    expect(packet.match(/Use the shared authority schema/g)).toHaveLength(1);
    expect(packet).not.toContain("Exclude");
    expect(await bridge.recall({ repository: otherRepository, task })).toEqual([]);
    expect(await packets.packet("Empty packet", { repository: fixture, task: "fixture/empty" }, [])).toBe("Empty packet");
  }, 60_000);

  it("rejects unavailable binaries and invalid scopes", async () => {
    await expect(bridge.remember({ ...scope(), task: "invalid" }, "decision")).rejects.toThrow();
    await expect(bridge.remember(scope(), " ")).rejects.toThrow();
    const missing = new DurableMemoryBridge({ ...env, HYPERFIDE_BIN: "/missing-hyperfide" });
    await expect(missing.recall(scope())).rejects.toThrow("not configured");
  });
});
