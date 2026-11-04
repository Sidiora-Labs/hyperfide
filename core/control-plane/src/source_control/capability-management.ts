import { parseGeneration, parseObjectId, parseUUID, SourceControlError } from "./contracts.js";
import {
  grantSourceCapability,
  revokeSourceCapability,
  type SourceAuthorization,
  type SourceCapabilityInput,
} from "./capabilities.js";
import { appendSourceAudit, sourceAuditRecord } from "./audit.js";
import { reserveSourceOperation } from "./operations.js";
import {
  sourceDigest,
  sourceScopeValues,
  type SourceMetadata,
} from "./metadata.js";

function record(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new SourceControlError(
      "INVALID_REQUEST",
      "Capability management fields differ from the versioned schema",
    );
  return value as Record<string, unknown>;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum)
    throw new SourceControlError(
      "LIMIT_EXCEEDED",
      "Capability list exceeds its bound",
    );
  return value;
}
export async function manageSourceCapability(
  metadata: SourceMetadata,
  context: SourceAuthorization,
  input: unknown,
  operationId: string,
  idempotencyKey: string | undefined,
) {
  const value = record(
    input,
    ["operation", "capability", "capability_id"],
    ["operation"],
  );
  let grant: SourceCapabilityInput | undefined;
  let capabilityId: string;
  if (value.operation === "grant") {
    if (value.capability_id !== undefined)
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Grant uses the capability object",
      );
    const c = record(
      value.capability,
      [
        "id",
        "principal_id",
        "credential_id",
        "principal_kind",
        "authority_epoch",
        "policy_version",
        "actions",
        "path_prefixes",
        "revision_ids",
        "managed_binding",
        "expires_at",
      ],
      [
        "principal_id",
        "credential_id",
        "principal_kind",
        "authority_epoch",
        "policy_version",
        "actions",
        "path_prefixes",
        "expires_at",
      ],
    );
    capabilityId =
      c.id === undefined ? operationId : parseUUID(c.id, "capability_id");
    if (
      !["human", "automation", "import", "worker", "service"].includes(
        String(c.principal_kind),
      ) ||
      typeof c.authority_epoch !== "string" ||
      typeof c.policy_version !== "string" ||
      typeof c.expires_at !== "string" ||
      !Number.isFinite(Date.parse(c.expires_at)) ||
      new Date(c.expires_at).toISOString() !== c.expires_at
    )
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Explicit canonical capability identity, policy and expiry required",
      );
    const actions = list(c.actions, 64),
      prefixes = list(c.path_prefixes, 256);
    if (
      actions.some((a) => typeof a !== "string") ||
      prefixes.some((p) => typeof p !== "string")
    )
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Capability actions and paths must be strings",
      );
    const revisions =
      c.revision_ids === undefined
        ? undefined
        : list(c.revision_ids, 256).map(parseObjectId);
    grant = {
      scope: context.scope,
      id: capabilityId,
      principal_id: parseUUID(c.principal_id, "principal_id"),
      credential_id: parseUUID(c.credential_id, "credential_id"),
      principal_kind:
        c.principal_kind as SourceCapabilityInput["principal_kind"],
      authority_epoch: c.authority_epoch,
      policy_version: c.policy_version,
      actions: actions as string[],
      path_prefixes: prefixes as string[],
      expires_at: c.expires_at,
      ...(revisions ? { revision_ids: revisions } : {}),
    };
    if (c.managed_binding !== undefined) {
      const binding = record(
        c.managed_binding,
        [
          "workspace_id",
          "generation",
          "task_id",
          "attempt_id",
          "attempt_generation",
        ],
        ["workspace_id", "generation"],
      );
      grant.managed_binding = {
        workspace_id: parseUUID(binding.workspace_id, "workspace_id"),
        generation: parseGeneration(binding.generation),
        ...(binding.task_id !== undefined
          ? { task_id: parseUUID(binding.task_id, "task_id") }
          : {}),
        ...(binding.attempt_id !== undefined
          ? { attempt_id: parseUUID(binding.attempt_id, "attempt_id") }
          : {}),
        ...(binding.attempt_generation !== undefined
          ? { attempt_generation: parseGeneration(binding.attempt_generation) }
          : {}),
      };
    }
  } else if (value.operation === "revoke") {
    if (value.capability !== undefined)
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Revoke accepts only a capability identity",
      );
    capabilityId = parseUUID(value.capability_id, "capability_id");
  } else
    throw new SourceControlError(
      "INVALID_REQUEST",
      "Capability operation must be grant or revoke",
    );
  parseUUID(operationId, "operation_id");
  if (!idempotencyKey)
    throw new SourceControlError(
      "INVALID_REQUEST",
      "Capability mutations require a stable idempotency key",
    );
  const digest = sourceDigest(value);
  return metadata.transaction(async (tx) => {
    await metadata.guard(tx, context, "source.capabilities.manage");
    const operation = await reserveSourceOperation(tx, context, {
      operation_id: operationId,
      idempotency_key: idempotencyKey,
      action: "source.capabilities.manage",
      request_digest: digest,
    });
    if (operation.state === "COMMITTED") return operation.result;
    if (operation.state !== "PENDING")
      throw new SourceControlError(
        "OPERATION_CANCELLED",
        "Capability operation is terminal",
      );
    let changed: boolean;
    if (grant) {
      if (
        (
          await tx.query(
            "SELECT 1 FROM hyperfide.source_capabilities WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND id=$4",
            [...sourceScopeValues(context.scope), capabilityId],
          )
        ).rows.length
      )
        throw new SourceControlError(
          "CONFLICT",
          "Capability identity already exists",
        );
      await grantSourceCapability(tx, context, grant);
      changed = true;
    } else changed = await revokeSourceCapability(tx, context, capabilityId);
    const result = {
      schema_version: 1,
      operation: value.operation,
      capability_id: capabilityId,
      changed,
    };
    await appendSourceAudit(
      tx,
      sourceAuditRecord(context, {
        action: "source.capabilities.manage",
        operation_id: operationId,
        request_digest: digest,
        result: "SUCCEEDED",
      }),
    );
    await tx.query(
      "UPDATE hyperfide.source_metadata_operations SET state='COMMITTED',result=$6,result_digest=$7,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5 AND state='PENDING'",
      [
        ...sourceScopeValues(context.scope),
        context.principal_id,
        operationId,
        result,
        sourceDigest(result),
      ],
    );
    return result;
  });
}
