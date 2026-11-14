import { spawn } from "node:child_process";
import { createHash, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, expectTypeOf, test } from "vitest";
import {
  createNodeHyperfideSdk as createRootHyperfideSdk,
  createHttpTransport,
  SystemInstallError as RootSystemInstallError,
  type SystemInstallErrorCode,
  type SystemInstallStatusArgs,
  type SystemInstallStatusResult,
} from "@hyperfide/sdk";
import {
  createNodeHyperfideSdk,
  SystemInstallError as NodeSystemInstallError,
} from "@hyperfide/sdk/node";
import {
  createBrowserHyperfideSdk,
  SystemInstallError as BrowserSystemInstallError,
} from "@hyperfide/sdk/browser";
import {
  createHyperfideSdk as createCoreHyperfideSdk,
  SystemInstallError as CoreSystemInstallError,
} from "@hyperfide/sdk/core";

interface StatusFixture {
  origin: string;
  ca_file: string;
  run_id: string;
  operation_id: string;
  predecessor_operation_id: string;
  runner: { credential_id: string; key_file: string };
  operator: { credential_id: string; key_file: string };
  expected: SystemInstallStatusResult;
}

async function install_status_reads_actual_ready_and_preserves_typed_errors() {
  expectTypeOf<
    RootSystemInstallError["code"]
  >().toEqualTypeOf<SystemInstallErrorCode>();
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const fixture = spawn(
    "python3",
    [
      "tests/hyperfide/support/withpg.py",
      "--",
      "python3",
      "tests/hyperfide/cases/source_control/fixtures/install/sdk_status.py",
    ],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(210_000),
    },
  );
  let output = "",
    stderr = "";
  fixture.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const lines = createInterface({ input: fixture.stdout });
  const exited = new Promise<number | null>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.once("exit", resolve);
  });
  try {
    const actual = await new Promise<StatusFixture>((resolve, reject) => {
      lines.on("line", (line) => {
        output += line + "\n";
        if (line.startsWith("SDK_INSTALL_READY ")) {
          try {
            resolve(JSON.parse(line.slice("SDK_INSTALL_READY ".length)));
          } catch (error) {
            reject(error);
          }
        }
      });
      exited.then(
        (code) =>
          reject(
            new Error(`Install producer exited ${code}: ${stderr}\n${output}`),
          ),
        reject,
      );
    });
    const ca = readFileSync(actual.ca_file);
    // This fetch implementation uses real HTTPS with the fixture CA. It does
    // not replace the control-plane service, action, authentication or result.
    const fetchStatus: typeof fetch = async (input, init) =>
      new Promise<Response>((resolve, reject) => {
        const request = https.request(
          String(input),
          {
            method: init?.method,
            ca,
            minVersion: "TLSv1.3",
            headers: Object.fromEntries(new Headers(init?.headers)),
            signal: init?.signal ?? undefined,
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.once("error", reject);
            incoming.once("end", () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: incoming.statusCode,
                  headers: {
                    "content-type": String(incoming.headers["content-type"]),
                  },
                }),
              ),
            );
          },
        );
        request.once("error", reject);
        request.end(init?.body);
      });
    const connection = { baseUrl: actual.origin, fetch: fetchStatus };
    const entries = [
      {
        sdk: createRootHyperfideSdk(connection),
        SystemInstallError: RootSystemInstallError,
      },
      {
        sdk: createNodeHyperfideSdk(connection),
        SystemInstallError: NodeSystemInstallError,
      },
      {
        sdk: createBrowserHyperfideSdk(connection),
        SystemInstallError: BrowserSystemInstallError,
      },
      {
        sdk: createCoreHyperfideSdk({
          transport: createHttpTransport({ ...connection, runtime: "node" }),
        }),
        SystemInstallError: CoreSystemInstallError,
      },
    ];
    function args(
      identity: StatusFixture["runner"] = actual.runner,
    ): SystemInstallStatusArgs {
      const key = readFileSync(identity.key_file);
      return {
        operationId: actual.operation_id,
        runId: actual.run_id,
        authorityUrl: actual.origin,
        authenticate({ endpoint, method, body }) {
          const url = new URL(endpoint),
            time = String(Math.floor(Date.now() / 1000)),
            nonce = randomUUID();
          const digest =
            "sha256:" + createHash("sha256").update(body).digest("hex");
          const bytes = Buffer.from(
            [
              "HYPERFIDE-REQUEST-V1",
              method,
              url.pathname,
              url.origin,
              identity.credential_id,
              time,
              nonce,
              digest,
              "",
            ].join("\n"),
          );
          return {
            "HF-Credential-Id": identity.credential_id,
            "HF-Request-Time": time,
            "HF-Request-Nonce": nonce,
            "HF-Request-Signature": sign(null, bytes, key).toString(
              "base64url",
            ),
          };
        },
      };
    }
    for (const { sdk, SystemInstallError } of entries) {
      const ready = await sdk.system.installStatus(args());
      expectTypeOf(ready).toEqualTypeOf<SystemInstallStatusResult>();
      expect(ready).toEqual(actual.expected);
      expect(ready.state).toBe("READY");
      expect(ready.receipt?.receipt_digest).toBe(ready.receipt_digest);
      expect(await sdk.system.installStatus(args())).toEqual(ready);
      for (const [input, code] of [
        [{ ...args(), operationId: randomUUID() }, "FLEET_INSTALL_NOT_FOUND"],
        [
          { ...args(), operationId: actual.predecessor_operation_id },
          "FLEET_INSTALL_SUPERSEDED",
        ],
        [args(actual.operator), "FLEET_INSTALL_SCOPE"],
      ] as const) {
        try {
          await sdk.system.installStatus(input);
          throw new Error(`Expected ${code}`);
        } catch (error) {
          expect(error).toBeInstanceOf(SystemInstallError);
          if (!(error instanceof SystemInstallError)) throw error;
          expectTypeOf(error.code).toEqualTypeOf<SystemInstallErrorCode>();
          expect(error.code).toBe(code);
          expect(error.body).toMatchObject({
            ok: false,
            error: { code },
          });
        }
      }
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        sdk.system.installStatus({ ...args(), signal: aborted.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    }
  } finally {
    fixture.stdin.end("close\n");
    const code = await exited;
    lines.close();
    expect(code, stderr + "\n" + output).toBe(0);
  }
}

test(
  install_status_reads_actual_ready_and_preserves_typed_errors.name,
  install_status_reads_actual_ready_and_preserves_typed_errors,
  240_000,
);
