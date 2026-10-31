import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SandboxInstance } from '@blaxel/core';
import type { SdkFactory, SdkMachine } from './machine-ops.js';

// The SDK owns global auth. Serialize every call, including calls on retained machines.
let pending: Promise<unknown> = Promise.resolve();
async function loadSdk(): Promise<typeof import('@blaxel/core')> {
  // Browser build disables the SDK's implicit local dotenv/config file loading.
  const root = createRequire(import.meta.url).resolve('@blaxel/core/package.json');
  return import(pathToFileURL(root.replace(/package\.json$/, 'dist/esm-browser/index.js')).href);
}
export function createBlaxelSdkFactory(load = loadSdk): SdkFactory {
  return credentials => {
    async function run<T>(fn: (sdk: typeof import('@blaxel/core')) => Promise<T>): Promise<T> {
      const call = pending.then(async () => {
        const sdk = await load();
        sdk.initialize({ apiKey: credentials.apiKey, workspace: credentials.workspace, disableH2: true, integration: 'hyperfide/0.1.0' });
        return fn(sdk);
      });
      pending = call.catch(() => undefined);
      return call;
    }
    function wrap(machine: SandboxInstance): SdkMachine {
      return {
        metadata: machine.metadata,
        status: machine.status,
        exec: (command, options) => run(async () => {
          const result = await machine.process.exec({ command, workingDir: options.cwd, timeout: options.timeoutSec, env: options.env, waitForCompletion: true });
          return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.status === 'killed' && options.timeoutSec !== undefined };
        }),
        readFile: path => run(async () => new Uint8Array(await (await machine.fs.readBinary(path)).arrayBuffer())),
        writeFile: (path, data) => run(async () => { await machine.fs.writeBinary(path, typeof data === 'string' ? new TextEncoder().encode(data) : data); }),
        destroy: () => run(async () => { await machine.delete(); }),
      };
    }
    return {
      create: options => run(async sdk => wrap(await sdk.SandboxInstance.create({
        name: options.name, region: options.region || undefined, memory: options.memoryMiB,
        lifecycle: options.idleTimeoutSec === undefined ? undefined : { expirationPolicies: [{ type: 'ttl-idle', value: `${options.idleTimeoutSec}s`, action: 'delete' }] },
        envs: Object.entries(options.env ?? {}).map(([name, value]) => ({ name, value })),
      }))),
      connect: id => run(async sdk => wrap(await sdk.SandboxInstance.get(id))),
      list: () => run(async sdk => {
        const result = [];
        for await (const machine of await sdk.SandboxInstance.list()) {
          result.push({ id: machine.metadata.name!, name: machine.metadata.name, status: machine.status ?? 'unknown', createdAt: machine.metadata.createdAt });
        }
        return result;
      }),
    };
  };
}
export const blaxelSdkFactory = createBlaxelSdkFactory();
