import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  IntegrationQueue,
  type IntegrationDependencies,
  type FinishedJob,
} from "./queue";
import { FakeMachineProvider } from "../testing/fake-machine";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(
  changes: Record<string, string>,
  integrationChanges: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "hyperfide-bundle-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const put = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  };
  git("init", "-b", "integration");
  git("config", "user.name", "Hyperfide Test");
  git("config", "user.email", "test@hyperfide.invalid");
  put({
    "spec/fixture/spec.kvx": '[task.1]\nstatus = "pending"\n',
    "platform/pnpm-lock.yaml": "base\n",
    "platform/package.json": '{"name":"@hyperfide/fixture"}\n',
  });
  git("add", ".");
  git("commit", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "result");
  put(changes);
  git("add", ".");
  git("commit", "-m", "Worker result");
  const bundle = join(root, "result.bundle");
  git("bundle", "create", bundle, "result");
  git("checkout", "integration");
  if (Object.keys(integrationChanges).length) {
    put(integrationChanges);
    git("add", ".");
    git("commit", "-m", "Integration advances");
  }
  // Keep the integration branch detached so ref updates never invalidate a checkout.
  git("checkout", "--detach");
  const provider = new FakeMachineProvider();
  provider.scripts.push({
    pattern: /pnpm -C platform install/,
    result: {},
    files: { "/workspace/platform/pnpm-lock.yaml": "regenerated\n" },
  });
  const deps: IntegrationDependencies = {
    machines: provider,
    asks: vi.fn(async () => []),
    command: vi.fn(async () => ({ exitCode: 0, stderr: "" })),
    spawnConflictThread: vi.fn(async () => ({ id: "conflict-thread" })),
    publish: vi.fn(),
  };
  const queue = new IntegrationQueue(repo, "integration", deps);
  const job: FinishedJob = {
    backend: "legacy",
    compatibility: "git-tip-bundle-v1",
    id: "job-1",
    feature: "fixture",
    task: "1",
    bundle,
    ref: "refs/heads/result",
  };
  return { queue, job, git, base, deps, provider };
}

test("fetches a real bundle, reconciles, and merges with a plain tagged message", async () => {
  const f = fixture({ "result.txt": "finished\n" });
  const state = await f.queue.enqueue(f.job);
  expect(state.status).toBe("merged");
  expect(f.git("show", "sandbox/job-1:result.txt")).toBe("finished");
  expect(f.git("show", "integration:result.txt")).toBe("finished");
  expect(f.git("log", "-1", "--format=%B", "integration")).toBe(
    "Integrate fixture/1 [spec:fixture/1]",
  );
  expect(
    f.git("rev-list", "--parents", "-1", "integration").split(" "),
  ).toHaveLength(3);
  expect(f.deps.command).toHaveBeenCalledWith(
    "hyperfide",
    ["spec", "reconcile"],
    expect.any(String),
  );
  expect(f.queue.list()[0]).toMatchObject({
    status: "merged",
    commit: state.commit,
  });
});

test("regenerates a conflicting lockfile in a machine with merged manifests", async () => {
  const f = fixture(
    {
      "platform/pnpm-lock.yaml": "worker\n",
      "platform/worker/package.json": '{"name":"@hyperfide/worker"}\n',
    },
    { "platform/pnpm-lock.yaml": "integration\n" },
  );
  expect((await f.queue.enqueue(f.job)).status).toBe("merged");
  expect(f.git("show", "integration:platform/pnpm-lock.yaml")).toBe(
    "regenerated",
  );
  expect(f.provider.execLog).toEqual([
    {
      id: "machine-1",
      command:
        "pnpm -C platform install --lockfile-only --no-frozen-lockfile --ignore-scripts",
      options: { cwd: "/workspace" },
    },
  ]);
  expect(
    f.provider.machines
      .get("machine-1")
      ?.files.has("/workspace/platform/worker/package.json"),
  ).toBe(true);
  expect(f.provider.machines.get("machine-1")?.destroyed).toBe(true);
});

test("refuses a duplicate header in any spec without moving integration", async () => {
  const f = fixture({ "spec/other/spec.kvx": "[task.2]\n[task.2]\n" });
  expect(await f.queue.enqueue(f.job)).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("Duplicate task header"),
  });
  expect(f.git("rev-parse", "integration")).toBe(f.base);
  expect(f.deps.command).not.toHaveBeenCalled();
});

test("also checks spec output after reconciliation", async () => {
  const f = fixture({ "result.txt": "result" });
  f.deps.command = vi.fn(async (_command, _args, cwd) => {
    writeFileSync(join(cwd, "spec/fixture/spec.kvx"), "[task.1]\n[task.1]\n");
    return { exitCode: 0, stderr: "" };
  });
  expect((await f.queue.enqueue(f.job)).status).toBe("failed");
  expect(f.git("rev-parse", "integration")).toBe(f.base);
});

test.each(["ASK.md", "nested/ASK.md"])(
  "holds an ASK result at %s with a visible reason",
  async (path) => {
    const f = fixture({ [path]: "Missing answer" });
    expect(await f.queue.enqueue(f.job)).toMatchObject({
      status: "held",
      reason: expect.stringContaining("ASK.md"),
    });
    expect(f.queue.list()[0].reason).toBeTruthy();
    expect(f.git("rev-parse", "integration")).toBe(f.base);
  },
);

test("holds unanswered blocking Asks and allows answered ones on retry", async () => {
  const f = fixture({ "result.txt": "result" });
  f.deps.asks = vi.fn(async () => [{ blocking: true, answered: false }]);
  expect((await f.queue.enqueue(f.job)).status).toBe("held");
  f.deps.asks = vi.fn(async () => [
    { blocking: true, answered: true },
    { blocking: false, answered: false },
  ]);
  expect((await f.queue.enqueue(f.job)).status).toBe("merged");
});

test("spawns a feature manager conflict thread and exposes the conflict", async () => {
  const f = fixture(
    { "spec/fixture/spec.kvx": '[task.1]\nstatus = "implemented"\n' },
    { "spec/fixture/spec.kvx": '[task.1]\nstatus = "done"\n' },
  );
  const before = f.git("rev-parse", "integration");
  expect(await f.queue.enqueue(f.job)).toMatchObject({
    status: "held",
    reason: expect.stringContaining("spec/fixture/spec.kvx"),
    threadId: "conflict-thread",
  });
  expect(f.deps.spawnConflictThread).toHaveBeenCalledWith(
    expect.objectContaining({
      role: "feature-manager",
      branch: "sandbox/job-1",
      integrationBranch: "integration",
    }),
  );
  expect(f.git("rev-parse", "integration")).toBe(before);
});

test("failed reconciliation is visible and leaves integration unchanged", async () => {
  const f = fixture({ "result.txt": "result" });
  f.deps.command = vi.fn(async () => ({
    exitCode: 1,
    stderr: "reconcile rejected",
  }));
  expect(await f.queue.enqueue(f.job)).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("reconcile rejected"),
  });
  expect(f.git("rev-parse", "integration")).toBe(f.base);
  expect(f.git("worktree", "list")).not.toContain("hyperfide-integrate-");
});

test("machine failure leaves the integration branch intact and destroys the machine", async () => {
  const f = fixture(
    { "platform/pnpm-lock.yaml": "worker\n" },
    { "platform/pnpm-lock.yaml": "integration\n" },
  );
  const before = f.git("rev-parse", "integration");
  f.provider.failOnExec = 1;
  expect(await f.queue.enqueue(f.job)).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("Injected machine exec failure"),
  });
  expect(f.provider.machines.get("machine-1")?.destroyed).toBe(true);
  expect(f.git("rev-parse", "integration")).toBe(before);
});

test("an Ask raised during reconciliation holds the merge", async () => {
  const f = fixture({ "result.txt": "result" });
  f.deps.command = vi.fn(async (_command, _args, cwd) => {
    writeFileSync(join(cwd, "ASK.md"), "Need an answer");
    return { exitCode: 0, stderr: "" };
  });
  expect((await f.queue.enqueue(f.job)).status).toBe("held");
  expect(f.git("rev-parse", "integration")).toBe(f.base);
});

async function native_queue_outage_never_executes_git() {
  const { SourceControlClient } = await import("@hyperfide/source-control");
  const { randomUUID } = await import("node:crypto");
  const { createServer } = await import("node:net");
  const { chmodSync, readFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "hyperfide-native-queue-"));
  roots.push(root);
  const log = join(root, "git-calls");
  writeFileSync(log, "");
  writeFileSync(
    join(root, "git"),
    "#!/bin/sh\nprintf '%s\\n' invoked >> '" + log + "'\nexit 97\n",
  );
  chmodSync(join(root, "git"), 0o700);
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("TCP fixture address missing");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const scope = {
    organisation_id: randomUUID(),
    repository_id: randomUUID(),
    security_domain_id: randomUUID(),
  };
  const digest = "sha256:" + "a".repeat(64);
  const assignment: import("../dispatcher/contracts").NativeAssignmentDescriptor =
    {
      schema_version: 1,
      backend: "native",
      scope,
      revision_id: digest,
      root_tree_id: digest,
      closure_id: digest,
      environment_id: digest,
      task_id: "native-task",
      task_generation: "1",
      attempt_id: randomUUID(),
      attempt_generation: "1",
      workspace_id: randomUUID(),
      workspace_generation: "2",
      assignment_id: randomUUID(),
      assignment_generation: "1",
      authority: {
        authority_epoch: "1",
        generation: "1",
        policy_version: "native-v1",
      },
    };
  const job: import("./queue").NativeFinishedJob = {
    id: randomUUID(),
    task: assignment.task_id,
    feature: "native",
    backend: "native",
    assignment,
    candidate: {
      candidate_id: randomUUID(),
      domain_id: randomUUID(),
      expected_generation: "1",
      expected_revision_id: digest,
      revision_id: digest,
      contributors: [],
      dependencies: [],
      transformation_version: "native-v1",
      inputs: {
        source: digest,
        dependency: digest,
        toolchain: digest,
        configuration: digest,
        graph: digest,
        contract: digest,
      },
    },
    operations: {
      create: randomUUID(),
      qualify: randomUUID(),
      accept: randomUUID(),
    },
  };
  const previousPath = process.env.PATH;
  process.env.PATH = root + ":" + previousPath;
  try {
    const queue = new IntegrationQueue(join(root, "no-checkout"), "unused", {
      source: new SourceControlClient({
        endpoint: `http://127.0.0.1:${address.port}/api/v1/source-control`,
        scope,
        token: "unreachable-source",
        timeout_ms: 1000,
      }),
      asks: async () => [],
      evidence: async () => {
        throw new Error("Evidence cannot precede candidate creation");
      },
    });
    const result = await queue.enqueue(job);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Source request lost its response");
    expect(result.acceptance).toBeUndefined();
    expect(readFileSync(log, "utf8")).toBe("");
    expect(queue.list()).toEqual([result]);
  } finally {
    process.env.PATH = previousPath;
  }
}
test(
  native_queue_outage_never_executes_git.name,
  native_queue_outage_never_executes_git,
);
