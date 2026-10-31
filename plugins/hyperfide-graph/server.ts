import type {
  PluginHosts,
  PluginRpc,
  PluginStorage,
  PluginCli,
} from "@hyperfide/plugin-sdk";
import {
  graphHostContract,
  graphRpcContract,
  requestSchema,
  scopeSchema,
  settingsSchema,
  type GraphRequest,
} from "./contract.js";
import { graphCli } from "./cli.js";
interface GraphApi {
  hosts: PluginHosts;
  rpc: PluginRpc;
  storage: PluginStorage;
  cli: PluginCli;
}
export default function graphPlugin(api: GraphApi) {
  const host = api.hosts.experimental_client({ contract: graphHostContract });
  const key = (scope: { hostId: string; repository: string }) =>
    `repository:${JSON.stringify([scope.hostId, scope.repository])}`;
  async function settings(raw: unknown) {
    const scope = scopeSchema.parse(raw);
    return settingsSchema.parse(
      (await api.storage.kv.get(key(scope))) ?? { enabled: true },
    );
  }
  async function run(raw: GraphRequest) {
    const input = requestSchema.parse(raw);
    const config = await settings({
      hostId: input.hostId,
      repository: input.repository,
    });
    if (!config.enabled)
      throw new Error("Graph is disabled for this repository");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        host.call(
          "run",
          {
            ...input,
            ...(config.binaryPath ? { binaryPath: config.binaryPath } : {}),
            timeoutMs: 15000,
          },
          { hostId: input.hostId, signal: controller.signal },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Graph command timed out"));
          }, 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  api.rpc.register(graphRpcContract, {
    run,
    async languageServerStatus({ hostId, repository }) {
      const port = Number(process.env.HYPERFIDE_HOST_DAEMON_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return "stopped";
      const base = `http://127.0.0.1:${port}`;
      try {
        const signal = AbortSignal.timeout(3000);
        const identity = await fetch(`${base}/status`, { signal });
        if (!identity.ok || (await identity.json()).hostId !== hostId) return "stopped";
        const url = new URL("/language-server/status", base);
        url.searchParams.set("repository", repository);
        const response = await fetch(url, { signal });
        return response.ok && (await response.json()).status === "running"
          ? "running" : "stopped";
      } catch {
        return "stopped";
      }
    },
    getSettings: settings,
    async setSettings(input) {
      const config = settingsSchema.parse(input.settings);
      await api.storage.kv.set(key(input), config);
      return config;
    },
  });
  api.cli.register(graphCli(run));
}
