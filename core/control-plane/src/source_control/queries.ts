import { canonicalJSON, SourceControlError } from "./contracts.js";

export interface QueryRevision {
  revision_id: string;
  root_tree_id: string;
  parent_revision_ids: readonly string[];
  descriptor: unknown;
  created_at?: string;
  generation?: string;
  index_complete?: boolean;
}
export interface QueryTreeEntry {
  name: string;
  kind: "file" | "directory" | "symlink";
  mode: string;
  object_id: string;
}
export interface SourceQueryReader {
  revision(id: string): Promise<QueryRevision>;
  tree(
    id: string,
    after: string | undefined,
    limit: number,
  ): Promise<{
    entries: readonly QueryTreeEntry[];
    next_cursor: string | null;
  }>;
  file(revision: string, path: string): Promise<Uint8Array | null>;
  ancestryIndex?(id: string): Promise<readonly QueryRevision[]>;
  pathIdentity?(revision: QueryRevision, path: string): Promise<string | null>;
}
export interface QueryBudget {
  max_nodes: number;
  max_bytes: number;
  max_ms: number;
  signal?: AbortSignal;
}
export interface QueryCoverage {
  state: "COMPLETE" | "PARTIAL" | "REDACTED";
  paths?: { path: string; state: "REDACTED" }[];
  visited_nodes: number;
  bytes_read: number;
  reason?: "NODE_BUDGET" | "TIME_BUDGET" | "PAGE_LIMIT";
}
interface WalkState {
  frontier: string[];
  seen: string[];
  target_generation?: string;
}
interface MergeState {
  left: WalkState;
  right: WalkState;
  revisions: Record<string, { parents: string[] }>;
  phase: "LEFT" | "RIGHT" | "PRUNE";
  common: string[];
  pruned: string[];
  offset: number;
}
export interface QueryFreshness {
  index_generation: string;
  index_complete: boolean;
}
export class SourcePathSelection {
  readonly effective: string[];
  readonly redacted: { path: string; state: "REDACTED" }[];
  constructor(
    readonly paths: readonly string[] = [""],
    readonly prefixes: readonly string[] = [""],
  ) {
    this.effective = [
      ...new Set(
        paths.flatMap((path) =>
          prefixes.flatMap((prefix) =>
            within(path, prefix)
              ? [path]
              : within(prefix, path)
                ? [prefix]
                : [],
          ),
        ),
      ),
    ];
    this.redacted = paths
      .filter((path) => !prefixes.some((prefix) => within(path, prefix)))
      .map((path) => ({ path, state: "REDACTED" as const }));
  }
  includes(path: string): boolean {
    return this.effective.some((prefix) => within(path, prefix));
  }
  intersects(path: string): boolean {
    return this.effective.some(
      (prefix) => within(path, prefix) || within(prefix, path),
    );
  }
  coverage(coverage: QueryCoverage): QueryCoverage {
    return this.redacted.length
      ? {
          ...coverage,
          state: coverage.state === "COMPLETE" ? "REDACTED" : coverage.state,
          paths: this.redacted,
        }
      : coverage;
  }
}
const within = (path: string, prefix: string) =>
  prefix === "" || path === prefix || path.startsWith(prefix + "/");
interface DirectoryWork {
  path: string;
  before: string | null;
  after: string | null;
  after_name?: string;
}
export interface DiffState {
  directories: DirectoryWork[];
}
export interface SourceDiffEntry {
  path: string;
  kind: "ADDED" | "REMOVED" | "MODIFIED" | "TYPE_CHANGED";
  before: QueryTreeEntry | null;
  after: QueryTreeEntry | null;
}
const order = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function walkState(value: unknown, start: string): WalkState {
  if (value === undefined) return { frontier: [start], seen: [] };
  if (
    !record(value) ||
    !Array.isArray(value.frontier) ||
    !Array.isArray(value.seen) ||
    [...value.frontier, ...value.seen].some(
      (v) => typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v),
    )
  )
    throw new SourceControlError(
      "INVALID_CURSOR",
      "Malformed history continuation",
    );
  if (
    value.target_generation !== undefined &&
    (typeof value.target_generation !== "string" ||
      !/^\d+$/.test(value.target_generation))
  )
    throw new SourceControlError(
      "INVALID_CURSOR",
      "Malformed ancestry generation",
    );
  return {
    frontier: [...value.frontier] as string[],
    seen: [...value.seen] as string[],
    ...(typeof value.target_generation === "string"
      ? { target_generation: value.target_generation }
      : {}),
  };
}
function mergeState(value: unknown, left: string, right: string): MergeState {
  if (value === undefined)
    return {
      left: walkState(undefined, left),
      right: walkState(undefined, right),
      revisions: {},
      phase: "LEFT",
      common: [],
      pruned: [],
      offset: 0,
    };
  const ids = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.every(
      (id) => typeof id === "string" && /^sha256:[a-f0-9]{64}$/.test(id),
    );
  if (
    !record(value) ||
    !record(value.left) ||
    !record(value.right) ||
    !record(value.revisions) ||
    (value.phase !== "LEFT" &&
      value.phase !== "RIGHT" &&
      value.phase !== "PRUNE") ||
    !ids(value.common) ||
    !ids(value.pruned) ||
    typeof value.offset !== "number" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    value.offset > value.common.length
  )
    throw new SourceControlError(
      "INVALID_CURSOR",
      "Malformed merge base continuation",
    );
  const revisions: MergeState["revisions"] = {};
  for (const [id, node] of Object.entries(value.revisions)) {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(id) ||
      !record(node) ||
      !ids(node.parents)
    )
      throw new SourceControlError(
        "INVALID_CURSOR",
        "Malformed merge base parents",
      );
    revisions[id] = { parents: [...node.parents] };
  }
  return {
    left: walkState(value.left, left),
    right: walkState(value.right, right),
    revisions,
    phase: value.phase,
    common: [...value.common],
    pruned: [...value.pruned],
    offset: value.offset,
  };
}
class Meter {
  nodes = 0;
  bytes = 0;
  private readonly deadline: number;
  constructor(readonly budget: QueryBudget) {
    if (
      !Number.isSafeInteger(budget.max_nodes) ||
      budget.max_nodes < 1 ||
      budget.max_nodes > 8192 ||
      !Number.isSafeInteger(budget.max_bytes) ||
      budget.max_bytes < 1 ||
      budget.max_bytes > 16777216 ||
      !Number.isSafeInteger(budget.max_ms) ||
      budget.max_ms < 1 ||
      budget.max_ms > 30000
    )
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "Query budget exceeds service bounds",
      );
    this.deadline = Date.now() + budget.max_ms;
  }
  check(): boolean {
    this.budget.signal?.throwIfAborted();
    return this.nodes < this.budget.max_nodes && Date.now() < this.deadline;
  }
  addBytes(size: number): void {
    this.bytes += size;
    if (this.bytes > this.budget.max_bytes)
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "Query content exceeds the byte budget",
      );
  }
  coverage(complete: boolean): QueryCoverage {
    return {
      state: complete ? "COMPLETE" : "PARTIAL",
      visited_nodes: this.nodes,
      bytes_read: this.bytes,
      ...(!complete
        ? {
            reason:
              this.nodes >= this.budget.max_nodes
                ? ("NODE_BUDGET" as const)
                : Date.now() >= this.deadline
                  ? ("TIME_BUDGET" as const)
                  : ("PAGE_LIMIT" as const),
          }
        : {}),
    };
  }
}
export class SourceQueries {
  private readonly revisions = new Map<string, QueryRevision>();
  private readonly indexed = new Set<string>();
  private readonly membership = new Map<string, Set<string>>();
  constructor(
    private readonly reader: SourceQueryReader,
    private readonly selection = new SourcePathSelection(),
  ) {}
  private async revision(id: string, index = false): Promise<QueryRevision> {
    if (index && !this.indexed.has(id) && this.reader.ancestryIndex) {
      this.indexed.add(id);
      const entries = await this.reader.ancestryIndex(id);
      this.membership.set(
        id,
        new Set(entries.map((revision) => revision.revision_id)),
      );
      for (const revision of entries)
        this.revisions.set(revision.revision_id, revision);
    }
    let revision = this.revisions.get(id);
    if (!revision) {
      revision = await this.reader.revision(id);
      this.revisions.set(id, revision);
    }
    return revision;
  }
  async freshness(...ids: string[]): Promise<QueryFreshness> {
    const revisions = await Promise.all(
      ids.map((id) => this.revision(id, true)),
    );
    return {
      index_generation: revisions
        .reduce(
          (n, r) =>
            BigInt(r.generation ?? "0") > n ? BigInt(r.generation!) : n,
          0n,
        )
        .toString(),
      index_complete: revisions.every((r) => r.index_complete === true),
    };
  }
  private async touches(
    revision: QueryRevision,
    budget: QueryBudget,
  ): Promise<boolean> {
    if (this.selection.effective.includes("")) return true;
    if (!this.selection.effective.length) return false;
    if (!this.reader.pathIdentity)
      throw new SourceControlError(
        "CAPABILITY_UNAVAILABLE",
        "Path history requires pinned tree lookup",
      );
    const parent = revision.parent_revision_ids[0]
      ? await this.revision(revision.parent_revision_ids[0])
      : null;
    for (const path of this.selection.effective) {
      budget.signal?.throwIfAborted();
      const current = await this.reader.pathIdentity(revision, path),
        before = parent ? await this.reader.pathIdentity(parent, path) : null;
      if (current !== before) return true;
    }
    return false;
  }
  async history(
    start: string,
    limit: number,
    budget: QueryBudget,
    continuation?: unknown,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "History page limit must be between one and 256",
      );
    const meter = new Meter(budget),
      freshness = await this.freshness(start),
      state = walkState(continuation, start),
      seen = new Set(state.seen),
      queued = new Set(state.frontier),
      entries: QueryRevision[] = [];
    let outputBytes = 0;
    while (state.frontier.length && entries.length < limit && meter.check()) {
      const id = state.frontier.shift()!;
      queued.delete(id);
      if (seen.has(id)) continue;
      const revision = await this.revision(id),
        size = Buffer.byteLength(canonicalJSON(revision));
      meter.nodes++;
      meter.addBytes(size);
      if (entries.length && outputBytes + size > 524288) {
        state.frontier.unshift(id);
        break;
      }
      seen.add(id);
      if (await this.touches(revision, budget)) {
        entries.push(revision);
        outputBytes += size;
      }
      for (const parent of revision.parent_revision_ids)
        if (!seen.has(parent) && !queued.has(parent)) {
          state.frontier.push(parent);
          queued.add(parent);
        }
    }
    const complete = state.frontier.length === 0;
    return {
      ...freshness,
      entries,
      coverage: this.selection.coverage(meter.coverage(complete)),
      continuation: complete
        ? null
        : { frontier: state.frontier, seen: [...seen] },
    };
  }
  async ancestry(
    ancestor: string,
    descendant: string,
    budget: QueryBudget,
    continuation?: unknown,
  ) {
    const meter = new Meter(budget),
      freshness = await this.freshness(descendant),
      state = walkState(continuation, descendant),
      seen = new Set(state.seen);
    if (state.target_generation === undefined) {
      const target = await this.revision(ancestor);
      meter.nodes++;
      state.target_generation = target.generation ?? "0";
    }
    const target = BigInt(state.target_generation);
    while (state.frontier.length && meter.check()) {
      const id = state.frontier.shift()!;
      if (seen.has(id)) continue;
      const revision = await this.revision(id);
      meter.nodes++;
      meter.addBytes(Buffer.byteLength(canonicalJSON(revision)));
      seen.add(id);
      if (id === ancestor)
        return {
          ...freshness,
          is_ancestor: true,
          coverage: meter.coverage(true),
          continuation: null,
        };
      if (this.membership.get(id)?.has(ancestor))
        return {
          ...freshness,
          is_ancestor: true,
          coverage: meter.coverage(true),
          continuation: null,
        };
      const generation = BigInt(revision.generation ?? "0");
      if (generation > 0n && target > 0n && generation <= target) continue;
      if (
        revision.index_complete === true &&
        this.indexed.has(id) &&
        !this.membership.get(id)?.has(ancestor)
      )
        continue;
      for (const parent of revision.parent_revision_ids)
        if (!seen.has(parent) && !state.frontier.includes(parent)) {
          const known = this.revisions.get(parent),
            generation = BigInt(known?.generation ?? "0");
          if (target === 0n || generation === 0n || generation >= target)
            state.frontier.push(parent);
        }
    }
    const complete = state.frontier.length === 0;
    return {
      ...freshness,
      is_ancestor: complete ? false : null,
      coverage: meter.coverage(complete),
      continuation: complete ? null : { ...state, seen: [...seen] },
    };
  }
  async mergeBases(
    left: string,
    right: string,
    budget: QueryBudget,
    continuation?: unknown,
  ) {
    const meter = new Meter(budget),
      freshness = await this.freshness(left, right);
    if (continuation === undefined && budget.max_nodes >= 2 && meter.check()) {
      const base =
        left === right
          ? left
          : this.membership.get(left)?.has(right)
            ? right
            : this.membership.get(right)?.has(left)
              ? left
              : null;
      if (base) {
        meter.nodes = 2;
        return {
          ...freshness,
          revision_ids: [base],
          coverage: meter.coverage(true),
          continuation: null,
        };
      }
    }
    const state = mergeState(continuation, left, right);
    for (const side of ["LEFT", "RIGHT"] as const) {
      if (state.phase !== side) continue;
      const walk = state[side === "LEFT" ? "left" : "right"],
        seen = new Set(walk.seen),
        queued = new Set(walk.frontier);
      while (walk.frontier.length && meter.check()) {
        const id = walk.frontier.shift()!;
        queued.delete(id);
        if (seen.has(id)) continue;
        let node = state.revisions[id];
        if (!node) {
          const revision = await this.revision(id);
          meter.addBytes(Buffer.byteLength(canonicalJSON(revision)));
          node = { parents: [...revision.parent_revision_ids] };
          state.revisions[id] = node;
        }
        meter.nodes++;
        seen.add(id);
        for (const parent of node.parents)
          if (!seen.has(parent) && !queued.has(parent)) {
            walk.frontier.push(parent);
            queued.add(parent);
          }
      }
      walk.seen = [...seen];
      if (walk.frontier.length)
        return {
          ...freshness,
          revision_ids: null,
          coverage: meter.coverage(false),
          continuation: state,
        };
      state.phase = side === "LEFT" ? "RIGHT" : "PRUNE";
    }
    if (!state.common.length) {
      const rightSeen = new Set(state.right.seen);
      state.common = state.left.seen.filter((id) => rightSeen.has(id));
    }
    const common = new Set(state.common),
      nonBases = new Set(state.pruned);
    while (state.offset < state.common.length && meter.check()) {
      const id = state.common[state.offset++]!;
      meter.nodes++;
      for (const parent of state.revisions[id]!.parents)
        if (common.has(parent)) nonBases.add(parent);
    }
    const complete = state.offset === state.common.length;
    state.pruned = [...nonBases];
    return {
      ...freshness,
      revision_ids: complete
        ? state.common.filter((id) => !nonBases.has(id)).sort(order)
        : null,
      coverage: meter.coverage(complete),
      continuation: complete ? null : state,
    };
  }
  async diff(
    beforeTree: string,
    afterTree: string,
    limit: number,
    budget: QueryBudget,
    continuation?: unknown,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "Diff page limit exceeds bounds",
      );
    let state: DiffState = {
      directories: [{ path: "", before: beforeTree, after: afterTree }],
    };
    if (continuation !== undefined) {
      if (
        !record(continuation) ||
        !Array.isArray(continuation.directories) ||
        continuation.directories.length > 4096
      )
        throw new SourceControlError(
          "INVALID_CURSOR",
          "Malformed diff continuation",
        );
      state = { directories: continuation.directories as DirectoryWork[] };
      for (const item of state.directories)
        if (
          !record(item) ||
          typeof item.path !== "string" ||
          !["string", "object"].includes(typeof item.before) ||
          !["string", "object"].includes(typeof item.after)
        )
          throw new SourceControlError(
            "INVALID_CURSOR",
            "Malformed directory continuation",
          );
    }
    const meter = new Meter(budget),
      entries: SourceDiffEntry[] = [];
    while (
      state.directories.length &&
      entries.length < limit &&
      meter.check()
    ) {
      const work = state.directories[0]!;
      if (work.before === work.after) {
        state.directories.shift();
        continue;
      }
      const amount = Math.min(256, budget.max_nodes - meter.nodes),
        [a, b] = await Promise.all([
          work.before
            ? this.reader.tree(work.before, work.after_name, amount)
            : Promise.resolve({ entries: [], next_cursor: null }),
          work.after
            ? this.reader.tree(work.after, work.after_name, amount)
            : Promise.resolve({ entries: [], next_cursor: null }),
        ]);
      const old = new Map(a.entries.map((entry) => [entry.name, entry])),
        next = new Map(b.entries.map((entry) => [entry.name, entry]));
      const names = [...new Set([...old.keys(), ...next.keys()])]
        .sort(order)
        .slice(0, amount);
      if (!names.length) {
        state.directories.shift();
        continue;
      }
      for (const name of names) {
        if (entries.length >= limit || !meter.check()) break;
        const before = old.get(name) ?? null,
          after = next.get(name) ?? null;
        meter.nodes++;
        work.after_name = name;
        if (
          before?.object_id === after?.object_id &&
          before?.mode === after?.mode &&
          before?.kind === after?.kind
        )
          continue;
        const path = work.path ? work.path + "/" + name : name;
        if (!this.selection.intersects(path)) continue;
        if (
          (before?.kind === "directory" || before === null) &&
          (after?.kind === "directory" || after === null)
        ) {
          state.directories.push({
            path,
            before: before?.object_id ?? null,
            after: after?.object_id ?? null,
          });
          if (
            this.selection.includes(path) &&
            (before === null || after === null)
          )
            entries.push({
              path,
              kind: before === null ? "ADDED" : "REMOVED",
              before,
              after,
            });
          continue;
        }
        if (before?.kind === "directory" || after?.kind === "directory")
          state.directories.push({
            path,
            before: before?.kind === "directory" ? before.object_id : null,
            after: after?.kind === "directory" ? after.object_id : null,
          });
        if (this.selection.includes(path))
          entries.push({
            path,
            kind:
              before === null
                ? "ADDED"
                : after === null
                  ? "REMOVED"
                  : before.kind !== after.kind
                    ? "TYPE_CHANGED"
                    : "MODIFIED",
            before,
            after,
          });
      }
      const fullyConsumed =
        work.after_name === names.at(-1) &&
        a.next_cursor === null &&
        b.next_cursor === null &&
        names.length === new Set([...old.keys(), ...next.keys()]).size;
      if (fullyConsumed) state.directories.shift();
      if (state.directories.length > 4096)
        throw new SourceControlError(
          "LIMIT_EXCEEDED",
          "Diff frontier exceeds continuation bounds",
        );
    }
    const complete = state.directories.length === 0;
    return {
      entries,
      coverage: this.selection.coverage(meter.coverage(complete)),
      continuation: complete ? null : state,
    };
  }
  async lineMap(
    before: string,
    after: string,
    path: string,
    budget: QueryBudget,
  ) {
    const meter = new Meter(budget);
    if (budget.max_nodes < 2)
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "Line mapping requires two pinned file reads",
      );
    const freshness = await this.freshness(before, after);
    const [a, b] = await Promise.all([
      this.reader.file(before, path),
      this.reader.file(after, path),
    ]);
    meter.nodes += 2;
    meter.addBytes((a?.byteLength ?? 0) + (b?.byteLength ?? 0));
    const old = textLines(a),
      next = textLines(b);
    if (old === null || next === null)
      return {
        ...freshness,
        binary: true,
        mappings: [],
        coverage: meter.coverage(true),
      };
    const mappings = matchLines(old, next, budget.signal).map(
      ([before_line, after_line]) => ({
        before_line: before_line + 1,
        after_line: after_line + 1,
      }),
    );
    return {
      ...freshness,
      binary: false,
      before_lines: old.length,
      after_lines: next.length,
      mappings,
      coverage: meter.coverage(true),
    };
  }
  async blame(
    start: string,
    path: string,
    budget: QueryBudget,
    range: { start_line: number; limit: number } = {
      start_line: 1,
      limit: 128,
    },
  ) {
    if (
      !Number.isSafeInteger(range.start_line) ||
      range.start_line < 1 ||
      !Number.isSafeInteger(range.limit) ||
      range.limit < 1 ||
      range.limit > 256
    )
      throw new SourceControlError(
        "INVALID_REQUEST",
        "Blame requires a bounded positive line range",
      );
    const meter = new Meter(budget),
      freshness = await this.freshness(start),
      initial = await this.reader.file(start, path);
    meter.addBytes(initial?.byteLength ?? 0);
    if (initial === null)
      throw new SourceControlError(
        "OBJECT_NOT_AVAILABLE",
        "File is absent at the pinned revision",
      );
    const lines = textLines(initial);
    if (lines === null)
      return {
        ...freshness,
        binary: true,
        lines: [],
        next_line: null,
        coverage: meter.coverage(true),
        strategy: "FIRST_PARENT",
      };
    const selected = lines.slice(
        range.start_line - 1,
        range.start_line - 1 + range.limit,
      ),
      origins = new Map<number, string>();
    const unresolved = new Map(
      selected.map((_, index) => [
        index + range.start_line - 1,
        index + range.start_line - 1,
      ]),
    );
    let current = start,
      currentLines = lines;
    while (unresolved.size && meter.check()) {
      const revision = await this.reader.revision(current);
      meter.nodes++;
      const parent = revision.parent_revision_ids[0];
      if (!parent) {
        for (const original of unresolved.keys())
          origins.set(original, current);
        unresolved.clear();
        break;
      }
      const bytes = await this.reader.file(parent, path);
      meter.addBytes(bytes?.byteLength ?? 0);
      const parentLines = textLines(bytes);
      if (parentLines === null)
        throw new SourceControlError(
          "HISTORY_REDACTED",
          "A binary predecessor cannot establish text line ancestry",
        );
      const prior = new Map(
        matchLines(parentLines, currentLines, budget.signal).map(([a, b]) => [
          b,
          a,
        ]),
      );
      for (const [original, index] of unresolved) {
        const parentIndex = prior.get(index);
        if (parentIndex === undefined) {
          origins.set(original, current);
          unresolved.delete(original);
        } else unresolved.set(original, parentIndex);
      }
      current = parent;
      currentLines = parentLines;
    }
    return {
      ...freshness,
      binary: false,
      strategy: "FIRST_PARENT",
      lines: selected.map((content, index) => ({
        line: index + range.start_line,
        content,
        origin_revision_id: origins.get(index + range.start_line - 1) ?? null,
      })),
      next_line:
        range.start_line - 1 + selected.length < lines.length
          ? range.start_line + selected.length
          : null,
      coverage: meter.coverage(unresolved.size === 0),
    };
  }
}
function textLines(bytes: Uint8Array | null): string[] | null {
  if (bytes === null) return [];
  if (bytes.byteLength > 2 * 1024 * 1024)
    throw new SourceControlError(
      "LIMIT_EXCEEDED",
      "Text query requires a file no larger than 2 MiB",
    );
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return null;
    return text.length ? (text.match(/[^\n]*\n|[^\n]+$/g) ?? []) : [];
  } catch {
    return null;
  }
}
function matchLines(
  before: readonly string[],
  after: readonly string[],
  signal?: AbortSignal,
): Array<[number, number]> {
  const cells = (before.length + 1) * (after.length + 1);
  if (cells > 2000000)
    throw new SourceControlError(
      "LIMIT_EXCEEDED",
      "Exact line comparison exceeds its matrix budget",
    );
  const width = after.length + 1,
    table = new Uint32Array(cells);
  for (let a = before.length - 1; a >= 0; a--) {
    signal?.throwIfAborted();
    for (let b = after.length - 1; b >= 0; b--)
      table[a * width + b] =
        before[a] === after[b]
          ? table[(a + 1) * width + b + 1]! + 1
          : Math.max(table[(a + 1) * width + b]!, table[a * width + b + 1]!);
  }
  const result: Array<[number, number]> = [];
  let a = 0,
    b = 0;
  while (a < before.length && b < after.length) {
    if (before[a] === after[b]) {
      result.push([a++, b++]);
    } else if (table[(a + 1) * width + b]! >= table[a * width + b + 1]!) a++;
    else b++;
  }
  return result;
}
