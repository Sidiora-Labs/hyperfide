export interface SourceSubscriptionInput {
 consumer_id:string;bootstrap_revision_id:string;retention_max_events?:number;retention_expires_at?:string;expected_previous_epoch?:string;
}
export interface SourceSubscription {
 consumer_id:string;subscription_epoch:string;bootstrap_revision_id:string;authority_epoch:string;state:'ACTIVE';retention_max_events:number;retention_expires_at:string;retained_events:number;boundary:'REGISTERED'|'RESNAPSHOT';
}
export interface SourceEventDelivery {
 event_id:string;aggregate_id:string;aggregate_generation:string;event_type:string;payload:unknown;lease_id:string;lease_expires_at:string;attempts:number;
}
export interface SourceEventPage {deliveries:SourceEventDelivery[];backfill_complete:boolean}
export interface SourceEventPollInput {consumer_id:string;subscription_epoch:string;limit?:number;lease_ms?:number}
export interface SourceEventAcknowledgment {consumer_id:string;subscription_epoch:string;event_id:string;lease_id:string}
