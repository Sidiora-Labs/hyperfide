import { randomUUID } from "node:crypto";
import {
  canonicalBytes,
  parseGeneration,
  parseObjectId,
  parseStrictJSON,
  parseUUID,
} from "../source_control/contracts.js";
import type { SourceScope } from "../source_control/contracts.js";
import {
  SourceMetadata,
  sourceDigest,
  sourceFailure,
  sourceScopeValues,
} from "../source_control/metadata.js";
import type { SourceContext, SourceSQL } from "../source_control/metadata.js";
import type { NativeCandidateRecord } from "../source_control/candidates.js";
import type { SourceCandidateEvidence } from "../source_control/evidence.js";
import { reserveSourceOperation } from "../source_control/operations.js";
import type { SourceObjectService } from "../source_control/objects.js";

interface Mutation {
  operation_id: string;
  idempotency_key: string;
}
export interface NativeCustodyInput extends Mutation {
  custody_id: string;
  custody_generation: string;
  revision_id: string;
  run_id?: string;
  task_id?: string;
}
export interface NativeEvidenceInput extends Mutation {
  candidate_id: string;
  check_id: string;
  receipt_object_id: string;
}
export interface NativeRevokeInput extends Mutation {
  evidence_id?: string;
  custody_id?: string;
}
export interface NativeCheckDefinition {
  id: string;
  argv: string[];
  executable_digest: string;
  environment_digest: string;
  required_artifacts: string[];
}
export interface NativeExecutionReceipt {
  schema_version: 1;
  source_kind: "NATIVE";
  candidate_id: string;
  candidate_manifest_digest: string;
  revision_id: string;
  root_tree_id: string;
  inputs: NativeCandidateRecord["inputs"];
  check_id: string;
  command: {
    argv: string[];
    cwd: ".";
    executable_digest: string;
    environment_digest: string;
    started_at: string;
    finished_at: string;
    exit_code: number;
    signal: string | null;
    timed_out: boolean;
    interrupted: boolean;
    output_truncated: boolean;
  };
  execution: {
    execution_id: string;
    source_revision_id: string;
    source_root_tree_id: string;
    input_digest: string;
    cleanup_complete: boolean;
    process_absent: boolean;
  };
  output: { stdout_object_id: string; stderr_object_id: string };
  artifacts: { path: string; object_id: string }[];
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    sourceFailure(
      "INVALID_EVIDENCE",
      "Native assurance fields differ from the versioned schema",
    );
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    sourceFailure("INVALID_EVIDENCE", "Bounded assurance text required");
  return value;
}
function date(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    sourceFailure("INVALID_EVIDENCE", "Canonical assurance timestamp required");
  return Date.parse(value);
}
function array(value: unknown, max = 256): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    sourceFailure("INVALID_EVIDENCE", "Bounded assurance list required");
  return value;
}
function checks(value: unknown): NativeCheckDefinition[] {
  const result = array(value, 64).map((raw) => {
    const check = object(raw, [
      "id",
      "argv",
      "executable_digest",
      "environment_digest",
      "required_artifacts",
    ]);
    const argv = array(check.argv, 64).map((v) => text(v, 4096));
    if (!argv.length)
      sourceFailure("INVALID_EVIDENCE", "Checker command required");
    const paths = array(check.required_artifacts, 64).map((v) => text(v, 4096));
    if (new Set(paths).size !== paths.length)
      sourceFailure("INVALID_EVIDENCE", "Duplicate checker artifacts");
    return {
      id: text(check.id),
      argv,
      executable_digest: parseObjectId(check.executable_digest),
      environment_digest: parseObjectId(check.environment_digest),
      required_artifacts: paths,
    };
  });
  if (
    !result.length ||
    new Set(result.map((item) => item.id)).size !== result.length
  )
    sourceFailure(
      "INVALID_EVIDENCE",
      "Distinct registered native checks required",
    );
  return result;
}
function receipt(value: unknown): NativeExecutionReceipt {
  const r = object(value, [
    "schema_version",
    "source_kind",
    "candidate_id",
    "candidate_manifest_digest",
    "revision_id",
    "root_tree_id",
    "inputs",
    "check_id",
    "command",
    "execution",
    "output",
    "artifacts",
  ]);
  if (r.schema_version !== 1 || r.source_kind !== "NATIVE")
    sourceFailure(
      "INVALID_EVIDENCE",
      "Native execution receipt version required",
    );
  parseUUID(r.candidate_id, "candidate_id");
  parseObjectId(r.candidate_manifest_digest);
  parseObjectId(r.revision_id);
  parseObjectId(r.root_tree_id);
  text(r.check_id);
  const inputs = object(r.inputs, [
    "source",
    "dependency",
    "toolchain",
    "configuration",
    "graph",
    "contract",
  ]);
  Object.values(inputs).forEach(parseObjectId);
  const command = object(r.command, [
    "argv",
    "cwd",
    "executable_digest",
    "environment_digest",
    "started_at",
    "finished_at",
    "exit_code",
    "signal",
    "timed_out",
    "interrupted",
    "output_truncated",
  ]);
  const argv = array(command.argv, 64);
  if (!argv.length)
    sourceFailure("INVALID_EVIDENCE", "Executed command required");
  argv.forEach((v) => text(v, 4096));
  if (
    command.cwd !== "." ||
    !Number.isInteger(command.exit_code) ||
    Number(command.exit_code) < 0 ||
    Number(command.exit_code) > 255 ||
    (command.signal !== null &&
      (typeof command.signal !== "string" || command.signal.length > 64))
  )
    sourceFailure(
      "INVALID_EVIDENCE",
      "Explicit bounded execution outcome required",
    );
  for (const key of ["timed_out", "interrupted", "output_truncated"])
    if (typeof command[key] !== "boolean")
      sourceFailure("INVALID_EVIDENCE", "Execution completion flags required");
  parseObjectId(command.executable_digest);
  parseObjectId(command.environment_digest);
  const start = date(command.started_at),
    end = date(command.finished_at);
  if (end < start || end - start > 86400000)
    sourceFailure("INVALID_EVIDENCE", "Execution interval is invalid");
  const execution = object(r.execution, [
    "execution_id",
    "source_revision_id",
    "source_root_tree_id",
    "input_digest",
    "cleanup_complete",
    "process_absent",
  ]);
  parseUUID(execution.execution_id, "execution_id");
  parseObjectId(execution.source_revision_id);
  parseObjectId(execution.source_root_tree_id);
  parseObjectId(execution.input_digest);
  if (
    typeof execution.cleanup_complete !== "boolean" ||
    typeof execution.process_absent !== "boolean"
  )
    sourceFailure(
      "INVALID_EVIDENCE",
      "Execution cleanup observations required",
    );
  const output = object(r.output, ["stdout_object_id", "stderr_object_id"]);
  parseObjectId(output.stdout_object_id);
  parseObjectId(output.stderr_object_id);
  const artifacts = array(r.artifacts, 64).map((v) => {
    const a = object(v, ["path", "object_id"]);
    return { path: text(a.path, 4096), object_id: parseObjectId(a.object_id) };
  });
  if (new Set(artifacts.map((a) => a.path)).size !== artifacts.length)
    sourceFailure("INVALID_EVIDENCE", "Duplicate execution artifacts");
  return r as unknown as NativeExecutionReceipt;
}
export class NativeSourceEvidenceVerifier {
  protected async policy(
    tx: SourceSQL,
    context: SourceContext,
    candidate: NativeCandidateRecord,
  ): Promise<{ checks: NativeCheckDefinition[]; checks_digest: string }> {
    const row = (
      await tx.query(
        "SELECT * FROM hyperfide.source_native_assurance_policies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND policy_id=$4 AND policy_digest=$5 AND authority_epoch=$6 AND policy_version=$7 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE",
        [
          ...sourceScopeValues(context.scope),
          candidate.policy_id,
          candidate.policy_digest,
          context.authority_epoch,
          context.policy_version,
        ],
      )
    ).rows[0];
    if (!row)
      sourceFailure(
        "EVIDENCE_POLICY_STALE",
        "Native evidence policy is unavailable or changed",
      );
    const list = checks(row.checks);
    return { checks: list, checks_digest: sourceDigest(list) };
  }
  protected async checker(
    tx: SourceSQL,
    context: SourceContext,
    candidate: NativeCandidateRecord,
    checkId: string,
    principal: string,
    credential?: string,
    validAt?: string,
  ): Promise<{ credential_id: string; credential_version: string }> {
    const rows = (
      await tx.query(
        `SELECT k.credential_id,c.credential_version::text FROM hyperfide.source_native_assurance_checkers k JOIN hyperfide.source_principal_credentials c ON c.organisation_id=k.organisation_id AND c.repository_id=k.repository_id AND c.security_domain_id=k.security_domain_id AND c.credential_id=k.credential_id AND c.principal_id=k.principal_id
   WHERE k.organisation_id=$1 AND k.repository_id=$2 AND k.security_domain_id=$3 AND k.policy_id=$4 AND k.check_id=$5 AND k.principal_id=$6 AND ($7::uuid IS NULL OR k.credential_id=$7) AND k.revoked_at IS NULL AND k.expires_at>COALESCE($8::timestamptz,clock_timestamp()) AND c.revoked_at IS NULL AND c.expires_at>COALESCE($8::timestamptz,clock_timestamp()) FOR SHARE OF k,c`,
        [
          ...sourceScopeValues(context.scope),
          candidate.policy_id,
          checkId,
          principal,
          credential ?? null,
          validAt ?? null,
        ],
      )
    ).rows;
    if (rows.length !== 1)
      sourceFailure(
        "CHECKER_NOT_AUTHORIZED",
        "Current explicitly registered independent checker required",
      );
    return rows[0] as { credential_id: string; credential_version: string };
  }
  protected async custody(
    tx: SourceSQL,
    context: SourceContext,
    candidate: NativeCandidateRecord,
    checker?: string,
  ): Promise<void> {
    for (const contributor of candidate.contributors) {
      const row = (
        await tx.query(
          "SELECT * FROM hyperfide.source_native_custodies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND custody_id=$4 AND custody_generation=$5 AND revision_id=$6 AND authority_epoch=$7 AND revoked_at IS NULL FOR SHARE",
          [
            ...sourceScopeValues(context.scope),
            contributor.custody_id,
            contributor.custody_generation,
            contributor.revision_id,
            context.authority_epoch,
          ],
        )
      ).rows[0];
      if (
        !row ||
        (row.run_id ?? undefined) !== contributor.run_id ||
        (row.task_id ?? undefined) !== contributor.task_id
      )
        sourceFailure(
          "CUSTODY_STALE",
          "Exact current native contributor custody required",
        );
      if (
        checker !== undefined &&
        (row.owner_principal_id === checker ||
          candidate.created_by_principal_id === checker)
      )
        sourceFailure(
          "CHECKER_NOT_INDEPENDENT",
          "Source authors cannot certify their own candidate",
        );
      if (row.run_id !== null) await this.managedCustody(tx, context, row);
    }
  }
  protected async managedCustody(
    tx: SourceSQL,
    context: SourceContext,
    row: Record<string, any>,
  ): Promise<void> {
    const available = (
      await tx.query(
        "SELECT to_regclass('hyperfide.source_fleet_submissions') IS NOT NULL AS native_present, to_regclass('hyperfide.submission_custodies') IS NOT NULL AS legacy_present",
      )
    ).rows[0];
    if (available?.native_present) {
      const native = (
        await tx.query(
          `SELECT 1 FROM hyperfide.source_fleet_submissions c
         JOIN hyperfide.tasks t ON t.organisation_id=c.organisation_id AND t.run_id=c.run_id AND t.id=c.task_id
         JOIN hyperfide.runs r ON r.organisation_id=c.organisation_id AND r.id=c.run_id
         WHERE c.organisation_id=$1 AND c.repository_id=$2 AND c.security_domain_id=$3 AND c.run_id=$4 AND c.task_id=$5
         AND c.custody_id=$6 AND c.custody_generation=$7 AND c.revision_id=$8 AND c.root_tree_id=$9
         AND c.authority='ACTIVE' AND t.current_native_custody_id=c.custody_id
         AND c.run_authority_epoch=r.authority_epoch AND c.source_authority_epoch=$10
         AND c.spec_revision_id=t.spec_revision_id AND c.spec_generation=t.spec_generation AND c.criteria_digest=t.criteria_digest
         FOR SHARE OF c,t,r`,
          [
            ...sourceScopeValues(context.scope),
            row.run_id,
            row.task_id,
            row.custody_id,
            row.custody_generation,
            row.revision_id,
            row.root_tree_id,
            context.authority_epoch,
          ],
        )
      ).rows[0];
      if (native) return;
    }
    if (available?.legacy_present) {
      const legacy = (
        await tx.query(
          `SELECT 1 FROM hyperfide.submission_custodies c JOIN hyperfide.tasks t ON t.organisation_id=c.organisation_id AND t.run_id=c.run_id AND t.id=c.task_id JOIN hyperfide.runs r ON r.organisation_id=c.organisation_id AND r.id=c.run_id
         WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.task_id=$3 AND c.id=$4 AND c.custody_generation=$5 AND c.source_object_id=$6 AND c.authority='ACTIVE' AND t.current_custody_id=c.id AND c.authority_epoch=r.authority_epoch FOR SHARE OF c,t,r`,
          [
            context.scope.organisation_id,
            row.run_id,
            row.task_id,
            row.custody_id,
            row.custody_generation,
            row.revision_id,
          ],
        )
      ).rows[0];
      if (legacy) return;
    }
    sourceFailure(
      "CUSTODY_STALE",
      "Managed custody does not bind the current native revision and accepted task",
    );
  }
  async verifyEvidence(
    tx: SourceSQL,
    context: SourceContext,
    candidate: NativeCandidateRecord,
    evidenceIds: readonly string[],
  ): Promise<SourceCandidateEvidence> {
    if (
      !evidenceIds.length ||
      evidenceIds.length > 256 ||
      new Set(evidenceIds).size !== evidenceIds.length
    )
      sourceFailure("INVALID_EVIDENCE", "Distinct native evidence required");
    evidenceIds.forEach((id) => parseUUID(id, "evidence_id"));
    const policy = await this.policy(tx, context, candidate);
    await this.custody(tx, context, candidate);
    const found = (
      await tx.query(
        "SELECT * FROM hyperfide.source_native_assurance_evidence WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND evidence_id=ANY($4::uuid[]) ORDER BY evidence_id FOR SHARE",
        [...sourceScopeValues(context.scope), [...evidenceIds]],
      )
    ).rows;
    if (found.length !== evidenceIds.length)
      sourceFailure("EVIDENCE_INCOMPLETE", "Native evidence is missing");
    const seen = new Set<string>();
    for (const row of found) {
      if (
        row.candidate_id !== candidate.candidate_id ||
        row.manifest_digest !== candidate.manifest_digest ||
        row.policy_id !== candidate.policy_id ||
        row.policy_digest !== candidate.policy_digest ||
        row.checks_digest !== policy.checks_digest ||
        row.outcome !== "PASS" ||
        row.revoked_at !== null ||
        seen.has(row.check_id) ||
        !policy.checks.some((check) => check.id === row.check_id)
      )
        sourceFailure(
          "EVIDENCE_BINDING_MISMATCH",
          "Evidence is failed, revoked, duplicate or belongs to other source inputs",
        );
      const checker = await this.checker(
        tx,
        context,
        candidate,
        row.check_id,
        row.checker_principal_id,
        row.checker_credential_id,
        new Date(row.created_at).toISOString(),
      );
      if (checker.credential_version !== String(row.checker_credential_version))
        sourceFailure(
          "CHECKER_NOT_AUTHORIZED",
          "Checker credential version changed",
        );
      await this.custody(tx, context, candidate, row.checker_principal_id);
      seen.add(row.check_id);
      if (sourceDigest(row.receipt) !== row.receipt_digest)
        sourceFailure(
          "EVIDENCE_BINDING_MISMATCH",
          "Immutable execution receipt digest differs",
        );
      const stored = receipt(row.receipt),
        ids = [
          row.receipt_object_id,
          stored.output.stdout_object_id,
          stored.output.stderr_object_id,
          ...stored.artifacts.map((a) => a.object_id),
        ];
      for (let index = 0; index < ids.length; index++) {
        const pinned = (
          await tx.query(
            `SELECT 1 FROM hyperfide.source_object_pins p JOIN hyperfide.source_object_placements s ON s.organisation_id=p.organisation_id AND s.repository_id=p.repository_id AND s.security_domain_id=p.security_domain_id AND s.object_id=p.object_id AND s.incarnation_id=p.incarnation_id WHERE p.organisation_id=$1 AND p.repository_id=$2 AND p.security_domain_id=$3 AND p.owner_kind='HOLD' AND p.owner_id=$4 AND p.position=$5 AND p.object_id=$6 AND s.state='VERIFIED' FOR SHARE OF p,s`,
            [
              ...sourceScopeValues(context.scope),
              "native-evidence:" + row.evidence_id,
              index,
              ids[index],
            ],
          )
        ).rows[0];
        if (!pinned)
          sourceFailure(
            "EVIDENCE_OBJECT_UNAVAILABLE",
            "Retained execution evidence is unavailable",
          );
      }
    }
    if (policy.checks.some((check) => !seen.has(check.id)))
      sourceFailure(
        "EVIDENCE_INCOMPLETE",
        "All registered native checks must pass",
      );
    return {
      schema_version: 1,
      candidate_id: candidate.candidate_id,
      manifest_digest: candidate.manifest_digest,
      policy_id: candidate.policy_id,
      policy_digest: candidate.policy_digest,
      evidence_ids: [...evidenceIds],
      evidence_digest: sourceDigest(
        found.map((row) => [
          row.evidence_id,
          row.receipt_digest,
          row.checker_principal_id,
          row.checker_credential_id,
          row.checks_digest,
        ]),
      ),
    };
  }
}

export class NativeSourceAssurance extends NativeSourceEvidenceVerifier {
  constructor(
    readonly metadata: SourceMetadata,
    readonly objects: SourceObjectService,
  ) {
    super();
  }
  private async mutate<T>(
    context: SourceContext,
    action: string,
    input: Mutation,
    body: (tx: SourceSQL) => Promise<T>,
  ): Promise<T> {
    parseUUID(input.operation_id, "operation_id");
    if (
      typeof input.idempotency_key !== "string" ||
      !input.idempotency_key.length ||
      input.idempotency_key.length > 256
    )
      sourceFailure("INVALID_REQUEST", "Bounded operation identity required");
    const {
      operation_id: _operation,
      idempotency_key: _key,
      ...semantic
    } = input;
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, action);
      const op = await reserveSourceOperation(tx, context, {
        operation_id: input.operation_id,
        idempotency_key: input.idempotency_key,
        action,
        request_digest: sourceDigest(semantic),
      });
      if (op.state === "COMMITTED") return op.result as T;
      if (op.state !== "PENDING")
        sourceFailure("OPERATION_CANCELLED", "Assurance operation is terminal");
      const result = await body(tx);
      await tx.query(
        "UPDATE hyperfide.source_metadata_operations SET state='COMMITTED',result=$6,result_digest=$7,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5",
        [
          ...sourceScopeValues(context.scope),
          context.principal_id,
          op.operation_id,
          result,
          sourceDigest(result),
        ],
      );
      return result;
    });
  }
  private async candidate(
    tx: SourceSQL,
    context: SourceContext,
    id: string,
  ): Promise<NativeCandidateRecord> {
    const row = (
      await tx.query(
        "SELECT manifest FROM hyperfide.source_native_candidates WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND candidate_id=$4",
        [...sourceScopeValues(context.scope), id],
      )
    ).rows[0];
    if (!row) sourceFailure("NOT_FOUND", "Native candidate is unavailable");
    return row.manifest as NativeCandidateRecord;
  }
  private async pin(
    tx: SourceSQL,
    scope: SourceScope,
    objectId: string,
    owner: string,
    position: number,
  ): Promise<void> {
    const row = (
      await tx.query(
        `SELECT o.current_incarnation FROM hyperfide.source_native_objects o JOIN hyperfide.source_object_placements p ON p.organisation_id=o.organisation_id AND p.repository_id=o.repository_id AND p.security_domain_id=o.security_domain_id AND p.object_id=o.object_id AND p.incarnation_id=o.current_incarnation WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.object_id=$4 AND o.state='VERIFIED' AND p.state='VERIFIED' FOR SHARE OF o,p`,
        [...sourceScopeValues(scope), objectId],
      )
    ).rows[0];
    if (!row)
      sourceFailure(
        "EVIDENCE_OBJECT_UNAVAILABLE",
        "A verified immutable evidence object is required",
      );
    await tx.query(
      "INSERT INTO hyperfide.source_object_pins(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,owner_kind,owner_id,position) VALUES($1,$2,$3,$4,$5,'HOLD',$6,$7) ON CONFLICT DO NOTHING",
      [
        ...sourceScopeValues(scope),
        objectId,
        row.current_incarnation,
        owner,
        position,
      ],
    );
  }
  async registerCustody(
    context: SourceContext,
    input: NativeCustodyInput,
  ): Promise<unknown> {
    object(
      input,
      [
        "operation_id",
        "idempotency_key",
        "custody_id",
        "custody_generation",
        "revision_id",
      ],
      ["run_id", "task_id"],
    );
    parseUUID(input.custody_id, "custody_id");
    parseObjectId(input.revision_id);
    parseGeneration(input.custody_generation);
    if (
      BigInt(input.custody_generation) < 1n ||
      BigInt(input.custody_generation) > 9223372036854775807n ||
      (input.run_id === undefined) !== (input.task_id === undefined)
    )
      sourceFailure(
        "INVALID_REQUEST",
        "Positive custody generation and paired managed identities required",
      );
    if (input.run_id !== undefined) {
      parseUUID(input.run_id, "run_id");
      parseUUID(input.task_id, "task_id");
    }
    return this.mutate(
      context,
      "source.assurance.custody.create",
      input,
      async (tx) => {
        const revision = await this.metadata.readRevisionInTransaction(
          tx,
          context,
          input.revision_id,
        );
        const row = {
          custody_id: input.custody_id,
          custody_generation: input.custody_generation,
          revision_id: input.revision_id,
          root_tree_id: revision.root_tree_id,
          run_id: input.run_id ?? null,
          task_id: input.task_id ?? null,
        };
        if (input.run_id !== undefined)
          await this.managedCustody(tx, context, row);
        await this.metadata.protectRoot(
          tx,
          context.scope,
          revision.root_tree_id,
          "native-custody:" + input.custody_id + ":" + input.custody_generation,
        );
        await tx.query(
          "INSERT INTO hyperfide.source_native_custodies(organisation_id,repository_id,security_domain_id,custody_id,custody_generation,owner_principal_id,revision_id,root_tree_id,authority_epoch,run_id,task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING",
          [
            ...sourceScopeValues(context.scope),
            input.custody_id,
            input.custody_generation,
            context.principal_id,
            input.revision_id,
            revision.root_tree_id,
            context.authority_epoch,
            input.run_id ?? null,
            input.task_id ?? null,
          ],
        );
        const retained = (
          await tx.query(
            "SELECT * FROM hyperfide.source_native_custodies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND custody_id=$4 FOR SHARE",
            [...sourceScopeValues(context.scope), input.custody_id],
          )
        ).rows[0];
        if (
          !retained ||
          retained.owner_principal_id !== context.principal_id ||
          String(retained.custody_generation) !== input.custody_generation ||
          retained.revision_id !== input.revision_id ||
          retained.root_tree_id !== revision.root_tree_id ||
          retained.run_id !== (input.run_id ?? null) ||
          retained.task_id !== (input.task_id ?? null) ||
          String(retained.authority_epoch) !== context.authority_epoch ||
          retained.revoked_at !== null
        )
          sourceFailure(
            "CUSTODY_CONFLICT",
            "Custody identity already binds another native source",
          );
        return {
          schema_version: 1,
          scope: context.scope,
          ...row,
          authority_epoch: context.authority_epoch,
        };
      },
    );
  }
  async publish(
    context: SourceContext,
    input: NativeEvidenceInput,
  ): Promise<unknown> {
    object(input, [
      "operation_id",
      "idempotency_key",
      "candidate_id",
      "check_id",
      "receipt_object_id",
    ]);
    parseUUID(input.candidate_id, "candidate_id");
    text(input.check_id);
    parseObjectId(input.receipt_object_id);
    await this.metadata.transaction((tx) =>
      this.metadata.guard(tx, context, "source.assurance.publish"),
    );
    const stored = await this.objects.read(
      context.scope,
      input.receipt_object_id,
    );
    if (stored.kind !== "blob" || stored.payload.length > 1048576)
      sourceFailure(
        "INVALID_EVIDENCE",
        "Execution receipt requires a bounded JSON blob",
      );
    const observed = receipt(parseStrictJSON(stored.payload, 1048576));
    return this.mutate(
      context,
      "source.assurance.publish",
      input,
      async (tx) => {
        const candidate = await this.candidate(tx, context, input.candidate_id),
          policy = await this.policy(tx, context, candidate);
        const check = policy.checks.find((item) => item.id === input.check_id);
        if (!check)
          sourceFailure(
            "EVIDENCE_POLICY_STALE",
            "Execution check is not in current policy",
          );
        if (!context.capability_id)
          sourceFailure(
            "CHECKER_NOT_AUTHORIZED",
            "Authenticated checker capability required",
          );
        const capability = (
          await tx.query(
            "SELECT credential_id FROM hyperfide.source_capabilities WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND id=$4 AND principal_id=$5 FOR SHARE",
            [
              ...sourceScopeValues(context.scope),
              context.capability_id,
              context.principal_id,
            ],
          )
        ).rows[0];
        if (!capability)
          sourceFailure(
            "CHECKER_NOT_AUTHORIZED",
            "Authenticated checker credential required",
          );
        const checker = await this.checker(
          tx,
          context,
          candidate,
          input.check_id,
          context.principal_id,
          capability.credential_id,
        );
        await this.custody(tx, context, candidate, context.principal_id);
        if (
          observed.candidate_id !== candidate.candidate_id ||
          observed.candidate_manifest_digest !== candidate.manifest_digest ||
          observed.revision_id !== candidate.revision_id ||
          observed.root_tree_id !== candidate.root_tree_id ||
          sourceDigest(observed.inputs) !== sourceDigest(candidate.inputs) ||
          observed.check_id !== check.id ||
          observed.execution.source_revision_id !== candidate.revision_id ||
          observed.execution.source_root_tree_id !== candidate.root_tree_id ||
          observed.execution.input_digest !== sourceDigest(candidate.inputs)
        )
          sourceFailure(
            "EVIDENCE_BINDING_MISMATCH",
            "Execution does not bind the exact native candidate and inputs",
          );
        if (
          sourceDigest(observed.command.argv) !== sourceDigest(check.argv) ||
          observed.command.executable_digest !== check.executable_digest ||
          observed.command.environment_digest !== check.environment_digest ||
          sourceDigest(observed.artifacts.map((a) => a.path)) !==
            sourceDigest(check.required_artifacts)
        )
          sourceFailure(
            "EVIDENCE_BINDING_MISMATCH",
            "Execution differs from its registered command or required artifacts",
          );
        const prior = (
          await tx.query(
            "SELECT evidence_id,receipt_object_id,outcome FROM hyperfide.source_native_assurance_evidence WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND checker_principal_id=$4 AND execution_id=$5 FOR SHARE",
            [
              ...sourceScopeValues(context.scope),
              context.principal_id,
              observed.execution.execution_id,
            ],
          )
        ).rows[0];
        if (prior) {
          if (prior.receipt_object_id !== input.receipt_object_id)
            sourceFailure(
              "IDEMPOTENCY_CONFLICT",
              "Execution identity already binds another receipt",
            );
          return {
            schema_version: 1,
            evidence_id: prior.evidence_id,
            candidate_id: candidate.candidate_id,
            receipt_object_id: input.receipt_object_id,
            outcome: prior.outcome,
          };
        }
        const evidenceId = randomUUID(),
          ids = [
            input.receipt_object_id,
            observed.output.stdout_object_id,
            observed.output.stderr_object_id,
            ...observed.artifacts.map((a) => a.object_id),
          ];
        for (let index = 0; index < ids.length; index++)
          await this.pin(
            tx,
            context.scope,
            ids[index]!,
            "native-evidence:" + evidenceId,
            index,
          );
        const pass =
          observed.command.exit_code === 0 &&
          observed.command.signal === null &&
          !observed.command.timed_out &&
          !observed.command.interrupted &&
          !observed.command.output_truncated &&
          observed.execution.cleanup_complete &&
          observed.execution.process_absent;
        await tx.query(
          "INSERT INTO hyperfide.source_native_assurance_evidence(organisation_id,repository_id,security_domain_id,evidence_id,candidate_id,manifest_digest,policy_id,policy_digest,checks_digest,check_id,checker_principal_id,checker_credential_id,checker_credential_version,execution_id,receipt_object_id,receipt_digest,receipt,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
          [
            ...sourceScopeValues(context.scope),
            evidenceId,
            candidate.candidate_id,
            candidate.manifest_digest,
            candidate.policy_id,
            candidate.policy_digest,
            policy.checks_digest,
            check.id,
            context.principal_id,
            checker.credential_id,
            checker.credential_version,
            observed.execution.execution_id,
            input.receipt_object_id,
            sourceDigest(observed),
            observed,
            pass ? "PASS" : "FAIL",
          ],
        );
        return {
          schema_version: 1,
          evidence_id: evidenceId,
          candidate_id: candidate.candidate_id,
          receipt_object_id: input.receipt_object_id,
          outcome: pass ? "PASS" : "FAIL",
        };
      },
    );
  }
  async revoke(
    context: SourceContext,
    input: NativeRevokeInput,
  ): Promise<unknown> {
    object(
      input,
      ["operation_id", "idempotency_key"],
      ["evidence_id", "custody_id"],
    );
    if ((input.evidence_id === undefined) === (input.custody_id === undefined))
      sourceFailure(
        "INVALID_REQUEST",
        "Exactly one native assurance target required",
      );
    const id = parseUUID(input.evidence_id ?? input.custody_id, "assurance_id");
    return this.mutate(
      context,
      "source.assurance.revoke",
      input,
      async (tx) => {
        const table = input.evidence_id
            ? "source_native_assurance_evidence"
            : "source_native_custodies",
          key = input.evidence_id ? "evidence_id" : "custody_id",
          owner = input.evidence_id
            ? "checker_principal_id"
            : "owner_principal_id";
        const row = (
          await tx.query(
            `SELECT ${owner} AS owner FROM hyperfide.${table} WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND ${key}=$4 FOR UPDATE`,
            [...sourceScopeValues(context.scope), id],
          )
        ).rows[0];
        if (!row || row.owner !== context.principal_id)
          sourceFailure(
            "SCOPE_DENIED",
            "Only the current assurance owner may revoke its retained record",
          );
        await tx.query(
          `UPDATE hyperfide.${table} SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND ${key}=$4`,
          [...sourceScopeValues(context.scope), id],
        );
        return { schema_version: 1, id, revoked: true };
      },
    );
  }
}
