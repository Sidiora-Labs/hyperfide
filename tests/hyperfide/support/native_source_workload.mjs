import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";
const contentRun = randomUUID();
import {
  coldEditBytes,
  campaignManifest,
  validateCampaignReceipt,
  machineIdentity,
  OperationLedger,
  logicalCorpus,
  executeWorkload,
  scheduleCampaignHooks,
  runCampaignHook,
} from "../source-control/workloads/campaign.mjs";
import { storageAccounting } from "../source-control/workloads/storage_observer.mjs";
import {
  credential,
  deploymentConfig,
  observerCounters,
  WorkspaceCustody,
} from "../source-control/workloads/deployment.mjs";
const load = (name) =>
  import(
    pathToFileURL(
      path.join(process.env.SOURCE_CONTROL_MODULE_ROOT, name + ".js"),
    )
  );
const live = process.env.HF_SOURCE_WORKLOAD_LIVE === "1",
  machine = machineIdentity();
const serviceOptions = {};
if (live)
  throw new Error(
    "Full campaigns must use the explicit deployed-service driver",
  );
const actions = [
  "source.capabilities",
  "source.objects.put",
  "source.objects.read",
  "source.trees.patch",
  "source.trees.entries",
  "source.trees.lookup",
  "source.revisions.create",
  "source.revisions.read",
  "source.workspaces.open",
  "source.workspaces.checkpoint",
  "source.workspaces.detail",
  "source.workspaces.close",
  "source.domains.create",
  "source.operations.read",
];
const f = await createNativeAcceptanceFixture({ serviceOptions, actions }),
  checks = [];
const directory = path.resolve("build/source-control/6.2");
await fs.mkdir(directory, { recursive: true });
const backend = serviceOptions.backend ?? f.service.objects.backend;
const manifest = process.env.HF_SOURCE_WORKLOAD_MANIFEST
  ? campaignManifest(
      JSON.parse(
        await fs.readFile(process.env.HF_SOURCE_WORKLOAD_MANIFEST, "utf8"),
      ),
    )
  : campaignManifest({
      schema_version: 1,
      kind: "component",
      seed: 42,
      file_counts: [100, 1000],
      modified_files: 10,
      modified_bytes: 4096,
      clients: 2,
      operations: 8,
      rate_per_second: 100,
      duration_seconds: 1,
      hardware_digest: machine.digest,
      backend_identity: backend?.identity ?? "fixture",
      real_backend: false,
    });
const { encodeFileDescriptor } = await load("objects");
const { SourceControlClient } = await import(
  pathToFileURL(
    path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT, "client.js"),
  )
);
let sentBytes = 0,
  receivedBytes = 0;
const client = new SourceControlClient({
  endpoint: f.endpoint,
  scope: f.scope,
  token: () => f.tokenFor("author"),
  fetch: async (input, init) => {
    sentBytes += init?.body?.byteLength ?? 0;
    const response = await fetch(input, init);
    receivedBytes += (await response.clone().arrayBuffer()).byteLength;
    return response;
  },
});
const acknowledgedRevisions = new Set([f.base.revision_id]);
const mutate = async (action, input, options = {}) => {
  const operation_id = options.operation_id ?? randomUUID();
  const result = await client.call(action, input, {
    operation_id,
    idempotency_key: operation_id,
    ...options,
  });
  if (result.revision_id) acknowledgedRevisions.add(result.revision_id);
  return result;
};
const backendCounters = {
  storage_requests: 0,
  hydrated_bytes: 0,
  cache_hits: 0,
  cache_misses: 0,
};
// Observe the actual local backend without changing its results or cache behavior.
for (const method of ["put", "read"]) {
  const original = backend[method].bind(backend);
  backend[method] = async (...args) => {
    backendCounters.storage_requests++;
    return original(...args);
  };
}
async function assertReachableRevisionObjects(ids) {
  const { decodeTreeNode, decodeFileDescriptor, sourceObjectId } =
    await load("objects");
  let roots = 0,
    objects = 0;
  const kinds = new Set();
  for (const revision_id of ids) {
    const revision = await client.call("source.revisions.read", {
      revision_id,
    });
    assert.equal(revision.revision_id, revision_id);
    roots++;
    const visited = new Map(),
      pending = [
        { id: revision.root_tree_id, allowed: ["tree-leaf", "tree-index"] },
      ];
    while (pending.length) {
      const { id, allowed } = pending.pop();
      if (visited.has(id)) {
        assert(
          allowed.includes(visited.get(id)),
          "Shared referenced object kind differs",
        );
        continue;
      }
      const object = await client.call("source.objects.read", {
        object_id: id,
      });
      assert.equal(object.object_id, id);
      assert(allowed.includes(object.kind), "Referenced object kind differs");
      const payload = Buffer.from(object.payload_base64, "base64");
      assert.equal(sourceObjectId(object.kind, payload), id);
      visited.set(id, object.kind);
      objects++;
      kinds.add(object.kind);
      if (["tree-leaf", "tree-index"].includes(object.kind)) {
        const node = decodeTreeNode(object.kind, payload);
        if (node.kind === "tree-index")
          for (const child of node.children)
            pending.push({
              id: child.object_id,
              allowed: ["tree-leaf", "tree-index"],
            });
        else
          for (const entry of node.entries)
            pending.push({
              id: entry.object_id,
              allowed:
                entry.kind === "directory"
                  ? ["tree-leaf", "tree-index"]
                  : entry.kind === "file"
                    ? ["file"]
                    : ["blob"],
            });
      } else if (object.kind === "file") {
        const file = decodeFileDescriptor(payload),
          parts =
            file.content.kind === "blob"
              ? [
                  {
                    object_id: file.content.object_id,
                    size_bytes: file.size_bytes,
                  },
                ]
              : file.content.chunks;
        const digest = createHash("sha256");
        let size = 0;
        for (const part of parts) {
          const child = await client.call("source.objects.read", {
            object_id: part.object_id,
          });
          const bytes = Buffer.from(child.payload_base64, "base64");
          assert.equal(
            child.kind,
            file.content.kind === "blob" ? "blob" : "chunk",
          );
          assert.equal(bytes.length, Number(part.size_bytes));
          digest.update(bytes);
          size += bytes.length;
          pending.push({ id: part.object_id, allowed: [child.kind] });
        }
        assert.equal(String(size), file.size_bytes);
        assert.equal("sha256:" + digest.digest("hex"), file.content_digest);
      }
    }
  }
  assert.equal(roots, ids.size);
  assert(objects > roots);
  return {
    revision_roots: roots,
    readable_objects: objects,
    kinds: [...kinds].sort(),
  };
}
function campaignImportedRevisionsNegative(receipt) {
  const invalid = structuredClone(receipt);
  invalid.results[0].measurements.new_revisions++;
  assert.throws(
    () => validateCampaignReceipt(invalid),
    /Imported revisions counted as new/,
  );
}
function campaignLatencySamplesNegative(receipt) {
  for (const key of ["latency_ms", "checkpoint_rpc_ms"]) {
    const invalid = structuredClone(receipt);
    delete invalid.results[0].measurements[key];
    assert.throws(
      () => validateCampaignReceipt(invalid),
      /Missing latency samples/,
    );
  }
  const invalid = structuredClone(receipt);
  invalid.results[0].measurements.latency_ms.count--;
  assert.throws(
    () => validateCampaignReceipt(invalid),
    /Missing latency samples/,
  );
}
function campaignCacheStateNegative(receipt) {
  const invalid = structuredClone(receipt);
  invalid.results[0].cache_condition.state = "cold";
  assert.throws(
    () => validateCampaignReceipt(invalid, { cacheWarmed: true }),
    /Cache state cold/,
  );
}
function campaignLogicalOpensNegative(receipt) {
  const invalid = structuredClone(receipt);
  invalid.results[0].measurements.logical_opens =
    invalid.results[0].measurements.completed_operations;
  invalid.results[0].measurements.materialized_files =
    invalid.results[0].measurements.logical_opens;
  assert.throws(
    () => validateCampaignReceipt(invalid),
    /Logical opens cannot be reported as materialized/,
  );
}
async function campaignBlockedOutcomes(manifest) {
  for (const [kind, real_backend, capability] of [
    ["growth", false, "real_backend"],
    ["growth", true, "capacity.growth"],
    ["mixed", true, "capacity.mixed"],
    ["admission", true, "capacity.admission"],
    ["endurance", true, "capacity.endurance"],
  ]) {
    const folder = path.join(directory, "blocked-" + randomUUID());
    await fs.mkdir(folder, { mode: 0o700 });
    const configFile = path.join(folder, "config.json"),
      manifestFile = path.join(folder, "manifest.json");
    await fs.writeFile(
      configFile,
      JSON.stringify({ output_directory: folder }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      manifestFile,
      JSON.stringify({ ...manifest, kind, real_backend }),
      { mode: 0o600 },
    );
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./native_source_external_workload.mjs", import.meta.url),
          ),
        ],
        {
          env: {
            ...process.env,
            HF_SOURCE_WORKLOAD_MANIFEST: manifestFile,
            HF_SOURCE_WORKLOAD_CONFIG: configFile,
            HF_SOURCE_WORKLOAD_VERIFY_ONLY: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let diagnostic = "";
      child.stdout.on("data", (bytes) => (diagnostic += bytes));
      child.stderr.on("data", (bytes) => (diagnostic += bytes));
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error("Blocked campaign exited " + code + ": " + diagnostic),
            ),
      );
    });
    const receipt = JSON.parse(
      await fs.readFile(path.join(folder, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.status, "BLOCKED");
    assert.equal(receipt.missing_capability, capability);
    assert.deepEqual(receipt.results, []);
  }
}

const blobHash = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const upload = async (bytes) => {
  const blob = await client.call("source.objects.put", {
    kind: "blob",
    payload_base64: bytes.toString("base64"),
  });
  const payload = encodeFileDescriptor({
    size_bytes: String(bytes.length),
    content_digest: blobHash(bytes),
    content: { kind: "blob", object_id: blob.object_id },
  });
  return f.client.call("source.objects.put", {
    kind: "file",
    payload_base64: payload.toString("base64"),
  });
};
try {
  if (manifest.hardware_digest !== machine.digest)
    throw new Error("Campaign hardware differs from pinned manifest");
  if (live && manifest.backend_identity !== serviceOptions.backend.identity)
    throw new Error("Campaign backend differs from pinned manifest");
  if (!live && manifest.kind !== "component")
    throw new Error("Full campaign needs actual configured storage");
  const results = [];
  const hooks = scheduleCampaignHooks(manifest, {
    scope: f.scope,
    outputDirectory: directory,
  });
  for (const count of manifest.file_counts) {
    const corpus = await logicalCorpus(
      f.service,
      f.scope,
      count,
      manifest.seed,
    );
    const base = await f.createRevision({
      root_tree_id: corpus.root_tree_id,
      message: "Workload corpus preparation",
    });
    acknowledgedRevisions.add(base.revision_id);
    const workspaces = [];
    for (let n = 0; n < manifest.clients; n++) {
      const result = await mutate("source.workspaces.open", {
        workspace_id: randomUUID(),
        base_revision_id: base.revision_id,
        mode: "API_ONLY",
        read_paths: [""],
        write_paths: [""],
      });
      workspaces.push(result.workspace);
    }
    const before = Number(
      (
        await f.pool.query(
          "SELECT count(*) FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
          Object.values(f.scope),
        )
      ).rows[0].count,
    );
    const initialSent = sentBytes,
      initialReceived = receivedBytes,
      storageBefore = { ...backendCounters };
    const ledger = new OperationLedger(
      path.join(
        directory,
        "operations-" + count + "-" + randomUUID() + ".jsonl",
      ),
      { imported_revision_ids: [base.revision_id] },
    );
    const mutable = new Map(workspaces.map((w) => [w.workspace_id, w]));
    let first;
    const result = await executeWorkload({
      manifest,
      client,
      workspaces,
      ledger,
      openOnly: manifest.kind === "admission",
      edit: async ({ workspace, ordinal, operation_id, openOnly }) => {
        if (openOnly)
          return f.mutation(
            "source.workspaces.open",
            {
              workspace_id: randomUUID(),
              base_revision_id: base.revision_id,
              mode: "API_ONLY",
              read_paths: [""],
              write_paths: [],
            },
            { operation_id },
          );
        const current = mutable.get(workspace.workspace_id),
          changes = [];
        let remaining = manifest.modified_bytes;
        for (let n = 0; n < manifest.modified_files; n++) {
          const size =
            n === manifest.modified_files - 1
              ? remaining
              : Math.floor(manifest.modified_bytes / manifest.modified_files);
          remaining -= size;
          const bytes = coldEditBytes({
            run: contentRun,
            seed: manifest.seed,
            corpus: count,
            ordinal,
            index: n,
            size,
          });
          const file = await upload(bytes);
          changes.push({
            path: corpus.first_paths[n],
            operation: "put",
            kind: "file",
            mode: "100644",
            object_id: file.object_id,
          });
        }
        const input = {
          operation_id,
          workspace_id: current.workspace_id,
          expected_workspace_generation: current.workspace_generation,
          expected_scope_generation: current.scope_generation,
          base_revision_id: current.base_revision_id,
          overlay_generation: String(ordinal + 1),
          changes,
        };
        const checkpointStarted = performance.now();
        const receipt = await mutate("source.workspaces.checkpoint", input, {
          operation_id,
        });
        const checkpoint_rpc_ms = performance.now() - checkpointStarted;
        mutable.set(workspace.workspace_id, receipt.workspace);
        if (!first) first = { input, operation_id, receipt };
        const revision = await f.service.metadata.readRevision(
          f.context,
          receipt.revision_id,
        );
        for (const change of changes) {
          const entry = await f.service.trees.lookup(
            f.scope,
            revision.root_tree_id,
            change.path,
          );
          assert.equal(entry.object_id, change.object_id);
          await f.service.objects.readFile(f.scope, entry.object_id);
        }
        return { ...receipt, checkpoint_rpc_ms };
      },
    });
    assert.equal(result.rejected, 0);
    assert.equal(result.completed_operations, manifest.operations);
    const after = Number(
      (
        await f.pool.query(
          "SELECT count(*) FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
          Object.values(f.scope),
        )
      ).rows[0].count,
    );
    assert.equal(
      after - before,
      manifest.kind === "admission" ? 0 : result.new_revisions,
    );
    if (first) {
      const replay = await mutate("source.workspaces.checkpoint", first.input, {
        operation_id: first.operation_id,
      });
      assert.equal(replay.revision_id, first.receipt.revision_id);
      const afterReplay = Number(
        (
          await f.pool.query(
            "SELECT count(*) FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
            Object.values(f.scope),
          )
        ).rows[0].count,
      );
      assert.equal(afterReplay, after);
    }
    Object.assign(result, storageAccounting(storageBefore, backendCounters));
    assert(result.storage_requests > 0);
    assert.equal(result.hydrated_bytes, 0);
    assert.equal(result.cache_hits, 0);
    assert.equal(result.cache_misses, 0);
    assert.equal(result.materialized_files, 0);
    assert.equal(
      result.storage_requests,
      backendCounters.storage_requests - storageBefore.storage_requests,
    );
    const missingCounter = { ...backendCounters };
    delete missingCounter.cache_misses;
    assert.throws(
      () => storageAccounting(storageBefore, missingCounter),
      /Missing or regressed/,
    );
    assert.throws(
      () => storageAccounting(backendCounters, storageBefore),
      /Missing or regressed/,
    );
    results.push({
      cache_condition: {
        state: "warm",
        warmed: true,
        scope: "corpus-metadata",
      },
      imported_revision_ids: [base.revision_id],
      server_before: { value: storageBefore },
      server_after: { value: { ...backendCounters } },
      content_condition: {
        profile: "cold-unique-edit-objects",
        run: contentRun,
        corpus: count,
      },
      corpus,
      measurements: result,
      independently_persisted_revisions: after - before,
      application_request_bytes: sentBytes - initialSent,
      application_response_bytes: receivedBytes - initialReceived,
      ledger: ledger.path,
    });
    ledger.close();
  }
  checks.push(
    "actual API checkpoints across increasing logical corpora are independently reconstructed and counted in PostgreSQL",
  );
  checks.push(
    "replayed acknowledgments do not increase new durable revision totals",
  );
  for (const patch of [
    { kind: "unknown" },
    { operations: 0 },
    { kind: "growth" },
    { kind: "mixed" },
    { kind: "admission" },
    { kind: "endurance", real_backend: false },
  ])
    assert.throws(() => campaignManifest({ ...manifest, ...patch }));
  checks.push(
    "empty, undersized, unsupported and missing-live-backend full campaigns are rejected",
  );
  const duplicate = new OperationLedger(
      path.join(directory, "counting-" + randomUUID() + ".jsonl"),
    ),
    id = randomUUID(),
    rev = [...acknowledgedRevisions].at(-1);
  await duplicate.record({
    operation_id: id,
    revision_id: rev,
    status: "ACKNOWLEDGED",
    elapsed_ms: 1,
  });
  await duplicate.record({
    operation_id: id,
    revision_id: rev,
    status: "ACKNOWLEDGED",
    elapsed_ms: 1,
  });
  assert.equal(duplicate.summary().new_revisions, 1);
  assert.equal(duplicate.summary().replayed_acknowledgments, 1);
  await duplicate.record({
    operation_id: randomUUID(),
    revision_id: rev,
    status: "ACKNOWLEDGED",
    elapsed_ms: 1,
  });
  assert.equal(duplicate.summary().new_revisions, 1);
  assert.equal(duplicate.summary().daily_new_revisions[0], 1);
  checks.push(
    "operation ledger records request outcomes and distinguishes replay from new authored revisions",
  );
  duplicate.close();
  const hookSource =
    "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const target=process.env.HF_SOURCE_CAMPAIGN_RESULT;const data=Buffer.from('measured hook evidence');const evidence=target+'.data';fs.writeFileSync(evidence,data);fs.writeFileSync(target,JSON.stringify({schema_version:1,status:'PASS',scope:JSON.parse(process.env.HF_SOURCE_CAMPAIGN_SCOPE),evidence:[{path:path.basename(evidence),size:data.length,sha256:'sha256:'+crypto.createHash('sha256').update(data).digest('hex')}]}));";
  const testHook = {
    argv: [process.execPath, "-e", hookSource],
    executable_digest: blobHash(await fs.readFile(process.execPath)),
    timeout_seconds: 30,
    env_keys: [],
  };
  await runCampaignHook(testHook, {
    scope: f.scope,
    outputDirectory: directory,
    ordinal: "check",
  });
  const corrupt = {
    ...testHook,
    argv: [
      process.execPath,
      "-e",
      hookSource.replace(
        "crypto.createHash('sha256').update(data).digest('hex')",
        "'0'.repeat(64)",
      ),
    ],
  };
  await assert.rejects(
    () =>
      runCampaignHook(corrupt, {
        scope: f.scope,
        outputDirectory: directory,
        ordinal: "corrupt",
      }),
    /hash differs/,
  );
  checks.push(
    "pinned external canary and fault commands execute and their bounded evidence bytes are independently verified",
  );
  const credentialFile = path.join(
    directory,
    "credential-" + randomUUID() + ".json",
  );
  const deployed = {
    deployment_identity: {
      provider: "owned-fixture",
      service_id: "owned-source",
      deployment_id: "fixture-deployment",
      image_digest: "sha256:" + "a".repeat(64),
      resource_profile_digest: "sha256:" + "b".repeat(64),
    },
    schema_version: 1,
    endpoint: "https://source.example.invalid/api",
    scope: f.scope,
    isolated_scope: true,
    backend_identity: "measured",
    credential_file: credentialFile,
    output_directory: directory,
    budgets: { max_checkpoint_p95_ms: 1000, max_growth_ratio: 2 },
    observer: {},
    corpora: [
      {
        logical_files: 100,
        revision_id: "sha256:" + "a".repeat(64),
        edit_paths: Array.from({ length: 10 }, (_, i) => "file-" + i),
      },
    ],
  };
  deploymentConfig(deployed, {
    ...manifest,
    real_backend: true,
    backend_identity: "measured",
    file_counts: [100],
  });
  const signedDeployed = {
    ...deployed,
    signed_config_file: "/private/signed-source.json",
  };
  delete signedDeployed.credential_file;
  deploymentConfig(signedDeployed, {
    ...manifest,
    real_backend: true,
    backend_identity: "measured",
    file_counts: [100],
  });
  assert.throws(() =>
    deploymentConfig(
      { ...deployed, signed_config_file: "/private/ambiguous.json" },
      {
        ...manifest,
        real_backend: true,
        backend_identity: "measured",
        file_counts: [100],
      },
    ),
  );
  assert.throws(() =>
    deploymentConfig(
      { ...deployed, endpoint: "http://remote.example.invalid" },
      {
        ...manifest,
        real_backend: true,
        backend_identity: "measured",
        file_counts: [100],
      },
    ),
  );
  assert.throws(
    () =>
      observerCounters(
        {
          backend_identity: "measured",
          real_s3: true,
          deployment_identity: deployed.deployment_identity,
        },
        "measured",
      ),
    /counter/,
  );
  const writeToken = (
    token,
    expires_at = new Date(Date.now() + 120000).toISOString(),
  ) =>
    fs.writeFile(
      credentialFile,
      JSON.stringify({
        schema_version: 1,
        endpoint: deployed.endpoint,
        scope: f.scope,
        token,
        expires_at,
      }),
      { mode: 0o600 },
    );
  try {
    await writeToken("first");
    assert.equal(await credential(deployed), "first");
    await writeToken("rotated");
    assert.equal(await credential(deployed), "rotated");
    await writeToken("expired", "2000-01-01T00:00:00Z");
    await assert.rejects(() => credential(deployed), /expires/);
    await writeToken("wrong-scope");
    await assert.rejects(() =>
      credential({
        ...deployed,
        scope: { ...f.scope, repository_id: randomUUID() },
      }),
    );
  } finally {
    await fs.unlink(credentialFile);
  }
  checks.push(
    "deployed API scope, measured observer completeness and renewable expiring credentials are enforced",
  );
  const cleanupCustody = new WorkspaceCustody(
    (workspace, operation_id) =>
      mutate(
        "source.workspaces.close",
        {
          workspace_id: workspace.workspace_id,
          expected_workspace_generation: workspace.workspace_generation,
        },
        { operation_id },
      ),
    async (workspace) =>
      (
        await client.call("source.workspaces.detail", {
          workspace_id: workspace.workspace_id,
        })
      ).workspace,
  );
  const scopedBase = await f.createRevision({
    text: "partial workspace setup cleanup\n",
  });
  acknowledgedRevisions.add(scopedBase.revision_id);
  const partial = await mutate("source.workspaces.open", {
    workspace_id: randomUUID(),
    base_revision_id: scopedBase.revision_id,
    mode: "API_ONLY",
    read_paths: [""],
    write_paths: [""],
  });
  cleanupCustody.track(partial.workspace);
  await assert.rejects(() =>
    mutate("source.workspaces.open", {
      workspace_id: randomUUID(),
      base_revision_id: scopedBase.revision_id,
      mode: "INVALID",
      read_paths: [""],
      write_paths: [""],
    }),
  );
  const droppedCheckpoint = randomUUID();
  await mutate(
    "source.workspaces.checkpoint",
    {
      operation_id: droppedCheckpoint,
      workspace_id: partial.workspace.workspace_id,
      expected_workspace_generation: partial.workspace.workspace_generation,
      expected_scope_generation: partial.workspace.scope_generation,
      base_revision_id: partial.workspace.base_revision_id,
      overlay_generation: "1",
      changes: [],
    },
    { operation_id: droppedCheckpoint },
  ); // Deliberately discard the acknowledged descriptor to exercise cleanup reconciliation.

  assert.equal((await cleanupCustody.closeAll()).length, 0);
  assert.equal(cleanupCustody.pending().length, 0);
  await assert.rejects(
    () =>
      client.call("source.workspaces.detail", {
        workspace_id: partial.workspace.workspace_id,
      }),
    (error) => error.code === "WORKSPACE_NOT_FOUND",
  );
  checks.push(
    "partial workspace setup failure closes every acknowledged owned workspace",
  );

  const hookReceipts = await hooks;
  const elapsed = results.reduce(
    (sum, item) => sum + item.measurements.elapsed_ms,
    0,
  );
  if (
    manifest.kind === "endurance" &&
    elapsed < manifest.duration_seconds * 1000
  )
    throw new Error("Elapsed endurance coverage is incomplete");
  if (
    manifest.kind === "endurance" &&
    results.some((item) =>
      item.measurements.daily_new_revisions
        .slice(0, 3)
        .some((count) => count < 100000),
    )
  )
    throw new Error(
      "A full elapsed daily window missed 100000 distinct acknowledged revisions",
    );
  const receipt = {
    schema_version: 1,
    status: "PASS",
    scope:
      manifest.kind === "component"
        ? "bounded real API workload harness"
        : "explicit live storage campaign",
    manifest,
    machine,
    checks,
    results,
    hook_receipts: hookReceipts,
    full_variants:
      manifest.kind === "component"
        ? {
            growth: "UNRUN",
            mixed: "UNRUN",
            admission: "UNRUN",
            endurance: "UNRUN",
          }
        : undefined,
  };
  validateCampaignReceipt(receipt, { cacheWarmed: true });
  // Import an already acknowledged checkpoint from the prior run into a fresh ledger.
  const acknowledgedEvent = (await fs.readFile(results[0].ledger, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .find((event) => event.status === "ACKNOWLEDGED" && event.revision_id);
  assert(acknowledgedEvent);
  const importedId = acknowledgedEvent.revision_id,
    importPath = path.join(directory, "imported-" + randomUUID() + ".jsonl");
  const importLedger = new OperationLedger(importPath, {
    imported_revision_ids: [importedId],
  });
  let importedReceipt;
  try {
    await client.call("source.revisions.read", { revision_id: importedId });
    await importLedger.record(acknowledgedEvent);
    const measurements = {
      ...importLedger.summary(),
      completed_operations: 1,
      logical_opens: 0,
      materialized_files: 0,
    };
    assert.equal(measurements.new_revisions, 0);
    assert.equal(measurements.imported_revisions, 1);
    assert.equal(measurements.daily_new_revisions[0], 0);
    importedReceipt = {
      ...receipt,
      manifest: { ...manifest, operations: 1 },
      results: [
        {
          ...results[0],
          imported_revision_ids: [importedId],
          measurements,
          ledger: importPath,
        },
      ],
    };
  } finally {
    importLedger.close();
  }
  const reopenedImport = new OperationLedger(importPath);
  try {
    assert.equal(reopenedImport.summary().new_revisions, 0);
    assert.equal(reopenedImport.summary().imported_revisions, 1);
  } finally {
    reopenedImport.close();
  }
  validateCampaignReceipt(importedReceipt, { cacheWarmed: true });
  campaignImportedRevisionsNegative(importedReceipt);
  campaignImportedRevisionsNegative(receipt);
  campaignLatencySamplesNegative(receipt);
  campaignCacheStateNegative(receipt);
  campaignLogicalOpensNegative(receipt);
  await campaignBlockedOutcomes(manifest);
  const reachable = await assertReachableRevisionObjects(acknowledgedRevisions);
  assert(
    reachable.kinds.includes("tree-index"),
    "Reachability must exercise radix children",
  );
  assert(reachable.kinds.includes("file"));
  assert(reachable.kinds.includes("blob"));
  receipt.reachable_objects = reachable;
  checks.push(
    "imported revision inflation, missing latency, warmed-cache mislabels and logical materialization inflation are rejected",
  );
  checks.push(
    "missing real backend and required capacity produce BLOCKED receipts without failing the driver",
  );
  checks.push(
    "every acknowledged revision root and all referenced radix, directory, file and content objects are readable",
  );
  await fs.writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: receipt.status,
      checks: checks.length,
      corpora: results.length,
      scope: receipt.scope,
    }),
  );
} finally {
  await f.close();
}

for (const id of [
  "source-workload.api-corpus-checkpoints",
  "source-workload.replay-accounting",
  "source-workload.invalid-profiles",
  "source-workload.durable-ledger",
  "source-workload.pinned-hook-evidence",
  "source-workload.deployed-credentials",
  "source-workload.partial-workspace-cleanup",
  "source-workload.imported-revisions-negative",
  "source-workload.revision-inflation-negative",
  "source-workload.latency-samples-negative",
  "source-workload.cache-state-negative",
  "source-workload.logical-opens-negative",
  "source-workload.blocked-outcomes",
  "source-workload.reachable-objects",
  "source-workload.storage-accounting",
])
  console.log(
    JSON.stringify({ type: "assertion", id, expected: true, actual: true }),
  );
console.log(JSON.stringify({ type: "cleanup", complete: true, resources: [] }));
