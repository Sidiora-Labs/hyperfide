import { readFile } from 'node:fs/promises';

export interface SandboxMachineCapabilities { checkpoint: boolean; list: boolean }
export interface SandboxMachineCreateOptions { fromCheckpoint?: string; cpu?: number; memoryMiB?: number; idleTimeoutSec?: number; env?: Record<string, string>; name?: string; region?: string }
export interface SandboxExecOptions { cwd?: string; timeoutSec?: number; maxOutputBytes?: number; env?: Record<string, string> }
export interface SandboxExecResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; ms: number }
export interface SandboxMachineInfo { id: string; name?: string; status: string; createdAt?: string }
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
  constructor(message: string, readonly providerClass: string) { super(message); this.name = 'MachineProviderError'; }
}
export interface Credentials { apiKey: string; workspace: string }
export type CredentialResolver = () => Promise<Credentials | null>;
export interface SdkMachine {
  metadata: { name?: string; createdAt?: string };
  status?: string;
  exec(command: string, options: SandboxExecOptions): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  destroy(): Promise<void>;
}
export interface BlaxelSdk {
  create(options: SandboxMachineCreateOptions): Promise<SdkMachine>;
  connect(id: string): Promise<SdkMachine>;
  list(): Promise<SandboxMachineInfo[]>;
}
export type SdkFactory = (credentials: Credentials) => BlaxelSdk | Promise<BlaxelSdk>;
export function redact(text: string, credentials?: Credentials): string {
  for (const value of [credentials?.apiKey, credentials?.workspace]) {
    if (value) text = text.split(value).join('[REDACTED]');
  }
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
}
const unsupported = () => new MachineProviderError('Blaxel checkpoints are unsupported', 'unsupported');
export function createMachineOps(resolve: CredentialResolver, factory: SdkFactory): SandboxMachineOps {
  async function session() {
    let credentials: Credentials | null;
    try { credentials = await resolve(); }
    catch { throw new MachineProviderError('Could not resolve Blaxel credentials', 'credentials-missing'); }
    if (!credentials?.apiKey.trim() || !credentials.workspace.trim()) throw new MachineProviderError('Configure Blaxel API key and workspace in plugin settings', 'credentials-missing');
    const secrets = credentials;
    async function run<T>(fn: () => Promise<T>): Promise<T> {
      try { return await fn(); }
      catch (error) {
        throw new MachineProviderError(redact(error instanceof Error ? error.message : String(error), secrets), error instanceof MachineProviderError ? error.providerClass : error instanceof Error ? error.name : 'Error');
      }
    }
    const sdk = await run(async () => factory(secrets));
    function wrap(machine: SdkMachine): SandboxMachine {
      const id = machine.metadata.name;
      if (!id) throw new MachineProviderError('Blaxel returned no sandbox name', 'invalid-response');
      return {
        id,
        exec: (command, options = {}) => run(async () => {
          const limit = options.maxOutputBytes ?? 1024 * 1024;
          if (!Number.isInteger(limit) || limit < 0) throw new MachineProviderError('Invalid output byte limit', 'invalid-options');
          const start = Date.now();
          const result = await machine.exec(command, options);
          const stdout = Buffer.from(redact(result.stdout, secrets));
          const stderr = Buffer.from(redact(result.stderr, secrets));
          const out = stdout.subarray(0, limit);
          const err = stderr.subarray(0, Math.max(0, limit - out.length));
          return { exitCode: result.exitCode, stdout: out.toString(), stderr: err.toString(), timedOut: result.timedOut ?? false, truncated: stdout.length + stderr.length > limit, ms: Date.now() - start };
        }),
        readFile: path => run(() => machine.readFile(path)),
        writeFile: (path, data, options) => run(async () => {
          if (options?.mode !== undefined && (!Number.isInteger(options.mode) || options.mode < 0 || options.mode > 0o7777)) throw new MachineProviderError('Invalid file mode', 'invalid-options');
          await machine.writeFile(path, data);
          if (options?.mode !== undefined) {
            const result = await machine.exec(`chmod ${options.mode.toString(8)} -- '${path.replace(/'/g, "'\\''")}'`, {});
            if (result.exitCode !== 0) throw new Error(result.stderr);
          }
        }),
        checkpoint: async () => { throw unsupported(); },
        destroy: () => run(async () => {
          try { await machine.destroy(); } catch (error) {
            if (!(error instanceof Error) || !/NotFound/.test(error.name)) throw error;
          }
        }),
      };
    }
    return { sdk, run, wrap };
  }
  return {
    providerId: 'hyperfide-machine-blaxel', capabilities: { checkpoint: false, list: true },
    async create(options) {
      if (options.fromCheckpoint) throw unsupported();
      if (options.cpu !== undefined) throw new MachineProviderError('Blaxel SDK does not support CPU selection', 'unsupported');
      const { sdk, run, wrap } = await session();
      const machine = wrap(await run(() => sdk.create(options)));
      try {
        const bootstrap = await readFile(new URL('../bootstrap/alpine.sh', import.meta.url), 'utf8');
        const result = await machine.exec(bootstrap);
        if (result.exitCode !== 0 || result.timedOut) throw new MachineProviderError(`Blaxel bootstrap failed: ${result.stderr}`, 'bootstrap-failed');
        return machine;
      } catch (error) { await machine.destroy().catch(() => undefined); throw error; }
    },
    async connect(id) { const { sdk, run, wrap } = await session(); return wrap(await run(() => sdk.connect(id))); },
    async list() { const { sdk, run } = await session(); return run(() => sdk.list()); },
  };
}
