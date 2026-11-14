import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";

const { SourceControlError } = await import(
  pathToFileURL(
    path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT, "contracts.js"),
  )
);

const actions = [
  "source.capabilities",
  "source.objects.put",
  "source.objects.read",
  "source.revisions.create",
  "source.revisions.read",
  "source.operations.read",
  "source.domains.create",
  "source.domains.read",
  "source.domains.configure",
  "source.candidates.create",
  "source.candidates.read",
  "source.candidates.qualify",
  "source.acceptance.accept",
  "source.acceptance.read",
  "source.lifecycle.read",
  "source.assurance.custody.create",
  "source.assurance.publish",
  "source.assurance.revoke",
  "source.retention.configure",
  "source.collection.discover",
  "source.collection.collect",
];
const f = await createNativeAcceptanceFixture({ actions, taskState: true });
const checks = [];
function assertWireEqual(actual, expected) {
  assert.deepEqual(actual, f.parseStrictJSON(f.canonicalBytes(expected)));
}
async function readLifecycleAfterRestart(input) {
  const options = { operation_id: randomUUID() };
  for (let retries = 0; ; retries++) {
    try {
      return await f.client.lifecycle(input, options);
    } catch (error) {
      if (
        !(error instanceof SourceControlError) ||
        error.code !== "OUTCOME_UNKNOWN" ||
        error.retry !== "RETRY_SAME_OPERATION" ||
        retries === 5
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
const count = async (table, where = "", values = []) =>
  (
    await f.pool.query(
      "SELECT count(*)::int AS count FROM hyperfide." +
        table +
        (where ? " WHERE " + where : ""),
      values,
    )
  ).rows[0].count;
const candidate = async (text, domain = f.domain) =>
  f.createCandidate(
    await f.createRevision({ text, parent_revision_ids: [domain.revision_id] }),
    { domain },
  );
const independent = async (text) => {
  const domain = await f.createDomain();
  return { domain, candidate: await candidate(text, domain) };
};
try {
  assert.notEqual(f.roles.author.principal_id, f.roles.checker.principal_id);
  const taskState = await f.taskState.snapshot();
  assert.equal(taskState.tasks.length, 1);
  assert.equal(taskState.attempts.length, 1);
  assert.equal(taskState.tasks[0].row.state, "SUBMITTED");
  assert.equal(taskState.attempts[0].row.execution_state, "SUBMITTED");
  const proposal = await f.createRevision({
    text: "candidate: first accepted source\n",
  });
  const lifecycleInput = {
    revision_id: proposal.revision_id,
    domain_id: f.domain.domain_id,
  };
  assertWireEqual((await f.client.lifecycle(lifecycleInput)).stages, [
    { state: "CREATED", receipt_id: proposal.revision_id },
  ]);
  const first = await f.createCandidate(proposal);
  assert.equal(first.revision_id, proposal.revision_id);
  assert.equal(first.root_tree_id, proposal.root_tree_id);
  assert.equal(await count("source_native_acceptances"), 0);
  assert.equal(
    (await f.client.domain(f.domain.domain_id)).revision_id,
    f.base.revision_id,
  );
  assertWireEqual((await f.client.lifecycle(lifecycleInput)).stages, [
    { state: "CREATED", receipt_id: proposal.revision_id },
    { state: "SUBMITTED", receipt_id: first.candidate_id },
  ]);
  const qualified = await f.qualify(first);
  assert.equal(qualified.execution.observed.exit_code, 0);
  assert.equal(qualified.execution.observed.signal, null);
  assert.equal(qualified.execution.stdout, "native check passed\n");
  assert.equal(qualified.evidence.outcome, "PASS");
  assert.equal(qualified.qualification.manifest_digest, first.manifest_digest);
  const proof = qualified.execution.receipt;
  const pinned = (
    await f.pool.query(
      "SELECT object_id,position FROM hyperfide.source_object_pins WHERE owner_id=$1 ORDER BY position",
      ["native-evidence:" + qualified.evidence.evidence_id],
    )
  ).rows;
  assert.deepEqual(
    pinned.map((row) => row.object_id),
    [
      qualified.execution.receipt_object_id,
      proof.output.stdout_object_id,
      proof.output.stderr_object_id,
      ...proof.artifacts.map((item) => item.object_id),
    ],
  );
  assertWireEqual((await f.client.lifecycle(lifecycleInput)).stages, [
    { state: "CREATED", receipt_id: proposal.revision_id },
    { state: "SUBMITTED", receipt_id: first.candidate_id },
    {
      state: "QUALIFIED",
      receipt_id: qualified.qualification.qualification_id,
    },
  ]);
  checks.push(
    "an independent authenticated checker executes the registered command on pinned source and publishes retained exact-input evidence",
  );

  const acceptanceOperation = randomUUID();
  const accepted = await f.accept(first, qualified, {
    operation_id: acceptanceOperation,
  });
  assert.equal(accepted.generation, "2");
  assert.equal(accepted.previous_revision_id, f.base.revision_id);
  assert.equal(accepted.root_tree_id, proposal.root_tree_id);
  assert.equal(accepted.revision_id, proposal.revision_id);
  const replay = await f.accept(first, qualified, {
    operation_id: acceptanceOperation,
  });
  assert.deepEqual(replay, accepted);
  assert.deepEqual(await f.client.acceptance(accepted.acceptance_id), accepted);
  assert.equal(
    (await f.client.domain(f.domain.domain_id)).revision_id,
    proposal.revision_id,
  );
  assert.equal(
    await count("source_native_acceptances", "domain_id=$1", [
      f.domain.domain_id,
    ]),
    1,
  );
  assert.equal(
    await count(
      "source_events",
      "aggregate_id=$1 AND event_type='NATIVE_SOURCE_ACCEPTED'",
      ["domain:" + f.domain.domain_id],
    ),
    1,
  );
  assert(
    (
      await f.pool.query(
        "SELECT 1 FROM hyperfide.source_object_pins WHERE object_id=$1 AND owner_id=$2",
        [proposal.root_tree_id, "acceptance:" + accepted.acceptance_id],
      )
    ).rowCount > 0,
  );
  assert.deepEqual(await f.taskState.snapshot(), taskState);
  checks.push(
    "atomic domain acceptance records one replayable receipt, advances only the selected domain, pins its root and creates no fleet task completion",
  );
  const lifecycle = await f.client.lifecycle(lifecycleInput);
  assertWireEqual(lifecycle, {
    schema_version: 1,
    scope: f.scope,
    ...lifecycleInput,
    root_tree_id: proposal.root_tree_id,
    stages: [
      { state: "CREATED", receipt_id: proposal.revision_id },
      { state: "SUBMITTED", receipt_id: first.candidate_id },
      {
        state: "QUALIFIED",
        receipt_id: qualified.qualification.qualification_id,
      },
      { state: "ACCEPTED", receipt_id: accepted.acceptance_id },
    ],
  });
  assert.equal(
    lifecycle.stages.some((stage) => stage.state === "REMOTELY_PUBLISHED"),
    false,
  );
  await f.restart();
  assert.deepEqual(await readLifecycleAfterRestart(lifecycleInput), lifecycle);
  const otherLifecycleDomain = await f.createDomain();
  assertWireEqual(
    (
      await readLifecycleAfterRestart({
        ...lifecycleInput,
        domain_id: otherLifecycleDomain.domain_id,
      })
    ).stages,
    [{ state: "CREATED", receipt_id: proposal.revision_id }],
  );
  await assert.rejects(
    readLifecycleAfterRestart({ ...lifecycleInput, domain_id: randomUUID() }),
    (error) => error.code === "NOT_FOUND",
  );
  await assert.rejects(
    readLifecycleAfterRestart({
      ...lifecycleInput,
      revision_id: f.sourceDigest("missing-revision"),
    }),
    (error) => error.code === "NOT_FOUND",
  );
  await assert.rejects(
    readLifecycleAfterRestart({
      ...lifecycleInput,
      accepted: true,
    }),
    (error) => error.code === "INVALID_REQUEST",
  );
  checks.push(
    "lifecycle reads through the authenticated HTTP SDK preserve every stage receipt per revision and domain across service restart; acceptance does not imply remote publication",
  );

  const raceDomain = await f.createDomain();
  const [left, right] = await Promise.all([
    candidate("candidate: racing left\n", raceDomain),
    candidate("candidate: racing right\n", raceDomain),
  ]);
  const [leftProof, rightProof] = await Promise.all([
    f.qualify(left),
    f.qualify(right),
  ]);
  const race = await Promise.allSettled([
    f.accept(left, leftProof),
    f.accept(right, rightProof),
  ]);
  assert.equal(race.filter((row) => row.status === "fulfilled").length, 1);
  const rejected = race.find((row) => row.status === "rejected");
  assert.equal(rejected.reason.code, "DOMAIN_CHANGED");
  const winner = race.find((row) => row.status === "fulfilled").value;
  assert.equal(
    (await f.client.domain(raceDomain.domain_id)).revision_id,
    winner.revision_id,
  );
  assert.equal(
    await count("source_native_acceptances", "domain_id=$1", [
      raceDomain.domain_id,
    ]),
    1,
  );
  await assert.rejects(
    f.accept(left, leftProof, { operation_id: acceptanceOperation }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  checks.push(
    "two qualified candidates racing one expected generation produce exactly one accepted head and operation identities cannot be rebound",
  );

  const changed = await independent("candidate: changed policy generation\n");
  const changedProof = await f.qualify(changed.candidate);
  const configured = await f.mutation("source.domains.configure", {
    domain_id: changed.domain.domain_id,
    expected_generation: "1",
    policy_id: f.policy.policy_id,
    policy_digest: f.policy.policy_digest,
  });
  assert.equal(configured.generation, "2");
  await assert.rejects(
    f.accept(changed.candidate, changedProof),
    (error) => error.code === "DOMAIN_CHANGED",
  );
  assert.equal(
    await count("source_native_acceptances", "domain_id=$1", [
      changed.domain.domain_id,
    ]),
    0,
  );
  assert.equal(
    (await f.client.domain(changed.domain.domain_id)).revision_id,
    f.base.revision_id,
  );
  checks.push(
    "a changed domain generation invalidates an already qualified candidate without moving source",
  );

  const custodyCase = await independent("candidate: revoked custody\n");
  const custodyProof = await f.qualify(custodyCase.candidate);
  const custody = custodyCase.candidate.contributors[0];
  await f.mutation("source.assurance.revoke", {
    custody_id: custody.custody_id,
  });
  await assert.rejects(
    f.accept(custodyCase.candidate, custodyProof),
    (error) => error.code === "CUSTODY_STALE",
  );
  assert.equal(
    await count("source_native_acceptances", "domain_id=$1", [
      custodyCase.domain.domain_id,
    ]),
    0,
  );
  checks.push(
    "revoking contributor custody fences previously complete evidence at the acceptance transaction",
  );

  const evidenceCase = await independent("candidate: revoked evidence\n");
  const evidenceProof = await f.qualify(evidenceCase.candidate);
  await f.mutation(
    "source.assurance.revoke",
    { evidence_id: evidenceProof.evidence.evidence_id },
    {},
    f.checkerClient,
  );
  await assert.rejects(
    f.accept(evidenceCase.candidate, evidenceProof),
    (error) => error.code === "EVIDENCE_BINDING_MISMATCH",
  );
  assert.equal(
    await count("source_native_acceptances", "domain_id=$1", [
      evidenceCase.domain.domain_id,
    ]),
    0,
  );
  checks.push(
    "revoking checker evidence fences a retained qualification and preserves the old domain head",
  );

  const failed = await independent("FAIL real checker failure\n");
  const failedEvidence = await f.publishEvidence(failed.candidate);
  assert.equal(failedEvidence.execution.observed.exit_code, 7);
  assert.equal(failedEvidence.evidence.outcome, "FAIL");
  await assert.rejects(
    f.mutation("source.candidates.qualify", {
      candidate_id: failed.candidate.candidate_id,
      evidence_ids: [failedEvidence.evidence.evidence_id],
    }),
    (error) => error.code === "EVIDENCE_BINDING_MISMATCH",
  );
  assert.equal(
    await count("source_native_acceptances", "domain_id=$1", [
      failed.domain.domain_id,
    ]),
    0,
  );
  checks.push(
    "a real failed checker command remains failed evidence and cannot qualify or advance source",
  );

  const forged = await independent("candidate: binding checks\n");
  const headBeforeWrongTree = await f.client.domain(forged.domain.domain_id);
  const wrongTree = await f.runCheck(forged.candidate, {
    mutate: (receipt) => ({ ...receipt, root_tree_id: f.base.root_tree_id }),
  });
  assert.notEqual(
    wrongTree.receipt.root_tree_id,
    forged.candidate.root_tree_id,
  );
  await assert.rejects(
    f.publishEvidence(forged.candidate, { execution: wrongTree }),
    (error) => error.code === "EVIDENCE_BINDING_MISMATCH",
  );
  assert.deepEqual(
    await f.client.domain(forged.domain.domain_id),
    headBeforeWrongTree,
  );
  assert.equal(
    await count("source_native_assurance_evidence", "candidate_id=$1", [
      forged.candidate.candidate_id,
    ]),
    0,
  );
  assert.equal(
    await count("source_native_acceptances", "domain_id=$1", [
      forged.domain.domain_id,
    ]),
    0,
  );
  checks.push(
    "a checker receipt recording a different root tree is refused with EVIDENCE_BINDING_MISMATCH and leaves the domain head unchanged",
  );
  const validExecution = await f.runCheck(forged.candidate);
  await assert.rejects(
    f.publishEvidence(forged.candidate, {
      execution: validExecution,
      actor: f.client,
    }),
    (error) => error.code === "CHECKER_NOT_AUTHORIZED",
  );
  const wrongGraph = await f.runCheck(forged.candidate, {
    mutate: (receipt) => ({
      ...receipt,
      inputs: {
        ...receipt.inputs,
        graph: f.sourceDigest("another-graph-generation"),
      },
    }),
  });
  await assert.rejects(
    f.publishEvidence(forged.candidate, { execution: wrongGraph }),
    (error) => error.code === "EVIDENCE_BINDING_MISMATCH",
  );
  checks.push(
    "evidence with another graph generation cannot qualify the unchanged candidate or narrow its required checks",
  );
  const wrongInputs = await f.runCheck(forged.candidate, {
    mutate: (receipt) => ({
      ...receipt,
      inputs: {
        ...receipt.inputs,
        contract: f.sourceDigest("another-contract"),
      },
    }),
  });
  await assert.rejects(
    f.publishEvidence(forged.candidate, { execution: wrongInputs }),
    (error) => error.code === "EVIDENCE_BINDING_MISMATCH",
  );
  await f.pool.query(
    `INSERT INTO hyperfide.source_native_assurance_checkers(organisation_id,repository_id,security_domain_id,policy_id,check_id,principal_id,credential_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '30 minutes')`,
    [
      ...Object.values(f.scope),
      f.policy.policy_id,
      f.check.id,
      f.roles.author.principal_id,
      f.roles.author.credential_id,
    ],
  );
  await assert.rejects(
    f.publishEvidence(forged.candidate, {
      execution: validExecution,
      actor: f.client,
    }),
    (error) => error.code === "CHECKER_NOT_INDEPENDENT",
  );
  checks.push(
    "altered source and input bindings and self-certification by even a registered author are refused",
  );

  const malformedRevision = await f.createRevision({
    text: "candidate: malformed proposal\n",
  });
  const malformedCustody = await f.registerCustody(malformedRevision);
  const beforeMalformed = await count("source_native_candidates");
  const duplicate = {
    revision_id: malformedRevision.revision_id,
    change_id: malformedRevision.change_id,
    custody_id: malformedCustody.custody_id,
    custody_generation: "1",
  };
  const freshDomain = await f.createDomain();
  await assert.rejects(
    f.createCandidate(malformedRevision, {
      domain: freshDomain,
      input: { contributors: [duplicate, duplicate] },
    }),
    (error) => error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    f.createCandidate(malformedRevision, {
      domain: freshDomain,
      input: {
        inputs: { ...first.inputs, source: f.sourceDigest("wrong-source") },
      },
    }),
    (error) => error.code === "CANDIDATE_INPUT_MISMATCH",
  );
  const unrelated = await f.createRevision({
    text: "candidate: unrelated contributor\n",
    parent_revision_ids: [],
  });
  const unrelatedCustody = await f.registerCustody(unrelated);
  await assert.rejects(
    f.createCandidate(malformedRevision, {
      domain: freshDomain,
      input: {
        contributors: [
          {
            revision_id: unrelated.revision_id,
            change_id: unrelated.change_id,
            custody_id: unrelatedCustody.custody_id,
            custody_generation: "1",
          },
        ],
      },
    }),
    (error) => error.code === "INVALID_CONTRIBUTOR",
  );
  assert.equal(await count("source_native_candidates"), beforeMalformed);
  await assert.rejects(
    f.pool.query(
      "UPDATE hyperfide.source_native_candidates SET manifest=$1 WHERE candidate_id=$2",
      [{}, first.candidate_id],
    ),
    (error) => error.code === "23514",
  );
  checks.push(
    "duplicate contributors, mismatched source manifests and edits to immutable candidates cannot enter acceptance",
  );

  const lost = await independent("candidate: lost acknowledgment\n");
  const lostProof = await f.qualify(lost.candidate);
  const sdk = await import(
    pathToFileURL(
      path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT, "client.js"),
    )
  );
  let lose = true;
  const interrupted = new sdk.SourceControlClient({
    endpoint: f.endpoint,
    scope: f.scope,
    token: () => f.tokenFor(),
    fetch: async (...args) => {
      const response = await fetch(...args);
      if (lose) {
        lose = false;
        await response.arrayBuffer();
        throw new TypeError("controlled lost acceptance response");
      }
      return response;
    },
  });
  const lostOperation = randomUUID(),
    lostInput = {
      candidate_id: lost.candidate.candidate_id,
      qualification_id: lostProof.qualification.qualification_id,
    };
  await assert.rejects(
    interrupted.acceptCandidate(lostInput, {
      operation_id: lostOperation,
      idempotency_key: lostOperation,
    }),
    (error) =>
      error.code === "OUTCOME_UNKNOWN" &&
      error.details.operation_id === lostOperation,
  );
  const operation = await f.client.operation(lostOperation);
  assert.equal(operation.state, "SUCCEEDED");
  const recovered = await f.mutation("source.acceptance.accept", lostInput, {
    operation_id: lostOperation,
  });
  assert.deepEqual(operation.result, recovered);
  assert.equal((await f.client.domain(lost.domain.domain_id)).generation, "2");
  assert.equal(
    await count("source_native_acceptances", "domain_id=$1", [
      lost.domain.domain_id,
    ]),
    1,
  );
  checks.push(
    "a lost acceptance response resolves through the original operation and never advances the domain twice",
  );

  const revokedPolicy = await f.registerPolicy({
    policy_id: randomUUID(),
    policy_digest: f.sourceDigest({
      case: "revoked-policy",
      checks: [f.check],
    }),
    checks: [f.check],
  });
  const policyDomain = await f.createDomain(f.base, revokedPolicy);
  const policyCandidate = await candidate(
    "candidate: revoked policy\n",
    policyDomain,
  );
  const policyProof = await f.qualify(policyCandidate);
  await f.pool.query(
    "UPDATE hyperfide.source_native_assurance_policies SET revoked_at=clock_timestamp() WHERE policy_id=$1",
    [revokedPolicy.policy_id],
  );
  await assert.rejects(
    f.accept(policyCandidate, policyProof),
    (error) => error.code === "EVIDENCE_POLICY_STALE",
  );
  assert.equal(
    await count("source_native_acceptances", "domain_id=$1", [
      policyDomain.domain_id,
    ]),
    0,
  );
  checks.push(
    "revoking the registered checker policy invalidates existing qualification without mutating accepted history",
  );

  const retention = f.service.retention;
  assert.equal(retention.constructor.name, "SourceRetentionService");
  const retentionDomain = await f.createDomain();
  const contributors = await Promise.all(
    ["left", "right"].map((side) =>
      f.createRevision({
        text: "candidate: retained contributor " + side + "\n",
      }),
    ),
  );
  const contributorCustodies = await Promise.all(
    contributors.map((revision) => f.registerCustody(revision)),
  );
  const retentionRevision = await f.createRevision({
    text: "candidate: retained combined source\n",
    parent_revision_ids: contributors.map((revision) => revision.revision_id),
  });
  const retainedCandidate = await f.createCandidate(retentionRevision, {
    domain: retentionDomain,
    input: {
      contributors: contributors.map((revision, index) => ({
        revision_id: revision.revision_id,
        change_id: revision.change_id,
        custody_id: contributorCustodies[index].custody_id,
        custody_generation: "1",
      })),
    },
  });
  const retentionProof = await f.qualify(retainedCandidate);
  const retentionReceipt = retentionProof.execution.receipt;
  const retainedRoots = [
    retentionRevision.root_tree_id,
    ...contributors.map((revision) => revision.root_tree_id),
    retentionProof.execution.receipt_object_id,
    retentionReceipt.output.stdout_object_id,
    retentionReceipt.output.stderr_object_id,
    ...retentionReceipt.artifacts.map((artifact) => artifact.object_id),
  ];
  const protectedObjects = (
    await f.pool.query(
      `WITH RECURSIVE retained(object_id) AS (
    SELECT unnest($4::text[]) UNION
    SELECT pin.object_id FROM retained r JOIN hyperfide.source_native_objects parent ON parent.object_id=r.object_id
      AND parent.organisation_id=$1 AND parent.repository_id=$2 AND parent.security_domain_id=$3
    JOIN hyperfide.source_object_pins pin ON pin.organisation_id=parent.organisation_id AND pin.repository_id=parent.repository_id
      AND pin.security_domain_id=parent.security_domain_id AND pin.owner_kind='OBJECT' AND pin.owner_id=parent.object_id||'/'||parent.current_incarnation::text
  ) SELECT object_id FROM retained ORDER BY object_id`,
      [...Object.values(f.scope), retainedRoots],
    )
  ).rows.map((row) => row.object_id);
  const protectedSet = new Set(protectedObjects),
    garbage = await f.blob("unretained collection control " + randomUUID());
  await f.pool.query(
    "UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind IN ('UPLOAD','READ') AND object_id=ANY($4::text[])",
    [...Object.values(f.scope), [...protectedObjects, garbage]],
  );
  const garbagePartition = (
    await f.pool.query(
      "SELECT gc_partition FROM hyperfide.source_native_objects WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4",
      [...Object.values(f.scope), garbage],
    )
  ).rows[0].gc_partition;
  assertWireEqual(
    await f.mutation("source.retention.configure", {
      expected_generation: "0",
      minimum_age_seconds: 0,
      quarantine_seconds: 0,
      backup_until: new Date(Date.now() - 60000).toISOString(),
      backend_identity: f.service.objects.backend.identity,
      independent_expiration: false,
    }),
    { generation: "1" },
  );
  const assertRetained = async () => {
    const rows = (
      await f.pool.query(
        `SELECT o.object_id,o.state,p.state AS placement_state FROM hyperfide.source_native_objects o
      JOIN hyperfide.source_object_placements p ON p.organisation_id=o.organisation_id AND p.repository_id=o.repository_id
        AND p.security_domain_id=o.security_domain_id AND p.object_id=o.object_id AND p.incarnation_id=o.current_incarnation
      WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.object_id=ANY($4::text[])`,
        [...Object.values(f.scope), protectedObjects],
      )
    ).rows;
    assert.equal(rows.length, protectedObjects.length);
    for (const row of rows) {
      assert.equal(row.state, "VERIFIED", row.object_id);
      assert.equal(row.placement_state, "VERIFIED", row.object_id);
    }
    assert.equal(
      await count(
        "source_collection_work",
        "organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=ANY($4::text[])",
        [...Object.values(f.scope), protectedObjects],
      ),
      0,
    );
    for (const contributor of contributors) {
      const revision = await f.client.revision(contributor.revision_id);
      assert.equal(revision.root_tree_id, contributor.root_tree_id);
    }
  };
  await assertRetained();
  const discover = async () => {
    const quarantined = [];
    for (let partition = 0; partition < 16; partition++) {
      const result = await f.mutation("source.collection.discover", {
        partition,
        limit: 256,
      });
      assert.equal(result.blocked, undefined);
      for (const row of result.quarantined) {
        assert.equal(protectedSet.has(row.object_id), false);
        quarantined.push(row.object_id);
      }
      await assertRetained();
    }
    return quarantined;
  };
  const collect = async () => {
    for (let partition = 0; partition < 16; partition++) {
      const result = await f.mutation("source.collection.collect", {
        partition,
        limit: 256,
      });
      for (const row of result.results)
        assert.equal(protectedSet.has(row.object_id), false);
      await assertRetained();
    }
  };
  const [retentionAcceptance, quarantined] = await Promise.all([
    f.accept(retainedCandidate, retentionProof),
    discover(),
    collect(),
  ]);
  assert(
    quarantined.includes(garbage),
    "Discovery must quarantine an actually unretained control object",
  );
  await f.mutation("source.collection.collect", {
    partition: garbagePartition,
    limit: 256,
  });
  assert.equal(
    (
      await f.pool.query(
        "SELECT state FROM hyperfide.source_native_objects WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4",
        [...Object.values(f.scope), garbage],
      )
    ).rows[0].state,
    "ABSENT",
  );
  assert.equal(
    retentionAcceptance.root_tree_id,
    retentionRevision.root_tree_id,
  );
  assert.equal(
    (await f.client.domain(retentionDomain.domain_id)).revision_id,
    retentionRevision.revision_id,
  );
  await assertRetained();
  for (const object_id of retainedRoots) await f.client.object(object_id);
  checks.push(
    "concurrent retention discovery, collection and acceptance collect an unretained control while accepted trees, contributor revisions and checker evidence remain verified and never enter quarantine or absence",
  );

  const checkerRevocation = await independent(
    "candidate: checker credential revocation\n",
  );
  const checkerRevocationProof = await f.qualify(checkerRevocation.candidate);
  const expiredCredential = await independent(
    "candidate: durable proof after credential expiry\n",
  );
  const expiredCredentialProof = await f.qualify(expiredCredential.candidate);
  await f.pool.query(
    "UPDATE hyperfide.source_principal_credentials SET expires_at=(SELECT max(created_at)+interval '1 millisecond' FROM hyperfide.source_native_assurance_evidence WHERE checker_credential_id=$1) WHERE credential_id=$1",
    [f.roles.checker.credential_id],
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    (
      await f.pool.query(
        "SELECT expires_at<clock_timestamp() AS expired FROM hyperfide.source_principal_credentials WHERE credential_id=$1",
        [f.roles.checker.credential_id],
      )
    ).rows[0].expired,
    true,
  );
  const durableAfterExpiry = await f.accept(
    expiredCredential.candidate,
    expiredCredentialProof,
  );
  assert.equal(
    durableAfterExpiry.revision_id,
    expiredCredential.candidate.revision_id,
  );
  checks.push(
    "credential expiry prevents new assertions while proof issued under valid authority remains usable",
  );
  await f.pool.query(
    "UPDATE hyperfide.source_principal_credentials SET revoked_at=clock_timestamp() WHERE credential_id=$1",
    [f.roles.checker.credential_id],
  );
  await assert.rejects(
    f.accept(checkerRevocation.candidate, checkerRevocationProof),
    (error) => error.code === "CHECKER_NOT_AUTHORIZED",
  );
  assert.equal(
    await count("source_native_acceptances", "domain_id=$1", [
      checkerRevocation.domain.domain_id,
    ]),
    0,
  );
  checks.push(
    "checker credential revocation is rechecked after qualification and before accepting source",
  );
  assert.deepEqual(await f.taskState.snapshot(), taskState);
  checks.push(
    "seeded real authority task and attempt rows, including tuple versions, remain unchanged through successful, refused and replayed acceptances",
  );

  const report = {
    schema_version: 1,
    status: "PASS",
    scope:
      "real PostgreSQL, independent Ed25519 checker, executed command, source HTTP/SDK and SigV4 storage",
    checks,
    acceptance_id: accepted.acceptance_id,
    accepted_revision_id: accepted.revision_id,
    backend_requests: f.backend.requests.length,
  };
  const output = path.join(f.ROOT, "build/source-control/4.1");
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await f.close();
}
