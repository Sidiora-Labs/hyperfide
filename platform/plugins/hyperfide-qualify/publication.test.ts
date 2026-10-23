import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WavePublication,
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
