import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createSignedSourceClient } from "../../../core/authority-client/src/source.ts";
import { SourceMetadata } from "../../../core/control-plane/dist/source_control/metadata.js";
import { pathToFileURL } from "node:url";
import { createFakePluginHost } from "../../../sdk/plugins/src/testing/index.ts";
import pg from "../../../core/control-plane/node_modules/pg/lib/index.js";

const { config } = JSON.parse(
  await fs.readFile(process.env.SOURCE_SIGNED_TRANSPORT_INPUT, "utf8"),
);
const directory = path.dirname(process.env.SOURCE_SIGNED_TRANSPORT_INPUT),
  filename = path.join(directory, "product-source.json");
await fs.writeFile(filename, JSON.stringify(config), { mode: 0o600 });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const checks = [];
try {
  const metadata = new SourceMetadata(pool);
  await metadata.registerRepository(config.scope, {
    authority_epoch: "1",
    policy_version: "signed-transport-v1",
    durability_profile: "single-region-verified-s3-v1",
  });
  const client = await createSignedSourceClient(config);
  const tree = await client.call("source.objects.put", {
    kind: "tree-leaf",
    payload_base64: Buffer.from('[1,"",[]]').toString("base64"),
  });
  const revisionOperation = randomUUID();
  const base = await client.createRevision(
    {
      change_id: randomUUID(),
      root_tree_id: tree.object_id,
      parent_revision_ids: [],
      predecessor_revision_ids: [],
      provenance: {
        author: { name: "Product CLI qualification", email: "" },
        message: "CLI base",
        timestamp: new Date().toISOString(),
      },
    },
    { operation_id: revisionOperation, idempotency_key: revisionOperation },
  );
  const root = path.resolve(import.meta.dirname, "../../..");
  execFileSync(
    process.execPath,
    [
      path.join(root, "tools/workspace/build-node-entry.mjs"),
      "src/index.ts",
      "dist/index.js",
      "--clean-dist",
      "--split",
    ],
    { cwd: path.join(root, "apps/cli"), stdio: "pipe" },
  );
  const cliEnvironment = { ...process.env };
  delete cliEnvironment.HYPERFIDE_CLI;
  delete cliEnvironment.HYPERFIDE_CLI_REEXEC;
  const invoke = async (args, operation = randomUUID()) => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "apps/cli/dist/index.js"),
        "source",
        "--config",
        filename,
        "--operation-id",
        operation,
        ...args,
      ],
      {
        cwd: root,
        env: cliEnvironment,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4194304,
      },
    );
    if (result.error) throw result.error;
    assert(result.stdout.trim(), result.stderr);
    return { response: JSON.parse(result.stdout), exitCode: result.status };
  };
  const operation = randomUUID(),
    args = [
      "open",
      base.revision_id,
      "--read-path",
      "main.txt",
      "--write-path",
      "main.txt",
    ];
  const opened = await invoke(args, operation),
    replayed = await invoke(args, operation);
  assert.equal(opened.exitCode, 0);
  assert.deepEqual(replayed, opened);
  assert.equal(opened.response.result.workspace.workspace_id, operation);
  checks.push(
    "actual platform CLI parses native open and reuses one workspace for the original operation",
  );
  const file = path.join(directory, "product-edit.txt");
  await fs.writeFile(file, "CLI durable contents\n", { mode: 0o600 });
  const checkpointOperation = randomUUID(),
    checkpointArgs = [
      "checkpoint",
      operation,
      "main.txt",
      "--file",
      file,
      "--base",
      base.revision_id,
      "--workspace-generation",
      "1",
      "--scope-generation",
      "1",
      "--overlay-generation",
      "1",
    ];
  const checkpoint = await invoke(checkpointArgs, checkpointOperation);
  assert.equal(checkpoint.exitCode, 0);
  assert.equal(checkpoint.response.result.workspace.workspace_generation, "2");
  assert.deepEqual(
    await invoke(checkpointArgs, checkpointOperation),
    checkpoint,
  );
  checks.push(
    "actual platform CLI uploads a file and replays one durable checkpoint through signed TLS",
  );
  const history = await invoke([
    "history",
    checkpoint.response.result.revision_id,
  ]);
  assert.equal(history.exitCode, 0);
  assert.equal(
    history.response.result.entries[0].revision_id,
    checkpoint.response.result.revision_id,
  );
  const lookup = await invoke(["operation", checkpointOperation]);
  assert.equal(lookup.response.result.state, "SUCCEEDED");
  checks.push(
    "actual platform CLI history and operation queries need no local checkout",
  );
  const hosted = await invoke([
    "open",
    checkpoint.response.result.revision_id,
    "--read-path",
    "main.txt",
    "--write-path",
    "main.txt",
    "--mode",
    "SPARSE",
  ]);
  assert.equal(hosted.exitCode, 0);
  const hostDirectory = path.join(directory, "product-host"),
    hostContext = { experimental_paths: { dataDir: hostDirectory } };
  const builtRoot = path.resolve("plugins/environment-slices/.bundled-runtime");
  const sourceHost = (
    await import(pathToFileURL(path.join(builtRoot, "host.js")).href)
  ).default;
  const sourceServer = (
    await import(pathToFileURL(path.join(builtRoot, "server.js")).href)
  ).default;
  let hostCalls = 0;
  const { hyperfide, harness } = createFakePluginHost({
    experimental_callHostRpc: async (call) => {
      hostCalls++;
      return sourceHost.handlers[call.method](call.input, hostContext);
    },
  });
  await sourceServer(hyperfide);
  const attachment = {
    projectId: randomUUID(),
    hostId: randomUUID(),
    sourceConfigFile: filename,
    workspaceId: hosted.response.result.workspace.workspace_id,
    mode: "SPARSE",
  };
  await assert.rejects(
    harness.callRpc("nativeAttach", attachment),
    /source-control plugin/,
  );
  await assert.rejects(
    harness.callRpc("nativeAttach", attachment, {
      experimental_caller: { kind: "plugin", pluginId: "unrelated-plugin" },
    }),
    /source-control plugin/,
  );
  assert.equal(hostCalls, 0);
  const caller = {
    experimental_caller: {
      kind: "plugin",
      pluginId: "hyperfide-source-control",
    },
  };
  const attached = await harness.callRpc("nativeAttach", attachment, caller);
  assert.equal(
    await fs.readFile(path.join(attached.path, "main.txt"), "utf8"),
    "CLI durable contents\n",
  );
  await fs.writeFile(
    path.join(attached.path, "main.txt"),
    "Host edited contents\n",
  );
  const identity = {
    projectId: attachment.projectId,
    workspaceId: attachment.workspaceId,
  };
  const finished = await harness.callRpc("nativeCheckpoint", identity, caller);
  assert.equal(finished.snapshotChain.length, 2);
  const observed = await harness.callRpc("nativeMetrics", identity, caller);
  await assert.rejects(
    harness.callRpc(
      "nativeMetrics",
      { ...identity, projectId: randomUUID() },
      caller,
    ),
    /not attached/,
  );
  assert(observed.materialized.files >= 1);
  assert.equal(observed.dirty.pending_checkpoint, false);
  await harness.lifecycle.dispose();
  checks.push(
    "built environment plugin RPC refuses unauthorized callers, materializes and checkpoints scoped files, and reports measured state",
  );
  const stale = await invoke(checkpointArgs);
  assert.equal(stale.exitCode, 1);
  assert.equal(stale.response.error.code, "WORKSPACE_CHANGED");
  checks.push(
    "actual platform CLI returns typed stale-generation refusal and nonzero exit",
  );
  await fs.mkdir("build/source-control/product", { recursive: true });
  await fs.writeFile(
    "build/source-control/product/cli-receipt.json",
    JSON.stringify(
      {
        status: "PASS",
        scope:
          "freshly built platform CLI and signed production TLS source endpoint",
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.error("source product CLI: " + checks.length + " groups passed");
} finally {
  await pool.end();
}
