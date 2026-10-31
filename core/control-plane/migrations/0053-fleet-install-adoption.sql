CREATE TABLE hyperfide.fleet_install_adoptions (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,adoption_id uuid NOT NULL,
 adoption_sequence bigint GENERATED ALWAYS AS IDENTITY,
 install_operation_id uuid NOT NULL,previous_adoption_id uuid,
 admission_digest hyperfide.digest NOT NULL,receipt_digest hyperfide.digest,
 input_digest hyperfide.digest NOT NULL,authority_epoch uuid NOT NULL,
 manager_session_id uuid NOT NULL,manager_generation bigint NOT NULL CHECK(manager_generation>0),
 leader_generation bigint NOT NULL CHECK(leader_generation>0),cohort_id uuid NOT NULL,cohort_generation bigint NOT NULL CHECK(cohort_generation>0),
 handoff_id uuid,runner_operation_id uuid,runner_result_digest hyperfide.digest,
 decision_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,adoption_id),
 UNIQUE(organisation_id,run_id,install_operation_id,adoption_sequence),
 FOREIGN KEY(organisation_id,run_id,install_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,previous_adoption_id) REFERENCES hyperfide.fleet_install_adoptions(organisation_id,run_id,adoption_id),
 FOREIGN KEY(organisation_id,run_id,manager_session_id) REFERENCES hyperfide.agent_sessions(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,cohort_id) REFERENCES hyperfide.fleet_cohorts(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,handoff_id) REFERENCES hyperfide.hierarchy_handoff_acknowledgements(organisation_id,run_id,handoff_id),
 FOREIGN KEY(organisation_id,run_id,runner_operation_id) REFERENCES hyperfide.runner_remote_jobs(organisation_id,run_id,operation_id),
 CHECK((runner_operation_id IS NULL)=(runner_result_digest IS NULL))
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_install_adoptions
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','adoption_id','adoption_sequence','install_operation_id','previous_adoption_id','admission_digest','receipt_digest','input_digest','authority_epoch','manager_session_id','manager_generation','leader_generation','cohort_id','cohort_generation','handoff_id','runner_operation_id','runner_result_digest','decision_id','created_at');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_install_adoptions
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
