CREATE TABLE hyperfide.fleet_test_job_bindings (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,intent_id uuid NOT NULL,
 job_id uuid NOT NULL,custody_id uuid NOT NULL,custody_generation bigint NOT NULL CHECK(custody_generation>0),
 task_id uuid NOT NULL,package_id uuid NOT NULL,manager_session_id uuid NOT NULL,
 manager_generation bigint NOT NULL CHECK(manager_generation>0),leader_generation bigint NOT NULL CHECK(leader_generation>0),authority_epoch uuid NOT NULL,
 selected_job_state_version bigint NOT NULL CHECK(selected_job_state_version>0),decision_id uuid NOT NULL,decision_operation_id uuid NOT NULL,
 pool_id uuid NOT NULL,sandbox_id uuid NOT NULL,profile_id uuid NOT NULL,preparation_digest hyperfide.digest NOT NULL,
 policy_digest hyperfide.digest NOT NULL,template_digest hyperfide.digest NOT NULL,template jsonb NOT NULL CHECK(jsonb_typeof(template)='object'),
 replacement_proof jsonb,
 state text NOT NULL CHECK(state IN('ACTIVE','SUPERSEDED')),superseded_by uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,intent_id),
 UNIQUE(organisation_id,run_id,decision_operation_id),
 FOREIGN KEY(organisation_id,run_id,intent_id) REFERENCES hyperfide.provisioning_intents(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,job_id,custody_id,custody_generation) REFERENCES hyperfide.qualification_jobs(organisation_id,run_id,id,custody_id,custody_generation),
 FOREIGN KEY(organisation_id,run_id,task_id) REFERENCES hyperfide.tasks(organisation_id,run_id,id),
 CHECK((state='ACTIVE')=(superseded_by IS NULL))
);
CREATE UNIQUE INDEX fleet_test_job_one_active ON hyperfide.fleet_test_job_bindings(organisation_id,run_id,job_id) WHERE state='ACTIVE';
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_test_job_bindings FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_test_job_bindings FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','intent_id','job_id','custody_id','custody_generation','task_id','package_id','manager_session_id','manager_generation','leader_generation','authority_epoch','selected_job_state_version','decision_id','decision_operation_id','pool_id','sandbox_id','profile_id','preparation_digest','policy_digest','template_digest','template','replacement_proof','created_at');
