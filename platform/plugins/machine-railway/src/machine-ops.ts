import { Sandbox, type CreateOptions, type ExecOptions, type ExecResult } from "railway";
import WebSocket from "ws";

export interface SandboxMachineCapabilities { checkpoint: boolean; list: boolean }
export interface SandboxMachineCreateOptions { fromCheckpoint?: string; cpu?: number; memoryMiB?: number; idleTimeoutSec?: number; env?: Record<string, string>; name?: string; region?: string }
export interface SandboxExecOptions { cwd?: string; timeoutSec?: number; maxOutputBytes?: number; env?: Record<string, string> }
export interface SandboxExecResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; ms: number }
export interface SandboxMachineInfo { id: string; name?: string; status: string; createdAt?: string; region?: string }
export interface SandboxMachine {
  readonly id: string;
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
  checkpoint(name: string): Promise<{ name: string }>;
  destroy(): Promise<void>;
}
export interface SandboxMachineOps {
  readonly providerId: string;
  readonly capabilities: SandboxMachineCapabilities;
  create(options: SandboxMachineCreateOptions): Promise<SandboxMachine>;
  connect(id: string): Promise<SandboxMachine>;
  list(): Promise<SandboxMachineInfo[]>;
}
export class MachineProviderError extends Error {
  constructor(message: string, readonly providerClass: string) { super(message); this.name = "MachineProviderError"; }
}
export interface Credentials { token: string; environmentId: string }
export type CredentialsResolver = () => Promise<Credentials | null>;
export function redact(value: string, credentials?: Credentials): string {
  let result = value;
  for (const secret of Object.values(credentials ?? {}).sort((a, b) => b.length - a.length)) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/\b(?:sk|rk|pk|ghp|gho|ghs|github_pat|xox[bap])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+\/_-]{24,}\.[A-Za-z0-9+\/_-]{24,}\.[A-Za-z0-9+\/_-]{16,}\b/g, "[REDACTED]");
}
export interface RailwayMachine {
  readonly id: string;
  exec(command: string, options: ExecOptions): { result(): Promise<ExecResult> };
  files: {
    read(path: string, options: { format: "bytes" }): Promise<Uint8Array>;
    write(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
  };
  checkpoint(name: string): Promise<unknown>;
  destroy(): Promise<void>;
}
export interface RailwayClient {
  create(options: SandboxMachineCreateOptions): Promise<RailwayMachine>;
  connect(id: string): Promise<RailwayMachine>;
  list(): Promise<SandboxMachineInfo[]>;
}
export type RailwayClientFactory = (credentials: Credentials) => RailwayClient | Promise<RailwayClient>;
class RailwayWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols, { origin: "https://railway.com" }); }
}
export interface RailwaySdk {
  create(options: CreateOptions): Promise<RailwayMachine>;
  create(checkpoint: string, options: CreateOptions): Promise<RailwayMachine>;
  connect(id: string, options: CreateOptions): Promise<RailwayMachine>;
  list(options: CreateOptions): Promise<SandboxMachineInfo[]>;
}
export function createRailwayClient(credentials: Credentials, sdk: RailwaySdk = Sandbox): RailwayClient {
  const config = { token: credentials.token, environmentId: credentials.environmentId, authType: "bearer" as const, webSocketImpl: RailwayWebSocket };
  return {
    async create(options) {
      const settings: CreateOptions = { ...config, resources: { cpu: options.cpu, memoryGB: options.memoryMiB === undefined ? undefined : options.memoryMiB * 1048576 / 1e9 }, idleTimeoutMinutes: options.idleTimeoutSec === undefined ? undefined : options.idleTimeoutSec / 60, env: options.env, region: options.region };
      return options.fromCheckpoint === undefined ? sdk.create(settings) : sdk.create(options.fromCheckpoint, settings);
    },
    connect: (id) => sdk.connect(id, config),
    async list() { return (await sdk.list(config)).map(({ id, status, createdAt, region }) => ({ id, status, createdAt, region })); },
  };
};

export function createMachineOps(resolveCredentials: CredentialsResolver, factory: RailwayClientFactory = createRailwayClient): SandboxMachineOps {
  async function session<T>(run: (client: RailwayClient, credentials: Credentials) => Promise<T>): Promise<T> {
    let credentials: Credentials | undefined;
    try {
      const resolved = await resolveCredentials();
      if (!resolved?.token.trim() || !resolved.environmentId.trim()) throw new MachineProviderError("Configure Railway credentials in plugin settings.", "credentials-missing");
      credentials = resolved;
      return await run(await factory(resolved), resolved);
    } catch (error) { throw mapped(error, credentials); }
  }
  function mapped(error: unknown, credentials?: Credentials): MachineProviderError {
    return new MachineProviderError(redact(error instanceof Error ? error.message : String(error), credentials), error instanceof MachineProviderError ? error.providerClass : error instanceof Error ? error.constructor.name : "Error");
  }
  function wrap(machine: RailwayMachine, credentials: Credentials): SandboxMachine {
    const clean = (value: string) => redact(value, credentials);
    async function guarded<T>(run: () => Promise<T>): Promise<T> { try { return await run(); } catch (error) { throw mapped(error, credentials); } }
    return {
      id: clean(machine.id),
      exec: (command, options = {}) => guarded(async () => {
        const started = Date.now();
        const result = await machine.exec(command, { timeoutSec: 1800, maxOutputBytes: 4_000_000, ...options }).result();
        return { ...result, exitCode: result.exitCode ?? -1, stdout: clean(result.stdout), stderr: clean(result.stderr), ms: Date.now() - started };
      }),
      readFile: (path) => guarded(async () => {
        const bytes = await machine.files.read(path, { format: "bytes" });
        // Preserve arbitrary binary data; replace only credential/token byte sequences.
        const raw = Buffer.from(bytes).toString("latin1");
        const secrets = { token: Buffer.from(credentials.token).toString("latin1"), environmentId: Buffer.from(credentials.environmentId).toString("latin1") };
        return Buffer.from(redact(raw, secrets), "latin1");
      }),
      writeFile: (path, data, options) => guarded(() => machine.files.write(path, data, options)),
      checkpoint: (name) => guarded(async () => { await machine.checkpoint(name); return { name: clean(name) }; }),
      destroy: () => guarded(() => machine.destroy()),
    };
  }
  return {
    providerId: "hyperfide-machine-railway",
    capabilities: { checkpoint: true, list: true },
    create: (options) => session(async (client, credentials) => wrap(await client.create(options), credentials)),
    connect: (id) => session(async (client, credentials) => wrap(await client.connect(id), credentials)),
    list: () => session(async (client, credentials) => (await client.list()).map((info) => ({ id: redact(info.id, credentials), status: redact(info.status, credentials), ...(info.name === undefined ? {} : { name: redact(info.name, credentials) }), ...(info.createdAt === undefined ? {} : { createdAt: redact(info.createdAt, credentials) }) }))),
  };
}
