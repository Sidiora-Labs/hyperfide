import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runBinary, type Runner } from "../hyperfide-spec/projection-run-task";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface PassedLane {
  task: string; cwd: string; verify_cmd: string; exit: number; duration: number;
  toolchain: Record<string, string>; log: string; sources: string[];
}
export interface Receipt {
  task: string; commit: string; verify_cmd: string; exit: number; duration: number;
  toolchain: Record<string, string>; evidence: string[];
  inputs: { original_path: string; sha256: string }[]; evidence_sha256: Record<string, string>; digest: string;
}
function sourcePath(root: string, path: string) {
  const full = resolve(root, path), rel = relative(root, full);
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) throw new Error("Source must be inside lane repository");
  return full;
}
export async function writeReceipt(lane: PassedLane, runner: Runner = runBinary) {
  if (lane.exit !== 0) return undefined;
  if (!/^\d+\.\d+$/.test(lane.task) || !lane.sources.length || !Object.keys(lane.toolchain).length || !Number.isFinite(lane.duration) || lane.duration < 0) throw new Error("Invalid lane evidence");
  const commit = await runner("git", ["rev-parse", "HEAD"], lane.cwd);
  if (commit.exit || !/^[a-f0-9]{40}$/.test(commit.stdout.trim())) throw new Error("Cannot pin lane commit");
  const inputs = await Promise.all(lane.sources.map(async path => ({ original_path: path, sha256: sha(await readFile(sourcePath(lane.cwd, path))) })));
  const folder = join("artifacts/hyperfide/tasks", lane.task, randomUUID());
  await mkdir(join(lane.cwd, folder), { recursive: true });
  const log = join(folder, "verify.log"), bundle = join(folder, "bundle.json");
  await writeFile(join(lane.cwd, log), lane.log);
  const bundleBytes = canonical({ inputs, files: [{ path: log, sha256: sha(lane.log) }] }) + "\n";
  await writeFile(join(lane.cwd, bundle), bundleBytes);
  const body = { task: lane.task, commit: commit.stdout.trim(), verify_cmd: lane.verify_cmd, exit: lane.exit,
    duration: Math.round(lane.duration), toolchain: lane.toolchain, evidence: [log, bundle], inputs, evidence_sha256: { [log]: sha(lane.log), [bundle]: sha(bundleBytes) } };
  const receipt: Receipt = { ...body, digest: sha(canonical(body)) };
  const path = join(folder, "receipt.json");
  await writeFile(join(lane.cwd, path), canonical(receipt) + "\n");
  return { receipt, path };
}
