import type {SourceCandidateContributor,SourceCandidateDependency} from './acceptance.js';
export interface SourceQueueEnqueueRequest {candidate_ids:string[];expires_at:string;max_attempts?:number}
export interface SourceQueueClaimRequest {lease_ms:number}
export interface SourceQueueBatchRequest {batch_id:string;lease_id:string}
export interface SourceQueueBindRequest extends SourceQueueBatchRequest {candidate_id:string}
export interface SourceQueueCompleteRequest extends SourceQueueBatchRequest {qualification_id:string}
export interface SourceQueueFailRequest extends SourceQueueBatchRequest {evidence_ids:string[]}
export interface SourceQueueIsolateRequest extends SourceQueueBatchRequest {partitions:string[][]}
export interface SourceQueueManifest {
 schema_version:1;authority_epoch:string;domain_id:string;expected_generation:string;expected_revision_id:string;policy_id:string;policy_digest:string;
 proposal_ids:string[];candidate_ids:string[];contributors:SourceCandidateContributor[];dependencies:SourceCandidateDependency[];
 input_context:{toolchain:string;configuration:string;contract:string};cost:{proposals:number;contributors:number;manifest_bytes:number;dependencies:number};
}
export interface SourceQueueBatch {
 schema_version:1;batch_id:string;work_id:string;lease_id:string;lease_expires_at:string;
 state:'CLAIMED'|'BOUND'|'PASSED'|'FAILED'|'ISOLATED'|'EXPIRED';manifest:SourceQueueManifest;
 candidate_id:string|null;qualification_id:string|null;evidence:unknown;result:unknown;attempt:number;max_attempts:number;
}
