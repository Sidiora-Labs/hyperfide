CREATE TABLE hyperfide.source_cutover_manifests (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,migration_id uuid NOT NULL,
 generation bigint NOT NULL,manifest jsonb NOT NULL,manifest_digest text NOT NULL,previous_manifest_digest text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,migration_id,generation),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,migration_id) REFERENCES hyperfide.source_native_cutovers
);
INSERT INTO hyperfide.source_cutover_manifests(organisation_id,repository_id,security_domain_id,migration_id,generation,manifest,manifest_digest)
SELECT organisation_id,repository_id,security_domain_id,migration_id,generation,manifest,manifest_digest FROM hyperfide.source_native_cutovers;
CREATE TRIGGER source_cutover_manifests_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_cutover_manifests FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_cutover_manifests FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE OR REPLACE FUNCTION hyperfide.source_cutover_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.state='ABORTED' OR NEW.generation<>OLD.generation+1 OR NEW.active_epoch<OLD.active_epoch OR
 ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.migration_id,OLD.owner_principal_id,OLD.created_at)
 IS DISTINCT FROM ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.migration_id,NEW.owner_principal_id,NEW.created_at)
 THEN RAISE EXCEPTION 'invalid source cutover transition' USING ERRCODE='23514';END IF;
 IF ROW(OLD.manifest,OLD.manifest_digest) IS DISTINCT FROM ROW(NEW.manifest,NEW.manifest_digest) AND
 (OLD.state NOT IN ('READY','QUIESCED') OR NEW.state<>'READY' OR NEW.route<>'CLOSED' OR NEW.pilot_acceptance_id IS NOT NULL OR NEW.parity_digest IS NULL OR NEW.legacy_isolation IS NULL OR NEW.manifest_digest=OLD.manifest_digest)
 THEN RAISE EXCEPTION 'invalid source final delta transition' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE FUNCTION hyperfide.source_capture_cutover_manifest() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
 INSERT INTO hyperfide.source_cutover_manifests(organisation_id,repository_id,security_domain_id,migration_id,generation,manifest,manifest_digest) VALUES(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.migration_id,NEW.generation,NEW.manifest,NEW.manifest_digest);
 ELSIF NEW.manifest_digest<>OLD.manifest_digest THEN
 INSERT INTO hyperfide.source_cutover_manifests(organisation_id,repository_id,security_domain_id,migration_id,generation,manifest,manifest_digest,previous_manifest_digest) VALUES(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.migration_id,NEW.generation,NEW.manifest,NEW.manifest_digest,OLD.manifest_digest);
 END IF;RETURN NEW;END $$;
CREATE TRIGGER source_capture_cutover_manifest AFTER INSERT OR UPDATE ON hyperfide.source_native_cutovers FOR EACH ROW EXECUTE FUNCTION hyperfide.source_capture_cutover_manifest();
