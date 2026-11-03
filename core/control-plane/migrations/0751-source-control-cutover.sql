CREATE TABLE hyperfide.source_native_cutovers (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 migration_id uuid NOT NULL,owner_principal_id uuid NOT NULL,manifest jsonb NOT NULL,manifest_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('SHADOW','READY','QUIESCED','NATIVE','RECOVERY','ABORTED')),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),active_epoch bigint NOT NULL CHECK(active_epoch>0),
 consolidated_revision_id text,pilot_acceptance_id text,parity_digest text,parity jsonb,legacy_isolation jsonb,route text NOT NULL DEFAULT 'LEGACY' CHECK(route IN ('LEGACY','CLOSED','NATIVE')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,migration_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,consolidated_revision_id) REFERENCES hyperfide.source_revisions,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,pilot_acceptance_id) REFERENCES hyperfide.source_native_acceptances
);
CREATE UNIQUE INDEX source_one_active_cutover ON hyperfide.source_native_cutovers(organisation_id,repository_id,security_domain_id) WHERE state<>'ABORTED';
CREATE TABLE hyperfide.source_cutover_operations (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,migration_id uuid NOT NULL,
 operation_id uuid NOT NULL,action text NOT NULL,request_digest text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,operation_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,migration_id) REFERENCES hyperfide.source_native_cutovers(organisation_id,repository_id,security_domain_id,migration_id)
);
CREATE TABLE hyperfide.source_cutover_acknowledgements (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,migration_id uuid NOT NULL,
 revision_id text NOT NULL,authority_epoch bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,migration_id,revision_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions
);
CREATE TRIGGER source_cutover_operations_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_cutover_operations FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_cutover_ack_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_cutover_acknowledgements FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE FUNCTION hyperfide.source_cutover_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.state='ABORTED' OR NEW.generation<>OLD.generation+1 OR NEW.active_epoch<OLD.active_epoch OR
 ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.migration_id,OLD.owner_principal_id,OLD.manifest,OLD.manifest_digest,OLD.created_at)
 IS DISTINCT FROM ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.migration_id,NEW.owner_principal_id,NEW.manifest,NEW.manifest_digest,NEW.created_at)
 THEN RAISE EXCEPTION 'invalid source cutover transition' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER source_cutover_transition BEFORE UPDATE OR DELETE ON hyperfide.source_native_cutovers FOR EACH ROW EXECUTE FUNCTION hyperfide.source_cutover_transition();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['source_native_cutovers','source_cutover_operations','source_cutover_acknowledgements'] LOOP EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',t);END LOOP;END $$;
