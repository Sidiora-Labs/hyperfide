CREATE TABLE hyperfide.fleet_install_deliveries (
 organisation_id uuid NOT NULL,
 run_id uuid NOT NULL,
 id uuid NOT NULL,
 input_digest hyperfide.digest NOT NULL,
 environment_id text NOT NULL,
 environment_generation bigint NOT NULL CHECK(environment_generation>0),
 sandbox_id uuid NOT NULL,
 boot_id uuid NOT NULL,
 boot_generation bigint NOT NULL CHECK(boot_generation>0),
 session_id uuid NOT NULL,
 reservation_id uuid NOT NULL,
 target_binding_id uuid NOT NULL,
 source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'),
 staging jsonb NOT NULL CHECK(jsonb_typeof(staging)='array'),
 timeout_ms integer NOT NULL CHECK(timeout_ms BETWEEN 1 AND 3600000),
 registration_digest hyperfide.digest NOT NULL,
 operation_id uuid,
 request jsonb CHECK(request IS NULL OR jsonb_typeof(request)='object'),
 request_digest hyperfide.digest,
 state text NOT NULL DEFAULT 'REGISTERED' CHECK(state IN('REGISTERED','QUEUED','COLLECTED','UNKNOWN')),
 registered_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,id),
 UNIQUE(organisation_id,run_id,input_digest,environment_id,environment_generation,sandbox_id,boot_generation),
 UNIQUE(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,input_digest) REFERENCES hyperfide.fleet_environment_specs(organisation_id,run_id,input_digest),
 FOREIGN KEY(organisation_id,sandbox_id,boot_generation) REFERENCES hyperfide.sandbox_boots(organisation_id,sandbox_id,boot_generation),
 FOREIGN KEY(organisation_id,run_id,session_id) REFERENCES hyperfide.runner_registry(organisation_id,run_id,session_id),
 FOREIGN KEY(organisation_id,run_id,reservation_id) REFERENCES hyperfide.reservations(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 CHECK((request IS NULL)=(request_digest IS NULL)),
 CHECK(state='REGISTERED' OR operation_id IS NOT NULL)
);
CREATE TRIGGER fleet_install_delivery_immutable BEFORE UPDATE OR DELETE ON hyperfide.fleet_install_deliveries
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','id','input_digest','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','session_id','reservation_id','target_binding_id','source','staging','timeout_ms','registration_digest','registered_by','created_at');
CREATE INDEX fleet_install_delivery_pending ON hyperfide.fleet_install_deliveries(organisation_id,run_id,state,operation_id);
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_install_deliveries
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE FUNCTION hyperfide.fleet_install_delivery_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF (OLD.operation_id IS NOT NULL AND NEW.operation_id IS DISTINCT FROM OLD.operation_id) OR
    (OLD.request IS NOT NULL AND (NEW.request IS DISTINCT FROM OLD.request OR NEW.request_digest IS DISTINCT FROM OLD.request_digest)) THEN
  RAISE EXCEPTION 'bound fleet delivery request is immutable' USING ERRCODE='23514';
 END IF;
 IF (OLD.state='COLLECTED' AND NEW.state IS DISTINCT FROM OLD.state) OR
    (OLD.state='UNKNOWN' AND NEW.state NOT IN ('UNKNOWN','COLLECTED')) OR
    (OLD.state='QUEUED' AND NEW.state='REGISTERED') THEN
  RAISE EXCEPTION 'fleet delivery cannot relaunch a settled or uncertain operation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_install_delivery_transition BEFORE UPDATE ON hyperfide.fleet_install_deliveries
 FOR EACH ROW EXECUTE FUNCTION hyperfide.fleet_install_delivery_guard();
