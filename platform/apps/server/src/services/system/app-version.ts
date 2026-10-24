import type { AppInstallKind } from "@hyperfide/config/app-install";
import semver from "semver";
import type { SystemVersionResponse } from "@hyperfide/server-contract";
import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";

const NEGATIVE_TTL_MS = 10 * 60_000;
const CACHE_TTL_MS = 60 * 60_000;
const TIMEOUT_MS = 5_000;

export interface AppVersionService {
  getSystemVersion(args?: {
    forceRefresh?: boolean;
  }): Promise<SystemVersionResponse>;
}

interface CreateAppVersionServiceArgs {
  installKind: AppInstallKind | null;
  sourceCommit: string | null;
  config: Pick<
    ServerRuntimeConfig,
    "appVersion" | "isDevelopment" | "updateChannel"
  >;
  fetchImpl?: typeof fetch;
  logger: ServerLogger;
  cacheTtlMs?: number;
  now?: () => number;
}

export function createAppVersionService(
  args: CreateAppVersionServiceArgs,
): AppVersionService {
  const now = args.now ?? Date.now;
  const channel = args.config.updateChannel;
  let cache: { version: string | null; cachedAt: number } | null = null;
  let inflight = false;

  async function refresh(): Promise<void> {
    if (channel === undefined || inflight) return;
    inflight = true;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race as well as abort: injected transports may ignore AbortSignal.
      const result = await Promise.race([
        (async () => {
          const response = await (args.fetchImpl ?? fetch)(channel.url, {
            headers: { accept: "application/json" },
            signal: controller.signal,
          });
          if (!response.ok)
            throw new Error(`Update channel returned ${response.status}`);
          const body: unknown = await response.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("version" in body) ||
            typeof body.version !== "string" ||
            semver.valid(body.version) === null
          ) {
            throw new Error("Update channel returned an invalid version");
          }
          return body.version;
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Update channel timed out"));
          }, TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
      cache = { version: result, cachedAt: now() };
    } catch (error) {
      cache = { version: null, cachedAt: now() };
      args.logger.warn({ error }, "Update channel lookup failed");
    } finally {
      clearTimeout(timeout);
      inflight = false;
    }
  }

  return {
    async getSystemVersion(options = {}): Promise<SystemVersionResponse> {
      const enabled =
        channel !== undefined &&
        !args.config.isDevelopment &&
        args.installKind !== "source";
      if (
        enabled &&
        !inflight &&
        (cache === null ||
          now() - cache.cachedAt >=
            (cache.version === null
              ? NEGATIVE_TTL_MS
              : (args.cacheTtlMs ?? CACHE_TTL_MS)) ||
          (options.forceRefresh === true && cache.version !== null))
      ) {
        void refresh();
      }
      const latestVersion = enabled ? (cache?.version ?? null) : null;
      return {
        currentCommit: args.installKind === "source" ? args.sourceCommit : null,
        installKind: args.installKind,
        currentVersion: args.config.appVersion,
        latestVersion,
        source: args.installKind,
        updateAvailable:
          latestVersion !== null &&
          semver.valid(args.config.appVersion) !== null &&
          semver.gt(latestVersion, args.config.appVersion),
        isDevelopment: args.config.isDevelopment,
        upgradeCommand: enabled ? (channel?.upgradeCommand ?? null) : null,
      };
    },
  };
}
