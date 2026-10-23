import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerProjectionAdapter, WorkerThreadRequest, WorkerTaskUpdate } from "../worker-projection-adapter.js";
import type { PacketTask } from "../shared/packet.js";

const exec = promisify(execFile);
export function parseTask(text: string, id: string): PacketTask & { status: string } {
  const block = text.split(`[task.${id}]`)[1]?.split(/\n\[/)[0];
  if (!block) throw new Error(`Unknown task ${id}`);
  const fields: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const match = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (match) fields[match[1]!] = JSON.parse(match[2]!);
  }
  return fields as PacketTask & { status: string };
}

export class ScriptedEchoProvider implements WorkerProjectionAdapter {
  requests: WorkerThreadRequest[] = [];
  updates: WorkerTaskUpdate[] = [];
  stopped?: () => Promise<void>;
  environment = "";
  constructor(readonly nextStatus?: string) {}
  async readFile(environment: string, path: string) { return readFile(join(environment, path), "utf8"); }
  async readTask(environment: string, feature: string, task: string) {
    return parseTask(await this.readFile(environment, `spec/${feature}/spec.kvx`), task);
  }
  async baseCommit(repository: string) {
    return (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  }
  async spawn(request: WorkerThreadRequest) {
    this.requests.push(request);
    this.environment = `${request.repository}-worker`;
    await exec("git", ["worktree", "add", "--detach", this.environment], { cwd: request.repository });
    return { id: "thr_scripted", environment: this.environment };
  }
  onStopped(_id: string, callback: () => Promise<void>) {
    this.stopped = callback;
    return () => { this.stopped = undefined; };
  }
  async publish(update: WorkerTaskUpdate) { this.updates.push(update); }
  async finish() {
    const request = this.requests[0]!;
    const script = `const fs = require('node:fs');
      const packet = fs.readFileSync(0, 'utf8');
      fs.writeFileSync('echo.json', JSON.stringify({ packet, task: process.env.CG_TASK, cwd: process.cwd() }));
      if (process.argv[1]) {
        const feature = process.argv[2];
        const task = process.env.CG_TASK;
        const file = 'spec/' + feature + '/spec.kvx';
        const text = fs.readFileSync(file, 'utf8');
        const header = '[task.' + task + ']';
        const start = text.indexOf(header) + header.length;
        const end = text.indexOf('\\n[', start);
        const block = text.slice(start, end < 0 ? undefined : end).replace(/status = "[^"]+"/, 'status = "' + process.argv[1] + '"');
        fs.writeFileSync(file, text.slice(0, start) + block + (end < 0 ? '' : text.slice(end)));
      }`;
    await new Promise<void>((resolve, reject) => {
      const feature = /# Task ([^/]+)\//.exec(request.prompt)![1]!;
      const child = execFile(process.execPath, ["-e", script, this.nextStatus ?? "", feature], {
        cwd: this.environment, env: { ...process.env, ...request.env },
      }, error => error ? reject(error) : resolve());
      child.stdin!.end(request.prompt);
    });
    await this.stopped?.();
  }
}
