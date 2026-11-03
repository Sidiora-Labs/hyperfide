import { parseObjectId, parseUUID } from "./contracts.js";
import type { SourceContext, SourceSQL } from "./metadata.js";
import { sourceFailure } from "./metadata.js";
import type { NativeCandidateRecord } from "./candidates.js";

export interface SourceCandidateEvidence {
  schema_version: 1;
  candidate_id: string;
  manifest_digest: string;
  policy_id: string;
  policy_digest: string;
  evidence_ids: string[];
  evidence_digest: string;
}
export type SourceCandidateEvidenceVerifier = (
  tx: SourceSQL,
  context: SourceContext,
  candidate: NativeCandidateRecord,
  evidenceIds: readonly string[],
) => Promise<SourceCandidateEvidence>;

export function evidenceIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 256 ||
    new Set(value).size !== value.length
  )
    sourceFailure(
      "INVALID_EVIDENCE",
      "One through 256 distinct evidence identities are required",
    );
  return value.map((id) => parseUUID(id, "evidence_id")).sort();
}
export async function verifyCandidateEvidence(
  verifier: SourceCandidateEvidenceVerifier | undefined,
  tx: SourceSQL,
  context: SourceContext,
  candidate: NativeCandidateRecord,
  ids: readonly string[],
): Promise<SourceCandidateEvidence> {
  if (!verifier)
    sourceFailure(
      "EVIDENCE_AUTHORITY_UNAVAILABLE",
      "Native assurance verification is required",
    );
  const current = await verifier(tx, context, candidate, ids);
  if (
    current.schema_version !== 1 ||
    current.candidate_id !== candidate.candidate_id ||
    current.manifest_digest !== candidate.manifest_digest ||
    current.policy_id !== candidate.policy_id ||
    current.policy_digest !== candidate.policy_digest ||
    JSON.stringify(evidenceIds(current.evidence_ids)) !== JSON.stringify(ids)
  )
    sourceFailure(
      "EVIDENCE_BINDING_MISMATCH",
      "Evidence does not bind this exact candidate and policy",
    );
  parseObjectId(current.evidence_digest);
  return {
    schema_version: 1,
    candidate_id: current.candidate_id,
    manifest_digest: current.manifest_digest,
    policy_id: current.policy_id,
    policy_digest: current.policy_digest,
    evidence_ids: [...ids],
    evidence_digest: current.evidence_digest,
  };
}
