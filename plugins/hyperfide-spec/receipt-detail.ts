import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runBinary, type Runner } from "./src/execution.js";

export interface TaskReceipt {
  digest: string; warnings: string[]; log: string; bundle: string;
}
export async function taskReceipts(cwd: string, task: string, spec: string): Promise<TaskReceipt[]> {
  if (!/^\d+\.\d+$/.test(task)) return [];
  const details = await receiptDetail(cwd, task, spec, async () => {});
  return details.map(({ receipt, warnings }) => ({ digest: receipt.digest, warnings,
    log: '.' + receipt.evidence[0], bundle: '.' + receipt.evidence[1] }));
}

export async function receiptDetail(cwd: string, task: string, spec: string, open: (path: string) => Promise<void>, runner: Runner = runBinary,
  checker = "tests/hyperfide/closure_check.py") {
  if (!/^\d+\.\d+$/.test(task)) throw new Error("Invalid task id");
  const root = join(cwd, "artifacts/hyperfide/tasks", task);
  const folders = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(folders.filter(f => f.isDirectory()).map(async folder => {
    const path = join(root, folder.name, "receipt.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    const result = await runner("python3", [checker, task, "--root", cwd, "--spec", spec, "--receipt", path, "--json"], cwd);
    const closure = JSON.parse(result.stdout);
    const detail = closure.tasks[0];
    const warnings: string[] = [...detail.warnings, ...detail.failures];
    const openEvidence = async (index: number) => {
      const full = resolve(cwd, receipt.evidence[index]);
      const rel = relative(root, full);
      if (rel.startsWith("..") || rel.startsWith("/")) throw new Error("Evidence outside task artifacts");
      await open(full);
    };
    return { receipt, closure, warnings, openLog: () => openEvidence(0), openBundleList: () => openEvidence(1) };
  }));
}
