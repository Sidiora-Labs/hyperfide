import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SandboxMachine, SandboxMachineOps } from "../machine-ops.js";

export interface BuildRecord {
  id: string;
  commit: string;
  checkpoint: string | null;
  status: "running" | "succeeded" | "failed" | "cancelled";
  steps: {
    name: string;
    status: "running" | "succeeded" | "failed";
    log: string;
    ms: number;
  }[];
  timings: { started: number; finished: number | null };
  error?: string;
}
export interface FleetConfig {
  checkpoint: string | null;
  checkpointCommit: string | null;
  workspace: string;
  shellPrefix: string;
  base: { steps: [string, string, number][] };
  [key: string]: unknown;
}
export interface BuildStorage {
  set(key: string, record: BuildRecord): Promise<unknown>;
}
export type GitRunner = (args: string[], cwd: string) => Promise<void>;
export const gitRunner: GitRunner = async (args, cwd) => {
  await promisify(execFile)("git", args, { cwd });
};
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export class ImageBuilder {
  private jobs = new Map<
    string,
    {
      record: BuildRecord;
      cancelled: boolean;
      machine?: SandboxMachine;
      cleanup?: Promise<void>;
      done: Promise<void>;
    }
  >();
  constructor(
    private options: {
      machines: Pick<SandboxMachineOps, "capabilities" | "create">;
      storage: BuildStorage;
      fleetPath: string;
      repository: string;
      git?: GitRunner;
    },
  ) {}
  list(): BuildRecord[] {
    return structuredClone([...this.jobs.values()].map((j) => j.record));
  }
  async wait(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown build");
    await job.done;
    return structuredClone(job.record);
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown build");
    if (job.record.status !== "running") return;
    job.cancelled = true;
    if (job.machine) await (job.cleanup ??= job.machine.destroy());
  }
  async start(commit: string): Promise<BuildRecord> {
    if (!/^[a-f0-9]{40}$/.test(commit)) {
      try {
        const result = await promisify(execFile)(
          "git",
          ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`],
          { cwd: this.options.repository },
        );
        commit = result.stdout.trim();
      } catch {
        throw new Error("Cannot resolve repository commit");
      }
      if (!/^[a-f0-9]{40}$/.test(commit))
        throw new Error("Cannot resolve repository commit");
    }
    if ([...this.jobs.values()].some((j) => j.record.status === "running"))
      throw new Error("An image build is already running");
    const record: BuildRecord = {
      id: randomUUID(),
      commit,
      checkpoint: null,
      status: "running",
      steps: [],
      timings: { started: Date.now(), finished: null },
    };
    const job = {
      record,
      cancelled: false,
      machine: undefined as SandboxMachine | undefined,
      done: Promise.resolve(),
    };
    this.jobs.set(record.id, job);
    try {
      await this.save(record);
    } catch (error) {
      this.jobs.delete(record.id);
      throw error;
    }
    job.done = this.run(job);
    return structuredClone(record);
  }
  private save(record: BuildRecord) {
    return this.options.storage.set(
      `image-build/${record.id}`,
      structuredClone(record),
    );
  }
  private async run(job: {
    record: BuildRecord;
    cancelled: boolean;
    machine?: SandboxMachine;
    cleanup?: Promise<void>;
  }) {
    const r = job.record;
    let temporary: string | undefined;
    const check = () => {
      if (job.cancelled) throw new Error("Build cancelled");
    };
    try {
      const fleet: FleetConfig = JSON.parse(
        await readFile(this.options.fleetPath, "utf8"),
      );
      if (!fleet.checkpoint)
        throw new Error("A recorded parent checkpoint is required");
      if (!this.options.machines.capabilities.checkpoint)
        throw new Error("Provider does not support checkpoints");
      temporary = await mkdtemp(join(tmpdir(), "hyperfide-image-"));
      const bundle = join(temporary, "main.bundle");
      const git = this.options.git ?? gitRunner;
      await git(
        ["cat-file", "-e", `${r.commit}^{commit}`],
        this.options.repository,
      );
      // A temporary ref gives the bundle a cloneable head without moving existing repository branches.
      const ref = `refs/heads/hyperfide-image-build-${r.id}`;
      await git(["update-ref", ref, r.commit], this.options.repository);
      try {
        await git(["bundle", "create", bundle, ref], this.options.repository);
      } finally {
        await git(["update-ref", "-d", ref], this.options.repository);
      }
      check();
      job.machine = await this.options.machines.create({
        fromCheckpoint: fleet.checkpoint,
        name: `hf-builder-${r.commit.slice(0, 10)}`,
      });
      check();
      await job.machine.writeFile(
        "/work/in/main.bundle",
        await readFile(bundle),
      );
      for (const [name, template, timeoutSec] of fleet.base.steps) {
        check();
        const step: BuildRecord["steps"][number] = {
          name,
          status: "running",
          log: "",
          ms: 0,
        };
        r.steps.push(step);
        await this.save(r);
        const started = Date.now();
        try {
          const command =
            fleet.shellPrefix +
            template
              .replaceAll("{W}", quote(fleet.workspace))
              .replaceAll("{commit}", quote(r.commit));
          const result = await job.machine.exec(command, {
            cwd: "/work",
            timeoutSec,
          });
          step.log = result.stdout + result.stderr;
          if (
            result.exitCode !== 0 ||
            result.timedOut ||
            (name === "platform-build" &&
              result.stdout.includes("build_failed"))
          )
            throw new Error(`Step ${name} failed (exit ${result.exitCode})`);
          check();
          step.status = "succeeded";
        } catch (error) {
          step.status = "failed";
          step.log += `\n${String(error)}`;
          throw error;
        } finally {
          step.ms = Date.now() - started;
          await this.save(r);
        }
      }
      check();
      r.checkpoint = (
        await job.machine.checkpoint(`hf-base-${r.commit.slice(0, 10)}`)
      ).name;
      check();
      r.status = "succeeded";
    } catch (error) {
      r.status = job.cancelled ? "cancelled" : "failed";
      r.error = String(error);
    } finally {
      try {
        if (job.machine) await (job.cleanup ??= job.machine.destroy());
      } catch (error) {
        r.status = "failed";
        r.error = `Cleanup failed: ${String(error)}`;
      }
      if (temporary) await rm(temporary, { recursive: true, force: true });
      r.timings.finished = Date.now();
      try {
        await this.save(r);
        // Merge into the latest document; failures never replace the usable parent checkpoint.
        const fleet = JSON.parse(
          await readFile(this.options.fleetPath, "utf8"),
        );
        fleet.imageBuilds = { ...fleet.imageBuilds, [r.id]: r };
        if (r.status === "succeeded") {
          fleet.checkpoint = r.checkpoint;
          fleet.checkpointCommit = r.commit;
        }
        const path = `${this.options.fleetPath}.${r.id}.tmp`;
        await writeFile(path, JSON.stringify(fleet, null, 2) + "\n");
        await rename(path, this.options.fleetPath);
      } catch (error) {
        r.status = "failed";
        r.error = `Record persistence failed: ${String(error)}`;
        await this.save(r);
      }
    }
  }
}
