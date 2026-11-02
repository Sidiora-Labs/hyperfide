import { createHash, randomUUID } from "node:crypto";

export interface SourceScope {
  organisation_id: string;
  repository_id: string;
  security_domain_id: string;
}
export type SourceMode = "API_ONLY" | "SPARSE" | "MATERIALIZED";
export interface WorkspaceBudgets {
  cache_bytes: number;
  max_cache_entries: number;
  max_file_bytes: number;
  materialized_bytes: number;
  dirty_bytes: number;
}
export interface WorkspaceDescriptor {
  schema_version: 1;
  scope: SourceScope;
  workspace_id: string;
  workspace_generation: string;
  scope_generation: string;
  authority_epoch: string;
  base_revision_id: string;
  root_tree_id: string;
  mode: SourceMode;
  read_paths: string[];
  write_paths: string[];
  checkpoint_revision_id: string | null;
  budgets: WorkspaceBudgets;
}
export interface SourceEntry {
  name: string;
  kind: "file" | "directory" | "symlink";
  mode: "100644" | "100755" | "120000" | "040000";
  object_id: string;
}
export interface SourceObject {
  object_id: string;
  kind: string;
  payload: Buffer;
}
export interface SourceTransport {
  call<T>(
    action: string,
    input: Record<string, unknown>,
    options?: { operation_id?: string; signal?: AbortSignal },
  ): Promise<T>;
}
export type WorkspaceChange =
  | { path: string; operation: "remove" }
  | {
      path: string;
      operation: "put";
      kind: "file" | "symlink";
      mode: "100644" | "100755" | "120000";
      object_id: string;
    };
export interface CheckpointRequest {
  scope: SourceScope;
  workspace_id: string;
  expected_workspace_generation: string;
  expected_scope_generation: string;
  base_revision_id: string;
  overlay_generation: string;
  operation_id: string;
  changes: WorkspaceChange[];
}
export interface CheckpointResult {
  workspace: WorkspaceDescriptor;
  revision_id: string;
  receipt: unknown;
}
export class SourceWorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceWorkspaceError";
  }
}
export function workspaceError(code: string, message: string): never {
  throw new SourceWorkspaceError(code, message);
}
export function nativeObjectId(kind: string, payload: Uint8Array): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(
        Buffer.from(
          `hyperfide-source-control\0v1\0${kind}\0${payload.byteLength}\0`,
          "utf8",
        ),
      )
      .update(payload)
      .digest("hex")
  );
}
export function fileObjectId(bytes: Buffer): string {
  const chunkSize = 4 * 1024 * 1024;
  const content =
    bytes.length <= chunkSize
      ? ["blob", nativeObjectId("blob", bytes)]
      : [
          "chunks",
          Array.from(
            { length: Math.ceil(bytes.length / chunkSize) },
            (_, index) => {
              const part = bytes.subarray(
                index * chunkSize,
                (index + 1) * chunkSize,
              );
              return [nativeObjectId("chunk", part), String(part.length)];
            },
          ),
        ];
  return nativeObjectId(
    "file",
    Buffer.from(
      JSON.stringify([1, String(bytes.length), rawDigest(bytes), content]),
    ),
  );
}
export function rawDigest(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
export function repositoryPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    ) ||
    Buffer.byteLength(value) > 4096 ||
    value
      .split("/")
      .some((p) => !p || p === "." || p === ".." || Buffer.byteLength(p) > 255)
  )
    workspaceError(
      "INVALID_PATH",
      "An exact repository-relative UTF-8 path is required",
    );
  return value;
}
export function withinScope(value: string, scopes: readonly string[]): boolean {
  return scopes.some(
    (p) => p === "" || value === p || value.startsWith(p + "/"),
  );
}
export function assertObjectId(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value))
    workspaceError("INVALID_OBJECT_ID", "Native object identity required");
}
function validateDescriptor(value: WorkspaceDescriptor): WorkspaceDescriptor {
  for (const id of [...Object.values(value.scope), value.workspace_id])
    if (
      typeof id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      workspaceError("WORKSPACE_DESCRIPTOR", "Scoped UUID identities required");
  if (
    value.schema_version !== 1 ||
    !["API_ONLY", "SPARSE", "MATERIALIZED"].includes(value.mode) ||
    !/^(0|[1-9]\d*)$/.test(value.workspace_generation) ||
    !/^(0|[1-9]\d*)$/.test(value.scope_generation) ||
    !/^(0|[1-9]\d*)$/.test(value.authority_epoch)
  )
    workspaceError("WORKSPACE_DESCRIPTOR", "Unsupported workspace descriptor");
  assertObjectId(value.base_revision_id);
  assertObjectId(value.root_tree_id);
  for (const p of [...value.read_paths, ...value.write_paths])
    if (p !== "") repositoryPath(p);
  for (const n of Object.values(value.budgets))
    if (!Number.isSafeInteger(n) || n < 0)
      workspaceError(
        "WORKSPACE_BUDGET",
        "Explicit nonnegative integer workspace budgets required",
      );
  return value;
}
export class NativeWorkspaceClient {
  constructor(
    readonly transport: SourceTransport,
    readonly scope: SourceScope,
  ) {}
  async open(
    input: {
      base_revision_id: string;
      mode: SourceMode;
      read_paths: string[];
      write_paths: string[];
      budgets?: WorkspaceBudgets;
    },
    operationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<WorkspaceDescriptor> {
    const r = await this.transport.call<{
      workspace: WorkspaceDescriptor;
      admission: { state: string };
    }>(
      "source.workspaces.open",
      { ...input, workspace_id: operationId },
      { operation_id: operationId, ...(signal ? { signal } : {}) },
    );
    if (r.admission.state !== "OPEN")
      workspaceError(
        "WORKSPACE_ADMISSION",
        "Workspace admission was not acknowledged",
      );
    return validateDescriptor(r.workspace);
  }
  async detail(
    workspaceId: string,
    signal?: AbortSignal,
    accessPath?: string,
  ): Promise<WorkspaceDescriptor> {
    const result = await this.transport.call<{
      workspace: WorkspaceDescriptor;
    }>(
      "source.workspaces.detail",
      {
        workspace_id: workspaceId,
        ...(accessPath === undefined
          ? {}
          : { path: repositoryPath(accessPath) }),
      },
      { ...(signal ? { signal } : {}) },
    );
    return validateDescriptor(result.workspace);
  }
  async assertAccess(
    descriptor: WorkspaceDescriptor,
    path: string,
    write = false,
    signal?: AbortSignal,
  ): Promise<void> {
    repositoryPath(path);
    const current = await this.detail(descriptor.workspace_id, signal, path);
    if (
      (
        ["organisation_id", "repository_id", "security_domain_id"] as const
      ).some((key) => current.scope[key] !== descriptor.scope[key]) ||
      current.authority_epoch !== descriptor.authority_epoch ||
      current.workspace_generation !== descriptor.workspace_generation ||
      current.scope_generation !== descriptor.scope_generation ||
      current.base_revision_id !== descriptor.base_revision_id
    )
      workspaceError(
        "WORKSPACE_STALE",
        "Workspace authority or generation changed",
      );
    if (!withinScope(path, write ? current.write_paths : current.read_paths))
      workspaceError(
        "SOURCE_ACCESS_DENIED",
        "Path is outside the authorized workspace scope",
      );
  }
  async lookup(
    treeId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<SourceEntry | null> {
    const result = await this.transport.call<{ entry: SourceEntry | null }>(
      "source.trees.lookup",
      { tree_id: treeId, path: repositoryPath(path) },
      { ...(signal ? { signal } : {}) },
    );
    return result.entry;
  }
  async entries(
    treeId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ entries: SourceEntry[]; next_cursor: string | null }> {
    return this.transport.call(
      "source.trees.entries",
      { tree_id: treeId, limit: 128, ...(cursor ? { cursor } : {}) },
      { ...(signal ? { signal } : {}) },
    );
  }
  async readObject(
    objectId: string,
    signal?: AbortSignal,
  ): Promise<SourceObject> {
    assertObjectId(objectId);
    const r = await this.transport.call<{
      object_id: string;
      kind: string;
      payload_base64: string;
      byte_length: string | number;
    }>(
      "source.objects.read",
      { object_id: objectId },
      { ...(signal ? { signal } : {}) },
    );
    if (
      typeof r.payload_base64 !== "string" ||
      r.payload_base64.length > 12 * 1024 * 1024
    )
      workspaceError(
        "OBJECT_ENCODING",
        "Canonical base64 object payload required",
      );
    const bytes = Buffer.from(r.payload_base64, "base64");
    if (
      bytes.toString("base64") !== r.payload_base64 ||
      !/^(0|[1-9]\d*)$/.test(String(r.byte_length)) ||
      r.object_id !== objectId ||
      BigInt(r.byte_length) !== BigInt(bytes.length) ||
      nativeObjectId(r.kind, bytes) !== objectId
    )
      workspaceError(
        "OBJECT_INTEGRITY",
        "Downloaded object does not match its native identity",
      );
    return { object_id: objectId, kind: r.kind, payload: bytes };
  }
  async putObject(
    kind: "blob" | "chunk" | "file",
    payload: Buffer,
    operationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<string> {
    const expected = nativeObjectId(kind, payload);
    const result = await this.transport.call<{ object_id: string }>(
      "source.objects.put",
      { kind, payload_base64: payload.toString("base64") },
      { operation_id: operationId, ...(signal ? { signal } : {}) },
    );
    if (result.object_id !== expected)
      workspaceError(
        "OBJECT_INTEGRITY",
        "Upload acknowledgment names different content",
      );
    return expected;
  }
  async putFile(bytes: Buffer, signal?: AbortSignal): Promise<string> {
    const chunkSize = 4 * 1024 * 1024;
    let content: unknown;
    if (bytes.length <= chunkSize)
      content = [
        "blob",
        await this.putObject("blob", bytes, undefined, signal),
      ];
    else {
      const chunks: [string, string][] = [];
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        chunks.push([
          await this.putObject("chunk", chunk, undefined, signal),
          String(chunk.length),
        ]);
      }
      content = ["chunks", chunks];
    }
    return this.putObject(
      "file",
      Buffer.from(
        JSON.stringify([1, String(bytes.length), rawDigest(bytes), content]),
      ),
      undefined,
      signal,
    );
  }
  checkpoint(
    input: CheckpointRequest,
    signal?: AbortSignal,
  ): Promise<CheckpointResult> {
    return this.transport.call(
      "source.workspaces.checkpoint",
      input as unknown as Record<string, unknown>,
      { operation_id: input.operation_id, ...(signal ? { signal } : {}) },
    );
  }
  async operation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ state: string; result?: CheckpointResult }> {
    try {
      return await this.transport.call(
        "source.operations.read",
        { operation_id: operationId },
        { ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      if ((error as { code?: string }).code === "NOT_FOUND")
        return { state: "ABSENT" };
      throw error;
    }
  }
}
