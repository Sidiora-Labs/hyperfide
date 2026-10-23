import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const workerEntry = new URL("../../../../plugins/hyperfide-spec/src/worker.ts", import.meta.url).href;
const { createTaskWorker: createSpecTaskWorker } = await import(workerEntry);
const providerEntry = new URL("../../../../plugins/hyperfide-spec/src/test/scripted-echo-provider.ts", import.meta.url).href;
const { ScriptedEchoProvider } = await import(providerEntry);

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function repository(preamble = true) {
  const root = await mkdtemp(join(tmpdir(), "hyperfide-worker-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, "spec/demo"), { recursive: true });
  await writeFile(join(repo, "spec/demo/spec.kvx"), `[task.2.3]\ntitle = "Worker packet"\nstatus = "pending"\nrequires = ["2.1", "1.4"]\ntouches = ["src/**"]\nverify_cmd = "npm test"\ndo_10 = "Last instruction"\ndo_2 = "First instruction"\n\n[task.9]\nstatus = "pending"\n`);
  if (preamble) {
    await mkdir(join(repo, ".hyperfide"));
    await writeFile(join(repo, ".hyperfide/packet-preamble.md"), "Repository-specific instructions.");
  }
  for (const args of [["init"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@hyperfide.dev", "commit", "-m", "fixture"]]) {
    execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  }
  return repo;
}
const input = (repo: string) => ({ repository: repo, projectId: "proj_test", feature: "demo", task: "2.3", providerId: "scripted-echo" });
describe("spec task worker", () => {
  it("launches the packet in a managed worktree with provider and CG_TASK, then reads implemented from that worktree", async () => {
    const repo = await repository();
    const provider = new ScriptedEchoProvider("implemented");
    const worker = createSpecTaskWorker(provider);
    const thread = await worker.runTask(input(repo));
    expect(provider.requests[0]).toMatchObject({ providerId: "scripted-echo", environment: { type: "provider", environmentProviderId: "environment-git-worktree" }, originPluginId: "hyperfide-spec" });
    await expect(worker.runTask(input(repo))).rejects.toThrow("running worker");
    await provider.finish();
    const echo = JSON.parse(await readFile(join(thread.environment, "echo.json"), "utf8"));
    expect(echo).toMatchObject({ task: "2.3", cwd: thread.environment });
    for (const text of ["# Task demo/2.3: Worker packet", "2.1, 1.4", "src/**", "npm test", "Standing rules", "[spec:demo/2.3]", "Repository-specific instructions.", await provider.baseCommit(repo)]) expect(echo.packet).toContain(text);
    expect(echo.packet.indexOf("do_2:")).toBeLessThan(echo.packet.indexOf("do_10:"));
    expect(provider.updates).toEqual([{ feature: "demo", task: "2.3", threadId: thread.id, status: "implemented" }]);
    expect((await provider.readTask(repo, "demo", "2.3")).status).toBe("pending");
    expect((await provider.readTask(thread.environment, "demo", "9")).status).toBe("pending");
  });
  it("marks a stopped worker needs-review and allows a chosen environment provider without a preamble", async () => {
    const repo = await repository(false);
    const provider = new ScriptedEchoProvider();
    await createSpecTaskWorker(provider).runTask({ ...input(repo), environmentProviderId: "hyperfide-slices" });
    expect(provider.requests[0]!.environment.environmentProviderId).toBe("hyperfide-slices");
    await provider.finish();
    expect(provider.updates[0]!.status).toBe("needs-review");
  });
  it("rejects unknown tasks and invalid identities before creating a thread", async () => {
    const repo = await repository();
    const provider = new ScriptedEchoProvider();
    const worker = createSpecTaskWorker(provider);
    await expect(worker.runTask({ ...input(repo), task: "missing" })).rejects.toThrow("Unknown task");
    await expect(worker.runTask({ ...input(repo), feature: "../escape" })).rejects.toThrow("identity");
    expect(provider.requests).toHaveLength(0);
  });
  it("uses the board KVX parser for multiline task fields and comments", async () => {
    const repo = await repository();
    const file = join(repo, "spec/demo/spec.kvx");
    await writeFile(file, (await readFile(file, "utf8"))
      .replace('requires = ["2.1", "1.4"]', 'requires = [\n"2.1",\n"1.4"\n] # direct dependencies')
      .replace('title = "Worker packet"', 'title = "Worker # packet" # title comment'));
    const provider = new ScriptedEchoProvider();
    await createSpecTaskWorker(provider).runTask(input(repo));
    expect(provider.requests[0]!.prompt).toContain("Worker # packet");
    expect(provider.requests[0]!.prompt).toContain("requires: 2.1, 1.4");
  });
  it("marks an unreadable stopped-worker spec for review", async () => {
    const repo = await repository();
    const provider = new ScriptedEchoProvider();
    const thread = await createSpecTaskWorker(provider).runTask(input(repo));
    await rm(join(thread.environment, "spec/demo/spec.kvx"));
    await provider.finish();
    expect(provider.updates[0]!.status).toBe("needs-review");
  });
});
