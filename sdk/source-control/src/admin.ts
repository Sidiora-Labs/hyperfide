import type { SourceScope } from "./contracts.js";
import type { WorkspaceDescriptor } from "./host/client.js";
export interface SourceCapabilityGrant {
  id?: string;
  principal_id: string;
  credential_id: string;
  principal_kind: "human" | "automation" | "import" | "worker" | "service";
  authority_epoch: string;
  policy_version: string;
  actions: string[];
  path_prefixes: string[];
  revision_ids?: string[];
  expires_at: string;
  managed_binding?: {
    workspace_id: string;
    generation: string;
    task_id?: string;
    attempt_id?: string;
    attempt_generation?: string;
  };
}
export type SourceCapabilityManageRequest =
  | { operation: "grant"; capability: SourceCapabilityGrant }
  | { operation: "revoke"; capability_id: string };
export interface SourceCapabilityManageResult {
  schema_version: 1;
  operation: "grant" | "revoke";
  capability_id: string;
  changed: boolean;
}
export interface SourceAuditRecord {
  schema_version: 1;
  id: string;
  scope: SourceScope;
  principal_id: string;
  capability_id: string;
  action: string;
  operation_id: string;
  request_digest: string;
  authority_epoch: string;
  policy_version: string;
  result: "ALLOWED" | "DENIED" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
  source_ids: string[];
  error_code: string | null;
}
export interface SourceAuditPage {
  records: SourceAuditRecord[];
  next_after_id: string | null;
}
export interface SourceWorkspaceWidenRequest {
  workspace_id: string;
  expected_workspace_generation: string;
  expected_scope_generation: string;
  read_paths: string[];
  write_paths: string[];
}
export interface SourceWorkspaceWidenResult {
  schema_version: 1;
  workspace: WorkspaceDescriptor;
  scope_changed: boolean;
}
