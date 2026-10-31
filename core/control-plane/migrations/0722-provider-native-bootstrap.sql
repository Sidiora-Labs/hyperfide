CREATE TABLE hyperfide.provider_native_bootstraps (
 organisation_id uuid NOT NULL,
 run_id uuid NOT NULL,
 intent_id uuid NOT NULL,
 id uuid NOT NULL,
 pool_id uuid NOT NULL,
 sandbox_id uuid NOT NULL,
 boot_id uuid NOT NULL,
 boot_generation bigint NOT NULL CHECK(boot_generation>0),
 native_sandbox_id text NOT NULL,
 configuration_digest hyperfide.digest NOT NULL,
 profile_id uuid NOT NULL,
 preparation_digest hyperfide.digest NOT NULL,
 descriptor_digest hyperfide.digest NOT NULL,
 descriptor jsonb NOT NULL,
 grant_id uuid NOT NULL,
 binding_operation_id uuid NOT NULL,
 grant_operation_id uuid NOT NULL,
 enrollment_operation_id uuid NOT NULL,
 secret_ref text NOT NULL,
 verifier hyperfide.digest NOT NULL,
 process_id text NOT NULL,
 manifest_digest hyperfide.digest,
 manifest jsonb,
 binding_input jsonb,
 grant_input jsonb,
 state text NOT NULL CHECK(state IN ('PINNED','BOUND','GRANTED','DELIVERING','OBSERVING','READY','UNKNOWN')),
 receipt jsonb,
 receipt_digest hyperfide.digest,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,intent_id),
 UNIQUE(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id),
 FOREIGN KEY(organisation_id,intent_id) REFERENCES hyperfide.provisioning_intents(organisation_id,id),
 CHECK((receipt IS NULL)=(receipt_digest IS NULL)),
 CHECK(state<>'READY' OR receipt IS NOT NULL)
);
CREATE INDEX provider_native_bootstrap_pending ON hyperfide.provider_native_bootstraps(organisation_id,run_id,state,updated_at);
CREATE TRIGGER immutable_binding BEFORE UPDATE ON hyperfide.provider_native_bootstraps FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','intent_id','id','pool_id','sandbox_id','boot_id','boot_generation','native_sandbox_id','configuration_digest','profile_id','preparation_digest','descriptor_digest','descriptor','grant_id','binding_operation_id','grant_operation_id','enrollment_operation_id','secret_ref','verifier','process_id','created_at');
CREATE FUNCTION hyperfide.protect_provider_bootstrap_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.binding_input IS NOT NULL AND NEW.binding_input IS DISTINCT FROM OLD.binding_input THEN RAISE EXCEPTION 'Bootstrap binding request is immutable'; END IF;
 IF OLD.grant_input IS NOT NULL AND NEW.grant_input IS DISTINCT FROM OLD.grant_input THEN RAISE EXCEPTION 'Bootstrap grant request is immutable'; END IF;
 IF OLD.manifest_digest IS NOT NULL AND (NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest OR NEW.manifest IS DISTINCT FROM OLD.manifest) THEN RAISE EXCEPTION 'Bootstrap manifest is immutable'; END IF;
 IF OLD.receipt_digest IS NOT NULL AND (NEW.receipt_digest IS DISTINCT FROM OLD.receipt_digest OR NEW.receipt IS DISTINCT FROM OLD.receipt OR NEW.state IS DISTINCT FROM 'READY') THEN RAISE EXCEPTION 'Bootstrap receipt is immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_evidence BEFORE UPDATE ON hyperfide.provider_native_bootstraps FOR EACH ROW EXECUTE FUNCTION hyperfide.protect_provider_bootstrap_evidence();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.provider_native_bootstraps FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();

CREATE TRIGGER retain_provider_bootstrap BEFORE DELETE ON hyperfide.provider_native_bootstraps FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','intent_id');
