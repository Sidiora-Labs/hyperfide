import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { receiptDetail } from "./receipt-detail";
import { runBinary } from "./src/execution";

it("reads task receipts and calls the checker through the shared runner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hyperfide-detail-"));
  try {
    const folder = join(cwd, "artifacts/hyperfide/tasks/4.2/lane");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "receipt.json"), JSON.stringify({ evidence: ["artifacts/hyperfide/tasks/4.2/lane/verify.log", "artifacts/hyperfide/tasks/4.2/lane/bundle.json"] }));
    const checker = join(cwd, "fake-checker.py");
    await writeFile(checker, `import json, sys\nassert sys.argv[1:] == ['4.2', '--root', ${JSON.stringify(cwd)}, '--spec', 'spec/task.kvx', '--receipt', ${JSON.stringify(join(folder, "receipt.json"))}, '--json']\nprint(json.dumps({'tasks': [{'warnings': ['pinned source drifted: source.ts'], 'failures': []}]}))\n`);
    const opened: string[] = [];
    const [detail] = await receiptDetail(cwd, "4.2", "spec/task.kvx", async path => { opened.push(path); }, runBinary, checker);
    expect(detail.warnings).toEqual(["pinned source drifted: source.ts"]);
    await detail.openLog(); await detail.openBundleList();
    expect(opened).toEqual([join(folder, "verify.log"), join(folder, "bundle.json")]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
