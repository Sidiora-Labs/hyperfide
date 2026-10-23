import { resolveEnvLoader, type EnvLoaderArgs } from "./env.js";
import { loadHostDaemonPortValue } from "./ports.js";
import {
  HYPERFIDE_LOOPBACK_HOST,
  HYPERFIDE_PROD_HOST_DAEMON_PORT,
  HYPERFIDE_PROD_SERVER_PORT,
} from "./runtime.js";
import { loadServerUrlValue } from "./server-url.js";

export interface CliConfig {
  HYPERFIDE_HOST_DAEMON_PORT: number;
  HYPERFIDE_SERVER_URL: string;
}

interface LoadCliConfigArgs extends EnvLoaderArgs {
  repoRoot?: string;
}

const DEFAULT_CLI_SERVER_URL = `http://${HYPERFIDE_LOOPBACK_HOST}:${HYPERFIDE_PROD_SERVER_PORT}`;

function hasConfiguredValue(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] !== undefined;
}

export function loadCliConfig(args: LoadCliConfigArgs = {}): CliConfig {
  const loader = resolveEnvLoader(args);
  const useDevDefaults = loader.mode === "dev" && args.repoRoot !== undefined;
  const serverUrl =
    hasConfiguredValue(loader.env, "HYPERFIDE_SERVER_URL") || useDevDefaults
      ? loadServerUrlValue({
          ...args,
          env: loader.env,
          homeDir: loader.context.homeDir,
          mode: loader.mode,
        })
      : loadServerUrlValue({
          ...args,
          env: loader.env,
          homeDir: loader.context.homeDir,
          mode: loader.mode,
          serverUrl: DEFAULT_CLI_SERVER_URL,
        });

  return {
    HYPERFIDE_HOST_DAEMON_PORT:
      hasConfiguredValue(loader.env, "HYPERFIDE_HOST_DAEMON_PORT") ||
      useDevDefaults
        ? loadHostDaemonPortValue({
            ...args,
            env: loader.env,
            homeDir: loader.context.homeDir,
            mode: loader.mode,
          })
        : HYPERFIDE_PROD_HOST_DAEMON_PORT,
    HYPERFIDE_SERVER_URL: serverUrl,
  };
}
