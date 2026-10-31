-- Explicit offline operational approvals retain original issuance and accepted history.
ALTER TABLE hyperfide.identity_bootstrap_recoveries DROP CONSTRAINT identity_bootstrap_recoveries_reason_check;
ALTER TABLE hyperfide.identity_bootstrap_recoveries ADD CONSTRAINT identity_bootstrap_recoveries_reason_check CHECK(reason IN ('LOST','COMPROMISED','EXPIRED','CAPABILITIES_AMENDED'));
CREATE TABLE hyperfide.identity_bootstrap_capability_approvals (
 approval_id uuid PRIMARY KEY,
 organisation_id uuid NOT NULL,
 run_id uuid NOT NULL,
 recovery_id uuid NOT NULL UNIQUE REFERENCES hyperfide.identity_bootstrap_recoveries(recovery_id),
 amendment_id uuid NOT NULL,
 previous_revision_digest hyperfide.digest NOT NULL,
 accepted_revision_digest hyperfide.digest NOT NULL,
 request_digest hyperfide.digest NOT NULL,
 signed_approval jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organisation_id,run_id,amendment_id) REFERENCES hyperfide.spec_amendments(organisation_id,run_id,id)
);
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.identity_bootstrap_capability_approvals FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER immutable_approval BEFORE UPDATE OR DELETE ON hyperfide.identity_bootstrap_capability_approvals FOR EACH ROW EXECUTE FUNCTION hyperfide.protect_bootstrap_recovery();
