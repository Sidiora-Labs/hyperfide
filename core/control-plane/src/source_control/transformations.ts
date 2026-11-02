import {createHash} from 'node:crypto';
import {canonicalBytes, parseGeneration, parseObjectId, parsePublicProvenance, parseUUID, SourceControlError} from './contracts.js';
import type {PublicProvenance, SourceScope} from './contracts.js';
import {SourceMetadata, revisionDescriptor, revisionIdentity, sourceDigest, sourceFailure, sourceScopeValues} from './metadata.js';
import type {RevisionReceipt, SourceContext, SourceSQL} from './metadata.js';
import {reserveSourceOperation} from './operations.js';
import {prepareRebaseStack, selectMergeBase} from './rebase.js';
import {selectRevertParent} from './revert.js';
import {SourceMergeEngine, normalizeSourceMergeBudget} from './merge.js';
import type {SourceMergeBudget, SourceMergeResult} from './merge.js';
import type {SourceConflict} from './conflicts.js';

interface StartInput {operation_id: string; idempotency_key: string; budget?: Partial<SourceMergeBudget>}
export interface MergeInput extends StartInput {ours_revision_id: string; theirs_revision_id: string; base_revision_id?: string; change_id: string; provenance: PublicProvenance}
export interface RebaseInput extends StartInput {revision_ids: string[]; onto_revision_id: string; max_steps?: number}
export interface RevertInput extends StartInput {revision_id: string; onto_revision_id: string; mainline_parent_revision_id?: string; change_id: string; provenance: PublicProvenance}
export interface ResumeInput {
  operation_id: string; max_steps?: number; expected_generation?: string;
  resolution?: {conflict_id: string; resolved_tree_id: string; provenance?: PublicProvenance};
}
export interface TransformationMapping {original_revision_id: string; successor_revision_id: string; change_id: string; unchanged: boolean; receipt: RevisionReceipt}
export interface TransformationResult {
  schema_version: 1; scope: SourceScope; operation_id: string; kind: 'MERGE' | 'REBASE' | 'REVERT';
  status: 'PENDING' | 'CONFLICT' | 'COMPLETED' | 'CANCELLED'; generation: string;
  algorithm: 'hyperfide-three-way-v1'; merge_base_strategy: 'REQUIRE_EXPLICIT_MAXIMAL_BASE';
  merge_base_ids: string[]; next_step: number; total_steps: number; tip_revision_id: string;
  mappings: TransformationMapping[]; conflicts: readonly SourceConflict[]; conflict_id?: string;
  receipt?: RevisionReceipt; metrics?: SourceMergeResult['metrics'];
  rename_detection: {status: 'NOT_PERFORMED'; reason: 'EXPLICIT_PATH_IDENTITY_ONLY'};
}
interface StepPlan {original_revision_id: string; source_revision_id: string; base_revision_id: string; change_id: string; provenance: PublicProvenance; parents?: string[]; predecessor_revision_ids: string[]}
interface Plan {input: Record<string, unknown>; steps: StepPlan[]; merge_base_ids: string[]; tip_revision_id: string; budget?: Partial<SourceMergeBudget>}
interface Stored {
  operation_id: string; authority_epoch: string; kind: TransformationResult['kind']; request: Plan;
  generation: string; status: 'ACTIVE' | 'CONFLICT' | 'COMPLETED'; next_step: number; tip_revision_id: string;
  result: TransformationResult; operation_state: 'PENDING' | 'COMMITTED' | 'CANCELLED' | 'FAILED';
}
interface RunOptions {signal?: AbortSignal}
const scopeKey = (context: SourceContext, operation: string): string[] => [...sourceScopeValues(context.scope), context.principal_id, operation];
function stepLimit(value?: number): number {
  if (value === undefined) return 8;
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) sourceFailure('LIMIT_EXCEEDED', 'Transformation call step budget must be between one and 64');
  return value;
}
function operationInput(input: StartInput): void {
  parseUUID(input.operation_id, 'operation_id');
  if (typeof input.idempotency_key !== 'string' || !input.idempotency_key.length || Buffer.byteLength(input.idempotency_key) > 256)
    sourceFailure('INVALID_REQUEST', 'Transformation requires an explicit bounded idempotency key');
  normalizeSourceMergeBudget(input.budget);
}
function semanticInput(input: StartInput): Record<string, unknown> {
  const result = {...input} as Record<string, unknown>;
  delete result.operation_id; delete result.idempotency_key;
  if (canonicalBytes(result).byteLength > 262144) sourceFailure('LIMIT_EXCEEDED', 'Transformation request exceeds its metadata budget');
  return result;
}
function derivedOperation(context: SourceContext, operation: string, step: number): string {
  const bytes = createHash('sha256').update(sourceDigest([context.scope, context.principal_id, operation, step, 'source-transform-revision-v1'])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function notCancelled(options: RunOptions): void {
  if (options.signal?.aborted) throw new SourceControlError('OPERATION_INTERRUPTED', 'Resume the retained transformation operation after cancellation', 'RETRY_SAME_OPERATION', 'UNKNOWN');
}
function view(row: Stored): TransformationResult {
  return row.operation_state === 'CANCELLED' ? {...row.result, status: 'CANCELLED'} : row.result;
}

export class SourceTransformationService {
  constructor(readonly metadata: SourceMetadata, readonly engine: SourceMergeEngine) {}

  private async row(tx: SourceSQL, context: SourceContext, operation: string, lock = false): Promise<Stored> {
    const row = (await tx.query(`SELECT t.*,t.authority_epoch::text,t.generation::text,o.state AS operation_state FROM hyperfide.source_transformations t JOIN hyperfide.source_metadata_operations o USING(organisation_id,repository_id,security_domain_id,principal_id,operation_id) WHERE t.organisation_id=$1 AND t.repository_id=$2 AND t.security_domain_id=$3 AND t.principal_id=$4 AND t.operation_id=$5${lock ? ' FOR UPDATE OF o,t' : ''}`, scopeKey(context, operation))).rows[0] as Stored | undefined;
    if (!row) sourceFailure('NOT_FOUND', 'Transformation is unavailable in the authorized source scope');
    if (row.authority_epoch !== context.authority_epoch) sourceFailure('STALE_AUTHORITY', 'Transformation authority epoch changed');
    return row;
  }

  async read(context: SourceContext, operationId: string): Promise<TransformationResult> {
    parseUUID(operationId, 'operation_id');
    return this.metadata.transaction(async tx => {
      await this.metadata.guard(tx, context, 'source.transforms.read');
      return view(await this.row(tx, context, operationId));
    });
  }

  private async start(context: SourceContext, kind: TransformationResult['kind'], input: StartInput, plan: Plan): Promise<Stored> {
    const action = `source.transforms.${kind.toLowerCase()}`;
    const digest = sourceDigest({kind, input: plan.input});
    if (canonicalBytes(plan).byteLength > 524288) sourceFailure('LIMIT_EXCEEDED', 'Retained transformation plan exceeds its metadata budget');
    return this.metadata.transaction(async tx => {
      await this.metadata.guard(tx, context, action);
      const operation = await reserveSourceOperation(tx, context, {operation_id: input.operation_id, idempotency_key: input.idempotency_key, action, request_digest: digest});
      const result: TransformationResult = {
        schema_version: 1, scope: {...context.scope}, operation_id: operation.operation_id, kind, status: 'PENDING', generation: '1',
        algorithm: 'hyperfide-three-way-v1', merge_base_strategy: 'REQUIRE_EXPLICIT_MAXIMAL_BASE', merge_base_ids: plan.merge_base_ids,
        next_step: 0, total_steps: plan.steps.length, tip_revision_id: plan.tip_revision_id, mappings: [], conflicts: [],
        rename_detection: {status: 'NOT_PERFORMED', reason: 'EXPLICIT_PATH_IDENTITY_ONLY'},
      };
      await tx.query("INSERT INTO hyperfide.source_transformations(organisation_id,repository_id,security_domain_id,principal_id,operation_id,authority_epoch,kind,request,status,tip_revision_id,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10) ON CONFLICT DO NOTHING", [...scopeKey(context, operation.operation_id), context.authority_epoch, kind, plan, plan.tip_revision_id, result]);
      return this.row(tx, context, operation.operation_id);
    });
  }

  async merge(context: SourceContext, input: MergeInput, options: RunOptions = {}): Promise<TransformationResult> {
    operationInput(input); parseUUID(input.change_id, 'change_id');
    parseObjectId(input.ours_revision_id); parseObjectId(input.theirs_revision_id);
    if (input.base_revision_id !== undefined) parseObjectId(input.base_revision_id);
    const provenance = parsePublicProvenance(input.provenance), request = semanticInput(input);
    notCancelled(options);
    const selected = await selectMergeBase(this.metadata, context, input.ours_revision_id, input.theirs_revision_id, input.base_revision_id, options.signal);
    const parents = [...new Set([input.ours_revision_id, input.theirs_revision_id])];
    const plan: Plan = {input: request, steps: [{original_revision_id: input.theirs_revision_id, source_revision_id: input.theirs_revision_id, base_revision_id: selected.revision.revision_id, change_id: input.change_id, provenance, parents, predecessor_revision_ids: []}], merge_base_ids: selected.merge_base_ids, tip_revision_id: input.ours_revision_id, ...(input.budget ? {budget: input.budget} : {})};
    const row = await this.start(context, 'MERGE', input, plan);
    return this.drive(context, row.operation_id, 1, options);
  }

  async rebase(context: SourceContext, input: RebaseInput, options: RunOptions = {}): Promise<TransformationResult> {
    operationInput(input); parseObjectId(input.onto_revision_id); const limit = stepLimit(input.max_steps);
    if (!Array.isArray(input.revision_ids) || !input.revision_ids.length || input.revision_ids.length > 64 || new Set(input.revision_ids).size !== input.revision_ids.length)
      sourceFailure('INVALID_REBASE_STACK', 'Rebase requires one to 64 unique ordered revisions');
    input.revision_ids.forEach(parseObjectId);
    const request = semanticInput(input); notCancelled(options);
    await this.metadata.readRevision(context, input.onto_revision_id);
    const stack = await prepareRebaseStack(this.metadata, context, input.revision_ids, options.signal);
    const steps: StepPlan[] = stack.map(step => ({original_revision_id: step.original_revision_id, source_revision_id: step.original_revision_id, base_revision_id: step.base_revision_id, change_id: step.change_id, provenance: step.original.descriptor.provenance, predecessor_revision_ids: [step.original_revision_id]}));
    const plan: Plan = {input: request, steps, merge_base_ids: [], tip_revision_id: input.onto_revision_id, ...(input.budget ? {budget: input.budget} : {})};
    const row = await this.start(context, 'REBASE', input, plan);
    return this.drive(context, row.operation_id, limit, options);
  }

  async revert(context: SourceContext, input: RevertInput, options: RunOptions = {}): Promise<TransformationResult> {
    operationInput(input); parseUUID(input.change_id, 'change_id'); parseObjectId(input.revision_id); parseObjectId(input.onto_revision_id);
    if (input.mainline_parent_revision_id !== undefined) parseObjectId(input.mainline_parent_revision_id);
    const provenance = parsePublicProvenance(input.provenance), request = semanticInput(input); notCancelled(options);
    const original = await this.metadata.readRevision(context, input.revision_id), parent = selectRevertParent(original, input.mainline_parent_revision_id);
    await this.metadata.readRevision(context, input.onto_revision_id);
    const plan: Plan = {input: request, steps: [{original_revision_id: input.revision_id, source_revision_id: parent, base_revision_id: input.revision_id, change_id: input.change_id, provenance, predecessor_revision_ids: []}], merge_base_ids: [], tip_revision_id: input.onto_revision_id, ...(input.budget ? {budget: input.budget} : {})};
    const row = await this.start(context, 'REVERT', input, plan);
    return this.drive(context, row.operation_id, 1, options);
  }

  async resume(context: SourceContext, input: ResumeInput, options: RunOptions = {}): Promise<TransformationResult> {
    parseUUID(input.operation_id, 'operation_id'); const limit = stepLimit(input.max_steps);
    if (input.expected_generation !== undefined) parseGeneration(input.expected_generation);
    notCancelled(options);
    await this.metadata.transaction(async tx => {await this.metadata.guard(tx, context, 'source.transforms.resume');});
    if (input.resolution !== undefined) {
      if (input.resolution === null || typeof input.resolution !== 'object' || Array.isArray(input.resolution) || Object.keys(input.resolution).some(key => !['conflict_id', 'resolved_tree_id', 'provenance'].includes(key)))
        sourceFailure('INVALID_REQUEST', 'Conflict resolution fields differ from the versioned schema');
      parseObjectId(input.resolution.conflict_id); parseObjectId(input.resolution.resolved_tree_id);
      if (input.resolution.provenance !== undefined) parsePublicProvenance(input.resolution.provenance);
      await this.resolve(context, input, options);
    }
    return this.drive(context, input.operation_id, limit, options, input.resolution === undefined ? input.expected_generation : undefined);
  }

  private async snapshot(context: SourceContext, operationId: string, expectedGeneration?: string): Promise<Stored> {
    return this.metadata.transaction(async tx => {
      await this.metadata.guard(tx, context, 'source.operations.read');
      const row = await this.row(tx, context, operationId, expectedGeneration !== undefined);
      await this.metadata.guard(tx, context, `source.transforms.${row.kind.toLowerCase()}`);
      if (expectedGeneration !== undefined && row.generation !== expectedGeneration) sourceFailure('STALE_TRANSFORMATION', 'Transformation generation changed');
      return row;
    });
  }

  private async drive(context: SourceContext, operationId: string, limit: number, options: RunOptions, expectedGeneration?: string): Promise<TransformationResult> {
    let row = await this.snapshot(context, operationId, expectedGeneration);
    for (let count = 0; count < limit; count++) {
      notCancelled(options);
      if (row.operation_state !== 'PENDING' || row.status !== 'ACTIVE') return view(row);
      const step = row.request.steps[row.next_step];
      if (!step) sourceFailure('INVALID_TRANSFORMATION', 'Retained transformation step is unavailable');
      const base = await this.metadata.readRevision(context, step.base_revision_id);
      const ours = await this.metadata.readRevision(context, row.tip_revision_id);
      const theirs = await this.metadata.readRevision(context, step.source_revision_id);
      const outcome = await this.engine.merge(context.scope, {base_tree_id: base.root_tree_id, ours_tree_id: ours.root_tree_id, theirs_tree_id: theirs.root_tree_id, ...(row.request.budget ? {budget: row.request.budget} : {}), ...(options.signal ? {signal: options.signal} : {})});
      notCancelled(options);
      row = await this.metadata.transaction(async tx => {
        await this.metadata.guard(tx, context, `source.transforms.${row.kind.toLowerCase()}`);
        const current = await this.row(tx, context, operationId, true);
        if (current.generation !== row.generation && expectedGeneration !== undefined) sourceFailure('STALE_TRANSFORMATION', 'Transformation generation changed during calculation');
        if (current.operation_state !== 'PENDING' || current.status !== 'ACTIVE' || current.generation !== row.generation) return current;
        if (outcome.conflicts.length) {
          const conflictId = sourceDigest([operationId, current.next_step, outcome.conflicts]);
          const result: TransformationResult = {...current.result, status: 'CONFLICT', generation: String(BigInt(current.generation) + 1n), conflicts: outcome.conflicts, conflict_id: conflictId, metrics: outcome.metrics};
          await tx.query('INSERT INTO hyperfide.source_transformation_conflicts(organisation_id,repository_id,security_domain_id,principal_id,operation_id,conflict_id,step,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [...scopeKey(context, operationId), conflictId, current.next_step, result]);
          await tx.query("UPDATE hyperfide.source_transformations SET generation=generation+1,status='CONFLICT',result=$6,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5", [...scopeKey(context, operationId), result]);
        } else {
          if (!outcome.root_tree_id) sourceFailure('INVALID_TRANSFORMATION', 'Successful merge requires a retained root');
          await this.commitStep(tx, context, current, outcome.root_tree_id, step.provenance, outcome.metrics);
        }
        return this.row(tx, context, operationId);
      });
    }
    return view(row);
  }

  private async commitStep(tx: SourceSQL, context: SourceContext, row: Stored, root: string, provenance: PublicProvenance, metrics?: SourceMergeResult['metrics']): Promise<TransformationResult> {
    const step = row.request.steps[row.next_step]!;
    const revisionInput = {operation_id: derivedOperation(context, row.operation_id, row.next_step), idempotency_key: `transform:${row.operation_id}:${row.next_step}`, change_id: step.change_id, root_tree_id: root, parent_revision_ids: step.parents ?? [row.tip_revision_id], predecessor_revision_ids: step.predecessor_revision_ids, provenance};
    const candidateId = revisionIdentity(revisionDescriptor(context.scope, revisionInput));
    const retained = (await tx.query('SELECT predecessor_revision_ids FROM hyperfide.source_change_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND change_id=$4 AND revision_id=$5', [...sourceScopeValues(context.scope), step.change_id, candidateId])).rows[0];
    if (retained) revisionInput.predecessor_revision_ids = retained.predecessor_revision_ids as string[];
    const receipt = await this.metadata.createRevisionInTransaction(tx, context, revisionInput);
    const mapping: TransformationMapping = {original_revision_id: step.original_revision_id, successor_revision_id: receipt.revision_id, change_id: step.change_id, unchanged: step.original_revision_id === receipt.revision_id, receipt};
    const mappings = [...row.result.mappings, mapping], next = row.next_step + 1, complete = next === row.request.steps.length;
    const {conflict_id: _conflict, ...previous} = row.result;
    const result: TransformationResult = {...previous, status: complete ? 'COMPLETED' : 'PENDING', generation: String(BigInt(row.generation) + 1n), next_step: next, tip_revision_id: receipt.revision_id, mappings, conflicts: [], receipt, ...(metrics ? {metrics} : {})};
    if (canonicalBytes(result).byteLength > 917504) sourceFailure('LIMIT_EXCEEDED', 'Transformation result exceeds its response budget');
    await tx.query('INSERT INTO hyperfide.source_transformation_steps(organisation_id,repository_id,security_domain_id,principal_id,operation_id,step,input_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [...scopeKey(context, row.operation_id), row.next_step, sourceDigest([step, row.tip_revision_id]), {mapping, root_tree_id: root, provenance}]);
    await tx.query('UPDATE hyperfide.source_transformations SET generation=generation+1,status=$6,next_step=$7,tip_revision_id=$8,result=$9,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5', [...scopeKey(context, row.operation_id), complete ? 'COMPLETED' : 'ACTIVE', next, receipt.revision_id, result]);
    if (complete) await tx.query("UPDATE hyperfide.source_metadata_operations SET state='COMMITTED',result=$6,result_digest=$7,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5 AND state='PENDING'", [...scopeKey(context, row.operation_id), result, sourceDigest(result)]);
    return result;
  }

  private async resolve(context: SourceContext, input: ResumeInput, options: RunOptions): Promise<void> {
    const resolution = input.resolution!, digest = sourceDigest(resolution);
    notCancelled(options);
    await this.metadata.transaction(async tx => {
      await this.metadata.guard(tx, context, 'source.transforms.resume');
      const row = await this.row(tx, context, input.operation_id, true);
      await this.metadata.guard(tx, context, `source.transforms.${row.kind.toLowerCase()}`);
      const old = (await tx.query('SELECT request_digest FROM hyperfide.source_transformation_resolutions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5 AND conflict_id=$6', [...scopeKey(context, input.operation_id), resolution.conflict_id])).rows[0];
      if (old) {
        if (old.request_digest !== digest) sourceFailure('IDEMPOTENCY_CONFLICT', 'Conflict resolution identity is bound to another resolved tree');
        return;
      }
      if (row.operation_state !== 'PENDING') sourceFailure('OPERATION_CANCELLED', 'Transformation is already terminal');
      if (row.status !== 'CONFLICT' || row.result.conflict_id !== resolution.conflict_id || input.expected_generation !== undefined && row.generation !== input.expected_generation)
        sourceFailure('STALE_TRANSFORMATION', 'Conflict or transformation generation changed');
      const step = row.request.steps[row.next_step]!;
      const provenance = resolution.provenance === undefined ? step.provenance : parsePublicProvenance(resolution.provenance);
      const result = await this.commitStep(tx, context, row, resolution.resolved_tree_id, provenance);
      await tx.query('INSERT INTO hyperfide.source_transformation_resolutions(organisation_id,repository_id,security_domain_id,principal_id,operation_id,conflict_id,request_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [...scopeKey(context, input.operation_id), resolution.conflict_id, digest, result]);
    });
  }
}
