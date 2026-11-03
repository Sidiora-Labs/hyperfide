import { createHash } from "node:crypto";
import {
  canonicalBytes,
  parseObjectId,
  SourceControlError,
} from "../contracts.js";
import type {
  SourceContext,
  SourceMetadata,
  SourceRevisionRecord,
} from "../metadata.js";
import { decodeFileDescriptor, type SourceObjectService } from "../objects.js";
import type { PersistentTree } from "../trees.js";
import {
  gitCommitPayload,
  gitObjectId,
  gitStreamObjectId,
  gitTreePayload,
  rawGitOID,
} from "./objects.js";
import type {
  GitObjectId,
  GitProjectedObject,
  GitTreeEntry,
} from "./objects.js";

export interface GitProjectionBudget {
  max_objects: number;
  max_total_bytes: number;
  max_file_bytes: number;
  max_tree_bytes: number;
  max_entries: number;
  max_revisions: number;
  max_depth: number;
  max_ms: number;
}
export type GitMappingKind = "revision" | "tree" | "file" | "symlink";
export interface GitProjectionMapping {
  native_kind: GitMappingKind;
  native_id: string;
  git_oid: GitObjectId;
  git_tree_oid?: GitObjectId;
  is_empty?: boolean;
  disposition?: "COMMIT";
}
export interface GitProjectionOptions {
  authorize_revision: (revision: SourceRevisionRecord) => Promise<void>;
  lookup_confirmed_mapping?: (
    kind: GitMappingKind,
    nativeId: string,
  ) => Promise<GitProjectionMapping | undefined>;
  budget?: Partial<GitProjectionBudget>;
  signal?: AbortSignal;
}
export interface GitProjectionMetrics {
  native_revisions_read: number;
  native_files_read: number;
  directories_read: number;
  tree_pages: number;
  entries_visited: number;
  objects_emitted: number;
  bytes_emitted: number;
  mappings_reused: number;
  empty_directories_omitted: number;
}
export interface GitProjectionResult {
  object_format: "sha1";
  head_oid: GitObjectId;
  root_tree_oid: GitObjectId;
  objects: GitProjectedObject[];
  mappings: GitProjectionMapping[];
  reachable_commit_oids: GitObjectId[];
  metadata_policy: "NATIVE_PUBLIC_V1";
  manifest_digest: string;
  metrics: GitProjectionMetrics;
}
const DEFAULT_BUDGET: GitProjectionBudget = {
  max_objects: 65536,
  max_total_bytes: 268435456,
  max_file_bytes: 67108864,
  max_tree_bytes: 8388608,
  max_entries: 200000,
  max_revisions: 4096,
  max_depth: 256,
  max_ms: 30000,
};
const HARD_BUDGET: GitProjectionBudget = {
  max_objects: 262144,
  max_total_bytes: 1073741824,
  max_file_bytes: 536870912,
  max_tree_bytes: 33554432,
  max_entries: 1000000,
  max_revisions: 16384,
  max_depth: 1024,
  max_ms: 120000,
};

function budgetFor(input?: Partial<GitProjectionBudget>): GitProjectionBudget {
  const budget = { ...DEFAULT_BUDGET };
  if (input !== undefined) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Git projection budget must be an object",
      );
    for (const [key, value] of Object.entries(input)) {
      if (
        !(key in HARD_BUDGET) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > HARD_BUDGET[key as keyof GitProjectionBudget]
      )
        throw new SourceControlError(
          "INVALID_REQUEST",
          "Git projection budget exceeds a supported bound",
        );
      budget[key as keyof GitProjectionBudget] = value;
    }
  }
  return budget;
}

export class SourceGitProjector {
  constructor(
    readonly objects: SourceObjectService,
    readonly trees: PersistentTree,
    readonly metadata: SourceMetadata,
  ) {}

  async project(
    context: SourceContext,
    revisionId: string,
    options: GitProjectionOptions,
  ): Promise<GitProjectionResult> {
    parseObjectId(revisionId);
    if (!options || typeof options.authorize_revision !== "function")
      throw new SourceControlError(
        "PUBLICATION_POLICY_REQUIRED",
        "Export requires authorization for every projected native revision",
      );
    const budget = budgetFor(options.budget),
      started = performance.now(),
      scope = Object.freeze({ ...context.scope });
    const emitted = new Map<string, GitProjectedObject>(),
      cache = new Map<string, GitProjectionMapping>();
    const mappings: GitProjectionMapping[] = [],
      reachable = new Set<GitObjectId>(),
      pending = new Set<string>();
    const metrics: GitProjectionMetrics = {
      native_revisions_read: 0,
      native_files_read: 0,
      directories_read: 0,
      tree_pages: 0,
      entries_visited: 0,
      objects_emitted: 0,
      bytes_emitted: 0,
      mappings_reused: 0,
      empty_directories_omitted: 0,
    };
    const check = () => {
      options.signal?.throwIfAborted();
      if (performance.now() - started > budget.max_ms)
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "Git projection exceeded its preparation deadline",
        );
    };
    const remember = (mapping: GitProjectionMapping): GitProjectionMapping => {
      cache.set(mapping.native_kind + ":" + mapping.native_id, mapping);
      mappings.push(mapping);
      return mapping;
    };
    const lookup = async (
      kind: GitMappingKind,
      id: string,
    ): Promise<GitProjectionMapping | undefined> => {
      check();
      const local = cache.get(kind + ":" + id);
      if (local) {
        metrics.mappings_reused++;
        return local;
      }
      const mapping = await options.lookup_confirmed_mapping?.(kind, id);
      if (!mapping) return undefined;
      if (mapping.native_kind !== kind || mapping.native_id !== id)
        throw new SourceControlError(
          "INVALID_GIT_MAPPING",
          "Confirmed Git mapping does not match its native identity",
        );
      rawGitOID(mapping.git_oid);
      if (kind === "revision") {
        if (!mapping.git_tree_oid)
          throw new SourceControlError(
            "INVALID_GIT_MAPPING",
            "A revision mapping must retain its projected tree",
          );
        rawGitOID(mapping.git_tree_oid);
      }
      if (kind === "tree" && typeof mapping.is_empty !== "boolean")
        throw new SourceControlError(
          "INVALID_GIT_MAPPING",
          "A tree mapping must retain its empty-directory disposition",
        );
      metrics.mappings_reused++;
      cache.set(kind + ":" + id, mapping);
      return mapping;
    };
    const emit = (object: GitProjectedObject): void => {
      check();
      if (emitted.has(object.oid)) return;
      if (
        emitted.size + 1 > budget.max_objects ||
        metrics.bytes_emitted + object.size_bytes > budget.max_total_bytes
      )
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "Git projection exceeds its object or byte budget",
        );
      emitted.set(object.oid, object);
      metrics.objects_emitted++;
      metrics.bytes_emitted += object.size_bytes;
    };
    const bufferObject = (
      kind: "tree" | "commit",
      payload: Buffer,
    ): GitObjectId => {
      const bytes = Buffer.from(payload),
        oid = gitObjectId(kind, bytes);
      emit({
        object_format: "sha1",
        oid,
        kind,
        size_bytes: bytes.length,
        async *content() {
          options.signal?.throwIfAborted();
          yield Buffer.from(bytes);
        },
      });
      return oid;
    };
    const blob = async (
      id: string,
      symlink: boolean,
    ): Promise<GitProjectionMapping> => {
      const kind = symlink ? "symlink" : "file",
        prior = await lookup(kind, id);
      if (prior) return prior;
      check();
      metrics.native_files_read++;
      const object = await this.objects.read(scope, id);
      let size: number, content: () => AsyncIterable<Uint8Array>;
      if (symlink) {
        if (object.kind !== "blob")
          throw new SourceControlError(
            "INVALID_GIT_OBJECT",
            "A native symlink must reference target bytes",
          );
        const bytes = Buffer.from(object.payload);
        size = bytes.length;
        content = async function* () {
          options.signal?.throwIfAborted();
          yield Buffer.from(bytes);
        };
      } else {
        if (object.kind !== "file")
          throw new SourceControlError(
            "INVALID_GIT_OBJECT",
            "A native file must reference a file descriptor",
          );
        const descriptor = decodeFileDescriptor(object.payload);
        size = Number(descriptor.size_bytes);
        const chunks =
          descriptor.content.kind === "blob"
            ? [
                {
                  object_id: descriptor.content.object_id,
                  size_bytes: descriptor.size_bytes,
                },
              ]
            : descriptor.content.chunks;
        const objects = this.objects,
          metadata = this.metadata,
          childKind = descriptor.content.kind === "blob" ? "blob" : "chunk";
        content = async function* () {
          await metadata.transaction((tx) =>
            metadata.guard(tx, context, "source.revisions.read"),
          );
          const hash = createHash("sha256");
          let total = 0;
          for (const chunk of chunks) {
            options.signal?.throwIfAborted();
            const part = await objects.read(scope, chunk.object_id);
            if (
              part.kind !== childKind ||
              part.payload.length !== Number(chunk.size_bytes)
            )
              throw new SourceControlError(
                "GIT_OBJECT_INTEGRITY",
                "A native file chunk changed during Git projection",
              );
            total += part.payload.length;
            hash.update(part.payload);
            yield part.payload;
          }
          if (
            total !== size ||
            "sha256:" + hash.digest("hex") !== descriptor.content_digest
          )
            throw new SourceControlError(
              "GIT_OBJECT_INTEGRITY",
              "Native file content does not match its retained descriptor",
            );
        };
      }
      if (
        size > budget.max_file_bytes ||
        size > budget.max_total_bytes - metrics.bytes_emitted
      )
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "Native file exceeds its Git export byte budget",
        );
      const oid = await gitStreamObjectId(
        "blob",
        size,
        content(),
        options.signal,
      );
      emit({
        object_format: "sha1",
        oid,
        kind: "blob",
        size_bytes: size,
        content,
      });
      return remember({ native_kind: kind, native_id: id, git_oid: oid });
    };
    const directory = async (
      id: string,
      depth: number,
    ): Promise<GitProjectionMapping> => {
      if (depth > budget.max_depth)
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "Git directory projection exceeds its depth budget",
        );
      const prior = await lookup("tree", id);
      if (prior) return prior;
      if (pending.has("tree:" + id))
        throw new SourceControlError(
          "INVALID_GIT_TREE",
          "Native directory contains a cycle",
        );
      pending.add("tree:" + id);
      metrics.directories_read++;
      const entries: GitTreeEntry[] = [];
      let cursor: string | undefined,
        treeBytes = 0;
      do {
        check();
        metrics.tree_pages++;
        const page = await this.trees.list(scope, id, {
          limit: 256,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const entry of page.entries) {
          check();
          metrics.entries_visited++;
          if (metrics.entries_visited > budget.max_entries)
            throw new SourceControlError(
              "LIMIT_EXCEEDED",
              "Git projection exceeds its entry budget",
            );
          const child =
            entry.kind === "directory"
              ? await directory(entry.object_id, depth + 1)
              : await blob(entry.object_id, entry.kind === "symlink");
          if (entry.kind === "directory" && child.is_empty) {
            metrics.empty_directories_omitted++;
            continue;
          }
          treeBytes += Buffer.byteLength(entry.name) + 28;
          if (treeBytes > budget.max_tree_bytes)
            throw new SourceControlError(
              "LIMIT_EXCEEDED",
              "A projected Git directory exceeds its byte budget",
            );
          entries.push({
            name: entry.name,
            mode: entry.mode,
            oid: child.git_oid,
          });
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      const payload = gitTreePayload(entries);
      if (payload.length > budget.max_tree_bytes)
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "A projected Git tree exceeds its byte budget",
        );
      const git_oid = bufferObject("tree", payload);
      pending.delete("tree:" + id);
      return remember({
        native_kind: "tree",
        native_id: id,
        git_oid,
        is_empty: entries.length === 0,
      });
    };
    const revision = async (
      id: string,
      depth: number,
    ): Promise<GitProjectionMapping> => {
      check();
      if (depth > budget.max_revisions)
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "Git revision projection exceeds its ancestry depth budget",
        );
      const local = cache.get("revision:" + id);
      if (local) {
        metrics.mappings_reused++;
        reachable.add(local.git_oid);
        return local;
      }
      if (pending.has("revision:" + id))
        throw new SourceControlError(
          "INVALID_GIT_COMMIT",
          "Native revision ancestry contains a cycle",
        );
      if (++metrics.native_revisions_read > budget.max_revisions)
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "Git projection exceeds its revision budget",
        );
      const record = await this.metadata.readRevision(context, id);
      const confirmed = await lookup("revision", id);
      if (confirmed) {
        reachable.add(confirmed.git_oid);
        return confirmed;
      }
      await options.authorize_revision(record);
      pending.add("revision:" + id);
      const parentMappings: GitProjectionMapping[] = [];
      for (const parent of record.parent_revision_ids)
        parentMappings.push(await revision(parent, depth + 1));
      const tree = await directory(record.root_tree_id, 0),
        parents = parentMappings.map((parent) => parent.git_oid);
      const git_oid = bufferObject(
        "commit",
        gitCommitPayload(tree.git_oid, parents, record.descriptor.provenance),
      );
      const mapping = remember({
        native_kind: "revision",
        native_id: id,
        git_oid,
        git_tree_oid: tree.git_oid,
        disposition: "COMMIT",
      });
      pending.delete("revision:" + id);
      reachable.add(mapping.git_oid);
      return mapping;
    };
    const head = await revision(revisionId, 0);
    const manifest = {
      object_format: "sha1",
      native_revision_id: revisionId,
      head_oid: head.git_oid,
      root_tree_oid: head.git_tree_oid!,
      metadata_policy: "NATIVE_PUBLIC_V1",
      mappings,
      objects: [...emitted.values()].map((object) => [
        object.oid,
        object.kind,
        object.size_bytes,
      ]),
    };
    return {
      object_format: "sha1",
      head_oid: head.git_oid,
      root_tree_oid: head.git_tree_oid!,
      objects: [...emitted.values()],
      mappings,
      reachable_commit_oids: [...reachable],
      metadata_policy: "NATIVE_PUBLIC_V1",
      manifest_digest:
        "sha256:" +
        createHash("sha256")
          .update(canonicalBytes(manifest, 8388608))
          .digest("hex"),
      metrics,
    };
  }
}
