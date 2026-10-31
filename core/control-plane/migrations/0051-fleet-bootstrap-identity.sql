CREATE INDEX identity_principal_public_key_lookup ON hyperfide.identity_principals(public_key_b64);
CREATE TABLE hyperfide.fleet_bootstrap_credentials (
 credential_id uuid PRIMARY KEY REFERENCES hyperfide.identity_principals(credential_id),
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,session_id uuid NOT NULL,
 authority_epoch uuid NOT NULL,leader_generation bigint NOT NULL CHECK(leader_generation>=0),
 cohort_id uuid NOT NULL,cohort_generation bigint NOT NULL CHECK(cohort_generation>=0),
 host_id text NOT NULL,replacement_from_generation bigint CHECK(replacement_from_generation>0),delegation_id uuid,manager_generation bigint CHECK(manager_generation>0),
 issued_by_credential_id uuid NOT NULL REFERENCES hyperfide.identity_principals(credential_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organisation_id,run_id,credential_id) REFERENCES hyperfide.identity_principals(organisation_id,run_id,credential_id),
 FOREIGN KEY(organisation_id,run_id,session_id) REFERENCES hyperfide.agent_sessions(organisation_id,run_id,id),
 CHECK((delegation_id IS NULL)=(manager_generation IS NULL)),
 CHECK(replacement_from_generation IS NULL OR cohort_generation=replacement_from_generation+1)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_bootstrap_credentials
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('credential_id','organisation_id','run_id','session_id','authority_epoch','cohort_id','host_id','replacement_from_generation','delegation_id','manager_generation','issued_by_credential_id','created_at');
CREATE FUNCTION hyperfide.fleet_bootstrap_cohort_pin() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF NEW.leader_generation<>OLD.leader_generation AND NOT(OLD.leader_generation=0 AND NEW.leader_generation=1) THEN
  RAISE EXCEPTION 'Bootstrap credential cannot acquire replacement leadership' USING ERRCODE='23514';
 END IF;
 IF NEW.cohort_generation<>OLD.cohort_generation AND NOT(OLD.cohort_generation=0 AND NEW.cohort_generation=1) THEN
  RAISE EXCEPTION 'Bootstrap credential cohort cannot be adopted by a replacement' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cohort_pin BEFORE UPDATE ON hyperfide.fleet_bootstrap_credentials
 FOR EACH ROW EXECUTE FUNCTION hyperfide.fleet_bootstrap_cohort_pin();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_bootstrap_credentials
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
