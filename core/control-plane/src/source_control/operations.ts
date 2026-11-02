import type {SourceContext, SourceMetadata, SourceSQL} from './metadata.js';
import {sourceFailure, sourceScopeValues} from './metadata.js';
import {parseObjectId, parseUUID} from './contracts.js';

export interface SourceOperationRecord {
 operation_id: string; action: string; idempotency_key: string; request_digest: string;
 state: 'PENDING' | 'COMMITTED' | 'CANCELLED' | 'FAILED'; result: unknown | null; result_digest: string | null;
}
export interface BeginSourceOperation {operation_id: string; idempotency_key: string; action: string; request_digest: string}
const columns = 'operation_id,action,idempotency_key,request_digest,state,result,result_digest';
export function validateOperation(input: BeginSourceOperation): void {
 parseUUID(input.operation_id, 'operation_id'); parseObjectId(input.request_digest);
 if (typeof input.action !== 'string' || !/^source\.[a-z][a-z0-9_.]{0,95}$/.test(input.action) || typeof input.idempotency_key !== 'string' || !input.idempotency_key.length || Buffer.byteLength(input.idempotency_key) > 256) sourceFailure('INVALID_REQUEST', 'Explicit bounded source action and idempotency key required');
}
export async function reserveSourceOperation(tx: SourceSQL, context: SourceContext, input: BeginSourceOperation): Promise<SourceOperationRecord> {
 validateOperation(input);
 const values = [...sourceScopeValues(context.scope), context.principal_id, input.operation_id, input.action, input.idempotency_key, input.request_digest];
 await tx.query("INSERT INTO hyperfide.source_metadata_operations(organisation_id,repository_id,security_domain_id,principal_id,operation_id,action,idempotency_key,request_digest,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING') ON CONFLICT DO NOTHING", values);
 const rows = (await tx.query(`SELECT ${columns} FROM hyperfide.source_metadata_operations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND (operation_id=$5 OR (action=$6 AND idempotency_key=$7)) ORDER BY operation_id FOR UPDATE`, values.slice(0, 7))).rows;
 const row = rows[0];
 if (rows.length !== 1 || !row || row.action !== input.action || row.idempotency_key !== input.idempotency_key || row.request_digest !== input.request_digest) sourceFailure('IDEMPOTENCY_CONFLICT', 'Operation identity or idempotency key is already bound to another request');
 return row as SourceOperationRecord;
}
export async function beginSourceOperation(store: SourceMetadata, context: SourceContext, input: BeginSourceOperation): Promise<SourceOperationRecord> {
 return store.transaction(async tx => {await store.guard(tx, context, input.action); return reserveSourceOperation(tx, context, input);});
}
export async function readSourceOperationInTransaction(store: SourceMetadata, tx: SourceSQL, context: SourceContext, operationId: string): Promise<SourceOperationRecord> {
 parseUUID(operationId, 'operation_id'); await store.guard(tx, context, 'source.operations.read');
 const row = (await tx.query(`SELECT ${columns} FROM hyperfide.source_metadata_operations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5`, [...sourceScopeValues(context.scope), context.principal_id, operationId])).rows[0];
 if (!row) sourceFailure('NOT_FOUND', 'Source operation is unavailable in the authorized scope');
 return row as SourceOperationRecord;
}
export async function readSourceOperation(store: SourceMetadata, context: SourceContext, operationId: string): Promise<SourceOperationRecord> {
 return store.transaction(tx => readSourceOperationInTransaction(store, tx, context, operationId));
}
export async function cancelSourceOperation(store: SourceMetadata, context: SourceContext, operationId: string): Promise<{disposition: 'CANCELLED' | 'TOO_LATE' | 'ALREADY_TERMINAL'; operation: SourceOperationRecord}> {
 parseUUID(operationId, 'operation_id');
 return store.transaction(async tx => {
  await store.guard(tx, context, 'source.operations.cancel');
  const values = [...sourceScopeValues(context.scope), context.principal_id, operationId];
  const row = (await tx.query(`SELECT ${columns} FROM hyperfide.source_metadata_operations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5 FOR UPDATE`, values)).rows[0] as SourceOperationRecord | undefined;
  if (!row) sourceFailure('NOT_FOUND', 'Source operation is unavailable in the authorized scope');
  if (row.state === 'COMMITTED') return {disposition: 'TOO_LATE', operation: row};
  if (row.state !== 'PENDING') return {disposition: 'ALREADY_TERMINAL', operation: row};
  await tx.query("UPDATE hyperfide.source_metadata_operations SET state='CANCELLED',updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5", values);
  return {disposition: 'CANCELLED', operation: {...row, state: 'CANCELLED'}};
 });
}
