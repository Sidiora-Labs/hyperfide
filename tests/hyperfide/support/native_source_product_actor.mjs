import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";
import { SourceControlClient } from "../../../sdk/source-control/src/client.ts";
import { executeSourceAction } from "../../../plugins/hyperfide-source-control/runtime.ts";
import {
  NativeWorkspaceClient,
  SourceWorkspaceJournal,
  NativeVirtualFilesystem,
  discoverVirtualHost,
  SourceWorkspaceError,
} from "../../../sdk/source-control/src/host/index.ts";
import { NativeObjectCache } from "../../../core/host-daemon/src/source-control/cache.ts";
import { SparseSourceMaterializer } from "../../../core/host-daemon/src/source-control/materializer.ts";
import { NativeWorkspaceCheckpoint } from "../../../core/host-daemon/src/source-control/checkpoint.ts";
import {
  SourceMetrics,
  SOURCE_METRIC_MODES,
  SOURCE_METRIC_STATUSES,
  SOURCE_METRIC_PARTITIONS,
  SOURCE_CHECKPOINT_BUCKETS_MS,
  SourceBudgetExceeded,
} from "../../../core/host-daemon/src/source-control/metrics.ts";

if (process.env.HF_SOURCE_HOST_CHECKPOINT === "1") {
  await runFocusedHostCheckpointActor();
  process.exit(0);
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hf-product-git-"));
const scope = {
  organisation_id: randomUUID(),
  repository_id: randomUUID(),
  security_domain_id: randomUUID(),
};
const gitDirectory = path.join(temporary, "remote.git");
execFileSync("git", ["init", "--bare", gitDirectory], { stdio: "ignore" });
const { createLocalGitDestination } = await import(
  pathToFileURL(
    path.join(process.env.SOURCE_CONTROL_MODULE_ROOT, "git/transport.js"),
  )
);
const destination = createLocalGitDestination({
  scope,
  id: "product-browser",
  repository_identity: "owned-product-browser",
  path: gitDirectory,
  allowed_refs: ["refs/heads/main"],
});
const { sourceTransferOptions } = await import(
  pathToFileURL(
    path.join(process.env.SOURCE_CONTROL_MODULE_ROOT, "transfers.js"),
  )
);
const productActions = [
  "source.objects.put",
  "source.objects.read",
  "source.objects.inspect",
  "source.trees.lookup",
  "source.trees.entries",
  "source.revisions.create",
  "source.revisions.read",
  "source.workspaces.open",
  "source.workspaces.detail",
  "source.workspaces.checkpoint",
  "source.queries.history",
  "source.queries.diff",
  "source.operations.read",
  "source.operations.cancel",
  "source.fleet.manifest",
  "source.domains.create",
  "source.domains.read",
  "source.domains.configure",
  "source.candidates.create",
  "source.candidates.read",
  "source.candidates.qualify",
  "source.acceptance.accept",
  "source.acceptance.read",
  "source.assurance.custody.create",
  "source.assurance.publish",
  "source.assurance.revoke",
  "source.transforms.merge",
  "source.transforms.read",
  "source.transforms.resume",
  "source.publications.create",
  "source.publications.read",
  "source.publications.resume",
  "source.publications.cancel",
  "source.transfers.create",
  "source.transfers.read",
  "source.transfers.complete",
  "source.transfers.cancel",
  "source.metrics.read",
];
const f = await createNativeAcceptanceFixture({
  scope,
  actions: productActions,
  serviceOptions: {
    publication: { destinations: [destination] },
    transfers: sourceTransferOptions(
      "https://localhost/api/v1/source-control/transfers",
      randomBytes(32),
    ),
  },
});
const client = new SourceControlClient({
  endpoint: f.endpoint,
  scope: f.scope,
  token: () => f.tokenFor(),
});
const binding = { client },
  checks = [];
const execute = async (action, id = randomUUID()) => {
  const response = await executeSourceAction(binding, id, action);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
};
async function boundedProductAdmission() {
  const responses = await Promise.all(
    Array.from({ length: 20 }, () =>
      executeSourceAction(binding, randomUUID(), {
        kind: "revision",
        revisionId: f.base.revision_id,
      }),
    ),
  );
  const refused = responses.filter((response) => !response.ok);
  assert(
    refused.length > 0,
    "Real concurrent product reads must reach the admission budget",
  );
  assert(responses.some((response) => response.ok));
  for (const response of refused) {
    assert.equal(response.error.code, "LIMIT_EXCEEDED");
    assert.equal(response.error.retry, "RETRY_SAME_OPERATION");
    assert.equal(response.error.outcome, "KNOWN");
    assert.equal(response.error.details.budget, "concurrent_requests");
    assert.equal(response.error.details.limit, 12);
    assert(response.error.message.includes("concurrent_requests"));
  }
  checks.push(
    "real concurrent product reads return typed LIMIT_EXCEEDED diagnostics naming their admission budget",
  );
}
async function incompleteDependencyClosureOpen() {
  const workspaceId = randomUUID();
  const refused = await executeSourceAction(binding, randomUUID(), {
    kind: "open",
    workspaceId,
    revisionId: f.base.revision_id,
    readPaths: ["main.txt"],
    writePaths: ["main.txt"],
    mode: "API_ONLY",
    dependencyPaths: ["dependencies/required.txt"],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEPENDENCY_CLOSURE_INCOMPLETE");
  assert.equal(refused.error.outcome, "KNOWN");
  assert.deepEqual(refused.error.details.readiness.outsideScope, [
    "dependencies/required.txt",
  ]);
  const absent = await executeSourceAction(binding, randomUUID(), {
    kind: "workspace",
    workspaceId,
  });
  assert.equal(absent.ok, false);
  assert.equal(absent.error.code, "WORKSPACE_NOT_FOUND");
  const readiness = await execute({
    kind: "readiness",
    revisionId: f.base.revision_id,
    readPaths: ["main.txt", "dependencies/required.txt"],
    dependencyPaths: ["dependencies/required.txt"],
  });
  assert.equal(readiness.state, "INCOMPLETE");
  assert.deepEqual(readiness.missingPaths, ["dependencies/required.txt"]);
  const ready = await execute({
    kind: "readiness",
    revisionId: f.base.revision_id,
    readPaths: ["main.txt"],
    dependencyPaths: ["main.txt"],
  });
  assert.equal(ready.state, "READY");
  checks.push(
    "incomplete dependency closure refuses admission without creating a workspace; readiness checks real immutable tree metadata",
  );
}
async function oversizedProductPagination() {
  const entries = [];
  for (let index = 0; index < 55; index++) {
    const file = await f.service.objects.putFile(
      f.scope,
      Buffer.from(`page content ${index}\n`),
    );
    entries.push({
      name: `page-${String(index).padStart(3, "0")}.txt`,
      kind: "file",
      mode: "100644",
      object_id: file.object_id,
    });
  }
  const tree = await f.service.trees.fromEntries(f.scope, entries);
  const revisions = [];
  let parent = f.base.revision_id;
  for (let index = 0; index < 55; index++) {
    const revision = await f.createRevision({
      root_tree_id: tree.root_tree_id,
      parent_revision_ids: [parent],
      message: `paged product history ${index}`,
    });
    revisions.push(revision.revision_id);
    parent = revision.revision_id;
  }
  const walk = async (action) => {
    const seen = new Set(),
      rows = [];
    let cursor,
      pages = 0;
    do {
      const page = await execute({ ...action, ...(cursor ? { cursor } : {}) });
      assert(page.entries.length <= 50);
      assert.equal(
        page.coverage.state,
        page.next_cursor ? "PARTIAL" : "COMPLETE",
      );
      rows.push(...page.entries);
      pages++;
      cursor = page.next_cursor;
      if (cursor) {
        assert(!seen.has(cursor), "Continuation must advance");
        seen.add(cursor);
      }
      assert(pages <= 4, "Pagination must terminate within the actual dataset");
    } while (cursor);
    assert(pages > 1, "Oversized data must require continuation");
    return { rows, pages };
  };
  const history = await walk({ kind: "history", revisionId: parent });
  assert.deepEqual(
    history.rows.map((row) => row.revision_id),
    [...revisions].reverse().concat(f.base.revision_id),
  );
  assert.equal(new Set(history.rows.map((row) => row.revision_id)).size, 56);
  const diff = await walk({
    kind: "diff",
    beforeRevisionId: f.base.revision_id,
    afterRevisionId: parent,
  });
  const expectedPaths = [
    "main.txt",
    ...entries.map((entry) => entry.name),
  ].sort();
  assert.deepEqual(diff.rows.map((row) => row.path).sort(), expectedPaths);
  assert.equal(new Set(diff.rows.map((row) => row.path)).size, 56);
  f.productPagination = {
    revisionId: parent,
    beforeRevisionId: f.base.revision_id,
    expectedPaths,
    historyRevisions: [...revisions].reverse().concat(f.base.revision_id),
  };
  checks.push(
    "oversized native history and diff follow every next_cursor to complete coverage without duplicate or missing rows",
  );
}
async function unauthorizedProductRead() {
  const secret = "private source content must never leave its capability";
  const file = await f.service.objects.putFile(f.scope, Buffer.from(secret));
  const main = await f.service.trees.lookup(
    f.scope,
    f.base.root_tree_id,
    "main.txt",
  );
  const directory = await f.service.trees.fromEntries(f.scope, [
    { ...main, name: "main.txt" },
  ]);
  const symlink = await f.service.objects.put(
    f.scope,
    "blob",
    Buffer.from("main.txt"),
  );
  const tree = await f.service.trees.fromEntries(f.scope, [
    { ...main, name: "main.txt" },
    {
      name: "folder",
      kind: "directory",
      mode: "040000",
      object_id: directory.root_tree_id,
    },
    {
      name: "link",
      kind: "symlink",
      mode: "120000",
      object_id: symlink.object_id,
    },
    {
      name: "private.txt",
      kind: "file",
      mode: "100644",
      object_id: file.object_id,
    },
  ]);
  const revision = await f.createRevision({ root_tree_id: tree.root_tree_id });
  const restrictedCapability = randomUUID();
  await f.pool.query(
    `INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,ARRAY['main.txt'],clock_timestamp()+interval '5 minutes')`,
    [
      ...Object.values(f.scope),
      restrictedCapability,
      f.roles.author.principal_id,
      f.roles.author.credential_id,
      f.sourcePolicy,
      productActions,
    ],
  );
  const restricted = new SourceControlClient({
    endpoint: f.endpoint,
    scope: f.scope,
    token: () => f.tokenFor("author", restrictedCapability),
  });
  const readsBefore = f.backend.requests.length;
  const denied = await executeSourceAction(
    { client: restricted },
    randomUUID(),
    { kind: "file", revisionId: revision.revision_id, path: "private.txt" },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "SCOPE_DENIED");
  assert.equal("result" in denied, false);
  assert.equal("content" in denied, false);
  assert(!JSON.stringify(denied).includes(secret));
  const allowed = await executeSourceAction(
    { client: restricted },
    randomUUID(),
    { kind: "file", revisionId: revision.revision_id, path: "main.txt" },
  );
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.result.content, "baseline\n");
  for (const path of ["folder", "link"])
    await assert.rejects(
      restricted.call("source.objects.read", {
        revision_id: revision.revision_id,
        path,
      }),
      (error) =>
        error.code === "SCOPE_DENIED" &&
        !JSON.stringify(error).includes(secret),
    );
  await assert.rejects(
    restricted.call("source.objects.read", { object_id: file.object_id }),
    (error) => error.code === "SCOPE_DENIED",
  );
  const readDirectory = await client.call("source.objects.read", {
    revision_id: revision.revision_id,
    path: "folder",
  });
  assert.equal(readDirectory.kind, "directory");
  assert.equal(readDirectory.object_id, directory.root_tree_id);
  const readSymlink = await client.call("source.objects.read", {
    revision_id: revision.revision_id,
    path: "link",
  });
  assert.equal(readSymlink.kind, "symlink");
  assert.equal(
    Buffer.from(readSymlink.content_base64, "base64").toString(),
    "main.txt",
  );
  assert(f.backend.requests.length >= readsBefore);
  checks.push(
    "real path-restricted capability denies an existing unauthorized file without returning content while allowing its authorized neighbor",
  );
}
async function hostProductMetricsAndVirtualRefusal() {
  const metrics = new SourceMetrics(),
    native = new NativeWorkspaceClient(client, f.scope);
  const descriptor = await native.open({
    base_revision_id: f.base.revision_id,
    mode: "SPARSE",
    read_paths: ["main.txt"],
    write_paths: ["main.txt"],
  });
  const root = path.join(temporary, "materialized"),
    journal = new SourceWorkspaceJournal(path.join(temporary, "journal"));
  const cache = new NativeObjectCache(
    path.join(temporary, "cache"),
    { max_bytes: 65536, max_entries: 2, max_object_bytes: 32768 },
    metrics,
  );
  const materializer = new SparseSourceMaterializer(
    native,
    cache,
    journal,
    root,
    metrics,
  );
  const first = await materializer.materialize(descriptor, ["main.txt"]);
  assert.equal(first.files, 1);
  assert.equal(first.bytes, Buffer.byteLength("baseline\n"));
  await materializer.materialize(descriptor, ["main.txt"]);
  const extra = await f.blob(Buffer.from("cache eviction"));
  const acquired = await cache.acquire(
    f.scope,
    extra,
    () => native.readObject(extra),
    () => native.assertAccess(descriptor, "main.txt"),
  );
  await acquired.release();
  await fs.writeFile(path.join(root, "main.txt"), "candidate: host metrics\n");
  await materializer.reconcile(descriptor);
  const dirty = metrics
    .snapshot()
    .product.find((series) => series.labels.partition === "OVERLAY");
  assert.equal(
    dirty.gauges.dirtyBytes,
    Buffer.byteLength("candidate: host metrics\n"),
  );
  const checkpoint = await new NativeWorkspaceCheckpoint(
    native,
    journal,
    root,
    materializer,
    metrics,
  ).checkpoint(descriptor);
  assert.equal(
    checkpoint.receipt.workspace_generation,
    checkpoint.workspace.workspace_generation,
  );
  assert.equal((await journal.snapshot()).pending, null);
  const snapshot = metrics.snapshot(),
    overlay = snapshot.product.find(
      (series) => series.labels.partition === "OVERLAY",
    ),
    cached = snapshot.product.find(
      (series) => series.labels.partition === "CACHE",
    );
  assert.equal(overlay.counters.logicalOpens, 2);
  assert.equal(overlay.counters.materializationFiles, 2);
  assert.equal(overlay.counters.materializationBytes, 2 * first.bytes);
  assert.equal(overlay.gauges.dirtyBytes, 0);
  assert.equal(overlay.gauges.transferQueueDepth, 0);
  assert.equal(overlay.checkpointLatency.count, 1);
  assert.equal(overlay.checkpointLatency.buckets.at(-1).count, 1);
  assert.deepEqual(
    overlay.checkpointLatency.buckets.slice(0, -1).map((bucket) => bucket.le),
    SOURCE_CHECKPOINT_BUCKETS_MS.map(String),
  );
  assert(cached.counters.cacheHits >= 2);
  assert(cached.counters.cacheEvictions >= 1);
  assert(cached.counters.downloadBytes > 0);
  assert.equal(cached.gauges.transferQueueDepth, 0);
  const virtualDescriptor = await native.open({
    base_revision_id: f.base.revision_id,
    mode: "VIRTUAL",
    read_paths: ["main.txt"],
    write_paths: ["main.txt"],
  });
  const host = {
    mount: {
      path: path.join(temporary, "uninstalled-mount"),
      sha256: "sha256:" + "0".repeat(64),
    },
    unmount: {
      path: path.join(temporary, "uninstalled-unmount"),
      sha256: "sha256:" + "0".repeat(64),
    },
  };
  const capabilities = await discoverVirtualHost(host);
  assert.equal(capabilities.available, false);
  const virtual = new NativeVirtualFilesystem(
    native,
    cache,
    new SourceWorkspaceJournal(path.join(temporary, "virtual-journal")),
    virtualDescriptor,
    {
      mountpoint: path.join(temporary, "virtual-source"),
      stateDirectory: path.join(temporary, "virtual-state"),
      host,
      uid: process.getuid(),
      gid: process.getgid(),
    },
  );
  await assert.rejects(
    () => virtual.mount(),
    (error) =>
      error instanceof SourceWorkspaceError &&
      error.code === "VIRTUAL_FILESYSTEM_UNAVAILABLE" &&
      error.message.includes("explicitly select SPARSE or MATERIALIZED"),
  );
  await assert.rejects(fs.stat(path.join(temporary, "virtual-source")), {
    code: "ENOENT",
  });
  checks.push(
    "real host materialization, cache hits and eviction, dirty journal and receipt-backed checkpoint feed bounded counters and latency; unavailable virtualization returns a typed refusal without fallback",
  );
}
try {
  await boundedProductAdmission();
  await incompleteDependencyClosureOpen();
  await oversizedProductPagination();
  await unauthorizedProductRead();
  await hostProductMetricsAndVirtualRefusal();
  const history = await execute({
    kind: "history",
    revisionId: f.base.revision_id,
  });
  assert(history.entries.some((row) => row.revision_id === f.base.revision_id));
  checks.push(
    "product history reads native source metadata through the real HTTP API without a checkout",
  );
  const workspaceId = randomUUID(),
    opened = await execute({
      kind: "open",
      workspaceId,
      revisionId: f.base.revision_id,
      readPaths: ["main.txt"],
      writePaths: ["main.txt"],
      mode: "API_ONLY",
    });
  assert.equal(opened.workspace.workspace_id, workspaceId);
  const operation = randomUUID(),
    input = {
      kind: "checkpoint",
      workspaceId,
      baseRevisionId: opened.workspace.base_revision_id,
      workspaceGeneration: opened.workspace.workspace_generation,
      scopeGeneration: opened.workspace.scope_generation,
      overlayGeneration: "1",
      path: "main.txt",
      content: "candidate: product checkpoint\n",
      executable: false,
    };
  const checkpoint = await execute(input, operation);
  assert.notEqual(checkpoint.revision_id, f.base.revision_id);
  assert.deepEqual(await execute(input, operation), checkpoint);
  const current = await execute({ kind: "workspace", workspaceId });
  assert.equal(current.workspace.base_revision_id, checkpoint.revision_id);
  const op = await execute({ kind: "operation", operationId: operation });
  assert.equal(op.state, "SUCCEEDED");
  checks.push(
    "product checkpoint uploads verified file objects, records durable source and replays the same operation once",
  );
  const stale = await executeSourceAction(binding, randomUUID(), input);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "WORKSPACE_CHANGED");
  const outside = await executeSourceAction(binding, randomUUID(), {
    ...input,
    baseRevisionId: checkpoint.revision_id,
    workspaceGeneration: checkpoint.workspace.workspace_generation,
    path: "private.txt",
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, "SCOPE_DENIED");
  checks.push(
    "stale workspace generations and writes outside the granted path remain explicit refusals",
  );
  const diff = await execute({
    kind: "diff",
    beforeRevisionId: f.base.revision_id,
    afterRevisionId: checkpoint.revision_id,
  });
  assert(diff.entries.some((row) => row.path === "main.txt"));
  checks.push(
    "product comparison returns actual changed paths and bounded coverage",
  );
  const revision = await f.createRevision({
      text: "candidate: accepted product\n",
    }),
    candidate = await f.createCandidate(revision),
    evidence = await f.publishEvidence(candidate);
  const qualificationOperation = randomUUID(),
    qualificationInput = {
      kind: "qualify",
      candidateId: candidate.candidate_id,
      evidenceIds: [evidence.evidence.evidence_id],
    };
  const qualification = await execute(
    qualificationInput,
    qualificationOperation,
  );
  assert.deepEqual(
    await execute(qualificationInput, qualificationOperation),
    qualification,
  );
  const accepted = await execute({
    kind: "accept",
    candidateId: candidate.candidate_id,
    qualificationId: qualification.qualification_id,
  });
  assert.equal(accepted.revision_id, revision.revision_id);
  checks.push(
    "product acceptance requires independent executed evidence and returns the real acceptance receipt",
  );
  const publication = await execute({
    kind: "publish",
    acceptanceId: accepted.acceptance_id,
    destinationId: "product-browser",
    targetRef: "refs/heads/main",
    expectedOldOid: null,
  });
  assert.equal(publication.status, "QUEUED");
  const sampled = await execute({ kind: "service-metrics", maxRows: 1 });
  assert(sampled.families.publications.remote_lag_ms >= 0);
  assert(
    sampled.product_requests.product.some(
      (series) =>
        series.labels.partition === "INTEGRATION" &&
        series.counters.integrationRetries >= 1,
    ),
  );
  await execute({
    kind: "cancel-publication",
    publicationId: publication.operation_id,
  });
  assert.equal(sampled.families.objects.observed_rows, 1);
  assert.equal(sampled.families.objects.coverage, "PARTIAL");
  assert(["PARTIAL", "COMPLETE"].includes(sampled.families.graphs.coverage));
  assert(sampled.families.graphs.observed_rows <= 1);
  checks.push(
    "server metrics sample actual scoped tables under an explicit per-family row budget",
  );
  const metrics = new SourceMetrics(4),
    release1 = metrics.admit("checkpoint"),
    release2 = metrics.admit("read");
  assert.throws(
    () => metrics.admit("read"),
    (error) =>
      error instanceof SourceBudgetExceeded &&
      error.code === "LIMIT_EXCEEDED" &&
      error.details.budget === "concurrent_requests" &&
      error.details.limit === 2 &&
      error.message.includes("concurrent_requests"),
  );
  const release3 = metrics.admit("cancel"),
    release4 = metrics.admit("resume");
  assert.throws(
    () => metrics.admit("cancel"),
    (error) =>
      error instanceof SourceBudgetExceeded &&
      error.code === "LIMIT_EXCEEDED" &&
      error.details.budget === "recovery_requests",
  );
  release1();
  release2();
  release3();
  release4();
  release4();
  for (let n = 0; n < 1000; n++) metrics.record("read", "success", 1);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.activeRequests, 0);
  assert.equal(snapshot.counters.length, 1);
  assert.equal(snapshot.counters[0].count, 1000);
  const unknownLabels = ["main.txt", f.base.revision_id, f.scope.repository_id];
  for (const value of unknownLabels) {
    assert.throws(() =>
      metrics.increment("logicalOpens", 1, {
        mode: value,
        status: "success",
        partition: "REQUEST",
      }),
    );
    assert.throws(() =>
      metrics.increment("logicalOpens", 1, {
        mode: "API_ONLY",
        status: value,
        partition: "REQUEST",
      }),
    );
    assert.throws(() =>
      metrics.increment("logicalOpens", 1, {
        mode: "API_ONLY",
        status: "success",
        partition: value,
      }),
    );
    assert.throws(() =>
      metrics.increment("logicalOpens", 1, {
        mode: "API_ONLY",
        status: "success",
        partition: "REQUEST",
        project: value,
      }),
    );
  }
  for (let index = 0; index < 1000; index++)
    metrics.increment("graphWorkItems", 1, {
      mode: "API_ONLY",
      status: "success",
      partition: "GRAPH",
    });
  metrics.increment("integrationRetries", 1, {
    mode: "API_ONLY",
    status: "unknown",
    partition: "INTEGRATION",
  });
  metrics.gauge("remoteLagMs", 123, {
    mode: "API_ONLY",
    status: "unknown",
    partition: "REMOTE",
  });
  assert.equal(
    metrics
      .snapshot()
      .product.find((series) => series.labels.partition === "GRAPH").counters
      .graphWorkItems,
    1000,
  );
  assert.equal(
    metrics
      .snapshot()
      .product.find((series) => series.labels.partition === "INTEGRATION")
      .counters.integrationRetries,
    1,
  );
  assert.equal(
    metrics
      .snapshot()
      .product.find((series) => series.labels.partition === "REMOTE").gauges
      .remoteLagMs,
    123,
  );
  for (const counter of metrics.snapshot().counters) {
    assert(SOURCE_METRIC_MODES.includes(counter.mode));
    assert(SOURCE_METRIC_STATUSES.includes(counter.status));
    assert(SOURCE_METRIC_PARTITIONS.includes(counter.partition));
    assert(
      unknownLabels.every((value) => !Object.values(counter).includes(value)),
    );
  }
  for (const series of metrics.snapshot().product) {
    assert.deepEqual(Object.keys(series.labels).sort(), [
      "mode",
      "partition",
      "status",
    ]);
    assert(
      unknownLabels.every(
        (value) => !Object.values(series.labels).includes(value),
      ),
    );
  }
  assert(
    metrics.snapshot().product.length <=
      SOURCE_METRIC_MODES.length *
        SOURCE_METRIC_STATUSES.length *
        SOURCE_METRIC_PARTITIONS.length,
  );
  const { SOURCE_SERVICE_STATUSES, SOURCE_SERVICE_PARTITIONS } = await import(
    pathToFileURL(
      path.join(process.env.SOURCE_CONTROL_MODULE_ROOT, "metrics.js"),
    )
  );
  for (const family of Object.values(sampled.families)) {
    assert(
      Object.keys(family.states).every((state) =>
        SOURCE_SERVICE_STATUSES.includes(state),
      ),
    );
    assert(
      Object.keys(family.partitions).every((partition) =>
        SOURCE_SERVICE_PARTITIONS.includes(partition),
      ),
    );
    assert(
      unknownLabels.every(
        (value) =>
          !Object.hasOwn(family.states, value) &&
          !Object.hasOwn(family.partitions, value),
      ),
    );
  }
  checks.push(
    "bounded metrics reserve recovery capacity and never create labels from source paths, revisions or project IDs",
  );
  if (process.env.HF_SOURCE_BROWSER === "1") {
    const { runSourceProductBrowser } =
      await import("./native_source_product_browser.mjs");
    await runSourceProductBrowser(f, binding);
    const remote = execFileSync(
      "git",
      ["--git-dir", gitDirectory, "rev-parse", "refs/heads/main"],
      { encoding: "utf8" },
    ).trim();
    assert.match(remote, /^[a-f0-9]{40}$/);
    checks.push(
      "actual Chromium workspace, lost-response replay and history journeys at desktop tablet and mobile sizes",
    );
  }
  const receipt = {
    status: "PASS",
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    checks,
    backend_requests: f.backend.requests.length,
    scope:
      "actual product action adapter, HTTP source API, PostgreSQL, S3 fixture, and independent checker",
  };
  await fs.mkdir("build/source-control/product", { recursive: true });
  await fs.writeFile(
    "build/source-control/product/receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  await f.close();
  await fs.rm(temporary, { recursive: true, force: true });
}

async function runFocusedHostCheckpointActor() {
  const { createHash, sign } = await import("node:crypto");
  const https = await import("node:https");
  const { installNativeFleetFixture } =
    await import("./native_source_fleet_install.mjs");
  const { createNativeFleetAssignmentFixture } =
    await import("./native_source_fleet_assignment.mjs");
  const { createNativeFleetPool } =
    await import("./native_source_fleet_pool.mjs");
  const { enrollNativeFleetWorker } =
    await import("./native_source_fleet_enrollment.mjs");
  const moduleRoot = process.env.SOURCE_CONTROL_MODULE_ROOT,
    controlRoot = path.dirname(moduleRoot);
  const load = (name) =>
    import(pathToFileURL(path.join(controlRoot, name + ".js")));
  const inputs = JSON.parse(
      await fs.readFile(process.env.NATIVE_SOURCE_FLEET_INPUT, "utf8"),
    ),
    i = inputs.ids;
  const [
    { createResourceContainer },
    { AuthorityStore },
    { FileExternalAuthorityJournal },
    identityModule,
    protocol,
    { parseKvx },
    { registerProofPolicy },
    { SourceControlClient },
    { encodeFileDescriptor },
  ] = await Promise.all([
    load("storage/runtime"),
    load("storage/durability"),
    load("storage/authority_journal"),
    load("identity/enrollment"),
    load("transport/protocol"),
    load("spec/import"),
    load("spec/obligations"),
    import(
      pathToFileURL(
        path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT, "client.js"),
      )
    ),
    load("source_control/objects"),
  ]);
  const signal = new AbortController().signal,
    resources = createResourceContainer({
      role: "control",
      env: process.env,
      signal,
    });
  const journal = new FileExternalAuthorityJournal(
    process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR,
    async (value) => {
      const { lookupAuthorityActivation } = await load("storage/durability");
      return lookupAuthorityActivation(resources, value);
    },
  );
  const authority = new AuthorityStore(
    resources,
    process.env.HYPERFIDE_DEPLOYMENT_ID,
    journal,
  );
  const identity = await identityModule.createComponent({
    env: process.env,
    resources,
    signal,
    dependencies: {
      require(name, capability) {
        assert.equal(name, "4.4");
        assert.equal(capability, "storage.authority.v1");
        return authority;
      },
    },
  });
  const identityAuthority = identity.capabilities["identity.authority"];
  let listener;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-native-fleet-"));
  const nativeScope = {
    organisation_id: i.organisation,
    repository_id: i.repository,
    security_domain_id: randomUUID(),
  };
  const f = await createNativeAcceptanceFixture({
    migrate: false,
    scope: nativeScope,
    serviceOptions: {
      transaction: (body) =>
        resources.gateway.withPrimaryTransaction(
          { timeoutMs: 15000, maxRetries: 2 },
          body,
        ),
    },
  });
  const stages = [];
  const hash = (bytes) =>
    "sha256:" + createHash("sha256").update(bytes).digest("hex");
  const digest = f.sourceDigest;
  const insert = async (table, record) => {
    const columns = Object.keys(record);
    await f.pool.query(
      "INSERT INTO hyperfide." +
        table +
        "(" +
        columns.join(",") +
        ") VALUES(" +
        columns.map((_, index) => "$" + (index + 1)).join(",") +
        ")",
      Object.values(record),
    );
  };
  const scope = { organisation_id: i.organisation, run_id: i.run };
  const request = async (
    key,
    component,
    action,
    input,
    operation = randomUUID(),
  ) => {
    const payload = Buffer.from(
      JSON.stringify({
        run_id: i.run,
        component,
        action,
        input,
        expected_version: null,
        authority: null,
      }),
    );
    const body = Buffer.from(
      JSON.stringify({
        protocol_version: 1,
        operation_id: operation,
        idempotency_key: operation,
        payload_digest: hash(payload),
        correlation_id: operation,
        causation_id: null,
        payload_b64: payload.toString("base64url"),
      }),
    );
    const proof = {
      id: i[key],
      time: String(Math.floor(Date.now() / 1000)),
      nonce: randomUUID(),
    };
    const signature = sign(
      null,
      protocol.signingBytes(inputs.origin, "/v1/invoke", proof, body),
      await fs.readFile(inputs.keys[key]),
    ).toString("base64url");
    return {
      body,
      headers: {
        "Content-Type": "application/json",
        "HF-Credential-Id": proof.id,
        "HF-Request-Time": proof.time,
        "HF-Request-Nonce": proof.nonce,
        "HF-Request-Signature": signature,
      },
    };
  };
  const sourceInvocation = async (
    key,
    action,
    input,
    operation = randomUUID(),
  ) => {
    const value = {
      protocol_version: 1,
      scope: f.scope,
      operation_id: operation,
      idempotency_key: operation,
      action,
      input,
    };
    const signed = await request(
      key,
      "source-control",
      action,
      value,
      operation,
    );
    const invocation = await identityAuthority.authenticate(
      signed.body,
      Object.entries(signed.headers).flat(),
      signal,
    );
    return { value, invocation };
  };
  const sourceCall = async (key, action, input, operation = randomUUID()) => {
    const { value, invocation } = await sourceInvocation(
      key,
      action,
      input,
      operation,
    );
    return f.service.api.invoke(action, value, invocation);
  };
  const controlCall = async (key, component, action, input) => {
    const signed = await request(key, component, action, input);
    const ca = await fs.readFile(inputs.ca);
    const response = await new Promise((resolve, reject) => {
      const req = https.request(
        inputs.origin + "/v1/invoke",
        { method: "POST", ca, headers: signed.headers },
        (res) => {
          const buffers = [];
          res.on("data", (part) => buffers.push(part));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              body: JSON.parse(Buffer.concat(buffers)),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(signed.body);
    });
    if (!response.body.ok) {
      const error = new Error(response.body.error.message);
      Object.assign(error, response.body.error);
      throw error;
    }
    return response.body.result;
  };
  try {
    console.error("native-fleet: fixture ready");
    const grantedActions = [
      ...new Set([
        ...f.service.api.actions.filter(
          (action) =>
            action === "source.capabilities" ||
            /^source\.(objects|uploads|trees|revisions|changes|operations|queries|workspaces|subscriptions|transforms|domains|candidates|acceptance|assurance|publications|fleet)\./.test(
              action,
            ),
        ),
        "source.capabilities.manage",
      ]),
    ];
    assert(
      grantedActions.length <= 64,
      "Fleet fixture grants only its bounded source lifecycle actions",
    );
    for (const name of ["leader", "manager"])
      await insert("source_capabilities", {
        ...f.scope,
        id: randomUUID(),
        principal_id: i[name],
        credential_id: i[name],
        principal_kind: "automation",
        authority_epoch: "1",
        policy_version: f.sourcePolicy,
        actions: grantedActions,
        path_prefixes: [""],
        expires_at: new Date(Date.now() + 1200000).toISOString(),
      });
    const mainFile = await f.service.objects.putFile(
      f.scope,
      Buffer.from("candidate: assigned baseline\n"),
    );
    const rootTree = await f.service.trees.fromEntries(f.scope, [
      {
        name: "main.txt",
        kind: "file",
        mode: "100644",
        object_id: mainFile.object_id,
      },
    ]);
    const baseline = await f.createRevision({
      root_tree_id: rootTree.root_tree_id,
      parent_revision_ids: [],
    });
    const nativePool = await createNativeFleetPool({
      f,
      ids: i,
      revision: baseline,
      capacity: inputs.capacity,
      resources,
      controlRoot,
    });
    Object.assign(i, nativePool.ids);
    const boundRun = await sourceCall("leader", "source.fleet.bind-run", {
      run_id: i.run,
      revision_id: baseline.revision_id,
      leader_generation: "1",
    });
    assert.equal(boundRun.revision_id, baseline.revision_id);
    const installed = await installNativeFleetFixture(f, {
      root,
      controlRoot,
      revision: baseline,
      fleet: i,
    });
    stages.push(installed.stage);
    const specification = randomUUID(),
      run = (
        await f.pool.query(
          "SELECT spec_generation::text,state_version::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2",
          [i.organisation, i.run],
        )
      ).rows[0];
    const generation = String(BigInt(run.spec_generation) + 1n),
      rubric = digest("native-fleet-executable-rubric");
    const acceptedCheck = {
      id: f.check.id,
      argv: f.check.argv,
      executable_digest: f.check.executable_digest,
      timeout_ms: 30000,
      required_artifacts: f.check.required_artifacts,
      input_keys: [
        "source",
        "dependency",
        "toolchain",
        "configuration",
        "graph",
        "contract",
      ],
    };
    const render = (value) => JSON.stringify(value);
    let source =
      '[req.4]\nac_2 = "Native worker source remains attributable through coordinator qualification."\n[acceptance.native-fleet]\nreqs = ["4.2"]\nchecks = ' +
      render([f.check.id]) +
      "\n[proof]\nrubric_digest = " +
      render(rubric) +
      "\n[proof.check." +
      f.check.id +
      "]\n";
    for (const [key, value] of Object.entries(acceptedCheck))
      if (key !== "id") source += key + " = " + render(value) + "\n";
    source +=
      '[task.native-first]\nwave = 1\nreqs = ["4.2"]\nacceptance_ids = ["native-fleet"]\ntouches = ["main.txt"]\nrequires = []\n';
    const parsed = parseKvx(source),
      document = {
        schema_version: 1,
        revision_digest: digest(source),
        source_digest: hash(Buffer.from(source)),
        repositories: [
          {
            repository_id: i.repository,
            source_object_id: baseline.revision_id,
            integration_ref: null,
          },
        ],
        allowed_actions: inputs.actions,
        closure_policy: {
          required_evidence: [],
          required_review_roles: [],
          publication: "AFTER_QUALIFICATION",
        },
        provenance: null,
        parsed,
        runtime_wave_offset: 0,
      };
    await insert("spec_revisions", {
      organisation_id: i.organisation,
      project_id: i.project,
      id: specification,
      source_digest: document.source_digest,
      source_content: source,
      document,
      schema_version: 1,
      revision_digest: document.revision_digest,
    });
    await insert("run_spec_revisions", {
      ...scope,
      spec_generation: generation,
      spec_revision_id: specification,
    });
    await f.pool.query(
      "UPDATE hyperfide.runs SET spec_generation=$3,spec_revision_id=$4,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2",
      [i.organisation, i.run, generation, specification],
    );
    const tasks = {};
    const registerTask = async (
      name,
      {
        profile = nativePool.profile,
        packageId = i.package,
        sourceRevision = baseline.revision_id,
        feature = "alpha",
      } = {},
    ) => {
      const task = randomUUID(),
        slot = randomUUID(),
        criteria = digest("native-fleet-" + name);
      tasks[name] = { task, slot, criteria };
      const definition = {
        ...inputs.definition,
        section: parsed.sections.find(
          (section) => section.name === "task.native-" + name,
        ),
        purpose: "Native source " + name,
        touches: ["main.txt"],
        environment_profile_id: profile,
        feature_key: feature,
      };
      await insert("tasks", {
        ...scope,
        id: task,
        task_key: feature + ".native-" + name,
        feature_package_id: packageId,
        spec_revision_id: specification,
        spec_generation: generation,
        criteria_digest: criteria,
        definition,
        wave: 1,
      });
      const policy = {
        schema_version: 1,
        criteria_digest: criteria,
        spec_revision_id: specification,
        spec_generation: generation,
        repository_id: i.repository,
        source_object_id: sourceRevision,
        rubric_digest: rubric,
        checks: [acceptedCheck],
        clauses: [
          {
            id: "4.2",
            mode: "EXECUTABLE",
            acceptance_ids: ["native-fleet"],
            checks: [f.check.id],
          },
        ],
        inputs: Object.fromEntries(
          [
            "source",
            "dependency",
            "toolchain",
            "configuration",
            "graph",
            "contract",
          ].map((key) => [key, digest("accepted-native-" + key)]),
        ),
        contract_digests: [],
      };
      const state = (
        await f.pool.query(
          "SELECT state_version::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2",
          [i.organisation, i.run],
        )
      ).rows[0].state_version;
      tasks[name].registry = await resources.gateway.withPrimaryTransaction(
        { timeoutMs: 15000 },
        (tx) =>
          registerProofPolicy(tx, scope, {
            run_id: i.run,
            task_id: task,
            spec_revision_id: specification,
            spec_generation: generation,
            state_version: state,
            policy,
          }),
      );
      return tasks[name];
    };
    await registerTask("first");
    const assignments = await createNativeFleetAssignmentFixture({
      f,
      ids: i,
      controlCall,
      installed,
      specification,
      tasks,
      capacity: nativePool.capacity,
    });
    const participant = await assignments.assign(tasks.first.task, 0);

    const controllerGrant = await f.pool.query(
      `UPDATE hyperfide.identity_principals
       SET allowed_actions = CASE
         WHEN 'runner.dispatch.consume' = ANY(allowed_actions) THEN allowed_actions
         ELSE array_append(allowed_actions, 'runner.dispatch.consume')
       END
       WHERE credential_id = $1 AND organisation_id = $2 AND run_id = $3
         AND role = 'OPERATOR'
       RETURNING run_id, allowed_actions`,
      [i.operator, scope.organisation_id, scope.run_id],
    );
    assert.equal(controllerGrant.rowCount, 1);
    assert.equal(controllerGrant.rows[0].run_id, scope.run_id);
    assert(
      controllerGrant.rows[0].allowed_actions.includes(
        "runner.dispatch.consume",
      ),
    );
    const enrolled = await enrollNativeFleetWorker({
      f,
      resources,
      controlRoot,
      identity,
      identityAuthority,
      scope,
      ids: i,
      assignment: participant,
      request,
      origin: inputs.origin,
    });
    const hostActions = [
      "source.objects.read",
      "source.objects.inspect",
      "source.trees.lookup",
      "source.trees.entries",
    ];
    const actorStat = await fs.readFile(`/proc/${process.pid}/stat`, "utf8");
    const actorStart = actorStat
      .slice(actorStat.lastIndexOf(")") + 2)
      .split(" ")[19];
    const nativeSessionId = `node:${process.pid}:${actorStart}`;
    const actorSession = await f.pool.query(
      `UPDATE hyperfide.agent_sessions
       SET native_session_id = $4, state = 'RUNNING', state_version = state_version + 1
       WHERE organisation_id = $1 AND run_id = $2 AND id = $3
         AND role = 'WORKER' AND state = 'REGISTERED' AND native_session_id IS NULL
         AND attempt_id = $5 AND sandbox_id = $6 AND sandbox_boot_generation = $7
       RETURNING native_session_id`,
      [
        scope.organisation_id,
        scope.run_id,
        enrolled.identity.principal_id,
        nativeSessionId,
        enrolled.bound.attempt_id,
        participant.sandbox_id,
        participant.boot_generation,
      ],
    );
    assert.equal(actorSession.rowCount, 1);
    assert.equal(actorSession.rows[0].native_session_id, nativeSessionId);
    const hostGrant = await f.pool.query(
      `UPDATE hyperfide.identity_principals
       SET allowed_actions = ARRAY(SELECT DISTINCT unnest(allowed_actions || $4::text[]))
       WHERE credential_id = $1 AND organisation_id = $2 AND run_id = $3
         AND role = 'WORKER' AND actor_id = $5
       RETURNING run_id, allowed_actions`,
      [
        enrolled.identity.credential_id,
        scope.organisation_id,
        scope.run_id,
        hostActions,
        enrolled.identity.principal_id,
      ],
    );
    assert.equal(hostGrant.rowCount, 1);
    assert.equal(hostGrant.rows[0].run_id, scope.run_id);
    for (const action of [...hostActions, "source.workspaces.checkpoint"])
      assert(hostGrant.rows[0].allowed_actions.includes(action));
    const sourceGrant = await f.pool.query(
      `UPDATE hyperfide.source_capabilities
       SET actions = ARRAY(SELECT DISTINCT unnest(actions || $6::text[]))
       WHERE organisation_id = $1 AND repository_id = $2 AND security_domain_id = $3
         AND credential_id = $4 AND id = $5
         AND managed_binding->>'workspace_id' = $7
       RETURNING actions`,
      [
        f.scope.organisation_id,
        f.scope.repository_id,
        f.scope.security_domain_id,
        enrolled.identity.credential_id,
        enrolled.bound.capability_id,
        hostActions,
        enrolled.bound.workspace_id,
      ],
    );
    assert.equal(sourceGrant.rowCount, 1);
    for (const action of hostActions)
      assert(sourceGrant.rows[0].actions.includes(action));
    const certFile = path.join(root, "tls.crt"),
      keyFile = path.join(root, "tls.key");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const { decodeSourceRequest, encodeSourceResponse } = await load(
      "source_control/contracts",
    );
    let signedIdentity;
    listener = https.createServer(
      { cert: await fs.readFile(certFile), key: await fs.readFile(keyFile) },
      async (req, res) => {
        let operation;
        try {
          assert.equal(req.url, "/api/v1/source-control");
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks),
            decoded = decodeSourceRequest(body);
          operation = decoded.operation_id;
          const invocation = await signedIdentity.authenticateSource(
            body,
            req.rawHeaders,
            signal,
          );
          const result = await f.service.api.invoke(
            decoded.action,
            decoded,
            invocation,
          );
          res.setHeader("content-type", "application/json");
          res.end(
            encodeSourceResponse({
              protocol_version: 1,
              operation_id: operation,
              result,
            }),
          );
        } catch (error) {
          console.error("host-checkpoint source:", error);
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              protocol_version: 1,
              operation_id: operation,
              error: {
                code: error.code ?? "INTERNAL",
                message: error.message,
                retry: "NEVER",
                outcome: "KNOWN",
              },
            }),
          );
        }
      },
    );
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const signedOrigin = "https://127.0.0.1:" + listener.address().port;
    const identityConfiguration = JSON.parse(
      await fs.readFile(process.env.HF_IDENTITY_CONFIG_FILE, "utf8"),
    );
    const controllerPrincipal = identityConfiguration.principals.find(
      (principal) =>
        principal.credential_id === i.operator &&
        principal.organisation_id === scope.organisation_id &&
        principal.run_id === scope.run_id,
    );
    assert(controllerPrincipal);
    controllerPrincipal.allowed_actions =
      controllerGrant.rows[0].allowed_actions;
    const signedIdentityFile = path.join(root, "identity.json");
    await fs.writeFile(
      signedIdentityFile,
      JSON.stringify({ ...identityConfiguration, origin: signedOrigin }),
      { mode: 0o600 },
    );
    const signedComponent = await identityModule.createComponent({
      env: { ...process.env, HF_IDENTITY_CONFIG_FILE: signedIdentityFile },
      resources,
      signal,
      dependencies: {
        require() {
          return authority;
        },
      },
    });
    signedIdentity = signedComponent.capabilities["identity.authority"];
    const workerKey = path.join(root, "worker.key");
    await fs.writeFile(
      workerKey,
      enrolled.keyPair.privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    const configFile = path.join(root, "source.json");
    await fs.writeFile(
      configFile,
      JSON.stringify({
        schema_version: 1,
        transport: {
          schema_version: 1,
          endpoint:
            "https://127.0.0.1:" +
            listener.address().port +
            "/api/v1/source-control",
          scope: f.scope,
          credential_id: enrolled.identity.credential_id,
          ca_file: certFile,
          key_file: workerKey,
        },
        assignment: enrolled.bound,
      }),
      { mode: 0o600 },
    );
    const { loadSourceClient } =
      await import("../../../plugins/hyperfide-source-control/runtime.ts");
    const { runHostCheckpointSubmissionAndReopen } =
      await import("./native_source_product_browser.mjs");
    await runHostCheckpointSubmissionAndReopen(
      f,
      await loadSourceClient(configFile),
      {
        configFile,
        assignment: enrolled.bound,
        directory: root,
      },
    );
  } finally {
    if (listener) await new Promise((resolve) => listener.close(resolve));
    for (const stage of stages)
      await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
    await f.close();
    await resources.close();
  }
}
