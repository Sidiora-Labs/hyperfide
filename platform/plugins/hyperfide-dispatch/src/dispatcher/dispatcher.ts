import { mkdir } from "node:fs/promises";
import type { PluginStorage } from "@hyperfide/authority";
import { openDispatchStorage, migrateDispatchDirectory } from "../storage";
import { randomUUID } from "node:crypto";
import type { SandboxMachine } from "../machine-ops";
import type { DispatcherOptions } from "./contracts";
export interface JobLedger {
  id: string;
  task: string;
  state: "claimed" | "running" | "succeeded" | "failed";
  attempt: number;
  machine?: string;
  keyId: string;
  commits: string[];
  error?: string;
  cancelled?: boolean;
  started?: string;
  finished?: string;
  worker?: string;
  log?: string;
  source?: string;
  events?: {
    stage: "claimed" | "started" | "finished" | "failed" | "merged";
    at: string;
  }[];
}
export class Dispatcher {
  readonly jobs = new Map<string, JobLedger>();
  private running = new Map<string, Promise<void>>();
  private serial: Promise<unknown> = Promise.resolve();
  private backoffUntil = 0;
  private backoffMs = 0;
  private initialized = false;
  private storage!: PluginStorage;
  close() {
    this.storage?.close();
  }
  constructor(private options: DispatcherOptions) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async atomic(name: string, value: unknown) {
    await this.storage.put(
      name === "budget.json" ? "budget" : "job:" + name.slice(0, -5),
      value,
    );
  }
  private async save(job: JobLedger) {
    await this.atomic(job.id + ".json", job);
  }
  async start() {
    if (this.initialized) throw new Error("Dispatcher already started");
    await mkdir(this.options.directory, { recursive: true });
    this.storage =
      this.options.storage ??
      (await openDispatchStorage(this.options.directory));
    await migrateDispatchDirectory(this.options.directory, this.storage);
    for (const { key, value } of await this.storage.entries()) {
      if (key === "budget") {
        const data = value as { until: number; ms: number };
        this.backoffUntil = data.until;
        this.backoffMs = data.ms;
      } else if (key.startsWith("job:")) {
        const data = value as JobLedger;
        this.jobs.set(data.id, data);
      }
    }
    // This directory is a single dispatcher lease. A restart interrupts its live jobs.
    const ownedJobs = [...this.jobs.values()].filter(
      (job) => !job.source || job.source === "dispatcher",
    );
    const owned = new Set(ownedJobs.map((job) => job.machine));
    for (const machine of await this.options.machines.list()) {
      if (
        owned.has(machine.id) ||
        machine.name?.startsWith("hyperfide-dispatch-")
      )
        await (await this.options.machines.connect(machine.id)).destroy();
    }
    for (const job of ownedJobs) {
      if (job.state === "running" || job.state === "claimed") {
        job.state = "failed";
        job.error = "Dispatcher restarted";
        job.finished = new Date(this.now()).toISOString();
        (job.events ??= []).push({ stage: "failed", at: job.finished });
        await this.save(job);
      }
      // A crash can occur after saving a terminal state but before releasing its claim.
      await this.options.spec.release(job.task, job.id);
    }
    this.initialized = true;
    const control = (await this.storage.get("fleet.control")) as
      | { cap?: number; paused?: boolean }
      | undefined;
    await this.storage.put("fleet.control", {
      cap: control?.cap ?? 0,
      maximum: this.options.cap,
      paused: control?.paused ?? true,
    });
  }
  tick(): Promise<void> {
    const next = this.serial.then(() => this.schedule());
    this.serial = next.catch(() => undefined);
    return next;
  }
  private async schedule() {
    if (!this.initialized) throw new Error("Call start before tick");
    if (this.now() < this.backoffUntil) return;
    const control = (await this.storage.get("fleet.control")) as
      | { cap: number; paused: boolean }
      | undefined;
    if (control?.paused) return;
    const limits = await this.options.limits();
    const cap = Math.max(
      0,
      Math.min(
        this.options.cap,
        control?.cap ?? this.options.cap,
        limits.host,
        limits.global - limits.otherRunning,
      ),
    );
    const integration = await this.options.integration();
    const tasks = (await this.options.spec.tasks()).sort(
      (a, b) => a.wave - b.wave || a.id.localeCompare(b.id),
    );
    for (const task of tasks) {
      if (this.now() < this.backoffUntil || this.running.size >= cap) break;
      if (
        task.status !== "pending" ||
        [...this.jobs.values()].some((j) => j.task === task.id)
      )
        continue;
      if (
        !(
          await Promise.all(
            task.requires.map((id) =>
              this.options.spec.merged(id, integration.tip),
            ),
          )
        ).every(Boolean)
      )
        continue;
      const key = this.options.keys.find(
        (k) =>
          [...this.running.keys()].filter(
            (id) => this.jobs.get(id)?.keyId === k.id,
          ).length < k.concurrency,
      );
      if (!key) break;
      const job: JobLedger = {
        id: randomUUID(),
        task: task.id,
        state: "claimed",
        attempt: 0,
        keyId: key.id,
        commits: [],
        source: "dispatcher",
        events: [{ stage: "claimed", at: new Date(this.now()).toISOString() }],
      };
      if (!(await this.options.spec.claim(task.id, job.id))) continue;
      this.jobs.set(job.id, job);
      try {
        await this.save(job);
      } catch (error) {
        await this.options.spec.release(task.id, job.id);
        this.jobs.delete(job.id);
        throw error;
      }
      const promise = this.execute(job, key.value, integration).finally(() => {
        this.running.delete(job.id);
      });
      this.running.set(job.id, promise);
    }
  }
  async drain() {
    await Promise.all(this.running.values());
  }
  private async execute(
    job: JobLedger,
    key: string,
    integration: { tip: string; bundle: Uint8Array },
  ) {
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        let machine: SandboxMachine | undefined;
        let retry = false;
        try {
          if (
            ((await this.storage.get("job:" + job.id)) as JobLedger | undefined)
              ?.cancelled
          )
            throw new Error("Cancelled by operator");
          job.attempt = attempt;
          machine = await this.options.machines.create({
            fromCheckpoint: await this.options.checkpoint(),
            name: "hyperfide-dispatch-" + job.id,
          });
          job.machine = machine.id;
          job.state = "running";
          job.started ??= new Date(this.now()).toISOString();
          (job.events ??= []).push({
            stage: "started",
            at: new Date(this.now()).toISOString(),
          });
          await this.save(job);
          await machine.writeFile(
            "/tmp/hyperfide-integration.bundle",
            integration.bundle,
          );
          const prep = await machine.exec(
            `git fetch /tmp/hyperfide-integration.bundle && git checkout --detach '${integration.tip.replaceAll("'", "'\\''")}' && ${this.options.prepare}`,
            { cwd: "/workspace" },
          );
          if (prep.exitCode || prep.timedOut)
            throw new Error(prep.stdout + prep.stderr);
          const result = await this.options.runner.run(
            await this.options.packet(job.task),
            machine,
            key,
          );
          job.log = (
            (job.log ?? "") +
            prep.stdout +
            prep.stderr +
            (result.stdout ?? "") +
            (result.stderr ?? "")
          )
            .replaceAll(key, "[redacted]")
            .slice(-16384);
          if (
            ((await this.storage.get("job:" + job.id)) as JobLedger | undefined)
              ?.cancelled
          )
            throw new Error("Cancelled by operator");
          if (
            result.exitCode ||
            /\b429\b/.test((result.stdout ?? "") + (result.stderr ?? ""))
          )
            throw new Error(result.stdout + "\n" + result.stderr);
          job.commits = result.commits;
          job.state = "succeeded";
          delete job.error;
          break;
        } catch (error) {
          job.error = String(error).replaceAll(key, "[redacted]");
          if (/\b429\b/.test(job.error)) {
            this.backoffMs = Math.min(
              600_000,
              this.backoffMs ? this.backoffMs * 2 : 60_000,
            );
            this.backoffUntil = this.now() + this.backoffMs;
            await this.atomic("budget.json", {
              until: this.backoffUntil,
              ms: this.backoffMs,
            });
          }
          job.state = "failed";
          job.cancelled = (
            (await this.storage.get("job:" + job.id)) as JobLedger | undefined
          )?.cancelled;
          retry = attempt < 2 && !job.cancelled;
        } finally {
          if (machine) {
            try {
              await machine.destroy();
            } catch (error) {
              job.state = "failed";
              job.error =
                "Destroy failed: " +
                String(error).replaceAll(key, "[redacted]");
              retry = false;
            }
          }
          await this.save(job);
        }
        if (!retry) break;
        while (this.backoffUntil > this.now()) {
          await (
            this.options.wait ??
            ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
          )(this.backoffUntil - this.now());
        }
      }
    } finally {
      job.finished = new Date(this.now()).toISOString();
      (job.events ??= []).push({
        stage: job.state === "succeeded" ? "finished" : "failed",
        at: job.finished,
      });
      await this.save(job);
      await this.options.spec.release(job.task, job.id);
    }
  }
}
