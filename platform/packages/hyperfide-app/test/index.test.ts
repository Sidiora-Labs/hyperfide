import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { waitForProcessExit } from "@hyperfide/config/child-process-exit";
import { resolvePortFromEnv } from "@hyperfide/config/runtime";
import {
  assertHyperfideAppArtifacts,
  assertHyperfideHostArtifacts,
  completeFullStackSupervision,
  createDaemonEnv,
  createHostEnrollKeyRequestBody,
  createServerEnv,
  createHostDaemonJoinEnv,
  parseLauncherArgs,
  readHyperfideAppPackageVersion,
  resolveHyperfideAppRuntimeState,
  resolveDataDir,
  resolveHyperfideAppStartContext,
  resolveHyperfideAppCommand,
  resolveServerListenerUrl,
  resolveBundledCliLaunch,
  resolveWorktreeRuntimePolicy,
  runHyperfideApp,
  shouldRunSourceAppUpdateShim,
  runBundledCliCommand,
  superviseFullStackProcesses,
  terminateManagedFullStackProcesses,
  waitForHostDaemonStatus,
} from "../src/launcher.js";
import type {
  HyperfideAppStartContext,
  DelayMillisecondsArgs,
  DelayMillisecondsFn,
  FullStackSupervisionResult,
  ManagedFullStackProcesses,
  ManagedProcessName,
  ManagedProcessRun,
  NamedProcessExitResult,
  ProcessExitResult,
  ReadServerMovedFileFn,
} from "../src/launcher.js";

interface DelayArgs {
  ms: number;
}

interface ControlledDelayCall {
  ms: number;
  resolve(): void;
}

interface ConfigReloadTestServer {
  close(): Promise<void>;
  port: number;
  reloadCount(): number;
  reloadRequests(): ConfigReloadRequest[];
  url: string;
}

interface HostListTestServer {
  close(): Promise<void>;
  requests(): string[];
  url: string;
}

interface ConfigReloadRequest {
  host: string | undefined;
  method: string | undefined;
  url: string | undefined;
}

interface InvalidConfigCommandCase {
  expectedError: RegExp;
  key: string;
  value: string;
}

interface StartupOnlyManagedEnvCase {
  key: string;
  value: string;
}

type DelayResult = "timeout";
type ResolveFakeManagedProcessExit = (result: NamedProcessExitResult) => void;
type StartFakeManagedProcess = () => Promise<ManagedProcessRun>;

interface FakeManagedProcessRunArgs {
  id: string;
  processName: ManagedProcessName;
}

interface WaitForProcessReplacementArgs {
  currentRun: () => ManagedProcessRun | null;
  previousRun: ManagedProcessRun;
}

interface WaitForDelayCallArgs {
  delay: ControlledDelay;
  index: number;
}

interface FakeSupervisor {
  daemonRuns: FakeManagedProcessRun[];
  daemonStart: StartFakeManagedProcess;
  processes: ManagedFullStackProcesses;
  serverRuns: FakeManagedProcessRun[];
  serverStart: StartFakeManagedProcess;
  setShutdownRequested(value: boolean): void;
  shutdownRequested(): boolean;
}

const invalidConfigCommandCases: InvalidConfigCommandCase[] = [
  ...[
    "HYPERFIDE_INFERENCE",
    "HYPERFIDE_INFERENCE_FALLBACK",
    "HYPERFIDE_TRANSCRIPTION",
  ].map((key) => ({
    expectedError: /were removed\. Choose AI services in Settings/u,
    key,
    value: "codex/gpt-5.6-luna",
  })),
  {
    expectedError: /HYPERFIDE_APP_URL must be a valid URL/u,
    key: "HYPERFIDE_APP_URL",
    value: "not-a-url",
  },
  {
    expectedError: /HYPERFIDE_SERVER_URL must be a valid URL/u,
    key: "HYPERFIDE_SERVER_URL",
    value: "not-a-url",
  },
  {
    expectedError: /HYPERFIDE_LOG_LEVEL must be one of/u,
    key: "HYPERFIDE_LOG_LEVEL",
    value: "bogus",
  },
];

const startupOnlyManagedEnvCases: StartupOnlyManagedEnvCase[] = [
  { key: "HYPERFIDE_APP_SURFACE", value: "desktop" },
  { key: "HYPERFIDE_APP_URL", value: "https://app.example.test" },
  { key: "HYPERFIDE_DATA_DIR", value: "/tmp/hyperfide-managed-data" },
  { key: "HYPERFIDE_DEV_APP_PORT", value: "4173" },
  { key: "HYPERFIDE_EXTERNAL_URL", value: "https://external.example.test" },
  { key: "HYPERFIDE_FF_PLACEHOLDER", value: "true" },
  { key: "HYPERFIDE_FF_TIMELINE_WINDOW_EVENT_BUDGET", value: "2000" },
  { key: "HYPERFIDE_HOST_DAEMON_PORT", value: "48887" },
  { key: "HYPERFIDE_INHERITED_SKILLS_ROOTS", value: "/tmp/hyperfide-skills" },
  { key: "HYPERFIDE_LOG_LEVEL", value: "debug" },
  { key: "HYPERFIDE_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD", value: "1" },
  { key: "HYPERFIDE_SERVER_BIND_HOST", value: "127.0.0.1" },
  { key: "HYPERFIDE_SERVER_PORT", value: "48886" },
];

const packageMetadataSchema = z.object({
  engines: z.object({
    node: z.string(),
  }),
  files: z.array(z.string()),
  os: z.array(z.string()),
});

type PackageMetadata = z.infer<typeof packageMetadataSchema>;

class FakeManagedProcessRun implements ManagedProcessRun {
  readonly exit: Promise<NamedProcessExitResult>;
  readonly id: string;
  readonly processName: ManagedProcessName;
  readonly terminationSignals: NodeJS.Signals[] = [];
  running = true;
  private resolveExit: ResolveFakeManagedProcessExit = () => undefined;

  constructor(args: FakeManagedProcessRunArgs) {
    this.id = args.id;
    this.processName = args.processName;
    this.exit = new Promise<NamedProcessExitResult>((resolvePromise) => {
      this.resolveExit = resolvePromise;
    });
  }

  exitWith(result: ProcessExitResult): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.resolveExit({ processName: this.processName, result });
  }

  async terminate(signal: NodeJS.Signals): Promise<void> {
    this.terminationSignals.push(signal);
    this.exitWith({ code: null, signal });
  }
}

class ControlledDelay {
  readonly calls: ControlledDelayCall[] = [];

  async delayMilliseconds(args: DelayMillisecondsArgs): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.calls.push({
        ms: args.ms,
        resolve: resolvePromise,
      });
    });
  }
}

function delay(args: DelayArgs): Promise<DelayResult> {
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      resolvePromise("timeout");
    }, args.ms);
  });
}

const immediateDelay: DelayMillisecondsFn = () => {
  return Promise.resolve();
};

const noServerMovedFile: ReadServerMovedFileFn = async () => null;

async function unexpectedServerMove(): Promise<FullStackSupervisionResult> {
  throw new Error("Unexpected server move");
}

function createTestStartContext(): HyperfideAppStartContext {
  return {
    appDistDir: "/tmp/hyperfide-app-test/app/dist",
    appVersion: "0.0.0-test",
    configFile: "/tmp/hyperfide-app-test/config.json",
    daemonBundleDir: "/tmp/hyperfide-app-test/host-daemon/dist",
    daemonEntry: "/tmp/hyperfide-app-test/host-daemon/dist/daemon-bundle.mjs",
    daemonLockDir: "/tmp/hyperfide-app-test/daemon.lock.lock",
    daemonLockFile: "/tmp/hyperfide-app-test/daemon.lock",
    daemonPort: 38887,
    dataDir: "/tmp/hyperfide-app-test",
    dbPath: "/tmp/hyperfide-app-test/hyperfide.db",
    envFile: "/tmp/hyperfide-app-test/env.json",
    logDir: "/tmp/hyperfide-app-test/logs",
    packageRoot: "/tmp/hyperfide-app-test/package",
    serverEntry: "/tmp/hyperfide-app-test/server/dist/index.js",
    serverPort: 38886,
    serverUrl: "http://127.0.0.1:38886",
  };
}

function createFakeSupervisor(): FakeSupervisor {
  let shutdownRequested = false;
  const serverRuns = [
    new FakeManagedProcessRun({ id: "server-1", processName: "server" }),
  ];
  const daemonRuns = [
    new FakeManagedProcessRun({ id: "daemon-1", processName: "daemon" }),
  ];
  const processes: ManagedFullStackProcesses = {
    daemonRun: daemonRuns[0],
    serverRun: serverRuns[0],
  };
  const serverStart = async (): Promise<ManagedProcessRun> => {
    const run = new FakeManagedProcessRun({
      id: `server-${serverRuns.length + 1}`,
      processName: "server",
    });
    serverRuns.push(run);
    processes.serverRun = run;
    return run;
  };
  const daemonStart = async (): Promise<ManagedProcessRun> => {
    const run = new FakeManagedProcessRun({
      id: `daemon-${daemonRuns.length + 1}`,
      processName: "daemon",
    });
    daemonRuns.push(run);
    processes.daemonRun = run;
    return run;
  };
  return {
    daemonRuns,
    daemonStart,
    processes,
    serverRuns,
    serverStart,
    setShutdownRequested(value) {
      shutdownRequested = value;
    },
    shutdownRequested() {
      return shutdownRequested;
    },
  };
}

async function waitForProcessReplacement(
  args: WaitForProcessReplacementArgs,
): Promise<ManagedProcessRun> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const currentRun = args.currentRun();
    if (currentRun !== null && currentRun !== args.previousRun) {
      return currentRun;
    }
    await delay({ ms: 1 });
  }
  throw new Error("Timed out waiting for process replacement");
}

async function waitForDelayCall(
  args: WaitForDelayCallArgs,
): Promise<ControlledDelayCall> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const call = args.delay.calls[args.index];
    if (call !== undefined) {
      return call;
    }
    await delay({ ms: 1 });
  }
  throw new Error("Timed out waiting for restart throttle delay");
}

async function stopFakeSupervisor(
  supervisor: FakeSupervisor,
  supervision: Promise<FullStackSupervisionResult>,
): Promise<FullStackSupervisionResult> {
  supervisor.setShutdownRequested(true);
  await terminateManagedFullStackProcesses({
    processes: supervisor.processes,
    signal: "SIGTERM",
  });
  return supervision;
}

async function startConfigReloadTestServer(): Promise<ConfigReloadTestServer> {
  const reloadRequests: ConfigReloadRequest[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      if (
        request.method === "POST" &&
        request.url === "/api/v1/system/config/reload"
      ) {
        reloadRequests.push({
          host: request.headers.host,
          method: request.method,
          url: request.url,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found", message: "Not found" }));
    },
  );

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected test server to listen on a TCP port");
  }
  const addressInfo: AddressInfo = address;

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    },
    port: addressInfo.port,
    reloadCount(): number {
      return reloadRequests.length;
    },
    reloadRequests(): ConfigReloadRequest[] {
      return [...reloadRequests];
    },
    url: `http://127.0.0.1:${addressInfo.port}`,
  };
}

async function startHostListTestServer(
  hosts: unknown[],
): Promise<HostListTestServer> {
  const requests: string[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.method === "GET" && request.url === "/api/v1/hosts") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(hosts));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found", message: "Not found" }));
    },
  );

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected test server to listen on a TCP port");
  }
  const addressInfo: AddressInfo = address;

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    },
    requests(): string[] {
      return [...requests];
    },
    url: `http://127.0.0.1:${addressInfo.port}`,
  };
}

function readPackageMetadata(): PackageMetadata {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return packageMetadataSchema.parse(
    JSON.parse(readFileSync(resolve(testDir, "..", "package.json"), "utf8")),
  );
}

function expectedConfigReloadRequest(
  server: ConfigReloadTestServer,
): ConfigReloadRequest {
  return {
    host: `127.0.0.1:${server.port}`,
    method: "POST",
    url: "/api/v1/system/config/reload",
  };
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  try {
    await run();
  } finally {
    write.mockRestore();
  }
  return chunks.join("");
}

describe("hyperfide-app launcher", () => {
  it("waits for the expected host daemon identity and connection", async () => {
    let statusRequests = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/status") {
        response.writeHead(404).end();
        return;
      }
      statusRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          connected: statusRequests >= 2,
          hostId: "host-expected",
          serverUrl: "http://127.0.0.1:38886/",
        }),
      );
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected status test server to have a TCP address");
    }

    try {
      await waitForHostDaemonStatus({
        childProcess: null,
        expectedHostId: "host-expected",
        expectedServerUrl: "http://localhost:38886",
        port: address.port,
        timeoutMs: 1_000,
      });
      expect(statusRequests).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });

  it("does not accept another daemon's successful health response", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        request.url === "/health"
          ? JSON.stringify({ ok: true })
          : JSON.stringify({
              connected: true,
              hostId: "host-other",
              serverUrl: "https://other.example.test",
            }),
      );
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected status test server to have a TCP address");
    }

    try {
      await expect(
        waitForHostDaemonStatus({
          childProcess: null,
          expectedHostId: "host-expected",
          expectedServerUrl: "https://hyperfide.example.test",
          port: address.port,
          timeoutMs: 25,
        }),
      ).rejects.toThrow("Timed out waiting for host daemon host-expected");
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });

  it("resolves production defaults for npx startup", () => {
    const context = resolveHyperfideAppStartContext({
      entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js").href,
      env: {},
      homeDir: "/home/tester",
    });

    expect(context.dataDir).toBe(join("/home/tester", ".hyperfide"));
    expect(context.configFile).toBe(
      join("/home/tester", ".hyperfide", "config.json"),
    );
    expect(context.envFile).toBe(
      join("/home/tester", ".hyperfide", "env.json"),
    );
    expect(context.serverPort).toBe(38886);
    expect(context.daemonPort).toBe(38887);
    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
    expect(context.serverEntry).toBe(
      resolve("/repo/packages/hyperfide-app/server/dist/index.js"),
    );
    expect(context.daemonEntry).toBe(
      resolve("/repo/packages/hyperfide-app/host-daemon/dist/daemon-bundle.mjs"),
    );
    expect(context.appVersion).toBe("0.0.0-dev");
  });

  it("uses workspace build outputs when run from a source checkout", () => {
    const context = resolveHyperfideAppStartContext({
      entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/src/launcher.ts")
        .href,
      env: {},
      homeDir: "/home/tester",
    });

    expect(context.packageRoot).toBe(resolve("/repo/packages/hyperfide-app"));
    expect(context.appDistDir).toBe(resolve("/repo/apps/app/dist"));
    expect(context.serverEntry).toBe(
      resolve("/repo/apps/server/dist/index.js"),
    );
    expect(context.daemonBundleDir).toBe(
      resolve("/repo/apps/host-daemon/dist"),
    );
    expect(context.daemonEntry).toBe(
      resolve("/repo/apps/host-daemon/dist/daemon-bundle.mjs"),
    );
  });

  it("reads appVersion from the package.json next to the resolved package root", () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const expectedVersion = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
      ).version;
    expect(readHyperfideAppPackageVersion(packageRoot)).toBe(expectedVersion);
  });

  it("falls back to the dev sentinel when package.json is missing", () => {
    expect(readHyperfideAppPackageVersion("/nonexistent/hyperfide-app/path")).toBe(
      "0.0.0-dev",
    );
  });

  it("honors explicit production ports and data directory", () => {
    const env = {
      HYPERFIDE_DATA_DIR: "~/custom-hyperfide",
      HYPERFIDE_HOST_DAEMON_PORT: "48887",
      HYPERFIDE_SERVER_PORT: "48886",
    };

    expect(resolveDataDir({ env, homeDir: "/home/tester" })).toBe(
      resolve("/home/tester/custom-hyperfide"),
    );
    expect(
      resolvePortFromEnv({
        defaultPort: 1,
        env,
        name: "HYPERFIDE_SERVER_PORT",
      }),
    ).toBe(48886);
    expect(
      resolvePortFromEnv({
        defaultPort: 1,
        env,
        name: "HYPERFIDE_HOST_DAEMON_PORT",
      }),
    ).toBe(48887);
  });

  it("creates host enroll-key request bodies", () => {
    expect(createHostEnrollKeyRequestBody({ requestedHostId: null })).toEqual(
      {},
    );
    expect(
      createHostEnrollKeyRequestBody({
        requestedHostId: "host_local",
      }),
    ).toEqual({
      hostId: "host_local",
    });
  });

  it("starts hyperfide when no command or the explicit start command is provided", () => {
    expect(resolveHyperfideAppCommand([])).toEqual({ kind: "start" });
    expect(resolveHyperfideAppCommand(["start"])).toEqual({ kind: "start" });
  });

  it("stops hyperfide on the explicit stop command only", () => {
    expect(resolveHyperfideAppCommand(["stop"])).toEqual({ kind: "stop" });
    expect(resolveHyperfideAppCommand(["stop", "now"])).toEqual({
      command: "stop",
      kind: "invalid",
    });
  });

  it("keeps CLI commands on the hyperfide binary", () => {
    expect(resolveHyperfideAppCommand(["status"])).toEqual({
      command: "status",
      kind: "invalid",
    });
    expect(resolveHyperfideAppCommand(["thread", "list"])).toEqual({
      command: "thread",
      kind: "invalid",
    });
  });

  it("starts only the host daemon for the explicit host-daemon start command", () => {
    expect(resolveHyperfideAppCommand(["host-daemon"])).toEqual({
      args: [],
      kind: "host-daemon",
    });
    expect(resolveHyperfideAppCommand(["host-daemon", "join"])).toEqual({
      args: ["join"],
      kind: "host-daemon",
    });
  });

  it("prints help for help requests", () => {
    expect(resolveHyperfideAppCommand(["--help"])).toEqual({ kind: "help" });
    expect(resolveHyperfideAppCommand(["help"])).toEqual({ kind: "help" });
  });

  it("parses launcher flags separately from commands", () => {
    expect(
      parseLauncherArgs([
        "host-daemon",
        "join",
        "--data-dir",
        "~/hyperfide-data",
        "--server-url",
        "https://hyperfide.example.test",
        "--join-code",
        "hyperfide_de_supplied",
        "--host-id",
        "host_remote",
        "--host-daemon-port",
        "48887",
        "--auto-update",
      ]),
    ).toEqual({
      options: {
        autoUpdate: true,
        dataDir: "~/hyperfide-data",
        help: false,
        hostDaemonPort: "48887",
        hostId: "host_remote",
        joinCode: "hyperfide_de_supplied",
        json: false,
        serverUrl: "https://hyperfide.example.test",
      },
      positionals: ["host-daemon", "join"],
    });
  });

  it("runs the source update shim for a start unless --no-in-app-updates is passed", () => {
    expect(shouldRunSourceAppUpdateShim([])).toBe(true);
    expect(shouldRunSourceAppUpdateShim(["start"])).toBe(true);
    expect(shouldRunSourceAppUpdateShim(["--no-in-app-updates"])).toBe(false);
    expect(shouldRunSourceAppUpdateShim(["start", "--no-in-app-updates"])).toBe(
      false,
    );
    expect(shouldRunSourceAppUpdateShim(["stop"])).toBe(false);
    expect(shouldRunSourceAppUpdateShim(["start", "--help"])).toBe(false);
  });

  it("keeps accepting --in-app-updates from launchers started by earlier update shims", () => {
    expect(parseLauncherArgs(["start", "--in-app-updates"])).toEqual({
      options: { help: false, json: false },
      positionals: ["start"],
    });
    expect(shouldRunSourceAppUpdateShim(["start", "--in-app-updates"])).toBe(
      true,
    );
    expect(() =>
      parseLauncherArgs(["--in-app-updates", "--no-in-app-updates"]),
    ).toThrow(
      "--in-app-updates and --no-in-app-updates cannot be used together",
    );
  });

  it("passes opt-in performance diagnostics through to the launched server", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-performance-"));
    try {
      for (const enabled of [false, true]) {
        const runtime = await resolveHyperfideAppRuntimeState({
          entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js")
            .href,
          env: { HYPERFIDE_DATA_DIR: dataDir },
          homeDir: "/home/tester",
          options: parseLauncherArgs(enabled ? ["--perf-diagnostics"] : [])
            .options,
          serverUrlMode: "local",
        });
        expect(runtime.serverEnv.HYPERFIDE_PERF_DIAGNOSTICS).toBe(
          enabled ? "1" : undefined,
        );
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reports the server bind host separately from the loopback connection URL", async () => {
    const parsedArgs = parseLauncherArgs(["--server-bind-host", "0.0.0.0"]);
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-bind-host-"));
    const runtime = await resolveHyperfideAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js").href,
      env: { HYPERFIDE_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: parsedArgs.options,
      serverUrlMode: "local",
    });

    expect(parsedArgs.options.serverBindHost).toBe("0.0.0.0");
    expect(runtime.serverEnv.HYPERFIDE_SERVER_BIND_HOST).toBe("0.0.0.0");
    expect(
      resolveServerListenerUrl({
        bindHost: runtime.serverEnv.HYPERFIDE_SERVER_BIND_HOST,
        port: runtime.context.serverPort,
      }),
    ).toBe("http://0.0.0.0:38886");
    expect(runtime.context.serverUrl).toBe("http://127.0.0.1:38886");
  });

  it("strips parent thread context from the production server without stripping the CLI", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-thread-context-"));
    const runtime = await resolveHyperfideAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js").href,
      env: {
        HYPERFIDE_DATA_DIR: dataDir,
        HYPERFIDE_ENVIRONMENT_ID: "env_parent",
        HYPERFIDE_PROJECT_ID: "proj_parent",
        HYPERFIDE_THREAD_ID: "thr_parent",
        HYPERFIDE_THREAD_STORAGE:
          "/home/tester/.hyperfide/thread-storage/thr_parent",
      },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
    });

    expect(runtime.serverEnv.HYPERFIDE_ENVIRONMENT_ID).toBeUndefined();
    expect(runtime.serverEnv.HYPERFIDE_THREAD_ID).toBeUndefined();
    expect(runtime.serverEnv.HYPERFIDE_THREAD_STORAGE).toBeUndefined();
    expect(runtime.serverEnv.HYPERFIDE_PROJECT_ID).toBe("proj_parent");

    const daemonEnv = createDaemonEnv({
      context: runtime.context,
      env: runtime.env,
      serverUrl: runtime.context.serverUrl,
    });
    expect(daemonEnv.HYPERFIDE_ENVIRONMENT_ID).toBeUndefined();
    expect(daemonEnv.HYPERFIDE_THREAD_ID).toBeUndefined();
    expect(daemonEnv.HYPERFIDE_THREAD_STORAGE).toBeUndefined();
    expect(daemonEnv.HYPERFIDE_PROJECT_ID).toBe("proj_parent");

    expect(runtime.env.HYPERFIDE_ENVIRONMENT_ID).toBe("env_parent");
    expect(runtime.env.HYPERFIDE_THREAD_ID).toBe("thr_parent");
    expect(runtime.env.HYPERFIDE_THREAD_STORAGE).toBe(
      "/home/tester/.hyperfide/thread-storage/thr_parent",
    );

    const cliThreadIdPath = join(dataDir, "cli-thread-id.txt");
    const exitCode = await runBundledCliCommand({
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.env.HYPERFIDE_THREAD_ID ?? 'missing')",
        cliThreadIdPath,
      ],
      context: runtime.context,
      env: { ...runtime.env, HYPERFIDE_CLI: process.execPath },
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(cliThreadIdPath, "utf8")).toBe("thr_parent");
  });

  it("rejects an invalid server bind host before launcher startup", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-invalid-bind-host-"));

    await expect(
      runHyperfideApp(["--data-dir", dataDir, "--server-bind-host", "localhost"]),
    ).rejects.toThrow(
      'HYPERFIDE_SERVER_BIND_HOST must be "127.0.0.1" or "0.0.0.0"',
    );
  });

  it("tells the bundled CLI where the server's machine installer is", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-cli-installer-"));
    const outputPath = join(dataDir, "installer-path.txt");

    const exitCode = await runBundledCliCommand({
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.env.HYPERFIDE_MACHINE_INSTALLER ?? 'missing')",
        outputPath,
      ],
      context: { ...createTestStartContext(), dataDir },
      env: { HYPERFIDE_CLI: process.execPath },
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(
      join("/tmp/hyperfide-app-test/server/dist", "assets", "install-machine.sh"),
    );
  });

  it("uses a supplied join code without requesting a loopback enroll key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-remote-join-"));
    const context = { ...createTestStartContext(), dataDir };

    const env = await createHostDaemonJoinEnv({
      context,
      env: {
        HYPERFIDE_HOST_ENROLL_KEY: "hyperfide_de_supplied",
        HYPERFIDE_HOST_ID: "host_remote",
        HYPERFIDE_CONNECT_MACHINE_CREDENTIAL: "hyperfide_cm_machine",
        HYPERFIDE_CONNECT_MACHINE_ID: "machine-1",
      },
      serverUrl: "https://hyperfide.example.test",
    });

    expect(env).toMatchObject({
      HYPERFIDE_HOST_ENROLL_KEY: "hyperfide_de_supplied",
      HYPERFIDE_HOST_ID: "host_remote",
    });
    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toMatchObject({
      machineCredential: "hyperfide_cm_machine",
      connectMachineId: "machine-1",
      serverUrl: "https://hyperfide.example.test",
    });
  });

  it("requires the join-code host ID on a fresh machine", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-remote-join-"));

    await expect(
      createHostDaemonJoinEnv({
        context: { ...createTestStartContext(), dataDir },
        env: { HYPERFIDE_HOST_ENROLL_KEY: "hyperfide_de_supplied" },
        serverUrl: "https://hyperfide.example.test",
      }),
    ).rejects.toThrow("--host-id is required when --join-code is supplied");
  });

  it("parses the json launcher flag", () => {
    expect(
      parseLauncherArgs(["client", "ssh-target", "list", "--json"]),
    ).toEqual({
      options: {
        help: false,
        json: true,
      },
      positionals: ["client", "ssh-target", "list"],
    });
  });

  it("uses managed config server URL when env and flags omit it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://hyperfide.example.test" }),
      "utf8",
    );

    const context = (
      await resolveHyperfideAppRuntimeState({
        entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js")
          .href,
        env: { HYPERFIDE_DATA_DIR: dataDir },
        homeDir: "/home/tester",
        options: { help: false },
        serverUrlMode: "managed",
      })
    ).context;

    expect(context.serverUrl).toBe("https://hyperfide.example.test");
  });

  it("uses managed config server URL over ambient env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-server-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://stored.example.test" }),
      "utf8",
    );

    const runtime = await resolveHyperfideAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js").href,
      env: {
        HYPERFIDE_DATA_DIR: dataDir,
        HYPERFIDE_SERVER_URL: "https://ambient.example.test",
      },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "managed",
    });

    expect(runtime.context.serverUrl).toBe("https://stored.example.test");
    expect(runtime.env.HYPERFIDE_SERVER_URL).toBe(
      "https://stored.example.test",
    );
  });

  it("keeps full-stack startup local even when managed config has a server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-local-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://hyperfide.example.test" }),
      "utf8",
    );

    const context = (
      await resolveHyperfideAppRuntimeState({
        entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js")
          .href,
        env: { HYPERFIDE_DATA_DIR: dataDir },
        homeDir: "/home/tester",
        options: { help: false },
        serverUrlMode: "local",
      })
    ).context;

    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
  });

  it("applies managed config environment values over ambient env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-env-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        config: {
          HYPERFIDE_APP_URL: "https://hyperfide.example.test",
          HYPERFIDE_LOG_LEVEL: "debug",
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          OPENAI_API_KEY: "stored-openai-key",
        },
      }),
      "utf8",
    );

    const runtime = await resolveHyperfideAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js").href,
      env: {
        HYPERFIDE_DATA_DIR: dataDir,
        OPENAI_API_KEY: "ambient-openai-key",
      },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
    });

    expect(runtime.env.HYPERFIDE_APP_URL).toBe("https://hyperfide.example.test");
    expect(runtime.env.HYPERFIDE_LOG_LEVEL).toBe("debug");
    expect(runtime.env.OPENAI_API_KEY).toBe("stored-openai-key");
    expect(runtime.serverEnv.HYPERFIDE_LOG_LEVEL).toBe("debug");
    expect(runtime.serverEnv.OPENAI_API_KEY).toBe("stored-openai-key");
  });

  it("applies the worktree policy after conflicting saved environment values", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-worktree-policy-"));
    const storedDataDir = join(dataDir, "stored-data");
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          HYPERFIDE_DATA_DIR: storedDataDir,
          HYPERFIDE_DEV_APP_PORT: "4173",
          HYPERFIDE_HOST_DAEMON_PORT: "48887",
          HYPERFIDE_INHERITED_SKILLS_ROOTS: "/stored/skills",
          HYPERFIDE_SERVER_BIND_HOST: "0.0.0.0",
          HYPERFIDE_SERVER_PORT: "48886",
          OPENAI_API_KEY: "stored-openai-key",
        },
      }),
      "utf8",
    );
    const worktreeEnv: NodeJS.ProcessEnv = {
      HYPERFIDE_DATA_DIR: dataDir,
      HYPERFIDE_HOST_DAEMON_PORT: "47887",
      HYPERFIDE_INHERITED_SKILLS_ROOTS: "/worktree/skills",
      HYPERFIDE_SERVER_PORT: "47886",
    };

    const runtime = await resolveHyperfideAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js").href,
      env: worktreeEnv,
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
      worktreePolicy: resolveWorktreeRuntimePolicy({
        env: worktreeEnv,
        homeDir: "/home/tester",
      }),
    });

    expect(runtime.context).toMatchObject({
      daemonPort: 47887,
      dataDir,
      serverPort: 47886,
      serverUrl: "http://127.0.0.1:47886",
    });
    for (const env of [runtime.env, runtime.serverEnv]) {
      expect(env).toMatchObject({
        HYPERFIDE_DATA_DIR: dataDir,
        HYPERFIDE_HOST_DAEMON_PORT: "47887",
        HYPERFIDE_INHERITED_SKILLS_ROOTS: "/worktree/skills",
        HYPERFIDE_SERVER_BIND_HOST: "127.0.0.1",
        HYPERFIDE_SERVER_PORT: "47886",
        OPENAI_API_KEY: "stored-openai-key",
      });
      expect(env.HYPERFIDE_DEV_APP_PORT).toBeUndefined();
    }
  });

  it("uses launcher flags over managed config and ambient server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-flag-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://stored.example.test" }),
      "utf8",
    );

    const runtime = await resolveHyperfideAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js").href,
      env: {
        HYPERFIDE_DATA_DIR: dataDir,
        HYPERFIDE_SERVER_URL: "https://ambient.example.test",
      },
      homeDir: "/home/tester",
      options: {
        help: false,
        serverUrl: "https://flag.example.test",
      },
      serverUrlMode: "managed",
    });

    expect(runtime.context.serverUrl).toBe("https://flag.example.test");
    expect(runtime.env.HYPERFIDE_SERVER_URL).toBe("https://flag.example.test");
  });

  it("stores managed config values from the config command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-config-command-"));

    await runHyperfideApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "HYPERFIDE_APP_URL",
      "https://hyperfide.example.test",
    ]);
    await runHyperfideApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "HYPERFIDE_LOG_LEVEL",
      "debug",
    ]);
    await runHyperfideApp([
      "--data-dir",
      dataDir,
      "env",
      "set",
      "OPENAI_API_KEY",
      "test-openai-key",
    ]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      config: {
        HYPERFIDE_APP_URL: "https://hyperfide.example.test",
        HYPERFIDE_LOG_LEVEL: "debug",
      },
    });
    expect(JSON.parse(readFileSync(join(dataDir, "env.json"), "utf8"))).toEqual(
      {
        env: {
          OPENAI_API_KEY: "test-openai-key",
        },
      },
    );
    if (process.platform !== "win32") {
      expect(statSync(join(dataDir, "config.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "env.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("stores client SSH targets from the client command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-client-command-"));
    const server = await startHostListTestServer([
      {
        id: "host_1",
        name: "mbp-intel",
        status: "connected",
      },
    ]);

    try {
      await runHyperfideApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "set",
        `${server.url}/projects/proj_1`,
        "mbp-intel",
      ]);

      expect(server.requests()).toContain("GET /api/v1/hosts");
      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toEqual({
        servers: {
          [server.url]: {
            hosts: {
              host_1: {
                sshAuthority: "mbp-intel",
              },
            },
          },
        },
      });
      if (process.platform !== "win32")
        expect(statSync(join(dataDir, "client.json")).mode & 0o777).toBe(0o600);

      await runHyperfideApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "set",
        server.url,
        "buildbox",
        "--host-id",
        "host_2",
      ]);
      expect(
        server.requests().filter((request) => request.includes("/hosts")),
      ).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toMatchObject({
        servers: {
          [server.url]: {
            hosts: {
              host_1: { sshAuthority: "mbp-intel" },
              host_2: { sshAuthority: "buildbox" },
            },
          },
        },
      });

      await runHyperfideApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "remove",
        server.url,
        "--host-id",
        "host_2",
      ]);
      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toEqual({
        servers: {
          [server.url]: {
            hosts: {
              host_1: { sshAuthority: "mbp-intel" },
            },
          },
        },
      });

      await runHyperfideApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "remove",
        server.url,
      ]);

      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toEqual({
        servers: {},
      });
    } finally {
      await server.close();
    }
  });

  it("loads a config that still carries the removed customAcpAgents array and drops it on the next write", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-config-custom-acp-"));
    writeFileSync(
      join(dataDir, "config.json"),
      `${JSON.stringify({
        customAcpAgents: [
          { id: "my-agent", displayName: "My Agent", command: "my-agent" },
          { id: "bad agent" },
        ],
      })}\n`,
      "utf8",
    );

    await runHyperfideApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "HYPERFIDE_APP_URL",
      "https://hyperfide.example.test",
    ]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      config: {
        HYPERFIDE_APP_URL: "https://hyperfide.example.test",
      },
    });
  });

  it("keeps secrets out of the config command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-secret-config-"));

    await expect(
      runHyperfideApp([
        "--data-dir",
        dataDir,
        "config",
        "set",
        "OPENAI_API_KEY",
        "test-openai-key",
      ]),
    ).rejects.toThrow(/hyperfide-app env set OPENAI_API_KEY/u);
  });

  it("rejects invalid server bind hosts before writing managed env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-invalid-bind-env-"));
    const envPath = join(dataDir, "env.json");
    const initialEnvFile = {
      env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
    };
    writeFileSync(envPath, JSON.stringify(initialEnvFile), "utf8");

    await expect(
      runHyperfideApp([
        "--data-dir",
        dataDir,
        "env",
        "set",
        "HYPERFIDE_SERVER_BIND_HOST",
        "localhost",
      ]),
    ).rejects.toThrow(
      'HYPERFIDE_SERVER_BIND_HOST must be "127.0.0.1" or "0.0.0.0"',
    );

    expect(JSON.parse(readFileSync(envPath, "utf8"))).toEqual(initialEnvFile);
  });

  it("unsets an invalid server bind host already in managed env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-recover-bind-env-"));
    const envPath = join(dataDir, "env.json");
    writeFileSync(
      envPath,
      JSON.stringify({ env: { HYPERFIDE_SERVER_BIND_HOST: "localhost" } }),
      "utf8",
    );

    await runHyperfideApp([
      "--data-dir",
      dataDir,
      "env",
      "unset",
      "HYPERFIDE_SERVER_BIND_HOST",
    ]);

    expect(JSON.parse(readFileSync(envPath, "utf8"))).toEqual({});
  });

  it("names the env file when a persisted server bind host is invalid", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-bad-bind-env-"));
    const envPath = join(dataDir, "env.json");
    writeFileSync(
      envPath,
      JSON.stringify({ env: { HYPERFIDE_SERVER_BIND_HOST: "localhost" } }),
      "utf8",
    );

    await expect(runHyperfideApp(["--data-dir", dataDir])).rejects.toThrow(envPath);
  });

  it("blames the flag, not the env file, for an invalid flag value", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-bad-bind-flag-"));
    const envPath = join(dataDir, "env.json");
    writeFileSync(
      envPath,
      JSON.stringify({ env: { HYPERFIDE_SERVER_BIND_HOST: "localhost" } }),
      "utf8",
    );

    const failure = await runHyperfideApp([
      "--data-dir",
      dataDir,
      "--server-bind-host",
      "0.0.0.0.0",
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("HYPERFIDE_SERVER_BIND_HOST");
    expect((failure as Error).message).not.toContain(envPath);
  });

  it("rejects invalid env key names", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-invalid-env-"));

    await expect(
      runHyperfideApp(["--data-dir", dataDir, "env", "set", "1BAD", "value"]),
    ).rejects.toThrow(/Invalid env key/u);
  });

  it("uses the explicit server bind host flag over managed env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-bind-host-env-"));
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({ env: { HYPERFIDE_SERVER_BIND_HOST: "0.0.0.0" } }),
      "utf8",
    );
    const parsedArgs = parseLauncherArgs(["--server-bind-host", "127.0.0.1"]);

    const runtime = await resolveHyperfideAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/hyperfide-app/dist/hyperfide-app.js").href,
      env: { HYPERFIDE_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: parsedArgs.options,
      serverUrlMode: "local",
    });

    expect(runtime.serverEnv.HYPERFIDE_SERVER_BIND_HOST).toBe("127.0.0.1");
  });

  it("rejects invalid managed config values before writing or reloading", async () => {
    const server = await startConfigReloadTestServer();
    try {
      for (const testCase of invalidConfigCommandCases) {
        const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-invalid-config-"));
        const configPath = join(dataDir, "config.json");
        const initialConfig = {
          config: {
            HYPERFIDE_APP_URL: "https://existing.example.test",
          },
        };
        writeFileSync(
          configPath,
          `${JSON.stringify(initialConfig, null, 2)}\n`,
          "utf8",
        );

        await expect(
          runHyperfideApp([
            "--data-dir",
            dataDir,
            "--server-port",
            String(server.port),
            "config",
            "set",
            testCase.key,
            testCase.value,
          ]),
        ).rejects.toThrow(testCase.expectedError);

        expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(
          initialConfig,
        );
      }

      expect(server.reloadCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("prints a restart notice when setting a startup-only config key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-startup-config-set-"));
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runHyperfideApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "config",
          "set",
          "HYPERFIDE_LOG_LEVEL",
          "debug",
        ]),
      );

      expect(output).toContain(
        "HYPERFIDE_LOG_LEVEL is startup-only. The running process keeps its current value; a full hyperfide-app restart is required to apply this change. Run `hyperfide-app stop && hyperfide-app start`, or restart the desktop app.",
      );
      expect(output).not.toContain("Reloaded running hyperfide-platform server config.");
      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("prints restart notices for every server startup-only managed env key", async () => {
    const server = await startConfigReloadTestServer();

    try {
      for (const testCase of startupOnlyManagedEnvCases) {
        const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-startup-env-set-"));
        const output = await captureStdout(() =>
          runHyperfideApp([
            "--data-dir",
            dataDir,
            "--server-port",
            String(server.port),
            "env",
            "set",
            testCase.key,
            testCase.value,
          ]),
        );

        expect(output).toContain(
          `${testCase.key} is startup-only. The running process keeps its current value; a full hyperfide-app restart is required to apply this change.`,
        );
        expect(output).not.toContain("Reloaded running hyperfide-platform server config.");
      }
      expect(server.reloadCount()).toBe(startupOnlyManagedEnvCases.length);
    } finally {
      await server.close();
    }
  });

  it("warns that wildcard exposure remains after unsetting the server bind host", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-startup-bind-unset-"));
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({ env: { HYPERFIDE_SERVER_BIND_HOST: "0.0.0.0" } }),
      "utf8",
    );
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runHyperfideApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "env",
          "unset",
          "HYPERFIDE_SERVER_BIND_HOST",
        ]),
      );

      expect(output).toContain(
        "HYPERFIDE_SERVER_BIND_HOST is startup-only. The running process keeps its current value; a full hyperfide-app restart is required to apply this change. Run `hyperfide-app stop && hyperfide-app start`, or restart the desktop app.",
      );
      expect(output).toContain(
        "Until then, the server keeps its previous bind address. If it was bound to 0.0.0.0, that network exposure remains open.",
      );
      expect(output).not.toContain("Reloaded running hyperfide-platform server config.");
      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("keeps the reload confirmation for reloadable keys", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-reloadable-env-set-"));
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runHyperfideApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "env",
          "set",
          "OPENAI_API_KEY",
          "test-openai-key",
        ]),
      );

      expect(output).toContain("Reloaded running hyperfide-platform server config.");
      expect(output).not.toContain("is startup-only");
    } finally {
      await server.close();
    }
  });

  it("reports that startup-only config will apply on next start without a running server", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-startup-next-start-"));
    const unavailableServer = await startConfigReloadTestServer();
    const unavailablePort = unavailableServer.port;
    await unavailableServer.close();

    const output = await captureStdout(() =>
      runHyperfideApp([
        "--data-dir",
        dataDir,
        "--server-port",
        String(unavailablePort),
        "env",
        "set",
        "HYPERFIDE_SERVER_BIND_HOST",
        "0.0.0.0",
      ]),
    );

    expect(output).toContain("config will apply on next start.");
    expect(output).not.toContain("is startup-only");
  });

  it("notes configured startup-only keys after explicit refresh", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-startup-refresh-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ config: { HYPERFIDE_LOG_LEVEL: "debug" } }),
      "utf8",
    );
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          HYPERFIDE_FF_PLACEHOLDER: "true",
          HYPERFIDE_SERVER_BIND_HOST: "0.0.0.0",
          HYPERFIDE_SERVER_PORT: "48886",
        },
      }),
      "utf8",
    );
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runHyperfideApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "config",
          "refresh",
        ]),
      );

      expect(output).toContain("Reloaded running hyperfide-platform server config.");
      expect(output).toContain(
        "HYPERFIDE_FF_PLACEHOLDER, HYPERFIDE_LOG_LEVEL, HYPERFIDE_SERVER_BIND_HOST, HYPERFIDE_SERVER_PORT",
      );
    } finally {
      await server.close();
    }
  });

  it("uses HYPERFIDE_SERVER_URL for config refresh when set", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-config-env-refresh-"));
    const server = await startConfigReloadTestServer();
    const previousServerUrl = process.env.HYPERFIDE_SERVER_URL;

    try {
      process.env.HYPERFIDE_SERVER_URL = server.url;

      await runHyperfideApp(["--data-dir", dataDir, "config", "refresh"]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      if (previousServerUrl === undefined) {
        delete process.env.HYPERFIDE_SERVER_URL;
      } else {
        process.env.HYPERFIDE_SERVER_URL = previousServerUrl;
      }
      await server.close();
    }
  });

  it("uses persisted HYPERFIDE_SERVER_URL for config refresh without env or flags", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-config-persisted-url-"));
    const server = await startConfigReloadTestServer();

    try {
      await runHyperfideApp([
        "--data-dir",
        dataDir,
        "config",
        "set",
        "HYPERFIDE_SERVER_URL",
        server.url,
      ]);

      expect(
        JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
      ).toEqual({
        serverUrl: server.url,
      });
      expect(server.reloadRequests()).toEqual([]);

      await runHyperfideApp(["--data-dir", dataDir, "config", "refresh"]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("uses --server-url over env and persisted config for config refresh", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-config-flag-url-"));
    const configServer = await startConfigReloadTestServer();
    const envServer = await startConfigReloadTestServer();
    const flagServer = await startConfigReloadTestServer();
    const previousServerUrl = process.env.HYPERFIDE_SERVER_URL;

    try {
      await runHyperfideApp([
        "--data-dir",
        dataDir,
        "config",
        "set",
        "HYPERFIDE_SERVER_URL",
        configServer.url,
      ]);

      process.env.HYPERFIDE_SERVER_URL = envServer.url;
      await runHyperfideApp([
        "--data-dir",
        dataDir,
        "--server-url",
        flagServer.url,
        "config",
        "refresh",
      ]);

      expect(configServer.reloadRequests()).toEqual([]);
      expect(envServer.reloadRequests()).toEqual([]);
      expect(flagServer.reloadRequests()).toEqual([
        expectedConfigReloadRequest(flagServer),
      ]);
    } finally {
      if (previousServerUrl === undefined) {
        delete process.env.HYPERFIDE_SERVER_URL;
      } else {
        process.env.HYPERFIDE_SERVER_URL = previousServerUrl;
      }
      await flagServer.close();
      await envServer.close();
      await configServer.close();
    }
  });

  it("observes child processes that exited before wait registration", async () => {
    const childProcess = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolvePromise, reject) => {
      childProcess.once("error", reject);
      childProcess.once("exit", () => {
        resolvePromise();
      });
    });

    await expect(
      Promise.race([waitForProcessExit(childProcess), delay({ ms: 100 })]),
    ).resolves.toEqual({ code: 7, signal: null });
  });

  it("keeps daemon running and starts only a new server after server exit", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      onServerMoved: unexpectedServerMove,
      processes: supervisor.processes,
      readServerMovedFile: noServerMovedFile,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    initialServerRun.exitWith({ code: 1, signal: null });
    const nextServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.serverRun,
      previousRun: initialServerRun,
    });

    expect(initialServerRun.running).toBe(false);
    expect(initialDaemonRun.running).toBe(true);
    expect(supervisor.processes.daemonRun).toBe(initialDaemonRun);
    expect(supervisor.daemonRuns).toHaveLength(1);
    expect(supervisor.serverRuns).toHaveLength(2);
    expect(nextServerRun).toBe(supervisor.serverRuns[1]);
    expect(supervisor.serverRuns[1]?.running).toBe(true);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("keeps server running and starts only a new daemon after daemon exit", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      onServerMoved: unexpectedServerMove,
      processes: supervisor.processes,
      readServerMovedFile: noServerMovedFile,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    initialDaemonRun.exitWith({ code: 1, signal: null });
    const nextDaemonRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.daemonRun,
      previousRun: initialDaemonRun,
    });

    expect(initialDaemonRun.running).toBe(false);
    expect(initialServerRun.running).toBe(true);
    expect(supervisor.processes.serverRun).toBe(initialServerRun);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.daemonRuns).toHaveLength(2);
    expect(nextDaemonRun).toBe(supervisor.daemonRuns[1]);
    expect(supervisor.daemonRuns[1]?.running).toBe(true);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("terminates both children without restarting during shutdown", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      onServerMoved: unexpectedServerMove,
      processes: supervisor.processes,
      readServerMovedFile: noServerMovedFile,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    supervisor.setShutdownRequested(true);
    await terminateManagedFullStackProcesses({
      processes: supervisor.processes,
      signal: "SIGINT",
    });

    await expect(supervision).resolves.toBe("shutdown");
    expect(initialServerRun.running).toBe(false);
    expect(initialDaemonRun.running).toBe(false);
    expect(initialServerRun.terminationSignals).toEqual(["SIGINT"]);
    expect(initialDaemonRun.terminationSignals).toEqual(["SIGINT"]);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.daemonRuns).toHaveLength(1);
  });

  it("sets exit code to 0 after clean full-stack shutdown", async () => {
    const previousExitCode = process.exitCode;
    const supervisor = createFakeSupervisor();
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      onServerMoved: unexpectedServerMove,
      processes: supervisor.processes,
      readServerMovedFile: noServerMovedFile,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    try {
      process.exitCode = 1;
      supervisor.setShutdownRequested(true);
      const shutdownPromise = terminateManagedFullStackProcesses({
        processes: supervisor.processes,
        signal: "SIGINT",
      });
      const supervisionResult = await supervision;

      await completeFullStackSupervision({
        shutdownPromise,
        supervisionResult,
      });

      expect(process.exitCode).toBe(0);
      expect(supervisor.serverRuns).toHaveLength(1);
      expect(supervisor.daemonRuns).toHaveLength(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("throttles repeated healthy child exits before restarting", async () => {
    const restartThrottle = new ControlledDelay();
    const supervisor = createFakeSupervisor();
    const firstServerRun = supervisor.serverRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: (args) => restartThrottle.delayMilliseconds(args),
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      onServerMoved: unexpectedServerMove,
      processes: supervisor.processes,
      readServerMovedFile: noServerMovedFile,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    firstServerRun.exitWith({ code: 1, signal: null });
    const firstDelay = await waitForDelayCall({
      delay: restartThrottle,
      index: 0,
    });
    expect(firstDelay.ms).toBe(1_000);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.processes.serverRun).toBeNull();
    firstDelay.resolve();

    const secondServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.serverRun,
      previousRun: firstServerRun,
    });
    expect(supervisor.serverRuns).toHaveLength(2);

    supervisor.serverRuns[1]?.exitWith({ code: 1, signal: null });
    const secondDelay = await waitForDelayCall({
      delay: restartThrottle,
      index: 1,
    });
    expect(secondDelay.ms).toBe(1_000);
    expect(supervisor.serverRuns).toHaveLength(2);
    expect(supervisor.processes.serverRun).toBeNull();
    secondDelay.resolve();

    const thirdServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.serverRun,
      previousRun: secondServerRun,
    });
    expect(thirdServerRun).toBe(supervisor.serverRuns[2]);
    expect(supervisor.serverRuns).toHaveLength(3);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("runs the bundled CLI with the launcher's own Node runtime", () => {
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        bundledCliPath: "/opt/hyperfide/host-daemon/dist/hyperfide",
        cliOverride: null,
        nodePath: "/Applications/Hyperfide.app/Contents/MacOS/hyperfide",
        platform: "darwin",
      }),
    ).toEqual({
      command: "/Applications/Hyperfide.app/Contents/MacOS/hyperfide",
      args: ["/opt/hyperfide/host-daemon/dist/hyperfide", "status"],
    });
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        bundledCliPath: "C:\\hyperfide\\host-daemon\\dist\\hyperfide",
        cliOverride: null,
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\hyperfide\\host-daemon\\dist\\hyperfide", "status"],
    });
  });

  it("runs a HYPERFIDE_CLI override directly, or through Node when it is extensionless on Windows", () => {
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        bundledCliPath: "C:\\hyperfide\\host-daemon\\dist\\hyperfide",
        cliOverride: "C:\\dev\\hyperfide",
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\dev\\hyperfide", "status"],
    });
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        bundledCliPath: "C:\\hyperfide\\host-daemon\\dist\\hyperfide",
        cliOverride: "C:\\tools\\hyperfide.exe",
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
      }),
    ).toEqual({ command: "C:\\tools\\hyperfide.exe", args: ["status"] });
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        bundledCliPath: "/opt/hyperfide/host-daemon/dist/hyperfide",
        cliOverride: "/repo/apps/cli/bin/hyperfide-platform",
        nodePath: "/usr/bin/node",
        platform: "linux",
      }),
    ).toEqual({
      command: "/repo/apps/cli/bin/hyperfide-platform",
      args: ["status"],
    });
  });

  it("limits npm package metadata to documented runtimes", () => {
    const metadata = readPackageMetadata();

    expect(metadata.engines.node).toBe("^22.19.0 || ^24.0.0 || ^26.0.0");
    expect(metadata.files).toContain(
      "host-daemon/dist/hyperfide-plugin-host-worker.mjs",
    );
    expect(metadata.files).toContain("host-daemon/dist/hyperfide");
    expect(metadata.files).toContain("host-daemon/dist/hyperfide.cmd");
    expect(metadata.files).toContain("host-daemon/dist/hyperfide-chunks");
    expect(metadata.os).toEqual(["darwin", "linux", "win32"]);
  });

  it("requires the bundled CLI's chunk directory next to host-daemon/dist/hyperfide", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "hyperfide-app-artifacts-"));
    try {
      const context = resolveHyperfideAppStartContext({
        entrypointUrl: pathToFileURL(join(packageRoot, "dist", "hyperfide.js")).href,
        env: {},
        homeDir: join(packageRoot, "home"),
      });
      for (const artifact of [
        context.serverEntry,
        context.daemonEntry,
        join(context.daemonBundleDir, "hyperfide"),
        join(context.daemonBundleDir, "hyperfide-provider-bridge-worker.mjs"),
        join(context.daemonBundleDir, "hyperfide-parcel-watcher-child.mjs"),
        join(context.daemonBundleDir, "hyperfide-plugin-host-worker.mjs"),
        join(context.appDistDir, "index.html"),
      ]) {
        mkdirSync(dirname(artifact), { recursive: true });
        writeFileSync(artifact, "");
      }

      const missingChunks = `Missing bundled hyperfide CLI chunks at ${join(packageRoot, "host-daemon", "dist", "hyperfide-chunks")}. Rebuild hyperfide-app`;
      expect(() => assertHyperfideAppArtifacts(context)).toThrow(missingChunks);

      const chunkDir = join(context.daemonBundleDir, "hyperfide-chunks");
      mkdirSync(chunkDir);
      expect(() => assertHyperfideAppArtifacts(context)).toThrow(missingChunks);

      writeFileSync(join(chunkDir, "chunk-AAAAAAAA.js"), "");
      expect(() => assertHyperfideAppArtifacts(context)).not.toThrow();

      rmSync(context.serverEntry);
      rmSync(join(context.appDistDir, "index.html"));
      expect(() => assertHyperfideHostArtifacts(context)).not.toThrow();
      expect(() => assertHyperfideAppArtifacts(context)).toThrow(
        /^Missing server entry/u,
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("prunes stale hyperfide CLI chunks from package build output", () => {
    const pruneScript = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "prune-hyperfide-chunks.mjs",
    );
    const packageRoot = mkdtempSync(join(tmpdir(), "hyperfide-app-prune-"));
    try {
      const chunkDir = join(packageRoot, "host-daemon", "dist", "hyperfide-chunks");
      mkdirSync(chunkDir, { recursive: true });
      writeFileSync(
        join(packageRoot, "host-daemon", "dist", "hyperfide"),
        'import"./hyperfide-chunks/chunk-LIVE.js";\n',
      );
      writeFileSync(join(chunkDir, "chunk-LIVE.js"), "export var a=1;\n");
      writeFileSync(join(chunkDir, "chunk-STALE.js"), "export var s=1;\n");
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "hyperfide-app-prune-fixture",
          version: "0.0.1",
          files: ["host-daemon/dist/hyperfide", "host-daemon/dist/hyperfide-chunks"],
        }),
      );

      execFileSync("node", [pruneScript], { cwd: packageRoot });
      expect(readdirSync(chunkDir)).toEqual(["chunk-LIVE.js"]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("keeps the desktop app surface the desktop shell passes to the server", () => {
    const context = createTestStartContext();

    const desktopServerEnv = createServerEnv({
      cliLauncherPath: null,
      context,
      env: { HYPERFIDE_APP_SURFACE: "desktop" },
      install: { kind: "desktop" },
    });
    const webServerEnv = createServerEnv({
      cliLauncherPath: null,
      context,
      env: {},
      install: { kind: "npm" },
    });
    const invalidSurfaceServerEnv = createServerEnv({
      cliLauncherPath: null,
      context,
      env: { HYPERFIDE_APP_SURFACE: "bogus" },
      install: { kind: "npm" },
    });

    expect(desktopServerEnv.HYPERFIDE_APP_SURFACE).toBe("desktop");
    expect(webServerEnv.HYPERFIDE_APP_SURFACE).toBe("web");
    expect(invalidSurfaceServerEnv.HYPERFIDE_APP_SURFACE).toBe("web");
  });

  it("replaces inherited install markers so a fork never reports a stale commit", () => {
    const serverEnv = createServerEnv({
      cliLauncherPath: null,
      context: createTestStartContext(),
      env: {
        HYPERFIDE_APP_INSTALL_KIND: "source",
        HYPERFIDE_APP_SOURCE_COMMIT: "a".repeat(40),
        HYPERFIDE_APP_SOURCE_ORIGIN: "official",
      },
      install: { kind: "source", origin: "fork" },
    });

    expect(serverEnv.HYPERFIDE_APP_INSTALL_KIND).toBe("source");
    expect(serverEnv.HYPERFIDE_APP_SOURCE_ORIGIN).toBe("fork");
    expect(serverEnv).not.toHaveProperty("HYPERFIDE_APP_SOURCE_COMMIT");
  });

  it("tells the server about the hyperfide command launcher only when this start wrote one", () => {
    const context = createTestStartContext();

    expect(
      createServerEnv({
        cliLauncherPath: "/home/me/.hyperfide/bin/hyperfide",
        context,
        env: { HYPERFIDE_CLI_LAUNCHER: "/stale/bin/hyperfide" },
        install: { kind: "npm" },
      }).HYPERFIDE_CLI_LAUNCHER,
    ).toBe("/home/me/.hyperfide/bin/hyperfide");
    expect(
      createServerEnv({
        cliLauncherPath: null,
        context,
        env: { HYPERFIDE_CLI_LAUNCHER: "/stale/bin/hyperfide" },
        install: { kind: "source", origin: "none" },
      }),
    ).not.toHaveProperty("HYPERFIDE_CLI_LAUNCHER");
  });
});

it("preserves machine identity and access headers through real config set and unset", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-app-config-machine-"));
  const identity = {
    serverUrl: "https://machine.example",
    serverHeaders: { "x-hyperfide-connect-machine": "private-machine-access" },
    machineCredential: "legacy-private",
    connectMachineId: "cloud-device",
  };
  try {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(identity));
    await runHyperfideApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "HYPERFIDE_APP_URL",
      "https://other.example",
    ]);
    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toMatchObject(identity);
    await runHyperfideApp([
      "--data-dir",
      dataDir,
      "config",
      "unset",
      "HYPERFIDE_APP_URL",
    ]);
    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual(identity);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
