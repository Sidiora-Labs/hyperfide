import { openDispatchStorage } from '../storage';
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dispatcher } from "./dispatcher";
import type { DispatcherOptions, SpecTask } from "./contracts";
import { FakeMachineProvider } from "../testing/fake-machine";
import { EchoRunner } from "../testing/echo-runner";
import { commandRunner } from "./runners";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hyperfide-dispatch-"));
  directories.push(directory);
  const controls = await openDispatchStorage(directory);
  await controls.put("fleet.control", { cap: 2, maximum: 2, paused: false });
  controls.close();
  const machines = new FakeMachineProvider();
  const seed = await machines.create();
  await seed.checkpoint("current");
  await seed.destroy();
  const runner = new EchoRunner();
  const tasks: SpecTask[] = ["a", "b", "c"].map((id) => ({
    id,
    status: "pending",
    requires: [],
    wave: 1,
  }));
  const claimed = new Set<string>();
  const released: string[] = [];
  let now = 0;
  const options: DispatcherOptions = {
    directory,
    machines,
    runner,
    cap: 2,
    keys: [
      { id: "one", value: "key-test-0001", concurrency: 1 },
      { id: "two", value: "key-test-0002", concurrency: 1 },
    ],
    spec: {
      tasks: async () => tasks,
      merged: async (id) => id === "merged",
      claim: async (id) => {
        if (claimed.has(id)) return false;
        claimed.add(id);
        return true;
      },
      release: async (id) => {
        claimed.delete(id);
        released.push(id);
      },
    },
    limits: async () => ({ global: 3, host: 2, otherRunning: 0 }),
    checkpoint: async () => "current",
    integration: async () => ({ tip: "abc123", bundle: Buffer.from("bundle") }),
    packet: async (task) => ({ task, prompt: "Implement " + task }),
    prepare: "hyperfide prepare",
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  };
  return {
    options,
    machines,
    runner,
    tasks,
    claimed,
    released,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("dispatcher", () => {
  it("honors fleet pause and cap controls from the shared persistent store", async () => {
    const f = await fixture();
    const storage = await openDispatchStorage(f.options.directory);
    f.options.storage = storage;
    const d = new Dispatcher(f.options);
    try {
      await d.start();
      await storage.put("fleet.control", { cap: 1, maximum: 2, paused: true });
      await d.tick();
      expect(d.jobs.size).toBe(0);
      await storage.put("fleet.control", { cap: 1, maximum: 2, paused: false });
      await d.tick();
      await d.drain();
      expect(d.jobs.size).toBe(1);
    } finally { d.close(); }
  });
  it("does not retry a running job cancelled through the shared store", async () => {
    const f = await fixture();
    f.tasks.splice(1);
    const storage = await openDispatchStorage(f.options.directory);
    f.options.storage = storage;
    const d = new Dispatcher(f.options);
    f.options.runner = { run: async () => {
      const job = [...d.jobs.values()][0];
      await storage.put("job:" + job.id, { ...job, cancelled: true });
      return { exitCode: 0, commits: [] };
    } };
    try {
      await d.start();
      await d.tick();
      await d.drain();
      expect([...d.jobs.values()][0]).toMatchObject({ state: "failed", attempt: 1, cancelled: true });
      expect(f.claimed.size).toBe(0);
    } finally { d.close(); }
  });
  it("does not claim without an available gateway key", async () => {
    const f = await fixture();
    f.options.keys = [];
    const d = new Dispatcher(f.options);
    await d.start();
    await d.tick();
    expect(d.jobs.size).toBe(0);
    expect(f.claimed.size).toBe(0);
  });
  it("detects HTTP 429 in successful runner output and retries after backoff", async () => {
    const f = await fixture();
    f.tasks.splice(1);
    const delays: number[] = [];
    f.options.wait = async (ms) => {
      delays.push(ms);
      f.advance(ms);
    };
    f.runner.results = [
      { exitCode: 0, commits: [], stdout: "HTTP 429 from gateway" },
    ];
    const d = new Dispatcher(f.options);
    await d.start();
    await d.tick();
    await d.drain();
    expect(delays).toEqual([60000]);
    expect(f.runner.calls).toHaveLength(2);
    expect([...d.jobs.values()][0].state).toBe("succeeded");
  });
  it("uses merged integration membership, not task status; claims before launch", async () => {
    const f = await fixture();
    f.tasks[0].requires = ["not-merged"];
    f.tasks[1].requires = ["merged"];
    f.claimed.add("c");
    const d = new Dispatcher(f.options);
    await d.start();
    await d.tick();
    await d.drain();
    expect(f.runner.calls.map((c) => c.packet.task)).toEqual(["b"]);
    expect(f.released).toEqual(["b"]);
    expect(f.machines.execLog[0].command).toContain(
      "git checkout --detach 'abc123'",
    );
    expect(f.machines.execLog[0].command).toContain("hyperfide prepare");
    expect([...f.machines.machines.values()].every((m) => m.destroyed)).toBe(
      true,
    );
    const job = [...d.jobs.values()][0];
    const storage = await openDispatchStorage(f.options.directory);
    const serialized = JSON.stringify(await storage.get('job:' + job.id));
    storage.close();
    expect(JSON.parse(serialized).commits).toEqual(["echo-commit"]);
    expect(serialized).not.toContain("key-test");
  });
  it("enforces cap and distinct per-key reservations under overlapping ticks", async () => {
    const f = await fixture();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = f.runner.run.bind(f.runner);
    f.runner.run = async (...args) => {
      const result = await original(...args);
      await gate;
      return result;
    };
    const d = new Dispatcher(f.options);
    await d.start();
    await Promise.all([d.tick(), d.tick()]);
    // Wait for preparation without completing either runner.
    await vi.waitFor(() => expect(f.runner.calls).toHaveLength(2), { timeout: 5000 });
    expect(d.jobs.size).toBe(2);
    expect(new Set(f.runner.calls.map((c) => c.key)).size).toBe(2);
    finish();
    await d.drain();
    await d.tick();
    await d.drain();
    expect(f.runner.calls).toHaveLength(3);
  });
  it.each([0, 1])("obeys injected host/global availability %s", async (cap) => {
    const f = await fixture();
    f.options.limits = async () => ({
      global: 2,
      host: 4,
      otherRunning: 2 - cap,
    });
    const d = new Dispatcher(f.options);
    await d.start();
    await d.tick();
    await d.drain();
    expect(f.runner.calls).toHaveLength(cap);
  });
  it("retries only once on a different machine, then remains terminal", async () => {
    const f = await fixture();
    f.tasks.splice(1);
    f.runner.results = [new Error("failure"), new Error("failure again")];
    const d = new Dispatcher(f.options);
    await d.start();
    await d.tick();
    await d.drain();
    await d.tick();
    await d.drain();
    expect(f.runner.calls).toHaveLength(2);
    expect(f.runner.calls[0].machine).not.toBe(f.runner.calls[1].machine);
    expect([...d.jobs.values()][0]).toMatchObject({
      state: "failed",
      attempt: 2,
    });
    expect([...f.machines.machines.values()].every((m) => m.destroyed)).toBe(
      true,
    );
  });
  it("backs off 60 seconds doubling to a 600 second ceiling, persisting across restart", async () => {
    const f = await fixture();
    f.options.cap = 1;
    f.tasks.splice(1);
    const delays: number[] = [];
    f.options.wait = async (ms) => {
      delays.push(ms);
      f.advance(ms);
    };
    f.runner.results = [new Error("HTTP 429"), new Error("HTTP 429")];
    const d = new Dispatcher(f.options);
    await d.start();
    await d.tick();
    await d.drain();
    expect([...d.jobs.values()][0].error).toContain("HTTP 429");
    expect(delays).toEqual([60000]);
    f.tasks.push({ id: "next", status: "pending", requires: [], wave: 2 });
    const restarted = new Dispatcher(f.options);
    await restarted.start();
    await restarted.tick();
    expect(f.runner.calls).toHaveLength(2);
    f.advance(120000);
    await restarted.tick();
    await restarted.drain();
    expect(f.runner.calls).toHaveLength(3);
    for (let n = 0; n < 4; n++) {
      f.advance(600000);
      f.tasks.push({
        id: "rate-" + n,
        status: "pending",
        requires: [],
        wave: 2,
      });
      f.runner.results = [new Error("HTTP 429"), new Error("HTTP 429")];
      await restarted.tick();
      await restarted.drain();
    }
    expect(delays.every((ms) => ms <= 600000)).toBe(true);
    expect(delays).toContain(600000);
  });
  it("reconciles interrupted ledgers and owned orphans while preserving unrelated machines", async () => {
    const f = await fixture();
    const orphan = await f.machines.create({
      name: "hyperfide-dispatch-orphan",
    });
    const unrelated = await f.machines.create({ name: "integration" });
    await writeFile(
      join(f.options.directory, "interrupted.json"),
      JSON.stringify({
        id: "interrupted",
        task: "a",
        state: "running",
        attempt: 1,
        machine: orphan.id,
        keyId: "one",
        commits: [],
      }),
    );
    const d = new Dispatcher(f.options);
    await d.start();
    expect(orphan.destroyed).toBe(true);
    expect(unrelated.destroyed).toBe(false);
    expect(d.jobs.get("interrupted")?.state).toBe("failed");
    expect(f.released).toEqual(["a"]);
    const again = new Dispatcher(f.options);
    await again.start();
    expect(again.jobs.get("interrupted")?.error).toBe("Dispatcher restarted");
  });
  it("cleans up when preparation fails and never invokes runner", async () => {
    const f = await fixture();
    f.tasks.splice(1);
    f.machines.scripts.push({
      pattern: /git fetch/,
      result: { exitCode: 1, stderr: "prepare failed" },
    });
    const d = new Dispatcher(f.options);
    await d.start();
    await d.tick();
    await d.drain();
    expect(f.runner.calls).toHaveLength(0);
    expect([...d.jobs.values()][0].attempt).toBe(2);
    expect([...f.machines.machines.values()].every((m) => m.destroyed)).toBe(
      true,
    );
  });
  it.each(["codex", "claude"] as const)(
    "configures %s runner without putting keys in commands",
    async (kind) => {
      const f = await fixture();
      const machine = await f.machines.create();
      f.machines.scripts.push(
        { pattern: /git rev-parse/, result: { stdout: "abc123" } },
        { pattern: /git rev-list/, result: { stdout: "def456\n" } },
      );
      const result = await commandRunner(kind, {
        command: "hyperfide",
        args: ["mcp"],
      }).run({ task: "a", prompt: "Do task" }, machine, "key-test-0001");
      expect(f.machines.execLog[1].options.env).toEqual({
        HYPERFIDE_GATEWAY_KEY: "key-test-0001",
      });
      expect(f.machines.execLog[1].command).not.toContain("key-test");
      expect(result.commits).toEqual(["def456"]);
      expect(f.machines.execLog[1].command).toContain(
        kind === "codex" ? "--ask-for-approval never" : "--mcp-config",
      );
      expect(
        Buffer.from(
          await machine.readFile("/tmp/hyperfide-mcp.json"),
        ).toString(),
      ).toContain("codify");
    },
  );
});
