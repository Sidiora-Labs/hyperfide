import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runBinary, type Runner } from "../hyperfide-spec/src/execution";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface NativeSourcePin {schema_version:1;scope:{organisation_id:string;repository_id:string;security_domain_id:string};revision_id:string;root_tree_id:string;workspace_id:string}
export interface PassedLane {
  task: string; cwd: string; verify_cmd: string; exit: number; duration: number;
  toolchain: Record<string, string>; log: string; sources: string[];
  commit?: string; sourceRoot?: string;source?:NativeSourcePin;sourceFiles?:Array<{path:string;kind:string;payload_digest:string}>;
}
export interface Receipt {
  task: string; commit?: string; source?:NativeSourcePin;verify_cmd: string; exit: number; duration: number;
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
  const commit = lane.source?null:lane.commit ? { exit: 0, stdout: lane.commit } : await runner("git", ["rev-parse", "HEAD"], lane.cwd);
  if (commit&&(commit.exit || !/^[a-f0-9]{40}$/.test(commit.stdout.trim()))) throw new Error("Cannot pin lane commit");
  if(lane.source&&(!/^sha256:[a-f0-9]{64}$/.test(lane.source.revision_id)||!/^sha256:[a-f0-9]{64}$/.test(lane.source.root_tree_id)||!lane.sourceFiles))throw new Error("Native qualification requires pinned source and materialization evidence");
  const inputs = await Promise.all(lane.sources.map(async path => {
    const entry=lane.sourceFiles?.find(item=>item.path===path),filename=sourcePath(lane.sourceRoot ?? lane.cwd,path);
    const bytes=entry?.kind==='symlink'?Buffer.from(await readlink(filename)):await readFile(filename),digest=sha(bytes);
    if(lane.source&&(!entry||entry.payload_digest!=='sha256:'+digest))throw new Error("Qualification modified its pinned source input: "+path);
    return {original_path:path,sha256:digest};
  }));
  const folder = join("artifacts/hyperfide/tasks", lane.task, randomUUID());
  await mkdir(join(lane.cwd, folder), { recursive: true });
  const log = join(folder, "verify.log"), bundle = join(folder, "bundle.json");
  await writeFile(join(lane.cwd, log), lane.log);
  const bundleBytes = canonical({ inputs, files: [{ path: log, sha256: sha(lane.log) }] }) + "\n";
  await writeFile(join(lane.cwd, bundle), bundleBytes);
  const body = { task: lane.task, ...(lane.source?{source:lane.source}:{commit:commit!.stdout.trim()}), verify_cmd: lane.verify_cmd, exit: lane.exit,
    duration: Math.round(lane.duration), toolchain: lane.toolchain, evidence: [log, bundle], inputs, evidence_sha256: { [log]: sha(lane.log), [bundle]: sha(bundleBytes) } };
  const receipt: Receipt = { ...body, digest: sha(canonical(body)) };
  const path = join(folder, "receipt.json");
  await writeFile(join(lane.cwd, path), canonical(receipt) + "\n");
  return { receipt, path };
}
