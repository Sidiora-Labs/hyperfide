import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ServerCredentialStore, ServerLoginDecision, type CredentialEncryption } from "../src/server-credentials.js";
import { ServerAuthentication } from "../src/server-auth.js";
import { probeHyperfideServer } from "../src/server-probe.js";
import { loadRemoteServerPage } from "../src/remote-server-load.js";

const credentials = { username: "owner", password: "private-test-value" };
const origin = "https://server.example";
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function store(available = true) {
  const dir = await mkdtemp(join(tmpdir(), "hyperfide-auth-")); dirs.push(dir);
  const path = join(dir, "credentials.json");
  // The fake keychain keeps the plaintext out of the persistence layer.
  const values = new Map<string, string>();
  const encryption: CredentialEncryption = {
    isEncryptionAvailable: () => available,
    encryptString: vi.fn(value => { const key = `ciphertext-${values.size}`; values.set(key, value); return Buffer.from(key); }),
    decryptString: vi.fn(value => { const result = values.get(value.toString()); if (!result) throw Error("locked"); return result; }),
  };
  return { value: new ServerCredentialStore(path, encryption), path, encryption };
}
it("reports auth-required at either endpoint without exposing response content", async () => {
  for (const endpoint of ["health", "config"]) {
    const result = await probeHyperfideServer({ serverUrl: origin, timeoutMs: 100,
      fetchImpl: async url => url.endsWith("health") && endpoint === "config"
        ? Response.json({ ok: true }) : new Response(credentials.password, { status: 401 }) });
    expect(result.kind).toBe("auth-required");
    expect(JSON.stringify(result)).not.toContain(credentials.password);
  }
});
it("sends basic authorization to both probe endpoints", async () => {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${Buffer.from("owner:private-test-value").toString("base64")}`);
    return Response.json(url.endsWith("health") ? { ok: true } : { hostDaemonPort: 38887, voiceTranscriptionEnabled: false });
  });
  expect((await probeHyperfideServer({ credentials, serverUrl: origin, timeoutMs: 100, fetchImpl })).kind).toBe("compatible");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it("answers saved credentials once per origin, then prompts; cancel supplies no answer", async () => {
  const prompt = vi.fn(async () => null);
  const login = new ServerLoginDecision(() => credentials, prompt);
  expect(await login.answer(origin)).toEqual(credentials);
  expect(prompt).not.toHaveBeenCalled();
  expect(await login.answer(origin)).toBeNull();
  expect(prompt).toHaveBeenCalledWith(origin);
  expect(await login.answer("https://other.example")).toEqual(credentials);
});
it("prompts immediately without a saved credential", async () => {
  const prompt = vi.fn(async () => credentials);
  expect(await new ServerLoginDecision(() => undefined, prompt).answer(origin)).toEqual(credentials);
  expect(prompt).toHaveBeenCalledOnce();
});
it("round trips encrypted credentials by origin without plaintext", async () => {
  const { value, path, encryption } = await store();
  await value.set(`${origin}/app`, credentials, true);
  const disk = await readFile(path, "utf8");
  expect(disk).not.toContain(credentials.password);
  expect(disk).not.toContain(credentials.username);
  const restored = new ServerCredentialStore(path, encryption); await restored.load();
  expect(restored.get(`${origin}/health`)).toEqual(credentials);
  expect(restored.get("http://server.example")).toBeUndefined();
  await restored.set(origin, credentials, false);
  const forgotten = new ServerCredentialStore(path, encryption); await forgotten.load();
  expect(forgotten.get(origin)).toBeUndefined();
});
it("keeps credentials only in session when secure storage is unavailable", async () => {
  const { value, path, encryption } = await store(false);
  await value.set(origin, credentials, true);
  expect(value.get(origin)).toEqual(credentials);
  expect(encryption.encryptString).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).not.toContain(credentials.password);
  const restored = new ServerCredentialStore(path, encryption); await restored.load();
  expect(restored.get(origin)).toBeUndefined();
});
it("authenticates shell requests only for the matching origin and refuses redirects", async () => {
  const { value } = await store(); await value.set(origin, credentials, false);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
  const auth = new ServerAuthentication(value, async () => null);
  await auth.fetch(`${origin}/api/v1/system/config`);
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(true);
  expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  await auth.fetch("https://other.example/feed");
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has("Authorization")).toBe(false);
});
it("cancel aborts authenticated probing and page loading returns to the chooser", async () => {
  const { value } = await store();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
  const prompt = vi.fn(async () => null);
  expect((await new ServerAuthentication(value, prompt).probe({ serverUrl: origin, timeoutMs: 100 })).kind).toBe("auth-required");
  expect(fetch).toHaveBeenCalledOnce();
  const loadStartupError = vi.fn<Parameters<typeof loadRemoteServerPage>[0]["loadStartupError"]>(async () => {});
  expect(await loadRemoteServerPage({ serverUrl: origin, wasAuthCancelled: () => true, isCurrent: () => true,
    loadStartupError, loadUrl: async () => { throw Error("ERR_ABORTED (-3)"); }, logWarning: vi.fn() })).toBe(false);
  expect(loadStartupError.mock.calls[0]?.[0]).toMatchObject({ title: "This server asks for a username and password", actions: [{ id: "choose-server" }] });
});
it("retries rejected credentials before accepting a server and shares pending prompts", async () => {
  const { value } = await store();
  const correct = `Basic ${Buffer.from("owner:private-test-value").toString("base64")}`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (new Headers(init?.headers).get("Authorization") !== correct) return new Response(null, { status: 401 });
    return Response.json(String(input).endsWith("health") ? { ok: true } : { hostDaemonPort: 38887, voiceTranscriptionEnabled: false });
  });
  const prompt = vi.fn().mockResolvedValueOnce({ username: "owner", password: "incorrect", remember: false })
    .mockResolvedValueOnce({ ...credentials, remember: false });
  const auth = new ServerAuthentication(value, prompt);
  expect((await auth.probe({ serverUrl: origin, timeoutMs: 100 })).kind).toBe("compatible");
  expect(prompt).toHaveBeenCalledTimes(2);
  const feed = await auth.fetch(`${origin}/desktop-version.json`);
  expect(feed.status).toBe(200);
  let resolvePrompt!: (value: null) => void;
  const sharedPrompt = vi.fn(() => new Promise<null>(resolve => { resolvePrompt = resolve; }));
  const shared = new ServerAuthentication(value, sharedPrompt);
  const first = shared.request(origin);
  const second = shared.request(`${origin}/app`);
  expect(first).toBe(second);
  resolvePrompt(null);
  expect(await first).toBeNull();
  expect(sharedPrompt).toHaveBeenCalledOnce();
});
