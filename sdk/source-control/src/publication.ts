import type {SourceScope} from './contracts.js';

export interface SourceCreatePublicationRequest {
 acceptance_id:string;destination_id:string;target_ref:string;expected_old_oid:string|null;
}
export interface SourcePublicationResult {
 schema_version:1;scope:SourceScope;operation_id:string;acceptance_id:string;revision_id:string;root_tree_id:string;
 destination_id:string;target_ref:string;expected_old_oid:string|null;git_oid:string|null;generation:string;
 status:'QUEUED'|'READY'|'DISPATCHED'|'OUTCOME_UNKNOWN'|'PUBLISHED'|'REMOTE_DIVERGED'|'REJECTED'|'CANCELLED';
 code?:string;observed_oid?:string|null;checkpoint_generation?:string;
}
