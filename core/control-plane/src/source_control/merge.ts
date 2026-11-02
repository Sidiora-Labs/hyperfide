import {
  canonicalBytes,
  compareUTF8,
  parseObjectId,
  parseTreeEntry,
  SourceControlError,
  type TreeEntry,
} from "./contracts.js";
import {
  decodeFileDescriptor,
  decodeTreeNode,
  treeNameKey,
  type SourceObjectService,
  type TreeNode,
} from "./objects.js";
import {
  sourceConflict,
  type SourceConflict,
  type SourceConflictKind,
} from "./conflicts.js";
import type { SourceStorageScope } from "./storage_contract.js";
import type { PersistentTree } from "./trees.js";

export interface SourceMergeBudget {
  max_nodes: number;
  max_entries: number;
  max_files: number;
  max_text_bytes: number;
  max_file_bytes: number;
  max_diff_cells: number;
  max_conflicts: number;
  max_ms: number;
}
export interface SourceMergeInput {
  base_tree_id: string;
  ours_tree_id: string;
  theirs_tree_id: string;
  signal?: AbortSignal;
  budget?: Partial<SourceMergeBudget>;
}
export interface SourceMergeMetrics {
  nodes_read: number;
  nodes_written: number;
  entries_compared: number;
  files_read: number;
  text_bytes: number;
  subtrees_reused: number;
}
export interface SourceMergeResult {
  root_tree_id: string | null;
  conflicts: readonly SourceConflict[];
  metrics: SourceMergeMetrics;
  algorithm: "hyperfide-three-way-v1";
  rename_detection: {
    status: "NOT_PERFORMED";
    reason: "EXPLICIT_PATH_IDENTITY_ONLY";
  };
}
const DEFAULT_BUDGET: SourceMergeBudget = {
  max_nodes: 16384,
  max_entries: 4096,
  max_files: 256,
  max_text_bytes: 2097152,
  max_file_bytes: 1048576,
  max_diff_cells: 4000000,
  max_conflicts: 128,
  max_ms: 10000,
};
const HARD_BUDGET: SourceMergeBudget = {
  max_nodes: 65536,
  max_entries: 4096,
  max_files: 1024,
  max_text_bytes: 8388608,
  max_file_bytes: 2097152,
  max_diff_cells: 8000000,
  max_conflicts: 128,
  max_ms: 120000,
};
type TreeRef = { id: string | null; count: number; node?: TreeNode };
type Change = {
  base: TreeEntry | null;
  ours: TreeEntry | null;
  theirs: TreeEntry | null;
};
type Edit = { start: number; end: number; lines: string[] };
const sameEntry = (a: TreeEntry | null, b: TreeEntry | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    a.mode === b.mode &&
    a.object_id === b.object_id);
const sameEdit = (a: Edit, b: Edit): boolean =>
  a.start === b.start &&
  a.end === b.end &&
  a.lines.length === b.lines.length &&
  a.lines.every((line, i) => line === b.lines[i]);
const splitLines = (text: string): string[] =>
  text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export function normalizeSourceMergeBudget(
  input?: Partial<SourceMergeBudget>,
): SourceMergeBudget {
  const result = { ...DEFAULT_BUDGET };
  if (input !== undefined) {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Merge budget must contain explicit positive bounds",
      );
    for (const [key, value] of Object.entries(input)) {
      if (
        !Object.hasOwn(HARD_BUDGET, key) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > HARD_BUDGET[key as keyof SourceMergeBudget]
      )
        throw new SourceControlError(
          "INVALID_REQUEST",
          "Merge budget exceeds a supported bound",
        );
      result[key as keyof SourceMergeBudget] = value;
    }
  }
  return result;
}

function edits(
  base: string[],
  side: string[],
  cells: { remaining: number },
  check: () => void,
): Edit[] | null {
  let prefix = 0,
    suffix = 0;
  while (
    prefix < base.length &&
    prefix < side.length &&
    base[prefix] === side[prefix]
  )
    prefix++;
  while (
    suffix < base.length - prefix &&
    suffix < side.length - prefix &&
    base[base.length - suffix - 1] === side[side.length - suffix - 1]
  )
    suffix++;
  const n = base.length - prefix - suffix,
    m = side.length - prefix - suffix;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0)
    return [
      { start: prefix, end: prefix + n, lines: side.slice(prefix, prefix + m) },
    ];
  const size = (n + 1) * (m + 1);
  if (!Number.isSafeInteger(size) || size > cells.remaining) return null;
  cells.remaining -= size;
  const width = m + 1,
    table = new Uint32Array(size);
  for (let i = n - 1; i >= 0; i--) {
    check();
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] =
        base[prefix + i] === side[prefix + j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  }
  const result: Edit[] = [];
  let i = 0,
    j = 0,
    current: Edit | null = null;
  const flush = () => {
    if (current !== null) {
      result.push(current);
      current = null;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[prefix + i] === side[prefix + j]) {
      flush();
      i++;
      j++;
      continue;
    }
    current ??= { start: prefix + i, end: prefix + i, lines: [] };
    if (
      j < m &&
      (i === n || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)
    )
      current.lines.push(side[prefix + j++]!);
    else {
      i++;
      current.end = prefix + i;
    }
  }
  flush();
  return result;
}

function mergeText(
  base: string,
  ours: string,
  theirs: string,
  cells: { remaining: number },
  check: () => void,
): { text: string } | { reason: "OVERLAPPING_EDITS" | "DIFF_BUDGET" } {
  const lines = splitLines(base),
    a = edits(lines, splitLines(ours), cells, check),
    b = edits(lines, splitLines(theirs), cells, check);
  if (a === null || b === null) return { reason: "DIFF_BUDGET" };
  const combined = [...a];
  for (const right of b) {
    let duplicate = false;
    for (const left of a) {
      check();
      if (sameEdit(left, right)) {
        duplicate = true;
        break;
      }
      const leftInsertion = left.start === left.end,
        rightInsertion = right.start === right.end;
      const overlaps =
        leftInsertion && rightInsertion
          ? left.start === right.start
          : leftInsertion
            ? left.start > right.start && left.start < right.end
            : rightInsertion
              ? right.start > left.start && right.start < left.end
              : left.start < right.end && right.start < left.end;
      if (overlaps) return { reason: "OVERLAPPING_EDITS" };
    }
    if (!duplicate) combined.push(right);
  }
  combined.sort((a, b) => a.start - b.start || a.end - b.end);
  const output: string[] = [];
  let cursor = 0;
  for (const edit of combined) {
    output.push(lines.slice(cursor, edit.start).join(""), edit.lines.join(""));
    cursor = edit.end;
  }
  output.push(lines.slice(cursor).join(""));
  return { text: output.join("") };
}

export class SourceMergeEngine {
  constructor(
    readonly objects: SourceObjectService,
    readonly trees: PersistentTree,
  ) {}
  async merge(
    scope: SourceStorageScope,
    input: SourceMergeInput,
  ): Promise<SourceMergeResult> {
    for (const id of [
      input.base_tree_id,
      input.ours_tree_id,
      input.theirs_tree_id,
    ])
      parseObjectId(id);
    const budget = normalizeSourceMergeBudget(input.budget),
      started = performance.now(),
      conflicts: SourceConflict[] = [];
    const metrics: SourceMergeMetrics = {
      nodes_read: 0,
      nodes_written: 0,
      entries_compared: 0,
      files_read: 0,
      text_bytes: 0,
      subtrees_reused: 0,
    };
    const nodes = new Map<string, TreeNode>(),
      fileBytes = new Map<string, Buffer | null>(),
      cells = { remaining: budget.max_diff_cells };
    let conflictBytes = 0;
    const check = () => {
      if (input.signal?.aborted)
        throw new SourceControlError(
          "OPERATION_CANCELLED",
          "Source merge was cancelled",
        );
      if (performance.now() - started > budget.max_ms)
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "Source merge elapsed-time budget exhausted",
        );
      if (
        metrics.nodes_read + metrics.nodes_written > budget.max_nodes ||
        metrics.entries_compared > budget.max_entries ||
        metrics.files_read > budget.max_files ||
        metrics.text_bytes > budget.max_text_bytes
      )
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "Source merge traversal budget exhausted",
        );
    };
    const nodeFor = async (ref: TreeRef, prefix: string): Promise<TreeNode> => {
      check();
      let node = ref.node ?? (ref.id === null ? undefined : nodes.get(ref.id));
      if (!node && ref.id !== null) {
        const object = await this.objects.read(scope, ref.id);
        metrics.nodes_read++;
        check();
        if (object.kind !== "tree-leaf" && object.kind !== "tree-index")
          throw new SourceControlError(
            "INVALID_TREE",
            "Merge input is not a tree",
          );
        node = decodeTreeNode(object.kind, object.payload);
        nodes.set(ref.id, node);
      }
      node ??= { kind: "tree-leaf", prefix, entries: [], count: 0 };
      if (
        node.prefix !== prefix ||
        (ref.count >= 0 && node.count !== ref.count)
      )
        throw new SourceControlError(
          "INVALID_TREE",
          "Merge radix reference differs from its retained prefix or count",
        );
      return node;
    };
    const rootRef = async (id: string): Promise<TreeRef> => {
      const ref = { id, count: -1 };
      const node = await nodeFor(ref, "");
      return { id, count: node.count, node };
    };
    const split = (node: TreeNode): Map<string, TreeRef> => {
      if (node.kind === "tree-index")
        return new Map(
          node.children.map((child) => [
            child.digit,
            { id: child.object_id, count: child.count },
          ]),
        );
      const groups = new Map<string, TreeEntry[]>();
      for (const entry of node.entries) {
        const digit = treeNameKey(entry.name)[node.prefix.length]!;
        const entries = groups.get(digit) ?? [];
        entries.push(entry);
        groups.set(digit, entries);
      }
      return new Map(
        [...groups].map(([digit, entries]) => [
          digit,
          {
            id: null,
            count: entries.length,
            node: {
              kind: "tree-leaf" as const,
              prefix: node.prefix + digit,
              entries,
              count: entries.length,
            },
          },
        ]),
      );
    };
    const diff = async (
      base: TreeRef,
      side: TreeRef,
      prefix: string,
      sideName: "ours" | "theirs",
      changes: Map<string, Change>,
    ): Promise<void> => {
      check();
      if (base.id !== null && base.id === side.id) {
        metrics.subtrees_reused++;
        return;
      }
      const a = await nodeFor(base, prefix),
        b = await nodeFor(side, prefix);
      if (a.kind === "tree-leaf" && b.kind === "tree-leaf") {
        const before = new Map(a.entries.map((entry) => [entry.name, entry])),
          after = new Map(b.entries.map((entry) => [entry.name, entry]));
        for (const name of [
          ...new Set([...before.keys(), ...after.keys()]),
        ].sort(compareUTF8)) {
          const old = before.get(name) ?? null,
            next = after.get(name) ?? null;
          metrics.entries_compared++;
          check();
          if (sameEntry(old, next)) continue;
          let change = changes.get(name);
          if (!change) {
            change = { base: old, ours: old, theirs: old };
            changes.set(name, change);
          }
          change[sideName] = next;
        }
        return;
      }
      const before = split(a),
        after = split(b);
      for (const digit of [
        ...new Set([...before.keys(), ...after.keys()]),
      ].sort())
        await diff(
          before.get(digit) ?? { id: null, count: 0 },
          after.get(digit) ?? { id: null, count: 0 },
          prefix + digit,
          sideName,
          changes,
        );
    };
    const conflict = (
      path: string,
      kind: SourceConflictKind,
      change: Change,
      details: Record<string, string | number | boolean> = {},
    ): null => {
      const entry = sourceConflict(scope, { path, kind, ...change, details });
      conflictBytes += canonicalBytes(entry).length;
      if (conflicts.length >= budget.max_conflicts || conflictBytes > 786432)
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "Source merge conflict response budget exhausted",
        );
      conflicts.push(entry);
      return null;
    };
    const readText = async (
      id: string,
    ): Promise<{ text: string } | { reason: "BINARY" | "FILE_LIMIT" }> => {
      check();
      let bytes = fileBytes.get(id);
      if (bytes === undefined) {
        const object = await this.objects.read(scope, id);
        if (object.kind !== "file")
          throw new SourceControlError(
            "INVALID_FILE",
            "Merge regular-file entry must reference a file descriptor",
          );
        const descriptor = decodeFileDescriptor(object.payload);
        if (BigInt(descriptor.size_bytes) > BigInt(budget.max_file_bytes)) {
          fileBytes.set(id, null);
          return { reason: "FILE_LIMIT" };
        }
        metrics.files_read++;
        metrics.text_bytes += Number(descriptor.size_bytes);
        check();
        bytes = await this.objects.readFile(scope, id);
        fileBytes.set(id, bytes);
        check();
      }
      if (bytes === null) return { reason: "FILE_LIMIT" };
      if (bytes.includes(0)) return { reason: "BINARY" };
      try {
        return {
          text: new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes),
        };
      } catch {
        return { reason: "BINARY" };
      }
    };
    const mergeEntry = async (
      path: string,
      change: Change,
    ): Promise<TreeEntry | null> => {
      const { base, ours, theirs } = change;
      if (sameEntry(ours, theirs)) {
        metrics.subtrees_reused++;
        return ours;
      }
      if (sameEntry(base, ours)) {
        metrics.subtrees_reused++;
        return theirs;
      }
      if (sameEntry(base, theirs)) {
        metrics.subtrees_reused++;
        return ours;
      }
      if (ours === null || theirs === null)
        return conflict(path, "DELETE_MODIFY", change);
      if (ours.kind !== theirs.kind)
        return conflict(
          path,
          ours.kind === "directory" || theirs.kind === "directory"
            ? "DIRECTORY_FILE"
            : "ENTRY_TYPE",
          change,
        );
      if (base !== null && base.kind !== ours.kind)
        return conflict(
          path,
          base.kind === "directory" || ours.kind === "directory"
            ? "DIRECTORY_FILE"
            : "ENTRY_TYPE",
          change,
        );
      if (ours.kind === "directory") {
        const empty =
          base === null ? await this.trees.empty(scope) : base.object_id;
        const id = await mergeDirectory(
          empty,
          ours.object_id,
          theirs.object_id,
          path,
        );
        return parseTreeEntry({ ...ours, object_id: id });
      }
      if (ours.kind === "symlink") return conflict(path, "SYMLINK", change);
      let mode = ours.mode;
      if (ours.mode !== theirs.mode) {
        if (base === null) return conflict(path, "EXECUTABLE_MODE", change);
        if (ours.mode === base.mode) mode = theirs.mode;
        else if (theirs.mode !== base.mode)
          return conflict(path, "EXECUTABLE_MODE", change);
      }
      if (ours.object_id === theirs.object_id)
        return parseTreeEntry({ ...ours, mode });
      if (base === null) {
        const left = await readText(ours.object_id),
          right = await readText(theirs.object_id);
        const kinds = [left, right].map((value) =>
          "text" in value
            ? "TEXT"
            : value.reason === "BINARY"
              ? "BINARY"
              : "UNKNOWN",
        );
        return conflict(path, "ADD_ADD", change, {
          ours_content: kinds[0]!,
          theirs_content: kinds[1]!,
        });
      }
      if (ours.object_id === base.object_id)
        return parseTreeEntry({ ...theirs, mode });
      if (theirs.object_id === base.object_id)
        return parseTreeEntry({ ...ours, mode });
      const ancestor = await readText(base.object_id),
        left = await readText(ours.object_id),
        right = await readText(theirs.object_id);
      const failure = [ancestor, left, right].find(
        (value) => "reason" in value,
      );
      if (failure && "reason" in failure)
        return conflict(
          path,
          failure.reason === "BINARY" ? "BINARY" : "TEXT_LIMIT",
          change,
          { reason: failure.reason },
        );
      if (!("text" in ancestor) || !("text" in left) || !("text" in right))
        throw new SourceControlError(
          "INVALID_FILE",
          "Text classification failed",
        );
      const merged = mergeText(
        ancestor.text,
        left.text,
        right.text,
        cells,
        check,
      );
      if ("reason" in merged)
        return conflict(
          path,
          merged.reason === "DIFF_BUDGET" ? "TEXT_LIMIT" : "TEXT",
          change,
          { reason: merged.reason },
        );
      check();
      const object = await this.objects.putFile(
        scope,
        Buffer.from(merged.text, "utf8"),
      );
      check();
      return parseTreeEntry({ ...ours, mode, object_id: object.object_id });
    };
    const mergeDirectory = async (
      base: string,
      ours: string,
      theirs: string,
      path: string,
    ): Promise<string> => {
      check();
      if (ours === theirs || base === theirs) {
        metrics.subtrees_reused++;
        return ours;
      }
      if (base === ours) {
        metrics.subtrees_reused++;
        return theirs;
      }
      const a = await rootRef(base),
        b = await rootRef(ours),
        c = await rootRef(theirs),
        changes = new Map<string, Change>();
      await diff(a, b, "", "ours", changes);
      await diff(a, c, "", "theirs", changes);
      const patches: { path: string; entry: TreeEntry | null }[] = [];
      for (const [name, change] of [...changes].sort(([a], [b]) =>
        compareUTF8(a, b),
      )) {
        check();
        const priorConflicts = conflicts.length,
          entry = await mergeEntry(path ? path + "/" + name : name, change);
        if (
          conflicts.length === priorConflicts &&
          !sameEntry(entry, change.ours)
        )
          patches.push({ path: name, entry });
      }
      if (!patches.length) return ours;
      check();
      const result = await this.trees.apply(scope, ours, patches);
      metrics.nodes_read += result.metrics.nodes_read;
      metrics.nodes_written += result.metrics.nodes_written;
      check();
      return result.root_tree_id;
    };
    await rootRef(input.base_tree_id);
    await rootRef(input.ours_tree_id);
    await rootRef(input.theirs_tree_id);
    const root = await mergeDirectory(
      input.base_tree_id,
      input.ours_tree_id,
      input.theirs_tree_id,
      "",
    );
    conflicts.sort(
      (a, b) => compareUTF8(a.path, b.path) || compareUTF8(a.kind, b.kind),
    );
    return {
      root_tree_id: conflicts.length ? null : root,
      conflicts: Object.freeze(conflicts),
      metrics,
      algorithm: "hyperfide-three-way-v1",
      rename_detection: {
        status: "NOT_PERFORMED",
        reason: "EXPLICIT_PATH_IDENTITY_ONLY",
      },
    };
  }
}
