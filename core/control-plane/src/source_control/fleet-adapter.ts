import { randomUUID } from "node:crypto";
import {
  parseGeneration,
  parseObjectId,
  parseRepositoryPath,
  parseUUID,
  type SourceScope,
} from "./contracts.js";
import type { WorkspaceBudgets } from "./workspaces.js";
import {
  SourceMetadata,
  sourceDigest,
  sourceFailure,
  sourceScopeValues,
  type SourceContext,
  type SourceSQL,
} from "./metadata.js";
import {
  type ManagedSourceBinding,
  type SourcePrincipal,
  type SourceSQL as AuthoritySQL,
} from "./capabilities.js";
import {
  readAdmittedNativeFleetSource,
  readNativeFleetRunSource,
  type NativeFleetRunSource,
} from "./fleet-run-source.js";
export {
  readNativeFleetRunSource,
  readAdmittedNativeFleetSource,
  listNativeFleetRunSources,
  validateNativeFleetSource,
  validateAdmittedNativeFleetSource,
  type NativeFleetRunSource,
} from "./fleet-run-source.js";
import { reserveSourceOperation } from "./operations.js";
import {
  assertPrimaryTransaction,
  type PrimaryTransaction,
} from "../storage/transactions.js";
import {
  assertInvocation,
  type InvocationContext,
} from "../transport/protocol.js";
import { requireAuthority } from "../hierarchy/packages.js";
import { assertCurrentCompute, releaseCompute } from "../scheduler/leases.js";
import type { ComputeToken } from "../scheduler/claim.js";
import {
  loadExecutionPacket,
  deriveQualificationInputs,
} from "../hierarchy/packets.js";
import { loadProofObligations } from "../spec/obligations.js";
import { nativeCandidateSourceDigest,validateCandidateDependencies,nativeCandidateDependencyDigest,type CandidateDependency,type CandidateExecutionDependency } from "./candidates.js";
import { readReadyFleetInstall } from "../preparation/fleet_authority.js";

export interface FleetSourceAssignmentInput {
  operation_id: string;
  idempotency_key: string;
  assignment_id: string;
  run_id: string;
  task_id: string;
  attempt_id: string;
  attempt_generation: string;
  workspace_id: string;
  base_revision_id: string;
  closure_digest: string;
  environment_digest: string;
  read_paths: string[];
  write_paths: string[];
  mode: "API_ONLY" | "SPARSE" | "MATERIALIZED";
  worker_principal_id: string;
  worker_credential_id: string;
  leader_generation: string;
  package_id: string;
  package_generation: string;
}

export interface FleetSourceAssignment {
  schema_version: 1;
  scope: SourceScope;
  assignment_id: string;
  assignment_generation: string;
  run_id: string;
  task_id: string;
  attempt_id: string;
  attempt_generation: string;
  workspace_id: string;
  base_revision_id: string;
  root_tree_id: string;
  closure_digest: string;
  environment_digest: string;
  worker_principal_id: string;
  capability_id: string;
  authority: {
    authority_epoch: string;
    generation: string;
    policy_version: string;
    workspace: { workspace_id: string; workspace_generation: string };
    managed: {
      task_id: string;
      attempt_id: string;
      attempt_generation: string;
    };
  };
  workspace: {
    workspace_generation: string;
    scope_generation: string;
    mode: "API_ONLY" | "SPARSE" | "MATERIALIZED";
    read_paths: string[];
    write_paths: string[];
    budgets: WorkspaceBudgets;
  };
}

export interface FleetRunSourceInput {
  operation_id: string;
  idempotency_key: string;
  run_id: string;
  revision_id: string;
  leader_generation: string;
}

type Row = Record<string, any>;
const WORKER_ACTIONS = [
  "source.objects.put",
  "source.workspaces.detail",
  "source.workspaces.checkpoint",
  "source.operations.read",
  "source.fleet.read",
  "source.fleet.submit",
  "source.fleet.submission",
  "source.graph.query",
];
const RETAINED_READS = new Set([
  "source.operations.read",
  "source.fleet.read",
  "source.fleet.submission",
  "source.fleet.submit",
]);
function positive(value: unknown): string {
  const result = parseGeneration(value);
  if (BigInt(result) < 1n)
    sourceFailure("INVALID_REQUEST", "Positive fleet generation required");
  return result;
}
function fields(value: unknown, required: string[]): asserts value is Row {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== required.length ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    sourceFailure(
      "INVALID_REQUEST",
      "Fleet source fields differ from the versioned contract",
    );
}
function computeToken(row: Row): ComputeToken {
  return {
    organisation_id: row.organisation_id,
    run_id: row.run_id,
    task_id: row.task_id,
    attempt_id: row.attempt_id,
    attempt_generation: String(row.attempt_generation),
    authority_epoch: row.run_authority_epoch,
    sandbox_id: row.sandbox_id,
    slot_id: row.slot_id,
    sandbox_boot_generation: String(row.sandbox_boot_generation),
  };
}
function primary(tx: AuthoritySQL): PrimaryTransaction {
  assertPrimaryTransaction(tx);
  return tx;
}
function invocationFor(
  context: SourceContext,
  i: InvocationContext | undefined,
  run: string,
): InvocationContext {
  assertInvocation(i);
  if (
    i.principal.organisation_id !== context.scope.organisation_id ||
    i.principal.run_id !== run ||
    i.principal.actor_id !== context.principal_id
  )
    sourceFailure(
      "FLEET_PRINCIPAL_MISMATCH",
      "Fleet source actor differs from the authenticated control-plane invocation",
    );
  return i;
}
function paths(input: unknown, empty = false): string[] {
  if (!Array.isArray(input) || (!empty && !input.length) || input.length > 256)
    sourceFailure("INVALID_REQUEST", "Explicit bounded fleet paths required");
  const result = input.map((p) => (p === "" ? "" : parseRepositoryPath(p)));
  if (new Set(result).size !== result.length)
    sourceFailure("INVALID_REQUEST", "Fleet paths must be unique");
  return result;
}

function assignmentPaths(value: unknown): string[] {
  if (!Array.isArray(value))
    sourceFailure(
      "FLEET_ASSIGNMENT_MISMATCH",
      "Admitted task scope is missing",
    );
  return value.map((path) => {
    if (typeof path !== "string")
      sourceFailure(
        "FLEET_ASSIGNMENT_MISMATCH",
        "Admitted task scope is invalid",
      );
    return path === "**" || path === "."
      ? ""
      : path.endsWith("/**")
        ? path.slice(0, -3)
        : path;
  });
}

export async function assertFleetManagedAuthority(
  tx: AuthoritySQL,
  principalValue: SourcePrincipal,
  binding: ManagedSourceBinding,
  action = "source.workspaces.checkpoint",
): Promise<void> {
  const row = (
    await tx.query(
      `SELECT f.*,w.closed_at,w.principal_id AS workspace_principal FROM hyperfide.source_fleet_assignments f
    JOIN hyperfide.source_workspaces w USING(organisation_id,repository_id,security_domain_id,workspace_id)
    WHERE f.organisation_id=$1 AND f.workspace_id=$2 AND f.worker_principal_id=$3 AND f.worker_credential_id=$4 AND f.assignment_generation=$5
    AND f.task_id=$6 AND f.attempt_id=$7 AND f.attempt_generation=$8 FOR SHARE OF f,w`,
      [
        principalValue.organisation_id,
        binding.workspace_id,
        principalValue.id,
        principalValue.credential_id,
        binding.generation,
        binding.task_id ?? null,
        binding.attempt_id ?? null,
        binding.attempt_generation ?? null,
      ],
    )
  ).rows[0];
  if (!row || row.workspace_principal !== principalValue.id)
    sourceFailure(
      "FLEET_ASSIGNMENT_STALE",
      "Source capability has no exact fleet assignment",
    );
  if (RETAINED_READS.has(action) && row.submission_id !== null) return;
  if (row.submission_id !== null || row.closed_at !== null)
    sourceFailure(
      "FLEET_ASSIGNMENT_STALE",
      "Submitted or closed workspaces cannot accept worker mutations",
    );
  await assertCurrentCompute(primary(tx), computeToken(row), {
    operation: "CHECKPOINT",
  });
  const session = (
    await tx.query(
      "SELECT 1 FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND role='WORKER' AND state IN('REGISTERED','RUNNING') AND attempt_id=$4 AND sandbox_id=$5 AND slot_id=$6 AND sandbox_boot_generation=$7 FOR SHARE",
      [
        row.organisation_id,
        row.run_id,
        principalValue.id,
        row.attempt_id,
        row.sandbox_id,
        row.slot_id,
        row.sandbox_boot_generation,
      ],
    )
  ).rows;
  if (session.length !== 1)
    sourceFailure(
      "FLEET_ASSIGNMENT_STALE",
      "Worker session no longer owns the assigned attempt",
    );
}

export class SourceFleetService {
  constructor(
    readonly metadata: SourceMetadata,
    readonly budgets: WorkspaceBudgets,
  ) {}
  private async mutate<T>(
    context: SourceContext,
    action: string,
    input: { operation_id: string; idempotency_key: string },
    body: (tx: SourceSQL) => Promise<T>,
  ): Promise<T> {
    return this.metadata.transaction((tx) =>
      this.mutateInTransaction(tx, context, action, input, body),
    );
  }
  private async mutateInTransaction<T>(
    tx: SourceSQL,
    context: SourceContext,
    action: string,
    input: { operation_id: string; idempotency_key: string },
    body: (tx: SourceSQL) => Promise<T>,
  ): Promise<T> {
    const operation = parseUUID(input.operation_id),
      { operation_id: _operation, idempotency_key: _key, ...payload } = input,
      digest = sourceDigest(payload);
    await this.metadata.guard(tx, context, action);
    const reserved = await reserveSourceOperation(tx, context, {
      operation_id: operation,
      idempotency_key: input.idempotency_key,
      action,
      request_digest: digest,
    });
    if (reserved.state === "COMMITTED" && reserved.result !== null)
      return reserved.result as T;
    if (reserved.state !== "PENDING")
      sourceFailure(
        "OPERATION_TERMINAL",
        "Fleet operation has already terminated",
      );
    const result = await body(tx);
    const committed = await tx.query(
      "UPDATE hyperfide.source_metadata_operations SET state='COMMITTED',result=$5,result_digest=$6,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND operation_id=$4 AND principal_id=$7 AND state='PENDING'",
      [
        ...sourceScopeValues(context.scope),
        reserved.operation_id,
        result,
        sourceDigest(result),
        context.principal_id,
      ],
    );
    if (committed.rowCount !== 1)
      sourceFailure(
        "OPERATION_TERMINAL",
        "Fleet operation changed before commit",
      );
    return result;
  }

  async bindRun(
    context: SourceContext,
    input: FleetRunSourceInput,
    invocation?: InvocationContext,
  ): Promise<NativeFleetRunSource> {
    fields(input, [
      "operation_id",
      "idempotency_key",
      "run_id",
      "revision_id",
      "leader_generation",
    ]);
    const run = parseUUID(input.run_id),
      revision = parseObjectId(input.revision_id),
      leader = positive(input.leader_generation);
    const i = invocationFor(context, invocation, run);
    return this.mutate(context, "source.fleet.bind-run", input, async (tx) => {
      await i.guard(tx);
      const p = primary(tx);
      await requireAuthority(p, {
        organisation_id: context.scope.organisation_id,
        run_id: run,
        session_id: context.principal_id,
        authority_epoch: i.principal.deployment_epoch,
        leader_generation: leader,
        roles: ["LEADER"],
      });
      const source = await this.metadata.readRevisionInTransaction(
        tx,
        context,
        revision,
      );
      await this.metadata.protectRoot(
        tx,
        context.scope,
        source.root_tree_id,
        "native-run:" + run + ":" + context.scope.repository_id,
      );
      const digest = sourceDigest({
        scope: context.scope,
        revision_id: revision,
        root_tree_id: source.root_tree_id,
      });
      await tx.query(
        `INSERT INTO hyperfide.source_fleet_runs(organisation_id,repository_id,security_domain_id,run_id,revision_id,root_tree_id,authority_epoch,source_authority_epoch,leader_generation,source_manifest_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [
          ...sourceScopeValues(context.scope),
          run,
          revision,
          source.root_tree_id,
          i.principal.deployment_epoch,
          context.authority_epoch,
          leader,
          digest,
        ],
      );
      const baseline = (
        await tx.query(
          "SELECT revision_id FROM hyperfide.source_fleet_runs WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND run_id=$4",
          [...sourceScopeValues(context.scope), run],
        )
      ).rows[0];
      if (baseline?.revision_id !== revision)
        sourceFailure(
          "FLEET_SOURCE_CONFLICT",
          "Run already binds another immutable native source",
        );
      const current = await readAdmittedNativeFleetSource(
        tx,
        { organisation_id: context.scope.organisation_id, run_id: run },
        context.scope.repository_id,
        revision,
      );
      if (
        !current ||
        current.scope.security_domain_id !== context.scope.security_domain_id ||
        current.revision_id !== revision
      )
        sourceFailure(
          "FLEET_SOURCE_CONFLICT",
          "Run already binds another immutable native source",
        );
      return current;
    });
  }
  async assign(
    context: SourceContext,
    input: FleetSourceAssignmentInput,
    invocation?: InvocationContext,
  ): Promise<FleetSourceAssignment> {
    fields(input, [
      "operation_id",
      "idempotency_key",
      "assignment_id",
      "run_id",
      "task_id",
      "attempt_id",
      "attempt_generation",
      "workspace_id",
      "base_revision_id",
      "closure_digest",
      "environment_digest",
      "read_paths",
      "write_paths",
      "mode",
      "worker_principal_id",
      "worker_credential_id",
      "leader_generation",
      "package_id",
      "package_generation",
    ]);
    for (const key of [
      "assignment_id",
      "run_id",
      "task_id",
      "attempt_id",
      "workspace_id",
      "worker_principal_id",
      "worker_credential_id",
      "package_id",
    ] as const)
      parseUUID(input[key]);
    for (const key of [
      "attempt_generation",
      "leader_generation",
      "package_generation",
    ] as const)
      positive(input[key]);
    for (const key of [
      "base_revision_id",
      "closure_digest",
      "environment_digest",
    ] as const)
      parseObjectId(input[key]);
    const read = paths(input.read_paths),
      write = paths(input.write_paths, true);
    if (!["API_ONLY", "SPARSE", "MATERIALIZED"].includes(input.mode))
      sourceFailure("INVALID_REQUEST", "Explicit workspace mode required");
    const i = invocationFor(context, invocation, input.run_id);
    return this.mutate(context, "source.fleet.assign", input, async (tx) => {
      await i.guard(tx);
      await requireAuthority(primary(tx), {
        organisation_id: context.scope.organisation_id,
        run_id: input.run_id,
        session_id: context.principal_id,
        authority_epoch: i.principal.deployment_epoch,
        leader_generation: input.leader_generation,
        package_id: input.package_id,
        package_generation: input.package_generation,
        roles: ["LEADER", "FEATURE_MANAGER"],
      });
      return this.assignInTransaction(tx, context, input, i);
    });
  }
  private async assignInTransaction(
    tx: SourceSQL,
    context: SourceContext,
    input: FleetSourceAssignmentInput,
    i: InvocationContext,
    retained = false,
  ): Promise<FleetSourceAssignment> {
    const read = paths(input.read_paths),
      write = paths(input.write_paths, true);
    const runScope = {
      organisation_id: context.scope.organisation_id,
      run_id: input.run_id,
    };
    const source = retained
      ? await readAdmittedNativeFleetSource(
          tx,
          runScope,
          context.scope.repository_id,
          input.base_revision_id,
        )
      : await readNativeFleetRunSource(
          tx,
          runScope,
          context.scope.repository_id,
        );
    if (
      !source ||
      source.scope.security_domain_id !== context.scope.security_domain_id ||
      source.revision_id !== input.base_revision_id
    )
      sourceFailure(
        "FLEET_SOURCE_MISMATCH",
        "Assignment must use the configured native run baseline",
      );
    const attempt = (
      await tx.query(
        `SELECT a.*,t.feature_package_id FROM hyperfide.attempts a JOIN hyperfide.tasks t ON t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task_id WHERE a.organisation_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.task_id=$4 AND a.generation=$5 FOR SHARE OF a,t`,
        [
          context.scope.organisation_id,
          input.run_id,
          input.attempt_id,
          input.task_id,
          input.attempt_generation,
        ],
      )
    ).rows[0];
    if (!attempt || attempt.feature_package_id !== input.package_id)
      sourceFailure(
        "FLEET_ASSIGNMENT_STALE",
        "Attempt must belong to the current delegated task",
      );
    const effects = (
      await tx.query(
        `SELECT e.result FROM hyperfide.fleet_effect_receipts e WHERE e.organisation_id=$1 AND e.run_id=$2 AND e.result->>'kind'='ASSIGN_WORKER' AND e.result->'assignment'->>'worker_id'=$3 AND e.result->'assignment'->>'manager_id'=$4 AND e.result->'assignment'->>'manager_generation'=$5 AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.result->'tasks') t WHERE t->>'task_id'=$6 AND t->>'attempt_id'=$7 AND t->>'attempt_generation'=$8)`,
        [
          context.scope.organisation_id,
          input.run_id,
          input.worker_principal_id,
          context.principal_id,
          input.package_generation,
          input.task_id,
          input.attempt_id,
          input.attempt_generation,
        ],
      )
    ).rows;
    if (effects.length !== 1)
      sourceFailure(
        "FLEET_ASSIGNMENT_REQUIRED",
        "A committed model-led manager assignment is required",
      );
    const effect = effects[0]!.result,
      assignment = effect.assignment,
      assigned = assignment.tasks.find(
        (item: Row) => item.task_id === input.task_id,
      );
    const ready = await readReadyFleetInstall(
      primary(tx),
      i,
      effect.install_binding,
    );
    if (
      assignment.assignment_id !== input.assignment_id ||
      assignment.leader_generation !== input.leader_generation ||
      assignment.delegation_id !== input.package_id ||
      assignment.source?.workspace_id !== input.workspace_id ||
      assignment.source?.scope?.organisation_id !==
        context.scope.organisation_id ||
      assignment.source?.scope?.repository_id !== context.scope.repository_id ||
      assignment.source?.scope?.security_domain_id !==
        context.scope.security_domain_id ||
      assignment.source?.revision_id !== source.revision_id ||
      assignment.source?.root_tree_id !== source.root_tree_id ||
      assignment.source?.source_manifest_digest !==
        ready.source_manifest_digest ||
      ready.source_backend !== "native" ||
      sourceDigest(ready.source_scope) !== sourceDigest(context.scope) ||
      ready.source_revision !== source.revision_id ||
      ready.root_tree_id !== source.root_tree_id ||
      ready.receipt_digest !== input.environment_digest ||
      ready.manifest_digest !== input.closure_digest ||
      assignment.source_revision !== source.revision_id ||
      assignment.package_digest !== input.closure_digest ||
      assignment.ready_receipt_digest !== input.environment_digest ||
      sourceDigest(assignmentPaths(assigned?.read_scope)) !==
        sourceDigest(read) ||
      sourceDigest(assignmentPaths(assigned?.write_scope)) !==
        sourceDigest(write)
    )
      sourceFailure(
        "FLEET_ASSIGNMENT_MISMATCH",
        "Native assignment differs from its admitted source, environment or task scope",
      );
    const token = computeToken({
      ...attempt,
      organisation_id: context.scope.organisation_id,
      run_id: input.run_id,
      task_id: input.task_id,
      attempt_id: input.attempt_id,
      attempt_generation: input.attempt_generation,
      run_authority_epoch: attempt.authority_epoch,
    });
    const authority = await assertCurrentCompute(primary(tx), token, {
      operation: "CHECKPOINT",
    });
    const proof = await loadProofObligations(primary(tx), {
      organisation_id: context.scope.organisation_id,
      run_id: input.run_id,
      task_id: input.task_id,
      spec_revision_id: authority.spec_revision_id,
      spec_generation: authority.spec_generation,
    });
    if (
      proof.policy.repository_id !== context.scope.repository_id ||
      proof.policy.source_object_id !== source.revision_id
    )
      sourceFailure(
        "FLEET_POLICY_MISMATCH",
        "Assignment source must match the exact accepted task proof baseline",
      );
    const sourceCredential = (
      await tx.query(
        "SELECT expires_at FROM hyperfide.source_principal_credentials WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND credential_id=$4 AND principal_id=$5 AND principal_kind='worker' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE",
        [
          ...sourceScopeValues(context.scope),
          input.worker_credential_id,
          input.worker_principal_id,
        ],
      )
    ).rows[0];
    const controlCredential = (
      await tx.query(
        "SELECT expires_at FROM hyperfide.identity_principals WHERE credential_id=$1 AND organisation_id=$2 AND run_id=$3 AND actor_id=$4 AND role='WORKER' AND state='ACTIVE' AND deployment_epoch=$5 AND attempt_id=$6 AND attempt_generation=$7 AND sandbox_id=$8 AND boot_generation=$9 AND expires_at>clock_timestamp() AND $10::text[] <@ allowed_actions FOR SHARE",
        [
          input.worker_credential_id,
          context.scope.organisation_id,
          input.run_id,
          input.worker_principal_id,
          attempt.authority_epoch,
          input.attempt_id,
          input.attempt_generation,
          attempt.sandbox_id,
          attempt.sandbox_boot_generation,
          WORKER_ACTIONS,
        ],
      )
    ).rows[0];
    const credential = controlCredential ?? sourceCredential;
    if (!credential)
      sourceFailure(
        "FLEET_WORKER_CREDENTIAL_REQUIRED",
        "An active source credential for the assigned worker is required",
      );
    const capability = randomUUID(),
      generation = "1",
      expiry = new Date(
        Math.min(
          Date.parse(context.expires_at),
          new Date(credential.expires_at).getTime(),
        ),
      ).toISOString();
    const workspace = {
      workspace_id: input.workspace_id,
      base_revision_id: source.revision_id,
      mode: input.mode,
      read_paths: read,
      write_paths: write,
      budgets: this.budgets,
    };
    await tx.query(
      `INSERT INTO hyperfide.source_workspaces(organisation_id,repository_id,security_domain_id,workspace_id,principal_id,authority_epoch,base_revision_id,root_tree_id,mode,read_paths,write_paths,budgets,open_request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        ...sourceScopeValues(context.scope),
        input.workspace_id,
        input.worker_principal_id,
        context.authority_epoch,
        source.revision_id,
        source.root_tree_id,
        input.mode,
        JSON.stringify(read),
        JSON.stringify(write),
        JSON.stringify(this.budgets),
        sourceDigest(workspace),
      ],
    );
    const binding = {
      workspace_id: input.workspace_id,
      generation,
      task_id: input.task_id,
      attempt_id: input.attempt_id,
      attempt_generation: input.attempt_generation,
    };
    await tx.query(
      `INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,managed_binding,expires_at) VALUES($1,$2,$3,$4,$5,$6,'worker',$7,$8,$9,$10,$11,$12)`,
      [
        ...sourceScopeValues(context.scope),
        capability,
        input.worker_principal_id,
        input.worker_credential_id,
        context.authority_epoch,
        context.policy_version,
        WORKER_ACTIONS,
        [""],
        binding,
        expiry,
      ],
    );
    const result: FleetSourceAssignment = {
      schema_version: 1,
      scope: context.scope,
      assignment_id: input.assignment_id,
      assignment_generation: generation,
      run_id: input.run_id,
      task_id: input.task_id,
      attempt_id: input.attempt_id,
      attempt_generation: input.attempt_generation,
      workspace_id: input.workspace_id,
      base_revision_id: source.revision_id,
      root_tree_id: source.root_tree_id,
      closure_digest: input.closure_digest,
      environment_digest: input.environment_digest,
      worker_principal_id: input.worker_principal_id,
      capability_id: capability,
      authority: {
        authority_epoch: context.authority_epoch,
        generation,
        policy_version: context.policy_version!,
        workspace: {
          workspace_id: input.workspace_id,
          workspace_generation: generation,
        },
        managed: {
          task_id: input.task_id,
          attempt_id: input.attempt_id,
          attempt_generation: input.attempt_generation,
        },
      },
      workspace: {
        workspace_generation: "1",
        scope_generation: "1",
        mode: input.mode,
        read_paths: read,
        write_paths: write,
        budgets: this.budgets,
      },
    };
    await tx.query(
      `INSERT INTO hyperfide.source_fleet_assignments(organisation_id,repository_id,security_domain_id,assignment_id,assignment_generation,run_id,task_id,attempt_id,attempt_generation,workspace_id,worker_principal_id,worker_credential_id,manager_principal_id,capability_id,run_authority_epoch,source_authority_epoch,sandbox_id,slot_id,sandbox_boot_generation,base_revision_id,closure_digest,environment_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        ...sourceScopeValues(context.scope),
        input.assignment_id,
        generation,
        input.run_id,
        input.task_id,
        input.attempt_id,
        input.attempt_generation,
        input.workspace_id,
        input.worker_principal_id,
        input.worker_credential_id,
        context.principal_id,
        capability,
        attempt.authority_epoch,
        context.authority_epoch,
        attempt.sandbox_id,
        attempt.slot_id,
        attempt.sandbox_boot_generation,
        source.revision_id,
        input.closure_digest,
        input.environment_digest,
        result,
      ],
    );
    return result;
  }
  async enrollWorker(
    tx: PrimaryTransaction,
    runner: InvocationContext,
    credentialId: string,
  ): Promise<FleetSourceAssignment | null> {
    assertPrimaryTransaction(tx);
    assertInvocation(runner);
    await runner.guard(tx);
    parseUUID(credentialId);
    if (runner.principal.role !== "RUNNER")
      sourceFailure(
        "FLEET_ENROLLMENT_DENIED",
        "Native source enrollment requires the bound runner",
      );
    const credential = (
      await tx.query(
        "SELECT * FROM hyperfide.identity_principals WHERE credential_id=$1 AND organisation_id=$2 AND run_id=$3 AND role='WORKER' AND state='ACTIVE' AND sandbox_id=$4 AND boot_id=$5 AND boot_generation=$6 AND deployment_epoch=$7 AND expires_at>clock_timestamp() FOR SHARE",
        [
          credentialId,
          runner.principal.organisation_id,
          runner.principal.run_id,
          runner.principal.sandbox_id,
          runner.principal.boot_id,
          runner.principal.boot_generation,
          runner.principal.deployment_epoch,
        ],
      )
    ).rows[0];
    if (!credential)
      sourceFailure(
        "FLEET_ENROLLMENT_DENIED",
        "Delegated worker credential differs from the current runner boot",
      );
    const effects = (
      await tx.query(
        "SELECT result FROM hyperfide.fleet_effect_receipts WHERE organisation_id=$1 AND run_id=$2 AND result->>'kind'='ASSIGN_WORKER' AND result->'assignment'->>'worker_id'=$3 AND EXISTS(SELECT 1 FROM jsonb_array_elements(result->'tasks') task WHERE task->>'attempt_id'=$4 AND task->>'attempt_generation'=$5)",
        [
          credential.organisation_id,
          credential.run_id,
          credential.actor_id,
          credential.attempt_id,
          String(credential.attempt_generation),
        ],
      )
    ).rows;
    if (effects.length !== 1)
      sourceFailure(
        "FLEET_ENROLLMENT_DENIED",
        "Exactly one committed manager assignment must own the worker",
      );
    const effect = effects[0]!.result,
      setup = effect.native_source_setup;
    if (setup === undefined) return null;
    if (
      !setup ||
      setup.action !== "source.fleet.assign" ||
      !setup.scope ||
      !setup.input ||
      effect.assignment?.schema_version !== 2
    )
      sourceFailure(
        "FLEET_ENROLLMENT_DENIED",
        "A versioned native source setup is required",
      );
    const scope = setup.scope as SourceScope,
      assignment = effect.assignment;
    if (
      scope.organisation_id !== credential.organisation_id ||
      assignment.worker_id !== credential.actor_id ||
      setup.input.attempt_id !== credential.attempt_id ||
      String(setup.input.attempt_generation) !==
        String(credential.attempt_generation)
    )
      sourceFailure(
        "FLEET_ENROLLMENT_DENIED",
        "Source setup differs from delegated worker custody",
      );
    const domain = (
      await tx.query(
        "SELECT authority_epoch::text,policy_version FROM hyperfide.source_authority_domains WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND enabled FOR SHARE",
        sourceScopeValues(scope),
      )
    ).rows[0];
    if (!domain)
      sourceFailure(
        "FLEET_ENROLLMENT_DENIED",
        "Native source authority is unavailable",
      );
    const assertCurrent = async (current: SourceSQL, action?: string) => {
      if (
        action !== undefined &&
        !["source.fleet.assign", "source.revisions.read"].includes(action)
      )
        sourceFailure(
          "SCOPE_DENIED",
          "Enrollment source authority is confined to its assigned workspace",
        );
      await runner.guard(current);
      await requireAuthority(primary(current), {
        organisation_id: credential.organisation_id,
        run_id: credential.run_id,
        session_id: assignment.manager_id,
        authority_epoch: runner.principal.deployment_epoch,
        leader_generation: assignment.leader_generation,
        package_id: assignment.delegation_id,
        package_generation: assignment.manager_generation,
        roles: ["FEATURE_MANAGER"],
      });
    };
    const context: SourceContext = {
      scope,
      principal_id: assignment.manager_id,
      authority_epoch: domain.authority_epoch,
      policy_version: domain.policy_version,
      expires_at: new Date(credential.expires_at).toISOString(),
      assertCurrent,
    };
    const digest = sourceDigest([
        "native-source-enrollment",
        assignment.assignment_id,
        credentialId,
      ]).slice(7),
      operation =
        digest.slice(0, 8) +
        "-" +
        digest.slice(8, 12) +
        "-4" +
        digest.slice(13, 16) +
        "-a" +
        digest.slice(17, 20) +
        "-" +
        digest.slice(20, 32);
    const input = {
      ...setup.input,
      worker_credential_id: credentialId,
      operation_id: operation,
      idempotency_key:
        "native-source-enrollment:" +
        assignment.assignment_id +
        ":" +
        credentialId,
    } as FleetSourceAssignmentInput;
    return this.mutateInTransaction(
      tx,
      context,
      "source.fleet.assign",
      input,
      (sql) => this.assignInTransaction(sql, context, input, runner, true),
    );
  }
  private async assignment(
    tx: SourceSQL,
    context: SourceContext,
    id: string,
  ): Promise<Row> {
    const row = (
      await tx.query(
        "SELECT * FROM hyperfide.source_fleet_assignments WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND assignment_id=$4 FOR SHARE",
        [...sourceScopeValues(context.scope), parseUUID(id)],
      )
    ).rows[0];
    if (!row)
      sourceFailure("NOT_FOUND", "Native fleet assignment is unavailable");
    if (
      (context.workspace &&
        context.workspace.workspace_id !== row.workspace_id) ||
      (context.principal_id !== row.worker_principal_id &&
        context.principal_id !== row.manager_principal_id)
    )
      sourceFailure(
        "SCOPE_DENIED",
        "Native fleet assignment belongs to another principal",
      );
    return row;
  }
  async read(
    context: SourceContext,
    id: string,
  ): Promise<FleetSourceAssignment> {
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.fleet.read");
      return (await this.assignment(tx, context, id)).result;
    });
  }
  async submit(
    context: SourceContext,
    input: FleetSourceSubmitInput,
    invocation?: InvocationContext,
  ): Promise<FleetSourceSubmission> {
    fields(input, [
      "operation_id",
      "idempotency_key",
      "assignment_id",
      "expected_assignment_generation",
      "expected_workspace_generation",
      "revision_id",
    ]);
    parseUUID(input.assignment_id);
    positive(input.expected_assignment_generation);
    positive(input.expected_workspace_generation);
    parseObjectId(input.revision_id);
    return this.mutate(context, "source.fleet.submit", input, async (tx) => {
      const row = await this.assignment(tx, context, input.assignment_id);
      if (
        context.principal_id !== row.worker_principal_id ||
        String(row.assignment_generation) !==
          input.expected_assignment_generation ||
        row.submission_id !== null
      )
        sourceFailure(
          "FLEET_ASSIGNMENT_STALE",
          "Only the exact current worker assignment may submit",
        );
      if (invocation) {
        const i = invocationFor(context, invocation, row.run_id);
        await i.guard(tx);
      }
      const p = primary(tx),
        token = computeToken(row),
        authority = await assertCurrentCompute(p, token, {
          operation: "ADVANCE",
        });
      const workspace = (
        await tx.query(
          "SELECT * FROM hyperfide.source_workspaces WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4 AND principal_id=$5 FOR UPDATE",
          [
            ...sourceScopeValues(context.scope),
            row.workspace_id,
            context.principal_id,
          ],
        )
      ).rows[0];
      if (
        !workspace ||
        workspace.closed_at !== null ||
        String(workspace.workspace_generation) !==
          input.expected_workspace_generation ||
        workspace.checkpoint_revision_id !== input.revision_id
      )
        sourceFailure(
          "FLEET_CHECKPOINT_MISMATCH",
          "Submission requires the exact durable checkpoint of this worker workspace",
        );
      const revisionContext: SourceContext = {
        ...context,
        ...(context.assertCurrent
          ? {
              assertCurrent: (sql: SourceSQL, action?: string) =>
                context.assertCurrent!(
                  sql,
                  action === "source.revisions.read"
                    ? "source.fleet.submit"
                    : action,
                ),
            }
          : {}),
      };
      const revision = await this.metadata.readRevisionInTransaction(
        tx,
        revisionContext,
        input.revision_id,
      );
      if (revision.root_tree_id !== workspace.root_tree_id)
        sourceFailure("FLEET_CHECKPOINT_MISMATCH", "Checkpoint tree changed");
      const packet = await loadExecutionPacket(p, {
          organisation_id: row.organisation_id,
          run_id: row.run_id,
          digest: authority.input_packet_digest,
        }),
        derived = deriveQualificationInputs(packet.packet);
      const registered = await loadProofObligations(tx, {
        organisation_id: row.organisation_id,
        run_id: row.run_id,
        task_id: row.task_id,
        spec_revision_id: authority.spec_revision_id,
        spec_generation: authority.spec_generation,
      });
      if (
        registered.criteria_digest !== authority.criteria_digest ||
        registered.policy.repository_id !== context.scope.repository_id ||
        registered.policy.source_object_id !== row.base_revision_id
      )
        sourceFailure(
          "FLEET_POLICY_MISMATCH",
          "Task proof policy must bind this native assignment baseline",
        );
      const dependencyRows=(packet.packet.mandatory as {inputs:{dependencies:CandidateExecutionDependency[]}}).inputs.dependencies;
      const dependencies=validateCandidateDependencies(dependencyRows.map(value=>({revision_id:value.source_object_id,execution_dependency:value})));
      if(nativeCandidateDependencyDigest(dependencies)!==derived.dependency_digest)sourceFailure("FLEET_DEPENDENCY_MISMATCH","Native dependency projection differs from the immutable execution packet");
      const inputs = {
        source: nativeCandidateSourceDigest(
          context.scope,
          input.revision_id,
          revision.root_tree_id,
        ),
        dependency: derived.dependency_digest,
        toolchain: derived.toolchain_digest,
        configuration: derived.configuration_digest,
        graph: derived.graph_digest,
        contract: derived.contract_digest,
      };
      const existing = (
        await tx.query(
          "SELECT current_native_custody_id,current_custody_id FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE",
          [row.organisation_id, row.run_id, row.task_id],
        )
      ).rows[0];
      if (
        !existing ||
        existing.current_native_custody_id !== null ||
        existing.current_custody_id !== null
      )
        sourceFailure(
          "FLEET_CUSTODY_CONFLICT",
          "Task already has coordinator submission custody",
        );
      const custody = randomUUID(),
        generation = String(row.attempt_generation);
      await this.metadata.protectRoot(
        tx,
        context.scope,
        revision.root_tree_id,
        "native-custody:" + custody + ":" + generation,
      );
      const resultBase = {
        schema_version: 1 as const,
        scope: context.scope,
        submission_id: custody,
        custody_id: custody,
        custody_generation: generation,
        assignment_id: row.assignment_id,
        run_id: row.run_id,
        task_id: row.task_id,
        attempt_id: row.attempt_id,
        attempt_generation: String(row.attempt_generation),
        revision_id: input.revision_id,
        root_tree_id: revision.root_tree_id,
        source_manifest_digest: inputs.source,
        input_manifest: inputs,
        dependencies,
        state: "SUBMITTED" as const,
      };
      const result: FleetSourceSubmission = {
        ...resultBase,
        result_digest: sourceDigest(resultBase),
      };
      await releaseCompute(p, token, { execution_state: "SUBMITTED" });
      await tx.query(
        `INSERT INTO hyperfide.source_native_custodies(organisation_id,repository_id,security_domain_id,custody_id,custody_generation,owner_principal_id,revision_id,root_tree_id,authority_epoch,run_id,task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          ...sourceScopeValues(context.scope),
          custody,
          generation,
          row.manager_principal_id,
          input.revision_id,
          revision.root_tree_id,
          context.authority_epoch,
          row.run_id,
          row.task_id,
        ],
      );
      await tx.query(
        `INSERT INTO hyperfide.source_fleet_submissions(organisation_id,repository_id,security_domain_id,custody_id,custody_generation,assignment_id,run_id,task_id,attempt_id,attempt_generation,revision_id,root_tree_id,run_authority_epoch,source_authority_epoch,spec_revision_id,spec_generation,criteria_digest,policy,input_manifest,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          ...sourceScopeValues(context.scope),
          custody,
          generation,
          row.assignment_id,
          row.run_id,
          row.task_id,
          row.attempt_id,
          row.attempt_generation,
          input.revision_id,
          revision.root_tree_id,
          row.run_authority_epoch,
          context.authority_epoch,
          authority.spec_revision_id,
          authority.spec_generation,
          authority.criteria_digest,
          registered.policy,
          inputs,
          result,
        ],
      );
      await tx.query(
        "UPDATE hyperfide.source_fleet_assignments SET submission_id=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND assignment_id=$4",
        [...sourceScopeValues(context.scope), row.assignment_id, custody],
      );
      await tx.query(
        "UPDATE hyperfide.tasks SET current_native_custody_id=$4,state='SUBMITTED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3",
        [row.organisation_id, row.run_id, row.task_id, custody],
      );
      return result;
    });
  }
  async submission(
    context: SourceContext,
    id: string,
  ): Promise<FleetSourceSubmission> {
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.fleet.submission");
      const row = (
        await tx.query(
          "SELECT s.result,a.workspace_id,a.worker_principal_id,a.manager_principal_id FROM hyperfide.source_fleet_submissions s JOIN hyperfide.source_fleet_assignments a USING(organisation_id,repository_id,security_domain_id,assignment_id) WHERE s.organisation_id=$1 AND s.repository_id=$2 AND s.security_domain_id=$3 AND s.custody_id=$4",
          [...sourceScopeValues(context.scope), parseUUID(id)],
        )
      ).rows[0];
      if (
        !row ||
        (context.workspace &&
          context.workspace.workspace_id !== row.workspace_id) ||
        (context.principal_id !== row.worker_principal_id &&
          context.principal_id !== row.manager_principal_id)
      )
        sourceFailure("NOT_FOUND", "Native fleet submission is unavailable");
      return row.result;
    });
  }
}

export interface FleetSourceSubmitInput {
  operation_id: string;
  idempotency_key: string;
  assignment_id: string;
  expected_assignment_generation: string;
  expected_workspace_generation: string;
  revision_id: string;
}

export interface FleetSourceSubmission {
  schema_version: 1;
  scope: SourceScope;
  submission_id: string;
  custody_id: string;
  custody_generation: string;
  assignment_id: string;
  run_id: string;
  task_id: string;
  attempt_id: string;
  attempt_generation: string;
  revision_id: string;
  root_tree_id: string;
  source_manifest_digest: string;
  dependencies: CandidateDependency[];
  input_manifest: Record<
    | "source"
    | "dependency"
    | "toolchain"
    | "configuration"
    | "graph"
    | "contract",
    string
  >;
  result_digest: string;
  state: "SUBMITTED";
}
