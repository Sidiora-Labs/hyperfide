CREATE TABLE hyperfide.source_bootstrap_issuances (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 approval_id uuid NOT NULL UNIQUE,run_id uuid NOT NULL,credential_id uuid NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^sha256:[0-9a-f]{64}$'),
 signed_approval jsonb NOT NULL CHECK(jsonb_typeof(signed_approval)='object'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id) REFERENCES hyperfide.source_repositories(organisation_id,repository_id,security_domain_id),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id),
 FOREIGN KEY(credential_id) REFERENCES hyperfide.identity_principals(credential_id)
);
CREATE TRIGGER source_bootstrap_issuance_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_bootstrap_issuances FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_bootstrap_issuances FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
