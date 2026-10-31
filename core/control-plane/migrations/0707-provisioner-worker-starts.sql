-- Durable provisioner worker start: one record per run. A service restart resumes
-- the recorded start instead of starting again; only an explicit stop or a
-- non-current owner credential lets a new start take ownership.
CREATE TABLE hyperfide.provisioner_worker_starts (
 organisation_id uuid NOT NULL,
 run_id uuid NOT NULL,
 owner_credential_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('STARTED','STOPPED')),
 start_count bigint NOT NULL CHECK(start_count>=1),
 resume_count bigint NOT NULL CHECK(resume_count>=0),
 started_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state_version bigint NOT NULL DEFAULT 1 CHECK(state_version>=1),
 PRIMARY KEY(organisation_id,run_id),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id,owner_credential_id) REFERENCES hyperfide.identity_principals(organisation_id,run_id,credential_id)
);
CREATE TRIGGER authority_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.provisioner_worker_starts
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
