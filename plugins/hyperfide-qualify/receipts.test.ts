import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { canonical } from "./receipts";
import { LaneService } from "./lanes";
import { createQualificationAdapter } from "./adapter";
import { receiptDetail } from "../hyperfide-spec/receipt-detail";
import { runBinary } from "../hyperfide-spec/src/execution";
import { SpecReader } from "../hyperfide-spec/src/reader";
import { renderDetail } from "../hyperfide-spec/src/board/app";
import { createBoardServer } from "../hyperfide-spec/src/board/server";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const checker = resolve(import.meta.dirname, "../../tests/hyperfide/closure_check.py");
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "hyperfide-receipt-")); dirs.push(cwd);
  await mkdir(join(cwd, "spec/fixture"), { recursive: true });
  await writeFile(join(cwd, "spec/fixture/spec.kvx"), '[task.4.2]\nstatus = "implemented"\nverify_cmd = "printf passed"\n');
  await writeFile(join(cwd, "source.ts"), "source\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Hyperfide", "-c", "user.email=test@hyperfide.local", "commit", "-qm", "fixture"]]) {
    expect((await runBinary("git", args, cwd)).exit).toBe(0);
  }
  const binary = join(cwd, "hyperfide");
  await writeFile(binary, '#!/bin/sh\nprintf "hyperfide fixture\\n"\n', { mode: 0o755 });
  const lanes = new LaneService(createQualificationAdapter(binary));
  const paths: string[] = [];
  const handler = async (command = "printf passed") => {
    const started = await lanes.start({ repository: cwd, feature: "fixture", task: "4.2" });
    const lane = await lanes.wait(started.id);
    expect(lane.state).toBe("passed");
    expect(lane.command).toBe(command);
    paths.push(lane.receipt!);
    return lane;
  };
  const lane = await handler();
  return { cwd, lane, paths, handler, lanes };
}
it("writes shape, canonical digest and evidence in the lane repository; detail checks and opens both assets", async () => {
  const f = await fixture();
  const receipt = JSON.parse(await readFile(join(f.cwd, f.paths[0]), "utf8"));
  expect(receipt).toMatchObject({ task: "4.2", verify_cmd: "printf passed", exit: 0, toolchain: { node: process.version } });
  expect(receipt.duration).toBeGreaterThan(0);
  expect(receipt.commit).toMatch(/^[a-f0-9]{40}$/);
  const { digest, ...body } = receipt;
  expect(digest).toBe(createHash("sha256").update(canonical(body)).digest("hex"));
  expect(receipt.evidence).toHaveLength(2);
  const opened: string[] = [];
  const details = await receiptDetail(f.cwd, "4.2", "spec/fixture/spec.kvx", async p => { opened.push(p); }, runBinary, checker);
  expect(details).toHaveLength(1); expect(details[0].warnings).toEqual([]);
  expect(details[0].closure.closed).toEqual(["4.2"]);
  await details[0].openLog(); await details[0].openBundleList();
  expect(opened).toEqual(receipt.evidence.map((p: string) => join(f.cwd, p)));
  expect(await readFile(opened[0], "utf8")).toBe("passed");
  expect(JSON.parse(await readFile(opened[1], "utf8")).inputs).toEqual(receipt.inputs);
});
it("shows pinned source drift as a warning on task detail", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "source.ts"), "drift\n");
  const [detail] = await receiptDetail(f.cwd, "4.2", "spec/fixture/spec.kvx", async () => {}, runBinary, checker);
  expect(detail.warnings).toEqual(["pinned source drifted: source.ts"]);
  expect(detail.closure.tasks[0].failures).toEqual([]); expect(detail.closure.open).toEqual(["4.2"]);
});
it("loads receipts through the real spec reader and renders log, bundle and drift on task detail", async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, "tests/hyperfide"), { recursive: true });
  await writeFile(join(f.cwd, "tests/hyperfide/closure_check.py"), await readFile(checker));
  const reader = new SpecReader(f.cwd, { async get() { return undefined; }, async set() {} }, async () => {}, async () => ({}));
  const task = await reader.task("fixture", "4.2");
  expect(task.receipts).toHaveLength(1);
  const board = createBoardServer(f.cwd, feature => reader.tasks(feature));
  expect((await board.tasks("fixture"))[0].receipts).toEqual(task.receipts);
  expect(task.receipts![0].warnings).toEqual([]);
  const html = renderDetail({ ...task, status: "implemented" }, []);
  expect(html).toContain('Open log'); expect(html).toContain('Open bundle list');
  expect(html).toContain(task.receipts![0].digest);
  await writeFile(join(f.cwd, "source.ts"), "drift\n");
  const drifted = await reader.task("fixture", "4.2");
  expect(renderDetail({ ...drifted, status: "implemented" }, [])).toContain("pinned source drifted: source.ts");
  expect((await board.tasks("fixture"))[0].receipts![0].warnings).toContain("pinned source drifted: source.ts");
  reader.close();
});
it("rejects tampered receipts and missing or corrupted evidence", async () => {
  const f = await fixture(), path = join(f.cwd, f.paths[0]);
  const receipt = JSON.parse(await readFile(path, "utf8")); receipt.duration++;
  await writeFile(path, JSON.stringify(receipt));
  let [detail] = await receiptDetail(f.cwd, "4.2", "spec/fixture/spec.kvx", async () => {}, runBinary, checker);
  expect(detail.warnings).toContain("digest does not match receipt content");
  await writeFile(join(f.cwd, receipt.evidence[0]), "corrupted log");
  [detail] = await receiptDetail(f.cwd, "4.2", "spec/fixture/spec.kvx", async () => {}, runBinary, checker);
  expect(detail.warnings).toContain("bundle log digest mismatch");
  await rm(join(f.cwd, receipt.evidence[1]));
  [detail] = await receiptDetail(f.cwd, "4.2", "spec/fixture/spec.kvx", async () => {}, runBinary, checker);
  expect(detail.warnings).toContain("missing log or evidence bundle");
});
it("records only passed lanes and preserves separate receipts for repeated passes", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "spec/fixture/spec.kvx"), '[task.4.2]\nverify_cmd = "exit 7"\n');
  await runBinary("git", ["add", "spec/fixture/spec.kvx"], f.cwd);
  await runBinary("git", ["-c", "user.name=Hyperfide", "-c", "user.email=test@hyperfide.local", "commit", "-qm", "failure"], f.cwd);
  const failed = await f.lanes.wait((await f.lanes.start({repository: f.cwd, feature: "fixture", task: "4.2"})).id);
  expect(failed.state).toBe("failed"); expect(failed.receipt).toBeUndefined();
  await runBinary("git", ["revert", "--no-commit", "HEAD"], f.cwd);
  await runBinary("git", ["-c", "user.name=Hyperfide", "-c", "user.email=test@hyperfide.local", "commit", "-qm", "restore"], f.cwd);
  await f.handler(); expect(new Set(f.paths).size).toBe(2);
});
it("runs the legacy negative self-test through JSON CLI mode", async () => {
  const result = await runBinary("python3", [checker, "--selftest", "--json"], tmpdir());
  expect(result.exit).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ self_test: { passed: true, failures: [] }, tasks: [], closed: [], open: [] });
});
