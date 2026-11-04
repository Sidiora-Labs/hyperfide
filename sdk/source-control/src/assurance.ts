import type {SourceScope} from './contracts.js';

export interface SourceRegisterAssurancePolicyRequest {
 policy_id:string;run_id:string;task_id:string;spec_revision_id:string;spec_generation:string;expires_at:string;
}
export interface SourceAssurancePolicyRegistration {
 schema_version:1;scope:SourceScope;policy_id:string;policy_digest:string;authority_epoch:string;policy_version:string;
 run_id:string;task_id:string;spec_revision_id:string;spec_generation:string;checks_digest:string;expires_at:string;
}
export interface SourceRegisterAssuranceCheckerRequest {
 policy_id:string;check_id:string;credential_id:string;expires_at:string;
}
export interface SourceAssuranceCheckerRegistration {
 schema_version:1;scope:SourceScope;policy_id:string;check_id:string;principal_id:string;credential_id:string;
 credential_version:string;identity_kind:'NATIVE';run_id:string;role:'VERIFIER'|'COORDINATOR';deployment_epoch:string;expires_at:string;
}
