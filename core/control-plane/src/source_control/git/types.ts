import type {SourceProjectionPolicy} from "./provenance.js";
import type { SourceContext, SourceSQL } from "../metadata.js";
import type { SourceScope } from "../contracts.js";

export interface GitExportObject {
  oid: string;
  kind: "blob" | "tree" | "commit" | "tag";
  size_bytes: number;
  content(): AsyncIterable<Uint8Array>;
}
export interface GitExportProjection {
  head_oid: string;
  root_tree_oid: string;
  objects: readonly GitExportObject[];
  reachable_commit_oids: readonly string[];
  mappings?: readonly GitPublicationMapping[];
  metrics?: unknown;
}
export interface GitPublicationMapping {
  native_kind: string;
  native_id: string;
  git_oid: string;
  git_tree_oid?: string;
  is_empty?: boolean;
}
export interface SourceGitCredential {
  authorization_header: string;
  expires_at: string;
}
export interface GitPushResult {
  outcome: "ACCEPTED" | "REJECTED" | "UNKNOWN";
  code: string;
}
export interface SourceGitTransport {
  observe(ref: string, signal?: AbortSignal): Promise<string | null>;
  authorize?(): Promise<SourceGitCredential | null>;
  push(input: {
    target_ref: string;
    expected_old_oid: string | null;
    new_oid: string;
    objects: readonly GitExportObject[];
    credential?: SourceGitCredential | null;
    signal?: AbortSignal;
  }): Promise<GitPushResult>;
}
export interface SourceGitDestination {
  scope: SourceScope;
  id: string;
  provider: "local" | "github" | "gitlab";
  repository_identity: string;
  configuration_digest: string;
  remote_key: string;
  allowed_refs: readonly string[];
  transport: SourceGitTransport;
  projection_policy?: SourceProjectionPolicy;
}
export interface AcceptedPublicationSource {
  acceptance_id: string;
  revision_id: string;
  root_tree_id: string;
  receipt_digest: string;
}
export interface SourcePublicationOptions {
  destinations: readonly SourceGitDestination[];
  acceptance(
    tx: SourceSQL,
    context: SourceContext,
    acceptanceId: string,
  ): Promise<AcceptedPublicationSource>;
  authorizePath?(tx:SourceSQL,context:SourceContext,path:string):Promise<void>;
  authorizeRevision(
    tx: SourceSQL,
    context: SourceContext,
    revisionId: string,
  ): Promise<void>;
}
