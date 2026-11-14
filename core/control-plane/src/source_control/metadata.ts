import { assertSourceRecoveryAdmission } from "./recovery.js";
import { assertNativeWriteAdmission } from "./migration/write_admission.js";
import { createHash } from "node:crypto";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import { FoundationError } from "../policy/programme.js";
import { StorageError } from "../storage/transactions.js";
import {
  canonicalBytes,
  canonicalEnvelope,
  parseGeneration,
  parseObjectId,
  parsePublicProvenance,
  parseUUID,
  SourceControlError,
} from "./contracts.js";
import type { PublicProvenance, SourceScope } from "./contracts.js";
import { protectSourceRoot } from "./object_catalog.js";
import {
  changeRevisions,
  createRevisionInTransaction,
  readRevisionInTransaction,
} from "./revisions.js";
import {
  beginSourceOperation,
  cancelSourceOperation,
  readSourceOperation,
  replaySourceOperation,
} from "./operations.js";
import type { BeginSourceOperation } from "./operations.js";
import {
  acknowledgeSourceEvent,
  createSourceSubscription,
  pollSourceEvents,
} from "./events.js";
import type {
  SourceAcknowledgment,
  SourceSubscriptionInput,
} from "./events.js";

export interface SourceSQL {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: any[],
  ): Promise<QueryResult<R>>;
}
export interface SourceContext {
  scope: SourceScope;
  principal_id: string;
  authority_epoch: string;
  expires_at: string;
  workspace?: { workspace_id: string; generation: string };
  capability_id?: string;
  policy_version?: string;
  assertCurrent?: (tx: SourceSQL, action?: string) => Promise<void>;
}
export interface SourceRepository {
  authority_epoch: string;
  policy_version: string;
  durability_profile: string;
}
export interface RevisionDescriptor {
  schema_version: 1;
  scope: SourceScope;
  root_tree_id: string;
  parent_revision_ids: string[];
  provenance: PublicProvenance;
}
export interface SourceRevisionRecord {
  revision_id: string;
  root_tree_id: string;
  parent_revision_ids: string[];
  descriptor: RevisionDescriptor;
  authority_epoch: string;
  created_at: string;
  generation: string;
  index_complete: boolean;
}
export interface RevisionInput {
  operation_id: string;
  idempotency_key: string;
  change_id: string;
  root_tree_id: string;
  parent_revision_ids: string[];
  predecessor_revision_ids: string[];
  provenance: PublicProvenance;
}
export interface RevisionReceipt {
  schema_version: 1;
  scope: SourceScope;
  operation_id: string;
  revision_id: string;
  root_tree_id: string;
  change_id: string;
  authority_epoch: string;
  durability_profile: string;
  result_digest: string;
  causal_token: string;
}
export interface SourceMetadataOptions {
  replica?: Pick<Pool, "connect">;
  replica_wait_ms?: number;
  read_authority?: SourceMetadata;
  authorize?: (
    tx: SourceSQL,
    context: SourceContext,
    action: string,
  ) => Promise<void>;
  protectRoot?: (
    tx: SourceSQL,
    scope: SourceScope,
    treeId: string,
    revisionId: string,
  ) => Promise<unknown>;
  transaction_timeout_ms?: number;
  transaction?: <T>(body: (tx: SourceSQL) => Promise<T>) => Promise<T>;
}
class SourceTransactionFailure extends FoundationError {
  constructor(readonly source: SourceControlError) {
    super(source.code, source.message);
  }
}
export const sourceScopeValues = (scope: SourceScope): string[] => [
  scope.organisation_id,
  scope.repository_id,
  scope.security_domain_id,
];
export const sourceDigest = (value: unknown): string =>
  "sha256:" + createHash("sha256").update(canonicalBytes(value)).digest("hex");
export function sourceFailure(code: string, message: string): never {
  throw new SourceControlError(code, message);
}
function metadataGeneration(value: string): void {
  parseGeneration(value);
  if (BigInt(value) < 1n)
    sourceFailure("INVALID_REQUEST", "Authority epoch must be positive");
  if (BigInt(value) > 9223372036854775807n)
    sourceFailure(
      "LIMIT_EXCEEDED",
      "Authority epoch exceeds the selected metadata backend range",
    );
}
export function validateScope(scope: SourceScope): void {
  for (const key of [
    "organisation_id",
    "repository_id",
    "security_domain_id",
  ] as const)
    parseUUID(scope?.[key], key);
  if (Object.keys(scope).length !== 3)
    sourceFailure(
      "INVALID_REQUEST",
      "Source scope accepts only organization, repository and security domain",
    );
}
export function revisionDescriptor(
  scope: SourceScope,
  input: RevisionInput,
): RevisionDescriptor {
  validateScope(scope);
  parseObjectId(input.root_tree_id);
  parseUUID(input.operation_id, "operation_id");
  parseUUID(input.change_id, "change_id");
  if (
    typeof input.idempotency_key !== "string" ||
    !input.idempotency_key.length ||
    Buffer.byteLength(input.idempotency_key) > 256
  )
    sourceFailure("INVALID_REQUEST", "Bounded idempotency key required");
  for (const ids of [
    input.parent_revision_ids,
    input.predecessor_revision_ids,
  ]) {
    if (
      !Array.isArray(ids) ||
      ids.length > 256 ||
      new Set(ids).size !== ids.length
    )
      sourceFailure(
        "INVALID_REQUEST",
        "Unique bounded revision references required",
      );
    for (const id of ids) parseObjectId(id);
  }
  return {
    schema_version: 1,
    scope: { ...scope },
    root_tree_id: input.root_tree_id,
    parent_revision_ids: [...input.parent_revision_ids],
    provenance: parsePublicProvenance(input.provenance),
  };
}
export function revisionIdentity(descriptor: RevisionDescriptor): string {
  const p = descriptor.provenance;
  const tuple = [
    1,
    sourceScopeValues(descriptor.scope),
    descriptor.root_tree_id,
    descriptor.parent_revision_ids,
    [p.author.name, p.author.email, p.message, p.timestamp],
  ];
  return (
    "sha256:" +
    createHash("sha256")
      .update(canonicalEnvelope("revision", canonicalBytes(tuple)))
      .digest("hex")
  );
}
export function revisionRequestDigest(
  scope: SourceScope,
  input: RevisionInput,
): string {
  return sourceDigest([
    1,
    revisionDescriptor(scope, input),
    input.change_id,
    input.predecessor_revision_ids,
  ]);
}
export class SourceMetadata {
  readonly pool: Pool;
  readonly options: SourceMetadataOptions;
  constructor(pool: Pool, options: SourceMetadataOptions = {}) {
    this.pool = pool;
    this.options = options;
  }
  async transaction<T>(fn: (tx: SourceSQL) => Promise<T>): Promise<T> {
    if (this.options.transaction) {
      try {
        return await this.options.transaction(async (tx) => {
          try {
            return await fn(tx);
          } catch (error) {
            if (error instanceof SourceControlError)
              throw new SourceTransactionFailure(error);
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof SourceTransactionFailure) throw error.source;
        if (
          !(error instanceof SourceControlError) &&
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "COMMIT_AMBIGUOUS"
        )
          throw new SourceControlError(
            "COMMIT_AMBIGUOUS",
            "Resolve the original operation identity before retrying source mutation",
            "RETRY_SAME_OPERATION",
            "UNKNOWN",
          );
        throw error;
      }
    }
    const tx = await this.pool.connect();
    let committing = false;
    try {
      await tx.query("BEGIN");
      await tx.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
        [String(this.options.transaction_timeout_ms ?? 10000)],
      );
      const result = await fn(tx);
      committing = true;
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await tx.query("ROLLBACK");
      } catch {}
      if (committing && !(error instanceof SourceControlError))
        throw new SourceControlError(
          "COMMIT_AMBIGUOUS",
          "Resolve the original operation identity before retrying source mutation",
          "RETRY_SAME_OPERATION",
          "UNKNOWN",
        );
      throw error;
    } finally {
      tx.release();
    }
  }
  async ancestryIndexAvailable(tx: SourceSQL): Promise<boolean> {
    return (
      (
        await tx.query(
          "SELECT to_regclass('hyperfide.source_revision_ancestry') IS NOT NULL AS present",
        )
      ).rows[0]?.present === true
    );
  }
  async ancestryIndex(
    context: SourceContext,
    revisionId: string,
  ): Promise<SourceRevisionRecord[]> {
    return this.transaction(async (tx) => {
      await this.guard(tx, context, "source.revisions.read");
      if (!(await this.ancestryIndexAvailable(tx))) return [];
      const rows = (
        await tx.query(
          `SELECT r.revision_id,r.root_tree_id,r.descriptor,r.authority_epoch::text,r.created_at,r.generation::text,r.index_complete
        FROM hyperfide.source_revision_ancestry a JOIN hyperfide.source_revisions r
        ON r.organisation_id=a.organisation_id AND r.repository_id=a.repository_id AND r.security_domain_id=a.security_domain_id AND r.revision_id=a.ancestor_revision_id
        WHERE a.organisation_id=$1 AND a.repository_id=$2 AND a.security_domain_id=$3 AND a.revision_id=$4 ORDER BY a.position`,
          [...sourceScopeValues(context.scope), revisionId],
        )
      ).rows;
      return rows.map(
        (row) =>
          ({
            ...row,
            parent_revision_ids: row.descriptor.parent_revision_ids,
            created_at: new Date(row.created_at).toISOString(),
          }) as SourceRevisionRecord,
      );
    });
  }
  async guard(
    tx: SourceSQL,
    context: SourceContext,
    action: string,
    exclusive = false,
  ): Promise<SourceRepository> {
    if (this.options.read_authority) {
      if (exclusive)
        sourceFailure(
          "PRIMARY_REQUIRED",
          "Replica snapshots cannot admit exclusive actions",
        );
      const profile = await this.options.read_authority.transaction((primary) =>
        this.options.read_authority!.guard(primary, context, action),
      );
      const row = (
        await tx.query(
          "SELECT authority_epoch::text,policy_version FROM hyperfide.source_repositories WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
          sourceScopeValues(context.scope),
        )
      ).rows[0];
      if (
        row?.authority_epoch !== profile.authority_epoch ||
        row.policy_version !== profile.policy_version
      )
        sourceFailure(
          "STALE_CAUSAL_TOKEN",
          "Replica snapshot authority differs from the current primary",
        );
      return profile;
    }
    validateScope(context.scope);
    parseUUID(context.principal_id, "principal_id");
    metadataGeneration(context.authority_epoch);
    if (!Number.isFinite(Date.parse(context.expires_at)))
      sourceFailure("INVALID_REQUEST", "Explicit authority expiry required");
    const authorize =
      this.options.authorize ??
      (context.assertCurrent
        ? async (sql: SourceSQL, c: SourceContext, a: string) =>
            c.assertCurrent!(sql, a)
        : null);
    if (!authorize)
      sourceFailure(
        "SOURCE_ACCESS_DENIED",
        "Authenticated source authorization callback required",
      );
    try {
      await authorize(tx, context, action);
    } catch (error) {
      if (
        action === "source.revisions.create" &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        [
          "AUTH_STALE_ATTEMPT",
          "AUTH_STALE_SESSION",
          "STALE_COMPUTE",
          "COMPUTE_LEASE_EXPIRED",
        ].includes(String(error.code))
      )
        sourceFailure(
          "STALE_AUTHORITY",
          "Revision mutation requires the current live attempt generation",
        );
      throw error;
    }
    const row = (
      await tx.query(
        `SELECT authority_epoch::text,policy_version,durability_profile,clock_timestamp()<$4::timestamptz AS unexpired FROM hyperfide.source_repositories WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR ${exclusive ? "UPDATE" : "SHARE"}`,
        [...sourceScopeValues(context.scope), context.expires_at],
      )
    ).rows[0];
    if (
      !row ||
      row.authority_epoch !== context.authority_epoch ||
      row.unexpired !== true ||
      (context.policy_version !== undefined &&
        row.policy_version !== context.policy_version)
    )
      sourceFailure(
        "STALE_AUTHORITY",
        "Source authority epoch, policy or expiry changed",
      );
    await assertNativeWriteAdmission(tx, context, action);
    await assertSourceRecoveryAdmission(tx, context.scope, action);
    return {
      authority_epoch: row.authority_epoch,
      policy_version: row.policy_version,
      durability_profile: row.durability_profile,
    };
  }
  async registerRepository(
    scope: SourceScope,
    profile: SourceRepository,
  ): Promise<void> {
    validateScope(scope);
    metadataGeneration(profile.authority_epoch);
    if (
      ![profile.policy_version, profile.durability_profile].every(
        (v) =>
          typeof v === "string" &&
          Buffer.byteLength(v) > 0 &&
          Buffer.byteLength(v) <= 256,
      )
    )
      sourceFailure(
        "INVALID_REQUEST",
        "Explicit bounded repository policy and durability profiles required",
      );
    await this.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO hyperfide.source_repositories(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version,durability_profile) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [
          ...sourceScopeValues(scope),
          profile.authority_epoch,
          profile.policy_version,
          profile.durability_profile,
        ],
      );
      const row = (
        await tx.query(
          "SELECT authority_epoch::text,policy_version,durability_profile FROM hyperfide.source_repositories WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
          sourceScopeValues(scope),
        )
      ).rows[0];
      if (
        row?.authority_epoch !== profile.authority_epoch ||
        row.policy_version !== profile.policy_version ||
        row.durability_profile !== profile.durability_profile
      )
        sourceFailure(
          "CONFLICT",
          "Repository is registered with another authority or durability profile",
        );
    });
  }
  async protectRoot(
    tx: SourceSQL,
    scope: SourceScope,
    treeId: string,
    revisionId: string,
  ): Promise<unknown> {
    return this.options.protectRoot
      ? this.options.protectRoot(tx, scope, treeId, revisionId)
      : protectSourceRoot(tx, scope, treeId, revisionId);
  }
  async createRevision(
    context: SourceContext,
    input: RevisionInput,
  ): Promise<RevisionReceipt> {
    try {
      return await this.transaction((tx) =>
        this.createRevisionInTransaction(tx, context, input),
      );
    } catch (error) {
      if (
        error instanceof StorageError &&
        error.code === "TX_RETRY_EXHAUSTED" &&
        error.outcome === "aborted" &&
        error.sqlstate === "40001"
      ) {
        const replay = await this.transaction((tx) =>
          replaySourceOperation(this, tx, context, {
            operation_id: input.operation_id,
            idempotency_key: input.idempotency_key,
            action: "source.revisions.create",
            request_digest: revisionRequestDigest(context.scope, input),
          }),
        );
        if (replay) return replay.result as RevisionReceipt;
      }
      throw error;
    }
  }
  async createRevisionInTransaction(
    tx: SourceSQL,
    context: SourceContext,
    input: RevisionInput,
  ): Promise<RevisionReceipt> {
    return createRevisionInTransaction(this, tx, context, input);
  }
  async readRevision(
    context: SourceContext,
    revisionId: string,
  ): Promise<SourceRevisionRecord> {
    return this.transaction((tx) =>
      this.readRevisionInTransaction(tx, context, revisionId),
    );
  }
  async readRevisionInTransaction(
    tx: SourceSQL,
    context: SourceContext,
    revisionId: string,
  ): Promise<SourceRevisionRecord> {
    return readRevisionInTransaction(this, tx, context, revisionId);
  }
  async changeRevisions(
    context: SourceContext,
    changeId: string,
    page: { after?: string; limit?: number } = {},
  ) {
    return changeRevisions(this, context, changeId, page);
  }
  async operation(context: SourceContext, operationId: string) {
    return readSourceOperation(this, context, operationId);
  }
  async beginOperation(context: SourceContext, input: BeginSourceOperation) {
    return beginSourceOperation(this, context, input);
  }
  async cancel(context: SourceContext, operationId: string) {
    return cancelSourceOperation(this, context, operationId);
  }
  async subscribe(context: SourceContext, input: SourceSubscriptionInput) {
    return createSourceSubscription(this, context, input);
  }
  async pollEvents(
    context: SourceContext,
    input: {
      consumer_id: string;
      subscription_epoch: string;
      limit?: number;
      lease_ms?: number;
    },
  ) {
    return pollSourceEvents(this, context, input);
  }
  async acknowledgeEvent(context: SourceContext, input: SourceAcknowledgment) {
    return acknowledgeSourceEvent(this, context, input);
  }
}
export function createSourceMetadata(
  pool: Pool,
  options: SourceMetadataOptions = {},
): SourceMetadata {
  return new SourceMetadata(pool, options);
}
