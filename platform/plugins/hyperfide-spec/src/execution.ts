import { spawn } from "node:child_process";

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
