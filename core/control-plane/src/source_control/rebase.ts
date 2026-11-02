import type {SourceContext, SourceMetadata, SourceRevisionRecord} from './metadata.js';
import {sourceFailure, sourceScopeValues} from './metadata.js';

export interface RebaseStep {
  original_revision_id: string;
  base_revision_id: string;
  change_id: string;
  original: SourceRevisionRecord;
}

export async function prepareRebaseStack(metadata: SourceMetadata, context: SourceContext, ids: readonly string[], signal?: AbortSignal): Promise<RebaseStep[]> {
  const steps: RebaseStep[] = [];
  const deadline = Date.now() + 10000;
  for (const id of ids) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) sourceFailure('LIMIT_EXCEEDED', 'Rebase stack validation exceeded its deadline');
    const original = await metadata.readRevision(context, id);
    if (original.parent_revision_ids.length !== 1) sourceFailure('REBASE_MAINLINE_REQUIRED', 'A replayed revision must have exactly one pinned parent');
    if (steps.length && original.parent_revision_ids[0] !== steps.at(-1)!.original_revision_id)
      sourceFailure('INVALID_REBASE_STACK', 'Rebase revisions must form an ordered linear stack');
    const membership = await metadata.transaction(async tx => {
      await metadata.guard(tx, context, 'source.transforms.rebase');
      return (await tx.query('SELECT change_id FROM hyperfide.source_change_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4 ORDER BY change_id LIMIT 2', [...sourceScopeValues(context.scope), id])).rows;
    });
    if (membership.length !== 1) sourceFailure('AMBIGUOUS_CHANGE_IDENTITY', 'A rebased revision requires one retained stable change identity');
    steps.push({original_revision_id: id, base_revision_id: original.parent_revision_ids[0]!, change_id: membership[0]!.change_id, original});
  }
  return steps;
}

export async function selectMergeBase(metadata: SourceMetadata, context: SourceContext, left: string, right: string, explicit?: string, signal?: AbortSignal): Promise<{revision: SourceRevisionRecord; merge_base_ids: string[]}> {
  const records = new Map<string, SourceRevisionRecord>();
  const deadline = Date.now() + 10000;
  const read = async (id: string): Promise<SourceRevisionRecord> => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) sourceFailure('LIMIT_EXCEEDED', 'Merge-base traversal exceeded its deadline');
    let revision = records.get(id);
    if (!revision) {
      if (records.size >= 4096) sourceFailure('LIMIT_EXCEEDED', 'Merge-base traversal exceeds 4096 pinned revisions');
      revision = await metadata.readRevision(context, id);
      records.set(id, revision);
    }
    return revision;
  };
  if (left === right) {
    if (explicit !== undefined && explicit !== left) sourceFailure('INVALID_MERGE_BASE', 'Explicit merge base must be a maximal common ancestor');
    return {revision: await read(left), merge_base_ids: [left]};
  }
  const linearSeen = [new Set<string>(), new Set<string>()];
  const tips: (string | undefined)[] = [left, right];
  let linear = true;
  while (linear && tips.some(id => id !== undefined)) {
    if (tips[0] !== undefined && tips[0] === tips[1]) {
      const common = tips[0];
      if (explicit !== undefined && explicit !== common) sourceFailure('INVALID_MERGE_BASE', 'Explicit merge base must be a maximal common ancestor');
      return {revision: await read(common), merge_base_ids: [common]};
    }
    for (let side = 0; side < 2; side++) {
      const id = tips[side];
      if (id === undefined) continue;
      if (linearSeen[1 - side]!.has(id)) {
        if (explicit !== undefined && explicit !== id) sourceFailure('INVALID_MERGE_BASE', 'Explicit merge base must be a maximal common ancestor');
        return {revision: await read(id), merge_base_ids: [id]};
      }
      linearSeen[side]!.add(id);
      const revision = await read(id);
      if (revision.parent_revision_ids.length > 1) {linear = false; break;}
      tips[side] = revision.parent_revision_ids[0];
    }
  }
  const ancestors = async (start: string): Promise<Set<string>> => {
    const pending = [start], seen = new Set<string>();
    while (pending.length) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) sourceFailure('LIMIT_EXCEEDED', 'Merge-base traversal exceeded its deadline');
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const revision = await read(id);
      pending.push(...revision.parent_revision_ids);
    }
    return seen;
  };
  const a = await ancestors(left), b = await ancestors(right);
  const common = new Set([...a].filter(id => b.has(id))), nonBases = new Set<string>();
  for (const id of common) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) sourceFailure('LIMIT_EXCEEDED', 'Merge-base traversal exceeded its deadline');
    for (const parent of records.get(id)!.parent_revision_ids) if (common.has(parent)) nonBases.add(parent);
  }
  const bases = [...common].filter(id => !nonBases.has(id)).sort();
  if (!bases.length) sourceFailure('UNRELATED_HISTORIES', 'Pinned revisions have no retained common ancestor');
  if (explicit !== undefined && !bases.includes(explicit)) sourceFailure('INVALID_MERGE_BASE', 'Explicit merge base must be a maximal common ancestor');
  if (explicit === undefined && bases.length !== 1) sourceFailure('MULTIPLE_MERGE_BASES', 'Multiple merge bases require an explicit pinned base');
  return {revision: records.get(explicit ?? bases[0]!)!, merge_base_ids: bases};
}
