import { createHash } from "node:crypto";
import {
  canonicalBytes,
  parseRepositoryPath,
  type TreeEntry,
} from "./contracts.js";
import type { SourceStorageScope } from "./storage_contract.js";

export type SourceConflictKind =
  | "ADD_ADD"
  | "DELETE_MODIFY"
  | "DIRECTORY_FILE"
  | "ENTRY_TYPE"
  | "SYMLINK"
  | "EXECUTABLE_MODE"
  | "BINARY"
  | "TEXT"
  | "TEXT_LIMIT";
export interface SourceConflict {
  readonly schema_version: 1;
  readonly conflict_id: string;
  readonly path: string;
  readonly kind: SourceConflictKind;
  readonly base: Readonly<TreeEntry> | null;
  readonly ours: Readonly<TreeEntry> | null;
  readonly theirs: Readonly<TreeEntry> | null;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export function sourceConflict(
  scope: SourceStorageScope,
  input: Omit<SourceConflict, "schema_version" | "conflict_id">,
): SourceConflict {
  const path = parseRepositoryPath(input.path);
  const reference = (entry: Readonly<TreeEntry> | null) =>
    entry === null ? null : Object.freeze({ ...entry });
  const body = {
    schema_version: 1 as const,
    path,
    kind: input.kind,
    base: reference(input.base),
    ours: reference(input.ours),
    theirs: reference(input.theirs),
    details: Object.freeze({ ...input.details }),
  };
  const conflict_id =
    "sha256:" +
    createHash("sha256")
      .update("hyperfide-source-conflict\0v1\0")
      .update(canonicalBytes([scope, body]))
      .digest("hex");
  return Object.freeze({ ...body, conflict_id });
}
