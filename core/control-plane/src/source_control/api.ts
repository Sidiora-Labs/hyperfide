import { manageSourceCapability } from "./capability-management.js";
import { readSourceAudit } from "./audit.js";
import { runSourceReadBatch } from "./batch.js";
import { withSourceCausalRead } from "./causal.js";
import type { InvocationContext } from "../transport/protocol.js";
import {
  parseObjectId,
  parseRepositoryPath,
  parseSourceRequest,
  parseUUID,
  SourceControlError,
  SOURCE_CAPABILITIES,
  SOURCE_FORMAT,
  type SourceAuthority,
  type SourceAction,
  type SourceRequest,
  type SourceScope,
} from "./contracts.js";
import type { SourceAuthorization, SourcePrincipal } from "./capabilities.js";
import type {
  SourceContext,
  SourceMetadata,
  RevisionInput,
} from "./metadata.js";
import { decodeFileDescriptor, type SourceObjectService } from "./objects.js";
import type { PersistentTree } from "./trees.js";
import { SourceCursorCodec, type SourceCursorBinding } from "./cursors.js";
import {
  SourceQueries,
  SourcePathSelection,
  type QueryBudget,
  type QueryRevision,
} from "./queries.js";
import { assertManagedObjectUploads } from "./managed-objects.js";
import { readSourceLifecycle } from "./acceptance.js";

export const SOURCE_API_ACTIONS = [
  "source.capabilities",
  "source.capabilities.manage",
  "source.audit.read",
  "source.objects.put",
  "source.objects.read",
  "source.objects.inspect",
  "source.uploads.prepare",
  "source.uploads.complete",
  "source.trees.entries",
  "source.trees.lookup",
  "source.trees.patch",
  "source.revisions.create",
  "source.revisions.read",
  "source.changes.revisions",
  "source.operations.read",
  "source.operations.cancel",
  "source.queries.batch",
  "source.queries.ancestry",
  "source.queries.merge-bases",
  "source.queries.history",
  "source.queries.diff",
  "source.queries.blame",
  "source.queries.line-map",
  "source.subscriptions.create",
  "source.subscriptions.poll",
  "source.subscriptions.ack",
  "source.lifecycle.read",
] as const;
export type SourceAdmissionClass =
  | "upload"
  | "query"
  | "event"
  | "acceptance"
  | "mutation";
const sourceMutation = (action: string) =>
  /\.(put|patch|create|open|prepare|complete|cancel|checkpoint|widen|close|ack|manage|merge|rebase|revert|resume|configure|qualify|accept|publish|revoke|bind-run|assign|submit|select|acquire|release|discover|collect|build|reserve|reconcile|consolidate|parity|quiesce|activate|abort|recover|verify|move|stage|refresh|register|enqueue|claim|bind|fail|isolate)$/.test(
    action,
  );
export function sourceAdmissionClass(
  action: SourceAction,
): SourceAdmissionClass {
  if (action.startsWith("source.subscriptions.")) return "event";
  if (
    action === "source.objects.put" ||
    action.startsWith("source.uploads.") ||
    action.startsWith("source.transfers.")
  )
    return "upload";
  if (
    sourceMutation(action) &&
    [
      "source.acceptance.",
      "source.candidates.",
      "source.domains.",
      "source.assurance.",
      "source.queue.",
    ].some((prefix) => action.startsWith(prefix))
  )
    return "acceptance";
  return sourceMutation(action) ? "mutation" : "query";
}
const partialPathRead = (action: string) =>
  [
    "source.queries.diff",
    "source.queries.history",
    "source.trees.entries",
  ].includes(action);
function queryPaths(input: Record<string, unknown>): string[] {
  if (input.paths === undefined) return [""];
  if (
    !Array.isArray(input.paths) ||
    !input.paths.length ||
    input.paths.length > 256
  )
    throw new SourceControlError(
      "INVALID_REQUEST",
      "Path filters require one through 256 repository prefixes",
    );
  return [
    ...new Set(
      input.paths.map((path) => (path === "" ? "" : parseRepositoryPath(path))),
    ),
  ];
}
export type SourceApiPrincipal = (InvocationContext | SourcePrincipal) & {
  signal?: AbortSignal;
};
export interface SourceApiAuthorizationRequest {
  invocation?: InvocationContext;
  principal?: SourcePrincipal;
  scope: SourceScope;
  action: string;
  paths?: readonly string[];
  revision_id?: string;
  object_id?: string;
  mutation: boolean;
  authority?: SourceAuthority;
}
export interface SourceApiDependencies {
  objects: SourceObjectService;
  trees: PersistentTree;
  metadata: SourceMetadata;
  cursorKey: Uint8Array;
  authorize(
    request: SourceApiAuthorizationRequest,
  ): Promise<SourceAuthorization>;
  invokeBatchMember?: (
    request: SourceRequest,
    parent: InvocationContext,
    signal: AbortSignal,
  ) => Promise<unknown>;
  workspaceOperation?: (
    context: SourceContext,
    operationId: string,
  ) => Promise<unknown | null>;
  extensions?: Readonly<
    Record<
      string,
      (
        request: SourceRequest,
        context: SourceAuthorization,
        principal: SourceApiPrincipal,
      ) => Promise<unknown>
    >
  >;
}
function value(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new SourceControlError(
      "INVALID_REQUEST",
      "Source operation input must be an object",
    );
  return input as Record<string, unknown>;
}
function objectView(input: unknown): unknown {
  if (input === null) return null;
  const row = value(input),
    result: Record<string, unknown> = {};
  for (const field of [
    "organisation_id",
    "repository_id",
    "security_domain_id",
    "object_id",
    "kind",
    "size_bytes",
    "incarnation_id",
    "generation",
    "state",
    "upload_id",
    "operation_id",
    "status",
    "expires_at",
  ])
    if (row[field] !== undefined) result[field] = row[field];
  return result;
}
function fields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(input, key))
  )
    throw new SourceControlError(
      "INVALID_REQUEST",
      "Source action fields differ from its versioned schema",
    );
}
function limit(input: unknown, fallback = 128): number {
  if (input === undefined) return fallback;
  if (!Number.isSafeInteger(input) || Number(input) < 1 || Number(input) > 256)
    throw new SourceControlError(
      "LIMIT_EXCEEDED",
      "Page size must be an integer between one and 256",
    );
  return Number(input);
}
function base64(input: unknown): Buffer {
  if (typeof input !== "string" || input.length > 12 * 1024 * 1024)
    throw new SourceControlError(
      "INVALID_ENCODING",
      "Canonical bounded base64 content required",
    );
  const bytes = Buffer.from(input, "base64");
  if (
    bytes.length > SOURCE_FORMAT.max_object_bytes ||
    bytes.toString("base64") !== input
  )
    throw new SourceControlError(
      "INVALID_ENCODING",
      "Noncanonical or excessive base64 content",
    );
  return bytes;
}
function queryBudget(
  input: unknown,
  principal: SourceApiPrincipal,
): QueryBudget {
  const b = input === undefined ? {} : value(input);
  fields(b, ["max_nodes", "max_bytes", "max_ms"], []);
  return {
    max_nodes: b.max_nodes === undefined ? 1024 : (b.max_nodes as number),
    max_bytes: b.max_bytes === undefined ? 4194304 : (b.max_bytes as number),
    max_ms: b.max_ms === undefined ? 5000 : (b.max_ms as number),
    ...("signal" in principal ? { signal: principal.signal } : {}),
  };
}
function requestPaths(
  action: string,
  input: Record<string, unknown>,
): string[] | undefined {
  if (action === "source.objects.read" && input.path !== undefined)
    return [parseRepositoryPath(input.path)];
  if (action === "source.fleet.manifest" && Array.isArray(input.paths))
    return input.paths.map((path) =>
      path === "" ? "" : parseRepositoryPath(path),
    );
  if (action === "source.transfers.create" && Array.isArray(input.paths))
    return input.paths.map((path) =>
      path === "" ? "" : parseRepositoryPath(path),
    );
  if (action === "source.graph.build") {
    if (
      !Array.isArray(input.paths) ||
      !input.paths.length ||
      input.paths.length > 256
    )
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Graph build requires bounded explicit paths",
      );
    return input.paths.map((path) =>
      path === "" ? "" : parseRepositoryPath(path),
    );
  }
  if (action === "source.graph.query" && input.path !== undefined)
    return [parseRepositoryPath(input.path)];
  if (
    [
      "source.transforms.",
      "source.domains.",
      "source.candidates.",
      "source.acceptance.",
      "source.lifecycle.",
      "source.assurance.",
      "source.publications.",
    ].some((prefix) => action.startsWith(prefix))
  )
    return [""];
  if (action === "source.workspaces.detail" && input.path !== undefined)
    return [parseRepositoryPath(input.path)];
  if (
    [
      "source.workspaces.open",
      "source.workspaces.create",
      "source.workspaces.widen",
    ].includes(action)
  ) {
    if (
      !Array.isArray(input.read_paths) ||
      !input.read_paths.length ||
      input.read_paths.length > 256
    )
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Workspace requires explicit bounded source paths",
      );
    return input.read_paths.map((path) =>
      path === "" ? "" : parseRepositoryPath(path),
    );
  }
  if (action === "source.workspaces.checkpoint") {
    if (!Array.isArray(input.changes) || input.changes.length > 256)
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "Workspace checkpoint requires a bounded explicit patch",
      );
    return input.changes.map((change) =>
      parseRepositoryPath(value(change).path),
    );
  }
  if (
    [
      "source.trees.lookup",
      "source.queries.blame",
      "source.queries.line-map",
    ].includes(action)
  )
    return [parseRepositoryPath(input.path)];
  if (action === "source.trees.patch") {
    if (!Array.isArray(input.patches) || input.patches.length > 256)
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "Tree patch must be a bounded explicit change set",
      );
    return input.patches.map((patch) => parseRepositoryPath(value(patch).path));
  }
  return undefined;
}
export function createSourceApi(dependencies: SourceApiDependencies) {
  const cursors = new SourceCursorCodec(dependencies.cursorKey),
    extensions = dependencies.extensions ?? {};
  const supported = [...SOURCE_API_ACTIONS, ...Object.keys(extensions)];
  const api = {
    actions: supported,
    async invoke(
      action: string,
      raw: unknown,
      principal: SourceApiPrincipal,
    ): Promise<unknown> {
      const request = parseSourceRequest(raw);
      if (request.action !== action || !supported.includes(action))
        throw new SourceControlError(
          "UNSUPPORTED_ACTION",
          "Source action is unavailable",
        );
      const input = value(request.input),
        mutation = sourceMutation(action),
        partial = partialPathRead(action);
      const filters = partial ? queryPaths(input) : undefined;
      const paths = partial ? [""] : requestPaths(action, input);
      const authorize = (witness?: string) =>
        dependencies.authorize({
          scope: request.scope,
          action,
          mutation,
          ...("operation" in principal
            ? { invocation: principal }
            : { principal }),
          ...(witness !== undefined
            ? { paths: [witness] }
            : paths
              ? { paths }
              : {}),
          ...(typeof input.revision_id === "string"
            ? { revision_id: input.revision_id }
            : {}),
          ...(typeof input.object_id === "string"
            ? { object_id: input.object_id }
            : {}),
          ...(request.authority ? { authority: request.authority } : {}),
        });
      let authorization: SourceAuthorization,
        witness = "";
      try {
        authorization = await authorize();
      } catch (error) {
        if (
          !partial ||
          !(error instanceof SourceControlError) ||
          error.code !== "SCOPE_DENIED"
        )
          throw error;
        const candidates = await dependencies.metadata.transaction(
          async (tx) =>
            (
              await tx.query(
                `SELECT id,path_prefixes FROM hyperfide.source_capabilities
          WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND credential_id=$5
          AND $6=ANY(actions) AND ($7::uuid IS NULL OR id=$7) AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY id LIMIT 65`,
                [
                  request.scope.organisation_id,
                  request.scope.repository_id,
                  request.scope.security_domain_id,
                  "operation" in principal
                    ? principal.principal.actor_id
                    : principal.id,
                  "operation" in principal
                    ? principal.principal.credential_id
                    : principal.credential_id,
                  action,
                  "operation" in principal
                    ? null
                    : (principal.capability_id ?? null),
                ],
              )
            ).rows,
        );
        let admitted: SourceAuthorization | undefined;
        for (const candidate of candidates) {
          const prefix = String(candidate.path_prefixes[0]);
          try {
            const result = await authorize(prefix);
            if (result.capability_id === candidate.id) {
              admitted = result;
              witness = prefix;
              break;
            }
          } catch (denied) {
            if (
              !(denied instanceof SourceControlError) ||
              denied.code !== "SCOPE_DENIED"
            )
              throw denied;
          }
        }
        if (!admitted) throw error;
        authorization = admitted;
      }
      const context: SourceAuthorization = partial
        ? {
            ...authorization,
            assertCurrent: (tx) =>
              authorization.assertCurrent(tx, action, [witness]),
          }
        : authorization;
      if (action === "source.queries.batch") {
        const batch = await runSourceReadBatch(
          request,
          principal,
          (member, actor, signal) => {
            if ("operation" in actor) {
              if (!dependencies.invokeBatchMember)
                throw new SourceControlError(
                  "AUTH_SCOPE_DENIED",
                  "Authenticated child dispatch is unavailable",
                );
              return dependencies.invokeBatchMember(member, actor, signal);
            }
            return api.invoke(member.action, member, actor);
          },
        );
        const fresh = batch.items.map((item) =>
          "result" in item &&
          item.result !== null &&
          typeof item.result === "object"
            ? (item.result as Record<string, unknown>)
            : {},
        );
        return {
          ...batch,
          index_generation: fresh
            .reduce(
              (maximum, item) =>
                typeof item.index_generation === "string" &&
                /^\d+$/.test(item.index_generation) &&
                BigInt(item.index_generation) > maximum
                  ? BigInt(item.index_generation)
                  : maximum,
              0n,
            )
            .toString(),
          index_complete: fresh.every((item) => item.index_complete === true),
        };
      }
      return withSourceCausalRead(
        dependencies.metadata,
        dependencies.objects,
        context,
        action,
        request.causal_token,
        principal.signal,
        !mutation &&
          (action.startsWith("source.queries.") ||
            [
              "source.revisions.read",
              "source.changes.revisions",
              "source.operations.read",
            ].includes(action)),
        async (metadata, route) => {
          const result = await (async () => {
            const query = value({ ...input });
            delete query.cursor;
            const binding = (snapshot: string): SourceCursorBinding => ({
              scope: request.scope,
              principal_id: authorization.principal_id,
              authority_epoch: authorization.authority_epoch,
              policy_version: authorization.policy_version,
              capability_id: authorization.capability_id,
              query: { action, input: query },
              snapshot,
            });
            const page = (snapshot: string): unknown =>
              input.cursor === undefined
                ? undefined
                : cursors.decode(binding(snapshot), String(input.cursor));
            const continuation = (
              snapshot: string,
              position: unknown,
            ): string | null =>
              position === null
                ? null
                : cursors.encode(binding(snapshot), position);
            const reader = {
              ancestryIndex: (id: string) =>
                metadata.ancestryIndex(context, parseObjectId(id)),
              pathIdentity: async (revision: QueryRevision, path: string) => {
                if (path === "") return revision.root_tree_id;
                try {
                  const entry = await dependencies.trees.lookup(
                    request.scope,
                    revision.root_tree_id,
                    path,
                  );
                  return entry
                    ? entry.kind + ":" + entry.mode + ":" + entry.object_id
                    : null;
                } catch (error) {
                  if (
                    error instanceof SourceControlError &&
                    error.code === "PATH_CONFLICT" &&
                    error.message === "A path ancestor is not a directory"
                  )
                    return null;
                  throw error;
                }
              },
              revision: (id: string) =>
                metadata.readRevision(context, parseObjectId(id)),
              tree: (id: string, after: string | undefined, size: number) =>
                dependencies.trees.list(request.scope, parseObjectId(id), {
                  limit: size,
                  ...(after === undefined ? {} : { cursor: after }),
                }),
              async file(
                revision: string,
                path: string,
              ): Promise<Uint8Array | null> {
                const record = await metadata.readRevision(
                    context,
                    parseObjectId(revision),
                  ),
                  entry = await dependencies.trees.lookup(
                    request.scope,
                    parseObjectId(record.root_tree_id),
                    path,
                  );
                if (!entry) return null;
                if (entry.kind !== "file")
                  throw new SourceControlError(
                    "INVALID_REQUEST",
                    "Text queries require a regular file",
                  );
                const descriptor = await dependencies.objects.read(
                  request.scope,
                  entry.object_id,
                );
                if (
                  descriptor.kind !== "file" ||
                  BigInt(decodeFileDescriptor(descriptor.payload).size_bytes) >
                    2097152n
                )
                  throw new SourceControlError(
                    "LIMIT_EXCEEDED",
                    "Text query file exceeds its 2 MiB budget",
                  );
                return dependencies.objects.readFile(
                  request.scope,
                  entry.object_id,
                );
              },
            };
            const selection = new SourcePathSelection(
              filters,
              authorization.path_prefixes,
            );
            const queries = new SourceQueries(reader, selection),
              scope = request.scope;
            if (action === "source.lifecycle.read") {
              fields(
                input,
                ["revision_id", "domain_id"],
                ["revision_id", "domain_id"],
              );
              return readSourceLifecycle(dependencies.metadata, context, {
                revision_id: parseObjectId(input.revision_id),
                domain_id: parseUUID(input.domain_id),
              });
            }
            if (action === "source.capabilities") {
              fields(input, [], []);
              return {
                ...SOURCE_CAPABILITIES,
                actions: supported,
                capabilities: [
                  "api-only",
                  "scoped-objects",
                  "durable-operations",
                  "bounded-history",
                  "bounded-diff",
                ],
              };
            }
            if (action === "source.objects.put") {
              fields(
                input,
                ["kind", "payload_base64"],
                ["kind", "payload_base64"],
              );
              const payload = base64(input.payload_base64);
              if (context.workspace) {
                if (!["blob", "chunk", "file"].includes(String(input.kind)))
                  throw new SourceControlError(
                    "SCOPE_DENIED",
                    "Managed workers upload file content through workspace checkpoints",
                  );
                if (input.kind === "file") {
                  const descriptor = decodeFileDescriptor(payload),
                    children =
                      descriptor.content.kind === "blob"
                        ? [descriptor.content.object_id]
                        : descriptor.content.chunks.map(
                            (chunk) => chunk.object_id,
                          );
                  await metadata.transaction(async (tx) => {
                    await metadata.guard(tx, context, action);
                    await assertManagedObjectUploads(tx, context, children);
                  });
                }
              }
              return objectView(
                await dependencies.objects.put(
                  scope,
                  input.kind as Parameters<SourceObjectService["put"]>[1],
                  payload,
                  request.operation_id,
                  authorization.principal_id,
                ),
              );
            }
            if (action === "source.capabilities.manage")
              return manageSourceCapability(
                metadata,
                context,
                input,
                request.operation_id,
                request.idempotency_key,
              );
            if (action === "source.audit.read") {
              fields(input, ["after_id", "limit"], []);
              const maximum =
                input.limit === undefined ? 100 : Number(input.limit);
              if (
                !Number.isSafeInteger(maximum) ||
                maximum < 1 ||
                maximum > 1000 ||
                (input.limit !== undefined && typeof input.limit !== "number")
              )
                throw new SourceControlError(
                  "LIMIT_EXCEEDED",
                  "Audit page must contain between one and 1000 rows",
                );
              const after =
                input.after_id === undefined
                  ? undefined
                  : parseUUID(input.after_id, "after_id");
              const records = await metadata.transaction((tx) =>
                readSourceAudit(tx, context, {
                  limit: maximum,
                  ...(after ? { after_id: after } : {}),
                }),
              );
              return {
                records,
                next_after_id:
                  records.length === maximum ? records.at(-1)!.id : null,
              };
            }
            if (action === "source.objects.read") {
              if (input.path !== undefined) {
                fields(input, ["revision_id", "path"], ["revision_id", "path"]);
                const revisionId = parseObjectId(input.revision_id),
                  path = parseRepositoryPath(input.path),
                  revision = await metadata.readRevision(context, revisionId),
                  entry = await dependencies.trees.lookup(
                    scope,
                    revision.root_tree_id,
                    path,
                  );
                if (!entry)
                  throw new SourceControlError(
                    "NOT_FOUND",
                    "The path is absent from this revision",
                  );
                const object = await dependencies.objects.read(
                  scope,
                  entry.object_id,
                  principal.signal,
                );
                if (
                  !(entry.kind === "file" && object.kind === "file") &&
                  !(
                    entry.kind === "symlink" &&
                    object.kind === "blob" &&
                    object.payload.byteLength <= 4096
                  ) &&
                  !(
                    entry.kind === "directory" &&
                    (object.kind === "tree-leaf" ||
                      object.kind === "tree-index")
                  )
                )
                  throw new SourceControlError(
                    "INVALID_OBJECT",
                    "Source entry differs from its object kind",
                  );
                const descriptor =
                  object.kind === "file"
                    ? decodeFileDescriptor(object.payload)
                    : null;
                if (descriptor && BigInt(descriptor.size_bytes) > 65536n)
                  throw new SourceControlError(
                    "LIMIT_EXCEEDED",
                    "Path file read exceeds its 65536 byte budget",
                  );
                const content = descriptor
                  ? await dependencies.objects.readFile(scope, entry.object_id)
                  : object.payload;
                await metadata.transaction((tx) =>
                  authorization.assertCurrent(tx, action, [path]),
                );
                return {
                  object_id: object.object_id,
                  kind: entry.kind,
                  path,
                  revision_id: revisionId,
                  mode: entry.mode,
                  content_base64: Buffer.from(content).toString("base64"),
                  byte_length: String(content.byteLength),
                  ...(descriptor
                    ? { content_digest: descriptor.content_digest }
                    : {}),
                };
              }
              fields(input, ["object_id"], ["object_id"]);
              const result = await dependencies.objects.read(
                scope,
                parseObjectId(input.object_id),
                principal.signal,
              );
              return {
                object_id: result.object_id,
                kind: result.kind,
                payload_base64: Buffer.from(result.payload).toString("base64"),
                byte_length: String(result.payload.byteLength),
              };
            }
            if (action === "source.objects.inspect") {
              fields(input, ["object_id"], ["object_id"]);
              return objectView(
                await dependencies.objects.inspect(
                  scope,
                  parseObjectId(input.object_id),
                ),
              );
            }
            if (action === "source.uploads.prepare") {
              if (context.workspace)
                throw new SourceControlError(
                  "SCOPE_DENIED",
                  "Managed workers must upload actual bytes through source.objects.put",
                );
              fields(
                input,
                ["kind", "object_id", "size_bytes"],
                ["kind", "object_id", "size_bytes"],
              );
              if (typeof input.size_bytes !== "string")
                throw new SourceControlError(
                  "INVALID_REQUEST",
                  "Upload size must be a canonical decimal string",
                );
              return objectView(
                await dependencies.objects.beginUpload(scope, {
                  operation_id: request.operation_id,
                  owner_principal_id: authorization.principal_id,
                  kind: input.kind as Parameters<SourceObjectService["put"]>[1],
                  object_id: parseObjectId(input.object_id),
                  size_bytes: input.size_bytes,
                }),
              );
            }
            if (action === "source.uploads.complete") {
              if (context.workspace)
                throw new SourceControlError(
                  "SCOPE_DENIED",
                  "Managed workers must upload actual bytes through source.objects.put",
                );
              fields(input, ["upload_id"], ["upload_id"]);
              return objectView(
                await dependencies.objects.completeUpload(
                  scope,
                  parseUUID(input.upload_id),
                ),
              );
            }
            if (action === "source.trees.entries") {
              fields(
                input,
                ["tree_id", "limit", "cursor", "paths"],
                ["tree_id"],
              );
              const id = parseObjectId(input.tree_id),
                position = page(id);
              if (position !== undefined && typeof position !== "string")
                throw new SourceControlError(
                  "INVALID_CURSOR",
                  "Directory cursor must address an exact name",
                );
              if (!authorization.path_prefixes.includes(""))
                await metadata.transaction(async (tx) => {
                  await metadata.guard(tx, context, action);
                  if (
                    !(
                      await tx.query(
                        "SELECT 1 FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND root_tree_id=$4 LIMIT 1",
                        [
                          scope.organisation_id,
                          scope.repository_id,
                          scope.security_domain_id,
                          id,
                        ],
                      )
                    ).rows.length
                  )
                    throw new SourceControlError(
                      "SCOPE_DENIED",
                      "Scoped directory queries require a registered revision root",
                    );
                });
              const result = await dependencies.trees.list(scope, id, {
                limit: limit(input.limit),
                ...(position === undefined
                  ? {}
                  : { cursor: position as string }),
              });
              return {
                ...result,
                entries: result.entries.filter((entry) =>
                  selection.includes(entry.name),
                ),
                next_cursor: continuation(id, result.next_cursor),
                tree_id: id,
                index_generation: "0",
                index_complete: true,
                coverage: selection.coverage({
                  state: result.next_cursor === null ? "COMPLETE" : "PARTIAL",
                  visited_nodes: result.entries.length,
                  bytes_read: 0,
                }),
              };
            }
            if (action === "source.trees.lookup") {
              fields(input, ["tree_id", "path"], ["tree_id", "path"]);
              return {
                entry: await dependencies.trees.lookup(
                  scope,
                  parseObjectId(input.tree_id),
                  parseRepositoryPath(input.path),
                ),
              };
            }
            if (action === "source.trees.patch") {
              fields(input, ["tree_id", "patches"], ["tree_id", "patches"]);
              return dependencies.trees.patch(
                scope,
                parseObjectId(input.tree_id),
                input.patches as Parameters<PersistentTree["patch"]>[2],
              );
            }
            if (action === "source.revisions.create") {
              fields(
                input,
                [
                  "change_id",
                  "root_tree_id",
                  "parent_revision_ids",
                  "predecessor_revision_ids",
                  "provenance",
                ],
                [
                  "change_id",
                  "root_tree_id",
                  "parent_revision_ids",
                  "predecessor_revision_ids",
                  "provenance",
                ],
              );
              if (!request.idempotency_key)
                throw new SourceControlError(
                  "INVALID_REQUEST",
                  "Revision mutation requires a stable idempotency key",
                );
              return metadata.createRevision(context, {
                ...input,
                operation_id: request.operation_id,
                idempotency_key: request.idempotency_key,
              } as RevisionInput);
            }
            if (action === "source.revisions.read") {
              fields(input, ["revision_id"], ["revision_id"]);
              return metadata.readRevision(
                context,
                parseObjectId(input.revision_id),
              );
            }
            if (action === "source.changes.revisions") {
              fields(input, ["change_id", "limit", "cursor"], ["change_id"]);
              const id = parseUUID(input.change_id),
                position = page(id);
              if (position !== undefined && typeof position !== "string")
                throw new SourceControlError(
                  "INVALID_CURSOR",
                  "Change cursor is malformed",
                );
              const result = await metadata.changeRevisions(context, id, {
                limit: limit(input.limit),
                ...(position === undefined
                  ? {}
                  : { after: position as string }),
              });
              return {
                ...result,
                next_cursor: continuation(id, result.next_cursor),
              };
            }
            if (action === "source.operations.read") {
              fields(input, ["operation_id"], ["operation_id"]);
              const id = parseUUID(input.operation_id),
                workspace = await dependencies.workspaceOperation?.(
                  context,
                  id,
                );
              if (workspace !== null && workspace !== undefined) {
                const result = value(workspace);
                return {
                  ...result,
                  state:
                    result.state === "COMMITTED"
                      ? "SUCCEEDED"
                      : result.state === "PENDING"
                        ? "ADMITTED"
                        : result.state,
                };
              }
              const result = await metadata.operation(context, id);
              return {
                ...result,
                state:
                  result.state === "COMMITTED"
                    ? "SUCCEEDED"
                    : result.state === "PENDING"
                      ? "ADMITTED"
                      : result.state,
              };
            }
            if (action === "source.operations.cancel") {
              fields(input, ["operation_id"], ["operation_id"]);
              const result = await metadata.cancel(
                context,
                parseUUID(input.operation_id),
              );
              return {
                ...result,
                operation: {
                  ...result.operation,
                  state:
                    result.operation.state === "COMMITTED"
                      ? "SUCCEEDED"
                      : result.operation.state === "PENDING"
                        ? "ADMITTED"
                        : result.operation.state,
                },
              };
            }
            if (action === "source.subscriptions.create") {
              fields(
                input,
                [
                  "consumer_id",
                  "bootstrap_revision_id",
                  "retention_max_events",
                  "retention_expires_at",
                  "expected_previous_epoch",
                ],
                ["consumer_id", "bootstrap_revision_id"],
              );
              return metadata.subscribe(context, {
                consumer_id: parseUUID(input.consumer_id),
                bootstrap_revision_id: parseObjectId(
                  input.bootstrap_revision_id,
                ),
                ...(input.retention_max_events !== undefined
                  ? {
                      retention_max_events:
                        input.retention_max_events as number,
                    }
                  : {}),
                ...(input.retention_expires_at !== undefined
                  ? {
                      retention_expires_at:
                        input.retention_expires_at as string,
                    }
                  : {}),
                ...(input.expected_previous_epoch !== undefined
                  ? {
                      expected_previous_epoch:
                        input.expected_previous_epoch as string,
                    }
                  : {}),
              });
            }
            if (action === "source.subscriptions.poll") {
              fields(
                input,
                ["consumer_id", "subscription_epoch", "limit", "lease_ms"],
                ["consumer_id", "subscription_epoch"],
              );
              return metadata.pollEvents(context, {
                consumer_id: parseUUID(input.consumer_id),
                subscription_epoch: parseUUID(input.subscription_epoch),
                limit: limit(input.limit),
                ...(input.lease_ms === undefined
                  ? {}
                  : { lease_ms: Number(input.lease_ms) }),
              });
            }
            if (action === "source.subscriptions.ack") {
              fields(
                input,
                ["consumer_id", "subscription_epoch", "event_id", "lease_id"],
                ["consumer_id", "subscription_epoch", "event_id", "lease_id"],
              );
              return metadata.acknowledgeEvent(context, {
                consumer_id: parseUUID(input.consumer_id),
                subscription_epoch: parseUUID(input.subscription_epoch),
                event_id: parseUUID(input.event_id),
                lease_id: parseUUID(input.lease_id),
              });
            }
            if (action === "source.queries.history") {
              fields(
                input,
                ["revision_id", "limit", "cursor", "budget", "paths"],
                ["revision_id"],
              );
              const id = parseObjectId(input.revision_id),
                result = await queries.history(
                  id,
                  limit(input.limit),
                  queryBudget(input.budget, principal),
                  page(id),
                );
              const { continuation: position, ...response } = result;
              return {
                ...response,
                next_cursor: continuation(id, position),
                revision_id: id,
              };
            }
            if (action === "source.queries.ancestry") {
              fields(
                input,
                [
                  "ancestor_revision_id",
                  "descendant_revision_id",
                  "cursor",
                  "budget",
                ],
                ["ancestor_revision_id", "descendant_revision_id"],
              );
              const ancestor = parseObjectId(input.ancestor_revision_id),
                descendant = parseObjectId(input.descendant_revision_id),
                snapshot = ancestor + ":" + descendant;
              const result = await queries.ancestry(
                ancestor,
                descendant,
                queryBudget(input.budget, principal),
                page(snapshot),
              );
              const { continuation: position, ...response } = result;
              return {
                ...response,
                next_cursor: continuation(snapshot, position),
              };
            }
            if (action === "source.queries.merge-bases") {
              fields(
                input,
                ["left_revision_id", "right_revision_id", "budget", "cursor"],
                ["left_revision_id", "right_revision_id"],
              );
              const left = parseObjectId(input.left_revision_id),
                right = parseObjectId(input.right_revision_id),
                snapshot = left + ":" + right;
              const { continuation: position, ...response } =
                await queries.mergeBases(
                  left,
                  right,
                  queryBudget(input.budget, principal),
                  page(snapshot),
                );
              return {
                ...response,
                next_cursor: continuation(snapshot, position),
              };
            }
            if (action === "source.queries.diff") {
              fields(
                input,
                [
                  "before_revision_id",
                  "after_revision_id",
                  "limit",
                  "cursor",
                  "budget",
                  "paths",
                ],
                ["before_revision_id", "after_revision_id"],
              );
              const before = parseObjectId(input.before_revision_id),
                after = parseObjectId(input.after_revision_id),
                snapshot = before + ":" + after;
              const [a, b] = await Promise.all([
                  reader.revision(before),
                  reader.revision(after),
                ]),
                result = await queries.diff(
                  a.root_tree_id,
                  b.root_tree_id,
                  limit(input.limit),
                  queryBudget(input.budget, principal),
                  page(snapshot),
                );
              const { continuation: position, ...response } = result;
              return {
                ...response,
                ...(await queries.freshness(before, after)),
                next_cursor: continuation(snapshot, position),
                before_revision_id: before,
                after_revision_id: after,
              };
            }
            if (action === "source.queries.line-map") {
              fields(
                input,
                ["before_revision_id", "after_revision_id", "path", "budget"],
                ["before_revision_id", "after_revision_id", "path"],
              );
              return queries.lineMap(
                parseObjectId(input.before_revision_id),
                parseObjectId(input.after_revision_id),
                parseRepositoryPath(input.path),
                queryBudget(input.budget, principal),
              );
            }
            if (action === "source.queries.blame") {
              fields(
                input,
                [
                  "revision_id",
                  "path",
                  "budget",
                  "start_line",
                  "limit",
                  "cursor",
                ],
                ["revision_id", "path"],
              );
              const id = parseObjectId(input.revision_id),
                position = page(id),
                start = position ?? input.start_line ?? 1;
              if (typeof start !== "number")
                throw new SourceControlError(
                  "INVALID_CURSOR",
                  "Blame cursor must address a line",
                );
              const result = await queries.blame(
                id,
                parseRepositoryPath(input.path),
                queryBudget(input.budget, principal),
                { start_line: start, limit: limit(input.limit) },
              );
              const { next_line: next, ...response } = result;
              return {
                ...response,
                next_cursor: next === undefined ? null : continuation(id, next),
              };
            }
            if (extensions[action])
              return extensions[action]!(request, context, principal);
            throw new SourceControlError(
              "UNSUPPORTED_ACTION",
              "Source operation is not implemented",
            );
          })();
          if (partial)
            await dependencies.metadata.transaction((tx) =>
              context.assertCurrent(tx, action),
            );
          return request.causal_token &&
            result !== null &&
            typeof result === "object" &&
            !Array.isArray(result)
            ? { ...result, causal_route: route }
            : result;
        },
      );
    },
  };
  return api;
}
