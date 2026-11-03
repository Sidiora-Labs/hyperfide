import {resolveEpochAdoption} from './migration/epoch_adoption.js';
import { parseObjectId, parseUUID } from "./contracts.js";
import type { SourceScope } from "./contracts.js";
import { sourceDigest, sourceFailure } from "./metadata.js";
import type { SourceContext, SourceSQL } from "./metadata.js";
import {
  SourceCandidateService,
  candidateScope,
  recordSourceEvent,
} from "./candidates.js";
import type {NativeCandidateRecord,CandidateQualification} from "./candidates.js";
import type { CandidateMutation } from "./candidates.js";
import { verifyCandidateEvidence } from "./evidence.js";

export interface NativeAcceptanceReceipt {
  schema_version: 1;
  scope: SourceScope;
  acceptance_id: string;
  operation_id: string;
  candidate_id: string;
  qualification_id: string;
  domain_id: string;
  generation: string;
  previous_revision_id: string;
  revision_id: string;
  root_tree_id: string;
  manifest_digest: string;
  policy_id: string;
  policy_digest: string;
  authority_epoch: string;
  durability_profile: string;
  evidence_digest: string;
  result_digest: string;
}
export class SourceAcceptanceService {
  constructor(readonly candidates: SourceCandidateService) {}
  async accept(
    context: SourceContext,
    input: CandidateMutation & {
      candidate_id: string;
      qualification_id: string;
    },
  ): Promise<NativeAcceptanceReceipt> {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some(
        (key) =>
          ![
            "operation_id",
            "idempotency_key",
            "candidate_id",
            "qualification_id",
          ].includes(key),
      )
    )
      sourceFailure(
        "INVALID_REQUEST",
        "Acceptance fields differ from the versioned schema",
      );
    parseUUID(input.candidate_id);
    parseObjectId(input.qualification_id);
    return this.candidates.mutate(
      context,
      "source.acceptance.accept",
      input,
      async (tx, operationId) => {
        const candidate = await this.candidates.candidateInTransaction(
          tx,
          context,
          input.candidate_id,
        );
        const domain = await this.candidates.domainInTransaction(
          tx,
          context,
          candidate.domain_id,
          true,
        );
        this.candidates.assertCurrentDomain(candidate, domain);
        if (BigInt(domain.generation) === 9223372036854775807n)
          sourceFailure(
            "LIMIT_EXCEEDED",
            "Integration domain generation is exhausted",
          );
        const qualification = await this.candidates.qualificationInTransaction(
          tx,
          context,
          input.qualification_id,
          candidate.candidate_id,
        );
        if (
          qualification.manifest_digest !== candidate.manifest_digest ||
          qualification.authority_epoch !== context.authority_epoch
        )
          sourceFailure(
            "QUALIFICATION_STALE",
            "Qualification does not bind the current candidate",
          );
        const evidence = await verifyCandidateEvidence(
          this.candidates.verifier,
          tx,
          context,
          candidate,
          qualification.evidence.evidence_ids,
        );
        if (sourceDigest(evidence) !== sourceDigest(qualification.evidence))
          sourceFailure(
            "QUALIFICATION_STALE",
            "Qualification evidence or authority changed",
          );
        const profile = await this.candidates.metadata.guard(
          tx,
          context,
          "source.acceptance.accept",
        );
        const generation = String(BigInt(domain.generation) + 1n),
          acceptanceId = sourceDigest([
            context.scope,
            context.principal_id,
            operationId,
            "native-acceptance-v1",
          ]);
        await this.candidates.metadata.protectRoot(
          tx,
          context.scope,
          candidate.root_tree_id,
          "acceptance:" + acceptanceId,
        );
        const body = {
          schema_version: 1 as const,
          scope: { ...context.scope },
          acceptance_id: acceptanceId,
          operation_id: operationId,
          candidate_id: candidate.candidate_id,
          qualification_id: qualification.qualification_id,
          domain_id: domain.domain_id,
          generation,
          previous_revision_id: domain.revision_id,
          revision_id: candidate.revision_id,
          root_tree_id: candidate.root_tree_id,
          manifest_digest: candidate.manifest_digest,
          policy_id: candidate.policy_id,
          policy_digest: candidate.policy_digest,
          authority_epoch: context.authority_epoch,
          durability_profile: profile.durability_profile,
          evidence_digest: evidence.evidence_digest,
        };
        const receipt: NativeAcceptanceReceipt = {
          ...body,
          result_digest: sourceDigest(body),
        };
        await tx.query(
          "INSERT INTO hyperfide.source_native_acceptances(organisation_id,repository_id,security_domain_id,acceptance_id,domain_id,generation,candidate_id,qualification_id,revision_id,root_tree_id,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            ...candidateScope(context),
            acceptanceId,
            domain.domain_id,
            generation,
            candidate.candidate_id,
            qualification.qualification_id,
            candidate.revision_id,
            candidate.root_tree_id,
            receipt,
          ],
        );
        const changed = await tx.query(
          "UPDATE hyperfide.source_integration_domains SET generation=$5,revision_id=$6,root_tree_id=$7,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND domain_id=$4 AND generation=$8 AND revision_id=$9",
          [
            ...candidateScope(context),
            domain.domain_id,
            generation,
            candidate.revision_id,
            candidate.root_tree_id,
            domain.generation,
            domain.revision_id,
          ],
        );
        if (changed.rowCount !== 1)
          sourceFailure(
            "DOMAIN_CHANGED",
            "Integration domain changed during acceptance",
          );
        await recordSourceEvent(
          tx,
          context,
          "domain:" + domain.domain_id,
          generation,
          "NATIVE_SOURCE_ACCEPTED",
          receipt,
        );
        return receipt;
      },
    );
  }
  async readInTransaction(
    tx: SourceSQL,
    context: SourceContext,
    id: string,
  ): Promise<NativeAcceptanceReceipt> {
    parseObjectId(id);
    await this.candidates.metadata.guard(tx, context, "source.acceptance.read");
    const row = (
      await tx.query(
        "SELECT receipt FROM hyperfide.source_native_acceptances WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND acceptance_id=$4",
        [...candidateScope(context), id],
      )
    ).rows[0];
    if (!row)
      sourceFailure(
        "NOT_FOUND",
        "Native acceptance is unavailable in this source scope",
      );
    const receipt = row.receipt as NativeAcceptanceReceipt;
    if(receipt.authority_epoch!==context.authority_epoch)await resolveEpochAdoption(tx,context,receipt);
    return receipt;
  }
  async read(
    context: SourceContext,
    id: string,
  ): Promise<NativeAcceptanceReceipt> {
    return this.candidates.metadata.transaction((tx) =>
      this.readInTransaction(tx, context, id),
    );
  }
  async authorizeAcceptance(
    tx: SourceSQL,
    context: SourceContext,
    id: string,
  ): Promise<NativeAcceptanceReceipt> {
    return this.verifyAcceptedEvidence(
      tx,
      context,
      await this.readInTransaction(tx, context, id),
    );
  }
  async authorizeAcceptedRevision(
    tx: SourceSQL,
    context: SourceContext,
    revisionId: string,
  ): Promise<NativeAcceptanceReceipt> {
    parseObjectId(revisionId);
    await this.candidates.metadata.guard(tx, context, "source.acceptance.read");
    const rows = (
      await tx.query(
        "SELECT receipt FROM hyperfide.source_native_acceptances WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4 ORDER BY created_at DESC,acceptance_id LIMIT 65",
        [...candidateScope(context), revisionId],
      )
    ).rows;
    if (!rows.length)
      sourceFailure(
        "ACCEPTANCE_REQUIRED",
        "Publication requires a native accepted revision",
      );
    if (rows.length > 64)
      sourceFailure(
        "LIMIT_EXCEEDED",
        "Publication acceptance lookup requires an exact acceptance identity",
      );
    return this.verifyAcceptedEvidence(
      tx,
      context,
      rows[0]!.receipt as NativeAcceptanceReceipt,
    );
  }
  private async verifyAcceptedEvidence(
    tx: SourceSQL,
    context: SourceContext,
    receipt: NativeAcceptanceReceipt,
  ): Promise<NativeAcceptanceReceipt> {
    if(receipt.authority_epoch!==context.authority_epoch)return this.verifyAdoptedEvidence(tx,context,receipt);
    const candidate = await this.candidates.candidateInTransaction(
      tx,
      context,
      receipt.candidate_id,
    );
    const domain = await this.candidates.domainInTransaction(
      tx,
      context,
      receipt.domain_id,
    );
    if (
      domain.policy_id !== receipt.policy_id ||
      domain.policy_digest !== receipt.policy_digest
    )
      sourceFailure(
        "QUALIFICATION_STALE",
        "Publication policy changed after native acceptance",
      );
    const qualification = await this.candidates.qualificationInTransaction(
      tx,
      context,
      receipt.qualification_id,
      receipt.candidate_id,
    );
    const current = await verifyCandidateEvidence(
      this.candidates.verifier,
      tx,
      context,
      candidate,
      qualification.evidence.evidence_ids,
    );
    if (sourceDigest(current) !== sourceDigest(qualification.evidence))
      sourceFailure(
        "QUALIFICATION_STALE",
        "Publication evidence changed after native acceptance",
      );
    return receipt;
  }
  private async verifyAdoptedEvidence(tx:SourceSQL,context:SourceContext,receipt:NativeAcceptanceReceipt):Promise<NativeAcceptanceReceipt>{
    const adoption=await resolveEpochAdoption(tx,context,receipt),{result_digest,...body}=receipt;
    if(sourceDigest(body)!==result_digest)sourceFailure('QUALIFICATION_STALE','Historical acceptance digest differs');
    const candidateRow=(await tx.query('SELECT manifest FROM hyperfide.source_native_candidates WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND candidate_id=$4',[...candidateScope(context),receipt.candidate_id])).rows[0];
    const qualificationRow=(await tx.query('SELECT result FROM hyperfide.source_candidate_qualifications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND qualification_id=$4',[...candidateScope(context),receipt.qualification_id])).rows[0];
    const domain=(await tx.query('SELECT policy_id,policy_digest FROM hyperfide.source_integration_domains WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND domain_id=$4',[...candidateScope(context),receipt.domain_id])).rows[0];
    const candidate=candidateRow?.manifest as NativeCandidateRecord|undefined,qualification=qualificationRow?.result as CandidateQualification|undefined;
    if(!candidate||!qualification||!domain||candidate.authority_epoch!==receipt.authority_epoch||qualification.authority_epoch!==receipt.authority_epoch||candidate.revision_id!==receipt.revision_id||candidate.root_tree_id!==receipt.root_tree_id||candidate.manifest_digest!==receipt.manifest_digest||candidate.policy_id!==receipt.policy_id||candidate.policy_digest!==receipt.policy_digest||qualification.candidate_id!==candidate.candidate_id||qualification.policy_id!==candidate.policy_id||qualification.policy_digest!==candidate.policy_digest||qualification.evidence.evidence_digest!==receipt.evidence_digest||qualification.manifest_digest!==candidate.manifest_digest||domain.policy_id!==receipt.policy_id||domain.policy_digest!==receipt.policy_digest)sourceFailure('QUALIFICATION_STALE','Historical accepted source or policy differs');
    const evidence=await verifyCandidateEvidence(this.candidates.verifier,tx,{...context,authority_epoch:receipt.authority_epoch,policy_version:adoption.original_policy_version},candidate,qualification.evidence.evidence_ids);
    if(sourceDigest(evidence)!==sourceDigest(qualification.evidence))sourceFailure('QUALIFICATION_STALE','Historical accepted evidence changed or was revoked');
    return receipt;
  }

}
