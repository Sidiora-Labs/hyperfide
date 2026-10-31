import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerChecker, type CheckerRecord } from "./server";
import { runBinary } from "../hyperfide-spec/src/execution";
import { createTaskWorker, type TaskWorkerHost, type WorkerThreadRequest, type WorkerTaskUpdate } from "../hyperfide-spec/src/worker";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture(options: { findings?: boolean; verify?: boolean; exit?: number; single?: boolean; malformed?: boolean; addFails?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "hyperfide-checker-")); dirs.push(cwd);
  for (const args of [["init", "-q"], ["config", "user.email", "test@hyperfide.local"], ["config", "user.name", "Hyperfide"]]) {
    expect((await runBinary("git", args, cwd)).exit).toBe(0);
  }
  await writeFile(join(cwd, "source.ts"), "before\n");
  await runBinary("git", ["add", "."], cwd);
  await runBinary("git", ["commit", "-qm", "base"], cwd);
  await writeFile(join(cwd, "source.ts"), "after\n");
  await writeFile(join(cwd, "spec.json"), JSON.stringify({ tasks: [1,2,3,4,5].map(n => ({ id: `4.${n}` })) }));
  await mkdir(join(cwd, "spec/checker"), { recursive: true });
  const verifyCmd = `printf checked > verified; exit ${options.exit ?? 0}`;
  const specPath = join(cwd, "spec/checker/spec.kvx");
  await writeFile(specPath, '[meta]\nname = "Checker"\n[req.5]\nac_3 = "Criterion 5.3"\n' + [1,2,3,4,5].map(n => `[task.4.${n}]
status = "implemented"
wave = 4
verify_cmd = ${JSON.stringify(verifyCmd)}
reqs = ["5.3"]
`).join(''));
  const binary = join(cwd, "hyperfide");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (${!!options.addFails}) process.exit(2);
if (args[0] !== 'spec' || args[1] !== 'add') process.exit(3);
const spec = JSON.parse(fs.readFileSync('spec.json', 'utf8'));
const task = {id: args[2]};
for (let i=3;i<args.length;i+=2) task[args[i].slice(2)] = args[i+1];
spec.tasks.push(task); fs.writeFileSync('spec.json', JSON.stringify(spec));
fs.appendFileSync('spec/checker/spec.kvx', '\\n[task.' + task.id + ']\\nwave = 4\\n');
`, { mode: 0o755 });
  const records: CheckerRecord[] = [], requests: WorkerThreadRequest[] = [];
  const finding = { file: "source.ts", line: 1, severity: "high", claim: "Return the expected value" };
  let request: WorkerThreadRequest;
  // Scripted echo provider drives the same Run task host interface as workers.
  const host: TaskWorkerHost = {
    async readFile(environment, path) { return readFile(join(environment, path), "utf8"); },
    async baseCommit() { return "HEAD"; },
    async publish() {},
    async spawn(input) { request = input; requests.push(input); return { id: `thread-${requests.length}`, environment: cwd }; },
    onStopped(_id, callback) {
      const current = request;
      queueMicrotask(async () => {
      const packet = JSON.parse(current.prompt);
      const result = options.verify === false ? { exit: 0 } : await current.tools!.verify();
      await mkdir(join(cwd, ".hyperfide"), { recursive: true });
      await writeFile(join(cwd, ".hyperfide/checker-verdict.json"), JSON.stringify({ verdict: options.findings ? "findings" : "pass", findings: options.findings ? [options.malformed ? {...finding, line: 0} : finding] : [], verify: { cmd: packet.verifyCmd, exit: result.exit } }));
      await callback();
      });
      return () => {};
    },
  };
  const run = registerChecker(host, { providers: options.single ? ["echo"] : ["worker", "echo"], checkerProvider: "echo", binary,
    async laneLog() { return "lane log"; }, async recordChecker(_task, record) { records.push(record); } });
  const task: WorkerTaskUpdate = { feature: "checker", task: "4.3", threadId: "worker", status: "implemented", repository: cwd, environment: cwd, projectId: "project", providerId: options.single ? "echo" : "worker" };
  return { cwd, task, records, requests, host, specPath, run: (t = task) => run(t) };
}
describe("checker lifecycle with echo provider", () => {
  it("starts a separate provider thread, executes verification and records pass on the task", async () => {
    const f = await fixture(); const result = await f.run();
    expect(result).toMatchObject({ status: "pass", independent: true, provider: "echo", fixTasks: [] });
    expect(await readFile(join(f.cwd, "verified"), "utf8")).toBe("checked");
    expect(f.requests[0].title).toBe("Checker checker/4.3");
    const packet = JSON.parse(f.requests[0].prompt);
    expect(packet.criteria).toEqual([{ id: "5.3", text: "Criterion 5.3" }]);
    expect(packet.diff).toContain("+after");
    expect(packet.laneLog).toBe("lane log"); expect(f.records).toEqual([result]);
  });
  it("runs automatically when the real worker reconciles an implemented KVX task", async () => {
    const f = await fixture();
    await writeFile(f.specPath, (await readFile(f.specPath, "utf8")).replaceAll('status = "implemented"', 'status = "pending"'));
    let stopWorker: (() => Promise<void>) | undefined;
    const onStopped = f.host.onStopped.bind(f.host);
    f.host.onStopped = (id, callback) => {
      if (id === "thread-1") { stopWorker = callback; return () => {}; }
      return onStopped(id, callback);
    };
    await createTaskWorker(f.host).runTask({ repository: f.cwd, projectId: "project", feature: "checker", task: "4.3", providerId: "worker" });
    await writeFile(f.specPath, (await readFile(f.specPath, "utf8")).replaceAll('status = "pending"', 'status = "implemented"'));
    await stopWorker!();
    expect(f.records[0]).toMatchObject({ status: "pass", independent: true });
    expect(f.requests.map(request => request.providerId)).toEqual(["worker", "echo"]);
  });
  it("appends findings to the current wave with all spec add fields", async () => {
    const f = await fixture({ findings: true });
    expect(await f.run()).toMatchObject({ status: "findings", fixTasks: ["4.6"] });
    const spec = JSON.parse(await readFile(join(f.cwd, "spec.json"), "utf8"));
    expect(spec.tasks.at(-1)).toEqual({ id: "4.6", title: "Checker high: Return the expected value", wave: "4", requires: "4.3", touches: "source.ts", verify: `printf checked > verified; exit 0`, do: "source.ts:1 [high] Return the expected value", reqs: "5.3" });
  });
  it("records lack of independence with a single provider", async () => {
    const f = await fixture({ single: true }); expect(await f.run()).toMatchObject({ status: "pass", independent: false });
  });
  it("serializes concurrent findings to allocate distinct task ids", async () => {
    const f = await fixture({ findings: true });
    const results = await Promise.all([f.run(), f.run({...f.task, task: "4.2"})]);
    expect(results.map(r => r?.fixTasks)).toEqual([["4.6"], ["4.7"]]);
    const spec = JSON.parse(await readFile(join(f.cwd, "spec.json"), "utf8"));
    expect(spec.tasks.slice(-2).map((t: { requires: string }) => t.requires)).toEqual(["4.3", "4.2"]);
  });
  it.each([{ verify: false }, { exit: 9 }, { findings: true, malformed: true }, { findings: true, addFails: true }])("records invalid verdicts or command failures as errors: %j", async options => {
    const f = await fixture(options); expect(await f.run()).toMatchObject({ status: "error" }); expect(f.records[0].error).toBeTruthy();
  });
  it("ignores tasks that are not implemented and coalesces running events", async () => {
    const f = await fixture(); expect(await f.run({...f.task, status: "pending"})).toBeUndefined();
    await Promise.all([f.run(), f.run()]); expect(f.requests).toHaveLength(1);
  });
});
