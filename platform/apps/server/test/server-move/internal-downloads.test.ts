import { isPostgresTest } from "@hyperfide/db/testing";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostDaemonRpcCommand } from "@hyperfide/host-daemon-contract";
import { createDeferredPromise } from "@hyperfide/test-helpers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createServerErrorHandler } from "../../src/errors.js";
import { setAuthenticatedDaemon } from "../../src/internal/auth.js";
import { registerInternalServerMoveRoutes } from "../../src/internal/server-move.js";
import { createServerMoveCoordinator } from "../../src/services/server-move/coordinator.js";
import {
  createTestServerMoveEnvironment,
  inspectResult,
  registerFakeDaemon,
  type FakeDaemonReply,
} from "../helpers/server-move.js";
import { seedHost, seedPrimaryHost } from "../helpers/seed.js";
import { testLogger, withTestHarness } from "../helpers/test-app.js";

type PrepareCommand = Extract<
  HostDaemonRpcCommand,
  { type: "server_move.prepare" }
>;

describe("server move downloads", () => {
  // Physical archive export uses SQLite backups.
  it.skipIf(isPostgresTest)(
    "streams the archive and the full hyperfide-app package with exact content lengths",
    async () =>
      await withTestHarness(async (harness) => {
        await seedHost(harness.deps, { id: "host-old", name: "Laptop" });
        seedPrimaryHost(harness.deps, "host-old");
        await seedHost(harness.deps, { id: "host-new", name: "Desktop" });
        const artifactDir = await mkdtemp(
          join(tmpdir(), "hyperfide-app-artifact-"),
        );
        try {
          const artifactPath = join(artifactDir, "hyperfide-app-full.tgz");
          const artifactBytes = Buffer.from("full hyperfide-app package bytes");
          await writeFile(artifactPath, artifactBytes);
          const { environment, events } = createTestServerMoveEnvironment(
            harness,
            {
              fullArtifact: {
                availability: async () => ({
                  available: true,
                  unpackedSizeBytes: artifactBytes.byteLength,
                  version: harness.config.appVersion,
                }),
                build: async () => ({
                  path: artifactPath,
                  sha256: createHash("sha256")
                    .update(artifactBytes)
                    .digest("hex"),
                  sizeBytes: artifactBytes.byteLength,
                  version: harness.config.appVersion,
                }),
              },
            },
          );
          const coordinator = await createServerMoveCoordinator(environment);
          const releasePrepare = createDeferredPromise<FakeDaemonReply>();
          const received: { prepare: PrepareCommand | null } = {
            prepare: null,
          };
          await registerFakeDaemon(harness, {
            events,
            hostId: "host-old",
            handle: (request) =>
              request.command.type === "server_move.probe"
                ? {
                    ok: true,
                    result: {
                      reachable: true,
                      message: null,
                      state: "pending",
                    },
                  }
                : { ok: true, result: inspectResult() },
          });
          await registerFakeDaemon(harness, {
            events,
            hostId: "host-new",
            handle: (request) => {
              switch (request.command.type) {
                case "server_move.inspect":
                  return {
                    ok: true,
                    result: inspectResult({
                      hyperfideAppVersion: "0.0.0-alpha.1",
                    }),
                  };
                case "server_move.prepare":
                  received.prepare = request.command;
                  return releasePrepare.promise;
                default:
                  return { ok: true, result: { ok: true } };
              }
            },
          });
          const app = await new Hono();
          app.onError(createServerErrorHandler(testLogger));
          app.use("*", async (context, next) => {
            setAuthenticatedDaemon(context, {
              hostId: context.req.header("x-test-host") ?? "",
              keyId: "test-key",
            });
            await next();
          });
          const internalApi = new Hono();
          registerInternalServerMoveRoutes(internalApi, harness.deps, {
            pending: null,
            serverMove: coordinator,
          });
          app.route("/internal", internalApi);

          await coordinator.start({
            targetHostId: "host-new",
            serverUrl: "https://desktop.example.test",
            stopRunningWork: true,
            archiveExistingTargetServerData: false,
          });
          await expect.poll(() => received.prepare !== null).toBe(true);
          const prepare = received.prepare;
          if (prepare === null || prepare.hyperfideApp === null) {
            throw new Error(
              "The target never received a hyperfide-app download",
            );
          }

          const hyperfideApp = await app.request(
            prepare.hyperfideApp.downloadPath,
            {
              headers: { "x-test-host": "host-new" },
            },
          );
          expect(hyperfideApp.status).toBe(200);
          expect(hyperfideApp.headers.get("content-length")).toBe(
            String(artifactBytes.byteLength),
          );
          expect(Buffer.from(await hyperfideApp.arrayBuffer())).toEqual(
            artifactBytes,
          );
          expect(prepare.hyperfideApp.sizeBytes).toBe(artifactBytes.byteLength);

          const archive = await app.request(prepare.archive.downloadPath, {
            headers: { "x-test-host": "host-new" },
          });
          expect(archive.status).toBe(200);
          expect(archive.headers.get("content-length")).toBe(
            String(prepare.archive.sizeBytes),
          );
          expect((await archive.arrayBuffer()).byteLength).toBe(
            prepare.archive.sizeBytes,
          );

          const forbidden = await app.request(
            prepare.hyperfideApp.downloadPath,
            {
              headers: { "x-test-host": "host-old" },
            },
          );
          expect(forbidden.status).toBe(403);
          expect((await stat(artifactPath)).size).toBe(
            artifactBytes.byteLength,
          );
          await coordinator.cancel();
          releasePrepare.resolve({
            ok: false,
            errorCode: "server_move_cancelled",
            errorMessage: "cancelled",
          });
        } finally {
          await rm(artifactDir, { force: true, recursive: true });
        }
      }),
  );
});
