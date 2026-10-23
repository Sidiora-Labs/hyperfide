import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runBinary, type Runner } from "./projection-run-task";

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

export interface ReceiptDetailHost {
  onTaskDetail(handler: (task: { cwd: string; id: string; spec: string }) => ReturnType<typeof receiptDetail>): void;
  openFile(path: string): Promise<void>;
}
export function registerReceiptDetail(host: ReceiptDetailHost, runner: Runner = runBinary, checker?: string) {
  host.onTaskDetail(task => receiptDetail(task.cwd, task.id, task.spec, path => host.openFile(path), runner, checker));
}
