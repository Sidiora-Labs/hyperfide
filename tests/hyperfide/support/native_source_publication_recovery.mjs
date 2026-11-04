import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "../../../core/control-plane/node_modules/pg/lib/index.js";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const load = (name) =>
  import(
    pathToFileURL(
      path.join(process.env.SOURCE_CONTROL_MODULE_ROOT, name + ".js"),
    )
  );
const [
  { createLocalGitDestination },
  { authorizeSource },
  { verifySourcePrincipalToken },
  { SourceControlError },
] = await Promise.all([
  load("git/transport"),
  load("capabilities"),
  load("authentication"),
  load("contracts"),
]);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
});
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "hf-publication-recovery-"),
);
const scope = {
  organisation_id: randomUUID(),
  repository_id: randomUUID(),
  security_domain_id: randomUUID(),
};
const checks = [];
const gate = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
let fixture, pending;
const entered = gate(),
  released = gate();
let pushes = 0,
  observations = 0,
  revokeAfterObservation = false,
  activeExternal;
try {
  for (const migration of JSON.parse(process.env.SOURCE_CONTROL_MIGRATIONS))
    await pool.query(
      await fs.readFile(
        path.join(root, "core/control-plane/migrations", migration),
        "utf8",
      ),
    );
  const destinations = Object.fromEntries(
    ["queued", "ready", "issued"].map((id) => {
      const directory = path.join(temporary, id + ".git");
      const initialized = spawnSync("git", ["init", "--bare", directory], {
        encoding: "utf8",
      });
      assert.equal(initialized.status, 0, initialized.stderr);
      return [
        id,
        createLocalGitDestination({
          scope,
          id,
          repository_identity: "recovery-" + id,
          path: directory,
          allowed_refs: ["refs/heads/main"],
        }),
      ];
    }),
  );
  destinations.ready.transport = {
    ...destinations.ready.transport,
    async authorize() {
      throw new SourceControlError(
        "EXPIRED_CREDENTIAL",
        "Owned credential interruption before dispatch",
      );
    },
  };
  const realIssued = destinations.issued.transport;
  destinations.issued.transport = {
    ...realIssued,
    async push(input) {
      pushes++;
      const objects = [];
      let buffered = 0;
      for (const object of input.objects) {
        const chunks = [];
        for await (const chunk of object.content()) {
          chunks.push(Buffer.from(chunk));
          buffered += chunk.length;
          assert(buffered <= 1048576);
        }
        objects.push({
          ...object,
          async *content() {
            yield* chunks;
          },
        });
      }
      entered.release();
      await released.promise;
      return realIssued.push({ ...input, objects });
    },
    async observe(ref, signal) {
      observations++;
      const result = await realIssued.observe(ref, signal);
      if (revokeAfterObservation) {
        revokeAfterObservation = false;
        await pool.query(
          "UPDATE hyperfide.authority_epochs SET state='REVOKED' WHERE deployment_id=$1 AND epoch=$2",
          [activeExternal.deployment, activeExternal.epoch],
        );
      }
      return result;
    },
  };
  fixture = await createNativeAcceptanceFixture({
    pool,
    migrate: false,
    scope,
    serviceOptions: {
      publication: { destinations: Object.values(destinations) },
    },
  });
  const revision = await fixture.createRevision({
    text: "candidate: publication recovery\n",
    parent_revision_ids: [],
  });
  const accepted = await fixture.accept(
    await fixture.createCandidate(revision, {
      domain: await fixture.createDomain(revision),
    }),
  );
  const publication = async (destination) => {
    const operation = randomUUID();
    const result = await fixture.client.createPublication(
      {
        acceptance_id: accepted.acceptance_id,
        destination_id: destination,
        target_ref: "refs/heads/main",
        expected_old_oid: null,
      },
      { operation_id: operation, idempotency_key: operation },
    );
    assert.equal(result.status, "QUEUED");
    return operation;
  };
  const queued = await publication("queued"),
    ready = await publication("ready"),
    issued = await publication("issued");
  await assert.rejects(
    fixture.client.resumePublication(ready),
    (error) => error.code === "EXPIRED_CREDENTIAL",
  );
  assert.equal((await fixture.client.publication(ready)).status, "READY");
  pending = fixture.client.resumePublication(issued).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await entered.promise;
  assert.equal((await fixture.client.publication(issued)).status, "DISPATCHED");
  const original = (
    await pool.query(
      "SELECT principal_id,authority_epoch::text,request FROM hyperfide.source_git_publications WHERE operation_id=$1",
      [issued],
    )
  ).rows[0];
  const originalDigest = (
    await pool.query(
      "SELECT request_digest FROM hyperfide.source_metadata_operations WHERE operation_id=$1",
      [issued],
    )
  ).rows[0].request_digest;
  activeExternal = { deployment: randomUUID(), epoch: randomUUID() };
  await pool.query(
    "INSERT INTO hyperfide.authority_epochs(deployment_id,epoch,activation_kind,state,fence_id,proof_digest) VALUES($1,$2,'RESTORE','ACTIVE',$3,$4)",
    [
      activeExternal.deployment,
      activeExternal.epoch,
      randomUUID(),
      fixture.sourceDigest("owned active restore"),
    ],
  );
  await pool.query(
    "UPDATE hyperfide.source_repositories SET authority_epoch=2 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
    Object.values(scope),
  );
  await pool.query(
    "UPDATE hyperfide.source_authority_domains SET authority_epoch=2 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
    Object.values(scope),
  );
  await pool.query(
    "UPDATE hyperfide.source_capabilities SET authority_epoch=2,actions=ARRAY['source.recovery.reconcile'] WHERE id=$1",
    [fixture.roles.checker.capability_id],
  );
  await pool.query(
    "UPDATE hyperfide.source_principal_credentials SET revoked_at=clock_timestamp() WHERE credential_id=$1",
    [fixture.roles.author.credential_id],
  );
  await pool.query(
    "INSERT INTO hyperfide.source_recovery_state(organisation_id,repository_id,security_domain_id,operation_id,deployment_id,external_epoch,state) VALUES($1,$2,$3,$4,$5,$6,'VERIFYING')",
    [
      ...Object.values(scope),
      randomUUID(),
      activeExternal.deployment,
      activeExternal.epoch,
    ],
  );
  const operator = await fixture.service.metadata.transaction((tx) =>
    authorizeSource(tx, {
      principal: verifySourcePrincipalToken(
        fixture.tokenFor("checker"),
        fixture.trust,
        scope,
      ),
      scope,
      action: "source.recovery.reconcile",
      mutation: true,
    }),
  );
  const owner = fixture.roles.author.principal_id;
  await assert.rejects(
    fixture.service.publications.resume(fixture.context, issued),
    (error) =>
      ["UNAUTHENTICATED", "SCOPE_DENIED", "STALE_AUTHORITY"].includes(
        error.code,
      ),
  );
  const observedBeforeDenial = observations;
  await assert.rejects(
    fixture.service.publications.reconcileRecovery(operator, {
      operation_id: issued,
      principal_id: randomUUID(),
    }),
    (error) => error.code === "NOT_FOUND",
  );
  const cancelledSignal = new AbortController();
  cancelledSignal.abort();
  await assert.rejects(
    fixture.service.publications.reconcileRecovery(
      operator,
      { operation_id: issued, principal_id: owner },
      cancelledSignal.signal,
    ),
    (error) => error.code === "OPERATION_INTERRUPTED",
  );
  assert.equal(observations, observedBeforeDenial);
  checks.push(
    "expired original author cannot resume; recovery is scoped to the exact original owner and cancelled observations have no effect",
  );
  for (const operation of [queued, ready])
    assert.equal(
      (
        await fixture.service.publications.reconcileRecovery(operator, {
          operation_id: operation,
          principal_id: owner,
        })
      ).status,
      "CANCELLED",
    );
  assert.equal(pushes, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM hyperfide.source_git_targets WHERE active_operation_id=ANY($1::uuid[])",
        [[queued, ready]],
      )
    ).rows[0].n,
    0,
  );
  checks.push(
    "current recovery authority cancels retained QUEUED and READY work without issuing a push",
  );
  const unknown = await fixture.service.publications.reconcileRecovery(
    operator,
    { operation_id: issued, principal_id: owner },
  );
  assert.equal(unknown.status, "OUTCOME_UNKNOWN");
  assert.equal(unknown.observed_oid, null);
  assert.equal(pushes, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT active_operation_id FROM hyperfide.source_git_targets WHERE destination_key=$1 AND target_ref=$2",
        [destinations.issued.remote_key, "refs/heads/main"],
      )
    ).rows[0].active_operation_id,
    issued,
  );
  assert.equal(
    (
      await fixture.service.publications.reconcileRecovery(operator, {
        operation_id: issued,
        principal_id: owner,
      })
    ).status,
    "OUTCOME_UNKNOWN",
  );
  checks.push(
    "an issued push with the old remote value remains unresolved and retains its destination reservation",
  );
  released.release();
  const staleOutcome = await pending;
  assert(
    staleOutcome.error,
    "Original expired owner must not settle after its delayed real push",
  );
  const actual = await realIssued.observe("refs/heads/main");
  assert.equal(actual, unknown.git_oid);
  revokeAfterObservation = true;
  await assert.rejects(
    fixture.service.publications.reconcileRecovery(operator, {
      operation_id: issued,
      principal_id: owner,
    }),
    (error) => error.code === "RECOVERY_NOT_READY",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT status FROM hyperfide.source_git_publications WHERE operation_id=$1",
        [issued],
      )
    ).rows[0].status,
    "OUTCOME_UNKNOWN",
  );
  checks.push(
    "external recovery authority is rechecked after remote observation before any settlement",
  );
  activeExternal = {
    deployment: activeExternal.deployment,
    epoch: randomUUID(),
  };
  await pool.query(
    "INSERT INTO hyperfide.authority_epochs(deployment_id,epoch,activation_kind,state,fence_id,proof_digest) VALUES($1,$2,'RESTORE','ACTIVE',$3,$4)",
    [
      activeExternal.deployment,
      activeExternal.epoch,
      randomUUID(),
      fixture.sourceDigest("renewed owned active restore"),
    ],
  );
  await pool.query(
    "UPDATE hyperfide.source_recovery_state SET external_epoch=$4 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
    [...Object.values(scope), activeExternal.epoch],
  );
  const resolved = await fixture.service.publications.reconcileRecovery(
    operator,
    { operation_id: issued, principal_id: owner },
  );
  assert.equal(resolved.status, "PUBLISHED");
  assert.equal(resolved.git_oid, actual);
  assert.equal(resolved.checkpoint_generation, "1");
  assert.equal(pushes, 1);
  const final = (
    await pool.query(
      "SELECT principal_id,authority_epoch::text,request FROM hyperfide.source_git_publications WHERE operation_id=$1",
      [issued],
    )
  ).rows[0];
  assert.deepEqual(final, original);
  const journal = (
    await pool.query(
      "SELECT principal_id,state,request_digest FROM hyperfide.source_metadata_operations WHERE operation_id=$1",
      [issued],
    )
  ).rows[0];
  assert.equal(journal.principal_id, owner);
  assert.equal(journal.state, "COMMITTED");
  assert.equal(journal.request_digest, originalDigest);
  const beforeReplay = observations;
  assert.deepEqual(
    await fixture.service.publications.reconcileRecovery(operator, {
      operation_id: issued,
      principal_id: owner,
    }),
    resolved,
  );
  assert.equal(observations, beforeReplay);
  assert.equal(pushes, 1);
  checks.push(
    "exact Git readback settles the original owner and operation once without reissuing a push or changing immutable identities",
  );
  await pool.query(
    "UPDATE hyperfide.source_recovery_state SET state='READY' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
    Object.values(scope),
  );
  await pool.query(
    "UPDATE hyperfide.source_repositories SET authority_epoch=3 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
    Object.values(scope),
  );
  await pool.query(
    "UPDATE hyperfide.source_authority_domains SET authority_epoch=3 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
    Object.values(scope),
  );
  const renewedCredential = randomUUID(),
    renewedCapability = randomUUID();
  await pool.query(
    "INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at) VALUES($1,$2,$3,$4,$5,'automation',1,$6,$7,'fixture-source-key',clock_timestamp()+interval '30 minutes')",
    [
      ...Object.values(scope),
      renewedCredential,
      owner,
      fixture.trust.issuer,
      fixture.trust.audience,
    ],
  );
  await pool.query(
    "INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',3,$7,$8,ARRAY[''],clock_timestamp()+interval '30 minutes')",
    [
      ...Object.values(scope),
      renewedCapability,
      owner,
      renewedCredential,
      fixture.sourcePolicy,
      [
        "source.publications.read",
        "source.publications.resume",
        "source.publications.cancel",
      ],
    ],
  );
  fixture.roles.author.credential_id = renewedCredential;
  fixture.roles.author.capability_id = renewedCapability;
  assert.deepEqual(
    JSON.parse(JSON.stringify(await fixture.client.publication(issued))),
    resolved,
  );
  await assert.rejects(
    fixture.client.resumePublication(issued),
    (error) => error.code === "STALE_AUTHORITY",
  );
  await assert.rejects(
    fixture.client.cancelPublication(issued),
    (error) => error.code === "STALE_AUTHORITY",
  );
  await pool.query(
    "UPDATE hyperfide.source_capabilities SET authority_epoch=3,actions=ARRAY['source.publications.read'] WHERE id=$1",
    [fixture.roles.checker.capability_id],
  );
  await assert.rejects(
    fixture.checkerClient.publication(issued),
    (error) => error.code === "NOT_FOUND",
  );
  assert.equal(pushes, 1);
  checks.push(
    "current owner credentials read retained publication receipts after an authority epoch advance while resume, cancellation and another principal remain fenced",
  );
  const receipt = {
    status: "PASS",
    scope:
      "current recovery operator, retained publication owner, real PostgreSQL and Git receive-pack",
    checks,
    pushes,
    observations,
  };
  const directory = path.resolve(
    process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR ??
      path.join(root, "build/source-control/publication-recovery"),
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(receipt) + "\n");
} finally {
  released.release();
  if (pending) await pending;
  await fixture?.close();
  await pool.end();
  await fs.rm(temporary, { recursive: true, force: true });
}
