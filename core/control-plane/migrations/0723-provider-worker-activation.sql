CREATE TABLE hyperfide.provider_worker_activations (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,intent_id uuid NOT NULL,id uuid NOT NULL,
 sandbox_id uuid NOT NULL,boot_id uuid NOT NULL,boot_generation bigint NOT NULL CHECK(boot_generation>0),
 worker_slot_id uuid NOT NULL,preparation_slot_id uuid NOT NULL,
 preparation_operation_id uuid NOT NULL,preparation_receipt_digest hyperfide.digest NOT NULL,
 released_allocation_id uuid NOT NULL,descriptor jsonb NOT NULL,descriptor_digest hyperfide.digest NOT NULL,
 permit jsonb NOT NULL,permit_digest hyperfide.digest NOT NULL,process_id text NOT NULL,
 state text NOT NULL CHECK(state IN('PINNED','SUBMITTING','OBSERVING','UNKNOWN','ACTIVE')),
 receipt jsonb,receipt_digest hyperfide.digest,last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,intent_id),UNIQUE(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id,intent_id) REFERENCES hyperfide.provider_native_bootstraps(organisation_id,run_id,intent_id),
 FOREIGN KEY(organisation_id,run_id,preparation_operation_id) REFERENCES hyperfide.runner_remote_jobs(organisation_id,run_id,operation_id),
 CHECK((receipt IS NULL)=(receipt_digest IS NULL)),CHECK(state<>'ACTIVE' OR receipt IS NOT NULL)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.provider_worker_activations FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','intent_id','id','sandbox_id','boot_id','boot_generation','worker_slot_id','preparation_slot_id','preparation_operation_id','preparation_receipt_digest','released_allocation_id','descriptor','descriptor_digest','permit','permit_digest','process_id','created_at');
CREATE FUNCTION hyperfide.protect_worker_activation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF OLD.state='ACTIVE' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.receipt IS DISTINCT FROM OLD.receipt OR NEW.receipt_digest IS DISTINCT FROM OLD.receipt_digest) THEN RAISE EXCEPTION 'Worker activation receipt is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.state='PINNED' AND OLD.state<>'PINNED' THEN RAISE EXCEPTION 'Submitted activation cannot be replayed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_activation BEFORE UPDATE ON hyperfide.provider_worker_activations FOR EACH ROW EXECUTE FUNCTION hyperfide.protect_worker_activation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.provider_worker_activations FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
