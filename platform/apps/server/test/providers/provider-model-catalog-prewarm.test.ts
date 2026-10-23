import { openSession, updateHost } from "@hyperfide/db";
import type { JsonValue } from "@hyperfide/domain";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  type HostDaemonOnlineRpcRequestMessage,
} from "@hyperfide/host-daemon-contract";
import { createDeferredPromise } from "@hyperfide/test-helpers";
import { describe, expect, it, vi } from "vitest";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { installProviderModelCatalogPrewarm } from "../../src/services/providers/provider-model-catalog-prewarm.js";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import { resolveSystemExecutionOptions } from "../../src/services/system/execution-options.js";
import {
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import {
  captureLogLines,
  catalogAnswer,
  errorAnswer,
  healthAnswer,
  installCatalogStore,
  modelList,
  requireRegistration,
  settleTimers,
} from "../helpers/provider-model-catalogs.js";
import { registerFirstPartyProviders } from "../helpers/provider-registry.js";
import { seedHost } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { setServerMoveFrozen } from "../../src/services/server-move/freeze-state.js";

const BASE_NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const PASS_FINISHED = "Provider model catalog prewarm pass finished";
const ALWAYS_VISIBLE_PROVIDER_IDS = [
  "acp-cursor",
  "claude-code",
  "codex",
  "pi",
];

type RpcCommand = HostDaemonOnlineRpcRequestMessage["command"];
type ListModelsCommand = Extract<RpcCommand, { type: "provider.list_models" }>;
type HealthCommand = Extract<RpcCommand, { type: "provider.health" }>;
type RpcAnswer<TCommand> = (
  command: TCommand,
  hostId: string,
) => HostRpcHandlerResult | Promise<HostRpcHandlerResult>;
type LogLines = ReturnType<typeof captureLogLines>;

interface DaemonHost {
  hostId: string;
  sessionId: string;
}

async function withPrewarm(
  harness: TestAppHarness,
  run: () => Promise<void>,
): Promise<void> {
  const prewarm = await installProviderModelCatalogPrewarm(harness.deps);
  try {
    await run();
  } finally {
    prewarm.stop();
  }
}

async function waitForPasses(logLines: LogLines, count: number) {
  await vi.waitFor(() => {
    expect(logLines(PASS_FINISHED)).toHaveLength(count);
  });
}

async function openDaemonSession(
  harness: TestAppHarness,
  hostId: string,
): Promise<string> {
  return (
    await openSession(harness.db, {
      hostId,
      instanceId: `instance-${hostId}`,
      hostName: "Test Host",
      dataDir: `/tmp/bb-host-data/${hostId}`,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      heartbeatIntervalMs: 5_000,
      leaseTimeoutMs: 30_000,
    })
  ).id;
}

async function seedDaemonHost(
  harness: TestAppHarness,
  hostId: string,
): Promise<DaemonHost> {
  const host = await seedHost(harness.deps, { id: hostId });
  return {
    hostId: host.id,
    sessionId: await openDaemonSession(harness, host.id),
  };
}

async function registerResponder(
  harness: TestAppHarness,
  args: DaemonHost & {
    health?: RpcAnswer<HealthCommand>;
    listModels?: RpcAnswer<ListModelsCommand>;
  },
) {
  const { requests } = await registerHostRpcResponder(harness, {
    hostId: args.hostId,
    sessionId: args.sessionId,
    handle: ({ command }) => {
      switch (command.type) {
        case "provider.health":
          return (
            args.health?.(command, args.hostId) ?? healthAnswer("not_installed")
          );
        case "provider.list_models":
          return (
            args.listModels?.(command, args.hostId) ??
            catalogAnswer(modelList(`${command.providerId}-model`))
          );
        default:
          throw new Error(`Unexpected RPC command ${command.type}`);
      }
    },
  });
  const listRequests = () =>
    requests.flatMap(({ command }) =>
      command.type === "provider.list_models" ? [command] : [],
    );
  return {
    ...args,
    get commands() {
      return requests.map(({ command }) => command);
    },
    listRequests,
    listedProviderIds: () =>
      listRequests()
        .map((command) => command.providerId)
        .sort(),
  };
}

function createHold() {
  const outstanding: { hostId: string; release(): void }[] = [];
  const maxByHost = new Map<string, number>();
  let maxOutstanding = 0;
  return {
    outstanding,
    maxOutstanding: () => maxOutstanding,
    maxOutstandingForHost: (hostId: string) => maxByHost.get(hostId) ?? 0,
    answer(hostId: string): Promise<HostRpcHandlerResult> {
      const deferred = createDeferredPromise<HostRpcHandlerResult>();
      const held = {
        hostId,
        release() {
          outstanding.splice(outstanding.indexOf(held), 1);
          deferred.resolve(catalogAnswer(modelList("held-model")));
        },
      };
      outstanding.push(held);
      maxOutstanding = Math.max(maxOutstanding, outstanding.length);
      maxByHost.set(
        hostId,
        Math.max(
          maxByHost.get(hostId) ?? 0,
          outstanding.filter((entry) => entry.hostId === hostId).length,
        ),
      );
      return deferred.promise;
    },
  };
}

async function releaseHeldOneByOne(
  hold: ReturnType<typeof createHold>,
  count: number,
): Promise<void> {
  for (let released = 0; released < count; released += 1) {
    await vi.waitFor(() => {
      expect(hold.outstanding.length).toBeGreaterThan(0);
    });
    await settleTimers();
    hold.outstanding[0]?.release();
  }
}

function registerClone(
  harness: TestAppHarness,
  args: {
    id: string;
    available?: boolean;
    bridgeOptions?: Readonly<Record<string, JsonValue>>;
    pluginId?: string;
  },
) {
  const base = requireRegistration(harness, "claude-code");
  const pluginId = args.pluginId ?? base.pluginId;
  return harness.deps.providerRegistry.register({
    ...base,
    pluginId,
    bridgeOptions: args.bridgeOptions ?? base.bridgeOptions,
    info: {
      ...base.info,
      id: args.id,
      pluginId,
      available: args.available ?? base.info.available,
    },
  });
}

describe("provider model catalog prewarm", () => {
  it("warms available always-visible providers and the installed-only provider the listing finds, once each without a cwd", async () => {
    await withTestHarness(async (harness) => {
      installCatalogStore(harness, { clock: { now: BASE_NOW } });
      const logLines = captureLogLines(harness);
      registerClone(harness, { id: "catalog-unavailable", available: false });
      registerClone(harness, {
        id: "catalog-bridgeless",
        pluginId: "catalog-no-artifact",
      });
      expect(requireRegistration(harness, "acp-opencode").visibility).toBe(
        "installed",
      );
      const host = await seedDaemonHost(harness, "host-prewarm-scope");

      await withPrewarm(harness, async () => {
        const responder = await registerResponder(harness, {
          ...host,
          health: (command) =>
            healthAnswer(
              command.providerId === "acp-opencode" ? "ready" : "not_installed",
            ),
        });
        await waitForPasses(logLines, 1);

        expect(responder.listedProviderIds()).toEqual(
          [...ALWAYS_VISIBLE_PROVIDER_IDS, "acp-opencode"].sort(),
        );
        expect(
          responder.listRequests().filter((command) => "cwd" in command),
        ).toEqual([]);
        expect(
          responder.commands.filter(
            (command) =>
              "providerId" in command &&
              command.providerId.startsWith("catalog-"),
          ),
        ).toEqual([]);
      });
    });
  });

  it("refreshes only missing, re-fingerprinted or at least four hours old catalogs on connect and on a registrations change, and skips a recent failure", async () => {
    await withTestHarness(async (harness) => {
      const clock = { now: BASE_NOW - 5 * HOUR };
      installCatalogStore(harness, { clock });
      const logLines = captureLogLines(harness);
      const base = requireRegistration(harness, "claude-code");
      const reregisterProbe = (version: string) =>
        registerClone(harness, {
          id: "catalog-probe",
          bridgeOptions: { ...base.bridgeOptions, catalogProbe: version },
        });
      let probe = reregisterProbe("one");
      const host = await seedDaemonHost(harness, "host-prewarm-age");
      const responder = await registerResponder(harness, {
        ...host,
        listModels: (command) =>
          command.providerId === "acp-cursor"
            ? errorAnswer("command_failed")
            : catalogAnswer(modelList(`${command.providerId}-model`)),
      });
      const read = async (providerId: string) =>
        await resolveSystemExecutionOptions(harness.deps, {
          hostId: host.hostId,
          providerId,
        });
      await read("claude-code");
      clock.now = BASE_NOW - HOUR;
      for (const providerId of ["codex", "acp-cursor", "catalog-probe"]) {
        await read(providerId);
      }
      probe.dispose();
      probe = reregisterProbe("two");
      clock.now = BASE_NOW;
      const readCount = responder.listRequests().length;
      const prewarmed = () =>
        responder
          .listRequests()
          .slice(readCount)
          .map((command) => command.providerId)
          .sort();

      await withPrewarm(harness, async () => {
        await waitForPasses(logLines, 1);
        expect(prewarmed()).toEqual(["catalog-probe", "claude-code", "pi"]);

        clock.now += HOUR;
        probe.dispose();
        reregisterProbe("three");
        await harness.hub.notifySystem(["provider-registrations-changed"]);
        await waitForPasses(logLines, 2);
        expect(prewarmed()).toEqual([
          "catalog-probe",
          "catalog-probe",
          "claude-code",
          "pi",
        ]);
      });
    });
  });

  it("limits list requests to two per host and four across hosts", async () => {
    await withTestHarness(async (harness) => {
      installCatalogStore(harness, { clock: { now: BASE_NOW } });
      const logLines = captureLogLines(harness);
      const hold = createHold();
      const [single, ...others] = await Promise.all(
        [
          "host-prewarm-limit-single",
          "host-prewarm-limit-a",
          "host-prewarm-limit-b",
          "host-prewarm-limit-c",
        ].map(async (hostId) => await seedDaemonHost(harness, hostId)),
      );
      const connect = async (host: DaemonHost) =>
        await registerResponder(harness, {
          ...host,
          listModels: (_command, routedHostId) => hold.answer(routedHostId),
        });

      await withPrewarm(harness, async () => {
        const singleResponder = await connect(single!);
        await releaseHeldOneByOne(hold, ALWAYS_VISIBLE_PROVIDER_IDS.length);
        await waitForPasses(logLines, 1);
        expect(hold.maxOutstanding()).toBe(2);

        const responders = await Promise.all(others.map(connect));
        await releaseHeldOneByOne(
          hold,
          responders.length * ALWAYS_VISIBLE_PROVIDER_IDS.length,
        );
        await waitForPasses(logLines, 4);

        expect(hold.maxOutstanding()).toBe(4);
        for (const responder of [singleResponder, ...responders]) {
          expect(responder.listedProviderIds()).toEqual(
            ALWAYS_VISIBLE_PROVIDER_IDS,
          );
          expect(hold.maxOutstandingForHost(responder.hostId)).toBe(2);
        }
      });
    });
  });

  it("never requests the remaining providers after the host disconnects mid-pass and records no failure for the interrupted refreshes", async () => {
    await withTestHarness(async (harness) => {
      installCatalogStore(harness, { clock: { now: BASE_NOW } });
      const logLines = captureLogLines(harness);
      const hold = createHold();
      const host = await seedDaemonHost(harness, "host-prewarm-disconnect");
      await registerResponder(harness, {
        ...host,
        listModels: (_command, hostId) => hold.answer(hostId),
      });
      const hubRequests = vi.spyOn(harness.hub, "requestHostOnlineRpc");
      const listAttempts = () =>
        hubRequests.mock.calls.filter(
          ([args]) => args.message.command.type === "provider.list_models",
        ).length;

      await withPrewarm(harness, async () => {
        await vi.waitFor(() => {
          expect(hold.outstanding).toHaveLength(2);
        });
        await handleDaemonSocketClosed(harness.deps, {
          sessionId: host.sessionId,
        });
        await waitForPasses(logLines, 1);
        await settleTimers();
        expect(listAttempts()).toBe(2);

        const next = await registerResponder(harness, {
          hostId: host.hostId,
          sessionId: await openDaemonSession(harness, host.hostId),
        });
        await waitForPasses(logLines, 2);
        expect(next.listedProviderIds()).toEqual(ALWAYS_VISIBLE_PROVIDER_IDS);
      });
    });
  });

  it("still runs the replacing session's connect request after the replaced session closes late, and cancels the replaced session's remaining tasks", async () => {
    await withTestHarness(async (harness) => {
      installCatalogStore(harness, { clock: { now: BASE_NOW } });
      const logLines = captureLogLines(harness);
      const hold = createHold();
      const first = await registerResponder(harness, {
        ...(await seedDaemonHost(harness, "host-prewarm-replacement")),
        listModels: (_command, hostId) => hold.answer(hostId),
      });

      await withPrewarm(harness, async () => {
        await vi.waitFor(() => {
          expect(hold.outstanding).toHaveLength(2);
        });
        const second = await registerResponder(harness, {
          hostId: first.hostId,
          sessionId: await openDaemonSession(harness, first.hostId),
        });
        await handleDaemonSocketClosed(harness.deps, {
          sessionId: first.sessionId,
        });
        await harness.hub.notifyHost(first.hostId, ["host-disconnected"]);
        expect(harness.hub.getDaemonSessionIdForHost(first.hostId)).toBe(
          second.sessionId,
        );
        await waitForPasses(logLines, 2);

        expect(first.listRequests()).toHaveLength(2);
        expect(second.listedProviderIds()).toEqual(ALWAYS_VISIBLE_PROVIDER_IDS);
      });
    });
  });

  it("warms only active persistent hosts, including a resumed host with a leftover operation id and a created host once it is active", async () => {
    await withTestHarness(async (harness) => {
      installCatalogStore(harness, { clock: { now: BASE_NOW } });
      const logLines = captureLogLines(harness);

      const seed = async (
        hostId: string,
        patch: Parameters<typeof updateHost>[3],
      ) => {
        const host = await seedDaemonHost(harness, hostId);
        await updateHost(harness.db, harness.hub, host.hostId, patch);
        return host;
      };
      const hosts = [
        await seed("host-prewarm-suspended", {
          phase: "suspended",
          suspendedAt: BASE_NOW,
        }),
        await seed("host-prewarm-resuming", {
          phase: "resuming",
          machineOperationId: "op-resuming",
        }),
        await seed("host-prewarm-ephemeral", { type: "ephemeral" }),
        await seed("host-prewarm-destroyed", { destroyedAt: BASE_NOW }),
        await seed("host-prewarm-creating", {
          phase: "creating",
          machineOperationId: "op-creating",
        }),
        await seed("host-prewarm-resumed", {
          phase: "active",
          machineOperationId: "op-resumed",
        }),
      ];

      await withPrewarm(harness, async () => {
        const responders = await Promise.all(
          hosts.map(async (host) => await registerResponder(harness, host)),
        );
        const resumed = responders.pop()!;
        const creating = responders.at(-1)!;
        await waitForPasses(logLines, 1);
        await settleTimers();

        for (const responder of responders) {
          expect(responder.commands).toEqual([]);
        }
        expect(resumed.listedProviderIds()).toEqual(
          ALWAYS_VISIBLE_PROVIDER_IDS,
        );
        expect(logLines(PASS_FINISHED).map(({ hostId }) => hostId)).toEqual([
          resumed.hostId,
        ]);

        await updateHost(harness.db, harness.hub, creating.hostId, {
          phase: "active",
          machineOperationId: null,
        });
        await harness.hub.notifyHost(creating.hostId, ["host-connected"]);
        await waitForPasses(logLines, 2);
        expect(creating.listedProviderIds()).toEqual(
          ALWAYS_VISIBLE_PROVIDER_IDS,
        );
      });
    });
  });

  it("sends nothing until provider registrations settle", async () => {
    await withTestHarness(async (harness) => {
      installCatalogStore(harness, { clock: { now: BASE_NOW } });
      const logLines = captureLogLines(harness);
      const registry = createProviderRegistryService({
        deferRegistrationsSettled: true,
      });
      await registerFirstPartyProviders(registry, {
        artifacts: harness.deps.pluginHostArtifacts,
      });
      harness.deps.providerRegistry = registry;
      const host = await seedDaemonHost(harness, "host-prewarm-settle");

      await withPrewarm(harness, async () => {
        const responder = await registerResponder(harness, host);
        await settleTimers(50);
        expect(responder.commands).toEqual([]);

        registry.markRegistrationsSettled();
        await waitForPasses(logLines, 1);
        expect(responder.listedProviderIds()).toEqual(
          ALWAYS_VISIBLE_PROVIDER_IDS,
        );
      });
    });
  });

  it("coalesces host-connected notifications during a running pass into one follow-up pass that refreshes nothing fresh", async () => {
    await withTestHarness(async (harness) => {
      installCatalogStore(harness, { clock: { now: BASE_NOW } });
      const logLines = captureLogLines(harness);
      const hold = createHold();
      const responder = await registerResponder(harness, {
        ...(await seedDaemonHost(harness, "host-prewarm-coalesce")),
        listModels: (_command, hostId) => hold.answer(hostId),
      });

      await withPrewarm(harness, async () => {
        await vi.waitFor(() => {
          expect(hold.outstanding).toHaveLength(2);
        });
        await harness.hub.notifyHost(responder.hostId, ["host-connected"]);
        await harness.hub.notifyHost(responder.hostId, ["host-connected"]);
        await releaseHeldOneByOne(hold, ALWAYS_VISIBLE_PROVIDER_IDS.length);
        await waitForPasses(logLines, 2);
        await settleTimers();

        expect(logLines(PASS_FINISHED)).toHaveLength(2);
        expect(responder.listRequests()).toHaveLength(
          ALWAYS_VISIBLE_PROVIDER_IDS.length,
        );
      });
    });
  });

  it("sends nothing after stop and drops the remaining tasks", async () => {
    await withTestHarness(async (harness) => {
      installCatalogStore(harness, { clock: { now: BASE_NOW } });
      const hold = createHold();
      const responder = await registerResponder(harness, {
        ...(await seedDaemonHost(harness, "host-prewarm-stop")),
        listModels: (_command, hostId) => hold.answer(hostId),
      });
      const prewarm = await installProviderModelCatalogPrewarm(harness.deps);
      await vi.waitFor(() => {
        expect(hold.outstanding).toHaveLength(2);
      });
      const commandCount = responder.commands.length;

      prewarm.stop();
      for (const held of [...hold.outstanding]) {
        held.release();
      }
      await harness.hub.notifyHost(responder.hostId, ["host-connected"]);
      await harness.hub.notifySystem(["provider-registrations-changed"]);
      await settleTimers(50);

      expect(responder.commands).toHaveLength(commandCount);
      expect(responder.listRequests()).toHaveLength(2);
    });
  });

  it("skips passes while the server is moving and warms the host once released", async () => {
    await withTestHarness(async (harness) => {
      installCatalogStore(harness, { clock: { now: BASE_NOW } });
      const logLines = captureLogLines(harness);
      const host = await seedDaemonHost(harness, "host-prewarm-frozen");

      setServerMoveFrozen(harness.db, true);
      try {
        await withPrewarm(harness, async () => {
          const responder = await registerResponder(harness, host);
          await harness.hub.notifyHost(host.hostId, ["host-connected"]);
          await harness.hub.notifySystem(["provider-registrations-changed"]);
          await settleTimers(50);
          expect(responder.commands).toEqual([]);
          expect(logLines(PASS_FINISHED)).toEqual([]);

          setServerMoveFrozen(harness.db, false);
          await harness.hub.notifyHost(host.hostId, ["host-connected"]);
          await waitForPasses(logLines, 1);
          expect(responder.listedProviderIds()).toEqual(
            [...ALWAYS_VISIBLE_PROVIDER_IDS].sort(),
          );
        });
      } finally {
        setServerMoveFrozen(harness.db, false);
      }
    });
  });
});
