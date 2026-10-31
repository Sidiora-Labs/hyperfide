export interface SandboxMachineOps {
  providerId: string;
  capabilities: { checkpoint: boolean; list: boolean };
  create(o: {
    fromCheckpoint?: string;
    cpu?: number;
    memoryMiB?: number;
    idleTimeoutSec?: number;
    env?: Record<string, string>;
    name?: string;
    region?: string;
  }): Promise<SandboxMachine>;
  connect(id: string): Promise<SandboxMachine>;
  list(): Promise<
    { id: string; name?: string; status: string; createdAt?: string }[]
  >;
}
export interface SandboxMachine {
  id: string;
  exec(
    cmd: string,
    options: {
      cwd?: string;
      timeoutSec?: number;
      maxOutputBytes?: number;
      env?: Record<string, string>;
    },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    ms: number;
  }>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    data: Uint8Array,
    options?: { mode?: number },
  ): Promise<void>;
  checkpoint(name: string): Promise<{ name: string }>;
  destroy(): Promise<void>;
}
