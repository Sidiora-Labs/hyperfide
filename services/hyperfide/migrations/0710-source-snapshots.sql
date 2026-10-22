-- Snapshots as the unit of record (hyperfide-v21 3.8, req 6.2). A worker result is a
-- tree identity plus checkpoint captured from its slice workspace, not a commit: the
-- native checkpoint.snapshot action writes the tree object through a private index and
-- the control plane records it here. Rows are immutable; a replayed capture of the same
-- bytes returns the row already recorded for that attempt.
CREATE TABLE hyperfide.source_snapshots (
 organisation_id uuid NOT NULL,
 run_id uuid NOT NULL,
 id uuid NOT NULL,
 task_id uuid NOT NULL,
 attempt_id uuid NOT NULL,
 attempt_generation bigint NOT NULL CHECK(attempt_generation>=1),
 repository_id uuid NOT NULL,
 base_commit hyperfide.git_oid NOT NULL,
 base_tree hyperfide.git_oid NOT NULL,
 result_tree hyperfide.git_oid NOT NULL,
 slice_digest hyperfide.digest NOT NULL,
 checkpoint_digest hyperfide.digest NOT NULL,
 checkpoint_receipt jsonb NOT NULL CHECK(jsonb_typeof(checkpoint_receipt)='object' AND octet_length(checkpoint_receipt::text)<=8192),
 files_changed bigint NOT NULL CHECK(files_changed>=0),
 insertions bigint NOT NULL CHECK(insertions>=0),
 deletions bigint NOT NULL CHECK(deletions>=0),
 binary_files bigint NOT NULL CHECK(binary_files>=0 AND binary_files<=files_changed),
 created_by_credential_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,id),
 UNIQUE(organisation_id,run_id,attempt_id,checkpoint_digest),
 CHECK((result_tree=base_tree)=(files_changed=0)),
 CHECK(checkpoint_receipt->>'checkpoint_digest'=checkpoint_digest),
 FOREIGN KEY(organisation_id,run_id,task_id,attempt_id,attempt_generation) REFERENCES hyperfide.attempts(organisation_id,run_id,task_id,id,generation),
 FOREIGN KEY(organisation_id,run_id,slice_digest) REFERENCES hyperfide.workspace_slice_manifests(organisation_id,run_id,digest),
 FOREIGN KEY(organisation_id,run_id,repository_id) REFERENCES hyperfide.run_repositories(organisation_id,run_id,repository_id),
 FOREIGN KEY(organisation_id,run_id,created_by_credential_id) REFERENCES hyperfide.identity_principals(organisation_id,run_id,credential_id)
);
CREATE INDEX source_snapshots_attempt ON hyperfide.source_snapshots(organisation_id,run_id,task_id,attempt_id,created_at);
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_snapshots FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER source_snapshot_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_snapshots FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','id','task_id','attempt_id','attempt_generation','repository_id','base_commit','base_tree','result_tree','slice_digest','checkpoint_digest','checkpoint_receipt','files_changed','insertions','deletions','binary_files','created_by_credential_id','created_at');
