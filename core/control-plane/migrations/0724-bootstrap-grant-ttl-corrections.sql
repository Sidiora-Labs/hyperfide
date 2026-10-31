CREATE TABLE hyperfide.provider_bootstrap_grant_rejections (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,intent_id uuid NOT NULL,id uuid NOT NULL,
 operation_id uuid NOT NULL,input_digest hyperfide.digest NOT NULL,payload_digest hyperfide.digest NOT NULL,
 evidence jsonb NOT NULL,evidence_digest hyperfide.digest NOT NULL,observed_at timestamptz NOT NULL,
 PRIMARY KEY(organisation_id,run_id,intent_id,operation_id),UNIQUE(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id,intent_id) REFERENCES hyperfide.provider_native_bootstraps(organisation_id,run_id,intent_id)
);
CREATE TABLE hyperfide.provider_bootstrap_grant_corrections (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,intent_id uuid NOT NULL,id uuid NOT NULL,
 prior_descriptor_digest hyperfide.digest NOT NULL,descriptor_digest hyperfide.digest NOT NULL,descriptor jsonb NOT NULL,
 original_operation_id uuid NOT NULL,rejection_id uuid NOT NULL,rejection_digest hyperfide.digest NOT NULL,
 operation_id uuid NOT NULL,request jsonb NOT NULL,request_digest hyperfide.digest NOT NULL,
 trusted_policy_digest hyperfide.digest NOT NULL,trusted_ceiling integer NOT NULL CHECK(trusted_ceiling BETWEEN 1 AND 900),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,intent_id),UNIQUE(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id,intent_id) REFERENCES hyperfide.provider_native_bootstraps(organisation_id,run_id,intent_id),
 FOREIGN KEY(organisation_id,rejection_id) REFERENCES hyperfide.provider_bootstrap_grant_rejections(organisation_id,id)
);
CREATE TRIGGER immutable_rejection BEFORE UPDATE OR DELETE ON hyperfide.provider_bootstrap_grant_rejections FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','intent_id','id','operation_id','input_digest','payload_digest','evidence','evidence_digest','observed_at');
CREATE TRIGGER immutable_correction BEFORE UPDATE OR DELETE ON hyperfide.provider_bootstrap_grant_corrections FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','intent_id','id','prior_descriptor_digest','descriptor_digest','descriptor','original_operation_id','rejection_id','rejection_digest','operation_id','request','request_digest','trusted_policy_digest','trusted_ceiling','created_at');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.provider_bootstrap_grant_rejections FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.provider_bootstrap_grant_corrections FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
