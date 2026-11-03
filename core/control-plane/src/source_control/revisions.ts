import {recordNativeRevisionAcknowledgement} from './migration/write_admission.js';
import {randomUUID} from 'node:crypto';
import {parseObjectId, parseUUID} from './contracts.js';
import type {RevisionInput, RevisionReceipt, SourceContext, SourceMetadata, SourceRevisionRecord, SourceSQL} from './metadata.js';
import {revisionDescriptor, revisionIdentity, revisionRequestDigest, sourceDigest, sourceFailure, sourceScopeValues} from './metadata.js';
import {reserveSourceOperation} from './operations.js';

export async function createRevisionInTransaction(store: SourceMetadata, tx: SourceSQL, context: SourceContext, input: RevisionInput): Promise<RevisionReceipt> {
 const descriptor = revisionDescriptor(context.scope, input), requestDigest = revisionRequestDigest(context.scope, input);
 parseUUID(context.principal_id, 'principal_id');
 const prior = (await tx.query('SELECT operation_id,action,idempotency_key,request_digest,state,result FROM hyperfide.source_metadata_operations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND (operation_id=$5 OR (action=$6 AND idempotency_key=$7)) ORDER BY operation_id', [...sourceScopeValues(context.scope), context.principal_id, input.operation_id, 'source.revisions.create', input.idempotency_key])).rows;
 if (prior.some(row => row.state === 'COMMITTED')) {
  await store.guard(tx, context, 'source.operations.read');
  const row = prior[0];
  if (prior.length !== 1 || !row || row.action !== 'source.revisions.create' || row.idempotency_key !== input.idempotency_key || row.request_digest !== requestDigest) sourceFailure('IDEMPOTENCY_CONFLICT', 'Committed operation is bound to another source request');
  return row.result as RevisionReceipt;
 }
 const profile = await store.guard(tx, context, 'source.revisions.create');
 const operation = await reserveSourceOperation(tx, context, {operation_id: input.operation_id, idempotency_key: input.idempotency_key, action: 'source.revisions.create', request_digest: requestDigest});
 if (operation.state === 'COMMITTED') return operation.result as RevisionReceipt;
 if (operation.state === 'CANCELLED') sourceFailure('OPERATION_CANCELLED', 'Source operation was cancelled before registration');
 if (operation.state !== 'PENDING') sourceFailure('CONFLICT', 'Source operation is already terminal');
 if (input.parent_revision_ids.length) {
  const parents = await tx.query('SELECT revision_id FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=ANY($4::text[])', [...sourceScopeValues(context.scope), input.parent_revision_ids]);
  if (parents.rows.length !== input.parent_revision_ids.length) sourceFailure('NOT_FOUND', 'A pinned parent revision is unavailable in the authorized scope');
 }
 if (input.predecessor_revision_ids.length) {
  const predecessors = await tx.query('SELECT revision_id FROM hyperfide.source_change_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND change_id=$4 AND revision_id=ANY($5::text[])', [...sourceScopeValues(context.scope), input.change_id, input.predecessor_revision_ids]);
  if (predecessors.rows.length !== input.predecessor_revision_ids.length) sourceFailure('NOT_FOUND', 'A change predecessor is unavailable in the authorized change');
 }
 const revisionId = revisionIdentity(descriptor), scope = sourceScopeValues(context.scope);
 const protection = await store.protectRoot(tx, context.scope, input.root_tree_id, revisionId);
 if (!protection || typeof protection !== 'object') sourceFailure('OBJECT_NOT_AVAILABLE', 'Verified root protection receipt required');
 await tx.query('INSERT INTO hyperfide.source_revisions(organisation_id,repository_id,security_domain_id,revision_id,root_tree_id,descriptor,authority_epoch,root_protection) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING', [...scope, revisionId, input.root_tree_id, descriptor, context.authority_epoch, protection]);
 const retained = (await tx.query('SELECT descriptor FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4', [...scope, revisionId])).rows[0];
 if (!retained || sourceDigest(retained.descriptor) !== sourceDigest(descriptor)) sourceFailure('CONFLICT', 'Immutable revision identity resolved to another descriptor');
 for (let position = 0; position < input.parent_revision_ids.length; position++) await tx.query('INSERT INTO hyperfide.source_revision_parents(organisation_id,repository_id,security_domain_id,revision_id,position,parent_revision_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [...scope, revisionId, position, input.parent_revision_ids[position]]);
 await tx.query('INSERT INTO hyperfide.source_change_revisions(organisation_id,repository_id,security_domain_id,change_id,revision_id,predecessor_revision_ids) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [...scope, input.change_id, revisionId, JSON.stringify(input.predecessor_revision_ids)]);
 const membership = (await tx.query('SELECT predecessor_revision_ids FROM hyperfide.source_change_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND change_id=$4 AND revision_id=$5', [...scope, input.change_id, revisionId])).rows[0];
 if (!membership || sourceDigest(membership.predecessor_revision_ids) !== sourceDigest(input.predecessor_revision_ids)) sourceFailure('CONFLICT', 'Change membership already has another immutable predecessor set');
 await recordNativeRevisionAcknowledgement(tx,context,revisionId);
 const body = {schema_version: 1 as const, scope: {...context.scope}, operation_id: operation.operation_id, revision_id: revisionId, root_tree_id: input.root_tree_id, change_id: input.change_id, authority_epoch: context.authority_epoch, durability_profile: profile.durability_profile};
 const resultDigest = sourceDigest(body);
 const receipt: RevisionReceipt = {...body, result_digest: resultDigest, causal_token: Buffer.from(JSON.stringify([1, context.scope, context.authority_epoch, operation.operation_id, resultDigest])).toString('base64url')};
 const eventId = randomUUID();
 const inserted = await tx.query("INSERT INTO hyperfide.source_events(organisation_id,repository_id,security_domain_id,event_id,aggregate_id,aggregate_generation,event_type,payload) VALUES($1,$2,$3,$4,$5,1,'REVISION_CREATED',$6) ON CONFLICT(organisation_id,repository_id,security_domain_id,aggregate_id,aggregate_generation) DO NOTHING RETURNING event_id", [...scope, eventId, input.change_id + '/' + revisionId, receipt]);
 if (inserted.rows.length) await tx.query("INSERT INTO hyperfide.source_event_deliveries(organisation_id,repository_id,security_domain_id,consumer_id,event_id,state) SELECT organisation_id,repository_id,security_domain_id,consumer_id,$4,'PENDING' FROM hyperfide.source_event_consumers WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 ON CONFLICT DO NOTHING", [...scope, eventId]);
 await tx.query("UPDATE hyperfide.source_metadata_operations SET state='COMMITTED',result=$6,result_digest=$7,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5 AND state='PENDING'", [...scope, context.principal_id, operation.operation_id, receipt, resultDigest]);
 return receipt;
}
export async function readRevisionInTransaction(store: SourceMetadata, tx: SourceSQL, context: SourceContext, revisionId: string): Promise<SourceRevisionRecord> {
 parseObjectId(revisionId); await store.guard(tx, context, 'source.revisions.read');
 const row = (await tx.query('SELECT revision_id,root_tree_id,descriptor,authority_epoch::text,created_at FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4', [...sourceScopeValues(context.scope), revisionId])).rows[0];
 if (!row) sourceFailure('NOT_FOUND', 'Revision is unavailable in the authorized source scope');
 return {...row, parent_revision_ids: row.descriptor.parent_revision_ids, created_at: new Date(row.created_at).toISOString()} as SourceRevisionRecord;
}
export async function changeRevisions(store: SourceMetadata, context: SourceContext, changeId: string, page: {after?: string; limit?: number} = {}): Promise<{revisions: (SourceRevisionRecord & {predecessor_revision_ids: string[]})[]; next_cursor: string | null}> {
 parseUUID(changeId, 'change_id'); if (page.after !== undefined) parseObjectId(page.after);
 const limit = page.limit ?? 100;
 if (!Number.isInteger(limit) || limit < 1 || limit > 256) sourceFailure('INVALID_REQUEST', 'Change page limit must be between one and 256');
 return store.transaction(async tx => {
  await store.guard(tx, context, 'source.changes.revisions');
  const rows = (await tx.query('SELECT r.revision_id,r.root_tree_id,r.descriptor,r.authority_epoch::text,r.created_at,m.predecessor_revision_ids FROM hyperfide.source_change_revisions m JOIN hyperfide.source_revisions r USING(organisation_id,repository_id,security_domain_id,revision_id) WHERE m.organisation_id=$1 AND m.repository_id=$2 AND m.security_domain_id=$3 AND m.change_id=$4 AND ($5::text IS NULL OR m.revision_id>$5) ORDER BY m.revision_id LIMIT $6', [...sourceScopeValues(context.scope), changeId, page.after ?? null, limit + 1])).rows;
  const revisions = rows.slice(0, limit).map(row => ({...row, parent_revision_ids: row.descriptor.parent_revision_ids, created_at: new Date(row.created_at).toISOString()} as SourceRevisionRecord & {predecessor_revision_ids: string[]}));
  return {revisions, next_cursor: rows.length > limit ? revisions.at(-1)!.revision_id : null};
 });
}
