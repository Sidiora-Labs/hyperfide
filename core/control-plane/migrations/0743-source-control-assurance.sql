CREATE TABLE hyperfide.source_native_assurance_policies (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL, policy_id uuid NOT NULL,
 policy_digest text NOT NULL CHECK(policy_digest ~ '^sha256:[a-f0-9]{64}$'), authority_epoch bigint NOT NULL CHECK(authority_epoch>0),
 policy_version text NOT NULL, checks jsonb NOT NULL CHECK(jsonb_typeof(checks)='array'),
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,policy_id)
);
CREATE TABLE hyperfide.source_native_assurance_checkers (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL, policy_id uuid NOT NULL,
 check_id text NOT NULL, principal_id uuid NOT NULL, credential_id uuid NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,policy_id,check_id,principal_id,credential_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,policy_id) REFERENCES hyperfide.source_native_assurance_policies,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,credential_id) REFERENCES hyperfide.source_principal_credentials
);
CREATE TABLE hyperfide.source_native_custodies (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL, custody_id uuid NOT NULL,
 custody_generation bigint NOT NULL CHECK(custody_generation>0), owner_principal_id uuid NOT NULL,
 revision_id text NOT NULL, root_tree_id text NOT NULL, authority_epoch bigint NOT NULL CHECK(authority_epoch>0),
 run_id uuid, task_id uuid, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,custody_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions,
 CHECK((run_id IS NULL)=(task_id IS NULL))
);
CREATE TABLE hyperfide.source_native_assurance_evidence (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL, evidence_id uuid NOT NULL,
 candidate_id uuid NOT NULL, manifest_digest text NOT NULL, policy_id uuid NOT NULL, policy_digest text NOT NULL, checks_digest text NOT NULL,
 check_id text NOT NULL, checker_principal_id uuid NOT NULL, checker_credential_id uuid NOT NULL, checker_credential_version bigint NOT NULL,
 execution_id uuid NOT NULL, receipt_object_id text NOT NULL, receipt_digest text NOT NULL, receipt jsonb NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('PASS','FAIL')), revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,evidence_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,checker_principal_id,execution_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,candidate_id) REFERENCES hyperfide.source_native_candidates,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,policy_id) REFERENCES hyperfide.source_native_assurance_policies
);
CREATE TRIGGER source_native_policy_binding BEFORE UPDATE ON hyperfide.source_native_assurance_policies FOR EACH ROW
 EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','policy_id','policy_digest','authority_epoch','policy_version','checks','expires_at');
CREATE TRIGGER source_native_checker_binding BEFORE UPDATE ON hyperfide.source_native_assurance_checkers FOR EACH ROW
 EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','policy_id','check_id','principal_id','credential_id','expires_at');
CREATE TRIGGER source_native_custody_binding BEFORE UPDATE ON hyperfide.source_native_custodies FOR EACH ROW
 EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','custody_id','custody_generation','owner_principal_id','revision_id','root_tree_id','authority_epoch','run_id','task_id','created_at');
CREATE TRIGGER source_native_evidence_binding BEFORE UPDATE ON hyperfide.source_native_assurance_evidence FOR EACH ROW
 EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','evidence_id','candidate_id','manifest_digest','policy_id','policy_digest','checks_digest','check_id','checker_principal_id','checker_credential_id','checker_credential_version','execution_id','receipt_object_id','receipt_digest','receipt','outcome','created_at');
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['source_native_assurance_policies','source_native_assurance_checkers','source_native_custodies','source_native_assurance_evidence'] LOOP
  EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',item);
  EXECUTE format('CREATE TRIGGER source_native_assurance_delete_guard BEFORE DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable()',item);
 END LOOP;
END $$;

CREATE FUNCTION hyperfide.source_native_assurance_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at THEN
  RAISE EXCEPTION 'Native assurance revocation is permanent' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['source_native_assurance_policies','source_native_assurance_checkers','source_native_custodies','source_native_assurance_evidence'] LOOP
  EXECUTE format('CREATE TRIGGER source_native_assurance_revocation BEFORE UPDATE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.source_native_assurance_revocation()',item);
 END LOOP;
END $$;
