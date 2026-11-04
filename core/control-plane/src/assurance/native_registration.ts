import {
  assertInvocation,
  type InvocationContext,
} from "../transport/protocol.js";
import {
  readProofObligationsSnapshot,
  type ProofObligations,
} from "../spec/obligations.js";
import { readAdmittedNativeFleetSource } from "../source_control/fleet-run-source.js";
import {
  parseGeneration,
  parseUUID,
  type SourceScope,
} from "../source_control/contracts.js";
import {
  sourceDigest,
  sourceFailure,
  sourceScopeValues,
  type SourceContext,
  type SourceSQL,
} from "../source_control/metadata.js";
import type { NativeCheckDefinition } from "./native_source.js";

interface RegistrationMutation {
  operation_id: string;
  idempotency_key: string;
}
export interface NativePolicyRegistrationInput extends RegistrationMutation {
  policy_id: string;
  run_id: string;
  task_id: string;
  spec_revision_id: string;
  spec_generation: string;
  expires_at: string;
}
export interface NativeCheckerRegistrationInput extends RegistrationMutation {
  policy_id: string;
  check_id: string;
  credential_id: string;
  expires_at: string;
}
export interface NativePolicyRegistrationResult {
  schema_version: 1;
  scope: SourceScope;
  policy_id: string;
  policy_digest: string;
  authority_epoch: string;
  policy_version: string;
  run_id: string;
  task_id: string;
  spec_revision_id: string;
  spec_generation: string;
  checks_digest: string;
  expires_at: string;
}
export interface NativeCheckerRegistrationResult {
  schema_version: 1;
  scope: SourceScope;
  policy_id: string;
  check_id: string;
  principal_id: string;
  credential_id: string;
  credential_version: string;
  identity_kind: "NATIVE";
  run_id: string;
  role: string;
  deployment_epoch: string;
  expires_at: string;
}
export function assertNativeRegistrationInvocation(
  context: SourceContext,
  invocation: InvocationContext | undefined,
): asserts invocation is InvocationContext {
  assertInvocation(invocation);
  if (
    invocation.principal.organisation_id !== context.scope.organisation_id ||
    invocation.principal.actor_id !== context.principal_id ||
    !["OPERATOR", "COORDINATOR"].includes(invocation.principal.role)
  )
    sourceFailure(
      "ASSURANCE_REGISTRATION_DENIED",
      "Current native operator or coordinator authority is required",
    );
}
function exact(value: unknown, required: readonly string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== required.length ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    sourceFailure(
      "INVALID_REQUEST",
      "Native assurance registration fields differ from the versioned contract",
    );
}
function expires(value: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    sourceFailure(
      "INVALID_REQUEST",
      "Canonical registration expiry is required",
    );
}
function nativeChecks(proof: ProofObligations): NativeCheckDefinition[] {
  if (
    !proof.policy.checks.length ||
    proof.policy.checks.length > 64 ||
    proof.policy.clauses.some((clause) => clause.mode !== "EXECUTABLE")
  )
    sourceFailure(
      "NATIVE_PROOF_UNSUPPORTED",
      "Native checker registration requires executable accepted proof clauses",
    );
  const environment = sourceDigest({ LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
  return proof.policy.checks.map((check) => ({
    id: check.id,
    argv: [...check.argv],
    executable_digest: check.executable_digest,
    environment_digest: environment,
    required_artifacts: [...check.required_artifacts],
  }));
}
export async function verifyNativePolicyRegistration(
  tx: SourceSQL,
  context: SourceContext,
  policy: { policy_id: string; policy_digest: string; checks: unknown },
): Promise<void> {
  const available = (
    await tx.query(
      "SELECT to_regclass('hyperfide.source_native_assurance_policy_registrations') IS NOT NULL AS ready",
    )
  ).rows[0]?.ready;
  if (!available) return;
  const row = (
    await tx.query(
      "SELECT p.*,r.authority_epoch AS current_run_epoch FROM hyperfide.source_native_assurance_policy_registrations p JOIN hyperfide.runs r ON r.organisation_id=p.organisation_id AND r.id=p.run_id WHERE p.organisation_id=$1 AND p.repository_id=$2 AND p.security_domain_id=$3 AND p.policy_id=$4 FOR SHARE OF p,r",
      [...sourceScopeValues(context.scope), policy.policy_id],
    )
  ).rows[0];
  if (!row) return;
  if (row.run_authority_epoch !== row.current_run_epoch)
    sourceFailure(
      "EVIDENCE_POLICY_STALE",
      "The accepted native policy run authority changed",
    );
  const proof = await readProofObligationsSnapshot(tx, {
    organisation_id: context.scope.organisation_id,
    run_id: row.run_id,
    task_id: row.task_id,
    spec_revision_id: row.spec_revision_id,
    spec_generation: String(row.spec_generation),
  });
  if (
    proof.registry_digest !== row.registry_digest ||
    proof.registry_digest !== policy.policy_digest ||
    sourceDigest(nativeChecks(proof)) !== row.checks_digest ||
    sourceDigest(policy.checks) !== row.checks_digest
  )
    sourceFailure(
      "EVIDENCE_POLICY_STALE",
      "Native assurance no longer matches its current accepted proof registry",
    );
}
export async function registerNativePolicy(
  tx: SourceSQL,
  context: SourceContext,
  input: NativePolicyRegistrationInput,
  invocation: InvocationContext,
): Promise<NativePolicyRegistrationResult> {
  exact(input, [
    "operation_id",
    "idempotency_key",
    "policy_id",
    "run_id",
    "task_id",
    "spec_revision_id",
    "spec_generation",
    "expires_at",
  ]);
  assertNativeRegistrationInvocation(context, invocation);
  for (const value of [
    input.policy_id,
    input.run_id,
    input.task_id,
    input.spec_revision_id,
  ])
    parseUUID(value);
  parseGeneration(input.spec_generation);
  expires(input.expires_at);
  if (
    BigInt(input.spec_generation) < 1n ||
    BigInt(input.spec_generation) > 9223372036854775807n
  )
    sourceFailure(
      "INVALID_REQUEST",
      "A positive signed PostgreSQL specification generation is required",
    );
  if (input.run_id !== invocation.principal.run_id)
    sourceFailure(
      "ASSURANCE_REGISTRATION_DENIED",
      "Policy registration requires the authenticated run and accepted generation",
    );
  await invocation.guard(tx);
  const window = (
    await tx.query(
      "SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '30 days' AS valid",
      [input.expires_at],
    )
  ).rows[0];
  if (!window?.valid)
    sourceFailure(
      "INVALID_REQUEST",
      "Policy expiry must be future and within thirty days",
    );
  const proof = await readProofObligationsSnapshot(tx, {
    organisation_id: context.scope.organisation_id,
    run_id: input.run_id,
    task_id: input.task_id,
    spec_revision_id: input.spec_revision_id,
    spec_generation: input.spec_generation,
  });
  const source = await readAdmittedNativeFleetSource(
    tx,
    { organisation_id: context.scope.organisation_id, run_id: input.run_id },
    context.scope.repository_id,
    proof.policy.source_object_id,
  );
  if (
    !source ||
    source.scope.security_domain_id !== context.scope.security_domain_id ||
    proof.policy.repository_id !== context.scope.repository_id
  )
    sourceFailure(
      "ASSURANCE_REGISTRATION_DENIED",
      "Accepted proof must bind this admitted native repository and security domain",
    );
  const definitions = nativeChecks(proof),
    checksDigest = sourceDigest(definitions);
  await tx.query(
    "INSERT INTO hyperfide.source_native_assurance_policies(organisation_id,repository_id,security_domain_id,policy_id,policy_digest,authority_epoch,policy_version,checks,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
    [
      ...sourceScopeValues(context.scope),
      input.policy_id,
      proof.registry_digest,
      context.authority_epoch,
      context.policy_version,
      JSON.stringify(definitions),
      input.expires_at,
    ],
  );
  const saved = (
    await tx.query(
      "SELECT policy_digest,authority_epoch::text,policy_version,checks,expires_at,revoked_at FROM hyperfide.source_native_assurance_policies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND policy_id=$4 FOR SHARE",
      [...sourceScopeValues(context.scope), input.policy_id],
    )
  ).rows[0];
  if (
    !saved ||
    saved.policy_digest !== proof.registry_digest ||
    saved.authority_epoch !== context.authority_epoch ||
    saved.policy_version !== context.policy_version ||
    sourceDigest(saved.checks) !== checksDigest ||
    new Date(saved.expires_at).toISOString() !== input.expires_at ||
    saved.revoked_at !== null
  )
    sourceFailure(
      "ASSURANCE_REGISTRATION_CONFLICT",
      "Policy identity already binds other native proof inputs",
    );
  await tx.query(
    "INSERT INTO hyperfide.source_native_assurance_policy_registrations(organisation_id,repository_id,security_domain_id,policy_id,run_id,task_id,spec_revision_id,spec_generation,run_authority_epoch,registry_digest,checks_digest,registered_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING",
    [
      ...sourceScopeValues(context.scope),
      input.policy_id,
      input.run_id,
      input.task_id,
      input.spec_revision_id,
      input.spec_generation,
      source.authority_epoch,
      proof.registry_digest,
      checksDigest,
      invocation.principal.credential_id,
    ],
  );
  const registration = (
    await tx.query(
      "SELECT run_id,task_id,spec_revision_id,spec_generation::text,run_authority_epoch FROM hyperfide.source_native_assurance_policy_registrations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND policy_id=$4 FOR SHARE",
      [...sourceScopeValues(context.scope), input.policy_id],
    )
  ).rows[0];
  if (
    !registration ||
    registration.run_id !== input.run_id ||
    registration.task_id !== input.task_id ||
    registration.spec_revision_id !== input.spec_revision_id ||
    registration.spec_generation !== input.spec_generation ||
    registration.run_authority_epoch !== source.authority_epoch
  )
    sourceFailure(
      "ASSURANCE_REGISTRATION_CONFLICT",
      "Policy registration identity already binds another accepted task",
    );
  return {
    schema_version: 1,
    scope: context.scope,
    policy_id: input.policy_id,
    policy_digest: proof.registry_digest,
    authority_epoch: context.authority_epoch,
    policy_version: context.policy_version!,
    run_id: input.run_id,
    task_id: input.task_id,
    spec_revision_id: input.spec_revision_id,
    spec_generation: input.spec_generation,
    checks_digest: checksDigest,
    expires_at: input.expires_at,
  };
}
export async function registerNativeChecker(
  tx: SourceSQL,
  context: SourceContext,
  input: NativeCheckerRegistrationInput,
  invocation: InvocationContext,
): Promise<NativeCheckerRegistrationResult> {
  exact(input, [
    "operation_id",
    "idempotency_key",
    "policy_id",
    "check_id",
    "credential_id",
    "expires_at",
  ]);
  assertNativeRegistrationInvocation(context, invocation);
  parseUUID(input.policy_id);
  parseUUID(input.credential_id);
  expires(input.expires_at);
  if (
    typeof input.check_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.check_id)
  )
    sourceFailure(
      "INVALID_REQUEST",
      "An exact registered check identity is required",
    );
  await invocation.guard(tx);
  const policy = (
    await tx.query(
      "SELECT p.*,b.run_id FROM hyperfide.source_native_assurance_policies p JOIN hyperfide.source_native_assurance_policy_registrations b USING(organisation_id,repository_id,security_domain_id,policy_id) WHERE p.organisation_id=$1 AND p.repository_id=$2 AND p.security_domain_id=$3 AND p.policy_id=$4 AND p.authority_epoch=$5 AND p.policy_version=$6 AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() AND $7::timestamptz>clock_timestamp() AND $7::timestamptz<=p.expires_at FOR SHARE OF p,b",
      [
        ...sourceScopeValues(context.scope),
        input.policy_id,
        context.authority_epoch,
        context.policy_version,
        input.expires_at,
      ],
    )
  ).rows[0];
  if (!policy || policy.run_id !== invocation.principal.run_id)
    sourceFailure(
      "ASSURANCE_REGISTRATION_DENIED",
      "Checker registration requires a current same-run native policy",
    );
  await verifyNativePolicyRegistration(tx, context, {
    policy_id: policy.policy_id,
    policy_digest: policy.policy_digest,
    checks: policy.checks,
  });
  if (
    !(policy.checks as NativeCheckDefinition[]).some(
      (check) => check.id === input.check_id,
    )
  )
    sourceFailure(
      "ASSURANCE_REGISTRATION_DENIED",
      "Checker is outside the accepted executable check set",
    );
  const identity = (
    await tx.query(
      "SELECT * FROM hyperfide.identity_principals WHERE organisation_id=$1 AND run_id=$2 AND credential_id=$3 AND state='ACTIVE' AND expires_at>clock_timestamp() AND role IN ('VERIFIER','COORDINATOR') FOR SHARE",
      [context.scope.organisation_id, policy.run_id, input.credential_id],
    )
  ).rows[0];
  if (
    !identity ||
    identity.deployment_epoch !== invocation.principal.deployment_epoch ||
    !Array.isArray(identity.allowed_actions) ||
    !identity.allowed_actions.includes("source.assurance.publish")
  )
    sourceFailure(
      "CHECKER_NOT_AUTHORIZED",
      "A current independent native verifier with source publication authority is required",
    );
  await tx.query(
    "INSERT INTO hyperfide.source_native_assurance_checkers(organisation_id,repository_id,security_domain_id,policy_id,check_id,principal_id,credential_id,expires_at,identity_kind,identity_run_id,identity_credential_version,identity_role,identity_deployment_epoch,identity_public_key_b64) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'NATIVE',$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING",
    [
      ...sourceScopeValues(context.scope),
      input.policy_id,
      input.check_id,
      identity.actor_id,
      identity.credential_id,
      input.expires_at,
      identity.run_id,
      identity.credential_version,
      identity.role,
      identity.deployment_epoch,
      identity.public_key_b64,
    ],
  );
  const saved = (
    await tx.query(
      "SELECT * FROM hyperfide.source_native_assurance_checkers WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND policy_id=$4 AND check_id=$5 AND principal_id=$6 AND credential_id=$7 FOR SHARE",
      [
        ...sourceScopeValues(context.scope),
        input.policy_id,
        input.check_id,
        identity.actor_id,
        identity.credential_id,
      ],
    )
  ).rows[0];
  if (
    !saved ||
    saved.identity_kind !== "NATIVE" ||
    saved.identity_run_id !== identity.run_id ||
    String(saved.identity_credential_version) !==
      String(identity.credential_version) ||
    saved.identity_role !== identity.role ||
    saved.identity_deployment_epoch !== identity.deployment_epoch ||
    saved.identity_public_key_b64 !== identity.public_key_b64 ||
    new Date(saved.expires_at).toISOString() !== input.expires_at ||
    saved.revoked_at !== null
  )
    sourceFailure(
      "ASSURANCE_REGISTRATION_CONFLICT",
      "Checker registration identity already binds another authority",
    );
  return {
    schema_version: 1,
    scope: context.scope,
    policy_id: input.policy_id,
    check_id: input.check_id,
    principal_id: identity.actor_id,
    credential_id: identity.credential_id,
    credential_version: String(identity.credential_version),
    identity_kind: "NATIVE",
    run_id: identity.run_id,
    role: identity.role,
    deployment_epoch: identity.deployment_epoch,
    expires_at: input.expires_at,
  };
}

export async function nativeCheckerCredentialVersion(
  tx: SourceSQL,
  row: Record<string, any>,
  recordedVersion?: string,
): Promise<string> {
  const current = BigInt(row.credential_version),
    registered = BigInt(row.registered_version),
    required =
      recordedVersion === undefined
        ? current
        : BigInt(parseGeneration(recordedVersion));
  if (
    current < registered ||
    required < registered ||
    required > current ||
    current - registered > 4096n
  )
    sourceFailure(
      "CHECKER_NOT_AUTHORIZED",
      "Native checker version is outside retained authority lineage",
    );
  if (current > registered) {
    const renewals = (
      await tx.query(
        `SELECT response FROM hyperfide.identity_operation_results WHERE scope_id=$1 AND operation='identity.principal.renew' AND response->>'credential_id'=$1::text AND response->>'credential_version' ~ '^[1-9][0-9]{0,18}$' AND (response->>'credential_version')::numeric>$2::numeric AND (response->>'credential_version')::numeric<=$3::numeric ORDER BY created_at LIMIT 4097`,
        [row.credential_id, String(registered), String(current)],
      )
    ).rows;
    const versions = new Set(
      renewals
        .filter(
          (item) =>
            item.response.run_id === row.identity_run_id &&
            item.response.role === row.identity_role &&
            item.response.actor_id === row.principal_id,
        )
        .map((item) => String(item.response.credential_version)),
    );
    for (let version = registered + 1n; version <= current; version++)
      if (!versions.has(String(version)))
        sourceFailure(
          "CHECKER_NOT_AUTHORIZED",
          "Native checker version changed outside verified renewal history",
        );
  }
  return String(required);
}
