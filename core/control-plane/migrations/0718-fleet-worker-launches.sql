ALTER TABLE hyperfide.native_launch_plans DROP CONSTRAINT native_launch_plans_plan_check;
ALTER TABLE hyperfide.native_launch_plans ADD CONSTRAINT native_launch_plans_plan_check
 CHECK(jsonb_typeof(plan)='object' AND octet_length(plan::text)<=1048576);

CREATE TABLE hyperfide.fleet_worker_launches (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,command_id uuid NOT NULL,launch_id uuid NOT NULL,
 runner_session_id uuid NOT NULL,executor_credential_id uuid NOT NULL,authority_epoch uuid NOT NULL,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),request_digest hyperfide.digest NOT NULL,
 state text NOT NULL CHECK(state IN('CLAIMED','COMPLETED','UNKNOWN','REFUSED')),
 result jsonb,result_digest hyperfide.digest,result_signature text,failure_code text CHECK(failure_code IS NULL OR length(failure_code)<=128),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 PRIMARY KEY(organisation_id,run_id,command_id),UNIQUE(organisation_id,run_id,launch_id),
 FOREIGN KEY(organisation_id,run_id,command_id) REFERENCES hyperfide.native_launch_plans(organisation_id,run_id,command_id),
 FOREIGN KEY(organisation_id,run_id,runner_session_id) REFERENCES hyperfide.runner_registry(organisation_id,run_id,session_id),
 CHECK((state='CLAIMED')=(completed_at IS NULL)),
 CHECK((result IS NULL)=(result_digest IS NULL)),CHECK((result IS NULL)=(result_signature IS NULL))
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_worker_launches
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','command_id','launch_id','runner_session_id','executor_credential_id','authority_epoch','request','request_digest','created_at');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_worker_launches
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
