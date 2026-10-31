CREATE TABLE hyperfide.fleet_runtime_readiness (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,id uuid NOT NULL,
 install_operation_id uuid NOT NULL,runner_operation_id uuid NOT NULL,runner_result_digest hyperfide.digest NOT NULL,
 sandbox_id uuid NOT NULL,boot_id uuid NOT NULL,boot_generation bigint NOT NULL CHECK(boot_generation>0),
 slot_id uuid NOT NULL,slot_generation bigint NOT NULL CHECK(slot_generation>0),runner_session_id uuid NOT NULL,
 readiness_digest hyperfide.digest NOT NULL,receipt_digest hyperfide.digest NOT NULL,
 input_digest hyperfide.digest NOT NULL,measurement_digest hyperfide.digest NOT NULL,
 source_digest hyperfide.digest NOT NULL,source_object_id text NOT NULL,source_tree_id text NOT NULL,
 publication jsonb NOT NULL CHECK(jsonb_typeof(publication)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,id),
 UNIQUE(organisation_id,run_id,install_operation_id,slot_id),
 UNIQUE(organisation_id,run_id,readiness_digest),
 FOREIGN KEY(organisation_id,run_id,install_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,runner_operation_id) REFERENCES hyperfide.runner_remote_jobs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,runner_session_id) REFERENCES hyperfide.runner_registry(organisation_id,run_id,session_id)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_runtime_readiness
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','id','install_operation_id','runner_operation_id','runner_result_digest','sandbox_id','boot_id','boot_generation','slot_id','slot_generation','runner_session_id','readiness_digest','receipt_digest','input_digest','measurement_digest','source_digest','source_object_id','source_tree_id','publication','created_at');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_runtime_readiness
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
