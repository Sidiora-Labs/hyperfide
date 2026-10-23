import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";
import plugin from "./server.js";
import { GraphMemoryBridge, type GraphMemoryHost } from "./graph-memory-projection.js";
import { TaskMemoryProjection } from "../hyperfide-spec/memory-packet-projection.js";

const exec = promisify(execFile);
const binary = resolve(import.meta.dirname, "../../../cg");
let fixture: string;
let otherRepository: string;
const calls: string[] = [];
const host: GraphMemoryHost = {
  async binaryPath(repository) { calls.push(repository); return binary; },
  async execute({ binary: executable, repository, args, timeoutMs }) {
    try {
      const result = await exec(executable, args, { cwd: repository, timeout: timeoutMs });
      return { exitCode: 0, ...result };
    } catch (error) {
      const result = error as { code?: number; stdout?: string; stderr?: string };
      return { exitCode: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }
  },
};
const bridge = new GraphMemoryBridge(host);
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
    const detail = await new TaskMemoryProjection(new GraphMemoryBridge(host)).detail(scope());
    expect(detail.recalledDecisions).toHaveLength(2);
    const rpc = await pluginHost.harness.callRpc("recallDecisions", scope());
    expect(rpc).toEqual({ memories: detail.recalledDecisions });
    const recalled = await pluginHost.harness.runCli(["recall", "--repository", fixture, "--task", task]);
    expect(JSON.parse(recalled.stdout ?? "").memories).toHaveLength(2);
    await exec(binary, ["remember", "Exclude facts", "--task", task, "--type", "fact"], { cwd: fixture });
    await bridge.remember({ repository: fixture, task: "fixture/other" }, "Exclude unrelated decisions");
    const packets = new TaskMemoryProjection(bridge);
    await bridge.remember({ repository: fixture, task: "fixture/7.3" }, "Current task decision");
    const packet = await packets.packet("Task 7.3 packet", { repository: fixture, task: "fixture/7.3" }, ["7.2", task]);
    expect(packet).toContain("## Recalled decisions");
    expect(packet).toContain("Use the shared authority schema");
    expect(packet).toContain("Keep task boundaries");
    expect(packet).toContain("Current task decision");
    expect(packet.match(/Use the shared authority schema/g)).toHaveLength(1);
    expect(packet).not.toContain("Exclude");
    expect(await bridge.recall({ repository: otherRepository, task })).toEqual([]);
    expect(await packets.packet("Empty packet", { repository: fixture, task: "fixture/empty" }, [])).toBe("Empty packet");
    expect(calls).toContain(fixture);
    expect(calls).toContain(otherRepository);
  });

  it("propagates host failures and rejects malformed data and scopes", async () => {
    await expect(bridge.remember({ ...scope(), task: "invalid" }, "decision")).rejects.toThrow();
    await expect(bridge.remember(scope(), " ")).rejects.toThrow();
    const missing = new GraphMemoryBridge({ ...host, binaryPath: async () => "" });
    await expect(missing.recall(scope())).rejects.toThrow("not configured");
    const failed = new GraphMemoryBridge({ ...host, execute: async () => ({ exitCode: 4, stdout: "", stderr: "host unavailable" }) });
    await expect(failed.recall(scope())).rejects.toThrow("host unavailable");
    const malformed = new GraphMemoryBridge({ ...host, execute: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }) });
    await expect(malformed.recall(scope())).rejects.toThrow();
  });
});
