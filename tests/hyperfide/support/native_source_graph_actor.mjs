import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "hf-native-graph-"));
const binary = path.resolve(process.env.HF_SOURCE_GRAPH_BINARY ?? "hyperfide"),
  binary_digest =
    "sha256:" +
    createHash("sha256")
      .update(await fs.readFile(binary))
      .digest("hex");
const actions = [
  "source.capabilities",
  "source.objects.put",
  "source.objects.read",
  "source.trees.lookup",
  "source.trees.entries",
  "source.revisions.create",
  "source.revisions.read",
  "source.graph.build",
  "source.graph.publish",
  "source.graph.query",
  "source.domains.create",
  "source.workspaces.open",
  "source.workspaces.close",
];
const fixture = await createNativeAcceptanceFixture({
  actions,
  serviceOptions: { graph: { binary, binary_digest, scratch, max_active: 2 } },
});
const f = fixture,
  checks = [];
const record = (message) => {
  checks.push(message);
  console.error("native-graph: " + message);
};
const controlRoot = path.dirname(process.env.SOURCE_CONTROL_MODULE_ROOT);
const load = (name) =>
  import(pathToFileURL(path.join(controlRoot, name + ".js")));
const [
  { TransactionGateway },
  { loadGraphSnapshot },
  { deriveNativeGraphSlice },
  { packetGraphPin },
] = await Promise.all([
  load("storage/transactions"),
  load("graph/publication"),
  load("preparation/slices"),
  load("hierarchy/packets"),
]);
const gateway = new TransactionGateway({
  acquirePrimary: async (deadline, signal) => {
    const client = await f.pool.connect();
    return {
      client,
      signal: AbortSignal.any([
        AbortSignal.timeout(
          Math.max(1, Math.ceil(deadline - performance.now())),
        ),
        ...(signal ? [signal] : []),
      ]),
      release: (destroy) => client.release(destroy),
    };
  },
});
const holds = new Map();
let abortAfterFirst = null;
f.service.metadata.options.transaction = async (body) => {
  const result = await gateway.withPrimaryTransaction(
    { timeoutMs: 10000, maxRetries: 2 },
    body,
  );
  const hold = result?.state === "BUILDING" ? holds.get(result.build_id) : null;
  if (hold) {
    hold.enter();
    await hold.released;
  }
  if (abortAfterFirst) {
    const n = (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM hyperfide.source_graph_files WHERE build_id=$1",
        [abortAfterFirst.build_id],
      )
    ).rows[0].n;
    if (n === 1) {
      const { controller } = abortAfterFirst;
      abortAfterFirst = null;
      controller.abort();
    }
  }
  return result;
};
function holdBuild(id) {
  let enter, release;
  const entered = new Promise((resolve) => (enter = resolve)),
    released = new Promise((resolve) => (release = resolve));
  const hold = { enter, release, entered, released };
  holds.set(id, hold);
  return hold;
}
const configuration = {
  resolver_digest: "sha256:" + "1".repeat(64),
  generated_digest: "sha256:" + "2".repeat(64),
  build_flags: [],
};
const paths = ["apps/web.ts", "lib/api.ts", "other/steady.ts"];
async function revision(files, parent) {
  let root = await f.service.trees.empty(f.scope);
  for (const [name, text] of Object.entries(files)) {
    const file = await f.service.objects.putFile(f.scope, Buffer.from(text));
    root = (
      await f.service.trees.patch(f.scope, root, [
        {
          path: name,
          operation: "put",
          kind: "file",
          mode: "100644",
          object_id: file.object_id,
        },
      ])
    ).root_tree_id;
  }
  return f.createRevision({
    root_tree_id: root,
    parent_revision_ids: parent ? [parent.revision_id] : [],
  });
}
const build = async (revision, extra = {}) =>
  f.client.call("source.graph.build", {
    build_id: randomUUID(),
    revision_id: revision.revision_id,
    root_tree_id: revision.root_tree_id,
    paths,
    configuration,
    ...extra,
  });
const publish = async (built, generation) =>
  f.client.call(
    "source.graph.publish",
    {
      build_id: built.build_id,
      channel: "integration",
      expected_generation: String(generation),
    },
    { operation_id: randomUUID() },
  );
const query = async (built, revision, input = {}) =>
  f.client.call("source.graph.query", {
    build_id: built.build_id,
    revision_id: revision.revision_id,
    root_tree_id: revision.root_tree_id,
    mode: "symbols",
    limit: 2,
    ...input,
  });
const nativePin = (revision) =>
  packetGraphPin({
    source_backend: "native",
    repository_id: f.scope.repository_id,
    security_domain_id: f.scope.security_domain_id,
    source_object_id: revision.revision_id,
    root_tree_id: revision.root_tree_id,
  });
const consumerScope = {
  organisation_id: f.scope.organisation_id,
  run_id: randomUUID(),
  authority_epoch: randomUUID(),
};
const snapshot = (tx, built, revision) =>
  loadGraphSnapshot(
    tx,
    consumerScope,
    built.build_id,
    [nativePin(revision)],
    f.context,
  );
async function assertRetained(built, generation) {
  const retained = (
    await f.pool.query(
      "SELECT build_id,generation::text FROM hyperfide.source_graph_channels WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND channel=$4",
      [...Object.values(f.scope), "integration"],
    )
  ).rows[0];
  assert.equal(retained.build_id, built.build_id);
  assert.equal(retained.generation, String(generation));
}
try {
  const files = {
    "apps/web.ts":
      "import { answer } from '../lib/api';\nexport function render() { return answer(); }\n",
    "lib/api.ts": "export function answer() { return 42; }\n",
    "other/steady.ts": "export function steady() { return true; }\n",
  };
  const first = await revision(files),
    firstId = randomUUID(),
    secondId = randomUUID(),
    firstHold = holdBuild(firstId),
    secondHold = holdBuild(secondId);
  const pending = build(first, { build_id: firstId }),
    concurrent = build(first, {
      build_id: secondId,
      configuration: {
        ...configuration,
        resolver_digest: "sha256:" + "4".repeat(64),
      },
    });
  let before;
  try {
    await Promise.all([firstHold.entered, secondHold.entered]);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM hyperfide.source_graph_builds WHERE build_id=ANY($1::uuid[]) AND state='BUILDING'",
          [[firstId, secondId]],
        )
      ).rows[0].n,
      2,
    );
    await assert.rejects(
      () => build(first),
      (e) => e.code === "GRAPH_OVERLOADED",
    );
    const reads = await Promise.all([
      f.client.call(
        "source.capabilities",
        {},
        { signal: AbortSignal.timeout(2000) },
      ),
      f.client.call(
        "source.revisions.read",
        { revision_id: first.revision_id },
        { signal: AbortSignal.timeout(2000) },
      ),
    ]);
    assert(reads[0]);
    assert.equal(reads[1].root_tree_id, first.root_tree_id);
  } finally {
    firstHold.release();
    secondHold.release();
    holds.clear();
  }
  const admitted = await Promise.all([pending, concurrent]);
  before = admitted[0];
  assert.equal(admitted[1].coverage.complete, true);
  record(
    "source capability and revision reads finish while two native builds saturate admission and a third is refused",
  );
  assert.equal(before.coverage.complete, true);
  assert.equal(before.coverage.extracted_files, 3);
  await publish(before, 0);
  const initial = await query(before, first);
  assert(initial.rows.some((r) => r.symbols.some((s) => s.name === "render")));
  assert(initial.next_cursor);
  const page = await query(before, first, { cursor: initial.next_cursor });
  assert(page.rows.some((r) => r.symbols.some((s) => s.name === "steady")));
  record(
    "actual native scanner facts are published and paginated against the exact native revision without a Git checkout",
  );
  assert.equal(initial.schema_version, 1);
  assert.equal(initial.identity.source_kind, "NATIVE");
  assert.deepEqual({ ...initial.identity.scope }, f.scope);
  assert.equal(initial.identity.revision_id, first.revision_id);
  assert.equal(initial.identity.root_tree_id, first.root_tree_id);
  assert.equal(initial.identity.parser_digest, binary_digest);
  assert.equal(initial.identity.resolver_digest, configuration.resolver_digest);
  assert.equal(initial.identity.graph_schema, "native-graph-v1");
  assert.equal(initial.identity.overlay, null);
  assert.equal(initial.coverage.complete, true);
  assert.equal(initial.coverage.resolution_complete, true);
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  assert.equal(
    initial.identity.configuration_digest,
    "sha256:" +
      createHash("sha256")
        .update(JSON.stringify(canonical(configuration)))
        .digest("hex"),
  );
  record(
    "graph responses expose independently verified source, parser binary, resolver, configuration, schema and coverage identities",
  );
  const context = await query(before, first, {
    mode: "context",
    path: "apps/web.ts",
    limit: 8,
  });
  assert.equal(context.rows[0].body, files["apps/web.ts"]);
  const dependencies = await query(before, first, {
    mode: "dependencies",
    path: "apps/web.ts",
    limit: 8,
  });
  assert.deepEqual(dependencies.rows[0].dependencies, ["lib/api.ts"]);
  record(
    "source-pinned context returns exact file bytes and resolves the actual cross-project import edge",
  );
  await gateway.withPrimaryTransaction({ timeoutMs: 10000 }, async (tx) => {
    const pinned = await snapshot(tx, before, first),
      pin = nativePin(first);
    assert.equal(pin.schema_version, 1);
    assert.equal(pin.source_kind, "NATIVE");
    assert.equal(pin.revision_id, first.revision_id);
    assert(!Object.hasOwn(pin, "source_object_id"));
    assert.equal(pinned.expected_sources_validated, true);
    assert.equal(pinned.source_set[0].revision_id, first.revision_id);
    assert.equal(pinned.source_set[0].root_tree_id, first.root_tree_id);
    assert.deepEqual(pinned.imported_git_provenance, []);
    const slice = await deriveNativeGraphSlice(
      tx,
      f.scope.organisation_id,
      pin,
      pinned,
      ["apps/web.ts"],
      { contracts: [], registries: [] },
      { files: 128, edges: 512 },
    );
    assert.equal(slice.mode, "SLICE");
    assert.equal(slice.fallback_reason, null);
    assert.equal(slice.closure.complete, true);
    assert.equal(slice.closure.edges, 1);
    assert.equal(slice.commit, first.revision_id);
    assert.deepEqual(slice.native_source, pin);
    assert.equal(slice.graph_manifest_id, before.build_id);
    assert.equal(slice.graph_manifest_digest, pinned.manifest_digest);
    assert(slice.included_paths.includes("apps/web.ts"));
    assert(slice.included_paths.includes("lib/api.ts"));
    assert(!slice.included_paths.includes("other/steady.ts"));
  });
  record(
    "the packet native pin and published native snapshot derive a complete non FULL_TREE slice for the exact revision and import closure",
  );

  await assert.rejects(
    () => query(before, { ...first, root_tree_id: "sha256:" + "f".repeat(64) }),
    (e) => e.code === "GRAPH_SOURCE_MISMATCH",
  );
  await assert.rejects(
    () => query(before, first, { cursor: initial.next_cursor, q: "different" }),
    (e) => e.code === "RESNAPSHOT_REQUIRED" || e.code === "INVALID_CURSOR",
  );
  record("source mismatch and query cursor substitution are refused");
  const workspace = await f.client.call("source.workspaces.open", {
    workspace_id: randomUUID(),
    base_revision_id: first.revision_id,
    read_paths: paths,
    write_paths: paths,
    mode: "API_ONLY",
  });
  const overlay = await build(first, {
    overlay: {
      workspace_id: workspace.workspace.workspace_id,
      workspace_generation: workspace.workspace.workspace_generation,
      revision_id: first.revision_id,
    },
  });
  await f.client.call(
    "source.graph.publish",
    {
      build_id: overlay.build_id,
      channel: "overlay",
      expected_generation: "0",
    },
    { operation_id: randomUUID() },
  );
  const overlayContext = await query(overlay, first);
  assert.deepEqual(
    { ...overlayContext.identity.overlay },
    {
      workspace_id: workspace.workspace.workspace_id,
      workspace_generation: workspace.workspace.workspace_generation,
      revision_id: first.revision_id,
    },
  );
  await f.client.call(
    "source.workspaces.close",
    {
      workspace_id: workspace.workspace.workspace_id,
      expected_workspace_generation: workspace.workspace.workspace_generation,
    },
    { operation_id: randomUUID() },
  );
  await assert.rejects(
    () => query(overlay, first),
    (e) => e.code === "GRAPH_OVERLAY_STALE",
  );
  record(
    "closed overlay workspaces cannot serve stale graph context and graph admission leaves source queries responsive",
  );

  const second = await revision(
    { ...files, "lib/api.ts": "export function answer() { return 43; }\n" },
    first,
  );
  const changed = await build(second, { previous_build_id: before.build_id });
  assert.equal(changed.coverage.extracted_files, 1);
  assert.equal(changed.coverage.reused_files, 2);
  assert(changed.coverage.invalidated_paths.includes("apps/web.ts"));
  assert(changed.coverage.invalidated_paths.includes("lib/api.ts"));
  await publish(changed, 1);
  record(
    "immutable content extraction is reused while a changed cross-project import invalidates its consumer",
  );
  const reconfigured = await build(second, {
    previous_build_id: changed.build_id,
    configuration: {
      ...configuration,
      resolver_digest: "sha256:" + "3".repeat(64),
    },
  });
  assert.equal(reconfigured.coverage.extracted_files, 3);
  assert.deepEqual(reconfigured.coverage.invalidated_paths, paths);
  record(
    "resolver configuration changes invalidate extraction contexts and every selected consumer",
  );
  const pausedId = randomUUID(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    f.service.graph.build(
      f.context,
      {
        build_id: pausedId,
        revision_id: second.revision_id,
        root_tree_id: second.root_tree_id,
        paths,
        configuration,
      },
      controller.signal,
    ),
  );
  await assertRetained(changed, 2);
  record(
    "interrupted extraction preserves the last complete published generation",
  );
  const interruptedId = randomUUID(),
    midway = new AbortController();
  abortAfterFirst = { build_id: interruptedId, controller: midway };
  await assert.rejects(
    () =>
      f.service.graph.build(
        f.context,
        {
          build_id: interruptedId,
          revision_id: second.revision_id,
          root_tree_id: second.root_tree_id,
          paths,
          configuration: {
            ...configuration,
            resolver_digest: "sha256:" + "5".repeat(64),
          },
        },
        midway.signal,
      ),
    (error) => error.name === "AbortError",
  );
  assert.equal(midway.signal.aborted, true);
  const interrupted = (
    await f.pool.query(
      "SELECT b.state,(SELECT count(*)::int FROM hyperfide.source_graph_files f WHERE f.build_id=b.build_id) AS files FROM hyperfide.source_graph_builds b WHERE b.build_id=$1",
      [interruptedId],
    )
  ).rows[0];
  assert.equal(interrupted.state, "BUILDING");
  assert.equal(interrupted.files, 1);
  await assert.rejects(
    () => publish({ build_id: interruptedId }, 2),
    (error) => error.code === "GRAPH_INCOMPLETE",
  );
  await assertRetained(changed, 2);
  record(
    "aborting after the first extracted and persisted file leaves staging incomplete and retains the previous channel build and generation",
  );
  const faultOperation = randomUUID();
  await f.pool
    .query(`CREATE FUNCTION hyperfide.native_graph_publication_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.operation_id='${faultOperation}'::uuid THEN
  IF NOT EXISTS(SELECT 1 FROM hyperfide.source_graph_channels c JOIN hyperfide.source_graph_builds b USING(organisation_id,repository_id,security_domain_id,build_id) WHERE c.build_id=(NEW.result->>'build_id')::uuid AND c.generation=3 AND b.state='PUBLISHED') THEN RAISE EXCEPTION 'publication fault did not reach channel and build writes' USING ERRCODE='P0002'; END IF;
  RAISE EXCEPTION 'injected failure after channel and build publication' USING ERRCODE='P0001';
 END IF; RETURN NEW; END $$;
 CREATE TRIGGER native_graph_publication_fault BEFORE INSERT ON hyperfide.source_graph_publications FOR EACH ROW EXECUTE FUNCTION hyperfide.native_graph_publication_fault()`);
  try {
    await assert.rejects(
      () =>
        f.service.graph.publish(f.context, {
          operation_id: faultOperation,
          build_id: reconfigured.build_id,
          channel: "integration",
          expected_generation: "2",
        }),
      (error) =>
        error.code === "DB_UNAVAILABLE" &&
        error.message === "Primary transaction failed (P0001)",
    );
    await assertRetained(changed, 2);
    assert.equal(
      (
        await f.pool.query(
          "SELECT state FROM hyperfide.source_graph_builds WHERE build_id=$1",
          [reconfigured.build_id],
        )
      ).rows[0].state,
      "READY",
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM hyperfide.source_graph_publications WHERE operation_id=$1",
          [faultOperation],
        )
      ).rowCount,
      0,
    );
  } finally {
    await f.pool.query(
      "DROP TRIGGER native_graph_publication_fault ON hyperfide.source_graph_publications; DROP FUNCTION hyperfide.native_graph_publication_fault()",
    );
  }
  record(
    "a failure inside the publication transaction rolls back the new build state, channel build id, generation and publication receipt",
  );
  await gateway.withPrimaryTransaction({ timeoutMs: 10000 }, async (tx) => {
    await assert.rejects(
      () => snapshot(tx, changed, first),
      (error) => error.code === "GRAPH_SOURCE_MISMATCH",
    );
    const pinned = await snapshot(tx, changed, second);
    const fallback = await deriveNativeGraphSlice(
      tx,
      f.scope.organisation_id,
      nativePin(first),
      pinned,
      ["apps/web.ts"],
      { contracts: [], registries: [] },
      { files: 128, edges: 512 },
    );
    assert.equal(fallback.mode, "FULL_TREE");
    assert.equal(fallback.fallback_reason, "NATIVE_GRAPH_SOURCE_MISMATCH");
  });
  record(
    "native revision substitution is refused and slice source mismatch records its explicit FULL_TREE fallback",
  );
  const cap = randomUUID();
  await f.pool.query(
    `INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,ARRAY['source.graph.query'],ARRAY['apps'],clock_timestamp()+interval '10 minutes')`,
    [
      ...Object.values(f.scope),
      cap,
      f.roles.author.principal_id,
      f.roles.author.credential_id,
      f.sourcePolicy,
    ],
  );
  const { SourceControlClient } = await import(
    pathToFileURL(
      path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT, "client.js"),
    )
  );
  const scoped = new SourceControlClient({
    endpoint: f.endpoint,
    scope: f.scope,
    token: f.tokenFor("author", cap),
  });
  const restricted = await scoped.call("source.graph.query", {
    build_id: changed.build_id,
    revision_id: second.revision_id,
    root_tree_id: second.root_tree_id,
    mode: "dependencies",
    limit: 128,
  });
  assert.deepEqual(
    restricted.rows.map((r) => r.path),
    ["apps/web.ts"],
  );
  assert.deepEqual(restricted.rows[0].dependencies, []);
  assert(!JSON.stringify(restricted).includes("lib/api.ts"));
  assert.equal(restricted.scanned, 1);
  await assert.rejects(
    () =>
      scoped.call("source.graph.query", {
        build_id: changed.build_id,
        revision_id: second.revision_id,
        root_tree_id: second.root_tree_id,
        mode: "status",
        path: "lib/api.ts",
        limit: 1,
      }),
    (e) => e.code === "SCOPE_DENIED",
  );
  await f.pool.query(
    "UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1",
    [cap],
  );
  await assert.rejects(
    () =>
      scoped.call("source.graph.query", {
        build_id: changed.build_id,
        revision_id: second.revision_id,
        root_tree_id: second.root_tree_id,
        mode: "status",
      }),
    (e) => e.code === "SCOPE_DENIED",
  );
  record(
    "current source capabilities filter snippets and cross-project edges, and revocation fences cached graph access",
  );
  const third = await revision(
    {
      ...files,
      "lib/api.ts": "export function answer() { return 43; }\n",
      ...Object.fromEntries(
        Array.from({ length: 100 }, (_, n) => [
          "unrelated/" + n + ".txt",
          "unrelated",
        ]),
      ),
    },
    second,
  );
  const grown = await build(third, { previous_build_id: changed.build_id });
  assert.equal(grown.coverage.extracted_files, 0);
  assert.equal(grown.coverage.reused_files, 3);
  assert.deepEqual(grown.coverage.changed_paths, []);
  record(
    "unrelated monorepo growth performs no extra parser work for the selected scope",
  );
  const incomplete = await revision(
    { ...files, "other/steady.ts": "export function broken( {" },
    third,
  );
  const debt = await build(incomplete);
  assert.equal(debt.coverage.complete, false);
  await assert.rejects(
    () => publish(debt, 2),
    (e) => e.code === "GRAPH_INCOMPLETE",
  );
  const still = await query(changed, second, { limit: 128 });
  assert.equal(still.identity.revision_id, second.revision_id);
  record(
    "parser debt remains explicit and cannot replace the complete published graph",
  );
  const unresolved = await revision(
      {
        ...files,
        "apps/web.ts":
          "import { missing } from '../missing';\nexport function render() { return missing(); }\n",
      },
      third,
    ),
    unresolvedBuild = await build(unresolved);
  assert.equal(unresolvedBuild.coverage.complete, true);
  assert.equal(unresolvedBuild.coverage.resolution_complete, false);
  await f.client.call(
    "source.graph.publish",
    {
      build_id: unresolvedBuild.build_id,
      channel: "unresolved",
      expected_generation: "0",
    },
    { operation_id: randomUUID() },
  );
  await gateway.withPrimaryTransaction({ timeoutMs: 10000 }, async (tx) => {
    const pinned = await snapshot(tx, unresolvedBuild, unresolved);
    const fallback = await deriveNativeGraphSlice(
      tx,
      f.scope.organisation_id,
      nativePin(unresolved),
      pinned,
      ["apps/web.ts"],
      { contracts: [], registries: [] },
      { files: 128, edges: 512 },
    );
    assert.equal(fallback.mode, "FULL_TREE");
    assert.equal(fallback.fallback_reason, "NATIVE_GRAPH_COVERAGE_INCOMPLETE");
  });
  await assertRetained(changed, 2);
  record(
    "real unresolved native import coverage produces an explicit FULL_TREE fallback without replacing the complete integration graph",
  );
  const receipt = {
    status: "PASS",
    checks,
    backend_requests: f.backend.requests.length,
  };
  await fs.mkdir("build/source-control/3.3", { recursive: true });
  await fs.writeFile(
    "build/source-control/3.3/receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  await f.close();
  await fs.rm(scratch, { recursive: true, force: true });
}
