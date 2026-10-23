import type { PacketTask } from "./shared/packet.js";

// Temporary boundary for the spec model (2.1) and host execution context (1.4).
// Reads must target the worker environment, never the operator's checkout.
export interface WorkerProjectionAdapter {
  readFile(environment: string, path: string): Promise<string>;
  readTask(environment: string, feature: string, task: string): Promise<PacketTask & { status: string }>;
  baseCommit(repository: string): Promise<string>;
  spawn(request: WorkerThreadRequest): Promise<{ id: string; environment: string }>;
  // Subscribe with replay if the thread stopped before subscription completed.
  // Deliver callbacks asynchronously, and await them so reconciliation can retry.
  onStopped(threadId: string, callback: () => Promise<void>): () => void;
  publish(update: WorkerTaskUpdate): Promise<void>;
}

export interface WorkerThreadRequest {
  repository: string;
  projectId: string;
  providerId: string;
  environment: { type: "provider"; environmentProviderId: string };
  env: { CG_TASK: string };
  title: string;
  prompt: string;
  origin: "plugin";
  originPluginId: "hyperfide-spec";
}

export interface WorkerTaskUpdate {
  feature: string;
  task: string;
  threadId: string;
  status: string;
}
