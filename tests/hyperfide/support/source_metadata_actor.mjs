import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createSourceS3Fixture } from "../cases/source_control/fixtures/objects/backend.mjs";
import { pathToFileURL } from "node:url";
const root = process.cwd(),
  modules = process.env.SOURCE_CONTROL_MODULE_ROOT;
if (!modules) throw Error("SOURCE_CONTROL_MODULE_ROOT required");
const load = (name) =>
  import(pathToFileURL(path.join(modules, name + ".js")).href);
const [
  { default: pg },
  {
    createSourceMetadata,
    SourceMetadata,
    revisionRequestDigest,
    revisionDescriptor,
    revisionIdentity,
  },
  { PostgresSourceObjectCatalog },
  { SourceObjectService, sourceObjectId, encodeTreeNode },
  { PersistentTree },
  { applySourceEvent },
  { SourceCollector },
  { S3SourceObjectBackend },
  { canonicalEnvelope },
] = await Promise.all([
  import(
    pathToFileURL(
      path.join(root, "core/control-plane/node_modules/pg/lib/index.js"),
    ).href
  ),
  load("metadata"),
  load("object_catalog"),
  load("objects"),
  load("trees"),
  load("events"),
  load("gc"),
  load("s3"),
  load("contracts"),
]);
const address = new URL(process.env.DATABASE_URL);
assert(
  address.searchParams.get("host")?.startsWith("/tmp/hyperfide/hf-withpg-"),
  "Only owned isolated PostgreSQL accepted",
);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 16,
});
const scope = {
    organisation_id: randomUUID(),
    repository_id: randomUUID(),
    security_domain_id: randomUUID(),
  },
  principal = randomUUID(),
  workspace = randomUUID();
const profile = {
  authority_epoch: "1",
  policy_version: "metadata-case-v1",
  durability_profile: "controlled-backend-postgres-v1",
};
const authority = async (tx, context, action) => {
  const row = (
    await tx.query(
      "SELECT enabled,workspace_generation::text FROM source_fixture_principals WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 FOR SHARE",
      [
        context.scope.organisation_id,
        context.scope.repository_id,
        context.scope.security_domain_id,
        context.principal_id,
      ],
    )
  ).rows[0];
  if (!row?.enabled)
    throw Object.assign(Error("Fixture principal revoked"), {
      code: "SOURCE_ACCESS_DENIED",
    });
  if (
    context.workspace &&
    action === "source.revisions.create" &&
    row.workspace_generation !== context.workspace.generation
  )
    throw Object.assign(Error("Fixture workspace revoked"), {
      code: "STALE_AUTHORITY",
    });
};
const store = createSourceMetadata(pool, { authorize: authority });
const backendFixture = await createSourceS3Fixture(),
  backend = new S3SourceObjectBackend(backendFixture.config);
const objects = new SourceObjectService(
    new PostgresSourceObjectCatalog({
      transaction: (fn) => store.transaction(fn),
    }),
    backend,
  ),
  trees = new PersistentTree(objects);
const context = {
  scope,
  principal_id: principal,
  authority_epoch: "1",
  expires_at: new Date(Date.now() + 600000).toISOString(),
  workspace: { workspace_id: workspace, generation: "1" },
};
const provenance = (message) => ({
  author: { name: "Metadata Case", email: "metadata@example.test" },
  message,
  timestamp: "2026-01-01T00:00:00.000Z",
});
const input = (
  tree,
  change = randomUUID(),
  message = "revision",
  parents = [],
  predecessors = [],
) => ({
  operation_id: randomUUID(),
  idempotency_key: randomUUID(),
  change_id: change,
  root_tree_id: tree,
  parent_revision_ids: parents,
  predecessor_revision_ids: predecessors,
  provenance: provenance(message),
});
const reject = async (fn, code) => {
  await assert.rejects(fn, (e) => e.code === code, code);
};
const checks = [];
async function assertRevisionEffects(
  target,
  request,
  expected,
  operationId = request.operation_id,
) {
  const revision = revisionIdentity(revisionDescriptor(target, request)),
    values = [
      target.organisation_id,
      target.repository_id,
      target.security_domain_id,
      revision,
      request.change_id,
      operationId,
    ];
  const count = (
    await pool.query(
      `SELECT
 (SELECT count(*) FROM hyperfide.source_metadata_operations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND operation_id=$6)::int AS operations,
 (SELECT count(*) FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4)::int AS revisions,
 (SELECT count(*) FROM hyperfide.source_change_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4 AND change_id=$5)::int AS memberships,
 (SELECT count(*) FROM hyperfide.source_revision_parents WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4)::int AS parents,
 (SELECT count(*) FROM hyperfide.source_events WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND payload->>'operation_id'=$6::text)::int AS events,
 (SELECT count(*) FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='REVISION' AND owner_id=$4)::int AS pins`,
      values,
    )
  ).rows[0];
  assert.deepEqual(count, {
    operations: expected,
    revisions: expected,
    memberships: expected,
    parents: expected * request.parent_revision_ids.length,
    events: expected,
    pins: expected,
  });
}
async function concurrentIdempotencyRace(tree) {
  const common = input(tree),
    requests = Array.from({ length: 18 }, (_, i) => ({
      ...common,
      operation_id: randomUUID(),
      provenance: provenance("concurrent-payload-" + (i % 6)),
    }));
  const outcomes = await Promise.allSettled(
    requests.map((request) => store.createRevision(context, request)),
  );
  const rows = (
    await pool.query(
      "SELECT operation_id,state,result,request_digest FROM hyperfide.source_metadata_operations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND idempotency_key=$5",
      [
        scope.organisation_id,
        scope.repository_id,
        scope.security_domain_id,
        principal,
        common.idempotency_key,
      ],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "COMMITTED");
  let replays = 0,
    conflicts = 0;
  for (let i = 0; i < requests.length; i++) {
    const outcome = outcomes[i],
      same =
        revisionRequestDigest(scope, requests[i]) === rows[0].request_digest;
    if (same) {
      assert.equal(outcome.status, "fulfilled");
      assert.deepEqual(outcome.value, rows[0].result);
      replays++;
    } else {
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.reason.code, "IDEMPOTENCY_CONFLICT");
      conflicts++;
    }
  }
  assert.equal(replays, 3);
  assert.equal(conflicts, 15);
  const winner = requests.find(
    (request) => request.operation_id === rows[0].operation_id,
  );
  assert(winner);
  await assertRevisionEffects(scope, winner, 1);
  for (const request of requests)
    if (revisionRequestDigest(scope, request) !== rows[0].request_digest)
      await assertRevisionEffects(scope, request, 0);
  checks.push(
    "simultaneous identical and different payloads share exactly one COMMITTED operation, revision, pin and event; all fifteen different payloads conflict",
  );
}
async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(
      Date.now() < deadline,
      "Real interleaving did not reach its barrier",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function revisionCollectionInterleavings() {
  const target = { ...scope, repository_id: randomUUID() },
    ctx = { ...context, scope: target },
    values = [
      target.organisation_id,
      target.repository_id,
      target.security_domain_id,
    ];
  await pool.query(
    "INSERT INTO source_fixture_principals VALUES($1,$2,$3,$4,true,1)",
    [...values, principal],
  );
  await store.registerRepository(target, profile);
  const collector = new SourceCollector(
    { transaction: (fn) => store.transaction(fn) },
    backend,
  );
  await collector.configure(target, {
    expected_generation: "0",
    minimum_age_seconds: 0,
    quarantine_seconds: 0,
    backup_until: "2020-01-01T00:00:00.000Z",
    backend_identity: backend.identity,
    independent_expiration: false,
  });
  const freshRoot = async (name) => {
    const file = await objects.putFile(target, Buffer.from(name));
    return (
      await trees.fromEntries(target, [
        {
          name: name + ".txt",
          kind: "file",
          mode: "100644",
          object_id: file.object_id,
        },
      ])
    ).root_tree_id;
  };
  const expireUploads = () =>
    pool.query(
      "UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='UPLOAD'",
      values,
    );
  const partition = (id) => parseInt(id.slice(7, 9), 16) % 16;
  const protectedRoot = await freshRoot("protected"),
    protectedInput = input(protectedRoot);
  await expireUploads();
  await collector.discover(target, {
    partition: partition(protectedRoot),
    limit: 256,
  });
  let enter, release;
  const entered = new Promise((resolve) => {
      enter = resolve;
    }),
    blocked = new Promise((resolve) => {
      release = resolve;
    });
  const registration = store.transaction(async (tx) => {
    const receipt = await store.createRevisionInTransaction(
      tx,
      ctx,
      protectedInput,
    );
    enter();
    await blocked;
    return receipt;
  });
  try {
    await entered;
    assert.deepEqual(
      (
        await collector.collect(target, {
          partition: partition(protectedRoot),
          limit: 256,
        })
      ).results,
      [],
    );
    await reject(
      () =>
        store.readRevision(
          ctx,
          revisionIdentity(revisionDescriptor(target, protectedInput)),
        ),
      "NOT_FOUND",
    );
  } finally {
    release();
    await registration;
  }
  await assertRevisionEffects(target, protectedInput, 1);
  assert.equal(
    (await objects.inspect(target, protectedRoot)).state,
    "VERIFIED",
  );
  const rescued = (
    await pool.query(
      "SELECT state FROM hyperfide.source_collection_work WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4",
      [...values, protectedRoot],
    )
  ).rows[0];
  assert.equal(rescued.state, "RESCUED");
  const removedRoot = await freshRoot("collected"),
    removedInput = input(removedRoot);
  await expireUploads();
  await collector.discover(target, {
    partition: partition(removedRoot),
    limit: 256,
  });
  backendFixture.faults.delayDelete = true;
  const collecting = collector.collect(target, {
    partition: partition(removedRoot),
    limit: 256,
  });
  try {
    await waitUntil(() => backendFixture.pendingDeletes.length === 1);
    await reject(
      () => store.createRevision(ctx, removedInput),
      "OBJECT_NOT_READY",
    );
    await assertRevisionEffects(target, removedInput, 0);
  } finally {
    backendFixture.resumeDeletes();
    await collecting;
  }
  assert.equal((await objects.inspect(target, removedRoot)).state, "ABSENT");
  const file = await objects.putFile(
    target,
    Buffer.from("in-flight native upload"),
  );
  const payload = encodeTreeNode({
      kind: "tree-leaf",
      prefix: "",
      entries: [
        {
          name: "upload.txt",
          kind: "file",
          mode: "100644",
          object_id: file.object_id,
        },
      ],
    }),
    id = sourceObjectId("tree-leaf", payload),
    envelope = canonicalEnvelope("tree-leaf", payload);
  const upload = await objects.beginUpload(target, {
    operation_id: randomUUID(),
    object_id: id,
    kind: "tree-leaf",
    size_bytes: String(envelope.length),
    owner_principal_id: principal,
  });
  const uploadInput = input(id);
  const discovered = await Promise.all([
    collector.discover(target, { partition: partition(id), limit: 256 }),
    reject(() => store.createRevision(ctx, uploadInput), "OBJECT_NOT_READY"),
  ]);
  assert(!discovered[0].quarantined.some((row) => row.object_id === id));
  assert.equal((await objects.inspect(target, id)).state, "UPLOADING");
  await assertRevisionEffects(target, uploadInput, 0);
  assert(
    !(
      await collector.collect(target, { partition: partition(id), limit: 256 })
    ).results.some((row) => row.object_id === id),
  );
  assert.equal(await backend.put(upload.storage_key, envelope), "ACKNOWLEDGED");
  await objects.completeUpload(target, upload.upload_id);
  await store.createRevision(ctx, uploadInput);
  await assertRevisionEffects(target, uploadInput, 1);
  checks.push(
    "real collector versus locked registration rescues one root; admitted deletion refuses with no partial rows; an in-flight upload stays pinned and cannot register until verified",
  );
}
async function replayAfterLeaseReleaseAndReassignment() {
  const setup = JSON.parse(process.env.SOURCE_METADATA_IDENTITY),
    ids = setup.ids;
  const controlLoad = (name) =>
    import(pathToFileURL(path.join(path.dirname(modules), name + ".js")));
  const [
    { createResourceContainer },
    { AuthorityStore, lookupAuthorityActivation },
    { FileExternalAuthorityJournal },
    { createComponent },
    { signingBytes, hash },
    { verifySourcePrincipalToken },
    { authorizeSource },
  ] = await Promise.all([
    controlLoad("storage/runtime"),
    controlLoad("storage/durability"),
    controlLoad("storage/authority_journal"),
    controlLoad("identity/enrollment"),
    controlLoad("transport/protocol"),
    load("authentication"),
    load("capabilities"),
  ]);
  const signal = new AbortController().signal,
    resources = createResourceContainer({
      role: "control",
      env: process.env,
      signal,
    });
  try {
    const journal = new FileExternalAuthorityJournal(
      process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR,
      (input) => lookupAuthorityActivation(resources, input),
    );
    const authorityStore = new AuthorityStore(
      resources,
      process.env.HYPERFIDE_DEPLOYMENT_ID,
      journal,
    );
    const identity = await createComponent({
      env: process.env,
      resources,
      signal,
      dependencies: {
        require(name, capability) {
          assert.equal(name, "4.4");
          assert.equal(capability, "storage.authority.v1");
          return authorityStore;
        },
      },
    });
    const authentication = identity.capabilities["identity.authority"];
    const target = {
        ...scope,
        organisation_id: ids.organisation,
        repository_id: randomUUID(),
      },
      owner = randomUUID(),
      credential = randomUUID(),
      capability = randomUUID(),
      keys = generateKeyPairSync("ed25519");
    const trusted = new SourceMetadata(pool, {
      transaction: (body) =>
        resources.gateway.withPrimaryTransaction(
          { timeoutMs: 10000, maxRetries: 0 },
          body,
        ),
    });
    await trusted.registerRepository(target, profile);
    const values = [
      target.organisation_id,
      target.repository_id,
      target.security_domain_id,
    ];
    await pool.query(
      "INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,$4)",
      [...values, profile.policy_version],
    );
    await pool.query(
      "INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at) VALUES($1,$2,$3,$4,$5,'automation',1,'metadata-replay','metadata-replay','owner',clock_timestamp()+interval '10 minutes')",
      [...values, credential, owner],
    );
    await pool.query(
      "INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,ARRAY[''],clock_timestamp()+interval '10 minutes')",
      [
        ...values,
        capability,
        owner,
        credential,
        profile.policy_version,
        ["source.revisions.create", "source.operations.read"],
      ],
    );
    const now = Math.floor(Date.now() / 1000),
      header = Buffer.from(
        JSON.stringify({ alg: "EdDSA", kid: "owner", typ: "HF-SOURCE-1" }),
      ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        iss: "metadata-replay",
        aud: "metadata-replay",
        sub: owner,
        credential_id: credential,
        credential_version: "1",
        principal_kind: "automation",
        scope: target,
        iat: now,
        nbf: now,
        exp: now + 300,
        capability_id: capability,
      }),
    ).toString("base64url");
    const token =
      header +
      "." +
      payload +
      "." +
      sign(null, Buffer.from(header + "." + payload), keys.privateKey).toString(
        "base64url",
      );
    const sourcePrincipal = verifySourcePrincipalToken(
      token,
      {
        issuer: "metadata-replay",
        audience: "metadata-replay",
        keys: { owner: keys.publicKey },
      },
      target,
    );
    const sourceAuthorization = await trusted.transaction((tx) =>
      authorizeSource(tx, {
        principal: sourcePrincipal,
        scope: target,
        action: "source.operations.read",
        mutation: false,
      }),
    );
    const proof = async (body, endpoint, credentialId, key) => {
      const item = {
        id: credentialId,
        time: String(Math.floor(Date.now() / 1000)),
        nonce: randomUUID(),
      };
      return [
        "HF-Credential-Id",
        item.id,
        "HF-Request-Time",
        item.time,
        "HF-Request-Nonce",
        item.nonce,
        "HF-Request-Signature",
        sign(
          null,
          signingBytes(setup.origin, endpoint, item, body),
          key,
        ).toString("base64url"),
      ];
    };
    const workerContext = async (credentialId, key) => {
      const operation = randomUUID(),
        request = {
          protocol_version: 1,
          scope: target,
          operation_id: operation,
          idempotency_key: operation,
          action: "source.operations.read",
          input: { operation_id: operation },
        };
      const body = Buffer.from(JSON.stringify(request)),
        invocation = await authentication.authenticateSource(
          body,
          await proof(body, "/api/v1/source-control", credentialId, key),
          signal,
        );
      return {
        ...sourceAuthorization,
        async assertCurrent(tx, action) {
          await sourceAuthorization.assertCurrent(tx, action);
          if (!invocation.principal.allowed_actions.includes(action))
            throw Error("Delegated worker lacks required action");
          await (action === "source.operations.read"
            ? invocation.identityGuard(tx)
            : invocation.guard(tx));
        },
      };
    };
    const oldContext = await workerContext(
      setup.worker.credential_id,
      await fs.readFile(setup.worker_key),
    );
    const root = await trees.empty(target),
      committedInput = input(root),
      pendingInput = input(root, randomUUID(), "reassigned pending");
    const begin = (request) => ({
      operation_id: request.operation_id,
      idempotency_key: request.idempotency_key,
      action: "source.revisions.create",
      request_digest: revisionRequestDigest(target, request),
    });
    const committed = await trusted.createRevision(oldContext, committedInput);
    assert.equal(
      (await trusted.beginOperation(oldContext, begin(pendingInput))).state,
      "PENDING",
    );
    await trusted.transaction(async (tx) => {
      await tx.query(
        "UPDATE hyperfide.attempts SET compute_authority='RELEASED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3",
        [ids.organisation, ids.run, ids.metadata_attempt],
      );
      await tx.query(
        "UPDATE hyperfide.compute_leases SET state='RELEASED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3",
        [ids.organisation, ids.run, ids.metadata_attempt],
      );
    });
    assert.deepEqual(
      (
        await pool.query(
          "SELECT state FROM hyperfide.compute_leases WHERE attempt_id=$1",
          [ids.metadata_attempt],
        )
      ).rows.map((row) => row.state),
      ["RELEASED"],
    );
    const afterRelease = await Promise.all(
      Array.from({ length: 8 }, () =>
        trusted.createRevision(oldContext, committedInput),
      ),
    );
    for (const receipt of afterRelease) assert.deepEqual(receipt, committed);
    assert.deepEqual(
      (await trusted.beginOperation(oldContext, begin(committedInput))).result,
      committed,
    );
    assert.deepEqual(
      (await trusted.operation(oldContext, committedInput.operation_id)).result,
      committed,
    );
    await reject(
      () =>
        trusted.createRevision(oldContext, {
          ...committedInput,
          provenance: provenance("tampered replay"),
        }),
      "IDEMPOTENCY_CONFLICT",
    );
    await reject(
      () => trusted.createRevision(oldContext, pendingInput),
      "STALE_AUTHORITY",
    );
    await assertRevisionEffects(target, committedInput, 1);
    const nextAttempt = randomUUID(),
      nextSession = randomUUID(),
      workerKeys = generateKeyPairSync("ed25519");
    await trusted.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) SELECT organisation_id,run_id,$2,task_id,2,authority_epoch,input_packet_digest,'CURRENT',sandbox_id,slot_id,sandbox_boot_generation,clock_timestamp()+interval '5 minutes' FROM hyperfide.attempts WHERE id=$1",
        [ids.metadata_attempt, nextAttempt],
      );
      await tx.query(
        "UPDATE hyperfide.tasks SET current_attempt_id=$2,generation=2,state_version=state_version+1 WHERE id=$1",
        [ids.metadata_task, nextAttempt],
      );
      await tx.query(
        "INSERT INTO hyperfide.compute_leases(organisation_id,run_id,attempt_id,attempt_generation,authority_epoch,sandbox_boot_generation,expires_at) SELECT organisation_id,run_id,id,generation,authority_epoch,sandbox_boot_generation,lease_expires_at FROM hyperfide.attempts WHERE id=$1",
        [nextAttempt],
      );
      await tx.query(
        "INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,attempt_id) SELECT organisation_id,run_id,$2,role,connector,account_key,$3,slot_id,sandbox_id,sandbox_boot_generation,$4 FROM hyperfide.agent_sessions WHERE id=$1",
        [ids.metadata_worker, nextSession, randomUUID(), nextAttempt],
      );
    });
    const operation = randomUUID(),
      delegate = {
        session_id: nextSession,
        public_key_b64: workerKeys.publicKey.export({ format: "jwk" }).x,
        allowed_actions: ["source.revisions.create", "source.operations.read"],
        ttl_seconds: 300,
      };
    const command = Buffer.from(
      JSON.stringify({
        run_id: ids.run,
        component: "14.1",
        action: "identity.principal.delegate",
        input: delegate,
        expected_version: null,
        authority: null,
      }),
    );
    const envelope = Buffer.from(
      JSON.stringify({
        protocol_version: 1,
        operation_id: operation,
        idempotency_key: operation,
        payload_digest: hash(command),
        correlation_id: operation,
        causation_id: null,
        payload_b64: command.toString("base64url"),
      }),
    );
    const runnerInvocation = await authentication.authenticate(
      envelope,
      await proof(
        envelope,
        "/v1/invoke",
        ids.runner,
        await fs.readFile(setup.runner_key),
      ),
      signal,
    );
    const delegated = await identity.actions["identity.principal.delegate"](
      delegate,
      { invocation: runnerInvocation, resources, signal },
    );
    const newContext = await workerContext(
      delegated.credential_id,
      workerKeys.privateKey,
    );
    await reject(
      () => trusted.createRevision(oldContext, pendingInput),
      "STALE_AUTHORITY",
    );
    assert.equal(
      (await trusted.operation(oldContext, pendingInput.operation_id)).state,
      "PENDING",
    );
    const completed = await Promise.all(
      Array.from({ length: 8 }, () =>
        trusted.createRevision(newContext, pendingInput),
      ),
    );
    for (const receipt of completed) assert.deepEqual(receipt, completed[0]);
    assert.equal(
      (await trusted.operation(newContext, pendingInput.operation_id)).state,
      "COMMITTED",
    );
    await assertRevisionEffects(target, pendingInput, 1);
    await pool.query(
      "UPDATE hyperfide.source_principal_credentials SET revoked_at=clock_timestamp() WHERE credential_id=$1",
      [credential],
    );
    await reject(
      () => trusted.createRevision(newContext, pendingInput),
      "UNAUTHENTICATED",
    );
    checks.push(
      "released real compute lease retains one committed receipt and event; signed replacement attempt completes pending work once while old attempt gets STALE_AUTHORITY and revoked source credentials stay denied",
    );
  } finally {
    await resources.close();
  }
}
let releaseLate = () => {},
  lateTransaction = null;
try {
  assert(
    process.env.SOURCE_METADATA_IDENTITY,
    "Real worker identity fixture required",
  );
  await pool.query(
    "CREATE TABLE source_fixture_principals(organisation_id uuid,repository_id uuid,security_domain_id uuid,principal_id uuid,enabled boolean,workspace_generation bigint,PRIMARY KEY(organisation_id,repository_id,security_domain_id,principal_id));CREATE TABLE source_fixture_effects(event_id uuid PRIMARY KEY,applications integer NOT NULL)",
  );
  await pool.query(
    "INSERT INTO source_fixture_principals VALUES($1,$2,$3,$4,true,1)",
    [
      scope.organisation_id,
      scope.repository_id,
      scope.security_domain_id,
      principal,
    ],
  );
  await store.registerRepository(scope, profile);
  const empty = await trees.empty(scope),
    file = await objects.putFile(scope, Buffer.from("native source\n"));
  const populated = (
    await trees.patch(scope, empty, [
      {
        path: "core/source.txt",
        operation: "put",
        kind: "file",
        mode: "100644",
        object_id: file.object_id,
      },
    ])
  ).root_tree_id;
  const firstInput = input(empty),
    first = await store.createRevision(context, firstInput);
  const replay = await Promise.all(
    Array.from({ length: 12 }, () => store.createRevision(context, firstInput)),
  );
  for (const value of replay) assert.deepEqual(value, first);
  const count = (
    await pool.query(
      "SELECT (SELECT count(*) FROM hyperfide.source_revisions)::int AS revisions,(SELECT count(*) FROM hyperfide.source_events)::int AS events,(SELECT count(*) FROM hyperfide.source_object_pins WHERE owner_kind='REVISION')::int AS pins",
    )
  ).rows[0];
  assert.deepEqual(count, { revisions: 1, events: 1, pins: 1 });
  await reject(
    () =>
      store.createRevision(context, {
        ...firstInput,
        provenance: provenance("changed"),
      }),
    "IDEMPOTENCY_CONFLICT",
  );
  checks.push(
    "concurrent identical retries preserve one revision, pin, result and event; changed payload conflicts",
  );
  await concurrentIdempotencyRace(empty);
  const successors = await Promise.all(
    ["left", "right"].map((message) =>
      store.createRevision(
        context,
        input(
          populated,
          firstInput.change_id,
          message,
          [first.revision_id],
          [first.revision_id],
        ),
      ),
    ),
  );
  assert.notEqual(successors[0].revision_id, successors[1].revision_id);
  const change = await store.changeRevisions(context, firstInput.change_id, {
    limit: 2,
  });
  assert.equal(change.revisions.length, 2);
  assert(change.next_cursor);
  const rest = await store.changeRevisions(context, firstInput.change_id, {
    limit: 2,
    after: change.next_cursor,
  });
  assert.equal(rest.revisions.length, 1);
  const child = await store.readRevision(context, successors[0].revision_id);
  assert.deepEqual(child.parent_revision_ids, [first.revision_id]);
  assert.equal(
    (
      await objects.readFile(
        scope,
        (await trees.lookup(scope, child.root_tree_id, "core/source.txt"))
          .object_id,
      )
    ).toString(),
    "native source\n",
  );
  checks.push(
    "same-change successors remain divergent, paginated and independently readable",
  );
  const abandoned = input(empty, randomUUID(), "rollback");
  await assert.rejects(
    store.transaction(async (tx) => {
      await store.createRevisionInTransaction(tx, context, abandoned);
      throw Error("caller rollback");
    }),
  );
  await reject(
    () => store.operation(context, abandoned.operation_id),
    "NOT_FOUND",
  );
  checks.push(
    "caller-owned transaction rolls back revision, operation, pins and outbox atomically",
  );
  const pending = input(empty, randomUUID(), "cancel");
  await store.beginOperation(context, {
    operation_id: pending.operation_id,
    idempotency_key: pending.idempotency_key,
    action: "source.revisions.create",
    request_digest: revisionRequestDigest(scope, pending),
  });
  assert.equal(
    (await store.cancel(context, pending.operation_id)).disposition,
    "CANCELLED",
  );
  await reject(
    () => store.createRevision(context, pending),
    "OPERATION_CANCELLED",
  );
  assert.equal(
    (await store.cancel(context, first.operation_id)).disposition,
    "TOO_LATE",
  );
  await pool.query(
    "UPDATE source_fixture_principals SET workspace_generation=2",
  );
  await reject(
    () => store.createRevision(context, input(empty)),
    "STALE_AUTHORITY",
  );
  assert.deepEqual(
    (await store.operation(context, first.operation_id)).result,
    first,
  );
  assert.deepEqual(await store.createRevision(context, firstInput), first);
  await pool.query(
    "UPDATE source_fixture_principals SET workspace_generation=1,enabled=false",
  );
  await reject(
    () => store.readRevision(context, first.revision_id),
    "SOURCE_ACCESS_DENIED",
  );
  await pool.query("UPDATE source_fixture_principals SET enabled=true");
  checks.push(
    "cancellation before commit, too-late cancellation, retained operation read and revocation",
  );
  const other = { ...scope, security_domain_id: randomUUID() };
  await store.registerRepository(other, profile);
  await pool.query(
    "INSERT INTO source_fixture_principals VALUES($1,$2,$3,$4,true,1)",
    [
      other.organisation_id,
      other.repository_id,
      other.security_domain_id,
      principal,
    ],
  );
  await reject(
    () => store.readRevision({ ...context, scope: other }, first.revision_id),
    "NOT_FOUND",
  );
  await reject(
    () =>
      store.createRevision(
        { ...context, scope: other },
        input(empty, randomUUID(), "foreign", [first.revision_id]),
      ),
    "NOT_FOUND",
  );
  const unavailable = (
    await trees.patch(scope, empty, [
      {
        path: "other.txt",
        operation: "put",
        kind: "file",
        mode: "100644",
        object_id: file.object_id,
      },
    ])
  ).root_tree_id;
  await pool.query(
    "UPDATE hyperfide.source_native_objects SET state='DELETE_PENDING' WHERE object_id=$1",
    [unavailable],
  );
  const refused = input(unavailable);
  await reject(
    () => store.createRevision(context, refused),
    "OBJECT_NOT_READY",
  );
  await reject(
    () => store.operation(context, refused.operation_id),
    "NOT_FOUND",
  );
  checks.push(
    "cross-domain parent/read refusal and collectible-root admission have no partial mutation",
  );
  await revisionCollectionInterleavings();
  const subscription = await store.subscribe(context, {
    consumer_id: randomUUID(),
    bootstrap_revision_id: first.revision_id,
  });
  for (;;) {
    const batch = await store.pollEvents(context, subscription);
    if (!batch.deliveries.length) break;
    for (const d of batch.deliveries)
      await store.acknowledgeEvent(context, {
        ...subscription,
        event_id: d.event_id,
        lease_id: d.lease_id,
      });
  }
  let resume, ready;
  const blocked = new Promise((resolve) => {
      resume = resolve;
    }),
    entered = new Promise((resolve) => {
      ready = resolve;
    });
  const lateInput = input(empty, randomUUID(), "late commit");
  const late = store.transaction(async (tx) => {
    const receipt = await store.createRevisionInTransaction(
      tx,
      context,
      lateInput,
    );
    ready();
    await blocked;
    return receipt;
  });
  releaseLate = resume;
  lateTransaction = late;
  await entered;
  const early = await store.createRevision(
    context,
    input(populated, randomUUID(), "early commit"),
  );
  let batch = await store.pollEvents(context, subscription);
  assert.equal(batch.deliveries.length, 1);
  assert.equal(batch.deliveries[0].payload.operation_id, early.operation_id);
  const earlyDelivery = batch.deliveries[0],
    ack = {
      ...subscription,
      event_id: earlyDelivery.event_id,
      lease_id: earlyDelivery.lease_id,
    };
  const apply = async (tx) =>
    (
      await tx.query(
        "INSERT INTO source_fixture_effects VALUES($1,1) ON CONFLICT(event_id) DO UPDATE SET applications=source_fixture_effects.applications+1 RETURNING applications",
        [earlyDelivery.event_id],
      )
    ).rows[0];
  const applied = await applySourceEvent(store, context, ack, apply),
    duplicate = await applySourceEvent(store, context, ack, apply);
  assert.equal(applied.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.result, applied.result);
  assert.equal(
    (
      await pool.query(
        "SELECT applications FROM source_fixture_effects WHERE event_id=$1",
        [earlyDelivery.event_id],
      )
    ).rows[0].applications,
    1,
  );
  await reject(
    () => store.acknowledgeEvent(context, { ...ack, lease_id: randomUUID() }),
    "STALE_LEASE",
  );
  resume();
  await late;
  batch = await store.pollEvents(context, subscription);
  assert.equal(batch.deliveries.length, 1);
  assert.equal(
    batch.deliveries[0].payload.operation_id,
    lateInput.operation_id,
  );
  checks.push(
    "event A commits after delivered B and is still delivered; inbox and effect commit once",
  );
  const lostInput = input(empty, randomUUID(), "lost acknowledgment");
  let lose = true;
  const lossy = new SourceMetadata(
    {
      async connect() {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, key) {
            if (key === "query")
              return async (...args) => {
                const value = await target.query(...args);
                if (args[0] === "COMMIT" && lose) {
                  lose = false;
                  throw Error("controlled lost COMMIT response");
                }
                return value;
              };
            const value = target[key];
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    },
    { authorize: authority },
  );
  await assert.rejects(
    lossy.createRevision(context, lostInput),
    (e) => e.code === "COMMIT_AMBIGUOUS" && e.outcome === "UNKNOWN",
  );
  const recovered = await store.operation(context, lostInput.operation_id);
  assert.equal(recovered.state, "COMMITTED");
  assert.deepEqual(
    await store.createRevision(context, lostInput),
    recovered.result,
  );
  const gatewayLostInput = input(
    empty,
    randomUUID(),
    "lost gateway acknowledgment",
  );
  const gatewayLost = new SourceMetadata(pool, {
    authorize: authority,
    transaction: async (body) => {
      await store.transaction(body);
      throw Object.assign(Error("controlled gateway COMMIT response loss"), {
        code: "COMMIT_AMBIGUOUS",
      });
    },
  });
  await assert.rejects(
    gatewayLost.createRevision(context, gatewayLostInput),
    (e) => e.code === "COMMIT_AMBIGUOUS" && e.outcome === "UNKNOWN",
  );
  assert.equal(
    (await store.operation(context, gatewayLostInput.operation_id)).state,
    "COMMITTED",
  );
  checks.push(
    "actual committed transaction with lost response resolves by original operation without a second effect",
  );
  await assert.rejects(
    pool.query(
      "UPDATE hyperfide.source_revisions SET descriptor='{}' WHERE revision_id=$1",
      [first.revision_id],
    ),
    (e) => e.code === "23514",
  );
  await reject(
    () =>
      store.createRevision(
        { ...context, authority_epoch: "9223372036854775808" },
        input(empty),
      ),
    "LIMIT_EXCEEDED",
  );
  await replayAfterLeaseReleaseAndReassignment();
  await pool.query(
    "UPDATE hyperfide.source_repositories SET authority_epoch=2",
  );
  await reject(
    () => store.createRevision(context, input(empty)),
    "STALE_AUTHORITY",
  );
  await assert.rejects(
    pool.query("UPDATE hyperfide.source_repositories SET authority_epoch=1"),
    (e) => e.code === "23514",
  );
  checks.push(
    "immutable history and monotonic authority epoch enforce typed backend bounds",
  );
  const receipt = {
    status: "PASS",
    scope:
      "isolated PostgreSQL, real signed worker identity, production metadata/catalog/collector and SigV4 HTTP component backend; no live-S3 claim",
    checks,
    assertion_groups: checks.length,
    backend_requests: backendFixture.requests.length,
  };
  await fs.mkdir("build/source-control/1.2", { recursive: true });
  await fs.writeFile(
    "build/source-control/1.2/receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  releaseLate();
  if (lateTransaction) await lateTransaction.catch(() => {});
  backendFixture.resumeDeletes();
  await backendFixture.close();
  await pool.end();
}
