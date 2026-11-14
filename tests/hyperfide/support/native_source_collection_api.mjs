import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import pg from "../../../core/control-plane/node_modules/pg/lib/index.js";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";
const load = (name) =>
  import(
    pathToFileURL(process.env.SOURCE_CONTROL_MODULE_ROOT + "/" + name + ".js")
  );
const [
  { createLocalGitDestination },
  { SourceWorkspaceService },
  { SourceMetadata },
  { sourceObjectId, encodeFileDescriptor },
  { canonicalEnvelope },
] = await Promise.all([
  load("git/transport"),
  load("workspaces"),
  load("metadata"),
  load("objects"),
  load("contracts"),
]);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 16,
});
for (const migration of JSON.parse(process.env.SOURCE_CONTROL_MIGRATIONS))
  await pool.query(
    await fs.readFile("core/control-plane/migrations/" + migration, "utf8"),
  );
await pool.query("ALTER SYSTEM SET fsync='on'");
await pool.query("ALTER SYSTEM SET synchronous_commit='on'");
await pool.query("SELECT pg_reload_conf()");
for (let attempt = 0; attempt < 100; attempt++) {
  const current = (
    await pool.query(
      "SELECT current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS commit",
    )
  ).rows[0];
  if (current.fsync === "on" && current.commit === "on") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(
  (await pool.query("SELECT current_setting('fsync') AS value")).rows[0].value,
  "on",
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "hf-source-collection-export-"),
);
const scope = {
  organisation_id: randomUUID(),
  repository_id: randomUUID(),
  security_domain_id: randomUUID(),
};
const remote = path.join(temporary, "retained.git");
execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
const destination = createLocalGitDestination({
  scope,
  id: "retention-export",
  repository_identity: "retention-export",
  path: remote,
  allowed_refs: ["refs/heads/main", "refs/heads/cancelled"],
});
const f = await createNativeAcceptanceFixture({
    pool,
    migrate: false,
    scope,
    serviceOptions: { publication: { destinations: [destination] } },
    actions: [
      "source.objects.put",
      "source.objects.read",
      "source.revisions.create",
      "source.revisions.read",
      "source.operations.read",
      "source.domains.create",
      "source.workspaces.open",
      "source.workspaces.detail",
      "source.workspaces.checkpoint",
      "source.workspaces.close",
      "source.candidates.create",
      "source.candidates.read",
      "source.candidates.qualify",
      "source.acceptance.accept",
      "source.acceptance.read",
      "source.lifecycle.read",
      "source.assurance.custody.create",
      "source.assurance.publish",
      "source.assurance.revoke",
      "source.publications.create",
      "source.publications.resume",
      "source.publications.cancel",
      "source.publications.read",
      "source.backups.create",
      "source.backups.verify",
      "source.retention.configure",
      "source.retention.acquire",
      "source.retention.release",
      "source.retention.reserve",
      "source.retention.reconcile",
      "source.collection.discover",
      "source.collection.collect",
      "source.collection.inspect",
    ],
  }),
  checks = [];
const scopeValues = Object.values(f.scope),
  partitionOf = (id) => parseInt(id.slice(7, 9), 16) % 16;
const roots = async (kind, owner) =>
  (
    await f.pool.query(
      "SELECT * FROM hyperfide.source_retention_roots WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind=$4 AND owner_id=$5 ORDER BY object_id",
      [...scopeValues, kind, owner],
    )
  ).rows;
const uploadExpiry = async (ids) =>
  f.pool.query(
    "UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='UPLOAD' AND object_id=ANY($4::text[])",
    [...scopeValues, ids],
  );
const sweep = async () => {
  for (let round = 0; round < 3; round++)
    for (let partition = 0; partition < 16; partition++) {
      await f.mutation("source.collection.discover", { partition, limit: 256 });
      await f.mutation("source.collection.collect", { partition, limit: 256 });
    }
};
try {
  const policy = {
    expected_generation: "0",
    minimum_age_seconds: 0,
    quarantine_seconds: 0,
    backup_until: "2000-01-01T00:00:00Z",
    backend_identity:
      "s3-v1:" + new URL(f.backend.config.endpoint).origin + "/fixture-bucket",
    independent_expiration: false,
  };
  assert.equal(
    (await f.mutation("source.retention.configure", policy)).generation,
    "1",
  );
  assert.equal(
    (await f.mutation("source.retention.configure", policy)).generation,
    "1",
  );
  f.backend.configuration.lifecycle =
    "<LifecycleConfiguration><Rule><Status>Enabled</Status><Filter><Prefix>source/v1/</Prefix></Filter><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>";
  await assert.rejects(
    f.mutation("source.retention.configure", {
      ...policy,
      expected_generation: "1",
    }),
    (error) => error.code === "RETENTION_POLICY_INVALID",
  );
  f.backend.configuration.lifecycle = null;
  assert(
    f.backend.requests.some((request) =>
      Object.hasOwn(request.query, "lifecycle"),
    ),
  );
  assert(
    f.backend.requests.some((request) =>
      Object.hasOwn(request.query, "versioning"),
    ),
  );
  checks.push(
    "registered retention configuration reads the signed bucket lifecycle and refuses a real overlapping expiration rule",
  );
  const uploaded = await f.mutation("source.objects.put", {
      kind: "blob",
      payload_base64: Buffer.from("api retained source").toString("base64"),
    }),
    id = uploaded.object_id,
    partition = parseInt(id.slice(7, 9), 16) % 16;
  await f.pool.query(
    "UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND owner_kind='UPLOAD'",
    [...Object.values(f.scope), id],
  );
  const root = {
    root_id: randomUUID(),
    owner_kind: "EXPORT",
    owner_id: "exact-export",
    object_id: id,
  };
  const retained = await f.mutation("source.retention.acquire", root);
  assert.equal(retained.object_id, id);
  assert.deepEqual(
    await f.mutation("source.retention.acquire", root),
    retained,
  );
  assert.equal(
    (await f.mutation("source.collection.discover", { partition, limit: 1 }))
      .quarantined.length,
    0,
  );
  await assert.rejects(
    f.mutation("source.retention.release", {
      root_id: root.root_id,
      owner_kind: "EXPORT",
      owner_id: "wrong-export",
    }),
    (error) => error.code === "RETENTION_OWNER_MISMATCH",
  );
  await f.mutation("source.retention.release", {
    root_id: root.root_id,
    owner_kind: "EXPORT",
    owner_id: root.owner_id,
  });
  await f.mutation("source.collection.discover", { partition, limit: 1 });
  const debt = await f.client.call("source.collection.inspect", {
    partition,
    limit: 1,
  });
  assert.equal(debt.work.length, 1);
  assert.equal(debt.work[0].object_id, id);
  const rescued = {
    ...root,
    root_id: randomUUID(),
    owner_kind: "HOLD",
    owner_id: "rescue",
  };
  await f.mutation("source.retention.acquire", rescued);
  assert.equal(
    (await f.client.object(id)).payload_base64,
    Buffer.from("api retained source").toString("base64"),
  );
  checks.push(
    "registered authenticated retention API acquires, replays, rejects wrong owner, exposes debt and rescues source",
  );
  await f.mutation("source.retention.release", {
    root_id: rescued.root_id,
    owner_kind: "HOLD",
    owner_id: "rescue",
  });
  await f.mutation("source.collection.discover", { partition, limit: 1 });
  const result = await f.mutation("source.collection.collect", {
    partition,
    limit: 1,
  });
  assert.equal(result.results[0].outcome, "ABSENT");
  assert.equal(
    (await f.client.call("source.collection.inspect", { partition, limit: 1 }))
      .work.length,
    0,
  );
  checks.push(
    "registered collection executes exact conditional deletion and removes resolved debt",
  );
  const classes = [
      "WORKSPACE",
      "CUSTODY",
      "CANDIDATE",
      "EVIDENCE",
      "IMPORT",
      "EXPORT",
      "BACKUP",
      "HOLD",
    ],
    inventory = [];
  for (const owner_kind of classes) {
    const bytes = Buffer.from("retention closure " + owner_kind),
      blob = await f.mutation("source.objects.put", {
        kind: "blob",
        payload_base64: bytes.toString("base64"),
      });
    const descriptor = [
      1,
      String(bytes.length),
      "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      ["blob", blob.object_id],
    ];
    const file = await f.mutation("source.objects.put", {
      kind: "file",
      payload_base64: Buffer.from(JSON.stringify(descriptor)).toString(
        "base64",
      ),
    });
    const leaf = await f.mutation("source.objects.put", {
      kind: "tree-leaf",
      payload_base64: Buffer.from(
        JSON.stringify([
          1,
          "",
          [["kept.txt", "file", "100644", file.object_id]],
        ]),
      ).toString("base64"),
    });
    const root = {
      root_id: randomUUID(),
      owner_kind,
      owner_id: "case-root-" + owner_kind,
      object_id: leaf.object_id,
    };
    await f.mutation("source.retention.acquire", root);
    inventory.push({
      root,
      objects: [leaf.object_id, file.object_id, blob.object_id],
      bytes,
    });
  }
  await f.pool.query(
    "UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='UPLOAD' AND object_id=ANY($4::text[])",
    [...Object.values(f.scope), inventory.flatMap((item) => item.objects)],
  );
  for (let round = 0; round < 3; round++)
    for (let part = 0; part < 16; part++) {
      await f.mutation("source.collection.discover", {
        partition: part,
        limit: 256,
      });
      await f.mutation("source.collection.collect", {
        partition: part,
        limit: 256,
      });
    }
  for (const item of inventory) {
    for (const object_id of item.objects)
      assert.equal((await f.client.object(object_id)).object_id, object_id);
    const blob = await f.client.object(item.objects[2]);
    assert(Buffer.from(blob.payload_base64, "base64").equals(item.bytes));
  }
  checks.push(
    "every declared workspace custody candidate evidence import export backup and hold root preserves independently retrieved tree file and blob closure while upload pins expire",
  );
  for (const item of inventory)
    await f.mutation("source.retention.release", {
      root_id: item.root.root_id,
      owner_kind: item.root.owner_kind,
      owner_id: item.root.owner_id,
    });
  for (let round = 0; round < 3; round++)
    for (let part = 0; part < 16; part++) {
      await f.mutation("source.collection.discover", {
        partition: part,
        limit: 256,
      });
      await f.mutation("source.collection.collect", {
        partition: part,
        limit: 256,
      });
    }
  for (const item of inventory)
    for (const object_id of item.objects)
      await assert.rejects(
        f.client.object(object_id),
        (error) => error.code === "OBJECT_NOT_READY",
      );
  checks.push(
    "ending each declared root obligation reclaims parent before children without erasing another retained closure",
  );

  const workspaceRevision = await f.createRevision({
      text: "workspace base\n",
    }),
    workspaceId = randomUUID();
  const opened = await f.mutation("source.workspaces.open", {
    workspace_id: workspaceId,
    base_revision_id: workspaceRevision.revision_id,
    mode: "API_ONLY",
    read_paths: [""],
    write_paths: [""],
  });
  const pinRows = async (id) =>
    (
      await f.pool.query(
        "SELECT object_id,incarnation_id,position,expires_at FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='WORKSPACE' AND owner_id=$4 ORDER BY position",
        [...scopeValues, id],
      )
    ).rows;
  assert.equal(
    (await pinRows(workspaceId))[0].object_id,
    workspaceRevision.root_tree_id,
  );
  const changedFile = await f.service.objects.putFile(
    f.scope,
    Buffer.from("workspace checkpoint\n"),
  );
  const checkpointOperation = randomUUID();
  const checkpoint = await f.mutation(
    "source.workspaces.checkpoint",
    {
      operation_id: checkpointOperation,
      workspace_id: workspaceId,
      expected_workspace_generation: opened.workspace.workspace_generation,
      expected_scope_generation: opened.workspace.scope_generation,
      base_revision_id: workspaceRevision.revision_id,
      overlay_generation: "1",
      changes: [
        {
          path: "main.txt",
          operation: "put",
          kind: "file",
          mode: "100644",
          object_id: changedFile.object_id,
        },
      ],
    },
    { operation_id: checkpointOperation, idempotency_key: checkpointOperation },
  );
  const workspacePins = await pinRows(workspaceId);
  assert.equal(workspacePins.length, 2);
  assert.deepEqual(
    workspacePins.map((pin) => pin.object_id),
    [workspaceRevision.root_tree_id, checkpoint.workspace.root_tree_id],
  );
  const reopened = await f.mutation("source.workspaces.open", {
    workspace_id: workspaceId,
    base_revision_id: workspaceRevision.revision_id,
    mode: "API_ONLY",
    read_paths: [""],
    write_paths: [""],
  });
  assert.equal(
    reopened.workspace.root_tree_id,
    checkpoint.workspace.root_tree_id,
  );
  assert.equal((await pinRows(workspaceId)).length, 2);
  await f.pool.query(
    "DELETE FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='REVISION' AND owner_id=ANY($4::text[])",
    [...scopeValues, [workspaceRevision.revision_id, checkpoint.revision_id]],
  );
  await uploadExpiry([
    workspaceRevision.root_tree_id,
    checkpoint.workspace.root_tree_id,
    changedFile.object_id,
  ]);
  await sweep();
  assert.equal(
    (await f.client.object(workspaceRevision.root_tree_id)).object_id,
    workspaceRevision.root_tree_id,
  );
  assert.equal(
    (await f.client.object(checkpoint.workspace.root_tree_id)).object_id,
    checkpoint.workspace.root_tree_id,
  );
  await f.mutation("source.workspaces.close", {
    workspace_id: workspaceId,
    expected_workspace_generation: checkpoint.workspace.workspace_generation,
  });
  assert.equal((await pinRows(workspaceId)).length, 0);
  await sweep();
  for (const object_id of [
    workspaceRevision.root_tree_id,
    checkpoint.workspace.root_tree_id,
  ])
    await assert.rejects(
      f.client.object(object_id),
      (error) => error.code === "OBJECT_NOT_READY",
    );
  const expiringRevision = await f.createRevision({
      text: "expiring workspace\n",
    }),
    expiringId = randomUUID();
  await f.mutation("source.workspaces.open", {
    workspace_id: expiringId,
    base_revision_id: expiringRevision.revision_id,
    mode: "API_ONLY",
    read_paths: [""],
    write_paths: [""],
  });
  await f.pool.query(
    "UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='WORKSPACE' AND owner_id=$4",
    [...scopeValues, expiringId],
  );
  await assert.rejects(
    f.client.call("source.workspaces.detail", { workspace_id: expiringId }),
    (error) => error.code === "WORKSPACE_EXPIRED",
  );
  const restartedWorkspaces = new SourceWorkspaceService(
    new SourceMetadata(f.pool),
    f.service.trees,
    f.service.workspaces.budgets,
  );
  assert.deepEqual(
    (await restartedWorkspaces.expire(f.context, { limit: 32 })).expired,
    [expiringId],
  );
  assert.equal((await pinRows(expiringId)).length, 0);
  checks.push(
    "real workspace open and checkpoint atomically retain base and checkpoint roots, survive service reconstruction and release their own pins on close and expiry",
  );

  const revision = await f.createRevision({
      text: "candidate: retention roots\n",
      parent_revision_ids: [],
    }),
    candidate = await f.createCandidate(revision, {
      domain: await f.createDomain(revision),
    });
  const candidateRoots = await roots("CANDIDATE", candidate.candidate_id);
  assert.equal(candidateRoots.length, 1);
  assert.equal(candidateRoots[0].object_id, revision.root_tree_id);
  assert.equal(candidateRoots[0].state, "ACTIVE");
  const publishedEvidence = await f.publishEvidence(candidate),
    evidenceId = publishedEvidence.evidence.evidence_id;
  const evidenceRoots = await roots("EVIDENCE", evidenceId),
    executionReceipt = publishedEvidence.execution.receipt;
  const expectedEvidence = [
    ...new Set([
      publishedEvidence.execution.receipt_object_id,
      executionReceipt.output.stdout_object_id,
      executionReceipt.output.stderr_object_id,
      ...executionReceipt.artifacts.map((artifact) => artifact.object_id),
    ]),
  ].sort();
  assert.deepEqual(
    evidenceRoots.map((root) => root.object_id),
    expectedEvidence,
  );
  assert(evidenceRoots.every((root) => root.state === "ACTIVE"));
  await uploadExpiry([revision.root_tree_id, ...expectedEvidence]);
  await sweep();
  for (const object_id of [revision.root_tree_id, ...expectedEvidence])
    assert.equal((await f.client.object(object_id)).object_id, object_id);
  const qualified = await f.qualify(candidate, {
    published: publishedEvidence,
  });
  assert.deepEqual(await roots("EVIDENCE", evidenceId), evidenceRoots);
  checks.push(
    "real candidate creation and evidence publication acquire exact CANDIDATE and EVIDENCE roots before qualification, retaining the tree, receipt, output and artifacts across collection",
  );
  const accepted = await f.accept(candidate, qualified),
    publication = await f.mutation("source.publications.create", {
      acceptance_id: accepted.acceptance_id,
      destination_id: destination.id,
      target_ref: "refs/heads/main",
      expected_old_oid: null,
    });
  const exportOwner =
    f.roles.author.principal_id + "/" + publication.operation_id;
  assert.equal((await roots("EXPORT", exportOwner))[0].state, "ACTIVE");
  const published = await f.mutation("source.publications.resume", {
    operation_id: publication.operation_id,
  });
  assert.equal(published.status, "PUBLISHED");
  assert.equal((await roots("EXPORT", exportOwner))[0].state, "RELEASED");
  assert.equal(
    "git:sha1:" +
      execFileSync(
        "git",
        ["--git-dir=" + remote, "rev-parse", "refs/heads/main"],
        { encoding: "utf8" },
      ).trim(),
    published.git_oid,
  );
  const cancelled = await f.mutation("source.publications.create", {
    acceptance_id: accepted.acceptance_id,
    destination_id: destination.id,
    target_ref: "refs/heads/cancelled",
    expected_old_oid: null,
  });
  assert.equal(
    (
      await roots(
        "EXPORT",
        f.roles.author.principal_id + "/" + cancelled.operation_id,
      )
    )[0].state,
    "ACTIVE",
  );
  assert.equal(
    (
      await f.mutation("source.publications.cancel", {
        operation_id: cancelled.operation_id,
      })
    ).status,
    "CANCELLED",
  );
  assert.equal(
    (
      await roots(
        "EXPORT",
        f.roles.author.principal_id + "/" + cancelled.operation_id,
      )
    )[0].state,
    "RELEASED",
  );
  checks.push(
    "real local Git publication retains an EXPORT root across dispatch and releases it after confirmed publication or cancellation",
  );
  await f.mutation(
    "source.assurance.revoke",
    { evidence_id: evidenceId },
    {},
    f.checkerClient,
  );
  assert(
    (await roots("EVIDENCE", evidenceId)).every(
      (root) => root.state === "RELEASED",
    ),
  );
  await sweep();
  for (const object_id of expectedEvidence)
    await assert.rejects(
      f.client.object(object_id),
      (error) => error.code === "OBJECT_NOT_READY",
    );
  await f.mutation("source.retention.release", {
    root_id: candidateRoots[0].root_id,
    owner_kind: "CANDIDATE",
    owner_id: candidate.candidate_id,
  });
  assert.equal(
    (await roots("CANDIDATE", candidate.candidate_id))[0].state,
    "RELEASED",
  );
  checks.push(
    "terminal evidence revocation and explicit candidate retention release remove producer roots without disturbing accepted source",
  );

  const child = await f.mutation("source.objects.put", {
      kind: "blob",
      payload_base64: Buffer.from("api reservation child").toString("base64"),
    }),
    reservations = [];
  for (let index = 0; index < 2; index++) {
    const text = "api reservation child",
      payload = encodeFileDescriptor({
        size_bytes: String(Buffer.byteLength(text)),
        content_digest:
          "sha256:" + createHash("sha256").update(text).digest("hex"),
        content: { kind: "blob", object_id: child.object_id },
      }),
      operation = randomUUID();
    const parent = await f.service.catalog.begin(f.scope, {
      operation_id: operation,
      object_id: sourceObjectId("file", payload),
      kind: "file",
      size_bytes: String(canonicalEnvelope("file", payload).length),
    });
    const reservation_id = randomUUID();
    await f.mutation("source.retention.reserve", {
      reservation_id,
      parent_object_id: parent.object_id,
      parent_incarnation_id: parent.incarnation_id,
      child_object_id: child.object_id,
      child_incarnation_id: child.incarnation_id,
      position: index,
    });
    reservations.push({ reservation_id, parent, payload, operation });
  }
  const debtPages = [];
  let cursor;
  do {
    const page = await f.client.call("source.collection.inspect", {
      partition: partitionOf(child.object_id),
      limit: 1,
      ...(cursor ? { after: cursor } : {}),
    });
    assert(page.work.length <= 1);
    debtPages.push(...page.work);
    cursor = page.next_cursor;
  } while (cursor);
  const inspected = debtPages.filter((row) =>
    reservations.some((item) => item.reservation_id === row.reservation_id),
  );
  assert.equal(inspected.length, 2);
  assert(
    inspected.every(
      (row) =>
        row.kind === "CHILD_RESERVATION" &&
        row.debt_kind === "PARENT_OUTCOME_UNKNOWN" &&
        row.child_incarnation_id === child.incarnation_id,
    ),
  );
  await f.service.objects.put(
    f.scope,
    "file",
    reservations[0].payload,
    reservations[0].operation,
  );
  for (const item of reservations)
    assert.equal(
      (
        await f.mutation("source.retention.reconcile", {
          reservation_id: item.reservation_id,
        })
      ).state,
      "ADOPTED",
    );
  assert(
    !(
      await f.client.call("source.collection.inspect", {
        partition: partitionOf(child.object_id),
        limit: 256,
      })
    ).work.some((row) =>
      reservations.some((item) => row.reservation_id === item.reservation_id),
    ),
  );
  checks.push(
    "registered inspect exposes typed unknown-parent reservation debt and paginates multiple reservations for the same child without loss",
  );

  const bf = await createNativeAcceptanceFixture({
    pool,
    migrate: false,
    actions: [
      "source.objects.put",
      "source.objects.read",
      "source.revisions.create",
      "source.revisions.read",
      "source.domains.create",
      "source.backups.create",
      "source.backups.verify",
      "source.retention.configure",
      "source.retention.acquire",
      "source.retention.release",
      "source.collection.discover",
      "source.collection.collect",
      "source.collection.inspect",
    ],
  });
  try {
    const backupScopeValues = Object.values(bf.scope),
      backupPolicy = {
        ...policy,
        backend_identity:
          "s3-v1:" +
          new URL(bf.backend.config.endpoint).origin +
          "/fixture-bucket",
      };
    await bf.mutation("source.retention.configure", backupPolicy);
    const backupUploadExpiry = async (ids) =>
      bf.pool.query(
        "UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='UPLOAD' AND object_id=ANY($4::text[])",
        [...backupScopeValues, ids],
      );
    const backupSweep = async () => {
      for (let round = 0; round < 3; round++)
        for (let partition = 0; partition < 16; partition++) {
          await bf.mutation("source.collection.discover", {
            partition,
            limit: 256,
          });
          await bf.mutation("source.collection.collect", {
            partition,
            limit: 256,
          });
        }
    };
    const deployment = randomUUID(),
      epoch = randomUUID(),
      digest = bf.sourceDigest("collection-backup-policy");
    await bf.pool.query(
      "INSERT INTO hyperfide.authority_epochs(deployment_id,epoch,activation_kind,state,fence_id,proof_digest) VALUES($1,$2,'BOOTSTRAP','ACTIVE','collection-backup-fixture',$3)",
      [deployment, epoch, digest],
    );
    const profile = {
      schema_version: 1,
      profile_id: "collection-backup-v1",
      metadata: {
        failure_domain: "owned-postgres",
        evidence_digest: digest,
        acknowledgment: "FSYNC_PRIMARY",
        replica_failure_domains: [],
        supported_failures: ["PROCESS_LOSS"],
      },
      placements: [
        {
          backend_id: backupPolicy.backend_identity,
          region: "fixture-region",
          failure_domain: "owned-s3",
          capabilities: {
            conditional_create: true,
            conditional_delete: true,
            strong_read_after_write: true,
          },
          evidence_digest: digest,
        },
      ],
      backup: {
        retention_seconds: 3600,
        maximum_age_seconds: 3600,
        external_journal_id: deployment,
      },
      objectives: { rpo_seconds: 0, rto_seconds: 60 },
    };
    const capture = async (object_id, expires_at) => {
      const root = {
        root_id: randomUUID(),
        owner_kind: "BACKUP",
        owner_id: "capture-" + randomUUID(),
        object_id,
      };
      await bf.mutation("source.retention.acquire", root);
      const backup_id = randomUUID();
      await bf.mutation("source.backups.create", {
        backup_id,
        profile,
        expires_at,
        max_revisions: 256,
        max_objects: 4096,
        max_bytes: 16777216,
      });
      let result;
      for (let batch = 0; batch < 64; batch++) {
        result = await bf.mutation("source.backups.verify", {
          backup_id,
          limit: 256,
        });
        if (result.state === "READY") break;
      }
      assert.equal(result.state, "READY");
      await bf.mutation("source.retention.release", {
        root_id: root.root_id,
        owner_kind: "BACKUP",
        owner_id: root.owner_id,
      });
      return backup_id;
    };
    const oldBackupObject = await bf.mutation("source.objects.put", {
        kind: "blob",
        payload_base64: Buffer.from("first captured backup version").toString(
          "base64",
        ),
      }),
      shortExpiry = new Date(Date.now() + 3000).toISOString();
    const firstBackup = await capture(oldBackupObject.object_id, shortExpiry);
    const waitForExpiry = Date.parse(shortExpiry) - Date.now() + 25;
    if (waitForExpiry > 0)
      await new Promise((resolve) => setTimeout(resolve, waitForExpiry));
    const liveBackupObject = await bf.mutation("source.objects.put", {
        kind: "blob",
        payload_base64: Buffer.from("second captured backup version").toString(
          "base64",
        ),
      }),
      secondBackup = await capture(
        liveBackupObject.object_id,
        new Date(Date.now() + 60000).toISOString(),
      );
    const captured = (
      await bf.pool.query(
        "SELECT object_id,incarnation_id FROM hyperfide.source_backup_objects WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND backup_id=$4 AND object_id=$5",
        [...backupScopeValues, secondBackup, liveBackupObject.object_id],
      )
    ).rows[0];
    assert.equal(captured.incarnation_id, liveBackupObject.incarnation_id);
    assert.equal(
      (
        await bf.pool.query(
          "SELECT count(*)::int AS n FROM hyperfide.source_backup_objects WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND backup_id=$4 AND object_id=$5",
          [...backupScopeValues, secondBackup, oldBackupObject.object_id],
        )
      ).rows[0].n,
      0,
    );
    await bf.pool.query(
      "DELETE FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='HOLD' AND owner_id=$4",
      [
        ...backupScopeValues,
        "backup:" + secondBackup + ":" + liveBackupObject.object_id,
      ],
    );
    const unbacked = await bf.mutation("source.objects.put", {
      kind: "blob",
      payload_base64: Buffer.from("outside both backups").toString("base64"),
    });
    await backupUploadExpiry([
      oldBackupObject.object_id,
      liveBackupObject.object_id,
      unbacked.object_id,
    ]);
    await bf.mutation("source.retention.configure", {
      ...backupPolicy,
      expected_generation: "1",
      backup_until: new Date(Date.now() + 60000).toISOString(),
    });
    await backupSweep();
    assert.equal(
      (await bf.client.object(liveBackupObject.object_id)).object_id,
      liveBackupObject.object_id,
    );
    for (const object_id of [oldBackupObject.object_id, unbacked.object_id])
      await assert.rejects(
        bf.client.object(object_id),
        (error) => error.code === "OBJECT_NOT_READY",
      );
    assert.equal(
      (
        await bf.pool.query(
          "SELECT incarnation_id FROM hyperfide.source_backup_objects WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND backup_id=$4 AND object_id=$5",
          [...backupScopeValues, firstBackup, oldBackupObject.object_id],
        )
      ).rows[0].incarnation_id,
      oldBackupObject.incarnation_id,
    );
    const rootOnlyObject = await bf.mutation("source.objects.put", {
        kind: "blob",
        payload_base64: Buffer.from("backup-root-only version").toString(
          "base64",
        ),
      }),
      rootOnly = {
        root_id: randomUUID(),
        owner_kind: "BACKUP",
        owner_id: "uncaptured-root",
        object_id: rootOnlyObject.object_id,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      };
    await bf.mutation("source.retention.acquire", rootOnly);
    await backupUploadExpiry([rootOnlyObject.object_id]);
    await bf.pool.query(
      "DELETE FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='HOLD' AND owner_id=$4",
      [...backupScopeValues, "root:" + rootOnly.root_id],
    );
    await backupSweep();
    assert.equal(
      (await bf.client.object(rootOnlyObject.object_id)).object_id,
      rootOnlyObject.object_id,
    );
    await bf.mutation("source.retention.release", {
      root_id: rootOnly.root_id,
      owner_kind: "BACKUP",
      owner_id: rootOnly.owner_id,
    });
    await backupSweep();
    await assert.rejects(
      bf.client.object(rootOnlyObject.object_id),
      (error) => error.code === "OBJECT_NOT_READY",
    );
    checks.push(
      "real backup producer captures exact versions; an unexpired backup retains only its members while expired and uncaptured objects collect under a future policy horizon",
    );
  } finally {
    await bf.close();
  }
  await f.pool.query(
    "UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.roles.author.capability_id],
  );
  await assert.rejects(
    f.client.call("source.collection.inspect", { partition, limit: 1 }),
    (error) => error.code === "SCOPE_DENIED",
  );
  checks.push(
    "source capability revocation immediately fences collection access",
  );
  await fs.mkdir(
    process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR ?? "build/source-control/2.3",
    { recursive: true },
  );
  const receipt = {
    status: "PASS",
    revision: process.env.SOURCE_COLLECTION_REVISION,
    checks,
    backend_requests: f.backend.requests.length,
  };
  await fs.writeFile(
    (process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR ?? "build/source-control/2.3") +
      "/api-receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  await f.close();
  await pool.end();
  await fs.rm(temporary, { recursive: true, force: true });
}
