import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { superviseFullStackProcesses } from "../src/launcher.js";
import type {
  HyperfideAppStartContext,
  ManagedFullStackProcesses,
  ManagedProcessName,
  ManagedProcessRun,
  NamedProcessExitResult,
  ProcessExitResult,
} from "../src/launcher.js";

type ResolveExit = (result: NamedProcessExitResult) => void;

class FakeManagedProcessRun implements ManagedProcessRun {
  readonly exit: Promise<NamedProcessExitResult>;
  readonly terminationSignals: NodeJS.Signals[] = [];
  private resolveExit: ResolveExit = () => undefined;

  constructor(readonly processName: ManagedProcessName) {
    this.exit = new Promise<NamedProcessExitResult>((resolvePromise) => {
      this.resolveExit = resolvePromise;
    });
  }

  exitWith(result: ProcessExitResult): void {
    this.resolveExit({ processName: this.processName, result });
  }

  async terminate(signal: NodeJS.Signals): Promise<void> {
    this.terminationSignals.push(signal);
    this.exitWith({ code: null, signal });
  }
}

describe("full-stack supervisor port takeover", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });

  it("stops its daemon when another healthy server owns the URL", async () => {
    const server = createServer(
      (_request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      },
    );
    servers.push(server);
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the test server to have a TCP address");
    }

    const serverRun = new FakeManagedProcessRun("server");
    const daemonRun = new FakeManagedProcessRun("daemon");
    const processes: ManagedFullStackProcesses = { daemonRun, serverRun };
    let restartAttempts = 0;
    const context: HyperfideAppStartContext = {
      appDistDir: "/tmp/hyperfide-app-test/app/dist",
      appVersion: "0.0.0-test",
      configFile: "/tmp/hyperfide-app-test/config.json",
      daemonBundleDir: "/tmp/hyperfide-app-test/host-daemon/dist",
      daemonEntry: "/tmp/hyperfide-app-test/host-daemon/dist/daemon-bundle.mjs",
      daemonLockDir: "/tmp/hyperfide-app-test/daemon.lock.lock",
      daemonLockFile: "/tmp/hyperfide-app-test/daemon.lock",
      daemonPort: address.port + 1,
      dataDir: "/tmp/hyperfide-app-test",
      dbPath: "/tmp/hyperfide-app-test/hyperfide.db",
      envFile: "/tmp/hyperfide-app-test/env.json",
      logDir: "/tmp/hyperfide-app-test/logs",
      packageRoot: "/tmp/hyperfide-app-test/package",
      serverEntry: "/tmp/hyperfide-app-test/server/dist/index.js",
      serverPort: address.port,
      serverUrl: `http://127.0.0.1:${String(address.port)}`,
    };
    const supervision = superviseFullStackProcesses({
      context,
      delayMilliseconds: async () => {
        throw new Error("Unexpected server restart delay");
      },
      isShutdownRequested: () => false,
      onServerMoved: async () => {
        throw new Error("Unexpected server move");
      },
      processes,
      readServerMovedFile: async () => null,
      startDaemon: async () => daemonRun,
      startServer: async () => {
        restartAttempts += 1;
        throw new Error("The server port is occupied");
      },
    });

    serverRun.exitWith({ code: 1, signal: null });
    const outcome = await supervision;

    expect(outcome).toBe("stopped");
    expect(restartAttempts).toBe(0);
    expect(daemonRun.terminationSignals).toEqual(["SIGTERM"]);
  });
});
