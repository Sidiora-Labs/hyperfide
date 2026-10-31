import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMachineOps, type BlaxelSdk, type SdkMachine } from './machine-ops.js';
import { machineProvider } from './provider.js';
import { createBlaxelPlugin, SETTING_DESCRIPTORS } from './server.js';

const credentials = { apiKey: 'test-token-0000000000', workspace: 'test-workspace-0000000000' };
function fixture() {
  const remote: SdkMachine = {
    metadata: { name: 'test-machine' },
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    readFile: vi.fn(async () => new Uint8Array([0, 255])),
    writeFile: vi.fn(async () => {}), destroy: vi.fn(async () => {}),
  };
  const sdk: BlaxelSdk = { create: vi.fn(async () => remote), connect: vi.fn(async () => remote), list: vi.fn(async () => [{ id: 'test-machine', status: 'running' }]) };
  const resolve = vi.fn(async () => credentials);
  const factory = vi.fn(() => sdk);
  return { remote, sdk, resolve, factory, ops: createMachineOps(resolve, factory) };
}
describe('Blaxel operations', () => {
  it('creates with region, resources and environment, bootstraps, connects, lists and destroys', async () => {
    const f = fixture();
    const options = { name: 'test-machine', region: 'test-region', memoryMiB: 1024, env: { TEST: 'yes' } };
    const machine = await f.ops.create(options);
    expect(f.sdk.create).toHaveBeenCalledWith(options);
    const script = readFileSync(new URL('../bootstrap/alpine.sh', import.meta.url), 'utf8');
    expect(f.remote.exec).toHaveBeenCalledWith(script, {});
    expect((await machine.exec(script)).exitCode).toBe(0);
    expect(f.remote.exec).toHaveBeenCalledTimes(2);
    expect(await machine.readFile('/tmp/binary')).toEqual(new Uint8Array([0, 255]));
    await machine.writeFile("/tmp/it's", 'hello', { mode: 0o600 });
    expect(f.remote.writeFile).toHaveBeenCalledWith("/tmp/it's", 'hello');
    expect(await f.ops.list()).toEqual([{ id: 'test-machine', status: 'running' }]);
    expect((await f.ops.connect(machine.id)).id).toBe(machine.id);
    await machine.destroy();
    expect(f.remote.destroy).toHaveBeenCalledOnce();
    expect(f.resolve).toHaveBeenCalledTimes(3);
    expect(f.ops.capabilities).toEqual({ checkpoint: false, list: true });
    await expect(machine.checkpoint('save')).rejects.toMatchObject({ providerClass: 'unsupported' });
    await expect(f.ops.create({ fromCheckpoint: 'save' })).rejects.toMatchObject({ providerClass: 'unsupported' });
  });
  it('resolves credentials at every entry and reports missing settings', async () => {
    const f = fixture();
    await f.ops.list();
    const next = { apiKey: 'test-token-next', workspace: 'test-workspace-next' };
    f.resolve.mockResolvedValueOnce(next);
    await f.ops.connect('test-machine');
    expect(f.factory).toHaveBeenLastCalledWith(next);
    const ops = createMachineOps(async () => null, f.factory);
    await expect(ops.create({})).rejects.toMatchObject({ providerClass: 'credentials-missing' });
    await expect(ops.connect('x')).rejects.toMatchObject({ providerClass: 'credentials-missing' });
    await expect(ops.list()).rejects.toMatchObject({ providerClass: 'credentials-missing' });
    expect((await machineProvider(ops, async () => null, async () => '').availability!()).status).toBe('setup-required');
  });
  it('redacts outputs and SDK errors and preserves SDK error class', async () => {
    const f = fixture();
    const machine = await f.ops.connect('test-machine');
    vi.mocked(f.remote.exec).mockResolvedValue({ exitCode: 3, stdout: credentials.apiKey, stderr: `${credentials.workspace} Bearer test-bearer-token`, timedOut: true });
    const result = await machine.exec('test', { cwd: '/tmp', timeoutSec: 2 });
    expect(result).toMatchObject({ exitCode: 3, timedOut: true, truncated: false });
    expect(result.stdout + result.stderr).not.toContain(credentials.apiKey);
    expect(result.stderr).not.toContain(credentials.workspace);
    expect(result.stderr).not.toContain('test-bearer-token');
    vi.mocked(f.remote.exec).mockResolvedValue({ exitCode: 0, stdout: '12345', stderr: '678' });
    expect(await machine.exec('test', { maxOutputBytes: 6 })).toMatchObject({ stdout: '12345', stderr: '6', truncated: true });
    const error = new Error(`failed ${credentials.apiKey} ${credentials.workspace} Bearer test-bearer-token`);
    error.name = 'SandboxNotFoundError';
    vi.mocked(f.sdk.connect).mockRejectedValue(error);
    await expect(f.ops.connect('missing')).rejects.toMatchObject({ providerClass: 'SandboxNotFoundError', message: 'failed [REDACTED] [REDACTED] Bearer [REDACTED]' });
    vi.mocked(f.remote.readFile).mockRejectedValue(error);
    await expect(machine.readFile('/missing')).rejects.toMatchObject({ providerClass: 'SandboxNotFoundError' });
  });
  it('cleans allocations when bootstrap fails', async () => {
    const f = fixture();
    vi.mocked(f.remote.exec).mockResolvedValue({ exitCode: 1, stdout: '', stderr: credentials.apiKey });
    await expect(f.ops.create({})).rejects.toMatchObject({ providerClass: 'bootstrap-failed', message: 'Blaxel bootstrap failed: [REDACTED]' });
    expect(f.remote.destroy).toHaveBeenCalledOnce();
  });
  it('registers the SDK provider using secret settings', async () => {
    const f = fixture();
    const register = vi.fn();
    const define = vi.fn(() => ({ get: async () => ({ HYPERFIDE_BLAXEL_API_KEY: credentials.apiKey, HYPERFIDE_BLAXEL_WORKSPACE: credentials.workspace, region: 'test-region' }) }));
    // Only the settings and machine registration surfaces are used by the entry point.
    await createBlaxelPlugin(f.factory)({ settings: { define }, experimental_machines: { register } } as unknown as Parameters<ReturnType<typeof createBlaxelPlugin>>[0]);
    expect(define).toHaveBeenCalledWith(SETTING_DESCRIPTORS);
    expect(SETTING_DESCRIPTORS.HYPERFIDE_BLAXEL_API_KEY.secret).toBe(true);
    expect(SETTING_DESCRIPTORS.HYPERFIDE_BLAXEL_WORKSPACE.secret).toBe(true);
    const provider = register.mock.calls[0][0];
    expect(await provider.availability()).toEqual({ status: 'available' });
    const checkpoint = vi.fn(async () => {});
    expect(await provider.create({ key: 'test-machine', checkpoint })).toMatchObject({ status: 'created', resource: { id: 'test-machine' } });
    expect(checkpoint.mock.calls[0]).toEqual([{ id: 'test-machine' }]);
    expect(f.sdk.create).toHaveBeenCalledWith({ name: 'test-machine', region: 'test-region' });
    expect(await provider.reconcileCleanup({ key: 'test-machine' })).toEqual({ status: 'removed' });
    expect(await provider.remove({ resource: { id: 'test-machine' } })).toEqual({ status: 'removed' });
    await expect(provider.suspend({})).rejects.toMatchObject({ providerClass: 'unsupported' });
  });
});

it('Alpine bootstrap installs only missing tools and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyperfide-blaxel-'));
  const script = new URL('../bootstrap/alpine.sh', import.meta.url);
  const command = (name: string, body: string) => { const path = join(dir, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
  try {
    for (const tool of ['git', 'python3', 'make', 'gcc', 'g++']) command(tool, `[ -f '${dir}/installed' ]`);
    // command -v sees scripts, so simulate absent tools by initially omitting them.
    for (const tool of ['git', 'python3', 'make', 'gcc', 'g++']) rmSync(join(dir, tool));
    command('id', 'echo 0');
    command('node', 'echo 24');
    command('apk', `echo "$*" >> '${dir}/calls'\nfor tool in git python3 make gcc g++; do\n echo '#!/bin/sh' > '${dir}/'"$tool"\n /bin/chmod +x '${dir}/'"$tool"\ndone`);
    const env = { PATH: dir };
    execFileSync('/bin/sh', [script.pathname], { env });
    execFileSync('/bin/sh', [script.pathname], { env });
    expect(readFileSync(join(dir, 'calls'), 'utf8').trim()).toBe('add --no-cache git python3 build-base');
    command('node', 'echo 22');
    expect(() => execFileSync('/bin/sh', [script.pathname], { env, stdio: 'pipe' })).toThrow();
    rmSync(join(dir, 'git'));
    command('id', 'echo 1000');
    expect(() => execFileSync('/bin/sh', [script.pathname], { env, stdio: 'pipe' })).toThrow();
    expect(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('maps the official SDK API and reapplies isolated credentials for retained machines', async () => {
  const { createBlaxelSdkFactory } = await import('./sdk.js');
  const initialize = vi.fn();
  const processExec = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', status: 'completed' }));
  const remote = {
    metadata: { name: 'test-sdk-machine' }, status: 'RUNNING',
    process: { exec: processExec },
    fs: { readBinary: vi.fn(async () => new Blob([new Uint8Array([255, 0])])), writeBinary: vi.fn(async () => {}) },
    delete: vi.fn(async () => {}),
  };
  const create = vi.fn(async () => remote);
  const sdk = { initialize, SandboxInstance: { create, get: vi.fn(async () => remote), list: vi.fn(async () => [remote]) } };
  const factory = createBlaxelSdkFactory(async () => sdk as unknown as typeof import('@blaxel/core'));
  const client = await factory(credentials);
  const other = await factory({ apiKey: 'test-other-token', workspace: 'test-other-workspace' });
  const machine = await client.create({ region: 'test-region', memoryMiB: 512, idleTimeoutSec: 120, env: { TEST: 'yes' } });
  expect(create).toHaveBeenCalledWith({ name: undefined, region: 'test-region', memory: 512, lifecycle: { expirationPolicies: [{ type: 'ttl-idle', value: '120s', action: 'delete' }] }, envs: [{ name: 'TEST', value: 'yes' }] });
  await other.list();
  expect(await machine.exec('pwd', { cwd: '/tmp', timeoutSec: 3, env: { TEST: 'exec' } })).toMatchObject({ stdout: 'ok' });
  expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: credentials.apiKey, workspace: credentials.workspace }));
  expect(processExec).toHaveBeenCalledWith({ command: 'pwd', workingDir: '/tmp', timeout: 3, env: { TEST: 'exec' }, waitForCompletion: true });
  expect(await machine.readFile('/binary')).toEqual(new Uint8Array([255, 0]));
  await machine.writeFile('/text', 'hello');
  expect(remote.fs.writeBinary).toHaveBeenCalledWith('/text', new TextEncoder().encode('hello'));
  expect(await client.list()).toEqual([{ id: 'test-sdk-machine', name: 'test-sdk-machine', status: 'RUNNING', createdAt: undefined }]);
  await machine.destroy();
  expect(remote.delete).toHaveBeenCalledOnce();
});
