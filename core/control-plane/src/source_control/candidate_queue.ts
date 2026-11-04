import { randomUUID } from "node:crypto";
import { canonicalBytes, parseObjectId, parseUUID } from "./contracts.js";
import { sourceDigest, sourceFailure } from "./metadata.js";
import type { SourceContext, SourceSQL } from "./metadata.js";
import { SourceCandidateService, candidateScope } from "./candidates.js";
import type {
  CandidateMutation,
  NativeCandidateRecord,
  CandidateContributor,
  CandidateDependency,
} from "./candidates.js";
import { evidenceIds, verifyCandidateEvidence } from "./evidence.js";
import type { SourceCandidateEvidenceVerifier } from "./evidence.js";

export const CANDIDATE_QUEUE_LIMITS = {
  max_proposals: 16,
  max_contributors: 64,
  max_manifest_bytes: 262144,
  max_dependencies: 256,
  max_attempts: 3,
  max_lease_ms: 300000,
  max_lifetime_ms: 86400000,
} as const;
export interface QueueEnqueueInput extends CandidateMutation {
  candidate_ids: string[];
  expires_at: string;
  max_attempts?: number;
}
export interface QueueClaimInput extends CandidateMutation {
  lease_ms: number;
}
export interface QueueBatchInput extends CandidateMutation {
  batch_id: string;
  lease_id: string;
}
export interface QueueBindInput extends QueueBatchInput {
  candidate_id: string;
}
export interface QueueCompleteInput extends QueueBatchInput {
  qualification_id: string;
}
export interface QueueFailInput extends QueueBatchInput {
  evidence_ids: string[];
}
export interface QueueIsolateInput extends QueueBatchInput {
  partitions: string[][];
}
export interface QueueCost {
  proposals: number;
  contributors: number;
  manifest_bytes: number;
  dependencies: number;
}
export interface QueueManifest {
  schema_version: 1;
  authority_epoch: string;
  domain_id: string;
  expected_generation: string;
  expected_revision_id: string;
  policy_id: string;
  policy_digest: string;
  proposal_ids: string[];
  candidate_ids: string[];
  contributors: CandidateContributor[];
  dependencies: CandidateDependency[];
  input_context: { toolchain: string; configuration: string; contract: string };
  cost: QueueCost;
}
export interface QueueBatchResult {
  schema_version: 1;
  batch_id: string;
  work_id: string;
  lease_id: string;
  lease_expires_at: string;
  state: "CLAIMED" | "BOUND" | "PASSED" | "FAILED" | "ISOLATED" | "EXPIRED";
  manifest: QueueManifest;
  candidate_id: string | null;
  qualification_id: string | null;
  evidence: unknown;
  result: unknown;
  attempt: number;
  max_attempts: number;
}
interface Work {
  work_id: string;
  domain_id: string;
  principal_id: string;
  manifest: QueueManifest;
  expires_at: string;
  state: string;
  attempts: number;
  max_attempts: number;
  batch_id: string | null;
}
interface Batch extends Work {
  batch_id: string;
  owner_principal_id: string;
  lease_id: string;
  lease_expires_at: string;
  candidate_id: string | null;
  qualification_id: string | null;
  evidence: unknown;
  result: unknown;
  batch_state: QueueBatchResult["state"];
}
const keys = (context: SourceContext) => candidateScope(context);
function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): void {
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
      "Candidate queue fields differ from the versioned schema",
    );
}
function integer(value: unknown, min: number, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    sourceFailure("QUEUE_LIMIT", "Candidate queue bound exceeded");
  return Number(value);
}
function list(value: unknown, max: number): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > max ||
    new Set(value).size !== value.length
  )
    sourceFailure("QUEUE_LIMIT", "Distinct bounded queue identities required");
  return value.map((id) => parseUUID(id));
}
const view = (row: Batch): QueueBatchResult => ({
  schema_version: 1,
  batch_id: row.batch_id,
  work_id: row.work_id,
  lease_id: row.lease_id,
  lease_expires_at: new Date(row.lease_expires_at).toISOString(),
  state: row.batch_state,
  manifest: row.manifest,
  candidate_id: row.candidate_id,
  qualification_id: row.qualification_id,
  evidence: row.evidence,
  result: row.result,
  attempt: row.attempts,
  max_attempts: row.max_attempts,
});

export class SourceCandidateQueue {
  constructor(
    readonly candidates: SourceCandidateService,
    readonly verifyFailedEvidence: SourceCandidateEvidenceVerifier,
  ) {}
  private async proposals(
    tx: SourceSQL,
    context: SourceContext,
    ids: readonly string[],
  ): Promise<NativeCandidateRecord[]> {
    const rows = (
      await tx.query(
        "SELECT proposal_id,manifest FROM hyperfide.source_candidate_queue_proposals WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND proposal_id=ANY($4::uuid[])",
        [...keys(context), ids],
      )
    ).rows;
    const found = new Map(
      rows.map((row) => [
        row.proposal_id,
        row.manifest as NativeCandidateRecord,
      ]),
    );
    return ids.map(
      (id) =>
        found.get(id) ??
        sourceFailure("NOT_FOUND", "Queue proposal is unavailable"),
    );
  }
  private manifest(
    candidates: NativeCandidateRecord[],
    proposalIds: string[],
  ): QueueManifest {
    const first = candidates[0]!;
    let bytes = 0;
    const contributors: CandidateContributor[] = [],
      dependencies: CandidateDependency[] = [],
      revisions = new Set<string>(),
      deps = new Map<string, CandidateDependency>();
    let executionDependencies: boolean | undefined;
    for (const candidate of candidates) {
      if (
        candidate.authority_epoch !== first.authority_epoch ||
        candidate.domain_id !== first.domain_id ||
        candidate.expected_generation !== first.expected_generation ||
        candidate.expected_revision_id !== first.expected_revision_id ||
        candidate.policy_id !== first.policy_id ||
        candidate.policy_digest !== first.policy_digest ||
        candidate.inputs.toolchain !== first.inputs.toolchain ||
        candidate.inputs.configuration !== first.inputs.configuration ||
        candidate.inputs.contract !== first.inputs.contract
      )
        sourceFailure(
          "BATCH_INPUT_MISMATCH",
          "Speculative proposals need the same pinned domain and execution context",
        );
      bytes += canonicalBytes(candidate).byteLength;
      for (const contributor of candidate.contributors) {
        if (revisions.has(contributor.revision_id))
          sourceFailure(
            "BATCH_INPUT_MISMATCH",
            "A speculative batch cannot duplicate contributors",
          );
        revisions.add(contributor.revision_id);
        contributors.push(contributor);
      }
      if (candidate.dependencies.length) {
        const full =
          candidate.dependencies[0]!.execution_dependency !== undefined;
        if (
          executionDependencies !== undefined &&
          executionDependencies !== full
        )
          sourceFailure(
            "BATCH_INPUT_MISMATCH",
            "Batch dependency proof modes cannot be mixed",
          );
        executionDependencies = full;
      }
      for (const dependency of candidate.dependencies) {
        const record = dependency.execution_dependency;
        const identity = record
          ? "execution:" +
            record.predecessor_run_id +
            ":" +
            record.predecessor_task_id
          : "revision:" + dependency.revision_id;
        const prior = deps.get(identity);
        if (prior && sourceDigest(prior) !== sourceDigest(dependency))
          sourceFailure(
            "BATCH_INPUT_MISMATCH",
            "A predecessor has conflicting pinned dependency proofs",
          );
        if (!prior) {
          deps.set(identity, dependency);
          dependencies.push(dependency);
        }
      }
    }
    const cost = {
      proposals: candidates.length,
      contributors: contributors.length,
      manifest_bytes: bytes,
      dependencies: dependencies.length,
    };
    if (
      cost.proposals > CANDIDATE_QUEUE_LIMITS.max_proposals ||
      cost.contributors > CANDIDATE_QUEUE_LIMITS.max_contributors ||
      cost.manifest_bytes > CANDIDATE_QUEUE_LIMITS.max_manifest_bytes ||
      cost.dependencies > CANDIDATE_QUEUE_LIMITS.max_dependencies
    )
      sourceFailure(
        "QUEUE_LIMIT",
        "Measured speculative batch exceeds its server budget",
      );
    return {
      schema_version: 1,
      authority_epoch: first.authority_epoch,
      domain_id: first.domain_id,
      expected_generation: first.expected_generation,
      expected_revision_id: first.expected_revision_id,
      policy_id: first.policy_id,
      policy_digest: first.policy_digest,
      proposal_ids: [...proposalIds],
      candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      contributors,
      dependencies,
      input_context: {
        toolchain: first.inputs.toolchain,
        configuration: first.inputs.configuration,
        contract: first.inputs.contract,
      },
      cost,
    };
  }
  private async pin(
    tx: SourceSQL,
    context: SourceContext,
    workId: string,
    candidates: NativeCandidateRecord[],
    expires: string,
  ): Promise<void> {
    for (const { candidate, position } of candidates
      .map((candidate, position) => ({ candidate, position }))
      .sort((a, b) =>
        a.candidate.root_tree_id.localeCompare(b.candidate.root_tree_id),
      )) {
      const row = (
        await tx.query(
          "SELECT o.current_incarnation FROM hyperfide.source_native_objects o JOIN hyperfide.source_object_placements p ON p.organisation_id=o.organisation_id AND p.repository_id=o.repository_id AND p.security_domain_id=o.security_domain_id AND p.object_id=o.object_id AND p.incarnation_id=o.current_incarnation WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.object_id=$4 AND o.state='VERIFIED' AND p.state='VERIFIED' FOR UPDATE OF o,p",
          [...keys(context), candidate.root_tree_id],
        )
      ).rows[0];
      if (!row)
        sourceFailure(
          "OBJECT_NOT_AVAILABLE",
          "Candidate queue requires retained verified roots",
        );
      await tx.query(
        "INSERT INTO hyperfide.source_object_pins(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,owner_kind,owner_id,position,expires_at) VALUES($1,$2,$3,$4,$5,'HOLD',$6,$7,$8)",
        [
          ...keys(context),
          candidate.root_tree_id,
          row.current_incarnation,
          "candidate-queue:" + workId,
          position,
          expires,
        ],
      );
    }
  }
  private async release(
    tx: SourceSQL,
    context: SourceContext,
    work: string,
  ): Promise<void> {
    await tx.query(
      "DELETE FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='HOLD' AND owner_id=$4",
      [...keys(context), "candidate-queue:" + work],
    );
  }
  private async clock(tx: SourceSQL, context: SourceContext): Promise<void> {
    await tx.query(
      "INSERT INTO hyperfide.source_candidate_queue_clock(organisation_id,repository_id,security_domain_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      keys(context),
    );
    await tx.query(
      "SELECT 1 FROM hyperfide.source_candidate_queue_clock WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR UPDATE",
      keys(context),
    );
  }
  private async addWork(
    tx: SourceSQL,
    context: SourceContext,
    candidates: NativeCandidateRecord[],
    proposalIds: string[],
    expires: string,
    attempts: number,
    maxAttempts: number,
    parent: string | null,
  ): Promise<{ work_id: string; manifest: QueueManifest }> {
    const manifest = this.manifest(candidates, proposalIds),
      work = randomUUID(),
      owner = candidates[0]!.created_by_principal_id;
    for (const principal of [
      ...new Set(
        candidates.map((candidate) => candidate.created_by_principal_id),
      ),
    ].sort()) {
      await tx.query(
        `INSERT INTO hyperfide.source_candidate_queue_owners(organisation_id,repository_id,security_domain_id,domain_id,principal_id,service_round)
       SELECT $1,$2,$3,$4,$5,service_sequence FROM hyperfide.source_candidate_queue_clock WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 ON CONFLICT DO NOTHING`,
        [...keys(context), manifest.domain_id, principal],
      );
    }
    await tx.query(
      "INSERT INTO hyperfide.source_candidate_queue_work(organisation_id,repository_id,security_domain_id,work_id,domain_id,principal_id,manifest,expires_at,state,attempts,max_attempts,parent_batch_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$11)",
      [
        ...keys(context),
        work,
        manifest.domain_id,
        owner,
        manifest,
        expires,
        attempts,
        maxAttempts,
        parent,
      ],
    );
    await tx.query(
      "UPDATE hyperfide.source_candidate_queue_owners SET pending_work=pending_work+1 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND domain_id=$4 AND principal_id=$5",
      [...keys(context), manifest.domain_id, owner],
    );
    await this.pin(tx, context, work, candidates, expires);
    return { work_id: work, manifest };
  }
  async enqueue(
    context: SourceContext,
    input: QueueEnqueueInput,
  ): Promise<{
    schema_version: 1;
    work_id: string;
    manifest: QueueManifest;
    expires_at: string;
    max_attempts: number;
  }> {
    fields(
      input,
      ["operation_id", "idempotency_key", "candidate_ids", "expires_at"],
      ["max_attempts"],
    );
    const ids = list(input.candidate_ids, CANDIDATE_QUEUE_LIMITS.max_proposals),
      attempts = integer(
        input.max_attempts ?? CANDIDATE_QUEUE_LIMITS.max_attempts,
        1,
        CANDIDATE_QUEUE_LIMITS.max_attempts,
      );
    if (
      typeof input.expires_at !== "string" ||
      !Number.isFinite(Date.parse(input.expires_at)) ||
      new Date(input.expires_at).toISOString() !== input.expires_at
    )
      sourceFailure("INVALID_REQUEST", "Canonical queue expiration required");
    return this.candidates.mutate(
      context,
      "source.queue.enqueue",
      input,
      async (tx) => {
        await this.clock(tx, context);
        const valid = (
          await tx.query(
            "SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '24 hours' AS valid",
            [input.expires_at],
          )
        ).rows[0]?.valid;
        if (!valid)
          sourceFailure(
            "QUEUE_LIMIT",
            "Queue expiration exceeds the allowed lifetime",
          );
        const candidates: NativeCandidateRecord[] = [],
          proposalIds: string[] = [];
        for (const id of ids) {
          const candidate = await this.candidates.candidateInTransaction(
              tx,
              context,
              id,
            ),
            domain = await this.candidates.domainInTransaction(
              tx,
              context,
              candidate.domain_id,
            );
          this.candidates.assertCurrentDomain(candidate, domain);
          const proposal = randomUUID();
          const inserted = await tx.query(
            "INSERT INTO hyperfide.source_candidate_queue_proposals(organisation_id,repository_id,security_domain_id,proposal_id,candidate_id,manifest_digest,created_by_principal_id,manifest,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING proposal_id",
            [
              ...keys(context),
              proposal,
              id,
              candidate.manifest_digest,
              candidate.created_by_principal_id,
              candidate,
              input.expires_at,
            ],
          );
          if (!inserted.rowCount)
            sourceFailure(
              "PROPOSAL_ALREADY_QUEUED",
              "Candidate already has a retained original queue proposal",
            );
          candidates.push(candidate);
          proposalIds.push(proposal);
        }
        const work = await this.addWork(
          tx,
          context,
          candidates,
          proposalIds,
          input.expires_at,
          0,
          attempts,
          null,
        );
        return {
          schema_version: 1,
          ...work,
          expires_at: input.expires_at,
          max_attempts: attempts,
        };
      },
    );
  }
  private async batch(
    tx: SourceSQL,
    context: SourceContext,
    id: string,
    lock = false,
    allowStale = false,
  ): Promise<Batch> {
    parseUUID(id);
    const row = (
      await tx.query(
        "SELECT b.*,b.state AS batch_state,w.domain_id,w.principal_id,w.manifest,w.expires_at,b.attempt AS attempts,w.max_attempts FROM hyperfide.source_candidate_batches b JOIN hyperfide.source_candidate_queue_work w USING(organisation_id,repository_id,security_domain_id,work_id) WHERE b.organisation_id=$1 AND b.repository_id=$2 AND b.security_domain_id=$3 AND b.batch_id=$4" +
          (lock ? " FOR UPDATE OF b,w" : ""),
        [...keys(context), id],
      )
    ).rows[0];
    if (!row) sourceFailure("NOT_FOUND", "Candidate batch is unavailable");
    if (!allowStale && row.manifest.authority_epoch !== context.authority_epoch)
      sourceFailure("STALE_AUTHORITY", "Candidate batch authority changed");
    return row as Batch;
  }
  private async lease(
    tx: SourceSQL,
    context: SourceContext,
    input: QueueBatchInput,
    states: readonly string[],
  ): Promise<Batch> {
    parseUUID(input.lease_id);
    const row = await this.batch(tx, context, input.batch_id, true);
    if (
      row.owner_principal_id !== context.principal_id ||
      row.lease_id !== input.lease_id ||
      !states.includes(row.batch_state)
    )
      sourceFailure(
        "QUEUE_LEASE_STALE",
        "Candidate batch ownership or state changed",
      );
    const fresh = (
      await tx.query(
        "SELECT $1::timestamptz>clock_timestamp() AND $2::timestamptz>clock_timestamp() AS valid",
        [row.lease_expires_at, row.expires_at],
      )
    ).rows[0]?.valid;
    if (!fresh)
      sourceFailure("QUEUE_LEASE_STALE", "Candidate batch lease expired");
    return row;
  }
  private async maintenance(
    tx: SourceSQL,
    context: SourceContext,
  ): Promise<number> {
    const expiredBatches = (
      await tx.query(
        "SELECT batch_id FROM hyperfide.source_candidate_batches WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND state IN('CLAIMED','BOUND','FAILED') AND lease_expires_at<=clock_timestamp() ORDER BY lease_expires_at,batch_id FOR UPDATE SKIP LOCKED LIMIT 64",
        keys(context),
      )
    ).rows;
    for (const expired of expiredBatches) {
      const row = await this.batch(tx, context, expired.batch_id, true, true),
        past = (
          await tx.query(
            "SELECT $1::timestamptz<=clock_timestamp() AS expired",
            [row.expires_at],
          )
        ).rows[0]?.expired;
      const state = past
        ? "EXPIRED"
        : row.attempts >= row.max_attempts
          ? "EXHAUSTED"
          : "PENDING";
      await tx.query(
        "UPDATE hyperfide.source_candidate_queue_work SET state=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND work_id=$4",
        [...keys(context), row.work_id, state],
      );
      await tx.query(
        "UPDATE hyperfide.source_candidate_batches SET state='EXPIRED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND batch_id=$4",
        [...keys(context), row.batch_id],
      );
      if (state !== "PENDING") await this.release(tx, context, row.work_id);
      else
        await tx.query(
          "UPDATE hyperfide.source_candidate_queue_owners SET pending_work=pending_work+1 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND domain_id=$4 AND principal_id=$5",
          [...keys(context), row.domain_id, row.principal_id],
        );
    }
    const pending = (
      await tx.query(
        "SELECT work_id,domain_id,principal_id FROM hyperfide.source_candidate_queue_work WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND state='PENDING' AND expires_at<=clock_timestamp() ORDER BY expires_at,work_id FOR UPDATE SKIP LOCKED LIMIT 64",
        keys(context),
      )
    ).rows;
    for (const row of pending) {
      await tx.query(
        "UPDATE hyperfide.source_candidate_queue_work SET state='EXPIRED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND work_id=$4",
        [...keys(context), row.work_id],
      );
      await tx.query(
        "UPDATE hyperfide.source_candidate_queue_owners SET pending_work=pending_work-1 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND domain_id=$4 AND principal_id=$5",
        [...keys(context), row.domain_id, row.principal_id],
      );
      await this.release(tx, context, row.work_id);
    }
    return expiredBatches.length + pending.length;
  }
  async claim(
    context: SourceContext,
    input: QueueClaimInput,
  ): Promise<{
    schema_version: 1;
    batch: QueueBatchResult | null;
    maintained: number;
  }> {
    fields(input, ["operation_id", "idempotency_key", "lease_ms"]);
    const duration = integer(
      input.lease_ms,
      1000,
      CANDIDATE_QUEUE_LIMITS.max_lease_ms,
    );
    return this.candidates.mutate(
      context,
      "source.queue.claim",
      input,
      async (tx) => {
        await this.clock(tx, context);
        const maintained = await this.maintenance(tx, context);
        for (let scan = 0; scan < 64; scan++) {
          const owner = (
            await tx.query(
              "SELECT o.* FROM hyperfide.source_candidate_queue_owners o WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.pending_work>0 AND EXISTS(SELECT 1 FROM hyperfide.source_candidate_queue_work w WHERE w.organisation_id=o.organisation_id AND w.repository_id=o.repository_id AND w.security_domain_id=o.security_domain_id AND w.domain_id=o.domain_id AND w.principal_id=o.principal_id AND w.state='PENDING' AND w.expires_at>clock_timestamp()) ORDER BY o.service_round,o.domain_id,o.principal_id FOR UPDATE SKIP LOCKED LIMIT 1",
              keys(context),
            )
          ).rows[0];
          if (!owner) return { schema_version: 1, batch: null, maintained };
          const work = (
            await tx.query(
              "SELECT * FROM hyperfide.source_candidate_queue_work WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND domain_id=$4 AND principal_id=$5 AND state='PENDING' AND expires_at>clock_timestamp() ORDER BY created_at,work_id FOR UPDATE SKIP LOCKED LIMIT 1",
              [...keys(context), owner.domain_id, owner.principal_id],
            )
          ).rows[0] as Work | undefined;
          if (!work) continue;
          await tx.query(
            "UPDATE hyperfide.source_candidate_queue_owners SET pending_work=pending_work-1 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND domain_id=$4 AND principal_id=$5",
            [...keys(context), owner.domain_id, owner.principal_id],
          );
          if (work.manifest.authority_epoch !== context.authority_epoch) {
            await tx.query(
              "UPDATE hyperfide.source_candidate_queue_work SET state='STALE' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND work_id=$4",
              [...keys(context), work.work_id],
            );
            await this.release(tx, context, work.work_id);
            continue;
          }
          const domain = await this.candidates.domainInTransaction(
            tx,
            context,
            work.domain_id,
          );
          if (
            domain.generation !== work.manifest.expected_generation ||
            domain.revision_id !== work.manifest.expected_revision_id ||
            domain.policy_digest !== work.manifest.policy_digest ||
            domain.policy_id !== work.manifest.policy_id
          ) {
            await tx.query(
              "UPDATE hyperfide.source_candidate_queue_work SET state='STALE' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND work_id=$4",
              [...keys(context), work.work_id],
            );
            await this.release(tx, context, work.work_id);
            continue;
          }
          if (work.attempts >= work.max_attempts) {
            await tx.query(
              "UPDATE hyperfide.source_candidate_queue_work SET state='EXHAUSTED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND work_id=$4",
              [...keys(context), work.work_id],
            );
            await this.release(tx, context, work.work_id);
            continue;
          }
          const batchId = randomUUID(),
            lease = randomUUID();
          await tx.query(
            "INSERT INTO hyperfide.source_candidate_batches(organisation_id,repository_id,security_domain_id,batch_id,work_id,owner_principal_id,lease_id,lease_expires_at,attempt,state) VALUES($1,$2,$3,$4,$5,$6,$7,LEAST($8::timestamptz,clock_timestamp()+$9::bigint*interval '1 millisecond'),$10,'CLAIMED')",
            [
              ...keys(context),
              batchId,
              work.work_id,
              context.principal_id,
              lease,
              work.expires_at,
              duration,
              work.attempts + 1,
            ],
          );
          await tx.query(
            "UPDATE hyperfide.source_candidate_queue_work SET state='LEASED',attempts=attempts+1,batch_id=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND work_id=$4",
            [...keys(context), work.work_id, batchId],
          );
          const original = await this.proposals(
              tx,
              context,
              work.manifest.proposal_ids,
            ),
            charges = new Map<string, number>();
          for (const proposal of original)
            charges.set(
              proposal.created_by_principal_id,
              (charges.get(proposal.created_by_principal_id) ?? 0) + 1,
            );
          const sequence = (
            await tx.query(
              "UPDATE hyperfide.source_candidate_queue_clock SET service_sequence=service_sequence+$4 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND service_sequence<=9223372036854775807-$4 RETURNING service_sequence::text AS value",
              [...keys(context), work.manifest.cost.proposals],
            )
          ).rows[0];
          if (!sequence)
            sourceFailure(
              "QUEUE_LIMIT",
              "Candidate queue service sequence is exhausted",
            );
          const start =
            BigInt(sequence.value) - BigInt(work.manifest.cost.proposals);
          for (const [principal, charge] of [...charges].sort(([a], [b]) =>
            a.localeCompare(b),
          ))
            await tx.query(
              "UPDATE hyperfide.source_candidate_queue_owners SET service_round=$6 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND domain_id=$4 AND principal_id=$5",
              [
                ...keys(context),
                owner.domain_id,
                principal,
                String(start + BigInt(charge)),
              ],
            );
          return {
            schema_version: 1,
            batch: view(await this.batch(tx, context, batchId)),
            maintained,
          };
        }
        return { schema_version: 1, batch: null, maintained };
      },
    );
  }
  async bind(
    context: SourceContext,
    input: QueueBindInput,
  ): Promise<QueueBatchResult> {
    fields(input, [
      "operation_id",
      "idempotency_key",
      "batch_id",
      "lease_id",
      "candidate_id",
    ]);
    parseUUID(input.candidate_id);
    return this.candidates.mutate(
      context,
      "source.queue.bind",
      input,
      async (tx) => {
        const row = await this.lease(tx, context, input, ["CLAIMED"]),
          candidate = await this.candidates.candidateInTransaction(
            tx,
            context,
            input.candidate_id,
          ),
          m = row.manifest;
        if (
          m.candidate_ids.includes(candidate.candidate_id) ||
          candidate.domain_id !== m.domain_id ||
          candidate.expected_generation !== m.expected_generation ||
          candidate.expected_revision_id !== m.expected_revision_id ||
          candidate.policy_id !== m.policy_id ||
          candidate.policy_digest !== m.policy_digest ||
          sourceDigest(candidate.contributors) !==
            sourceDigest(m.contributors) ||
          sourceDigest(candidate.dependencies) !==
            sourceDigest(m.dependencies) ||
          sourceDigest({
            toolchain: candidate.inputs.toolchain,
            configuration: candidate.inputs.configuration,
            contract: candidate.inputs.contract,
          }) !== sourceDigest(m.input_context)
        )
          sourceFailure(
            "BATCH_INPUT_MISMATCH",
            "Batch qualification requires a fresh candidate bound to its exact ordered proposal set",
          );
        this.candidates.assertCurrentDomain(
          candidate,
          await this.candidates.domainInTransaction(tx, context, m.domain_id),
        );
        await tx.query(
          "UPDATE hyperfide.source_candidate_batches SET candidate_id=$5,state='BOUND' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND batch_id=$4",
          [...keys(context), row.batch_id, candidate.candidate_id],
        );
        return view(await this.batch(tx, context, row.batch_id));
      },
    );
  }
  async complete(
    context: SourceContext,
    input: QueueCompleteInput,
  ): Promise<QueueBatchResult> {
    fields(input, [
      "operation_id",
      "idempotency_key",
      "batch_id",
      "lease_id",
      "qualification_id",
    ]);
    parseObjectId(input.qualification_id);
    return this.candidates.mutate(
      context,
      "source.queue.complete",
      input,
      async (tx) => {
        const row = await this.lease(tx, context, input, ["BOUND"]),
          candidate = await this.candidates.candidateInTransaction(
            tx,
            context,
            row.candidate_id!,
          );
        this.candidates.assertCurrentDomain(
          candidate,
          await this.candidates.domainInTransaction(
            tx,
            context,
            candidate.domain_id,
          ),
        );
        const qualified = await this.candidates.qualificationInTransaction(
            tx,
            context,
            input.qualification_id,
            candidate.candidate_id,
          ),
          current = await verifyCandidateEvidence(
            this.candidates.verifier,
            tx,
            context,
            candidate,
            qualified.evidence.evidence_ids,
          );
        if (sourceDigest(current) !== sourceDigest(qualified.evidence))
          sourceFailure("QUALIFICATION_STALE", "Batch qualification changed");
        await tx.query(
          "UPDATE hyperfide.source_candidate_batches SET state='PASSED',qualification_id=$5,result=$6 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND batch_id=$4",
          [
            ...keys(context),
            row.batch_id,
            qualified.qualification_id,
            qualified,
          ],
        );
        await tx.query(
          "UPDATE hyperfide.source_candidate_queue_work SET state='SUCCEEDED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND work_id=$4",
          [...keys(context), row.work_id],
        );
        await this.release(tx, context, row.work_id);
        return view(await this.batch(tx, context, row.batch_id));
      },
    );
  }
  async fail(
    context: SourceContext,
    input: QueueFailInput,
  ): Promise<QueueBatchResult> {
    fields(input, [
      "operation_id",
      "idempotency_key",
      "batch_id",
      "lease_id",
      "evidence_ids",
    ]);
    const ids = evidenceIds(input.evidence_ids);
    return this.candidates.mutate(
      context,
      "source.queue.fail",
      input,
      async (tx) => {
        const row = await this.lease(tx, context, input, ["BOUND"]),
          candidate = await this.candidates.candidateInTransaction(
            tx,
            context,
            row.candidate_id!,
          );
        const evidence = await verifyCandidateEvidence(
          this.verifyFailedEvidence,
          tx,
          context,
          candidate,
          ids,
        );
        await tx.query(
          "UPDATE hyperfide.source_candidate_batches SET state='FAILED',evidence=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND batch_id=$4",
          [...keys(context), row.batch_id, evidence],
        );
        await tx.query(
          "UPDATE hyperfide.source_candidate_queue_work SET state='FAILED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND work_id=$4",
          [...keys(context), row.work_id],
        );
        return view(await this.batch(tx, context, row.batch_id));
      },
    );
  }
  async isolate(
    context: SourceContext,
    input: QueueIsolateInput,
  ): Promise<QueueBatchResult> {
    fields(input, [
      "operation_id",
      "idempotency_key",
      "batch_id",
      "lease_id",
      "partitions",
    ]);
    if (
      !Array.isArray(input.partitions) ||
      input.partitions.length < 2 ||
      input.partitions.length > CANDIDATE_QUEUE_LIMITS.max_proposals
    )
      sourceFailure(
        "QUEUE_LIMIT",
        "Failure isolation requires two through sixteen proper partitions",
      );
    const parts = input.partitions.map((part) =>
      list(part, CANDIDATE_QUEUE_LIMITS.max_proposals),
    );
    return this.candidates.mutate(
      context,
      "source.queue.isolate",
      input,
      async (tx) => {
        await this.clock(tx, context);
        const row = await this.lease(tx, context, input, ["FAILED"]),
          flat = parts.flat(),
          original = row.manifest.proposal_ids;
        if (
          flat.length !== original.length ||
          new Set(flat).size !== flat.length ||
          sourceDigest([...flat].sort()) !==
            sourceDigest([...original].sort()) ||
          parts.some(
            (part) =>
              sourceDigest(part) !==
              sourceDigest(original.filter((id) => part.includes(id))),
          )
        )
          sourceFailure(
            "BATCH_INPUT_MISMATCH",
            "Isolation must preserve each original proposal exactly once and in order",
          );
        if (row.attempts >= row.max_attempts)
          sourceFailure(
            "QUEUE_RETRY_EXHAUSTED",
            "Candidate isolation retry budget is exhausted",
          );
        const failedCandidate = await this.candidates.candidateInTransaction(
          tx,
          context,
          row.candidate_id!,
        );
        await verifyCandidateEvidence(
          this.verifyFailedEvidence,
          tx,
          context,
          failedCandidate,
          (row.evidence as { evidence_ids: string[] }).evidence_ids,
        );
        const children = [];
        for (const part of parts) {
          const candidates = await this.proposals(tx, context, part);
          children.push(
            await this.addWork(
              tx,
              context,
              candidates,
              part,
              new Date(row.expires_at).toISOString(),
              row.attempts,
              row.max_attempts,
              row.batch_id,
            ),
          );
        }
        await tx.query(
          "UPDATE hyperfide.source_candidate_batches SET state='ISOLATED',result=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND batch_id=$4",
          [...keys(context), row.batch_id, { children }],
        );
        await tx.query(
          "UPDATE hyperfide.source_candidate_queue_work SET state='SPLIT' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND work_id=$4",
          [...keys(context), row.work_id],
        );
        await this.release(tx, context, row.work_id);
        return view(await this.batch(tx, context, row.batch_id));
      },
    );
  }
  async read(
    context: SourceContext,
    batchId: string,
  ): Promise<QueueBatchResult> {
    return this.candidates.metadata.transaction(async (tx) => {
      await this.candidates.metadata.guard(tx, context, "source.queue.read");
      return view(await this.batch(tx, context, batchId));
    });
  }
}
