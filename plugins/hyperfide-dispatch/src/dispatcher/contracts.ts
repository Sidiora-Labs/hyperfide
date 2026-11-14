import type { SourceScope, SourceAuthority } from "@hyperfide/source-control";
import type { SandboxMachine, SandboxMachineOps } from "../machine-ops";
import type { Task } from "../../../hyperfide-spec/src/shared/model.js";
export type SpecTask = Pick<Task, "id" | "status" | "requires" | "wave">;
// Integration supplies authoritative merged membership and atomic claims.
export interface SpecReadModel {
  tasks(): Promise<SpecTask[]>;
  merged(task: string, revision: string): Promise<boolean>;
  claim(task: string, job: string): Promise<boolean>;
  release(task: string, job: string): Promise<void>;
}
export interface NativeAssignmentDescriptor {
  schema_version: 1;
  backend: "native";
  revision_id: string;
  root_tree_id: string;
  scope: SourceScope;
  closure_id: string;
  environment_id: string;
  task_id: string;
  task_generation: string;
  attempt_id: string;
  attempt_generation: string;
  workspace_id: string;
  workspace_generation: string;
  assignment_id: string;
  assignment_generation: string;
  authority: SourceAuthority;
}
export interface LegacyAssignmentDescriptor {
  schema_version: 1;
  backend: "legacy";
  compatibility: "git-tip-bundle-v1";
  tip: string;
  bundle: Uint8Array;
}
export type AssignmentDescriptor =
  | NativeAssignmentDescriptor
  | LegacyAssignmentDescriptor;

export interface LegacyIntegrationInput {
  tip: string;
  bundle: Uint8Array;
}
// Existing plugin callbacks enter only through this named Git compatibility adapter.
export function legacyAssignment(
  value: LegacyIntegrationInput,
): LegacyAssignmentDescriptor {
  return {
    schema_version: 1,
    backend: "legacy",
    compatibility: "git-tip-bundle-v1",
    ...value,
  };
}
export interface TaskPacket {
  task: string;
  prompt: string;
  assignment?: AssignmentDescriptor;
}
export interface RunnerResult {
  exitCode: number;
  commits: string[];
  submission?: import("@hyperfide/source-control").SourceFleetSubmission;
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
  planning?: "manager" | "legacy-nonadaptive" | "native";
  directory: string;
  storage?: import("@hyperfide/authority").PluginStorage;
  machines: SandboxMachineOps;
  spec: SpecReadModel;
  runner: TaskRunner;
  keys: { id: string; value: string; concurrency: number }[];
  cap: number;
  limits(): Promise<{ global: number; host: number; otherRunning: number }>;
  checkpoint(): Promise<string>;
  integration(): Promise<AssignmentDescriptor | LegacyIntegrationInput>;
  assignment?(task: string, attempt: number): Promise<AssignmentDescriptor>;
  packet(task: string): Promise<TaskPacket>;
  prepare: string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}
