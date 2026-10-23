import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerChecker, type CheckerHost, type ImplementedTask, type CheckerRecord } from "./server";
import { runBinary, type ThreadRequest } from "../hyperfide-spec/projection-run-task";

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
`, { mode: 0o755 });
  const records: CheckerRecord[] = [], requests: ThreadRequest[] = [];
  const finding = { file: "source.ts", line: 1, severity: "high", claim: "Return the expected value" };
  let listener: ((task: ImplementedTask) => Promise<CheckerRecord | undefined>) | undefined;
  // Scripted echo provider drives the same Run task host interface as workers.
  const host: CheckerHost = {
    onImplemented(handler) { listener = handler; },
    async recordChecker(_task, record) { records.push(record); },
    async listTaskIds() { return JSON.parse(await readFile(join(cwd, "spec.json"), "utf8")).tasks.map((t: {id: string}) => t.id); },
    async createThread(request, tools) {
      requests.push(request);
      expect(request.env.CG_TASK).toBe(request.task);
      const packet = JSON.parse(request.packet);
      expect(packet.criteria).toEqual(["Criterion 5.3"]);
      expect(packet.diff).toContain("+after");
      expect(packet.laneLog).toBe("lane log");
      const result = options.verify === false ? { exit: 0 } : await tools.verify();
      return { verdict: options.findings ? "findings" : "pass", findings: options.findings ? [options.malformed ? {...finding, line: 0} : finding] : [], verify: { cmd: packet.verifyCmd, exit: result.exit } };
    },
  };
  registerChecker(host, { providers: options.single ? ["echo"] : ["worker", "echo"], checkerProvider: "echo", binary });
  const task: ImplementedTask = { id: "4.3", status: "implemented", wave: 4, cwd, base: "HEAD", criteria: ["Criterion 5.3"],
    verifyCmd: `printf checked > verified; exit ${options.exit ?? 0}`, laneLog: "lane log", workerProvider: options.single ? "echo" : "worker", touches: ["source.ts"], reqs: ["5.3"] };
  return { cwd, task, records, requests, run: (t = task) => listener!(t) };
}
describe("checker lifecycle with echo provider", () => {
  it("starts a separate provider thread, executes verification and records pass on the task", async () => {
    const f = await fixture(); const result = await f.run();
    expect(result).toMatchObject({ status: "pass", independent: true, provider: "echo", fixTasks: [] });
    expect(await readFile(join(f.cwd, "verified"), "utf8")).toBe("checked");
    expect(f.requests[0].role).toBe("checker"); expect(f.records).toEqual([result]);
  });
  it("appends findings to the current wave with all spec add fields", async () => {
    const f = await fixture({ findings: true });
    expect(await f.run()).toMatchObject({ status: "findings", fixTasks: ["4.6"] });
    const spec = JSON.parse(await readFile(join(f.cwd, "spec.json"), "utf8"));
    expect(spec.tasks.at(-1)).toEqual({ id: "4.6", title: "Checker high: Return the expected value", wave: "4", requires: "4.3", touches: "source.ts", verify: f.task.verifyCmd, do: "source.ts:1 [high] Return the expected value", reqs: "5.3" });
  });
  it("records lack of independence with a single provider", async () => {
    const f = await fixture({ single: true }); expect(await f.run()).toMatchObject({ status: "pass", independent: false });
  });
  it("serializes concurrent findings to allocate distinct task ids", async () => {
    const f = await fixture({ findings: true });
    const results = await Promise.all([f.run(), f.run({...f.task, id: "4.2"})]);
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
