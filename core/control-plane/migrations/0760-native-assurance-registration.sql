CREATE TABLE hyperfide.source_native_assurance_policy_registrations (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL, policy_id uuid NOT NULL,
 run_id uuid NOT NULL, task_id uuid NOT NULL, spec_revision_id uuid NOT NULL, spec_generation bigint NOT NULL CHECK(spec_generation>0),
 run_authority_epoch uuid NOT NULL, registry_digest text NOT NULL, checks_digest text NOT NULL,
 registered_by uuid NOT NULL REFERENCES hyperfide.identity_principals(credential_id),
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,policy_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,policy_id) REFERENCES hyperfide.source_native_assurance_policies,
 FOREIGN KEY(organisation_id,run_id,task_id) REFERENCES hyperfide.tasks(organisation_id,run_id,id),
 CHECK(registry_digest ~ '^sha256:[a-f0-9]{64}$' AND checks_digest ~ '^sha256:[a-f0-9]{64}$')
);
ALTER TABLE hyperfide.source_native_assurance_checkers
 ADD COLUMN identity_kind text NOT NULL DEFAULT 'SOURCE_BEARER' CHECK(identity_kind IN ('SOURCE_BEARER','NATIVE')),
 ADD COLUMN identity_run_id uuid,
 ADD COLUMN identity_credential_version bigint,
 ADD COLUMN identity_role text,
 ADD COLUMN identity_deployment_epoch uuid,
 ADD COLUMN identity_public_key_b64 text,
 ADD CONSTRAINT native_checker_identity_binding CHECK(
  (identity_kind='SOURCE_BEARER' AND identity_run_id IS NULL AND identity_credential_version IS NULL AND identity_role IS NULL AND identity_deployment_epoch IS NULL AND identity_public_key_b64 IS NULL)
  OR (identity_kind='NATIVE' AND identity_run_id IS NOT NULL AND identity_credential_version>0 AND identity_role IN ('VERIFIER','COORDINATOR') AND identity_deployment_epoch IS NOT NULL AND identity_public_key_b64 ~ '^[A-Za-z0-9_-]{43}$')
 );
DO $$ DECLARE constraint_name text; BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='hyperfide.source_native_assurance_checkers'::regclass AND confrelid='hyperfide.source_principal_credentials'::regclass LOOP
  EXECUTE format('ALTER TABLE hyperfide.source_native_assurance_checkers DROP CONSTRAINT %I',constraint_name);
 END LOOP;
END $$;
CREATE FUNCTION hyperfide.validate_native_checker_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.identity_kind='NATIVE' THEN
  IF NOT EXISTS(SELECT 1 FROM hyperfide.identity_principals i JOIN hyperfide.source_native_assurance_policy_registrations p ON p.organisation_id=i.organisation_id AND p.run_id=i.run_id
   WHERE p.organisation_id=NEW.organisation_id AND p.repository_id=NEW.repository_id AND p.security_domain_id=NEW.security_domain_id AND p.policy_id=NEW.policy_id
   AND i.credential_id=NEW.credential_id AND i.actor_id=NEW.principal_id AND i.run_id=NEW.identity_run_id AND i.credential_version>=NEW.identity_credential_version AND i.role=NEW.identity_role AND i.deployment_epoch=NEW.identity_deployment_epoch AND i.public_key_b64=NEW.identity_public_key_b64)
  THEN RAISE EXCEPTION 'Native checker requires its exact registered identity and accepted policy' USING ERRCODE='23503'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM hyperfide.source_principal_credentials c WHERE c.organisation_id=NEW.organisation_id AND c.repository_id=NEW.repository_id AND c.security_domain_id=NEW.security_domain_id AND c.credential_id=NEW.credential_id AND c.principal_id=NEW.principal_id)
  THEN RAISE EXCEPTION 'Source checker requires its exact credential identity' USING ERRCODE='23503'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_checker_identity_valid BEFORE INSERT ON hyperfide.source_native_assurance_checkers FOR EACH ROW EXECUTE FUNCTION hyperfide.validate_native_checker_identity();
CREATE TRIGGER native_checker_identity_immutable BEFORE UPDATE ON hyperfide.source_native_assurance_checkers FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('identity_kind','identity_run_id','identity_credential_version','identity_role','identity_deployment_epoch','identity_public_key_b64');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_native_assurance_policy_registrations FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER native_policy_registration_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_native_assurance_policy_registrations FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
