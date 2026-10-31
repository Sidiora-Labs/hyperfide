import type { SandboxMachine, SandboxMachineOps } from "../machine-ops";
import type { Task } from "../../../hyperfide-spec/src/shared/model.js";
export type SpecTask = Pick<Task, "id" | "status" | "requires" | "wave">;
// Integration supplies authoritative merged membership and atomic claims.
export interface SpecReadModel {
  tasks(): Promise<SpecTask[]>;
  merged(task: string, tip: string): Promise<boolean>;
  claim(task: string, job: string): Promise<boolean>;
  release(task: string, job: string): Promise<void>;
}
export interface TaskPacket {
  task: string;
  prompt: string;
}
export interface RunnerResult {
  exitCode: number;
  commits: string[];
  stdout?: string;
  stderr?: string;
}
export interface TaskRunner {
  run(
    packet: TaskPacket,
    machine: SandboxMachine,
    key: string,
  ): Promise<RunnerResult>;
}
export interface DispatcherOptions {
  directory: string;
  storage?: import("@hyperfide/authority").PluginStorage;
  machines: SandboxMachineOps;
  spec: SpecReadModel;
  runner: TaskRunner;
  keys: { id: string; value: string; concurrency: number }[];
  cap: number;
  limits(): Promise<{ global: number; host: number; otherRunning: number }>;
  checkpoint(): Promise<string>;
  integration(): Promise<{ tip: string; bundle: Uint8Array }>;
  packet(task: string): Promise<TaskPacket>;
  prepare: string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}
