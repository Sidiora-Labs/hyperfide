import type {PublicProvenance,SourceScope,TreeEntry} from './contracts.js';

export interface SourceTransformationBudget {
 max_nodes?:number;max_entries?:number;max_files?:number;max_text_bytes?:number;
 max_file_bytes?:number;max_diff_cells?:number;max_conflicts?:number;max_ms?:number;
}
export interface SourceMergeRequest {
 ours_revision_id:string;theirs_revision_id:string;base_revision_id?:string;
 change_id:string;provenance:PublicProvenance;budget?:SourceTransformationBudget;
}
export interface SourceRebaseRequest {
 revision_ids:string[];onto_revision_id:string;max_steps?:number;budget?:SourceTransformationBudget;
}
export interface SourceRevertRequest {
 revision_id:string;onto_revision_id:string;mainline_parent_revision_id?:string;
 change_id:string;provenance:PublicProvenance;budget?:SourceTransformationBudget;
}
export interface SourceResumeRequest {
 operation_id:string;max_steps?:number;expected_generation?:string;
 resolution?:{conflict_id:string;resolved_tree_id:string;provenance?:PublicProvenance};
}
export interface SourceTransformationConflict {
 schema_version:1;conflict_id:string;path:string;
 kind:'ADD_ADD'|'DELETE_MODIFY'|'DIRECTORY_FILE'|'ENTRY_TYPE'|'SYMLINK'|'EXECUTABLE_MODE'|'BINARY'|'TEXT'|'TEXT_LIMIT';
 base:Readonly<TreeEntry>|null;ours:Readonly<TreeEntry>|null;theirs:Readonly<TreeEntry>|null;
 details:Readonly<Record<string,string|number|boolean>>;
}
export interface SourceRevisionReceipt {
 schema_version:1;scope:SourceScope;operation_id:string;revision_id:string;root_tree_id:string;change_id:string;
 authority_epoch:string;durability_profile:string;result_digest:string;causal_token:string;
}
export interface SourceTransformationResult {
 schema_version:1;scope:SourceScope;operation_id:string;kind:'MERGE'|'REBASE'|'REVERT';
 status:'PENDING'|'CONFLICT'|'COMPLETED'|'CANCELLED';generation:string;
 algorithm:'hyperfide-three-way-v1';merge_base_strategy:'REQUIRE_EXPLICIT_MAXIMAL_BASE';
 merge_base_ids:string[];next_step:number;total_steps:number;tip_revision_id:string;
 mappings:{original_revision_id:string;successor_revision_id:string;change_id:string;unchanged:boolean;receipt:SourceRevisionReceipt}[];
 conflicts:SourceTransformationConflict[];conflict_id?:string;receipt?:SourceRevisionReceipt;
 metrics?:{nodes_read:number;nodes_written:number;entries_compared:number;files_read:number;text_bytes:number;subtrees_reused:number};
 rename_detection:{status:'NOT_PERFORMED';reason:'EXPLICIT_PATH_IDENTITY_ONLY'};
}
