import type {SourceRevisionRecord} from './metadata.js';
import {sourceFailure} from './metadata.js';

export function selectRevertParent(revision: SourceRevisionRecord, mainline?: string): string {
  if (!revision.parent_revision_ids.length) sourceFailure('REVERT_ROOT_UNSUPPORTED', 'Reverting a root revision requires an explicit source patch');
  if (revision.parent_revision_ids.length > 1 && mainline === undefined)
    sourceFailure('MAINLINE_REQUIRED', 'Reverting a merge revision requires its explicit mainline parent');
  const parent = mainline ?? revision.parent_revision_ids[0]!;
  if (!revision.parent_revision_ids.includes(parent)) sourceFailure('INVALID_MAINLINE', 'Mainline must identify a pinned parent of the reverted revision');
  return parent;
}
