CREATE TABLE hyperfide.source_workspaces (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 workspace_id uuid NOT NULL, principal_id uuid NOT NULL, authority_epoch bigint NOT NULL CHECK(authority_epoch>0),
 workspace_generation bigint NOT NULL DEFAULT 1 CHECK(workspace_generation>0),
 scope_generation bigint NOT NULL DEFAULT 1 CHECK(scope_generation>0),
 base_revision_id text NOT NULL, root_tree_id text NOT NULL, checkpoint_revision_id text,
 mode text NOT NULL CHECK(mode IN ('API_ONLY','SPARSE','MATERIALIZED')),
 read_paths jsonb NOT NULL, write_paths jsonb NOT NULL, budgets jsonb NOT NULL,
 open_request_digest text NOT NULL, closed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,workspace_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,base_revision_id) REFERENCES hyperfide.source_revisions,
 CHECK(jsonb_typeof(read_paths)='array' AND jsonb_typeof(write_paths)='array' AND jsonb_typeof(budgets)='object')
);
CREATE TABLE hyperfide.source_workspace_checkpoints (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 principal_id uuid NOT NULL, operation_id uuid NOT NULL, workspace_id uuid NOT NULL,
 request_digest text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,workspace_id) REFERENCES hyperfide.source_workspaces,
 CHECK(jsonb_typeof(result)='object')
);
CREATE TRIGGER source_workspace_checkpoints_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_workspace_checkpoints
 FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_workspaces
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_workspace_checkpoints
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
