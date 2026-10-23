import type { HyperfideStatus } from "@hyperfide/host-daemon-contract";

// Scope observations to the server instance so independent servers cannot share host state.
const observations = new WeakMap<object, Map<string, HyperfideStatus>>();
export function recordHyperfideStatus(owner: object, hostId: string, status: HyperfideStatus): void {
  let hosts = observations.get(owner);
  if (!hosts) observations.set(owner, hosts = new Map());
  hosts.set(hostId, structuredClone(status));
}
export function getHyperfideStatus(owner: object, hostId: string): HyperfideStatus | null {
  return observations.get(owner)?.get(hostId) ?? null;
}
