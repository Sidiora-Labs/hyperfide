import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { SourceControlClient } from "../../sdk/source-control/src/client.js";
import type { SourceScope } from "../../sdk/source-control/src/contracts.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WavePublication,
  createNativeExportAdapter,
  type Publication,
  type PublicationHost,
} from "./publication";
import {
  makeHumanTasks,
  type PermissionAsk,
  type WaveSnapshot,
} from "../hyperfide-spec/wave-authority";
import { wavePullRequests } from "../github/wave-publication";
import register from "./server";
import { waveClosureView } from "./app";

let root: string,
  repo: string,
  remote: string,
  base: string,
  wave: WaveSnapshot;
let host: PublicationHost, service: WavePublication;
let ask: PermissionAsk;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const prepare = () =>
  service.prepare({
    feature: "fixture",
    wave: 4,
    base,
    baseBranch: "main",
    remote,
  });
const grant = () => {
  ask.status = "answered";
  ask.answer = "grant";
  ask.operator = "owner";
};
const remoteHeads = () => git(remote, "for-each-ref", "--format=%(refname)");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hyperfide-wave-test-"));
  repo = join(root, "repo");
  remote = join(root, "remote.git");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  git(repo, "config", "user.name", "Fixture Operator");
  git(repo, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "base"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  base = git(repo, "rev-parse", "HEAD");
  const commits: string[] = [];
  for (const id of ["4.1", "4.2"]) {
    git(repo, "checkout", "-b", `task-${id}`, base);
    for (let i = 1; i <= 2; i++) {
      await writeFile(join(repo, id), `task ${id} revision ${i}\n`);
      git(repo, "add", ".");
      git(repo, "commit", "-m", `work ${i}`);
    }
    commits.push(git(repo, "rev-parse", "HEAD"));
  }
  git(repo, "checkout", "main");
  wave = {
    feature: "fixture",
    wave: 4,
    tasks: commits.map((commit, i) => ({
      id: `4.${i + 1}`,
      title: `Task ${i + 1}`,
      status: "done",
      commit,
      checker: { verdict: "pass", commit },
      lanes: [{ status: "passed", commit, closureCheck: "pass" }],
    })),
    humans: makeHumanTasks().map((task) => ({
      ...task,
      mark: { operator: "owner", at: "2026-10-23" },
    })),
    asks: [],
  };
  const records = new Map<string, Publication>();
  host = {
    repository: repo,
    authority: {
      read: async () => structuredClone(wave),
      mark: async (_f, _w, job, operator) => {
        wave.humans.find((t) => t.id === job)!.mark = {
          operator: operator.id,
          at: "2026-10-23",
        };
      },
    },
    asks: {
      policy: async () => ({ blocks: true }),
      raise: vi.fn(async (input) => {
        ask = {
          id: "permission-1",
          kind: "permission",
          status: "open",
          binding: input.binding,
        };
        wave.asks.push({ id: ask.id, status: "open" });
        return structuredClone(ask);
      }),
      get: async () => structuredClone(ask),
    },
    store: {
      get: async (key) => records.get(key),
      put: async (key, value) => {
        records.set(key, structuredClone(value));
      },
    },
  };
  service = new WavePublication(host);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local wave publication", () => {
  it("squashes each task, waits for permission, pushes once, and opens the configured PR", async () => {
    const createPullRequest = vi.fn(async () => ({ url: "fixture:pr/1" }));
    host.pullRequest = wavePullRequests({ createPullRequest }, "fixture/repo");
    const publication = await prepare();
    expect(
      git(repo, "log", "--format=%s%n%b", `${base}..${publication.head}`),
    ).toContain("[spec:fixture/4.1]");
    expect(
      git(repo, "log", "--format=%s%n%b", `${base}..${publication.head}`),
    ).toContain("4.2: Task 2");
    expect(
      git(repo, "rev-list", "--count", `${base}..${publication.head}`),
    ).toBe("2");
    expect(git(repo, "show", `${publication.head}:4.1`)).toBe(
      "task 4.1 revision 2",
    );
    expect(git(repo, "show", `${publication.head}:4.2`)).toBe(
      "task 4.2 revision 2",
    );
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
    expect(remoteHeads()).toBe("");
    await expect(service.publish("fixture", 4)).rejects.toThrow("permission");
    expect(createPullRequest).not.toHaveBeenCalled();
    grant();
    const result = await service.publish("fixture", 4);
    expect(result.pushed).toBe(true);
    expect(git(remote, "rev-parse", `refs/heads/${publication.branch}`)).toBe(
      publication.head,
    );
    expect(createPullRequest).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        body: expect.stringContaining("4.1: Task 1"),
        base: "main",
        head: publication.branch,
      }),
    );
    await rm(remote, { recursive: true });
    expect(await service.publish("fixture", 4)).toEqual(result);
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(await prepare()).toEqual(result);
  });
  it("refusal leaves the publication branch local", async () => {
    const p = await prepare();
    ask.status = "answered";
    ask.answer = "refuse";
    ask.operator = "owner";
    await expect(service.publish("fixture", 4)).rejects.toThrow("permission");
    expect(remoteHeads()).toBe("");
    expect(git(repo, "rev-parse", p.branch)).toBe(p.head);
  });
  it.each(["implemented", "findings", "failed", "ask", "human"])(
    "blocks preparation for %s",
    async (gate) => {
      if (gate === "implemented") wave.tasks[0].status = gate;
      if (gate === "findings") wave.tasks[0].checker.verdict = gate;
      if (gate === "failed") wave.tasks[0].lanes[0].status = gate;
      if (gate === "ask") wave.asks.push({ id: "unresolved", status: "open" });
      if (gate === "human") delete wave.humans[0].mark;
      await expect(prepare()).rejects.toThrow();
      expect(host.asks.raise).not.toHaveBeenCalled();
      expect(remoteHeads()).toBe("");
    },
  );
  it("rejects a network remote without calling it", async () => {
    await expect(
      service.prepare({
        feature: "fixture",
        wave: 4,
        base,
        baseBranch: "main",
        remote: "https://example.invalid/repo.git",
      }),
    ).rejects.toThrow("local bare");
  });
  it("blocks Git URL rewrites from turning a local push into a network push", async () => {
    await prepare();
    git(repo, "config", "url.https://example.invalid/.insteadOf", remote);
    grant();
    await expect(service.publish("fixture", 4)).rejects.toThrow(
      "transport 'https' not allowed",
    );
    expect(remoteHeads()).toBe("");
  });
  it.each([
    "no operator",
    "wrong binding",
    "branch drift",
    "new ask",
    "lane drift",
  ])("rechecks %s after permission", async (change) => {
    const p = await prepare();
    grant();
    if (change === "no operator") delete ask.operator;
    if (change === "wrong binding") ask.binding = "other";
    if (change === "branch drift")
      git(repo, "update-ref", `refs/heads/${p.branch}`, base);
    if (change === "new ask") wave.asks.push({ id: "new", status: "open" });
    if (change === "lane drift") wave.tasks[0].lanes[0].status = "failed";
    await expect(service.publish("fixture", 4)).rejects.toThrow();
    expect(remoteHeads()).toBe("");
  });
  it("retries a failed PR without pushing the branch again", async () => {
    host.pullRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("client unavailable"))
      .mockResolvedValue({ url: "fixture:pr/2" });
    const p = await prepare();
    grant();
    await expect(service.publish("fixture", 4)).rejects.toThrow(
      "client unavailable",
    );
    // A PR retry succeeds even when neither the local branch nor remote is available.
    git(repo, "branch", "-D", p.branch);
    await rm(remote, { recursive: true });
    expect((await service.publish("fixture", 4)).pr).toBe("fixture:pr/2");
  });
  it("exposes closure and operator human actions through a fake plugin host", async () => {
    wave.humans = makeHumanTasks();
    const handlers = new Map<string, (input: any) => Promise<any>>();
    register({
      ...host,
      operator: async () => ({ role: "operator", id: "owner" }),
      rpc: {
        register: (name, handler) => {
          handlers.set(name, handler);
        },
      },
    });
    const input = { feature: "fixture", wave: 4 };
    const client = {
      read: () => handlers.get("hyperfide-qualify.wave")!(input),
      mark: (job: string) =>
        handlers.get("hyperfide-qualify.mark")!({ ...input, job }),
    };
    const view = await waveClosureView(client);
    expect(view.ready).toBe(false);
    expect(view.humanTasks).toHaveLength(3);
    for (const task of view.humanTasks) {
      expect(task.needsOperatorMark).toBe(true);
      await task.mark();
    }
    expect((await waveClosureView(client)).ready).toBe(true);
    expect(
      (
        await handlers.get("hyperfide-qualify.prepare")!({
          ...input,
          base,
          baseBranch: "main",
          remote,
        })
      ).ask,
    ).toBe("permission-1");
    await expect(
      handlers.get("hyperfide-qualify.publish")!(input),
    ).rejects.toThrow("permission");
    grant();
    expect(
      (await handlers.get("hyperfide-qualify.publish")!(input)).pushed,
    ).toBe(true);
  });
});

async function native_publication_uses_the_real_source_client_without_git_worktrees() {
  const historical = await prepare();
  const script = fileURLToPath(
    new URL(
      "../../tests/hyperfide/cases/source_control/5_1.py",
      import.meta.url,
    ),
  );
  const child = spawn("python3", [script, "--publication-host"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  const originalPath = process.env.PATH;
  let movedGit = false;
  try {
    const ready = await new Promise<{
      endpoint: string;
      scope: SourceScope;
      token: string;
      acceptance_id: string;
      revision_id: string;
      remote: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new Error("Native source host startup timed out: " + stderr)),
        90000,
      );
      const lines = createInterface({ input: child.stdout });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        reject(new Error("Native source host exited " + code + ": " + stderr));
      });
      lines.on("line", (line) => {
        if (line.startsWith("NATIVE_PUBLICATION_HOST ")) {
          clearTimeout(timeout);
          resolve(JSON.parse(line.slice("NATIVE_PUBLICATION_HOST ".length)));
        }
      });
    });
    const client = new SourceControlClient({
      endpoint: ready.endpoint,
      scope: ready.scope,
      token: ready.token,
      timeout_ms: 30000,
    });
    host.native = createNativeExportAdapter({
      schema_version: 1,
      client,
      request: {
        acceptance_id: ready.acceptance_id,
        destination_id: "primary",
        target_ref: "refs/heads/main",
        expected_old_oid: null,
      },
    });
    const gitExecutable = execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    const commands = join(root, "native-git-commands");
    const executables = join(root, "executables");
    await mkdir(executables);
    await writeFile(commands, "");
    await writeFile(
      join(executables, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${commands}'\nexec '${gitExecutable}' "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = executables + ":" + originalPath;
    await rename(join(repo, ".git"), join(root, "historical-git"));
    movedGit = true;
    service = new WavePublication(host);
    expect(await prepare()).toEqual(historical);
    wave.asks = [];
    wave.wave = 5;
    const input = {
      feature: "fixture",
      wave: 5,
      base: ready.revision_id,
      baseBranch: "main",
      remote: "primary",
    };
    const publication = await service.prepare(input);
    expect(publication.native?.schema_version).toBe(1);
    expect(publication.native?.result.status).toBe("QUEUED");
    expect(publication.native?.result.revision_id).toBe(ready.revision_id);
    expect(
      (await client.publication(publication.native!.operation_id)).status,
    ).toBe("QUEUED");
    expect(await readFile(commands, "utf8")).toBe("");
    expect(git(ready.remote, "for-each-ref", "--format=%(refname)")).toBe("");
    // The independent oracle uses Git; the publisher has no Git repository to invoke.
    await writeFile(commands, "");
    await expect(service.publish("fixture", 5)).rejects.toThrow("permission");
    grant();
    wave.tasks[0].lanes[0].status = "failed";
    await expect(service.publish("fixture", 5)).rejects.toThrow("Wave changed");
    wave.tasks[0].lanes[0].status = "passed";
    const configured = host.native;
    host.native = {
      ...configured,
      request: { ...configured.request, destination_id: "mirror" },
    };
    await expect(service.publish("fixture", 5)).rejects.toThrow(
      "binding changed",
    );
    host.native = configured;
    service = new WavePublication(host);
    expect(await service.prepare(input)).toEqual(publication);
    const published = await service.publish("fixture", 5);
    expect(published.pushed).toBe(true);
    expect(published.native?.result.status).toBe("PUBLISHED");
    expect(published.head).toMatch(/^git:sha1:[a-f0-9]{40}$/);
    expect(await readFile(commands, "utf8")).toBe("");
    process.env.PATH = originalPath;
    expect(git(ready.remote, "rev-parse", "refs/heads/main")).toBe(
      published.head.slice(9),
    );
    expect(git(ready.remote, "show", "refs/heads/main:main.txt")).toBe(
      "candidate: plugin native publication",
    );
    child.stdin.end("close\n");
    expect(await exited).toBe(0);
    expect(await new WavePublication(host).publish("fixture", 5)).toEqual(
      published,
    );
    expect(await new WavePublication(host).prepare(input)).toEqual(published);
  } finally {
    process.env.PATH = originalPath;
    if (movedGit)
      await rename(join(root, "historical-git"), join(repo, ".git"));
    if (child.exitCode === null) {
      child.stdin.end("close\n");
      const timeout = setTimeout(() => {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      }, 15000);
      await exited;
      clearTimeout(timeout);
    }
  }
}
it(
  native_publication_uses_the_real_source_client_without_git_worktrees.name,
  native_publication_uses_the_real_source_client_without_git_worktrees,
  120000,
);
