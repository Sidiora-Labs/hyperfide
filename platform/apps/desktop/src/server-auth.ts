import { basicAuthorization, type ServerCredentialStore, type ServerCredentials } from "./server-credentials.js";
import { probeHyperfideServer, type ServerProbeResult } from "./server-probe.js";

export class ServerAuthentication {
  private readonly pending = new Map<string, Promise<ServerCredentials | null>>();
  constructor(private readonly store: ServerCredentialStore,
    private readonly prompt: (origin: string) => Promise<(ServerCredentials & { remember: boolean }) | null>) {}
  request(url: string): Promise<ServerCredentials | null> {
    const origin = new URL(url).origin;
    const pending = this.pending.get(origin);
    if (pending) return pending;
    const result = (async () => {
      const value = await this.prompt(origin);
      if (value) await this.store.set(origin, value, value.remember);
      return value;
    })().finally(() => this.pending.delete(origin));
    this.pending.set(origin, result);
    return result;
  }
  readonly fetch: typeof fetch = (input, init) => this.fetchUsing(globalThis.fetch, input, init);
  async fetchUsing(transport: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    const credentials = this.store.get(url);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (credentials) headers.set("Authorization", basicAuthorization(credentials));
    // Never forward a credential to a redirect destination, including another origin.
    try {
      return await transport(input, { ...init, headers, ...(credentials ? { redirect: "error" as const } : {}) });
    } catch {
      throw new Error("Server request failed");
    }
  }
  async probe(args: { serverUrl: string; timeoutMs: number }): Promise<ServerProbeResult> {
    let result = await probeHyperfideServer({ ...args, fetchImpl: this.fetch });
    while (result.kind === "auth-required") {
      if (!(await this.request(args.serverUrl))) return result;
      result = await probeHyperfideServer({ ...args, fetchImpl: this.fetch });
    }
    return result;
  }
}
