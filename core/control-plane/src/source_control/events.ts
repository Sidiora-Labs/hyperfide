import {randomUUID} from 'node:crypto';
import {parseObjectId, parseUUID} from './contracts.js';
import type {SourceContext, SourceMetadata, SourceSQL} from './metadata.js';
import {sourceFailure, sourceScopeValues} from './metadata.js';

export interface SourceSubscription {consumer_id: string; subscription_epoch: string; bootstrap_revision_id: string}
export interface SourceEventDelivery {event_id: string; aggregate_id: string; aggregate_generation: string; event_type: string; payload: unknown; lease_id: string; lease_expires_at: string; attempts: number}
export interface SourceAcknowledgment {consumer_id: string; subscription_epoch: string; event_id: string; lease_id: string}
export async function createSourceSubscription(store: SourceMetadata, context: SourceContext, input: {consumer_id: string; bootstrap_revision_id: string}): Promise<SourceSubscription> {
 parseUUID(input.consumer_id, 'consumer_id'); parseObjectId(input.bootstrap_revision_id);
 return store.transaction(async tx => {
  // This infrequent registration boundary waits for existing shared publication guards.
  await store.guard(tx, context, 'source.subscriptions.create', true);
  const values = [...sourceScopeValues(context.scope), input.consumer_id];
  const old = (await tx.query('SELECT principal_id,consumer_id,subscription_epoch,bootstrap_revision_id FROM hyperfide.source_event_consumers WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4', values)).rows[0];
  if (old) {
   if (old.principal_id !== context.principal_id || old.bootstrap_revision_id !== input.bootstrap_revision_id) sourceFailure('CONFLICT', 'Subscription is bound to another principal or bootstrap');
   return {consumer_id: old.consumer_id, subscription_epoch: old.subscription_epoch, bootstrap_revision_id: old.bootstrap_revision_id};
  }
  const revision = (await tx.query('SELECT revision_id FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4', [...sourceScopeValues(context.scope), input.bootstrap_revision_id])).rows[0];
  if (!revision) sourceFailure('NOT_FOUND', 'Subscription requires a retained immutable bootstrap revision');
  const high = (await tx.query('SELECT event_id FROM hyperfide.source_events WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 ORDER BY event_id DESC LIMIT 1', sourceScopeValues(context.scope))).rows[0]?.event_id ?? null;
  const epoch = randomUUID();
  await tx.query('INSERT INTO hyperfide.source_event_consumers(organisation_id,repository_id,security_domain_id,consumer_id,principal_id,subscription_epoch,bootstrap_revision_id,backfill_high_id,backfill_complete) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [...values, context.principal_id, epoch, input.bootstrap_revision_id, high, high === null]);
  return {consumer_id: input.consumer_id, subscription_epoch: epoch, bootstrap_revision_id: input.bootstrap_revision_id};
 });
}
async function consumer(tx: SourceSQL, context: SourceContext, consumerId: string, epoch: string) {
 parseUUID(consumerId, 'consumer_id'); parseUUID(epoch, 'subscription_epoch');
 const row = (await tx.query('SELECT * FROM hyperfide.source_event_consumers WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 AND principal_id=$5 AND subscription_epoch=$6 FOR NO KEY UPDATE', [...sourceScopeValues(context.scope), consumerId, context.principal_id, epoch])).rows[0];
 if (!row) sourceFailure('STALE_SUBSCRIPTION', 'Subscription is unavailable for this principal, scope or epoch');
 return row;
}
export async function pollSourceEvents(store: SourceMetadata, context: SourceContext, input: {consumer_id: string; subscription_epoch: string; limit?: number; lease_ms?: number}): Promise<{deliveries: SourceEventDelivery[]; backfill_complete: boolean}> {
 const limit = input.limit ?? 100, leaseMs = input.lease_ms ?? 30000;
 if (!Number.isInteger(limit) || limit < 1 || limit > 256 || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120000) sourceFailure('INVALID_REQUEST', 'Bounded event page and delivery lease required');
 return store.transaction(async tx => {
  await store.guard(tx, context, 'source.subscriptions.poll');
  const row = await consumer(tx, context, input.consumer_id, input.subscription_epoch), scope = sourceScopeValues(context.scope);
  let complete = row.backfill_complete === true;
  if (!complete) {
   const page = (await tx.query('SELECT event_id FROM hyperfide.source_events WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND event_id<=$4 AND ($5::uuid IS NULL OR event_id>$5) ORDER BY event_id LIMIT 256', [...scope, row.backfill_high_id, row.backfill_after_id])).rows;
   if (page.length) await tx.query("INSERT INTO hyperfide.source_event_deliveries(organisation_id,repository_id,security_domain_id,consumer_id,event_id,state) SELECT $1,$2,$3,$4,event_id,'PENDING' FROM unnest($5::uuid[]) AS e(event_id) ON CONFLICT DO NOTHING", [...scope, input.consumer_id, page.map(r => r.event_id)]);
   const after = page.at(-1)?.event_id ?? row.backfill_after_id;
   complete = page.length < 256 || after === row.backfill_high_id;
   await tx.query('UPDATE hyperfide.source_event_consumers SET backfill_after_id=$5,backfill_complete=$6 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4', [...scope, input.consumer_id, after, complete]);
  }
  const leaseId = randomUUID();
  const deliveries = (await tx.query(`WITH selected AS (
   SELECT event_id FROM hyperfide.source_event_deliveries WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4
   AND (state='PENDING' OR state='LEASED' AND lease_expires_at<=clock_timestamp()) ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT $5
  ), leased AS (
   UPDATE hyperfide.source_event_deliveries d SET state='LEASED',lease_id=$6,lease_expires_at=clock_timestamp()+$7::bigint*interval '1 millisecond',attempts=d.attempts+1
   FROM selected s WHERE d.organisation_id=$1 AND d.repository_id=$2 AND d.security_domain_id=$3 AND d.consumer_id=$4 AND d.event_id=s.event_id RETURNING d.*
  ) SELECT e.event_id,e.aggregate_id,e.aggregate_generation::text,e.event_type,e.payload,l.lease_id,l.lease_expires_at,l.attempts
  FROM leased l JOIN hyperfide.source_events e USING(organisation_id,repository_id,security_domain_id,event_id) ORDER BY e.event_id`, [...scope, input.consumer_id, limit, leaseId, leaseMs])).rows;
  return {deliveries: deliveries.map(r => ({...r, lease_expires_at: new Date(r.lease_expires_at).toISOString()} as SourceEventDelivery)), backfill_complete: complete};
 });
}
export async function applySourceEvent<T>(store: SourceMetadata, context: SourceContext, input: SourceAcknowledgment, apply: (tx: SourceSQL, payload: unknown) => Promise<T>): Promise<{duplicate: boolean; result: T}> {
 parseUUID(input.event_id, 'event_id'); parseUUID(input.lease_id, 'lease_id');
 return store.transaction(async tx => {
  await store.guard(tx, context, 'source.subscriptions.ack'); await consumer(tx, context, input.consumer_id, input.subscription_epoch);
  const values = [...sourceScopeValues(context.scope), input.consumer_id, input.event_id];
  const row = (await tx.query('SELECT d.*,e.payload,d.lease_expires_at>clock_timestamp() AS lease_valid FROM hyperfide.source_event_deliveries d JOIN hyperfide.source_events e USING(organisation_id,repository_id,security_domain_id,event_id) WHERE d.organisation_id=$1 AND d.repository_id=$2 AND d.security_domain_id=$3 AND d.consumer_id=$4 AND d.event_id=$5 FOR UPDATE OF d', values)).rows[0];
  if (!row) sourceFailure('NOT_FOUND', 'Delivery is unavailable in the authorized subscription');
  if (row.state === 'ACKNOWLEDGED') {
   if (row.acknowledged_lease_id !== input.lease_id) sourceFailure('STALE_LEASE', 'Acknowledgment belongs to another delivery lease');
   const inbox = (await tx.query('SELECT result FROM hyperfide.source_event_inbox WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 AND event_id=$5', values)).rows[0];
   if (!inbox) sourceFailure('CONFLICT', 'Acknowledged delivery has no transactional inbox result');
   return {duplicate: true, result: inbox.result as T};
  }
  if (row.state !== 'LEASED' || row.lease_id !== input.lease_id || row.lease_valid !== true) sourceFailure('STALE_LEASE', 'Delivery lease expired or was reassigned');
  const result = await apply(tx, row.payload);
  await tx.query('INSERT INTO hyperfide.source_event_inbox(organisation_id,repository_id,security_domain_id,consumer_id,event_id,result) VALUES($1,$2,$3,$4,$5,$6)', [...values, JSON.stringify(result ?? null)]);
  await tx.query("UPDATE hyperfide.source_event_deliveries SET state='ACKNOWLEDGED',acknowledged_at=clock_timestamp(),acknowledged_lease_id=$6,lease_id=NULL,lease_expires_at=NULL WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND consumer_id=$4 AND event_id=$5", [...values, input.lease_id]);
  return {duplicate: false, result};
 });
}
export async function acknowledgeSourceEvent(store: SourceMetadata, context: SourceContext, input: SourceAcknowledgment) {return applySourceEvent(store, context, input, async () => null);}
