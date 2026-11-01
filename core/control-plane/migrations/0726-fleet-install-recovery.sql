CREATE TABLE hyperfide.fleet_install_heads (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,environment_id text NOT NULL,
 environment_generation bigint NOT NULL CHECK(environment_generation>0),
 logical_operation_id uuid NOT NULL,current_operation_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,environment_id,environment_generation),
 FOREIGN KEY(organisation_id,run_id,logical_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,current_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id)
);
INSERT INTO hyperfide.fleet_install_heads(organisation_id,run_id,environment_id,environment_generation,logical_operation_id,current_operation_id)
 SELECT organisation_id,run_id,environment_id,environment_generation,operation_id,operation_id FROM hyperfide.fleet_environment_installs;
DO $$ DECLARE constraint_name text;
BEGIN
 FOR constraint_name IN SELECT c.conname FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='hyperfide.fleet_environment_installs'::regclass AND c.contype='u'
 AND pg_catalog.pg_get_constraintdef(c.oid)='UNIQUE (organisation_id, run_id, environment_id, environment_generation)'
 LOOP EXECUTE format('ALTER TABLE hyperfide.fleet_environment_installs DROP CONSTRAINT %I',constraint_name); END LOOP;
END $$;
ALTER TABLE hyperfide.fleet_environment_installs ADD CONSTRAINT fleet_install_execution_environment
 UNIQUE(organisation_id,run_id,environment_id,environment_generation,operation_id);
ALTER TABLE hyperfide.fleet_install_heads ADD CONSTRAINT fleet_install_head_environment
 FOREIGN KEY(organisation_id,run_id,environment_id,environment_generation,current_operation_id)
 REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,environment_id,environment_generation,operation_id);
ALTER TABLE hyperfide.fleet_install_heads ADD CONSTRAINT fleet_install_logical_environment
 FOREIGN KEY(organisation_id,run_id,environment_id,environment_generation,logical_operation_id)
 REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,environment_id,environment_generation,operation_id);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_install_heads
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','environment_id','environment_generation','logical_operation_id');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_install_heads
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TABLE hyperfide.fleet_install_recoveries (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,operation_id uuid NOT NULL,
 predecessor_install_operation_id uuid NOT NULL,logical_operation_id uuid NOT NULL,
 predecessor_admission_digest hyperfide.digest NOT NULL,runner_operation_id uuid NOT NULL,
 runner_plan_digest hyperfide.digest NOT NULL,runner_result_digest hyperfide.digest NOT NULL,
 quiescence_operation_id uuid NOT NULL,quiescence_receipt_digest hyperfide.digest NOT NULL,
 decision_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,operation_id),
 UNIQUE(organisation_id,run_id,predecessor_install_operation_id),
 FOREIGN KEY(organisation_id,run_id,operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,predecessor_install_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,logical_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,runner_operation_id) REFERENCES hyperfide.runner_remote_jobs(organisation_id,run_id,operation_id),
 CHECK(operation_id<>predecessor_install_operation_id AND quiescence_operation_id=runner_operation_id)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_install_recoveries
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','operation_id','predecessor_install_operation_id','logical_operation_id','predecessor_admission_digest','runner_operation_id','runner_plan_digest','runner_result_digest','quiescence_operation_id','quiescence_receipt_digest','decision_id','created_at');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_install_recoveries
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TABLE hyperfide.fleet_install_delivery_executions (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,operation_id uuid NOT NULL,
 delivery_id uuid NOT NULL,logical_operation_id uuid NOT NULL,
 request jsonb CHECK(request IS NULL OR jsonb_typeof(request)='object'),request_digest hyperfide.digest,
 state text NOT NULL DEFAULT 'REGISTERED' CHECK(state IN('REGISTERED','QUEUED','COLLECTED','UNKNOWN')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,delivery_id) REFERENCES hyperfide.fleet_install_deliveries(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,logical_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 CHECK((request IS NULL)=(request_digest IS NULL)),CHECK(state='REGISTERED' OR request IS NOT NULL)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_install_delivery_executions
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','operation_id','delivery_id','logical_operation_id','created_at');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_install_delivery_executions
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE FUNCTION hyperfide.fleet_install_execution_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF OLD.request IS NOT NULL AND (NEW.request IS DISTINCT FROM OLD.request OR NEW.request_digest IS DISTINCT FROM OLD.request_digest) THEN
  RAISE EXCEPTION 'bound installation execution request is immutable' USING ERRCODE='23514';
 END IF;
 IF (OLD.state='COLLECTED' AND NEW.state IS DISTINCT FROM OLD.state) OR
    (OLD.state='UNKNOWN' AND NEW.state NOT IN('UNKNOWN','COLLECTED')) OR
    (OLD.state='QUEUED' AND NEW.state='REGISTERED') THEN
  RAISE EXCEPTION 'installation execution state cannot replay' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_install_execution_terminal BEFORE UPDATE ON hyperfide.fleet_install_delivery_executions
 FOR EACH ROW EXECUTE FUNCTION hyperfide.fleet_install_execution_guard();
