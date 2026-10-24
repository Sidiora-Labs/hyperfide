import {
  heartbeatSession,
  noopNotifier,
  openSession,
  updateHost,
  upsertHost,
} from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";
import {
  HOST_DAEMON_COMPATIBLE_PROTOCOL_VERSIONS,
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonServerWsMessageSchema,
  hostDaemonSessionOpenResponseSchema,
} from "@hyperfide/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { HostSharedPortCoordinator } from "../../src/ws/host-shared-ports.js";
import { NotificationHub } from "../../src/ws/hub.js";
import {
  onDaemonSocketMessage,
  onDaemonSocketOpen,
} from "../../src/ws/daemon-protocol.js";
import { readJson } from "../helpers/json.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import {
  createTestDaemonHostKey,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

async function setup(args: { enrolled?: boolean; online?: boolean } = {}) {
  const db = await createMigratedConnection();
  const hub = await new NotificationHub();
  const sharedPorts = await new HostSharedPortCoordinator({ db, hub });
  const host = await upsertHost(db, noopNotifier, {
    id: "host-1",
    name: "test-host",
    ...(args.enrolled === false ? {} : { connectMachineId: "machine-1" }),
  });
  if (args.enrolled !== false && args.online !== false) {
    const session = await openSession(db, {
      hostId: host.id,
      instanceId: "instance-1",
      hostName: host.name,
      dataDir: "/tmp/host-data",
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      heartbeatIntervalMs: 30_000,
      leaseTimeoutMs: 90_000,
    });
    await sharedPorts.recordHostConnectCapability({
      hostId: host.id,
      sessionId: session.id,
      hasMachineCredential: true,
    });
    return { db, host, hub, session, sharedPorts };
  }
  return { db, host, hub, session: null, sharedPorts };
}

describe("HostSharedPortCoordinator", () => {
  it("aggregates owner replacements and pushes only changed desired sets", async () => {
    const { host, hub, session, sharedPorts } = await setup();
    const daemonSocket = createMockHubSocket();
    if (!session) {
      throw new Error("expected an enrolled setup session");
    }
    await hub.registerDaemon(session.id, host.id, daemonSocket);

    expect(await sharedPorts.reconcileSharedPortsForHost(host.id)).toEqual({
      generation: 0,
      ports: [],
    });

    await sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [8080, 3000, 8080],
    });
    const first = await sharedPorts.reconcileSharedPortsForHost(host.id);
    expect(first).toEqual({ generation: 1, ports: [3000, 8080] });
    expect(
      hostDaemonServerWsMessageSchema.parse(
        JSON.parse(daemonSocket.messages[0]!),
      ),
    ).toEqual({ type: "connect-shares.replace", ...first });

    await sharedPorts.declareSharedPorts({
      ownerId: "other-plugin",
      hostId: host.id,
      ports: [4173],
    });
    await sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [8080],
    });
    const replacement = await sharedPorts.reconcileSharedPortsForHost(host.id);
    expect(replacement).toEqual({ generation: 3, ports: [4173, 8080] });

    await sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [8080],
    });
    expect(await sharedPorts.reconcileSharedPortsForHost(host.id)).toEqual(
      replacement,
    );
    expect(daemonSocket.messages).toHaveLength(3);

    await sharedPorts.clearDeclarationsForOwner("connect");
    expect(await sharedPorts.reconcileSharedPortsForHost(host.id)).toEqual({
      generation: 4,
      ports: [4173],
    });
  });

  it("replaces one owner's complete declaration set only after validation", async () => {
    const { host, sharedPorts } = await setup();
    await sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [3000],
    });

    await expect(
      (async () =>
        await sharedPorts.replaceDeclarationsForOwner("connect", [
          { hostId: host.id, ports: [4173] },
          { hostId: "missing-host", ports: [8080] },
        ]))(),
    ).rejects.toThrow(/unknown host missing-host/);
    expect(
      (await sharedPorts.reconcileSharedPortsForHost(host.id)).ports,
    ).toEqual([3000]);

    await sharedPorts.replaceDeclarationsForOwner("connect", [
      { hostId: host.id, ports: [4173] },
    ]);
    expect(
      (await sharedPorts.reconcileSharedPortsForHost(host.id)).ports,
    ).toEqual([4173]);
  });

  it("delivers changed ports over a registered credentialed socket after its lease stales", async () => {
    const { db, host, hub, session, sharedPorts } = await setup();
    if (!session) throw new Error("expected an online host session");
    const daemonSocket = createMockHubSocket();
    await hub.registerDaemon(session.id, host.id, daemonSocket);

    await sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [3000],
    });
    await heartbeatSession(db, session.id, Date.now() - 1);
    await sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [],
    });

    expect(daemonSocket.messages.map((message) => JSON.parse(message))).toEqual(
      [
        {
          type: "connect-shares.replace",
          generation: 1,
          ports: [3000],
        },
        {
          type: "connect-shares.replace",
          generation: 2,
          ports: [],
        },
      ],
    );
  });

  it("rejects a registered credentialless session after its lease stales", async () => {
    const { db, host, hub, session, sharedPorts } = await setup();
    if (!session) throw new Error("expected an online host session");
    await hub.registerDaemon(session.id, host.id, createMockHubSocket());
    await sharedPorts.recordHostConnectCapability({
      hostId: host.id,
      sessionId: session.id,
      hasMachineCredential: false,
    });
    await heartbeatSession(db, session.id, Date.now() - 1);

    let declarationError: unknown;
    try {
      await sharedPorts.declareSharedPorts({
        ownerId: "connect",
        hostId: host.id,
        ports: [3000],
      });
    } catch (error) {
      declarationError = error;
    }

    expect(declarationError).toBeInstanceOf(ApiError);
    expect(declarationError).toMatchObject({
      body: { code: "connect_host_unenrolled" },
    });
    expect(await sharedPorts.reconcileSharedPortsForHost(host.id)).toEqual({
      generation: 0,
      ports: [],
    });
  });

  it("retains changed generations through a full disconnect and reconnect", async () => {
    const { db, host, hub, session, sharedPorts } = await setup();
    if (!session) throw new Error("expected an online host session");
    const firstSocket = createMockHubSocket();
    await hub.registerDaemon(session.id, host.id, firstSocket);
    await sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [3000],
    });

    hub.unregisterDaemon(session.id);
    sharedPorts.clearHostConnectCapability(session.id);
    await sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: host.id,
      ports: [4173],
    });
    expect(firstSocket.messages.map((message) => JSON.parse(message))).toEqual([
      {
        type: "connect-shares.replace",
        generation: 1,
        ports: [3000],
      },
    ]);

    const reconnected = await openSession(db, {
      hostId: host.id,
      instanceId: "reconnected-instance",
      hostName: host.name,
      dataDir: "/tmp/host-data",
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      heartbeatIntervalMs: 30_000,
      leaseTimeoutMs: 90_000,
    });
    await sharedPorts.recordHostConnectCapability({
      hostId: host.id,
      sessionId: reconnected.id,
      hasMachineCredential: true,
    });
    const secondSocket = createMockHubSocket();
    await hub.registerDaemon(reconnected.id, host.id, secondSocket);

    expect(await sharedPorts.pushCurrentSharedPortsForHost(host.id)).toEqual({
      generation: 2,
      ports: [4173],
    });
    expect(secondSocket.messages.map((message) => JSON.parse(message))).toEqual(
      [
        {
          type: "connect-shares.replace",
          generation: 2,
          ports: [4173],
        },
      ],
    );
  });

  it("retains declarations for offline enrolled hosts and delivers them on reconnect", async () => {
    const { sharedPorts } = await setup();
    await expect(
      (async () =>
        await sharedPorts.declareSharedPorts({
          ownerId: "connect",
          hostId: "missing-host",
          ports: [3000],
        }))(),
    ).rejects.toThrow(/unknown host missing-host/);

    const credentialless = await setup({ enrolled: false });
    let unenrolledError: unknown;
    try {
      await credentialless.sharedPorts.declareSharedPorts({
        ownerId: "connect",
        hostId: credentialless.host.id,
        ports: [3000],
      });
    } catch (error) {
      unenrolledError = error;
    }
    expect(unenrolledError).toBeInstanceOf(ApiError);
    expect(unenrolledError).toMatchObject({
      body: {
        code: "connect_host_unenrolled",
        message: expect.stringContaining("enroll it via Connect"),
      },
    });

    const offline = await setup({ online: false });
    await expect(
      (async () =>
        await offline.sharedPorts.declareSharedPorts({
          ownerId: "connect",
          hostId: offline.host.id,
          ports: [3000],
        }))(),
    ).resolves.not.toThrow();

    const session = await openSession(offline.db, {
      hostId: offline.host.id,
      instanceId: "reconnected-instance",
      hostName: offline.host.name,
      dataDir: "/tmp/host-data",
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      heartbeatIntervalMs: 30_000,
      leaseTimeoutMs: 90_000,
    });
    await offline.sharedPorts.recordHostConnectCapability({
      hostId: offline.host.id,
      sessionId: session.id,
      hasMachineCredential: true,
    });
    const daemonSocket = createMockHubSocket();
    await offline.hub.registerDaemon(session.id, offline.host.id, daemonSocket);

    expect(
      await offline.sharedPorts.pushCurrentSharedPortsForHost(offline.host.id),
    ).toEqual({ generation: 1, ports: [3000] });
    expect(daemonSocket.messages.map((message) => JSON.parse(message))).toEqual(
      [
        {
          type: "connect-shares.replace",
          generation: 1,
          ports: [3000],
        },
      ],
    );
  });

  it("always accepts empty declarations for offline, unenrolled, and removed hosts", async () => {
    const offline = await setup();
    if (!offline.session) throw new Error("expected an online host session");
    await offline.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: offline.host.id,
      ports: [3000],
    });
    offline.sharedPorts.clearHostConnectCapability(offline.session.id);
    await offline.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: offline.host.id,
      ports: [],
    });
    expect(
      await offline.sharedPorts.reconcileSharedPortsForHost(offline.host.id),
    ).toEqual({ generation: 2, ports: [] });

    const unenrolled = await setup({ enrolled: false });
    await unenrolled.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: unenrolled.host.id,
      ports: [],
    });
    expect(
      await unenrolled.sharedPorts.reconcileSharedPortsForHost(
        unenrolled.host.id,
      ),
    ).toEqual({ generation: 0, ports: [] });

    const removed = await setup();
    await removed.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: removed.host.id,
      ports: [4000],
    });
    await updateHost(removed.db, noopNotifier, removed.host.id, {
      destroyedAt: Date.now(),
    });
    await removed.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: removed.host.id,
      ports: [],
    });
    expect(
      await removed.sharedPorts.reconcileSharedPortsForHost(removed.host.id),
    ).toEqual({ generation: 2, ports: [] });

    await removed.sharedPorts.declareSharedPorts({
      ownerId: "connect",
      hostId: "missing-host",
      ports: [],
    });
    expect(
      await removed.sharedPorts.reconcileSharedPortsForHost("missing-host"),
    ).toEqual({ generation: 0, ports: [] });
  });

  it("stores only daemon-reported tunnel identity", async () => {
    const { host, sharedPorts } = await setup();
    expect(await sharedPorts.getTunnelIdentity(host.id)).toBeNull();
    expect(
      await sharedPorts.recordTunnelIdentity(host.id, {
        label: "sawyer-air",
        baseDomain: "hyperfide.example",
      }),
    ).toEqual({ label: "sawyer-air", baseDomain: "hyperfide.example" });
    expect(await sharedPorts.getTunnelIdentity(host.id)).toEqual({
      label: "sawyer-air",
      baseDomain: "hyperfide.example",
    });
  });
});

describe("daemon session connect shares", () => {
  it("includes the current authoritative set in the session-open response", async () => {
    await withTestHarness(async (harness) => {
      await upsertHost(harness.db, harness.hub, {
        id: "host-1",
        name: "Host",
        connectMachineId: "machine-1",
      });
      const previousSession = await openSession(harness.db, {
        hostId: "host-1",
        instanceId: "previous-instance",
        hostName: "Host",
        dataDir: "/tmp/host-data",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        heartbeatIntervalMs: 30_000,
        leaseTimeoutMs: 90_000,
      });
      await harness.deps.sharedPorts.recordHostConnectCapability({
        hostId: "host-1",
        sessionId: previousSession.id,
        hasMachineCredential: true,
      });
      await harness.deps.sharedPorts.declareSharedPorts({
        ownerId: "connect",
        hostId: "host-1",
        ports: [4173],
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: {
          authorization: `Bearer ${createTestDaemonHostKey({ hostId: "host-1" })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host-1",
          instanceId: "instance-1",
          hostName: "Host",
          hasMachineCredential: true,
          platform: "darwin",
          dataDir: "/tmp/host-data",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      await expect(readJson(response)).resolves.toMatchObject({
        connectShares: { generation: 1, ports: [4173] },
      });
    });
  });

  it("reconciles a declaration made after HTTP open but before WebSocket registration", async () => {
    await withTestHarness(async (harness) => {
      await upsertHost(harness.db, harness.hub, {
        id: "host-1",
        name: "Host",
        connectMachineId: "machine-1",
      });
      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: {
          authorization: `Bearer ${createTestDaemonHostKey({ hostId: "host-1" })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host-1",
          instanceId: "instance-1",
          hostName: "Host",
          hasMachineCredential: true,
          platform: "darwin",
          dataDir: "/tmp/host-data",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });
      const session = hostDaemonSessionOpenResponseSchema.parse(
        await response.json(),
      );
      expect(session.connectShares).toEqual({ generation: 0, ports: [] });

      await harness.deps.sharedPorts.declareSharedPorts({
        ownerId: "connect",
        hostId: "host-1",
        ports: [4173],
      });
      const daemonSocket = createMockHubSocket();
      await onDaemonSocketOpen(harness.deps, {
        hostId: "host-1",
        sessionId: session.sessionId,
        socket: daemonSocket,
      });

      expect(
        daemonSocket.messages.map((message) => JSON.parse(message)),
      ).toContainEqual({
        type: "connect-shares.replace",
        generation: 1,
        ports: [4173],
      });

      await onDaemonSocketMessage(harness.deps, {
        hostId: "host-1",
        sessionId: session.sessionId,
        socket: daemonSocket,
        raw: JSON.stringify({
          type: "connect-tunnel.identity",
          identity: { label: "sawyer-air", baseDomain: "hyperfide.example" },
        }),
      });
      expect(
        await harness.deps.sharedPorts.getTunnelIdentity("host-1"),
      ).toEqual({
        label: "sawyer-air",
        baseDomain: "hyperfide.example",
      });
    });
  });

  it("rejects declarations while the current session lacks its machine credential", async () => {
    await withTestHarness(async (harness) => {
      await upsertHost(harness.db, harness.hub, {
        id: "host-1",
        name: "Host",
        connectMachineId: "machine-1",
      });
      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: {
          authorization: `Bearer ${createTestDaemonHostKey({ hostId: "host-1" })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "host-1",
          instanceId: "restarted-without-credential",
          hostName: "Host",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-data",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });
      expect(response.status).toBe(201);
      const session = hostDaemonSessionOpenResponseSchema.parse(
        await response.json(),
      );
      const daemonSocket = createMockHubSocket();
      await onDaemonSocketOpen(harness.deps, {
        hostId: "host-1",
        sessionId: session.sessionId,
        socket: daemonSocket,
      });
      const messagesBeforeDeclaration = [...daemonSocket.messages];

      await expect(
        (async () =>
          await harness.deps.sharedPorts.declareSharedPorts({
            ownerId: "connect",
            hostId: "host-1",
            ports: [4173],
          }))(),
      ).rejects.toThrow(
        'cannot share ports from host "Host" (host-1) because it has no hyperfide-platform connect machine credential; enroll it via Connect in Settings > Machines',
      );
      expect(daemonSocket.messages).toEqual(messagesBeforeDeclaration);
      expect(
        await harness.deps.sharedPorts.reconcileSharedPortsForHost("host-1"),
      ).toEqual({ generation: 0, ports: [] });
    });
  });
});

const NEXT_CONFIG = {
  domain: "next.hyperfide.example",
  server: {
    protocol: "wss" as const,
    host: "tunnel.next.hyperfide.example",
    port: 443,
  },
};

function openDaemonSession(harness: TestAppHarness, protocolVersion: number) {
  return harness.app.request("/internal/session/open", {
    method: "POST",
    headers: {
      authorization: `Bearer ${createTestDaemonHostKey({ hostId: "host-1" })}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      hostId: "host-1",
      instanceId: `instance-${protocolVersion}`,
      hostName: "Host",
      hasMachineCredential: true,
      platform: "linux",
      dataDir: "/tmp/host-data",
      localApiPort: null,
      protocolVersion,
      activeThreads: [],
    }),
  });
}

describe("connect next machine tunnels", () => {
  it("sends the config to enrolled hosts, owned by one plugin and cleared with it", async () => {
    const { host, hub, session, sharedPorts } = await setup();
    if (!session) throw new Error("expected a session");
    const daemonSocket = createMockHubSocket();
    await hub.registerDaemon(session.id, host.id, daemonSocket);
    const sent = () =>
      daemonSocket.messages
        .map((message) =>
          hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
        )
        .filter((message) => message.type === "connect-next.replace");

    await sharedPorts.setNextTunnelConfig("hyperfide--connect-next", NEXT_CONFIG);
    expect(sent()).toEqual([
      { type: "connect-next.replace", generation: 1, config: NEXT_CONFIG },
    ]);
    await sharedPorts.setNextTunnelConfig("hyperfide--connect-next", NEXT_CONFIG);
    expect(sent()).toHaveLength(1);
    await expect(
      (async () =>
        await sharedPorts.setNextTunnelConfig("other-plugin", NEXT_CONFIG))(),
    ).rejects.toThrow('already configured by plugin "hyperfide--connect-next"');
    await sharedPorts.setNextTunnelConfig("other-plugin", null);
    expect(sent()).toHaveLength(1);

    await sharedPorts.clearDeclarationsForOwner("hyperfide--connect-next");
    expect(sent().at(-1)).toEqual({
      type: "connect-next.replace",
      generation: 2,
      config: null,
    });
    await sharedPorts.setNextTunnelConfig("other-plugin", NEXT_CONFIG);
    expect(sent().at(-1)?.generation).toBe(3);
  });

  it("gives an unenrolled host no config", async () => {
    const { host, sharedPorts } = await setup({ enrolled: false });
    await sharedPorts.setNextTunnelConfig("hyperfide--connect-next", NEXT_CONFIG);
    expect(await sharedPorts.reconcileNextTunnelForHost(host.id)).toEqual({
      generation: 1,
      config: null,
    });
  });

  it("keeps the latest status per session and drops it when the session ends", async () => {
    const { host, session, sharedPorts } = await setup();
    if (!session) throw new Error("expected a session");
    let changes = 0;
    const unsubscribe = sharedPorts.onNextTunnelStatusChange(() => {
      changes += 1;
    });
    const status = {
      state: "connected" as const,
      label: "sawyer-air",
      lastError: null,
      nextRetryAt: null,
      since: 1,
      shares: [{ port: 3000, state: "active" as const, error: null }],
    };
    sharedPorts.recordNextTunnelStatus({
      hostId: host.id,
      sessionId: "another-session",
      status,
    });
    expect(await sharedPorts.listNextTunnelStatuses()).toEqual([]);
    sharedPorts.recordNextTunnelStatus({
      hostId: host.id,
      sessionId: session.id,
      status,
    });
    sharedPorts.recordNextTunnelStatus({
      hostId: host.id,
      sessionId: session.id,
      status,
    });
    expect(changes).toBe(1);
    expect(await sharedPorts.listNextTunnelStatuses()).toEqual([
      { hostId: host.id, hostName: "test-host", status },
    ]);
    sharedPorts.clearHostConnectCapability(session.id);
    expect(await sharedPorts.listNextTunnelStatuses()).toEqual([]);
    expect(changes).toBe(2);
    unsubscribe();
  });

  it("gives a current daemon the config at session open and on the socket", async () => {
    await withTestHarness(async (harness) => {
      await upsertHost(harness.db, harness.hub, {
        id: "host-1",
        name: "Host",
        connectMachineId: "machine-1",
      });
      await harness.deps.sharedPorts.setNextTunnelConfig(
        "hyperfide--connect-next",
        NEXT_CONFIG,
      );
      const response = await openDaemonSession(
        harness,
        HOST_DAEMON_PROTOCOL_VERSION,
      );
      const session = hostDaemonSessionOpenResponseSchema.parse(
        await readJson(response),
      );
      expect(session.connectNext).toEqual({
        generation: 1,
        config: NEXT_CONFIG,
      });
      const daemonSocket = createMockHubSocket();
      await onDaemonSocketOpen(harness.deps, {
        hostId: "host-1",
        sessionId: session.sessionId,
        socket: daemonSocket,
      });
      await onDaemonSocketMessage(harness.deps, {
        hostId: "host-1",
        sessionId: session.sessionId,
        socket: daemonSocket,
        raw: JSON.stringify({
          type: "connect-next.status",
          status: {
            state: "connecting",
            label: null,
            lastError: null,
            nextRetryAt: null,
            since: 1,
            shares: [],
          },
        }),
      });
      expect(
        daemonSocket.messages.map((message) => JSON.parse(message)),
      ).toContainEqual({
        type: "connect-next.replace",
        generation: 1,
        config: NEXT_CONFIG,
      });
      expect(
        await harness.deps.sharedPorts.listNextTunnelStatuses(),
      ).toMatchObject([{ hostId: "host-1", status: { state: "connecting" } }]);
    });
  });

  it("still rejects protocols outside the compatible window", async () => {
    await withTestHarness(async (harness) => {
      await upsertHost(harness.db, harness.hub, { id: "host-1", name: "Host" });
      for (const version of [
        Math.min(...HOST_DAEMON_COMPATIBLE_PROTOCOL_VERSIONS) - 1,
        HOST_DAEMON_PROTOCOL_VERSION + 1,
      ]) {
        const response = await openDaemonSession(harness, version);
        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({
          code: "protocol_version_mismatch",
        });
      }
    });
  });
});
