import type {SourceAuthority,SourceScope} from './contracts.js';

export interface SourceBindFleetRunRequest {run_id:string;revision_id:string;leader_generation:string}
export interface SourceFleetSelectRequest {
 selection_id:string;run_id:string;acceptance_id:string;expected_generation:string;leader_generation:string;
}
export interface SourceFleetSelection {
 schema_version:1;scope:SourceScope;selection_id:string;run_id:string;generation:string;
 previous_revision_id:string;revision_id:string;root_tree_id:string;acceptance_id:string;acceptance_digest:string;
 run_authority_epoch:string;source_authority_epoch:string;result_digest:string;
}
export interface SourceFleetRunBinding {
 scope:SourceScope;run_id:string;revision_id:string;root_tree_id:string;source_revision:string;
 source_manifest_digest:string;authority_epoch:string;source_authority_epoch:string;leader_generation:string;
}
export interface SourceFleetAssignmentRequest {
 assignment_id:string;run_id:string;task_id:string;attempt_id:string;attempt_generation:string;
 workspace_id:string;base_revision_id:string;closure_digest:string;environment_digest:string;
 read_paths:string[];write_paths:string[];mode:'API_ONLY'|'SPARSE'|'MATERIALIZED';
 worker_principal_id:string;worker_credential_id:string;leader_generation:string;package_id:string;package_generation:string;
}
export interface SourceFleetAssignment {
 schema_version:1;scope:SourceScope;assignment_id:string;assignment_generation:string;
 run_id:string;task_id:string;attempt_id:string;attempt_generation:string;workspace_id:string;
 base_revision_id:string;root_tree_id:string;closure_digest:string;environment_digest:string;
 worker_principal_id:string;capability_id:string;authority:SourceAuthority;
 workspace:{workspace_generation:string;scope_generation:string;mode:'API_ONLY'|'SPARSE'|'MATERIALIZED';
 read_paths:string[];write_paths:string[];budgets:{cache_bytes:number;max_cache_entries:number;max_file_bytes:number;materialized_bytes:number;dirty_bytes:number}};
}
export interface SourceFleetSubmitRequest {
 assignment_id:string;expected_assignment_generation:string;expected_workspace_generation:string;revision_id:string;
}
export interface SourceFleetSubmission {
 schema_version:1;scope:SourceScope;submission_id:string;custody_id:string;custody_generation:string;
 assignment_id:string;run_id:string;task_id:string;attempt_id:string;attempt_generation:string;
 revision_id:string;root_tree_id:string;source_manifest_digest:string;
 input_manifest:Record<'source'|'dependency'|'toolchain'|'configuration'|'graph'|'contract',string>;
 result_digest:string;state:'SUBMITTED';
}

export interface SourceFleetQualifyRequest {
 run_id:string;task_id:string;custody_id:string;custody_generation:string;
 candidate_id:string;qualification_id:string;expected_state_version:string;
}

export interface SourceNativeManifestRequest {
 revision_id:string;paths:string[];max_files:number;max_bytes:number;max_nodes:number;metadata_only:boolean;
}
export interface SourceNativeManifest {
 schema_version:1;kind:'hyperfide.native-source-manifest';scope:SourceScope;
 repository:string;revision:string;root_tree_id:string;paths:string[];bytes:number;digest:string;
 transfer_mode?:'metadata-only';
 entries:Array<{path:string;mode:'100644'|'100755';file_object_id:string;file_descriptor_base64:string;size:number;digest:string;content_base64:string}>;
}

export interface SourceFleetQualificationReceipt {
 schema_version:1;scope:SourceScope;run_id:string;task_id:string;custody_id:string;custody_generation:string;
 qualification_id:string;candidate_id:string;candidate_qualification_id:string;revision_id:string;root_tree_id:string;
 criteria_digest:string;spec_revision_id:string;spec_generation:string;policy_digest:string;input_digest:string;
 evidence_digest:string;state:'QUALIFIED';task_state_version:string;
}
