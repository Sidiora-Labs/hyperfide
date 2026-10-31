CREATE TABLE hyperfide.fleet_environment_specs (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,input_digest hyperfide.digest NOT NULL,
 package_digest hyperfide.digest NOT NULL,source_config_digest hyperfide.digest NOT NULL,
 source_manifest_digest hyperfide.digest NOT NULL,plan_digest hyperfide.digest NOT NULL,
 package_spec jsonb NOT NULL CHECK(jsonb_typeof(package_spec)='object'),source_config jsonb NOT NULL CHECK(jsonb_typeof(source_config)='object'),
 install_plan jsonb NOT NULL CHECK(jsonb_typeof(install_plan)='object'),registered_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,input_digest),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id)
);
CREATE TABLE hyperfide.fleet_environment_installs (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,operation_id uuid NOT NULL,
 input_digest hyperfide.digest NOT NULL,environment_id text NOT NULL,environment_generation bigint NOT NULL CHECK(environment_generation>0),
 sandbox_id uuid NOT NULL,boot_id uuid NOT NULL,boot_generation bigint NOT NULL CHECK(boot_generation>0),
 authority_epoch uuid NOT NULL,package_id uuid NOT NULL,manager_session_id uuid NOT NULL,
 manager_generation bigint NOT NULL CHECK(manager_generation>0),leader_generation bigint NOT NULL CHECK(leader_generation>0),
 cohort_id uuid NOT NULL,cohort_generation bigint NOT NULL CHECK(cohort_generation>0),
 admission jsonb NOT NULL,admission_digest hyperfide.digest NOT NULL,expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'ADMITTED' CHECK(state IN('ADMITTED','READY')),
 receipt jsonb,receipt_digest hyperfide.digest,completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,operation_id),
 UNIQUE(organisation_id,run_id,environment_id,environment_generation),
 FOREIGN KEY(organisation_id,run_id,input_digest) REFERENCES hyperfide.fleet_environment_specs(organisation_id,run_id,input_digest),
 FOREIGN KEY(organisation_id,sandbox_id,boot_generation) REFERENCES hyperfide.sandbox_boots(organisation_id,sandbox_id,boot_generation),
 FOREIGN KEY(organisation_id,run_id,package_id) REFERENCES hyperfide.hierarchy_packages(organisation_id,run_id,package_id),
 FOREIGN KEY(organisation_id,run_id,manager_session_id) REFERENCES hyperfide.agent_sessions(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,cohort_id) REFERENCES hyperfide.fleet_cohorts(organisation_id,run_id,id),
 CHECK((state='ADMITTED' AND receipt IS NULL AND receipt_digest IS NULL AND completed_at IS NULL) OR
       (state='READY' AND receipt IS NOT NULL AND jsonb_typeof(receipt)='object' AND receipt_digest IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_environment_specs
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','input_digest','package_digest','source_config_digest','source_manifest_digest','plan_digest','package_spec','source_config','install_plan','registered_by','created_at');
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_environment_installs
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','operation_id','input_digest','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','authority_epoch','package_id','manager_session_id','manager_generation','leader_generation','cohort_id','cohort_generation','admission','admission_digest','expires_at','created_at');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_environment_specs
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_environment_installs
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();

CREATE FUNCTION hyperfide.fleet_install_terminal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF OLD.state='READY' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.receipt IS DISTINCT FROM OLD.receipt OR NEW.receipt_digest IS DISTINCT FROM OLD.receipt_digest OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
  RAISE EXCEPTION 'completed fleet installation is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_install_terminal BEFORE UPDATE ON hyperfide.fleet_environment_installs
 FOR EACH ROW EXECUTE FUNCTION hyperfide.fleet_install_terminal_guard();
