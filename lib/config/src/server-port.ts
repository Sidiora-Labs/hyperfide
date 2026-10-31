import { loadServerPortValue, type RuntimePortLoaderArgs } from "./ports.js";

export interface ServerPortConfig {
  HYPERFIDE_SERVER_PORT: number;
}

type LoadServerPortConfigArgs = RuntimePortLoaderArgs;

export function loadServerPortConfig(
  args: LoadServerPortConfigArgs = {},
): ServerPortConfig {
  return {
    HYPERFIDE_SERVER_PORT: loadServerPortValue(args),
  };
}
