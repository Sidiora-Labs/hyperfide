CREATE TABLE hyperfide.runner_result_collections (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,operation_id uuid NOT NULL,
 claim_id uuid NOT NULL,executor_credential_id uuid NOT NULL,
 lease_id uuid NOT NULL,lease_until timestamptz NOT NULL,
 next_poll_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempts bigint NOT NULL DEFAULT 0 CHECK(attempts>=0),
 PRIMARY KEY(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,operation_id) REFERENCES hyperfide.runner_remote_jobs(organisation_id,run_id,operation_id)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.runner_result_collections
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','operation_id','claim_id','executor_credential_id');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.runner_result_collections
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE INDEX runner_result_collections_poll ON hyperfide.runner_result_collections(organisation_id,run_id,executor_credential_id,next_poll_at,lease_until);
CREATE INDEX runner_remote_jobs_collect ON hyperfide.runner_remote_jobs(organisation_id,run_id,executor_credential_id,created_at,operation_id)
 WHERE state='UNKNOWN' AND claim_id IS NOT NULL AND result IS NULL AND pre_provider_refusal_id IS NULL AND native_claimed_at IS NOT NULL;
