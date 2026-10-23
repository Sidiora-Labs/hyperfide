import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUniqueTaskHeaders } from "../../../hyperfide-spec/src/duplicate-headers";

const exec = promisify(execFile);
export interface FinishedJob {
  id: string;
  feature: string;
  task: string;
  bundle: string;
  ref: string;
}
export interface MergeState {
  id: string;
  status: "queued" | "merging" | "held" | "failed" | "merged";
  reason?: string;
  branch?: string;
  commit?: string;
  threadId?: string;
}
export interface IntegrationMachine {
  exec(
    command: string,
    options: { cwd: string },
  ): Promise<{ exitCode: number; stderr: string; timedOut?: boolean }>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  destroy(): Promise<void>;
}
export interface IntegrationDependencies {
  machines: { create(): Promise<IntegrationMachine> };
  asks(job: FinishedJob): Promise<{ blocking: boolean; answered: boolean }[]>;
  command(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<{ exitCode: number; stderr: string }>;
  spawnConflictThread(input: {
    role: "feature-manager";
    job: FinishedJob;
    branch: string;
    integrationBranch: string;
    reason: string;
  }): Promise<{ id: string }>;
  publish?(state: MergeState): void;
}

export class IntegrationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private states = new Map<string, MergeState>();
  constructor(
    private repository: string,
    private integrationBranch: string,
    private deps: IntegrationDependencies,
  ) {}
  list(): MergeState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }
  enqueue(job: FinishedJob): Promise<MergeState> {
    const state: MergeState = { id: job.id, status: "queued" };
    this.set(state);
    const result = this.tail.then(() => this.integrate(job, state));
    this.tail = result.catch(() => undefined);
    return result;
  }
  private set(state: MergeState) {
    this.states.set(state.id, { ...state });
    this.deps.publish?.({ ...state });
  }
  private async git(cwd: string, ...args: string[]): Promise<string> {
    return (
      await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })
    ).stdout.trimEnd();
  }
  private async integrate(
    job: FinishedJob,
    state: MergeState,
  ): Promise<MergeState> {
    let temporary: string | undefined;
    let worktree: string | undefined;
    try {
      for (const value of [job.id, job.feature, job.task]) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value))
          throw new Error("Invalid job identity");
      }
      state.status = "merging";
      this.set(state);
      const branch = `sandbox/${job.id}`;
      state.branch = branch;
      await this.git(
        this.repository,
        "check-ref-format",
        `refs/heads/${this.integrationBranch}`,
      );
      await this.git(
        this.repository,
        "fetch",
        "--no-tags",
        "--",
        job.bundle,
        `${job.ref}:refs/heads/${branch}`,
      );
      const files = (
        await this.git(
          this.repository,
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          branch,
        )
      )
        .split("\0")
        .filter(Boolean);
      if (
        files.some((f) => /(^|\/)ASK\.md$/.test(f)) ||
        (await this.deps.asks(job)).some((a) => a.blocking && !a.answered)
      ) {
        state.status = "held";
        state.reason = "ASK.md or unanswered blocking Ask holds integration";
        return state;
      }
      const base = await this.git(
        this.repository,
        "rev-parse",
        `refs/heads/${this.integrationBranch}`,
      );
      let conflicts: string[] = [];
      try {
        await this.git(
          this.repository,
          "merge-tree",
          "--write-tree",
          "--name-only",
          base,
          branch,
        );
      } catch (error) {
        const result = error as { code?: number; stdout?: string };
        if (result.code !== 1 || !result.stdout) throw error;
        conflicts = result.stdout
          .split("\n\n")[0]
          .split("\n")
          .slice(1)
          .filter(Boolean);
        if (!conflicts.length) throw error;
      }
      if (conflicts.some((f) => f !== "platform/pnpm-lock.yaml")) {
        state.reason = `Merge conflict: ${conflicts.join(", ")}`;
        state.threadId = (
          await this.deps.spawnConflictThread({
            role: "feature-manager",
            job,
            branch,
            integrationBranch: this.integrationBranch,
            reason: state.reason,
          })
        ).id;
        state.status = "held";
        return state;
      }
      temporary = await mkdtemp(join(tmpdir(), "hyperfide-integrate-"));
      worktree = join(temporary, "tree");
      await this.git(
        this.repository,
        "worktree",
        "add",
        "--detach",
        worktree,
        base,
      );
      try {
        await this.git(worktree, "merge", "--no-commit", "--no-ff", branch);
      } catch (error) {
        if (!conflicts.length) throw error;
      }
      if (conflicts.length) {
        await this.git(
          worktree,
          "checkout",
          "--ours",
          "--",
          "platform/pnpm-lock.yaml",
        );
        const machine = await this.deps.machines.create();
        try {
          const inputs = (
            await this.git(worktree, "ls-files", "-z", "platform")
          )
            .split("\0")
            .filter((f) =>
              /(^|\/)(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|\.npmrc)$/.test(
                f,
              ),
            );
          for (const file of inputs)
            await machine.writeFile(
              `/workspace/${file}`,
              await readFile(join(worktree, file)),
            );
          const result = await machine.exec(
            "pnpm -C platform install --lockfile-only --no-frozen-lockfile --ignore-scripts",
            { cwd: "/workspace" },
          );
          if (result.exitCode !== 0 || result.timedOut)
            throw new Error(`Lockfile regeneration failed: ${result.stderr}`);
          await writeFile(
            join(worktree, "platform/pnpm-lock.yaml"),
            await machine.readFile("/workspace/platform/pnpm-lock.yaml"),
          );
          await this.git(worktree, "add", "--", "platform/pnpm-lock.yaml");
        } finally {
          await machine.destroy();
        }
      }
      const validate = async () => {
        const paths = (
          await this.git(
            worktree!,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "spec",
          )
        )
          .split("\0")
          .filter((f) => f.endsWith(".kvx"));
        assertUniqueTaskHeaders(
          await Promise.all(
            paths.map(async (path) => ({
              path,
              text: await readFile(join(worktree!, path), "utf8"),
            })),
          ),
        );
      };
      await validate();
      const reconciled = await this.deps.command(
        "hyperfide",
        ["spec", "reconcile"],
        worktree,
      );
      if (reconciled.exitCode !== 0)
        throw new Error(`Spec reconciliation failed: ${reconciled.stderr}`);
      await validate();
      const resultFiles = (
        await this.git(
          worktree,
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        )
      ).split("\0");
      if (
        resultFiles.some((f) => /(^|\/)ASK\.md$/.test(f)) ||
        (await this.deps.asks(job)).some((a) => a.blocking && !a.answered)
      ) {
        state.status = "held";
        state.reason = "ASK.md or unanswered blocking Ask holds integration";
        return state;
      }
      await this.git(worktree, "add", "--all");
      await this.git(
        worktree,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        `Integrate ${job.feature}/${job.task} [spec:${job.feature}/${job.task}]`,
      );
      const commit = await this.git(worktree, "rev-parse", "HEAD");
      await this.git(
        this.repository,
        "update-ref",
        `refs/heads/${this.integrationBranch}`,
        commit,
        base,
      );
      state.status = "merged";
      state.commit = commit;
    } catch (error) {
      state.status = "failed";
      state.reason = error instanceof Error ? error.message : String(error);
    } finally {
      if (worktree)
        await this.git(
          this.repository,
          "worktree",
          "remove",
          "--force",
          worktree,
        ).catch(() => undefined);
      if (temporary) await rm(temporary, { recursive: true, force: true });
      this.set(state);
    }
    return { ...state };
  }
}
