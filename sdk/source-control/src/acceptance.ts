import type {SourceScope} from './contracts.js';

export interface SourceCandidateInputs {
 source:string;dependency:string;toolchain:string;configuration:string;graph:string;contract:string;
}
export interface SourceCandidateContributor {
 revision_id:string;change_id:string;custody_id:string;custody_generation:string;run_id?:string;task_id?:string;
}
export interface SourceCandidateExecutionDependency {
 predecessor_run_id:string;predecessor_task_id:string;milestone:'QUALIFIED'|'INTEGRATED';state:'QUALIFIED'|'INTEGRATING'|'INTEGRATED';
 current_custody_id:string;repository_id:string;source_object_id:string;custody_generation:string;authority:'ACTIVE';qualification_outcome:'PASS';
 source_backend:'native';security_domain_id:string;qualification_id:string;
}
export interface SourceCandidateDependency {revision_id:string;execution_dependency?:SourceCandidateExecutionDependency}
export interface SourceCreateDomainRequest {domain_id:string;revision_id:string;policy_id:string;policy_digest:string}
export interface SourceConfigureDomainRequest {domain_id:string;expected_generation:string;policy_id:string;policy_digest:string}
export interface SourceCreateCandidateRequest {
 candidate_id:string;domain_id:string;expected_generation:string;expected_revision_id:string;revision_id:string;
 contributors:SourceCandidateContributor[];dependencies:SourceCandidateDependency[];inputs:SourceCandidateInputs;transformation_version:string;
}
export interface SourceQualifyCandidateRequest {candidate_id:string;evidence_ids:string[]}
export interface SourceAcceptCandidateRequest {candidate_id:string;qualification_id:string}
export interface SourceIntegrationDomain {
 schema_version:1;scope:SourceScope;domain_id:string;generation:string;revision_id:string;root_tree_id:string;
 authority_epoch:string;policy_id:string;policy_digest:string;
}
export interface SourceCandidateRecord {
 schema_version:1;scope:SourceScope;candidate_id:string;domain_id:string;expected_generation:string;expected_revision_id:string;
 revision_id:string;root_tree_id:string;created_by_principal_id:string;authority_epoch:string;policy_id:string;policy_digest:string;
 contributors:SourceCandidateContributor[];dependencies:SourceCandidateDependency[];inputs:SourceCandidateInputs;
 transformation_version:string;manifest_digest:string;
}
export interface SourceCandidateEvidence {
 schema_version:1;candidate_id:string;manifest_digest:string;policy_id:string;policy_digest:string;
 evidence_ids:string[];evidence_digest:string;
}
export interface SourceCandidateQualification {
 schema_version:1;scope:SourceScope;qualification_id:string;candidate_id:string;manifest_digest:string;
 authority_epoch:string;policy_id:string;policy_digest:string;evidence:SourceCandidateEvidence;
}
export interface SourceAcceptanceReceipt {
 schema_version:1;scope:SourceScope;acceptance_id:string;operation_id:string;candidate_id:string;qualification_id:string;
 domain_id:string;generation:string;previous_revision_id:string;revision_id:string;root_tree_id:string;
 manifest_digest:string;policy_id:string;policy_digest:string;authority_epoch:string;durability_profile:string;
 evidence_digest:string;result_digest:string;
}
export interface SourceCreateCustodyRequest {
 custody_id:string;custody_generation:string;revision_id:string;run_id?:string;task_id?:string;
}
export interface SourceCustodyReceipt {
 schema_version:1;scope:SourceScope;custody_id:string;custody_generation:string;revision_id:string;root_tree_id:string;
 run_id:string|null;task_id:string|null;authority_epoch:string;
}
export interface SourcePublishEvidenceRequest {candidate_id:string;check_id:string;receipt_object_id:string}
export interface SourceEvidenceReceipt {
 schema_version:1;evidence_id:string;candidate_id:string;receipt_object_id:string;outcome:'PASS'|'FAIL';
}
export interface SourceRevocationReceipt {schema_version:1;id:string;revoked:true}
export interface SourceExecutionReceipt {
 schema_version:1;source_kind:'NATIVE';candidate_id:string;candidate_manifest_digest:string;revision_id:string;root_tree_id:string;
 inputs:SourceCandidateInputs;check_id:string;
 command:{
  argv:string[];cwd:'.';executable_digest:string;environment_digest:string;started_at:string;finished_at:string;
  exit_code:number;signal:string|null;timed_out:boolean;interrupted:boolean;output_truncated:boolean;
 };
 execution:{execution_id:string;source_revision_id:string;source_root_tree_id:string;input_digest:string;cleanup_complete:boolean;process_absent:boolean};
 output:{stdout_object_id:string;stderr_object_id:string};artifacts:{path:string;object_id:string}[];
}
