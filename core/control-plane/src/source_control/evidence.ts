import { SourceRetentionService } from "./retention.js";
import { retentionScope } from "./pins.js";
import type {
  SourceStorageScope,
  SourceTransaction,
} from "./storage_contract.js";
import { parseObjectId, parseUUID, SourceControlError } from "./contracts.js";
import type { SourceContext, SourceSQL } from "./metadata.js";
function sourceFailure(code: string, message: string): never {
  throw new SourceControlError(code, message);
}
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
  await retainCandidateEvidence(tx, context.scope, ids);
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

export async function retainCandidateEvidence(
  tx: SourceTransaction,
  scope: SourceStorageScope,
  ids: readonly string[],
): Promise<void> {
  const rows = (
    await tx.query(
      "SELECT evidence_id,receipt_object_id,receipt,revoked_at FROM hyperfide.source_native_assurance_evidence WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND evidence_id=ANY($4::uuid[]) ORDER BY evidence_id FOR SHARE",
      [...retentionScope(scope), [...ids]],
    )
  ).rows;
  if (rows.length !== ids.length)
    sourceFailure(
      "EVIDENCE_INCOMPLETE",
      "Retained evidence record is unavailable",
    );
  for (const row of rows) {
    if (row.revoked_at !== null)
      sourceFailure(
        "EVIDENCE_REVOKED",
        "Revoked evidence cannot acquire retention",
      );
    const objects = new Set<string>([
      row.receipt_object_id,
      row.receipt.output.stdout_object_id,
      row.receipt.output.stderr_object_id,
      ...row.receipt.artifacts.map(
        (artifact: { object_id: string }) => artifact.object_id,
      ),
    ]);
    for (const object_id of [...objects].sort())
      await SourceRetentionService.acquire(tx, scope, {
        root_id: SourceRetentionService.producerRootId(
          scope,
          "EVIDENCE",
          row.evidence_id,
          object_id,
        ),
        owner_kind: "EVIDENCE",
        owner_id: row.evidence_id,
        object_id,
      });
  }
}
export async function releaseTerminalEvidence(
  tx: SourceTransaction,
  scope: SourceStorageScope,
  partition: number,
  limit: number,
): Promise<void> {
  const producers = (
    await tx.query(
      "SELECT 1 FROM hyperfide.source_retention_roots WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='EVIDENCE' AND state='ACTIVE' AND owner_id ~ '^[a-f0-9-]{36}$' AND get_byte(decode(substr(object_id,8,2),'hex'),0)%16=$4 LIMIT 1",
      [...retentionScope(scope), partition],
    )
  ).rowCount;
  if (!producers) return;
  const roots = (
    await tx.query(
      "SELECT r.root_id,r.owner_id,r.object_id FROM hyperfide.source_retention_roots r JOIN hyperfide.source_native_assurance_evidence e ON e.organisation_id=r.organisation_id AND e.repository_id=r.repository_id AND e.security_domain_id=r.security_domain_id AND e.evidence_id::text=r.owner_id WHERE r.organisation_id=$1 AND r.repository_id=$2 AND r.security_domain_id=$3 AND r.owner_kind='EVIDENCE' AND r.state='ACTIVE' AND e.revoked_at IS NOT NULL AND get_byte(decode(substr(r.object_id,8,2),'hex'),0)%16=$4 ORDER BY r.root_id LIMIT $5 FOR SHARE OF e",
      [...retentionScope(scope), partition, limit],
    )
  ).rows;
  for (const root of roots) {
    await SourceRetentionService.release(tx, scope, {
      root_id: root.root_id,
      owner_kind: "EVIDENCE",
      owner_id: root.owner_id,
    });
    await tx.query(
      "DELETE FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='HOLD' AND owner_id=$4 AND object_id=$5",
      [
        ...retentionScope(scope),
        "native-evidence:" + root.owner_id,
        root.object_id,
      ],
    );
  }
}
