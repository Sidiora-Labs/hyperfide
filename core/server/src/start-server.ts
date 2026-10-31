import { createDesktopAppUpdateService } from "./services/system/desktop-app-update.js";
import { createDesktopUpdateChannel } from "./services/system/desktop-update-channel.js";
import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "@hyperfide/config/server";
import { isLoopbackHostname } from "@hyperfide/config/loopback";
import { toOptionalString } from "@hyperfide/config/strings";
import { createLogger } from "@hyperfide/logger";
import {
  getAppSettings,
  getDisabledProviderIds,
  listRunningThreads,
  setAppSettings,
} from "@hyperfide/db";
import { initDb } from "./db.js";
import { createApp } from "./server.js";
import { PendingInteractionLifecycle } from "./services/interactions/pending-interactions.js";
import { createMachineAuthService } from "./services/machine-auth.js";
import { resolveBuiltinSkillsRootPath } from "./services/skills/builtin-skills-copy.js";
import { SkillTreeRegistry } from "./services/skills/injected-skills.js";
import { PluginHostArtifactRegistry } from "./services/plugins/plugin-host-artifact-registry.js";
import { createProviderNativeRootsCache } from "./services/providers/native-roots.js";
import { createAiServiceRegistry } from "./services/ai/ai-service-registry.js";
import { createAppUpdateService } from "./services/system/app-update.js";
import {
  createCliCommandService,
  createWindowsUserPath,
} from "./services/system/cli-command.js";
import { createAppVersionService } from "./services/system/app-version.js";
import { createLauncherChannel } from "./services/system/launcher-channel.js";
import { createHyperfideAppManagedConfigReloader } from "./services/system/hyperfide-app-managed-config.js";
import { startGatedPerformanceDiagnostics } from "./services/system/performance-diagnostics.js";
import { startEventLoopStallMonitor } from "./services/system/event-loop-stall-monitor.js";
import {
  runPeriodicSweeps,
  runStartupRecoverySweep,
} from "./services/system/periodic-sweeps.js";
import { installProviderModelCatalogPrewarm } from "./services/providers/provider-model-catalog-prewarm.js";
import {
  createProviderRegistryService,
  type ProviderRegistryService,
} from "./services/providers/provider-registry.js";
import type { PluginService } from "./services/plugins/plugin-service.js";
import { createTelemetryService } from "./services/system/telemetry.js";
import { TerminalSessionLifecycle } from "./services/terminals/terminal-session-lifecycle.js";
import { createLifecycleDedupers } from "./lifecycle-dedupers.js";
import type { ServerLogger, ServerRuntimeConfig } from "./types.js";
import { NotificationHub } from "./ws/hub.js";
import { startDaemonLivenessChecks } from "./ws/daemon-protocol.js";
import { WatchInterestCoordinator } from "./ws/watch-interests.js";
import { WorkspaceReadCaches } from "./services/environments/workspace-read-cache.js";
import { HostSharedPortCoordinator } from "./ws/host-shared-ports.js";
import { disconnectImportedDaemonSessions } from "./internal/session-owner-side-effects.js";
import {
  applyServerImportAtBoot,
  refuseInterruptedServerImport,
  repairLastServerMoveHostName,
} from "./services/server-move/pending-boot.js";
import { isServerMoveFrozen } from "./services/server-move/freeze-state.js";
import { reconcileServerMoveRunAtBoot } from "./services/server-move/reconcile.js";
import {
  retireServerProcess as retireProcessWithDeadline,
  SERVER_RETIRE_FORCE_EXIT_MS,
} from "./services/server-move/retire.js";
import {
  PluginToolCallRegistry,
  setPluginToolCallRegistry,
} from "./services/plugins/plugin-tool-calls.js";

interface StartHttpListenerArgs {
  fetch: Parameters<typeof serve>[0]["fetch"];
  serverConfig: Pick<
    ServerConfig,
    "HYPERFIDE_SERVER_BIND_HOST" | "HYPERFIDE_SERVER_PORT"
  >;
}

export function startHttpListener(args: StartHttpListenerArgs) {
  return serve({
    hostname: args.serverConfig.HYPERFIDE_SERVER_BIND_HOST,
    port: args.serverConfig.HYPERFIDE_SERVER_PORT,
    fetch: args.fetch,
  });
}

export interface StartServerPluginsArgs {
  dataDir: string;
  logger: Pick<ServerLogger, "error" | "warn">;
  pluginService: Pick<PluginService, "start" | "startPeriodicUpdateChecks">;
  providerRegistry: Pick<ProviderRegistryService, "markRegistrationsSettled">;
}

export function startServerPlugins(
  args: StartServerPluginsArgs,
): Promise<void> {
  return args.pluginService
    .start()
    .catch((error: unknown) => {
      args.logger.error({ err: error }, "Plugin startup failed");
    })
    .finally(() => {
      args.providerRegistry.markRegistrationsSettled();
      return args.pluginService.startPeriodicUpdateChecks();
    });
}

export async function runServer(serverConfig: ServerConfig): Promise<void> {
  const logger = createLogger({
    component: "server",
    dataDir: serverConfig.HYPERFIDE_DATA_DIR,
  });
  await refuseInterruptedServerImport({
    dataDir: serverConfig.HYPERFIDE_DATA_DIR,
    logger,
  });
  let diagnosticsEnabled = () => false;
  const db = await initDb(serverConfig.databasePath, {
    slowQueryThresholdMs: () => (diagnosticsEnabled() ? 25 : 100),
    slowQueryDiagnosticsEnabled: () => diagnosticsEnabled(),
    dataDir: serverConfig.HYPERFIDE_DATA_DIR,
    logger,
  });
  const serverImport = await applyServerImportAtBoot({
    dataDir: serverConfig.HYPERFIDE_DATA_DIR,
    db,
    logger,
    now: Date.now(),
  });
  const pendingServerMove = serverImport.pendingMove;
  if (pendingServerMove === null) {
    await repairLastServerMoveHostName({
      dataDir: serverConfig.HYPERFIDE_DATA_DIR,
      db,
      logger,
    });
  }
  if (serverConfig.HYPERFIDE_SKIP_ONBOARDING) {
    const settings = await getAppSettings(db);
    if (settings.onboardingCompletedAt === null) {
      await setAppSettings(db, {
        ...settings,
        onboardingCompletedAt: new Date().toISOString(),
      });
    }
  }
  const serverMoveRun =
    pendingServerMove === null
      ? await reconcileServerMoveRunAtBoot({
          dataDir: serverConfig.HYPERFIDE_DATA_DIR,
          logger,
          now: Date.now(),
        })
      : null;
  const hub = new NotificationHub();
  const watchInterests = new WatchInterestCoordinator({ db, hub });
  const sharedPorts = new HostSharedPortCoordinator({ db, hub });
  const workspaceReadCaches = new WorkspaceReadCaches({ hub });
  const lifecycleDedupers = createLifecycleDedupers();
  const appUrl = toOptionalString(serverConfig.HYPERFIDE_APP_URL);

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const appDir = resolve(selfDir, "../../../apps/web");
  const appDistDir = join(appDir, "dist");
  const isProduction = process.env.NODE_ENV === "production";
  const staticDir =
    isProduction && existsSync(appDistDir) ? appDistDir : undefined;
  const runtimeConfig: ServerRuntimeConfig = {
    appVersion: serverConfig.HYPERFIDE_APP_VERSION,
    builtinSkillsRootPath: resolveBuiltinSkillsRootPath(),
    marketplaceUrl: serverConfig.HYPERFIDE_MARKETPLACE_URL,
    customModels: [],
    dataDir: serverConfig.HYPERFIDE_DATA_DIR,
    featureFlags: serverConfig.featureFlags,
    hostDaemonPort: serverConfig.HYPERFIDE_HOST_DAEMON_PORT,
    inheritedSkillsRootPaths: serverConfig.HYPERFIDE_INHERITED_SKILLS_ROOTS,
    isDevelopment: !isProduction,
    performanceDiagnosticsAvailable: serverConfig.HYPERFIDE_PERF_DIAGNOSTICS,
    serverPort: serverConfig.HYPERFIDE_SERVER_PORT,
    sharedSkillRoots: { user: [], project: [] },
  };

  const providerRegistry = createProviderRegistryService({
    deferRegistrationsSettled: true,
    readUserProviderPreferences: async () => {
      const settings = await getAppSettings(db);
      return {
        providerOrder: settings.providerOrder,
        disabledProviderIds: await getDisabledProviderIds(db),
        defaultProviderId: settings.defaultProviderId,
      };
    },
  });

  if (appUrl !== undefined) {
    runtimeConfig.appUrl = appUrl;
  }
  if (serverConfig.HYPERFIDE_DEV_APP_PORT !== undefined) {
    runtimeConfig.devAppPort = serverConfig.HYPERFIDE_DEV_APP_PORT;
  }
  if (serverConfig.HYPERFIDE_SERVER_LAUNCH_ID !== undefined) {
    runtimeConfig.launchId = serverConfig.HYPERFIDE_SERVER_LAUNCH_ID;
  }
  const terminalSessions = new TerminalSessionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    logger,
  });
  const hyperfideAppManagedConfig = await createHyperfideAppManagedConfigReloader({
    config: runtimeConfig,
    hub,
    logger,
  });

  const telemetry = await createTelemetryService({ logger });

  const machineAuth = await createMachineAuthService({
    dataDir: serverConfig.HYPERFIDE_DATA_DIR,
    db,
    logger,
  });
  await machineAuth.ensureReady();
  const skillTreeRegistry = new SkillTreeRegistry();
  const pluginHostArtifacts = new PluginHostArtifactRegistry();
  const providerNativeRoots = createProviderNativeRootsCache();
  const aiServices = createAiServiceRegistry({
    onStatusChange: async () => await hub.notifySystem(["config-changed"]),
  });
  const pendingInteractions = new PendingInteractionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
  });
  await pendingInteractions.start();
  setPluginToolCallRegistry(new PluginToolCallRegistry({ logger }));

  const updatePackage = serverConfig.HYPERFIDE_APP_UPDATE_PACKAGE;
  if (updatePackage !== undefined) {
    runtimeConfig.updateChannel = {
      url: `https://registry.npmjs.org/${encodeURIComponent(updatePackage)}/latest`,
      upgradeCommand: `npx ${updatePackage}@latest`,
    };
  }
  const appVersion = createAppVersionService({
    installKind: serverConfig.HYPERFIDE_APP_INSTALL_KIND ?? null,
    sourceCommit: serverConfig.HYPERFIDE_APP_SOURCE_COMMIT ?? null,
    config: runtimeConfig,
    logger,
  });
  const appUpdateMode = serverConfig.HYPERFIDE_APP_UPDATE_MODE ?? null;
  const desktopUpdateChannel =
    serverConfig.HYPERFIDE_APP_SURFACE === "desktop"
      ? createDesktopUpdateChannel(process)
      : null;
  const appUpdate =
    desktopUpdateChannel === null
      ? createAppUpdateService({
          currentCommit:
            serverConfig.HYPERFIDE_APP_INSTALL_KIND === "source"
              ? (serverConfig.HYPERFIDE_APP_SOURCE_COMMIT ?? null)
              : null,
          appSurface: serverConfig.HYPERFIDE_APP_SURFACE,
          appVersion,
          config: runtimeConfig,
          countRunningThreads: async () =>
            (await listRunningThreads(db)).length,
          launcher:
            appUpdateMode === null ? null : createLauncherChannel(process),
          logger,
          mode: appUpdateMode,
          notifyChanged: async () =>
            await hub.notifySystem(["app-update-changed"]),
        })
      : createDesktopAppUpdateService({
          channel: desktopUpdateChannel,
          currentVersion: runtimeConfig.appVersion,
          dataDir: serverConfig.HYPERFIDE_DATA_DIR,
          countRunningThreads: async () =>
            (await listRunningThreads(db)).length,
          notifyChanged: async () =>
            await hub.notifySystem(["app-update-changed"]),
          logger,
        });
  const cliCommand = createCliCommandService({
    env: process.env,
    homeDir: homedir(),
    launcherPath: serverConfig.HYPERFIDE_CLI_LAUNCHER ?? null,
    platform: process.platform,
    windowsUserPath: createWindowsUserPath(process.env),
  });
  const {
    app,
    closeWebSockets,
    injectWebSocket,
    pluginCatalogService,
    pluginService,
    serverMove,
  } = await createApp(
    {
      appUpdate,
      appVersion,
      hyperfideAppManagedConfig,
      cliCommand,
      config: runtimeConfig,
      db,
      hub,
      lifecycleDedupers,
      logger,
      machineAuth,
      pendingInteractions,
      providerRegistry,
      pluginHostArtifacts,
      providerNativeRoots,
      aiServices,
      skillTreeRegistry,
      telemetry,
      terminalSessions,
      watchInterests,
      sharedPorts,
      workspaceReadCaches,
    },
    {
      serverMove: {
        appSurface: serverConfig.HYPERFIDE_APP_SURFACE,
        bindHost: serverConfig.HYPERFIDE_SERVER_BIND_HOST,
        manualImportPending: serverImport.manualImportPending,
        pending: pendingServerMove,
        restoredRun: serverMoveRun,
        retireProcess: retireServerProcess,
      },
      staticDir,
      performanceDiagnosticsEnabled: () => diagnosticsEnabled(),
    },
  );
  await disconnectImportedDaemonSessions(
    {
      config: runtimeConfig,
      db,
      hub,
      lifecycleDedupers,
      logger,
      machineAuth,
      pendingInteractions,
      providerRegistry,
      pluginHostArtifacts,
      aiServices,
      skillTreeRegistry,
      telemetry,
      terminalSessions,
    },
    { sessions: serverImport.importedDaemonSessions },
  );
  const performanceDiagnostics = await startGatedPerformanceDiagnostics({
    allowed: serverConfig.HYPERFIDE_PERF_DIAGNOSTICS,
    dataDir: serverConfig.HYPERFIDE_DATA_DIR,
    db,
    hub,
    logger,
  });
  diagnosticsEnabled = performanceDiagnostics.isEnabled;
  const eventLoopStallMonitor = startEventLoopStallMonitor({
    logger,
    thresholdMs: () => (diagnosticsEnabled() ? 100 : 500),
  });
  const stopDaemonLivenessChecks = startDaemonLivenessChecks({
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    sharedPorts,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
  });

  const sweepDeps = {
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    pluginSchedules: pluginService,
    plugins: pluginService,
    telemetry,
    terminalSessions,
  };
  const providerModelCatalogPrewarm =
    pendingServerMove === null
      ? await installProviderModelCatalogPrewarm(sweepDeps)
      : null;
  if (pendingServerMove === null) {
    await runStartupRecoverySweep(sweepDeps).catch((error) => {
      logger.error({ err: error }, "Startup recovery sweep failed");
    });
  }

  if (!isLoopbackHostname(serverConfig.HYPERFIDE_SERVER_BIND_HOST)) {
    logger.warn(
      { bindHost: serverConfig.HYPERFIDE_SERVER_BIND_HOST },
      "SECURITY WARNING: The public API is unauthenticated and permits command execution and file reads. Wildcard server binding must only be used behind a trusted network boundary.",
    );
  }

  const server = startHttpListener({
    fetch: app.fetch,
    serverConfig,
  });
  injectWebSocket(server);

  logger.info(
    {
      bindHost: serverConfig.HYPERFIDE_SERVER_BIND_HOST,
      port: serverConfig.HYPERFIDE_SERVER_PORT,
      dataDir: serverConfig.HYPERFIDE_DATA_DIR,
    },
    "Server listening",
  );
  pluginService.bindSdk({
    baseUrl: `http://127.0.0.1:${serverConfig.HYPERFIDE_SERVER_PORT}`,
  });
  let sweepInterval: ReturnType<typeof setInterval> | null = null;
  if (pendingServerMove === null) {
    telemetry.capture({ name: "app_started" });
    if (serverMoveRun?.kind === "completed") {
      logger.info(
        { moveId: serverMoveRun.run.status.moveId },
        "This server already moved before it restarted; retiring without starting plugins",
      );
      providerRegistry.markRegistrationsSettled();
    } else {
      void startServerPlugins({
        dataDir: serverConfig.HYPERFIDE_DATA_DIR,
        logger,
        pluginService,
        providerRegistry,
      }).finally(() => {
        void serverMove.handlePluginsStarted();
      });
    }
    pluginCatalogService.startPeriodicRefresh();
    sweepInterval = setInterval(async () => {
      if (!isServerMoveFrozen(db)) {
        void runPeriodicSweeps(sweepDeps);
      }
    }, 10_000);
    sweepInterval.unref();
  } else {
    logger.info(
      { moveId: pendingServerMove.moveId },
      "Server started in pending move mode; waiting for the target machine to activate it",
    );
  }

  let shutdownPromise: Promise<void> | null = null;
  const runShutdown = async (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      serverMove.dispose();
      appUpdate.dispose();
      providerModelCatalogPrewarm?.stop();
      eventLoopStallMonitor.stop();
      await performanceDiagnostics.stop();
      stopDaemonLivenessChecks();
      if (sweepInterval !== null) {
        clearInterval(sweepInterval);
      }
      pluginCatalogService.stopPeriodicRefresh();
      await pluginService.stopPeriodicUpdateChecks();
      if (pendingServerMove === null) {
        await pluginService.stop().catch((error: unknown) => {
          logger.warn({ err: error }, "Plugin shutdown failed");
        });
      }
      const closeServer = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await closeWebSockets();
      await closeServer;
    })();
    return shutdownPromise;
  };

  function retireServerProcess(): void {
    logger.info({}, "Server moved to another machine; shutting down");
    retireProcessWithDeadline({
      exit: (code) => process.exit(code),
      forceExitAfterMs: SERVER_RETIRE_FORCE_EXIT_MS,
      shutdown: runShutdown,
    });
  }

  process.on("uncaughtException", async (error: unknown) => {
    if (await pluginService.handleUncaughtException(error)) return;
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  process.once("SIGINT", async () => {
    void runShutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", async () => {
    void runShutdown().finally(() => process.exit(0));
  });
}
