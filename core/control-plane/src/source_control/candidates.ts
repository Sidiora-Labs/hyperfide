import { randomUUID } from "node:crypto";
import {
  canonicalBytes,
  parseGeneration,
  parseObjectId,
  parseUUID,
} from "./contracts.js";
import type { SourceScope } from "./contracts.js";
import {
  SourceMetadata,
  sourceDigest,
  sourceFailure,
  sourceScopeValues,
} from "./metadata.js";
import type { SourceContext, SourceSQL } from "./metadata.js";
import { reserveSourceOperation } from "./operations.js";
import { evidenceIds, verifyCandidateEvidence } from "./evidence.js";
import type {
  SourceCandidateEvidence,
  SourceCandidateEvidenceVerifier,
} from "./evidence.js";

export interface CandidateMutation {
  operation_id: string;
  idempotency_key: string;
}
export interface CandidateInputs {
  source: string;
  dependency: string;
  toolchain: string;
  configuration: string;
  graph: string;
  contract: string;
}
export interface CandidateContributor {
  revision_id: string;
  change_id: string;
  custody_id: string;
  custody_generation: string;
  run_id?: string;
  task_id?: string;
}
export interface CandidateDependency {
  revision_id: string;
  execution_dependency?: CandidateExecutionDependency;
}
export interface CandidateExecutionDependency {
  predecessor_run_id: string;
  predecessor_task_id: string;
  milestone: "QUALIFIED" | "INTEGRATED";
  state: "QUALIFIED" | "INTEGRATING" | "INTEGRATED";
  current_custody_id: string;
  repository_id: string;
  source_object_id: string;
  custody_generation: string;
  authority: "ACTIVE";
  qualification_outcome: "PASS";
  source_backend: "native";
  security_domain_id: string;
  qualification_id: string;
}
export interface CreateDomainInput extends CandidateMutation {
  domain_id: string;
  revision_id: string;
  policy_id: string;
  policy_digest: string;
}
export interface ConfigureDomainInput extends CandidateMutation {
  domain_id: string;
  expected_generation: string;
  policy_id: string;
  policy_digest: string;
}
export interface CreateCandidateInput extends CandidateMutation {
  candidate_id: string;
  domain_id: string;
  expected_generation: string;
  expected_revision_id: string;
  revision_id: string;
  contributors: CandidateContributor[];
  dependencies: CandidateDependency[];
  inputs: CandidateInputs;
  transformation_version: string;
}
export interface NativeIntegrationDomain {
  schema_version: 1;
  scope: SourceScope;
  domain_id: string;
  generation: string;
  revision_id: string;
  root_tree_id: string;
  authority_epoch: string;
  policy_id: string;
  policy_digest: string;
}
export interface NativeCandidateRecord {
  schema_version: 1;
  scope: SourceScope;
  candidate_id: string;
  domain_id: string;
  expected_generation: string;
  expected_revision_id: string;
  revision_id: string;
  root_tree_id: string;
  created_by_principal_id: string;
  authority_epoch: string;
  policy_id: string;
  policy_digest: string;
  contributors: CandidateContributor[];
  dependencies: CandidateDependency[];
  inputs: CandidateInputs;
  transformation_version: string;
  manifest_digest: string;
}
export interface CandidateQualification {
  schema_version: 1;
  scope: SourceScope;
  qualification_id: string;
  candidate_id: string;
  manifest_digest: string;
  authority_epoch: string;
  policy_id: string;
  policy_digest: string;
  evidence: SourceCandidateEvidence;
}
export const candidateScope = (context: SourceContext): string[] =>
  sourceScopeValues(context.scope);
function shape(
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
      "INVALID_REQUEST",
      "Candidate fields differ from the versioned schema",
    );
  return value as Record<string, unknown>;
}
export function positiveGeneration(value: string): string {
  parseGeneration(value);
  if (BigInt(value) < 1n || BigInt(value) > 9223372036854775807n)
    sourceFailure(
      "INVALID_REQUEST",
      "A positive PostgreSQL generation is required",
    );
  return value;
}
function operation(input: CandidateMutation): void {
  parseUUID(input.operation_id, "operation_id");
  if (
    typeof input.idempotency_key !== "string" ||
    !input.idempotency_key.length ||
    Buffer.byteLength(input.idempotency_key) > 256
  )
    sourceFailure("INVALID_REQUEST", "A bounded idempotency key is required");
}
export function nativeCandidateSourceDigest(
  scope: SourceScope,
  revisionId: string,
  treeId: string,
): string {
  return sourceDigest({ scope, revision_id: revisionId, root_tree_id: treeId });
}
export function nativeCandidateDependencyDigest(
  dependencies: readonly CandidateDependency[],
): string {
  return sourceDigest(dependencies.map(value=>value.execution_dependency??value));
}
export function validateCandidateDependencies(input: readonly CandidateDependency[]): CandidateDependency[] {
  const dependencies=input.map(value=>{
    shape(value, ["revision_id", ...(value.execution_dependency===undefined?[]:["execution_dependency"])]);
    parseObjectId(value.revision_id);
    if(value.execution_dependency===undefined)return {...value};
    const record=value.execution_dependency;
    shape(record,["predecessor_run_id","predecessor_task_id","milestone","state","current_custody_id","repository_id","source_object_id","custody_generation","authority","qualification_outcome","source_backend","security_domain_id","qualification_id"]);
    for(const key of ["predecessor_run_id","predecessor_task_id","current_custody_id","repository_id","security_domain_id"] as const)parseUUID(record[key]);
    parseObjectId(record.source_object_id);parseObjectId(record.qualification_id);
    positiveGeneration(record.custody_generation);
    if(!["QUALIFIED","INTEGRATED"].includes(record.milestone)||!["QUALIFIED","INTEGRATING","INTEGRATED"].includes(record.state)||record.authority!=="ACTIVE"||record.qualification_outcome!=="PASS"||record.source_backend!=="native"||record.source_object_id!==value.revision_id)sourceFailure("INVALID_REQUEST","Exact native execution dependency provenance required");
    return {...value,execution_dependency:{...record}};
  });
  const full=dependencies.filter(value=>value.execution_dependency!==undefined);
  if(full.length!==0&&full.length!==dependencies.length)sourceFailure("INVALID_REQUEST","Execution and revision-only dependencies cannot be mixed");
  const identities=dependencies.map(value=>value.execution_dependency?value.execution_dependency.predecessor_run_id+":"+value.execution_dependency.predecessor_task_id:value.revision_id);
  if(new Set(identities).size!==identities.length)sourceFailure("INVALID_REQUEST","Candidate dependency identities must be distinct");
  return dependencies;
}
export async function recordSourceEvent(
  tx: SourceSQL,
  context: SourceContext,
  aggregate: string,
  generation: string,
  type: string,
  payload: unknown,
): Promise<void> {
  const event = randomUUID(),
    scope = candidateScope(context);
  await tx.query(
    "INSERT INTO hyperfide.source_events(organisation_id,repository_id,security_domain_id,event_id,aggregate_id,aggregate_generation,event_type,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organisation_id,repository_id,security_domain_id,aggregate_id,aggregate_generation) DO NOTHING RETURNING event_id",
    [...scope, event, aggregate, generation, type, payload],
  );

}
export async function commitCandidateOperation(
  tx: SourceSQL,
  context: SourceContext,
  id: string,
  result: unknown,
): Promise<void> {
  await tx.query(
    "UPDATE hyperfide.source_metadata_operations SET state='COMMITTED',result=$6,result_digest=$7,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5 AND state='PENDING'",
    [
      ...candidateScope(context),
      context.principal_id,
      id,
      result,
      sourceDigest(result),
    ],
  );
}

export class SourceCandidateService {
  constructor(
    readonly metadata: SourceMetadata,
    readonly verifier?: SourceCandidateEvidenceVerifier,
  ) {}
  async mutate<T>(
    context: SourceContext,
    action: string,
    input: CandidateMutation,
    body: (tx: SourceSQL, operationId: string) => Promise<T>,
  ): Promise<T> {
    operation(input);
    const {
      operation_id: _operation,
      idempotency_key: _key,
      ...semantic
    } = input;
    const digest = sourceDigest(semantic);
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, action);
      const current = await reserveSourceOperation(tx, context, {
        operation_id: input.operation_id,
        idempotency_key: input.idempotency_key,
        action,
        request_digest: digest,
      });
      if (current.state === "COMMITTED") return current.result as T;
      if (current.state === "CANCELLED")
        sourceFailure("OPERATION_CANCELLED", "Source mutation was cancelled");
      if (current.state !== "PENDING")
        sourceFailure("CONFLICT", "Source mutation is terminal");
      const result = await body(tx, current.operation_id);
      await commitCandidateOperation(tx, context, current.operation_id, result);
      return result;
    });
  }
  async domainInTransaction(
    tx: SourceSQL,
    context: SourceContext,
    id: string,
    lock = false,
  ): Promise<NativeIntegrationDomain> {
    parseUUID(id, "domain_id");
    const row = (
      await tx.query(
        "SELECT domain_id,generation::text,revision_id,root_tree_id,authority_epoch::text,policy_id,policy_digest FROM hyperfide.source_integration_domains WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND domain_id=$4" +
          (lock ? " FOR UPDATE" : " FOR SHARE"),
        [...candidateScope(context), id],
      )
    ).rows[0];
    if (!row)
      sourceFailure(
        "NOT_FOUND",
        "Integration domain is unavailable in this scope",
      );
    if (row.authority_epoch !== context.authority_epoch)
      sourceFailure(
        "STALE_AUTHORITY",
        "Integration domain belongs to another authority epoch",
      );
    return {
      schema_version: 1,
      scope: { ...context.scope },
      ...row,
    } as NativeIntegrationDomain;
  }
  async readDomain(
    context: SourceContext,
    id: string,
  ): Promise<NativeIntegrationDomain> {
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.domains.read");
      return this.domainInTransaction(tx, context, id);
    });
  }
  async createDomain(
    context: SourceContext,
    input: CreateDomainInput,
  ): Promise<NativeIntegrationDomain> {
    shape(input, [
      "operation_id",
      "idempotency_key",
      "domain_id",
      "revision_id",
      "policy_id",
      "policy_digest",
    ]);
    parseUUID(input.domain_id);
    parseObjectId(input.revision_id);
    parseUUID(input.policy_id);
    parseObjectId(input.policy_digest);
    return this.mutate(context, "source.domains.create", input, async (tx) => {
      const revision = await this.metadata.readRevisionInTransaction(
        tx,
        context,
        input.revision_id,
      );
      await this.metadata.protectRoot(
        tx,
        context.scope,
        revision.root_tree_id,
        "domain:" + input.domain_id + ":1",
      );
      await tx.query(
        "INSERT INTO hyperfide.source_integration_domains(organisation_id,repository_id,security_domain_id,domain_id,generation,revision_id,root_tree_id,authority_epoch,policy_id,policy_digest) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
        [
          ...candidateScope(context),
          input.domain_id,
          input.revision_id,
          revision.root_tree_id,
          context.authority_epoch,
          input.policy_id,
          input.policy_digest,
        ],
      );
      const domain = await this.domainInTransaction(
        tx,
        context,
        input.domain_id,
      );
      if (
        domain.generation !== "1" ||
        domain.revision_id !== input.revision_id ||
        domain.policy_id !== input.policy_id ||
        domain.policy_digest !== input.policy_digest
      )
        sourceFailure(
          "DOMAIN_CONFLICT",
          "Integration domain is already configured differently",
        );
      return domain;
    });
  }
  async configureDomain(
    context: SourceContext,
    input: ConfigureDomainInput,
  ): Promise<NativeIntegrationDomain> {
    shape(input, [
      "operation_id",
      "idempotency_key",
      "domain_id",
      "expected_generation",
      "policy_id",
      "policy_digest",
    ]);
    parseUUID(input.domain_id);
    positiveGeneration(input.expected_generation);
    parseUUID(input.policy_id);
    parseObjectId(input.policy_digest);
    return this.mutate(
      context,
      "source.domains.configure",
      input,
      async (tx) => {
        const current = await this.domainInTransaction(
          tx,
          context,
          input.domain_id,
          true,
        );
        if (current.generation !== input.expected_generation)
          sourceFailure(
            "DOMAIN_CHANGED",
            "Integration domain generation changed",
          );
        if (BigInt(current.generation) === 9223372036854775807n)
          sourceFailure(
            "LIMIT_EXCEEDED",
            "Integration domain generation is exhausted",
          );
        await tx.query(
          "UPDATE hyperfide.source_integration_domains SET generation=generation+1,policy_id=$5,policy_digest=$6,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND domain_id=$4",
          [
            ...candidateScope(context),
            input.domain_id,
            input.policy_id,
            input.policy_digest,
          ],
        );
        return this.domainInTransaction(tx, context, input.domain_id);
      },
    );
  }
  async candidateInTransaction(
    tx: SourceSQL,
    context: SourceContext,
    id: string,
  ): Promise<NativeCandidateRecord> {
    parseUUID(id, "candidate_id");
    const row = (
      await tx.query(
        "SELECT manifest FROM hyperfide.source_native_candidates WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND candidate_id=$4",
        [...candidateScope(context), id],
      )
    ).rows[0];
    if (!row)
      sourceFailure(
        "NOT_FOUND",
        "Candidate is unavailable in this source scope",
      );
    const candidate = row.manifest as NativeCandidateRecord;
    if (candidate.authority_epoch !== context.authority_epoch)
      sourceFailure(
        "STALE_AUTHORITY",
        "Candidate belongs to another authority epoch",
      );
    return candidate;
  }
  private async assertContributorAncestry(
    tx: SourceSQL,
    context: SourceContext,
    tip: string,
    required: readonly string[],
    includePredecessors = false,
  ): Promise<void> {
    const remaining = new Set(required),
      pending = [tip],
      seen = new Set([tip]),
      deadline = Date.now() + 5000;
    while (pending.length && remaining.size) {
      if (Date.now() >= deadline)
        sourceFailure(
          "LIMIT_EXCEEDED",
          "Candidate ancestry validation exceeded its deadline",
        );
      const page = pending.splice(0, 256);
      page.forEach((id) => remaining.delete(id));
      if (!remaining.size) return;
      const rows = (
        await tx.query(
          includePredecessors
            ? "SELECT parent_revision_id FROM hyperfide.source_revision_parents WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=ANY($4::text[]) UNION SELECT jsonb_array_elements_text(predecessor_revision_ids) AS parent_revision_id FROM hyperfide.source_change_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=ANY($4::text[]) ORDER BY parent_revision_id"
            : "SELECT parent_revision_id FROM hyperfide.source_revision_parents WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=ANY($4::text[]) ORDER BY parent_revision_id",
          [...candidateScope(context), page],
        )
      ).rows;
      for (const row of rows)
        if (!seen.has(row.parent_revision_id)) {
          if (seen.size >= 4096)
            sourceFailure(
              "LIMIT_EXCEEDED",
              "Candidate ancestry exceeds its bounded revision scope",
            );
          seen.add(row.parent_revision_id);
          pending.push(row.parent_revision_id);
        }
    }
    if (remaining.size)
      sourceFailure(
        "INVALID_CONTRIBUTOR",
        "Candidate does not retain its pinned baseline and contributor revisions",
      );
  }
  async create(
    context: SourceContext,
    input: CreateCandidateInput,
  ): Promise<NativeCandidateRecord> {
    shape(input, [
      "operation_id",
      "idempotency_key",
      "candidate_id",
      "domain_id",
      "expected_generation",
      "expected_revision_id",
      "revision_id",
      "contributors",
      "dependencies",
      "inputs",
      "transformation_version",
    ]);
    parseUUID(input.candidate_id);
    parseUUID(input.domain_id);
    positiveGeneration(input.expected_generation);
    parseObjectId(input.expected_revision_id);
    parseObjectId(input.revision_id);
    if (
      !Array.isArray(input.contributors) ||
      !input.contributors.length ||
      input.contributors.length > 64 ||
      !Array.isArray(input.dependencies) ||
      input.dependencies.length > 256
    )
      sourceFailure(
        "INVALID_REQUEST",
        "Explicit bounded candidate contributors and dependencies are required",
      );
    const contributors = input.contributors.map((value) => {
      shape(
        value,
        ["revision_id", "change_id", "custody_id", "custody_generation"],
        ["run_id", "task_id"],
      );
      parseObjectId(value.revision_id);
      parseUUID(value.change_id);
      parseUUID(value.custody_id);
      positiveGeneration(value.custody_generation);
      if ((value.run_id === undefined) !== (value.task_id === undefined))
        sourceFailure(
          "INVALID_REQUEST",
          "Managed contributor run and task identities must be supplied together",
        );
      if (value.run_id !== undefined) {
        parseUUID(value.run_id);
        parseUUID(value.task_id);
      }
      return { ...value };
    });
    if (
      new Set(contributors.map((value) => value.revision_id)).size !==
        contributors.length ||
      new Set(contributors.map((value) => value.custody_id)).size !==
        contributors.length
    )
      sourceFailure(
        "INVALID_REQUEST",
        "Candidate contributor and custody identities must be distinct",
      );
    const dependencies = validateCandidateDependencies(input.dependencies);
    shape(input.inputs, [
      "source",
      "dependency",
      "toolchain",
      "configuration",
      "graph",
      "contract",
    ]);
    Object.values(input.inputs).forEach(parseObjectId);
    if (
      typeof input.transformation_version !== "string" ||
      !input.transformation_version.length ||
      Buffer.byteLength(input.transformation_version) > 128
    )
      sourceFailure(
        "INVALID_REQUEST",
        "Explicit bounded transformation version required",
      );
    if (canonicalBytes(input).byteLength > 262144)
      sourceFailure(
        "LIMIT_EXCEEDED",
        "Candidate manifest exceeds its metadata bound",
      );
    return this.mutate(
      context,
      "source.candidates.create",
      input,
      async (tx) => {
        const domain = await this.domainInTransaction(
          tx,
          context,
          input.domain_id,
        );
        if (
          domain.generation !== input.expected_generation ||
          domain.revision_id !== input.expected_revision_id
        )
          sourceFailure(
            "DOMAIN_CHANGED",
            "Candidate baseline differs from the current integration domain",
          );
        const revision = await this.metadata.readRevisionInTransaction(
          tx,
          context,
          input.revision_id,
        );
        for (const contributor of contributors) {
          const membership = (
            await tx.query(
              "SELECT 1 FROM hyperfide.source_change_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND change_id=$4 AND revision_id=$5",
              [
                ...candidateScope(context),
                contributor.change_id,
                contributor.revision_id,
              ],
            )
          ).rows[0];
          if (!membership)
            sourceFailure(
              "INVALID_CONTRIBUTOR",
              "Contributor revision is unavailable under the supplied change identity",
            );
        }
        await this.assertContributorAncestry(tx, context, input.revision_id, [
          input.expected_revision_id,
        ]);
        await this.assertContributorAncestry(
          tx,
          context,
          input.revision_id,
          contributors.map((value) => value.revision_id),
          true,
        );
        for (const dependency of dependencies) {
          await this.metadata.readRevisionInTransaction(
            tx,
            context,
            dependency.revision_id,
          );
          if(dependency.execution_dependency){
            const expected=dependency.execution_dependency;
            if(expected.repository_id!==context.scope.repository_id||expected.security_domain_id!==context.scope.security_domain_id)sourceFailure("SCOPE_DENIED","Native execution dependency belongs to another source scope");
            const {readNativeTaskQualification}=await import("../assurance/fleet_native.js");
            const current=await readNativeTaskQualification(tx,{organisation_id:context.scope.organisation_id,run_id:expected.predecessor_run_id},expected.predecessor_task_id,expected.repository_id);
            if(current.revision_id!==expected.source_object_id||current.custody_id!==expected.current_custody_id||current.custody_generation!==expected.custody_generation||current.qualification_id!==expected.qualification_id)sourceFailure("CANDIDATE_DEPENDENCY_STALE","Native dependency custody or qualification differs from the execution packet");
            const task=(await tx.query('SELECT state FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[context.scope.organisation_id,expected.predecessor_run_id,expected.predecessor_task_id])).rows[0];
            const progress=["QUALIFIED","INTEGRATING","INTEGRATED"];
            if(!task||progress.indexOf(String(task.state))<progress.indexOf(expected.state)||expected.milestone==="INTEGRATED"&&task.state!=="INTEGRATED")sourceFailure("CANDIDATE_DEPENDENCY_STALE","Native dependency has not reached its declared milestone");
          }
        }
        if (
          input.inputs.source !==
            nativeCandidateSourceDigest(
              context.scope,
              input.revision_id,
              revision.root_tree_id,
            ) ||
          input.inputs.dependency !==
            nativeCandidateDependencyDigest(dependencies)
        )
          sourceFailure(
            "CANDIDATE_INPUT_MISMATCH",
            "Candidate source or dependency digest differs from its pinned inputs",
          );
        const body = {
          schema_version: 1 as const,
          scope: { ...context.scope },
          candidate_id: input.candidate_id,
          domain_id: input.domain_id,
          expected_generation: input.expected_generation,
          expected_revision_id: input.expected_revision_id,
          revision_id: input.revision_id,
          root_tree_id: revision.root_tree_id,
          created_by_principal_id: context.principal_id,
          authority_epoch: context.authority_epoch,
          policy_id: domain.policy_id,
          policy_digest: domain.policy_digest,
          contributors,
          dependencies,
          inputs: { ...input.inputs },
          transformation_version: input.transformation_version,
        };
        const candidate: NativeCandidateRecord = {
          ...body,
          manifest_digest: sourceDigest(body),
        };
        await this.metadata.protectRoot(
          tx,
          context.scope,
          revision.root_tree_id,
          "candidate:" + input.candidate_id,
        );
        await tx.query(
          "INSERT INTO hyperfide.source_native_candidates(organisation_id,repository_id,security_domain_id,candidate_id,domain_id,revision_id,root_tree_id,manifest_digest,manifest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
          [
            ...candidateScope(context),
            candidate.candidate_id,
            candidate.domain_id,
            candidate.revision_id,
            candidate.root_tree_id,
            candidate.manifest_digest,
            candidate,
          ],
        );
        const retained = await this.candidateInTransaction(
          tx,
          context,
          candidate.candidate_id,
        );
        if (retained.manifest_digest !== candidate.manifest_digest)
          sourceFailure(
            "CANDIDATE_CONFLICT",
            "Candidate identity already binds another immutable manifest",
          );
        await recordSourceEvent(
          tx,
          context,
          "candidate:" + candidate.candidate_id,
          "1",
          "NATIVE_CANDIDATE_CREATED",
          candidate,
        );
        return retained;
      },
    );
  }
  async read(
    context: SourceContext,
    id: string,
  ): Promise<NativeCandidateRecord> {
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.candidates.read");
      return this.candidateInTransaction(tx, context, id);
    });
  }
  async qualify(
    context: SourceContext,
    input: CandidateMutation & { candidate_id: string; evidence_ids: string[] },
  ): Promise<CandidateQualification> {
    shape(input, [
      "operation_id",
      "idempotency_key",
      "candidate_id",
      "evidence_ids",
    ]);
    parseUUID(input.candidate_id);
    const ids = evidenceIds(input.evidence_ids);
    return this.mutate(
      context,
      "source.candidates.qualify",
      input,
      async (tx) => {
        const candidate = await this.candidateInTransaction(
            tx,
            context,
            input.candidate_id,
          ),
          domain = await this.domainInTransaction(
            tx,
            context,
            candidate.domain_id,
          );
        this.assertCurrentDomain(candidate, domain);
        const evidence = await verifyCandidateEvidence(
          this.verifier,
          tx,
          context,
          candidate,
          ids,
        );
        const body = {
          schema_version: 1 as const,
          scope: { ...context.scope },
          candidate_id: candidate.candidate_id,
          manifest_digest: candidate.manifest_digest,
          authority_epoch: context.authority_epoch,
          policy_id: candidate.policy_id,
          policy_digest: candidate.policy_digest,
          evidence,
        };
        const result: CandidateQualification = {
          ...body,
          qualification_id: sourceDigest(body),
        };
        await tx.query(
          "INSERT INTO hyperfide.source_candidate_qualifications(organisation_id,repository_id,security_domain_id,qualification_id,candidate_id,manifest_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [
            ...candidateScope(context),
            result.qualification_id,
            candidate.candidate_id,
            candidate.manifest_digest,
            result,
          ],
        );
        await recordSourceEvent(
          tx,
          context,
          "qualification:" + result.qualification_id,
          "1",
          "NATIVE_CANDIDATE_QUALIFIED",
          result,
        );
        return result;
      },
    );
  }
  assertCurrentDomain(
    candidate: NativeCandidateRecord,
    domain: NativeIntegrationDomain,
  ): void {
    if (
      domain.generation !== candidate.expected_generation ||
      domain.revision_id !== candidate.expected_revision_id ||
      domain.policy_id !== candidate.policy_id ||
      domain.policy_digest !== candidate.policy_digest
    )
      sourceFailure(
        "DOMAIN_CHANGED",
        "Candidate baseline or domain policy changed",
      );
  }
  async qualificationInTransaction(
    tx: SourceSQL,
    context: SourceContext,
    id: string,
    candidateId: string,
  ): Promise<CandidateQualification> {
    parseObjectId(id);
    const row = (
      await tx.query(
        "SELECT result FROM hyperfide.source_candidate_qualifications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND qualification_id=$4 AND candidate_id=$5",
        [...candidateScope(context), id, candidateId],
      )
    ).rows[0];
    if (!row)
      sourceFailure(
        "QUALIFICATION_REQUIRED",
        "Exact candidate qualification is unavailable",
      );
    return row.result as CandidateQualification;
  }
}
