import type { InvocationContext } from "../transport/protocol.js";
import { assertInvocation } from "../transport/protocol.js";
import { FoundationError } from "../policy/programme.js";
import {
  assertPrimaryTransaction,
  type PrimaryTransaction,
} from "../storage/transactions.js";
import { loadProofObligations, type ProofPolicy } from "../spec/obligations.js";
import {
  parseGeneration,
  parseObjectId,
  parseUUID,
  SourceControlError,
  type SourceScope,
} from "../source_control/contracts.js";
import {
  sourceDigest,
  sourceFailure,
  sourceScopeValues,
  type SourceContext,
  type SourceSQL,
} from "../source_control/metadata.js";
import {
  SourceCandidateService,
  type NativeCandidateRecord,
  type CandidateQualification,
} from "../source_control/candidates.js";
import { verifyCandidateEvidence } from "../source_control/evidence.js";
import { NativeSourceEvidenceVerifier } from "./native_source.js";

type Row = Record<string, any>;
export interface NativeFleetQualificationInput {
  operation_id: string;
  idempotency_key: string;
  run_id: string;
  task_id: string;
  custody_id: string;
  custody_generation: string;
  candidate_id: string;
  qualification_id: string;
  expected_state_version: string;
}
export interface NativeTaskQualificationReceipt {
  schema_version: 1;
  scope: SourceScope;
  run_id: string;
  task_id: string;
  custody_id: string;
  custody_generation: string;
  qualification_id: string;
  candidate_id: string;
  candidate_qualification_id: string;
  revision_id: string;
  root_tree_id: string;
  criteria_digest: string;
  spec_revision_id: string;
  spec_generation: string;
  policy_digest: string;
  input_digest: string;
  evidence_digest: string;
  state: "QUALIFIED";
  task_state_version: string;
}
function equal(a: unknown, b: unknown): boolean {
  return sourceDigest(a) === sourceDigest(b);
}
function primary(tx: SourceSQL): PrimaryTransaction {
  assertPrimaryTransaction(tx);
  return tx;
}
function positive(value: unknown): string {
  const v = parseGeneration(value);
  if (BigInt(v) < 1n)
    sourceFailure("INVALID_REQUEST", "A positive generation is required");
  return v;
}
async function currentSubmission(
  tx: SourceSQL,
  scope: { organisation_id: string; run_id: string },
  taskId: string,
  custodyId?: string,
): Promise<Row> {
  const row = (
    await tx.query(
      `SELECT c.*,t.state AS task_state,t.state_version::text AS task_state_version,
  t.criteria_digest AS current_criteria,t.spec_revision_id AS current_spec_revision,t.spec_generation::text AS current_spec_generation,
  t.current_native_custody_id,t.blocked_ask,r.authority_epoch AS current_run_epoch,
  d.authority_epoch::text AS current_source_epoch,d.policy_version AS current_policy_version,d.enabled,
  n.revoked_at AS native_revoked,n.owner_principal_id,a.base_revision_id AS assignment_base_revision_id
  FROM hyperfide.tasks t JOIN hyperfide.source_fleet_submissions c ON c.organisation_id=t.organisation_id AND c.run_id=t.run_id AND c.task_id=t.id AND c.custody_id=t.current_native_custody_id
  JOIN hyperfide.source_fleet_assignments a ON a.organisation_id=c.organisation_id AND a.repository_id=c.repository_id AND a.security_domain_id=c.security_domain_id AND a.assignment_id=c.assignment_id AND a.run_id=c.run_id AND a.task_id=c.task_id AND a.attempt_id=c.attempt_id AND a.attempt_generation=c.attempt_generation AND a.run_authority_epoch=c.run_authority_epoch AND a.source_authority_epoch=c.source_authority_epoch
  JOIN hyperfide.runs r ON r.organisation_id=t.organisation_id AND r.id=t.run_id
  JOIN hyperfide.source_authority_domains d ON d.organisation_id=c.organisation_id AND d.repository_id=c.repository_id AND d.security_domain_id=c.security_domain_id
  JOIN hyperfide.source_native_custodies n ON n.organisation_id=c.organisation_id AND n.repository_id=c.repository_id AND n.security_domain_id=c.security_domain_id AND n.custody_id=c.custody_id AND n.custody_generation=c.custody_generation AND n.revision_id=c.revision_id AND n.root_tree_id=c.root_tree_id AND n.run_id=c.run_id AND n.task_id=c.task_id AND n.authority_epoch=c.source_authority_epoch
  WHERE t.organisation_id=$1 AND t.run_id=$2 AND t.id=$3 AND ($4::uuid IS NULL OR c.custody_id=$4) FOR SHARE OF c,t,r,d,n,a`,
      [
        parseUUID(scope.organisation_id),
        parseUUID(scope.run_id),
        parseUUID(taskId),
        custodyId ? parseUUID(custodyId) : null,
      ],
    )
  ).rows[0];
  if (
    !row ||
    row.authority !== "ACTIVE" ||
    row.native_revoked !== null ||
    !row.enabled ||
    row.blocked_ask ||
    row.run_authority_epoch !== row.current_run_epoch ||
    String(row.source_authority_epoch) !== row.current_source_epoch ||
    row.criteria_digest !== row.current_criteria ||
    row.spec_revision_id !== row.current_spec_revision ||
    String(row.spec_generation) !== row.current_spec_generation
  )
    sourceFailure(
      "QUALIFICATION_STALE_CUSTODY",
      "Native task custody, accepted specification or authority is no longer current",
    );
  return row;
}
function contextFor(row: Row): SourceContext {
  return {
    scope: {
      organisation_id: row.organisation_id,
      repository_id: row.repository_id,
      security_domain_id: row.security_domain_id,
    },
    principal_id: row.owner_principal_id,
    authority_epoch: row.current_source_epoch,
    policy_version: row.current_policy_version,
    expires_at: "9999-12-31T00:00:00.000Z",
  };
}
async function proof(
  tx: SourceSQL,
  row: Row,
  candidate: NativeCandidateRecord,
  qualification: CandidateQualification,
  verifier: NativeSourceEvidenceVerifier,
): Promise<string> {
  const registered = await loadProofObligations(primary(tx), {
    organisation_id: row.organisation_id,
    run_id: row.run_id,
    task_id: row.task_id,
    spec_revision_id: row.spec_revision_id,
    spec_generation: String(row.spec_generation),
  });
  const policy: ProofPolicy = registered.policy;
  if (
    row.assignment_base_revision_id !== policy.source_object_id ||
    policy.repository_id !== row.repository_id ||
    !equal(policy, row.policy) ||
    candidate.policy_digest !== registered.registry_digest
  )
    sourceFailure(
      "QUALIFICATION_POLICY_STALE",
      "Native qualification must use the accepted Hyperfide proof policy and immutable assignment baseline",
    );
  if (
    !equal(candidate.scope, contextFor(row).scope) ||
    candidate.revision_id !== row.revision_id ||
    candidate.root_tree_id !== row.root_tree_id ||
    !equal(candidate.inputs, row.input_manifest) ||
    qualification.candidate_id !== candidate.candidate_id ||
    qualification.manifest_digest !== candidate.manifest_digest ||
    !candidate.contributors.some(
      (c) =>
        c.custody_id === row.custody_id &&
        c.custody_generation === String(row.custody_generation) &&
        c.run_id === row.run_id &&
        c.task_id === row.task_id &&
        c.revision_id === row.revision_id,
    )
  )
    sourceFailure(
      "QUALIFICATION_INPUT_STALE",
      "Native proof does not bind the current submitted revision, custody and execution inputs",
    );
  if (policy.clauses.some((clause) => clause.mode !== "EXECUTABLE"))
    sourceFailure(
      "QUALIFICATION_PROOF_INCOMPLETE",
      "Native task qualification requires evidence for every accepted clause; review clauses need explicit review support",
    );
  const policyRow = (
    await tx.query(
      "SELECT checks FROM hyperfide.source_native_assurance_policies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND policy_id=$4 FOR SHARE",
      [...sourceScopeValues(candidate.scope), candidate.policy_id],
    )
  ).rows[0];
  const checks: Row[] = policyRow?.checks;
  if (
    !Array.isArray(checks) ||
    checks.length !== policy.checks.length ||
    policy.checks.some((check) => {
      const native = checks.find((item) => item.id === check.id);
      return (
        !native ||
        !equal(native.argv, check.argv) ||
        native.executable_digest !== check.executable_digest ||
        !equal(native.required_artifacts, check.required_artifacts)
      );
    })
  )
    sourceFailure(
      "QUALIFICATION_POLICY_STALE",
      "Native checker registry differs from accepted executable proof obligations",
    );
  const evidence = await verifyCandidateEvidence(
    verifier.verifyEvidence.bind(verifier),
    tx,
    contextFor(row),
    candidate,
    qualification.evidence.evidence_ids,
  );
  if (!equal(evidence, qualification.evidence))
    sourceFailure(
      "QUALIFICATION_INPUT_STALE",
      "Independent native evidence changed after candidate qualification",
    );
  const observations = (
    await tx.query(
      "SELECT check_id,receipt FROM hyperfide.source_native_assurance_evidence WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND evidence_id=ANY($4::uuid[]) FOR SHARE",
      [...sourceScopeValues(candidate.scope), evidence.evidence_ids],
    )
  ).rows;
  for (const check of policy.checks) {
    const observed = observations.find(
      (item) => item.check_id === check.id,
    )?.receipt;
    const elapsed =
      Date.parse(observed?.command?.finished_at) -
      Date.parse(observed?.command?.started_at);
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > check.timeout_ms)
      sourceFailure(
        "QUALIFICATION_PROOF_INCOMPLETE",
        "Native execution exceeds the accepted command deadline",
      );
  }
  return evidence.evidence_digest;
}
export async function assertNativeTaskQualified(
  tx: PrimaryTransaction,
  scope: { organisation_id: string; run_id: string },
  taskId: string,
  repositoryId?: string | null,
): Promise<NativeTaskQualificationReceipt> {
  try {
    assertPrimaryTransaction(tx);
    const row = await currentSubmission(tx, scope, taskId);
    if (
      !["QUALIFIED", "INTEGRATING", "INTEGRATED"].includes(row.task_state) ||
      row.qualification_outcome !== "PASS" ||
      !row.current_qualification_id ||
      (repositoryId && row.repository_id !== repositoryId)
    )
      sourceFailure(
        "DEPENDENCY_NOT_QUALIFIED",
        "Dependency lacks a current native task qualification",
      );
    const retained = (
      await tx.query(
        "SELECT * FROM hyperfide.source_fleet_qualifications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND qualification_id=$4 AND custody_id=$5 FOR SHARE",
        [
          ...sourceScopeValues(contextFor(row).scope),
          row.current_qualification_id,
          row.custody_id,
        ],
      )
    ).rows[0];
    if (!retained)
      sourceFailure(
        "DEPENDENCY_NOT_QUALIFIED",
        "Native task qualification receipt is unavailable",
      );
    const receipt = retained.receipt as NativeTaskQualificationReceipt;
    const { qualification_id: _identity, ...body } = receipt;
    if (
      sourceDigest(body) !== receipt.qualification_id ||
      receipt.custody_generation !== String(row.custody_generation) ||
      receipt.criteria_digest !== row.criteria_digest ||
      receipt.spec_revision_id !== row.spec_revision_id ||
      receipt.spec_generation !== String(row.spec_generation) ||
      receipt.revision_id !== row.revision_id ||
      receipt.root_tree_id !== row.root_tree_id ||
      receipt.input_digest !== sourceDigest(row.input_manifest)
    )
      sourceFailure(
        "QUALIFICATION_INPUT_STALE",
        "Native task qualification receipt differs from current custody",
      );
    const candidate = (
      await tx.query(
        "SELECT manifest FROM hyperfide.source_native_candidates WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND candidate_id=$4",
        [...sourceScopeValues(receipt.scope), receipt.candidate_id],
      )
    ).rows[0]?.manifest as NativeCandidateRecord;
    const qualification = (
      await tx.query(
        "SELECT result FROM hyperfide.source_candidate_qualifications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND qualification_id=$4",
        [
          ...sourceScopeValues(receipt.scope),
          receipt.candidate_qualification_id,
        ],
      )
    ).rows[0]?.result as CandidateQualification;
    if (
      !candidate ||
      !qualification ||
      (await proof(
        tx,
        row,
        candidate,
        qualification,
        new NativeSourceEvidenceVerifier(),
      )) !== receipt.evidence_digest
    )
      sourceFailure(
        "QUALIFICATION_INPUT_STALE",
        "Native task proof is no longer current",
      );
    return receipt;
  } catch (error) {
    if (error instanceof SourceControlError)
      throw new FoundationError(error.code, error.message);
    throw error;
  }
}
export class NativeFleetQualification {
  constructor(
    readonly candidates: SourceCandidateService,
    readonly assurance: NativeSourceEvidenceVerifier,
  ) {}
  async qualify(
    context: SourceContext,
    input: NativeFleetQualificationInput,
    invocation?: InvocationContext,
  ): Promise<NativeTaskQualificationReceipt> {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some(
        (key) =>
          ![
            "operation_id",
            "idempotency_key",
            "run_id",
            "task_id",
            "custody_id",
            "custody_generation",
            "candidate_id",
            "qualification_id",
            "expected_state_version",
          ].includes(key),
      )
    )
      sourceFailure(
        "INVALID_REQUEST",
        "Native fleet qualification fields differ from the versioned contract",
      );
    for (const key of [
      "run_id",
      "task_id",
      "custody_id",
      "candidate_id",
    ] as const)
      parseUUID(input[key], key);
    positive(input.custody_generation);
    positive(input.expected_state_version);
    parseObjectId(input.qualification_id);
    assertInvocation(invocation);
    if (
      !["COORDINATOR", "OPERATOR"].includes(invocation.principal.role) ||
      invocation.principal.actor_id !== context.principal_id ||
      invocation.principal.organisation_id !== context.scope.organisation_id ||
      invocation.principal.run_id !== input.run_id
    )
      sourceFailure(
        "SCOPE_DENIED",
        "Current Hyperfide qualification authority is required",
      );
    return this.candidates.mutate(
      context,
      "source.fleet.qualify",
      input,
      async (tx) => {
        const p = primary(tx);
        await invocation.guard(p);
        const controls = await import("../scheduler/claim.js");
        await controls.assertNoExecutionHold(
          p,
          {
            organisation_id: context.scope.organisation_id,
            run_id: input.run_id,
          },
          { operation: "ADVANCE" },
        );
        await tx.query(
          "SELECT id FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE",
          [context.scope.organisation_id, input.run_id, input.task_id],
        );
        const row = await currentSubmission(
          tx,
          {
            organisation_id: context.scope.organisation_id,
            run_id: input.run_id,
          },
          input.task_id,
          input.custody_id,
        );
        if (
          !equal(context.scope, contextFor(row).scope) ||
          String(row.custody_generation) !== input.custody_generation ||
          row.task_state_version !== input.expected_state_version ||
          row.task_state !== "SUBMITTED"
        )
          sourceFailure(
            "QUALIFICATION_STALE_CUSTODY",
            "Task state or native custody generation changed before qualification",
          );
        const candidate = await this.candidates.candidateInTransaction(
          tx,
          context,
          input.candidate_id,
        );
        const qualification = await this.candidates.qualificationInTransaction(
          tx,
          context,
          input.qualification_id,
          input.candidate_id,
        );
        const evidenceDigest = await proof(
          tx,
          row,
          candidate,
          qualification,
          this.assurance,
        );
        const body = {
          schema_version: 1 as const,
          scope: context.scope,
          run_id: input.run_id,
          task_id: input.task_id,
          custody_id: input.custody_id,
          custody_generation: input.custody_generation,
          candidate_id: input.candidate_id,
          candidate_qualification_id: input.qualification_id,
          revision_id: row.revision_id,
          root_tree_id: row.root_tree_id,
          criteria_digest: row.criteria_digest,
          spec_revision_id: row.spec_revision_id,
          spec_generation: String(row.spec_generation),
          policy_digest: candidate.policy_digest,
          input_digest: sourceDigest(row.input_manifest),
          evidence_digest: evidenceDigest,
          state: "QUALIFIED" as const,
          task_state_version: (BigInt(row.task_state_version) + 1n).toString(),
        };
        const result: NativeTaskQualificationReceipt = {
          ...body,
          qualification_id: sourceDigest(body),
        };
        await tx.query(
          `INSERT INTO hyperfide.source_fleet_qualifications(organisation_id,repository_id,security_domain_id,run_id,task_id,custody_id,custody_generation,qualification_id,candidate_id,candidate_qualification_id,criteria_digest,spec_revision_id,spec_generation,policy_digest,input_digest,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            ...sourceScopeValues(context.scope),
            input.run_id,
            input.task_id,
            input.custody_id,
            input.custody_generation,
            result.qualification_id,
            input.candidate_id,
            input.qualification_id,
            row.criteria_digest,
            row.spec_revision_id,
            row.spec_generation,
            candidate.policy_digest,
            result.input_digest,
            result,
          ],
        );
        await tx.query(
          "UPDATE hyperfide.source_fleet_submissions SET qualification_outcome='PASS',current_qualification_id=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND custody_id=$4",
          [
            ...sourceScopeValues(context.scope),
            input.custody_id,
            result.qualification_id,
          ],
        );
        await tx.query(
          "UPDATE hyperfide.tasks SET state='QUALIFIED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3",
          [context.scope.organisation_id, input.run_id, input.task_id],
        );
        return result;
      },
    );
  }
}
