import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createSignedSourceClient,
  type SignedSourceConfiguration,
} from "@hyperfide/authority";
import {
  SourceControlError,
  type SourceAuthority,
  type SourceControlClient,
  type SourceAction,
} from "@hyperfide/source-control";
import {
  SourceMetrics,
  type SourceMetricAction,
  type SourceMetricLabels,
} from "../../core/host-daemon/src/source-control/metrics.js";
import {
  sourceActionSchema,
  sourceCheckpointReceiptMatches,
  type SourceActionInput,
  type SourceProductResponse,
  type SourceClosureReadiness,
} from "./contract.js";

export async function loadSourceClient(filename: string): Promise<{
  client: SourceControlClient;
  authority?: SourceAuthority;
  assignment?: Record<string, unknown>;
}> {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename)
    throw new Error("An absolute source configuration path is required");
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: any;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > 131072 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0
    )
      throw new Error(
        "Source configuration must be a bounded protected regular file",
      );
    const bytes = Buffer.alloc(131073);
    let size = 0;
    for (;;) {
      const part = await file.read(bytes, size, bytes.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
      if (size > 131072)
        throw new Error("Source configuration exceeds its bound");
    }
    const after = await file.stat();
    if (
      size !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("Source configuration changed while reading");
    value = JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally {
    await file.close();
  }
  if (value.transport) {
    if (
      value.schema_version !== 1 ||
      !value.assignment ||
      typeof value.assignment !== "object" ||
      Object.keys(value).some(
        (key) => !["schema_version", "transport", "assignment"].includes(key),
      )
    )
      throw new Error("Invalid worker source configuration");
  }
  const transport = (value.transport ?? value) as SignedSourceConfiguration;
  const client = await createSignedSourceClient(transport);
  if (
    value.assignment?.scope &&
    JSON.stringify(value.assignment.scope) !== JSON.stringify(transport.scope)
  ) {
    const expected = transport.scope,
      actual = value.assignment.scope;
    if (
      actual.organisation_id !== expected.organisation_id ||
      actual.repository_id !== expected.repository_id ||
      actual.security_domain_id !== expected.security_domain_id
    )
      throw new Error("Assignment source scope differs from transport");
  }
  return {
    client,
    ...(value.assignment?.authority
      ? { authority: value.assignment.authority }
      : {}),
    ...(value.assignment ? { assignment: value.assignment } : {}),
  };
}
function childOperation(operationId: string, phase: string): string {
  const bytes = createHash("sha256")
    .update(operationId + ":" + phase)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export async function sourceClosureReadiness(
  client: SourceControlClient,
  action: {
    revisionId: string;
    readPaths: string[];
    dependencyPaths?: string[];
  },
  authority?: SourceAuthority,
): Promise<SourceClosureReadiness> {
  const options = authority ? { authority } : {};
  const revision = await client.call<{ root_tree_id: string }>(
    "source.revisions.read",
    { revision_id: action.revisionId },
    options,
  );
  const required = [...new Set(action.dependencyPaths ?? [])];
  const missingPaths: string[] = [],
    outsideScope: string[] = [];
  for (const path of required) {
    if (
      !action.readPaths.some(
        (prefix) => path === prefix || path.startsWith(prefix + "/"),
      )
    ) {
      outsideScope.push(path);
      continue;
    }
    const result = await client.call<{ entry: unknown | null }>(
      "source.trees.lookup",
      { tree_id: revision.root_tree_id, path },
      options,
    );
    if (!result.entry) missingPaths.push(path);
  }
  return {
    state: missingPaths.length || outsideScope.length ? "INCOMPLETE" : "READY",
    revisionId: action.revisionId,
    checkedPaths: required.length,
    missingPaths,
    outsideScope,
  };
}
export const sourceProductMetrics = new SourceMetrics(14);
const recentProductOperations = new Map<string, string>();
function productMetricAction(action: SourceActionInput): SourceMetricAction {
  if (
    ["open", "checkpoint", "submit", "qualify", "accept"].includes(action.kind)
  )
    return action.kind as SourceMetricAction;
  if (["merge", "resolve-conflict"].includes(action.kind)) return "transform";
  if (["publish", "publication"].includes(action.kind)) return "publish";
  if (
    ["operation", "resume-publication", "complete-transfer"].includes(
      action.kind,
    )
  )
    return "resume";
  if (
    ["cancel-operation", "cancel-publication", "cancel-transfer"].includes(
      action.kind,
    )
  )
    return "cancel";
  return "read";
}
export async function executeSourceAction(
  binding: Awaited<ReturnType<typeof loadSourceClient>>,
  operationId: string,
  input: SourceActionInput,
): Promise<SourceProductResponse> {
  const action = sourceActionSchema.parse(input),
    { client, authority } = binding;
  const call = (name: SourceAction, value: unknown, id = operationId) =>
    client.call(name, value, {
      operation_id: id,
      idempotency_key: id,
      ...(authority ? { authority } : {}),
    });
  const metricAction = productMetricAction(action),
    started = performance.now();
  let release: (() => void) | undefined;
  let labels: SourceMetricLabels = {
    mode: action.kind === "open" ? action.mode : "UNKNOWN",
    status: "success",
    partition: [
      "merge",
      "resolve-conflict",
      "qualify",
      "accept",
      "submit",
    ].includes(action.kind)
      ? "INTEGRATION"
      : ["publish", "resume-publication", "publication"].includes(action.kind)
        ? "REMOTE"
        : "REQUEST",
  };
  try {
    release = sourceProductMetrics.admit(metricAction);
    const integration =
      labels.partition === "INTEGRATION" || labels.partition === "REMOTE";
    if (
      integration &&
      (recentProductOperations.get(operationId) === action.kind ||
        action.kind === "resume-publication" ||
        action.kind === "resolve-conflict")
    )
      sourceProductMetrics.increment("integrationRetries", 1, {
        ...labels,
        partition: "INTEGRATION",
      });
    if (integration) {
      recentProductOperations.set(operationId, action.kind);
      if (recentProductOperations.size > 256)
        recentProductOperations.delete(
          recentProductOperations.keys().next().value!,
        );
    }
    let result: unknown;
    switch (action.kind) {
      case "readiness":
        result = await sourceClosureReadiness(client, action, authority);
        break;
      case "service-metrics": {
        const sample = await call("source.metrics.read", {
          max_rows: action.maxRows ?? 1024,
        });
        result = {
          ...(sample as object),
          product_requests: sourceProductMetrics.snapshot(),
        };
        break;
      }
      case "revision":
        result = await call("source.revisions.read", {
          revision_id: action.revisionId,
        });
        break;
      case "history":
        result = await call("source.queries.history", {
          revision_id: action.revisionId,
          limit: 50,
          ...(action.cursor ? { cursor: action.cursor } : {}),
        });
        break;
      case "diff":
        result = await call("source.queries.diff", {
          before_revision_id: action.beforeRevisionId,
          after_revision_id: action.afterRevisionId,
          limit: 50,
          ...(action.cursor ? { cursor: action.cursor } : {}),
        });
        break;
      case "open": {
        const readiness = await sourceClosureReadiness(
          client,
          action,
          authority,
        );
        if (readiness.state !== "READY")
          throw new SourceControlError(
            "DEPENDENCY_CLOSURE_INCOMPLETE",
            "Dependency closure is incomplete. Include every required path in the read scope and select a revision containing those paths.",
            "NEVER",
            "KNOWN",
            { readiness },
          );
        result = await call("source.workspaces.open", {
          workspace_id: action.workspaceId,
          base_revision_id: action.revisionId,
          read_paths: action.readPaths,
          write_paths: action.writePaths,
          mode: action.mode,
        });
        result = { ...(result as object), readiness };
        break;
      }
      case "workspace":
        result = await call("source.workspaces.detail", {
          workspace_id: action.workspaceId,
        });
        break;
      case "file": {
        const entry = (await call("source.objects.read", {
          revision_id: action.revisionId,
          path: action.path,
        })) as {
          kind: "file" | "directory" | "symlink";
          path: string;
          content_base64: string;
          byte_length: string;
          content_digest?: string;
          mode: string;
        };
        if (entry.kind !== "file")
          throw new SourceControlError(
            "INVALID_REQUEST",
            "Select a regular source file",
          );
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.from(entry.content_base64, "base64"),
          );
        } catch {
          throw new SourceControlError(
            "BINARY_FILE",
            "Use the source SDK to read binary content",
          );
        }
        result = {
          path: entry.path,
          content,
          size: Number(entry.byte_length),
          digest: entry.content_digest,
          mode: entry.mode,
        };
        break;
      }
      case "checkpoint": {
        const bytes = Buffer.from(action.content),
          digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
        const blob = (await call(
          "source.objects.put",
          { kind: "blob", payload_base64: bytes.toString("base64") },
          childOperation(operationId, "blob"),
        )) as { object_id: string };
        const descriptor = Buffer.from(
          JSON.stringify([
            1,
            String(bytes.length),
            digest,
            ["blob", blob.object_id],
          ]),
        );
        const file = (await call(
          "source.objects.put",
          { kind: "file", payload_base64: descriptor.toString("base64") },
          childOperation(operationId, "file"),
        )) as { object_id: string };
        result = await call("source.workspaces.checkpoint", {
          workspace_id: action.workspaceId,
          operation_id: operationId,
          expected_workspace_generation: action.workspaceGeneration,
          expected_scope_generation: action.scopeGeneration,
          base_revision_id: action.baseRevisionId,
          overlay_generation: action.overlayGeneration,
          changes: [
            {
              path: action.path,
              operation: "put",
              kind: "file",
              mode: action.executable ? "100755" : "100644",
              object_id: file.object_id,
            },
          ],
        });
        if (!sourceCheckpointReceiptMatches(operationId, action, result))
          throw new SourceControlError(
            "CHECKPOINT_RECEIPT",
            "Checkpoint response does not bind the retained operation and workspace generation. Reconcile the same operation.",
            "RETRY_SAME_OPERATION",
            "UNKNOWN",
          );
        break;
      }
      case "assignment":
        result = await call("source.fleet.read", {
          assignment_id: action.assignmentId,
        });
        break;
      case "submit":
        result = await call("source.fleet.submit", {
          assignment_id: action.assignmentId,
          expected_assignment_generation: action.assignmentGeneration,
          expected_workspace_generation: action.workspaceGeneration,
          revision_id: action.revisionId,
        });
        break;
      case "merge":
        result = await call("source.transforms.merge", {
          ours_revision_id: action.oursRevisionId,
          theirs_revision_id: action.theirsRevisionId,
          change_id: childOperation(operationId, "merge-change"),
          provenance: {
            author: { name: "Source control", email: "" },
            message: "Merge source revisions",
            timestamp: action.createdAt,
          },
        });
        break;
      case "transformation":
        result = await call("source.transforms.read", {
          operation_id: action.transformationId,
        });
        break;
      case "resolve-conflict": {
        const resolved = (await call("source.revisions.read", {
          revision_id: action.resolvedRevisionId,
        })) as { root_tree_id: string };
        result = await call("source.transforms.resume", {
          operation_id: action.transformationId,
          expected_generation: action.expectedGeneration,
          resolution: {
            conflict_id: action.conflictId,
            resolved_tree_id: resolved.root_tree_id,
          },
        });
        break;
      }
      case "candidate":
        result = await call("source.candidates.read", {
          candidate_id: action.candidateId,
        });
        break;
      case "qualify":
        result = await call("source.candidates.qualify", {
          candidate_id: action.candidateId,
          evidence_ids: action.evidenceIds,
        });
        break;
      case "accept":
        result = await call("source.acceptance.accept", {
          candidate_id: action.candidateId,
          qualification_id: action.qualificationId,
        });
        break;
      case "publish":
        result = await call("source.publications.create", {
          acceptance_id: action.acceptanceId,
          destination_id: action.destinationId,
          target_ref: action.targetRef,
          expected_old_oid: action.expectedOldOid,
        });
        break;
      case "transfer":
        result = await call("source.transfers.read", {
          transfer_id: action.transferId,
        });
        break;
      case "complete-transfer":
        result = await call("source.transfers.complete", {
          transfer_id: action.transferId,
          object_id: action.objectId,
        });
        break;
      case "cancel-transfer":
        result = await call("source.transfers.cancel", {
          transfer_id: action.transferId,
        });
        break;
      case "publication":
        result = await call("source.publications.read", {
          operation_id: action.publicationId,
        });
        break;
      case "resume-publication":
        result = await call("source.publications.resume", {
          operation_id: action.publicationId,
        });
        break;
      case "cancel-publication":
        result = await call("source.publications.cancel", {
          operation_id: action.publicationId,
        });
        break;
      case "operation":
        result = await call("source.operations.read", {
          operation_id: action.operationId,
        });
        break;
      case "cancel-operation":
        result = await call("source.operations.cancel", {
          operation_id: action.operationId,
        });
        break;
    }
    if (result && typeof result === "object" && "grant" in result) {
      const { grant: _secret, ...publicResult } = result as Record<
        string,
        unknown
      >;
      result = publicResult;
    }
    if (result && typeof result === "object" && "workspace" in result) {
      const workspace = result.workspace as {
        mode?: SourceMetricLabels["mode"];
      };
      if (workspace.mode) labels = { ...labels, mode: workspace.mode };
    }
    sourceProductMetrics.record(
      metricAction,
      "success",
      performance.now() - started,
      action.kind === "checkpoint" ? Buffer.byteLength(action.content) : 0,
      labels,
    );
    return { ok: true, operationId, result };
  } catch (error) {
    sourceProductMetrics.record(
      metricAction,
      error instanceof SourceControlError && error.outcome === "KNOWN"
        ? "rejected"
        : "unknown",
      performance.now() - started,
      0,
      {
        ...labels,
        status:
          error instanceof SourceControlError && error.outcome === "KNOWN"
            ? "rejected"
            : "unknown",
      },
    );
    if (error instanceof SourceControlError)
      return {
        ok: false,
        operationId,
        error: {
          code: error.code,
          message: error.message,
          retry: error.retry,
          outcome: error.outcome,
          ...(error.details ? { details: error.details } : {}),
        },
      };
    throw error;
  } finally {
    release?.();
  }
}
