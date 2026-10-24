import type { DurableMemory } from "../../../memory/durable-memory.js";
export const statuses = ['pending', 'in_progress', 'blocked', 'implemented', 'done', 'superseded'] as const;
export type Status = typeof statuses[number];
export interface Criterion { id: string; text: string }
export interface Task {
  id: string;
  feature: string;
  title: string;
  status: Status;
  wave: number;
  requires: string[];
  touches: string[];
  verify_cmd: string;
  do: string[];
  reqs: string[];
  owner: string;
  criteria: Criterion[];
  recalledDecisions?: DurableMemory[];
  receipts?: import('../../receipt-detail.js').TaskReceipt[];
  [field: `do_${number}`]: string;
}
export interface Feature { stale?: boolean; error?: string; id: string; name: string; status: string; tasks: Task[] }
export interface Wave { wave: number; tasks: Task[] }
export interface SpecSnapshot {
  repository: string;
  readAt: string;
  features: Feature[];
  status: Record<string, unknown>;
  trace: Record<string, unknown>;
}
export interface SpecRead extends SpecSnapshot { stale: boolean; error?: string }
export interface SpecRpc {
  features(): Promise<Feature[]>;
  tasks(feature: string): Promise<Task[]>;
  task(feature: string, id: string): Promise<Task>;
  waves(feature: string): Promise<Wave[]>;
}
