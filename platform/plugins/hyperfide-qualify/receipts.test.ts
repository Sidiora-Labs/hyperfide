import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { canonical, type PassedLane } from "./receipts";
import { registerLaneReceipts } from "./projection-lane-receipts";
import { receiptDetail } from "../hyperfide-spec/receipt-detail";
import { runBinary } from "../hyperfide-spec/src/execution";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const checker = resolve(import.meta.dirname, "../../../tests/hyperfide/closure_check.py");
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "hyperfide-receipt-")); dirs.push(cwd);
  await mkdir(join(cwd, "spec"));
  await writeFile(join(cwd, "spec/task.kvx"), '[task.4.2]\nstatus = "implemented"\nverify_cmd = "printf passed"\n');
  await writeFile(join(cwd, "source.ts"), "source\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Hyperfide", "-c", "user.email=test@hyperfide.local", "commit", "-qm", "fixture"]]) {
    expect((await runBinary("git", args, cwd)).exit).toBe(0);
  }
  const lane: PassedLane = { task: "4.2", cwd, verify_cmd: "printf passed", exit: 0, duration: 12,
    toolchain: { node: process.version }, log: "passed", sources: ["source.ts"] };
  const paths: string[] = [];
  const handler = registerLaneReceipts({ onLaneFinished() {}, async recordReceipt(_task, path) { paths.push(path); } });
  await handler(lane);
  return { cwd, lane, paths, handler };
}
it("writes shape, canonical digest and evidence in the lane repository; detail checks and opens both assets", async () => {
  const f = await fixture();
  const receipt = JSON.parse(await readFile(join(f.cwd, f.paths[0]), "utf8"));
  expect(receipt).toMatchObject({ task: "4.2", verify_cmd: "printf passed", exit: 0, duration: 12, toolchain: { node: process.version } });
  expect(receipt.commit).toMatch(/^[a-f0-9]{40}$/);
  const { digest, ...body } = receipt;
  expect(digest).toBe(createHash("sha256").update(canonical(body)).digest("hex"));
  expect(receipt.evidence).toHaveLength(2);
  const opened: string[] = [];
  const details = await receiptDetail(f.cwd, "4.2", "spec/task.kvx", async p => { opened.push(p); }, runBinary, checker);
  expect(details).toHaveLength(1); expect(details[0].warnings).toEqual([]);
  expect(details[0].closure.closed).toEqual(["4.2"]);
  await details[0].openLog(); await details[0].openBundleList();
  expect(opened).toEqual(receipt.evidence.map((p: string) => join(f.cwd, p)));
  expect(await readFile(opened[0], "utf8")).toBe("passed");
  expect(JSON.parse(await readFile(opened[1], "utf8")).inputs).toEqual(receipt.inputs);
});
it("shows pinned source drift as a warning on task detail", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "source.ts"), "drift\n");
  const [detail] = await receiptDetail(f.cwd, "4.2", "spec/task.kvx", async () => {}, runBinary, checker);
  expect(detail.warnings).toEqual(["pinned source drifted: source.ts"]);
  expect(detail.closure.tasks[0].failures).toEqual([]); expect(detail.closure.open).toEqual(["4.2"]);
});
it("rejects tampered receipts and missing or corrupted evidence", async () => {
  const f = await fixture(), path = join(f.cwd, f.paths[0]);
  const receipt = JSON.parse(await readFile(path, "utf8")); receipt.duration++;
  await writeFile(path, JSON.stringify(receipt));
  let [detail] = await receiptDetail(f.cwd, "4.2", "spec/task.kvx", async () => {}, runBinary, checker);
  expect(detail.warnings).toContain("digest does not match receipt content");
  await writeFile(join(f.cwd, receipt.evidence[0]), "corrupted log");
  [detail] = await receiptDetail(f.cwd, "4.2", "spec/task.kvx", async () => {}, runBinary, checker);
  expect(detail.warnings).toContain("bundle log digest mismatch");
  await rm(join(f.cwd, receipt.evidence[1]));
  [detail] = await receiptDetail(f.cwd, "4.2", "spec/task.kvx", async () => {}, runBinary, checker);
  expect(detail.warnings).toContain("missing log or evidence bundle");
});
it("records only passed lanes and preserves separate receipts for repeated passes", async () => {
  const f = await fixture(); await f.handler({ ...f.lane, exit: 1 }); expect(f.paths).toHaveLength(1);
  await f.handler(f.lane); expect(new Set(f.paths).size).toBe(2);
});
it("runs the legacy negative self-test through JSON CLI mode", async () => {
  const result = await runBinary("python3", [checker, "--selftest", "--json"], tmpdir());
  expect(result.exit).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ self_test: { passed: true, failures: [] }, tasks: [], closed: [], open: [] });
});
