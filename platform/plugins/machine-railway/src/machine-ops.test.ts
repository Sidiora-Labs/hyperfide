import { describe, expect, it, vi } from "vitest";
import { createMachineOps, createRailwayClient, MachineProviderError, redact, type Credentials, type RailwayClient, type RailwayMachine } from "./machine-ops.js";
import { createProvider } from "./provider.js";
import { createRailwayPlugin } from "../server.js";
import { SETTING_DESCRIPTORS, resolveSettings } from "../configuration.js";
const credentials = { token: "test-token-0000000000", environmentId: "test-environment-0000000000" };
function fixture() {
  const execResult = { exitCode: 0 as number | null, stdout: credentials.token, stderr: `Bearer fake-bearer-0000000000 ${credentials.environmentId}`, truncated: false, timedOut: false };
  const machine: RailwayMachine = {
    id: "sandbox-test", exec: vi.fn(() => ({ result: async () => execResult })),
    files: { read: vi.fn(async () => Buffer.from(`hello ${credentials.token}`)), write: vi.fn(async () => {}) },
    checkpoint: vi.fn(async () => ({})), destroy: vi.fn(async () => {}),
  };
  const client: RailwayClient = { create: vi.fn(async () => machine), connect: vi.fn(async () => machine), list: vi.fn(async () => [{ id: machine.id, status: credentials.token, name: credentials.environmentId }]) };
  const resolve = vi.fn(async (): Promise<Credentials | null> => credentials);
  const factory = vi.fn(() => client);
  const ops = createMachineOps(resolve, factory);
  return { machine, client, resolve, factory, ops, execResult };
}
describe("Railway operations", () => {
  it("creates from a checkpoint with resources and uses fresh settings for every entry point", async () => {
    const f = fixture();
    const options = { fromCheckpoint: "test-checkpoint", cpu: 2, memoryMiB: 4096, idleTimeoutSec: 120, env: { HELLO: "world" }, region: "test-region", name: "test-machine" };
    expect((await f.ops.create(options)).id).toBe("sandbox-test");
    expect(f.client.create).toHaveBeenCalledWith(options);
    f.resolve.mockResolvedValueOnce({ token: "test-token-1111111111", environmentId: "test-environment-1111111111" });
    await f.ops.connect("sandbox-test");
    expect(f.factory).toHaveBeenLastCalledWith({ token: "test-token-1111111111", environmentId: "test-environment-1111111111" });
    expect(await f.ops.list()).toEqual([{ id: "sandbox-test", status: "[REDACTED]", name: "[REDACTED]" }]);
    expect(f.resolve).toHaveBeenCalledTimes(3);
    expect(f.ops.capabilities).toEqual({ checkpoint: true, list: true });
  });
  it("executes with bounded output and timeout, preserving outcome flags", async () => {
    const f = fixture(); const machine = await f.ops.connect("sandbox-test");
    const options = { cwd: "/tmp", timeoutSec: 3, maxOutputBytes: 123, env: { TEST: "yes" } };
    f.execResult.timedOut = true; f.execResult.truncated = true; f.execResult.exitCode = null;
    expect(await machine.exec("sleep 5", options)).toEqual({ exitCode: -1, stdout: "[REDACTED]", stderr: "[REDACTED] [REDACTED]", timedOut: true, truncated: true, ms: expect.any(Number) });
    expect(f.machine.exec).toHaveBeenCalledWith("sleep 5", options);
    await machine.exec("true");
    expect(f.machine.exec).toHaveBeenLastCalledWith("true", { timeoutSec: 1800, maxOutputBytes: 4_000_000 });
  });
  it("reads, writes, checkpoints and destroys with output redaction", async () => {
    const f = fixture(); const machine = await f.ops.create({});
    expect(Buffer.from(await machine.readFile("/file")).toString()).toBe("hello [REDACTED]");
    const binary = new Uint8Array([0, 255, 128, 1]);
    vi.mocked(f.machine.files.read).mockResolvedValueOnce(binary);
    expect(await machine.readFile("/binary")).toEqual(Buffer.from(binary));
    await machine.writeFile("/file", binary, { mode: 0o600 });
    expect(f.machine.files.write).toHaveBeenCalledWith("/file", binary, { mode: 0o600 });
    await machine.writeFile("/file", "text");
    expect(await machine.checkpoint(credentials.token)).toEqual({ name: "[REDACTED]" });
    await machine.destroy(); expect(f.machine.destroy).toHaveBeenCalledOnce();
  });
  it("fails without credentials without constructing a client", async () => {
    const f = fixture(); f.resolve.mockResolvedValue(null);
    for (const call of [() => f.ops.create({}), () => f.ops.connect("id"), () => f.ops.list()]) await expect(call()).rejects.toMatchObject({ providerClass: "credentials-missing" });
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("maps every SDK failure to its class and redacts error stacks", async () => {
    class SandboxNotFoundError extends Error {}
    const failure = () => new SandboxNotFoundError(`${credentials.token} ${credentials.environmentId} Bearer test-bearer-0000000000`);
    const f = fixture(); const machine = await f.ops.connect("id");
    vi.mocked(f.client.create).mockRejectedValue(failure()); vi.mocked(f.client.connect).mockRejectedValue(failure()); vi.mocked(f.client.list).mockRejectedValue(failure());
    vi.mocked(f.machine.exec).mockImplementation(() => { throw failure(); });
    vi.mocked(f.machine.files.read).mockRejectedValue(failure()); vi.mocked(f.machine.files.write).mockRejectedValue(failure()); vi.mocked(f.machine.checkpoint).mockRejectedValue(failure()); vi.mocked(f.machine.destroy).mockRejectedValue(failure());
    for (const call of [() => f.ops.create({}), () => f.ops.connect("id"), () => f.ops.list(), () => machine.exec("false"), () => machine.readFile("/file"), () => machine.writeFile("/file", "x"), () => machine.checkpoint("snap"), () => machine.destroy()]) {
      try { await call(); throw new Error("expected rejection"); } catch (error) {
        expect(error).toBeInstanceOf(MachineProviderError);
        expect(error).toMatchObject({ providerClass: "SandboxNotFoundError", message: "[REDACTED] [REDACTED] [REDACTED]" });
        expect(String((error as Error).stack)).not.toContain(credentials.token);
      }
    }
    f.factory.mockImplementation(() => { throw failure(); });
    await expect(f.ops.create({})).rejects.toMatchObject({ providerClass: "SandboxNotFoundError" });
  });
  it("redacts short secrets and bearer-looking tokens", () => {
    expect(redact("tiny Bearer abc sk_00000000000000", { token: "tiny", environmentId: "env" })).toBe("[REDACTED] [REDACTED] [REDACTED]");
  });
});
describe("SDK machine provider", () => {
  function setup() {
    const f = fixture(); const records = new Map<string, unknown>();
    const store = { async get<T>(key: string) { return records.get(key) as T | undefined; }, async set(key: string, value: unknown) { records.set(key, value); } };
    const provider = createProvider(f.ops, f.resolve, store);
    const context = { inputs: null, key: "test-key", attempt: 1, checkpoint: vi.fn(async () => {}), report: { step: vi.fn(), log: vi.fn() }, signal: new AbortController().signal };
    return { ...f, provider, context, store };
  }
  it("registers secret settings and reports setup-required", async () => {
    const f = setup(); f.resolve.mockResolvedValue(null);
    expect(await f.provider.availability!()).toMatchObject({ status: "setup-required" });
    expect(resolveSettings({})).toBeNull();
    expect(resolveSettings({ HYPERFIDE_RAILWAY_API_TOKEN: credentials.token, HYPERFIDE_RAILWAY_ENV_ID: credentials.environmentId })).toEqual(credentials);
    const define = vi.fn(() => ({ get: async () => ({}) })); const register = vi.fn();
    createRailwayPlugin(f.factory)({ settings: { define }, storage: { kv: f.store }, experimental_machines: { register } });
    expect(define).toHaveBeenCalledWith(SETTING_DESCRIPTORS);
    expect(Object.values(SETTING_DESCRIPTORS).every((value) => value.secret)).toBe(true);
    expect(register).toHaveBeenCalledOnce();
  });
  it("creates, checkpoints, suspends, resumes and removes idempotently", async () => {
    const f = setup(); expect(await f.provider.availability!()).toEqual({ status: "available" });
    const created = await f.provider.create(f.context); if (created.status !== "created") throw new Error("create failed");
    expect(f.context.checkpoint).toHaveBeenCalledWith(created.resource);
    const context = { ...f.context, hostId: "host", resource: created.resource };
    expect((await f.provider.resume!(context)).resource).toEqual(created.resource);
    const suspended = await f.provider.suspend!(context);
    expect(suspended.resource).toMatchObject({ id: null, checkpoint: "hyperfide-sandbox-test" });
    expect(await f.provider.suspend!({ ...context, resource: suspended.resource })).toEqual(suspended);
    const resumed = await f.provider.resume!({ ...context, resource: suspended.resource });
    expect(f.client.create).toHaveBeenLastCalledWith({ fromCheckpoint: "hyperfide-sandbox-test", name: "test-key" });
    expect(await f.provider.remove({ ...context, resource: resumed.resource })).toEqual({ status: "removed" });
    expect(await f.provider.reconcileCleanup(f.context)).toEqual({ status: "removed" });
  });
  it("never declares an uncertain allocation cleaned up", async () => {
    const f = setup(); vi.mocked(f.client.create).mockRejectedValue(new Error("allocation uncertain"));
    await expect(f.provider.create(f.context)).rejects.toThrow("allocation uncertain");
    expect(await f.provider.reconcileCleanup(f.context)).toMatchObject({ status: "failed" });
    await expect(f.provider.create(f.context)).rejects.toMatchObject({ providerClass: "allocation-pending" });
  });
});

it("adapts SDK creation units, checkpoint overload, authentication and Node WebSocket", async () => {
  const f = fixture();
  const sdk = { create: vi.fn(async () => f.machine), connect: vi.fn(async () => f.machine), list: vi.fn(async () => [{ id: "sandbox-test", status: "RUNNING", createdAt: "test-date" }]) };
  const client = createRailwayClient(credentials, sdk);
  await client.create({ fromCheckpoint: "base", cpu: 2, memoryMiB: 1024, idleTimeoutSec: 120, env: { TEST: "yes" }, region: "test-region" });
  expect(sdk.create).toHaveBeenCalledWith("base", expect.objectContaining({ token: credentials.token, environmentId: credentials.environmentId, authType: "bearer", resources: { cpu: 2, memoryGB: 1.073741824 }, idleTimeoutMinutes: 2, env: { TEST: "yes" }, region: "test-region", webSocketImpl: expect.any(Function) }));
  await client.create({});
  expect(sdk.create).toHaveBeenLastCalledWith(expect.objectContaining({ token: credentials.token, idleTimeoutMinutes: undefined }));
  await client.connect("sandbox-test");
  expect(sdk.connect).toHaveBeenCalledWith("sandbox-test", expect.objectContaining({ token: credentials.token, environmentId: credentials.environmentId }));
  expect(await client.list()).toEqual([{ id: "sandbox-test", status: "RUNNING", createdAt: "test-date" }]);
  expect(sdk.list).toHaveBeenCalledWith(expect.objectContaining({ token: credentials.token }));
});
it("recovers a suspension interrupted after destroy and treats missing removals as success", async () => {
  const f = fixture(); const data = new Map<string, unknown>();
  const store = { async get<T>(key: string) { return data.get(key) as T | undefined; }, async set(key: string, value: unknown) { data.set(key, value); } };
  const provider = createProvider(f.ops, f.resolve, store);
  class SandboxNotFoundError extends Error {}
  vi.mocked(f.client.connect).mockRejectedValue(new SandboxNotFoundError("already destroyed"));
  const context = { hostId: "test-host", resource: { id: "sandbox-test", checkpoint: "saved", key: "key" }, checkpoint: vi.fn(async () => {}), report: { step: vi.fn(), log: vi.fn() }, signal: new AbortController().signal };
  expect(await provider.suspend!(context)).toEqual({ resource: { id: null, checkpoint: "saved", key: "key" } });
  expect(await provider.remove(context)).toEqual({ status: "removed" });
  expect(f.machine.destroy).not.toHaveBeenCalled();
  f.resolve.mockRejectedValue(new Error(credentials.token));
  expect(await provider.availability!()).toEqual({ status: "unavailable", message: "Railway settings could not be resolved." });
});
