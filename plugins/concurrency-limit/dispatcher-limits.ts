import { resolveHostLimit, type LimitConfiguration } from "./limits";
/** Snapshot consumed by dispatchers together with their own in-flight count. */
export function dispatcherLimits(
  configuration: LimitConfiguration,
  hostId: string,
  parallelism: number | null,
  otherRunning: number,
) {
  return {
    global: configuration.globalLimit ?? Number.MAX_SAFE_INTEGER,
    host: resolveHostLimit(configuration, hostId, parallelism).limit,
    otherRunning,
  };
}
