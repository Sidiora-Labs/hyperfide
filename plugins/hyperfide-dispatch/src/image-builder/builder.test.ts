import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeMachineProvider } from "../testing/fake-machine.js";
import {
  ImageBuilder,
  gitRunner,
  type BuildRecord,
  type FleetConfig,
} from "./builder.js";
const commit = "a".repeat(40);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "hyperfide-builder-test-"));
  dirs.push(dir);
  const fleet: FleetConfig = JSON.parse(
    await readFile(
      new URL(
        "../../../../deploy/hyperfide/sandbox/fleet.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  fleet.checkpoint = "parent";
  const path = join(dir, "fleet.json");
  await writeFile(path, JSON.stringify(fleet));
  const machines = new FakeMachineProvider();
  machines.checkpoints.set("parent", new Map());
  const records = new Map<string, BuildRecord>();
  const gitCalls: string[][] = [];
  const builder = new ImageBuilder({
    machines,
    repository: dir,
    fleetPath: path,
    storage: {
      set: async (key, record) => {
        records.set(key, structuredClone(record));
      },
    },
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "bundle") await writeFile(args[2], "bundle bytes");
    },
  });
  return { builder, machines, records, gitCalls, path, fleet, dir };
}
describe("image builder", () => {
  it("bundles, uploads, runs every configured step, checkpoints and persists both records", async () => {
    const s = await setup();
    const initial = await s.builder.start(commit);
    const record = await s.builder.wait(initial.id);
    expect(record.status).toBe("succeeded");
    expect(record.checkpoint).toBe(`hf-base-${commit.slice(0, 10)}`);
    expect(record.steps.map((s) => s.name)).toEqual([
      "clone",
      "cg",
      "service",
      "platform",
      "platform-build",
      "index",
      "tools",
    ]);
    expect(
      record.steps.every((s) => s.status === "succeeded" && s.ms >= 0),
    ).toBe(true);
    expect(s.gitCalls.map((c) => c[0])).toEqual([
      "cat-file",
      "update-ref",
      "bundle",
      "update-ref",
    ]);
    expect(s.machines.execLog.map((e) => e.options.timeoutSec)).toEqual(
      s.fleet.base.steps.map((s) => s[2]),
    );
    expect(
      s.machines.execLog.every(
        (e) => e.options.cwd === "/work" && !e.command.includes("{W}"),
      ),
    ).toBe(true);
    const machine = [...s.machines.machines.values()][0];
    expect(
      Buffer.from(machine.files.get("/work/in/main.bundle")!).toString(),
    ).toBe("bundle bytes");
    expect(machine.destroyed).toBe(true);
    expect(s.records.get(`image-build/${record.id}`)).toEqual(record);
    const fleet = JSON.parse(await readFile(s.path, "utf8"));
    expect(fleet.imageBuilds[record.id]).toEqual(record);
    expect(fleet.checkpointCommit).toBe(commit);
    expect(record.timings.finished).toBeGreaterThanOrEqual(
      record.timings.started,
    );
  });
  it("keeps failed step output and the partial record without changing the parent", async () => {
    const s = await setup();
    s.machines.scripts.push({
      pattern: /npm ci/,
      result: { exitCode: 9, stderr: "build diagnostic" },
    });
    const record = await s.builder.wait((await s.builder.start(commit)).id);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(3);
    expect(record.steps[2].log).toContain("build diagnostic");
    expect(record.steps[2].status).toBe("failed");
    expect([...s.machines.machines.values()][0].destroyed).toBe(true);
    expect(JSON.parse(await readFile(s.path, "utf8")).checkpoint).toBe(
      "parent",
    );
    expect(s.records.get(`image-build/${record.id}`)).toEqual(record);
  });
  it("handles injected exec exceptions and masked platform build failures", async () => {
    const s = await setup();
    s.machines.failOnExec = 2;
    expect(
      (await s.builder.wait((await s.builder.start(commit)).id)).steps[1].log,
    ).toContain("Injected");
    s.machines.failOnExec = undefined;
    s.machines.scripts.push({
      pattern: /pnpm build/,
      result: { stdout: "build_failed\ncompiler diagnostic" },
    });
    expect(
      (await s.builder.wait((await s.builder.start(commit)).id)).status,
    ).toBe("failed");
  });
  it("cancels an active exec, destroys its machine and never checkpoints", async () => {
    const s = await setup();
    let release!: () => void;
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = s.machines.create.bind(s.machines);
    s.machines.create = async (options) => {
      const m = await original(options);
      const exec = m.exec.bind(m);
      m.exec = async (cmd, options) => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return exec(cmd, options);
      };
      return m;
    };
    const start = await s.builder.start(commit);
    await running;
    expect(s.builder.list()[0].steps[0].status).toBe("running");
    await expect(s.builder.start(commit)).rejects.toThrow("already running");
    await s.builder.cancel(start.id);
    release();
    const record = await s.builder.wait(start.id);
    expect(record.status).toBe("cancelled");
    expect(record.checkpoint).toBeNull();
    expect([...s.machines.machines.values()][0].destroyed).toBe(true);
  });
  it("rejects unknown parents and invalid commit input", async () => {
    const s = await setup();
    s.machines.checkpoints.clear();
    expect(
      (await s.builder.wait((await s.builder.start(commit)).id)).error,
    ).toContain("Unknown checkpoint");
    await expect(s.builder.start("HEAD; echo unsafe")).rejects.toThrow(
      "Cannot resolve repository commit",
    );
    await expect(s.builder.cancel("missing")).rejects.toThrow("Unknown build");
  });
  it("creates a real cloneable git bundle for a commit", async () => {
    const s = await setup();
    await gitRunner(["init", "--initial-branch=main"], s.dir);
    await gitRunner(
      [
        "-c",
        "user.name=Hyperfide",
        "-c",
        "user.email=test@hyperfide.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "base",
      ],
      s.dir,
    );
    await gitRunner(
      ["update-ref", "refs/heads/hyperfide-image-build-test", "HEAD"],
      s.dir,
    );
    const bundle = join(s.dir, "real.bundle");
    await gitRunner(
      ["bundle", "create", bundle, "refs/heads/hyperfide-image-build-test"],
      s.dir,
    );
    await gitRunner(["bundle", "verify", bundle], s.dir);
    for (const revision of ["main", "HEAD"]) {
      const build = await s.builder.start(revision);
      expect(build.commit).toMatch(/^[a-f0-9]{40}$/);
      expect((await s.builder.wait(build.id)).status).toBe("succeeded");
    }
    await gitRunner(["clone", bundle, join(s.dir, "clone")], s.dir);
    await gitRunner(
      [
        "-C",
        join(s.dir, "clone"),
        "checkout",
        "origin/hyperfide-image-build-test",
      ],
      s.dir,
    );
  });
});
