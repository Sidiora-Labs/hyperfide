import { SourceControlError, parseObjectId, parseUUID } from "../contracts.js";
import type { SourceScope } from "../contracts.js";
import {
  SourceMetadata,
  sourceDigest,
  sourceScopeValues,
} from "../metadata.js";
import type { SourceContext, SourceSQL } from "../metadata.js";
import { reserveSourceOperation } from "../operations.js";
import type { SourceObjectService } from "../objects.js";
import type { PersistentTree } from "../trees.js";
import { SourceGitProjector } from "./projection.js";
import { parseProjectionPolicy } from "./provenance.js";
import type { GitProjectionMapping } from "./projection.js";
import { gitRef, rawGitOid } from "./transport.js";
import type {
  SourceGitDestination,
  SourcePublicationOptions,
} from "./types.js";

export interface CreatePublicationInput {
  operation_id: string;
  idempotency_key: string;
  acceptance_id: string;
  destination_id: string;
  target_ref: string;
  expected_old_oid: string | null;
}
export interface SourcePublicationResult {
  schema_version: 1;
  scope: SourceScope;
  operation_id: string;
  acceptance_id: string;
  revision_id: string;
  root_tree_id: string;
  destination_id: string;
  target_ref: string;
  expected_old_oid: string | null;
  git_oid: string | null;
  generation: string;
  status:
    | "QUEUED"
    | "READY"
    | "DISPATCHED"
    | "OUTCOME_UNKNOWN"
    | "PUBLISHED"
    | "REMOTE_DIVERGED"
    | "REJECTED"
    | "CANCELLED";
  code?: string;
  observed_oid?: string | null;
  checkpoint_generation?: string;
}
interface Stored {
  operation_id: string;
  authority_epoch: string;
  request: CreatePublicationInput;
  destination_key: string;
  configuration_digest: string;
  acceptance_id: string;
  acceptance_digest: string;
  revision_id: string;
  root_tree_id: string;
  target_ref: string;
  expected_old_oid: string | null;
  git_oid: string | null;
  status: SourcePublicationResult["status"];
  generation: string;
  projection_manifest: string | null;
  projection_mappings: GitProjectionMapping[] | null;
  result: SourcePublicationResult;
  operation_state: string;
  projection_lineage: string;
  base_checkpoint_generation: string | null;
}
const terminal = new Set([
  "PUBLISHED",
  "REMOTE_DIVERGED",
  "REJECTED",
  "CANCELLED",
]);
type PublicationOwner = Pick<SourceContext, "scope" | "principal_id">;
const key = (context: PublicationOwner, operation: string) => [
  ...sourceScopeValues(context.scope),
  context.principal_id,
  operation,
];

export class SourceGitPublicationService {
  private readonly projector: SourceGitProjector;
  private readonly destinations: Map<string, SourceGitDestination>;
  constructor(
    readonly metadata: SourceMetadata,
    objects: SourceObjectService,
    trees: PersistentTree,
    readonly options: SourcePublicationOptions,
  ) {
    this.projector = new SourceGitProjector(objects, trees, metadata);
    this.destinations = new Map();
    for (const destination of options.destinations) {
      if (
        !/^[A-Za-z0-9._-]{1,128}$/.test(destination.id) ||
        this.destinations.has(destination.id) ||
        !destination.repository_identity ||
        destination.allowed_refs.length < 1 ||
        destination.allowed_refs.length > 64
      )
        throw new SourceControlError(
          "INVALID_DESTINATION",
          "Publication destinations require unique bounded identifiers and explicit refs",
        );
      if (destination.projection_policy) {
        const policy = parseProjectionPolicy(destination.projection_policy);
        if (
          policy.repository_identity !== destination.repository_identity ||
          !options.authorizePath
        )
          throw new SourceControlError(
            "INVALID_DESTINATION",
            "Project publication requires its exact repository identity and path authorizer",
          );
      }
      destination.allowed_refs.forEach(gitRef);
      parseObjectId(destination.remote_key);
      parseObjectId(destination.configuration_digest);
      this.destinations.set(destination.id, destination);
    }
  }
  private destination(
    context: SourceContext,
    id: string,
    ref: string,
  ): SourceGitDestination {
    const destination = this.destinations.get(id);
    if (
      !destination ||
      sourceScopeValues(destination.scope).some(
        (value, index) => value !== sourceScopeValues(context.scope)[index],
      ) ||
      !destination.allowed_refs.includes(gitRef(ref))
    )
      throw new SourceControlError(
        "DESTINATION_DENIED",
        "Publication destination or ref is not configured",
      );
    return destination;
  }
  private binding(destination: SourceGitDestination): string {
    return sourceDigest([
      destination.scope,
      destination.provider,
      destination.repository_identity,
      destination.id,
      destination.configuration_digest,
      destination.allowed_refs,
      ...(destination.projection_policy
        ? [parseProjectionPolicy(destination.projection_policy)]
        : []),
    ]);
  }
  private async row(
    tx: SourceSQL,
    context: SourceContext,
    operation: string,
    lock = false,
  ): Promise<Stored> {
    const row = (
      await tx.query(
        `SELECT p.*,p.authority_epoch::text,p.generation::text,o.state AS operation_state FROM hyperfide.source_git_publications p JOIN hyperfide.source_metadata_operations o USING(organisation_id,repository_id,security_domain_id,principal_id,operation_id) WHERE p.organisation_id=$1 AND p.repository_id=$2 AND p.security_domain_id=$3 AND p.principal_id=$4 AND p.operation_id=$5${lock ? " FOR UPDATE OF o,p" : ""}`,
        key(context, operation),
      )
    ).rows[0] as Stored | undefined;
    if (!row)
      throw new SourceControlError(
        "NOT_FOUND",
        "Publication is unavailable in this source scope",
      );
    if (row.authority_epoch !== context.authority_epoch)
      throw new SourceControlError(
        "STALE_AUTHORITY",
        "Publication authority epoch changed",
      );
    return row;
  }
  private async accepted(
    tx: SourceSQL,
    context: SourceContext,
    row: Pick<
      Stored,
      "acceptance_id" | "revision_id" | "root_tree_id" | "acceptance_digest"
    >,
  ): Promise<void> {
    const accepted = await this.options.acceptance(
      tx,
      context,
      row.acceptance_id,
    );
    if (
      accepted.revision_id !== row.revision_id ||
      accepted.root_tree_id !== row.root_tree_id ||
      accepted.receipt_digest !== row.acceptance_digest
    )
      throw new SourceControlError(
        "ACCEPTANCE_CHANGED",
        "Publication acceptance binding changed",
      );
  }
  async create(
    context: SourceContext,
    input: CreatePublicationInput,
  ): Promise<SourcePublicationResult> {
    parseUUID(input.operation_id);
    parseUUID(input.idempotency_key);
    parseObjectId(input.acceptance_id);
    if (input.expected_old_oid !== null) rawGitOid(input.expected_old_oid);
    const destination = this.destination(
        context,
        input.destination_id,
        input.target_ref,
      ),
      configuration = this.binding(destination),
      request = {
        acceptance_id: input.acceptance_id,
        destination_id: input.destination_id,
        target_ref: input.target_ref,
        expected_old_oid: input.expected_old_oid,
      },
      digest = sourceDigest(request),
      destinationKey = destination.remote_key;
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.publications.create");
      const accepted = await this.options.acceptance(
        tx,
        context,
        input.acceptance_id,
      );
      const operation = await reserveSourceOperation(tx, context, {
        operation_id: input.operation_id,
        idempotency_key: input.idempotency_key,
        action: "source.publications.create",
        request_digest: digest,
      });
      const prior = (
        await tx.query(
          "SELECT result FROM hyperfide.source_git_publications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5",
          key(context, operation.operation_id),
        )
      ).rows[0];
      if (prior) return prior.result as SourcePublicationResult;
      if (operation.state !== "PENDING")
        throw new SourceControlError(
          "OPERATION_CANCELLED",
          "Publication operation is terminal",
        );
      await tx.query(
        "INSERT INTO hyperfide.source_git_targets(destination_key,target_ref) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [destinationKey, input.target_ref],
      );
      const target = (
        await tx.query(
          "SELECT active_operation_id FROM hyperfide.source_git_targets WHERE destination_key=$1 AND target_ref=$2 FOR UPDATE",
          [destinationKey, input.target_ref],
        )
      ).rows[0]!;
      if (target.active_operation_id)
        throw new SourceControlError(
          "PUBLICATION_BUSY",
          "Destination ref has an unresolved publication",
        );
      const base = (
        await tx.query(
          "SELECT projection_lineage,checkpoint_generation::text FROM hyperfide.source_git_publications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND destination_key=$4 AND target_ref=$5 AND git_oid=$6 AND status='PUBLISHED' ORDER BY checkpoint_generation DESC LIMIT 1",
          [
            ...sourceScopeValues(context.scope),
            destinationKey,
            input.target_ref,
            input.expected_old_oid,
          ],
        )
      ).rows[0];
      const protection = await this.metadata.protectRoot(
        tx,
        context.scope,
        accepted.root_tree_id,
        "publication:" + operation.operation_id,
      );
      const result: SourcePublicationResult = {
        schema_version: 1,
        scope: { ...context.scope },
        operation_id: operation.operation_id,
        ...request,
        revision_id: accepted.revision_id,
        root_tree_id: accepted.root_tree_id,
        git_oid: null,
        generation: "1",
        status: "QUEUED",
      };
      await tx.query(
        "INSERT INTO hyperfide.source_git_publications(organisation_id,repository_id,security_domain_id,principal_id,operation_id,authority_epoch,request,destination_key,configuration_digest,target_ref,acceptance_id,revision_id,root_tree_id,acceptance_digest,expected_old_oid,status,root_protection,result,projection_lineage,base_checkpoint_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'QUEUED',$16,$17,$18,$19)",
        [
          ...key(context, operation.operation_id),
          context.authority_epoch,
          { ...input, operation_id: operation.operation_id },
          destinationKey,
          configuration,
          input.target_ref,
          input.acceptance_id,
          accepted.revision_id,
          accepted.root_tree_id,
          accepted.receipt_digest,
          input.expected_old_oid,
          protection,
          result,
          base?.projection_lineage ?? operation.operation_id,
          base?.checkpoint_generation ?? null,
        ],
      );
      await tx.query(
        "UPDATE hyperfide.source_git_targets SET active_operation_id=$3,active_organisation_id=$4,active_repository_id=$5,active_security_domain_id=$6,active_principal_id=$7 WHERE destination_key=$1 AND target_ref=$2",
        [
          destinationKey,
          input.target_ref,
          operation.operation_id,
          ...sourceScopeValues(context.scope),
          context.principal_id,
        ],
      );
      return result;
    });
  }
  async read(
    context: SourceContext,
    operationId: string,
  ): Promise<SourcePublicationResult> {
    parseUUID(operationId);
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.publications.read");
      const row = (
        await tx.query(
          "SELECT result,authority_epoch::text FROM hyperfide.source_git_publications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5",
          key(context, operationId),
        )
      ).rows[0];
      if (!row)
        throw new SourceControlError(
          "NOT_FOUND",
          "Publication is unavailable in this source scope",
        );
      if (BigInt(row.authority_epoch) > BigInt(context.authority_epoch))
        throw new SourceControlError(
          "STALE_AUTHORITY",
          "Publication belongs to a later authority epoch",
        );
      return row.result as SourcePublicationResult;
    });
  }
  private async snapshot(
    context: SourceContext,
    operationId: string,
  ): Promise<Stored> {
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.publications.resume");
      const row = await this.row(tx, context, operationId);
      const destination = this.destination(
        context,
        row.request.destination_id,
        row.target_ref,
      );
      if (this.binding(destination) !== row.configuration_digest)
        throw new SourceControlError(
          "DESTINATION_CHANGED",
          "Publication destination configuration changed",
        );
      if (row.status === "QUEUED" || row.status === "READY")
        await this.accepted(tx, context, row);
      return row;
    });
  }
  private async transition(
    tx: SourceSQL,
    context: PublicationOwner,
    row: Stored,
    status: SourcePublicationResult["status"],
    extra: Partial<SourcePublicationResult> = {},
    storage: {
      git_oid?: string;
      projection_manifest?: string;
      projection_mappings?: readonly GitProjectionMapping[];
      credential_expires_at?: string | null;
      checkpoint_generation?: string;
    } = {},
  ): Promise<SourcePublicationResult> {
    const result = {
      ...row.result,
      ...extra,
      status,
      generation: String(BigInt(row.generation) + 1n),
    };
    await tx.query(
      "UPDATE hyperfide.source_git_publications SET status=$6,generation=generation+1,result=$7,git_oid=COALESCE($8,git_oid),projection_manifest=COALESCE($9,projection_manifest),projection_mappings=COALESCE($10::jsonb,projection_mappings),credential_expires_at=CASE WHEN $11::boolean THEN $12::timestamptz ELSE credential_expires_at END,checkpoint_generation=COALESCE($13::bigint,checkpoint_generation),updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5",
      [
        ...key(context, row.operation_id),
        status,
        result,
        storage.git_oid ?? null,
        storage.projection_manifest ?? null,
        storage.projection_mappings
          ? JSON.stringify(storage.projection_mappings)
          : null,
        Object.hasOwn(storage, "credential_expires_at"),
        storage.credential_expires_at ?? null,
        storage.checkpoint_generation ?? null,
      ],
    );
    return result;
  }
  private async settle(
    context: SourceContext,
    operationId: string,
    status: SourcePublicationResult["status"],
    extra: Partial<SourcePublicationResult> = {},
    preDispatchOnly = false,
  ): Promise<SourcePublicationResult> {
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.publications.resume");
      const row = await this.row(tx, context, operationId, true);
      if (terminal.has(row.status)) return row.result;
      if (
        preDispatchOnly &&
        (row.status === "DISPATCHED" || row.status === "OUTCOME_UNKNOWN")
      )
        return row.result;
      if (status === "OUTCOME_UNKNOWN" && row.status === "OUTCOME_UNKNOWN")
        return row.result;
      return this.settleLocked(tx, context, row, status, extra);
    });
  }
  private async settleLocked(
    tx: SourceSQL,
    context: PublicationOwner,
    row: Stored,
    status: SourcePublicationResult["status"],
    extra: Partial<SourcePublicationResult> = {},
  ): Promise<SourcePublicationResult> {
    if (terminal.has(status)) {
      const target = (
        await tx.query(
          "SELECT active_operation_id,active_organisation_id,active_repository_id,active_security_domain_id,active_principal_id FROM hyperfide.source_git_targets WHERE destination_key=$1 AND target_ref=$2 FOR UPDATE",
          [row.destination_key, row.target_ref],
        )
      ).rows[0];
      if (
        !target ||
        target.active_operation_id !== row.operation_id ||
        target.active_organisation_id !== context.scope.organisation_id ||
        target.active_repository_id !== context.scope.repository_id ||
        target.active_security_domain_id !== context.scope.security_domain_id ||
        target.active_principal_id !== context.principal_id
      )
        throw new SourceControlError(
          "PUBLICATION_FENCED",
          "Publication lost its exact destination ownership",
        );
    }
    let checkpoint: string | undefined;
    if (status === "PUBLISHED") {
      const target = (
        await tx.query(
          "UPDATE hyperfide.source_git_targets SET checkpoint_generation=checkpoint_generation+1,git_oid=$3 WHERE destination_key=$1 AND target_ref=$2 AND active_operation_id=$4 RETURNING checkpoint_generation::text",
          [row.destination_key, row.target_ref, row.git_oid, row.operation_id],
        )
      ).rows[0];
      if (!target)
        throw new SourceControlError(
          "PUBLICATION_FENCED",
          "Publication lost destination ownership",
        );
      checkpoint = target.checkpoint_generation;
      for (
        let start = 0;
        start < (row.projection_mappings?.length ?? 0);
        start += 256
      )
        await tx.query(
          "INSERT INTO hyperfide.source_git_mappings(organisation_id,repository_id,security_domain_id,principal_id,operation_id,native_kind,native_id,mapping) SELECT $1,$2,$3,$4,$5,m.native_kind,m.native_id,m.mapping FROM jsonb_to_recordset($6::jsonb) AS m(native_kind text,native_id text,mapping jsonb) ON CONFLICT DO NOTHING",
          [
            ...key(context, row.operation_id),
            JSON.stringify(
              row
                .projection_mappings!.slice(start, start + 256)
                .map((mapping) => ({
                  native_kind: mapping.native_kind,
                  native_id: mapping.native_id,
                  mapping,
                })),
            ),
          ],
        );
    }
    const result = await this.transition(
      tx,
      context,
      row,
      status,
      {
        ...extra,
        ...(checkpoint ? { checkpoint_generation: checkpoint } : {}),
      },
      checkpoint ? { checkpoint_generation: checkpoint } : {},
    );
    if (terminal.has(status)) {
      const state =
        status === "PUBLISHED"
          ? "COMMITTED"
          : status === "CANCELLED"
            ? "CANCELLED"
            : "FAILED";
      await tx.query(
        "UPDATE hyperfide.source_metadata_operations SET state=$6,result=CASE WHEN $6='COMMITTED' THEN $7::jsonb ELSE NULL END,result_digest=CASE WHEN $6='COMMITTED' THEN $8 ELSE NULL END,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5",
        [
          ...key(context, row.operation_id),
          state,
          result,
          sourceDigest(result),
        ],
      );
      await tx.query(
        "UPDATE hyperfide.source_git_targets SET active_operation_id=NULL,active_organisation_id=NULL,active_repository_id=NULL,active_security_domain_id=NULL,active_principal_id=NULL WHERE destination_key=$1 AND target_ref=$2 AND active_operation_id=$3",
        [row.destination_key, row.target_ref, row.operation_id],
      );
    }
    return result;
  }
  private async reconcile(
    context: SourceContext,
    row: Stored,
    signal?: AbortSignal,
  ): Promise<SourcePublicationResult> {
    const destination = this.destination(
      context,
      row.request.destination_id,
      row.target_ref,
    );
    let observed: string | null;
    try {
      observed = await destination.transport.observe(row.target_ref, signal);
    } catch {
      return this.settle(context, row.operation_id, "OUTCOME_UNKNOWN", {
        code: "REMOTE_OBSERVATION_FAILED",
      });
    }
    if (observed === row.git_oid && row.git_oid !== null)
      return this.settle(context, row.operation_id, "PUBLISHED", {
        observed_oid: observed,
      });
    if (observed !== row.expected_old_oid)
      return this.settle(context, row.operation_id, "OUTCOME_UNKNOWN", {
        code: "REMOTE_DIVERGED_INFLIGHT",
        observed_oid: observed,
      });
    return this.settle(context, row.operation_id, "OUTCOME_UNKNOWN", {
      code: "ISSUED_PUSH_UNRESOLVED",
      observed_oid: observed,
    });
  }
  async resume(
    context: SourceContext,
    operationId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SourcePublicationResult> {
    parseUUID(operationId);
    let row = await this.snapshot(context, operationId);
    if (terminal.has(row.status)) return row.result;
    if (row.status === "DISPATCHED" || row.status === "OUTCOME_UNKNOWN")
      return this.reconcile(context, row, options.signal);
    const destination = this.destination(
      context,
      row.request.destination_id,
      row.target_ref,
    );
    options.signal?.throwIfAborted();
    const observed = await destination.transport.observe(
      row.target_ref,
      options.signal,
    );
    if (observed !== row.expected_old_oid)
      return this.settle(
        context,
        operationId,
        "REMOTE_DIVERGED",
        { code: "REMOTE_DIVERGED", observed_oid: observed },
        true,
      );
    const checkpoint = row.base_checkpoint_generation;
    const authorizedRevisions = new Set<string>();
    const projected = await this.projector.project(context, row.revision_id, {
      ...(destination.projection_policy
        ? {
            policy: destination.projection_policy,
            authorize_path: async (path: string) => {
              await this.metadata.transaction((tx) =>
                this.options.authorizePath!(tx, context, path),
              );
            },
          }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      authorize_revision: async (revision) => {
        await this.metadata.transaction((tx) =>
          this.options.authorizeRevision(tx, context, revision.revision_id),
        );
        authorizedRevisions.add(revision.revision_id);
      },
      ...(checkpoint
        ? {
            lookup_confirmed_mapping: async (nativeKind, nativeId) =>
              this.metadata.transaction(async (tx) => {
                await this.metadata.guard(
                  tx,
                  context,
                  "source.publications.resume",
                );
                return (
                  await tx.query(
                    "SELECT m.mapping FROM hyperfide.source_git_mappings m JOIN hyperfide.source_git_publications p USING(organisation_id,repository_id,security_domain_id,principal_id,operation_id) WHERE m.organisation_id=$1 AND m.repository_id=$2 AND m.security_domain_id=$3 AND p.destination_key=$4 AND p.target_ref=$5 AND p.status='PUBLISHED' AND p.checkpoint_generation<=$6 AND m.native_kind=$7 AND m.native_id=$8 AND p.projection_lineage=$9 ORDER BY p.checkpoint_generation DESC LIMIT 1",
                    [
                      ...sourceScopeValues(context.scope),
                      row.destination_key,
                      row.target_ref,
                      checkpoint,
                      nativeKind,
                      nativeId,
                      row.projection_lineage,
                    ],
                  )
                ).rows[0]?.mapping as GitProjectionMapping | undefined;
              }),
          }
        : {}),
    });
    if (
      row.expected_old_oid !== null &&
      !projected.reachable_commit_oids.some(
        (oid) => oid === row.expected_old_oid,
      )
    )
      throw new SourceControlError(
        "NON_FAST_FORWARD",
        "Publication target does not retain the expected remote head",
      );
    row = await this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.publications.resume");
      const current = await this.row(tx, context, operationId, true);
      if (terminal.has(current.status)) return current;
      if (current.status === "QUEUED") {
        await this.transition(
          tx,
          context,
          current,
          "READY",
          { git_oid: projected.head_oid },
          {
            git_oid: projected.head_oid,
            projection_manifest: projected.manifest_digest,
            projection_mappings: projected.mappings,
          },
        );
        return this.row(tx, context, operationId);
      }
      if (current.git_oid !== projected.head_oid)
        throw new SourceControlError(
          "PROJECTION_CHANGED",
          "Publication projection identity changed",
        );
      return current;
    });
    if (row.status !== "READY")
      return terminal.has(row.status)
        ? row.result
        : this.reconcile(context, row, options.signal);
    const credential = (await destination.transport.authorize?.()) ?? null;
    const admitted = await this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.publications.resume");
      const current = await this.row(tx, context, operationId, true);
      if (current.status !== "READY") return false;
      await this.accepted(tx, context, current);
      for (const revisionId of authorizedRevisions)
        await this.options.authorizeRevision(tx, context, revisionId);
      if (credential && Date.parse(credential.expires_at) <= Date.now())
        throw new SourceControlError(
          "EXPIRED_CREDENTIAL",
          "Publication credential expired before dispatch",
        );
      await this.transition(
        tx,
        context,
        current,
        "DISPATCHED",
        {},
        { credential_expires_at: credential?.expires_at ?? null },
      );
      return true;
    });
    if (!admitted) return this.read(context, operationId);
    let pushed;
    try {
      pushed = await destination.transport.push({
        target_ref: row.target_ref,
        expected_old_oid: row.expected_old_oid,
        new_oid: projected.head_oid,
        objects: projected.objects,
        credential,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      pushed = { outcome: "UNKNOWN", code: "TRANSPORT_INTERRUPTED" };
    }
    if (pushed.outcome === "REJECTED")
      return this.settle(
        context,
        operationId,
        pushed.code === "REMOTE_DIVERGED" ? "REMOTE_DIVERGED" : "REJECTED",
        { code: pushed.code },
      );
    return this.reconcile(
      context,
      await this.snapshot(context, operationId),
      options.signal,
    );
  }
  async reconcileRecovery(
    operatorContext: SourceContext,
    input: { operation_id: string; principal_id: string },
    signal?: AbortSignal,
  ): Promise<SourcePublicationResult> {
    const checkCancellation = () => {
      if (signal?.aborted)
        throw new SourceControlError(
          "OPERATION_INTERRUPTED",
          "Publication recovery observation was cancelled",
        );
    };
    checkCancellation();
    parseUUID(input.operation_id, "operation_id");
    parseUUID(input.principal_id, "principal_id");
    const owner: PublicationOwner = {
      scope: operatorContext.scope,
      principal_id: input.principal_id,
    };
    const load = async (tx: SourceSQL, lock = false): Promise<Stored> => {
      const row = (
        await tx.query(
          `SELECT p.*,p.authority_epoch::text,p.generation::text,o.state AS operation_state FROM hyperfide.source_git_publications p JOIN hyperfide.source_metadata_operations o USING(organisation_id,repository_id,security_domain_id,principal_id,operation_id) WHERE p.organisation_id=$1 AND p.repository_id=$2 AND p.security_domain_id=$3 AND p.principal_id=$4 AND p.operation_id=$5${lock ? " FOR UPDATE OF o,p" : ""}`,
          key(owner, input.operation_id),
        )
      ).rows[0] as Stored | undefined;
      if (!row)
        throw new SourceControlError(
          "NOT_FOUND",
          "Publication is unavailable in the recovery scope",
        );
      if (BigInt(row.authority_epoch) > BigInt(operatorContext.authority_epoch))
        throw new SourceControlError(
          "STALE_AUTHORITY",
          "Recovery authority precedes the publication epoch",
        );
      if (!terminal.has(row.status) && row.operation_state !== "PENDING")
        throw new SourceControlError(
          "PUBLICATION_FENCED",
          "Publication operation is no longer pending",
        );
      return row;
    };
    const initial = await this.metadata.transaction(async (tx) => {
      await this.metadata.guard(
        tx,
        operatorContext,
        "source.recovery.reconcile",
      );
      const row = await load(tx, true);
      checkCancellation();
      if (terminal.has(row.status)) return { result: row.result };
      if (row.status === "QUEUED" || row.status === "READY")
        return {
          result: await this.settleLocked(tx, owner, row, "CANCELLED", {
            code: "RECOVERY_PREISSUE_CANCELLED",
          }),
        };
      const destination = this.destination(
        operatorContext,
        row.request.destination_id,
        row.target_ref,
      );
      if (this.binding(destination) !== row.configuration_digest)
        throw new SourceControlError(
          "DESTINATION_CHANGED",
          "Recovery destination differs from the issued publication",
        );
      return { row, destination };
    });
    if ("result" in initial) return initial.result;
    let observed: string | null = null;
    let observedSuccessfully = false;
    try {
      observed = await initial.destination.transport.observe(
        initial.row.target_ref,
        signal,
      );
      observedSuccessfully = true;
    } catch {}
    checkCancellation();
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(
        tx,
        operatorContext,
        "source.recovery.reconcile",
      );
      const row = await load(tx, true);
      checkCancellation();
      if (terminal.has(row.status)) return row.result;
      const destination = this.destination(
        operatorContext,
        row.request.destination_id,
        row.target_ref,
      );
      if (this.binding(destination) !== row.configuration_digest)
        throw new SourceControlError(
          "DESTINATION_CHANGED",
          "Recovery destination differs from the issued publication",
        );
      if (
        observedSuccessfully &&
        row.git_oid !== null &&
        observed === row.git_oid
      )
        return this.settleLocked(tx, owner, row, "PUBLISHED", {
          code: "RECOVERY_CONFIRMED",
          observed_oid: observed,
        });
      if (row.status === "OUTCOME_UNKNOWN") return row.result;
      return this.settleLocked(tx, owner, row, "OUTCOME_UNKNOWN", {
        code: observedSuccessfully
          ? "RECOVERY_ISSUED_PUSH_UNRESOLVED"
          : "RECOVERY_OBSERVATION_FAILED",
        ...(observedSuccessfully ? { observed_oid: observed } : {}),
      });
    });
  }
  async cancel(
    context: SourceContext,
    operationId: string,
  ): Promise<SourcePublicationResult> {
    parseUUID(operationId);
    const row = await this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.publications.cancel");
      return this.row(tx, context, operationId);
    });
    if (terminal.has(row.status)) return row.result;
    if (row.status === "DISPATCHED" || row.status === "OUTCOME_UNKNOWN")
      return this.reconcile(context, row);
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.publications.cancel");
      const current = await this.row(tx, context, operationId, true);
      if (
        terminal.has(current.status) ||
        current.status === "DISPATCHED" ||
        current.status === "OUTCOME_UNKNOWN"
      )
        return current.result;
      const result = await this.transition(tx, context, current, "CANCELLED");
      await tx.query(
        "UPDATE hyperfide.source_metadata_operations SET state='CANCELLED',result=NULL,result_digest=NULL,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5",
        [...key(context, operationId)],
      );
      await tx.query(
        "UPDATE hyperfide.source_git_targets SET active_operation_id=NULL,active_organisation_id=NULL,active_repository_id=NULL,active_security_domain_id=NULL,active_principal_id=NULL WHERE destination_key=$1 AND target_ref=$2 AND active_operation_id=$3",
        [current.destination_key, current.target_ref, operationId],
      );
      return result;
    });
  }
}
