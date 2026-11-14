import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@hyperfide/plugin-sdk/testing/host";
import entry, { runBinary } from "./host.js";
import { NativeGraphRefusal } from "./contract.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture(body: string) {
  const repository = await mkdtemp(join(tmpdir(), "hyperfide-graph-"));
  dirs.push(repository);
  const binaryPath = join(repository, "cg");
  await writeFile(
    binaryPath,
    `#!/usr/bin/env node\nif(process.argv[2] === '--version') { console.log('Hyperfide 22'); } else { ${body} }`,
    { mode: 0o755 },
  );
  return {
    hostId: "host",
    repository,
    binaryPath,
    timeoutMs: 2000,
    command: "index-status" as const,
  };
}
it("executes JSON commands on the host and verifies the binary", async () => {
  const input = await fixture(
    "console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}));",
  );
  const host = experimental_createHostEntryHarness(entry);
  const result = await host.experimental_call("run", input);
  expect(result.binary).toMatchObject({
    path: input.binaryPath,
    version: "Hyperfide 22",
    ok: true,
  });
  expect(result.binary!.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.data).toEqual({
    args: ["index-status", "--json"],
    cwd: input.repository,
  });
  for (const command of ["survey", "context", "why"] as const) {
    expect(
      (
        await host.experimental_call("run", {
          ...input,
          command,
          target: "a; echo injected",
        })
      ).data.args,
    ).toEqual([command, "a; echo injected", "--json"]);
  }
  await host.experimental_dispose();
});
it("reports missing binaries and malformed JSON", async () => {
  const input = await fixture("console.log('invalid');");
  const host = experimental_createHostEntryHarness(entry);
  await expect(
    host.experimental_call("run", {
      ...input,
      binaryPath: join(input.repository, "missing"),
    }),
  ).rejects.toThrow(/binary missing/);
  await expect(host.experimental_call("run", input)).rejects.toThrow();
  await host.experimental_dispose();
});
it("kills a command that exceeds its deadline", async () => {
  const input = await fixture("setInterval(() => {}, 1000);");
  const host = experimental_createHostEntryHarness(entry);
  await expect(
    host.experimental_call("run", { ...input, timeoutMs: 300 }),
  ).rejects.toThrow(/timed out/);
  await host.experimental_dispose();
});
it("rejects a binary whose version cannot be verified", async () => {
  const input = await fixture("console.log('{}');");
  await writeFile(input.binaryPath, "#!/usr/bin/env node\nprocess.exit(1);\n", {
    mode: 0o755,
  });
  const host = experimental_createHostEntryHarness(entry);
  await expect(host.experimental_call("run", input)).rejects.toThrow(
    /failed verification/,
  );
  await host.experimental_dispose();
});
it("requires protected source configuration for native graph access", async () => {
  const original = process.env.HF_SOURCE_CONFIG;
  delete process.env.HF_SOURCE_CONFIG;
  const host = experimental_createHostEntryHarness(entry);
  try {
    await expect(
      host.experimental_call("run", {
        hostId: "host",
        repository: "/no/local/repository",
        command: "index-status",
        timeoutMs: 2000,
        nativeSource: {
          buildId: "11111111-1111-4111-8111-111111111111",
          revisionId: `sha256:${"a".repeat(64)}`,
          rootTreeId: `sha256:${"b".repeat(64)}`,
        },
      }),
    ).rejects.toThrow(/HF_SOURCE_CONFIG/);
  } finally {
    if (original === undefined) delete process.env.HF_SOURCE_CONFIG;
    else process.env.HF_SOURCE_CONFIG = original;
    await host.experimental_dispose();
  }
});

async function refuses_checkout_commands_when_native_source_has_no_graph_pin() {
  const original = process.env.HF_SOURCE_CONFIG;
  const folder = await mkdtemp(join(tmpdir(), "hyperfide-native-graph-"));
  dirs.push(folder);
  const filename = join(folder, "source.json");
  await writeFile(filename, JSON.stringify({ schema_version: 1 }), {
    mode: 0o600,
  });
  process.env.HF_SOURCE_CONFIG = filename;
  try {
    for (const command of ["survey", "why"] as const) {
      const request = {
        hostId: "host",
        repository: "/no/local/checkout",
        command,
        target: "apps/web.ts",
        timeoutMs: 2000,
      };
      await expect(runBinary(request)).rejects.toBeInstanceOf(
        NativeGraphRefusal,
      );
      await expect(runBinary(request)).rejects.toMatchObject({
        code: "NATIVE_GRAPH_PIN_REQUIRED",
      });
    }
  } finally {
    if (original === undefined) delete process.env.HF_SOURCE_CONFIG;
    else process.env.HF_SOURCE_CONFIG = original;
  }
}
it(refuses_checkout_commands_when_native_source_has_no_graph_pin);

async function refuses_native_checkout_with_invalid_transport_or_conflicting_pin() {
  const original = process.env.HF_SOURCE_CONFIG;
  const folder = await mkdtemp(join(tmpdir(), "hyperfide-native-graph-"));
  dirs.push(folder);
  const filename = join(folder, "source.json");
  const nativeSource = {
    buildId: "11111111-1111-4111-8111-111111111111",
    revisionId: `sha256:${"a".repeat(64)}`,
    rootTreeId: `sha256:${"b".repeat(64)}`,
  };
  await writeFile(
    filename,
    JSON.stringify({ nativeSource, transport: { schema_version: 1 } }),
    { mode: 0o600 },
  );
  process.env.HF_SOURCE_CONFIG = filename;
  try {
    for (const command of ["survey", "why"] as const) {
      const request = {
        hostId: "host",
        repository: "/no/local/checkout",
        command,
        target: "apps/web.ts",
        timeoutMs: 2000,
      };
      await expect(runBinary(request)).rejects.toMatchObject({
        code: "NATIVE_SOURCE_CONFIG_INVALID",
      });
      await expect(
        runBinary({ ...request, nativeSource }),
      ).rejects.toMatchObject({ code: "NATIVE_SOURCE_CONFIG_INVALID" });
      await expect(
        runBinary({
          ...request,
          nativeSource: {
            ...nativeSource,
            revisionId: `sha256:${"c".repeat(64)}`,
          },
        }),
      ).rejects.toMatchObject({ code: "NATIVE_GRAPH_SOURCE_MISMATCH" });
    }
  } finally {
    if (original === undefined) delete process.env.HF_SOURCE_CONFIG;
    else process.env.HF_SOURCE_CONFIG = original;
  }
}
it(refuses_native_checkout_with_invalid_transport_or_conflicting_pin);
