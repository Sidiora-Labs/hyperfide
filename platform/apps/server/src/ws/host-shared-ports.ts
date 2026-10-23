import {
  getNonDestroyedHost,
  getSessionById,
  type DbConnection,
} from "@hyperfide/db";
import {
  hostDaemonConnectNextConfigSchema,
  hostDaemonConnectNextStatusSchema,
  hostDaemonConnectTunnelIdentitySchema,
  type HostDaemonConnectNext,
  type HostDaemonConnectNextConfig,
  type HostDaemonConnectNextStatus,
  type HostDaemonConnectShares,
  type HostDaemonConnectTunnelIdentity,
} from "@hyperfide/host-daemon-contract";
import { ApiError } from "../errors.js";
import type { NotificationHub } from "./hub.js";

interface HostSharedPortCoordinatorDeps {
  db: DbConnection;
  hub: Pick<NotificationHub, "sendDaemonMessage">;
}

interface SharedPortDeclaration {
  ports: number[];
}

interface HostConnectCapability {
  hasMachineCredential: boolean;
  sessionId: string;
}

interface HostConnectCapabilityState {
  capability: HostConnectCapability;
  leaseExpiresAt: number;
  protocolVersion: number;
}

export interface HostNextTunnelStatus {
  hostId: string;
  hostName: string;
  status: HostDaemonConnectNextStatus;
}

interface NextTunnelOwnership {
  ownerId: string;
  config: HostDaemonConnectNextConfig;
}

function normalizePorts(ports: readonly number[]): number[] {
  const normalized = new Set<number>();
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `shared port ${String(port)} must be an integer between 1 and 65535`,
      );
    }
    normalized.add(port);
  }
  return [...normalized].sort((a, b) => a - b);
}

function fingerprint(shares: HostDaemonConnectShares): string {
  return JSON.stringify(shares.ports);
}

export class HostSharedPortCoordinator {
  private readonly declarationsByHost = new Map<
    string,
    Map<string, SharedPortDeclaration>
  >();
  private readonly generationByHost = new Map<string, number>();
  private readonly fingerprintByHost = new Map<string, string>();
  private readonly tunnelIdentityByHost = new Map<
    string,
    HostDaemonConnectTunnelIdentity
  >();
  private readonly tunnelIdentityPromiseByHost = new Map<
    string,
    Promise<HostDaemonConnectTunnelIdentity>
  >();
  private readonly connectCapabilityByHost = new Map<
    string,
    HostConnectCapability
  >();
  private nextTunnel: NextTunnelOwnership | null = null;
  private nextTunnelGeneration = 0;
  private readonly nextTunnelStatusByHost = new Map<
    string,
    { sessionId: string; status: HostDaemonConnectNextStatus }
  >();
  private readonly nextTunnelListeners = new Set<() => void>();

  constructor(private readonly deps: HostSharedPortCoordinatorDeps) {}

  async recordHostConnectCapability(args: {
    hostId: string;
    sessionId: string;
    hasMachineCredential: boolean;
  }): Promise<void> {
    await this.requireShareCapableHost(args.hostId);
    this.connectCapabilityByHost.set(args.hostId, {
      hasMachineCredential: args.hasMachineCredential,
      sessionId: args.sessionId,
    });
  }

  clearHostConnectCapability(sessionId: string): void {
    for (const [hostId, capability] of this.connectCapabilityByHost) {
      if (capability.sessionId === sessionId) {
        this.connectCapabilityByHost.delete(hostId);
      }
    }
    let changed = false;
    for (const [hostId, entry] of this.nextTunnelStatusByHost) {
      if (entry.sessionId === sessionId) {
        this.nextTunnelStatusByHost.delete(hostId);
        changed = true;
      }
    }
    if (changed) this.notifyNextTunnelListeners();
  }

  async setNextTunnelConfig(
    ownerId: string,
    config: HostDaemonConnectNextConfig | null,
  ): Promise<void> {
    if (ownerId.trim().length === 0) {
      throw new Error("connect next ownerId must be non-empty");
    }
    const current = this.nextTunnel;
    if (config === null) {
      if (current === null || current.ownerId !== ownerId) return;
      this.nextTunnel = null;
    } else {
      if (current !== null && current.ownerId !== ownerId) {
        throw new Error(
          `connect next machine tunnels are already configured by plugin "${current.ownerId}"`,
        );
      }
      const parsed = hostDaemonConnectNextConfigSchema.parse(config);
      if (
        current !== null &&
        JSON.stringify(current.config) === JSON.stringify(parsed)
      ) {
        return;
      }
      this.nextTunnel = { ownerId, config: parsed };
    }
    this.nextTunnelGeneration += 1;
    for (const hostId of this.connectCapabilityByHost.keys()) {
      await this.pushCurrentNextTunnelForHost(hostId);
    }
  }

  async reconcileNextTunnelForHost(
    hostId: string,
  ): Promise<HostDaemonConnectNext> {
    return {
      generation: this.nextTunnelGeneration,
      config: (await this.canReceiveSharedPorts(hostId))
        ? (this.nextTunnel?.config ?? null)
        : null,
    };
  }

  async hostSupportsNextTunnel(hostId: string): Promise<boolean> {
    return (await this.connectCapabilityState(hostId)) !== null;
  }

  async pushCurrentNextTunnelForHost(hostId: string): Promise<void> {
    if (!(await this.hostSupportsNextTunnel(hostId))) return;
    this.deps.hub.sendDaemonMessage(hostId, {
      type: "connect-next.replace",
      ...(await this.reconcileNextTunnelForHost(hostId)),
    });
  }

  recordNextTunnelStatus(args: {
    hostId: string;
    sessionId: string;
    status: HostDaemonConnectNextStatus;
  }): void {
    const capability = this.connectCapabilityByHost.get(args.hostId);
    if (capability?.sessionId !== args.sessionId) return;
    const status = hostDaemonConnectNextStatusSchema.parse(args.status);
    const previous = this.nextTunnelStatusByHost.get(args.hostId);
    if (
      previous?.sessionId === args.sessionId &&
      JSON.stringify(previous.status) === JSON.stringify(status)
    ) {
      return;
    }
    this.nextTunnelStatusByHost.set(args.hostId, {
      sessionId: args.sessionId,
      status,
    });
    this.notifyNextTunnelListeners();
  }

  async listNextTunnelStatuses(): Promise<HostNextTunnelStatus[]> {
    const statuses: HostNextTunnelStatus[] = [];
    for (const [hostId, entry] of this.nextTunnelStatusByHost) {
      const host = await getNonDestroyedHost(this.deps.db, hostId);
      if (!host) continue;
      statuses.push({ hostId, hostName: host.name, status: entry.status });
    }
    return statuses.sort(
      (a, b) =>
        a.hostName.localeCompare(b.hostName) ||
        a.hostId.localeCompare(b.hostId),
    );
  }

  onNextTunnelStatusChange(listener: () => void): () => void {
    this.nextTunnelListeners.add(listener);
    return () => {
      this.nextTunnelListeners.delete(listener);
    };
  }

  private notifyNextTunnelListeners(): void {
    for (const listener of [...this.nextTunnelListeners]) {
      try {
        listener();
      } catch {}
    }
  }

  async validateSharedPortDeclaration(
    hostId: string,
    ports: readonly number[],
  ): Promise<number[]> {
    if (hostId.trim().length === 0) {
      throw new Error("shared-port declaration hostId must be non-empty");
    }
    const normalized = normalizePorts(ports);
    if (normalized.length > 0) {
      const host = await this.requireDurablyEnrolledHost(hostId);
      const state = await this.connectCapabilityState(hostId);
      if (state !== null && !state.capability.hasMachineCredential) {
        this.throwMissingMachineCredential(host);
      }
    }
    return normalized;
  }

  async declareSharedPorts(args: {
    ownerId: string;
    hostId: string;
    ports: readonly number[];
  }): Promise<void> {
    if (args.ownerId.trim().length === 0) {
      throw new Error("shared-port declaration ownerId must be non-empty");
    }
    const ports = await this.validateSharedPortDeclaration(
      args.hostId,
      args.ports,
    );
    const current = this.declarationsByHost.get(args.hostId);
    const candidate = new Map(current ?? []);
    candidate.set(args.ownerId, { ports });
    this.declarationsByHost.set(args.hostId, candidate);
    await this.publishIfChanged(args.hostId);
  }

  async replaceDeclarationsForOwner(
    ownerId: string,
    declarations: readonly {
      hostId: string;
      ports: readonly number[];
    }[],
  ): Promise<void> {
    if (ownerId.trim().length === 0) {
      throw new Error("shared-port declaration ownerId must be non-empty");
    }

    const normalizedByHost = new Map<string, number[]>();
    for (const declaration of declarations) {
      const ports = await this.validateSharedPortDeclaration(
        declaration.hostId,
        declaration.ports,
      );
      normalizedByHost.set(declaration.hostId, ports);
    }

    const affectedHostIds = new Set(normalizedByHost.keys());
    for (const [hostId, current] of this.declarationsByHost) {
      if (current.has(ownerId)) affectedHostIds.add(hostId);
    }

    const replacements = new Map<string, Map<string, SharedPortDeclaration>>();
    for (const hostId of affectedHostIds) {
      const replacement = new Map(this.declarationsByHost.get(hostId) ?? []);
      const ports = normalizedByHost.get(hostId);
      if (ports === undefined) replacement.delete(ownerId);
      else replacement.set(ownerId, { ports });
      replacements.set(hostId, replacement);
    }

    for (const [hostId, replacement] of replacements) {
      if (replacement.size === 0) this.declarationsByHost.delete(hostId);
      else this.declarationsByHost.set(hostId, replacement);
    }
    for (const hostId of affectedHostIds) await this.publishIfChanged(hostId);
  }

  async clearDeclarationsForOwner(ownerId: string): Promise<void> {
    await this.setNextTunnelConfig(ownerId, null);
    for (const [hostId, declarations] of this.declarationsByHost) {
      if (!declarations.delete(ownerId)) {
        continue;
      }
      if (declarations.size === 0) {
        this.declarationsByHost.delete(hostId);
      }
      await this.publishIfChanged(hostId);
    }
  }

  async recordTunnelIdentity(
    hostId: string,
    identity: HostDaemonConnectTunnelIdentity,
  ): Promise<HostDaemonConnectTunnelIdentity> {
    await this.requireConnectedEnrolledHost(hostId);
    const parsed = hostDaemonConnectTunnelIdentitySchema.parse(identity);
    this.tunnelIdentityByHost.set(hostId, parsed);
    return parsed;
  }

  async getTunnelIdentity(
    hostId: string,
  ): Promise<HostDaemonConnectTunnelIdentity | null> {
    await this.requireConnectedEnrolledHost(hostId);
    return this.tunnelIdentityByHost.get(hostId) ?? null;
  }

  async ensureTunnelIdentity(
    hostId: string,
    ensure: () => Promise<HostDaemonConnectTunnelIdentity>,
  ): Promise<HostDaemonConnectTunnelIdentity> {
    const current = await this.getTunnelIdentity(hostId);
    if (current !== null) {
      return Promise.resolve(current);
    }
    const existing = this.tunnelIdentityPromiseByHost.get(hostId);
    if (existing) {
      return existing;
    }
    let pending: Promise<HostDaemonConnectTunnelIdentity>;
    pending = ensure()
      .then(
        async (identity) => await this.recordTunnelIdentity(hostId, identity),
      )
      .finally(() => {
        if (this.tunnelIdentityPromiseByHost.get(hostId) === pending) {
          this.tunnelIdentityPromiseByHost.delete(hostId);
        }
      });
    this.tunnelIdentityPromiseByHost.set(hostId, pending);
    return pending;
  }

  async reconcileSharedPortsForHost(
    hostId: string,
  ): Promise<HostDaemonConnectShares> {
    const generation = this.generationByHost.get(hostId) ?? 0;
    if (!(await this.canReceiveSharedPorts(hostId))) {
      return { generation, ports: [] };
    }
    return this.resolveDeclarations(
      this.declarationsByHost.get(hostId) ?? new Map(),
      generation,
    );
  }

  async pushCurrentSharedPortsForHost(
    hostId: string,
  ): Promise<HostDaemonConnectShares> {
    const shares = await this.reconcileSharedPortsForHost(hostId);
    this.deps.hub.sendDaemonMessage(hostId, {
      type: "connect-shares.replace",
      ...shares,
    });
    return shares;
  }

  private async requireShareCapableHost(hostId: string) {
    if (hostId.trim().length === 0) {
      throw new Error("shared-port declaration hostId must be non-empty");
    }
    const host = await getNonDestroyedHost(this.deps.db, hostId);
    if (!host) {
      throw new Error(`cannot declare shared ports for unknown host ${hostId}`);
    }
    return host;
  }

  private async requireDurablyEnrolledHost(hostId: string) {
    const host = await this.requireShareCapableHost(hostId);
    if (host.connectMachineId === null) {
      throw new ApiError(
        409,
        "connect_host_unenrolled",
        `cannot share ports from host "${host.name}" (${host.id}) because it has no bb connect machine credential; enroll it via Connect in Settings > Machines`,
        false,
      );
    }
    return host;
  }

  private async connectCapabilityState(
    hostId: string,
  ): Promise<HostConnectCapabilityState | null> {
    const capability = this.connectCapabilityByHost.get(hostId);
    const session = capability
      ? await getSessionById(this.deps.db, { sessionId: capability.sessionId })
      : null;
    if (
      capability === undefined ||
      session?.hostId !== hostId ||
      session.status !== "active"
    ) {
      return null;
    }
    return {
      capability,
      leaseExpiresAt: session.leaseExpiresAt,
      protocolVersion: session.protocolVersion,
    };
  }

  private async canReceiveSharedPorts(hostId: string): Promise<boolean> {
    const host = await getNonDestroyedHost(this.deps.db, hostId);
    if (!host || host.connectMachineId === null) return false;
    return (
      (await this.connectCapabilityState(hostId))?.capability
        .hasMachineCredential === true
    );
  }

  private async requireConnectedEnrolledHost(hostId: string) {
    const host = await this.requireDurablyEnrolledHost(hostId);
    const state = await this.connectCapabilityState(hostId);
    if (state === null || state.leaseExpiresAt <= Date.now()) {
      throw new ApiError(
        503,
        "connect_host_offline",
        `cannot share ports from host "${host.name}" (${host.id}) because it is not connected right now; bring the host online and try again`,
        true,
      );
    }
    if (!state.capability.hasMachineCredential) {
      this.throwMissingMachineCredential(host);
    }
    return host;
  }

  private throwMissingMachineCredential(host: {
    id: string;
    name: string;
  }): never {
    throw new ApiError(
      409,
      "connect_host_unenrolled",
      `cannot share ports from host "${host.name}" (${host.id}) because it has no bb connect machine credential; enroll it via Connect in Settings > Machines`,
      false,
    );
  }

  private async publishIfChanged(hostId: string): Promise<void> {
    const currentGeneration = this.generationByHost.get(hostId) ?? 0;
    const nextGeneration = currentGeneration + 1;
    const shares = this.resolveDeclarations(
      this.declarationsByHost.get(hostId) ?? new Map(),
      nextGeneration,
    );
    const nextFingerprint = fingerprint(shares);
    const previousFingerprint =
      this.fingerprintByHost.get(hostId) ??
      fingerprint({ generation: currentGeneration, ports: [] });
    if (nextFingerprint === previousFingerprint) {
      return;
    }

    this.fingerprintByHost.set(hostId, nextFingerprint);
    this.generationByHost.set(hostId, nextGeneration);
    if (await this.canReceiveSharedPorts(hostId)) {
      this.deps.hub.sendDaemonMessage(hostId, {
        type: "connect-shares.replace",
        ...shares,
      });
    }
  }

  private resolveDeclarations(
    declarations: ReadonlyMap<string, SharedPortDeclaration>,
    generation: number,
  ): HostDaemonConnectShares {
    const ports = new Set<number>();
    for (const declaration of declarations.values()) {
      for (const port of declaration.ports) {
        ports.add(port);
      }
    }
    return {
      generation,
      ports: [...ports].sort((a, b) => a - b),
    };
  }
}
