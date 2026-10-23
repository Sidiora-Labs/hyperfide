import { spawn } from "node:child_process";

// Projection of 2.3's shared runner and Run task host until that plugin lands.
export interface RunResult { exit: number; stdout: string; stderr: string }
export type Runner = (command: string, args: string[], cwd: string) => Promise<RunResult>;
export const runBinary: Runner = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  child.on("error", reject);
  child.on("close", exit => resolve({ exit: exit ?? 1, stdout, stderr }));
});

export interface ThreadRequest {
  task: string;
  provider: string;
  cwd: string;
  packet: string;
  role: "worker" | "checker";
}
export interface RunTaskHost {
  createThread(request: ThreadRequest & { env: Record<string, string> }, tools: {
    verify(): Promise<RunResult>;
  }): Promise<unknown>;
}
export function runTaskThread(host: RunTaskHost, request: ThreadRequest, tools: Parameters<RunTaskHost["createThread"]>[1]) {
  return host.createThread({ ...request, env: { CG_TASK: request.task } }, tools);
}
